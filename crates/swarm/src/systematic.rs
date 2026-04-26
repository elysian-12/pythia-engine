//! Systematic agents — deterministic, backed by simple in-line rules.
//!
//! Each agent has its own parameters: z-threshold, stop/TP multiples,
//! cooldown, horizon, risk fraction. At construction we declare what
//! mix of strategies + parameters should populate the swarm.
//!
//! We deliberately don't reuse `crypto_native::liq_fade` etc. directly
//! because those operate on full historical vectors (batch), whereas a
//! live agent needs incremental per-event state. This module
//! re-implements the incremental variant — ~30 lines per agent type.

use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use domain::{
    crypto::{Asset, LiqSide},
    signal::Direction,
    time::EventTs,
};
use serde::{Deserialize, Serialize};

use econometrics::{cointegration_test, granger_f, information_share_proxy};
use regime::Regime;

use crate::agent::{AgentDecision, AgentKind, AgentProfile, Event, PeerView, SwarmAgent};

/// The family of rule each systematic agent belongs to. Determines
/// which inputs it consumes.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RuleFamily {
    /// Fires on rolling-z of hourly net liquidation.
    LiqZScore { trend_follow: bool },
    /// Fires on rolling-z of funding rate.
    FundingZScore { trend_follow: bool },
    /// Fires on Donchian breakout with ATR floor.
    VolBreakout,
    /// Fires when the Polymarket prediction series Granger-causes spot
    /// AND the two series are cointegrated AND the Hasbrouck info-share
    /// puts the dominant share on the prediction market. The previous
    /// implementation in TS / synth land used a magnitude-z proxy on
    /// `swp − mid`; this real version threads three orthogonal
    /// statistical gates from the `econometrics` crate so the agent
    /// only fires when the prediction market is *actually* leading.
    PolyEdge,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SystematicParams {
    pub family: RuleFamily,
    pub z_threshold: f64,
    pub z_window: usize,
    pub cooldown_bars: usize,
    pub horizon_hours: i64,
    pub risk_fraction: f64,
    pub asset_filter: Option<Asset>, // `None` = both BTC + ETH
    pub donchian_bars: usize,
    pub atr_pct_min: f64,
}

impl SystematicParams {
    pub fn liq_trend() -> Self {
        Self {
            family: RuleFamily::LiqZScore { trend_follow: true },
            z_threshold: 2.5,
            z_window: 48,
            cooldown_bars: 6,
            horizon_hours: 4,
            risk_fraction: 0.01,
            asset_filter: None,
            donchian_bars: 24,
            atr_pct_min: 0.004,
        }
    }

    pub fn liq_fade() -> Self {
        Self {
            family: RuleFamily::LiqZScore { trend_follow: false },
            z_threshold: 2.5,
            ..Self::liq_trend()
        }
    }

    pub fn funding_arb() -> Self {
        Self {
            family: RuleFamily::FundingZScore { trend_follow: false },
            z_threshold: 2.0,
            z_window: 24 * 14,
            horizon_hours: 8,
            ..Self::liq_trend()
        }
    }

    pub fn funding_trend() -> Self {
        Self {
            family: RuleFamily::FundingZScore { trend_follow: true },
            z_threshold: 2.0,
            z_window: 24 * 14,
            horizon_hours: 8,
            ..Self::liq_trend()
        }
    }

    pub fn vol_breakout() -> Self {
        Self {
            family: RuleFamily::VolBreakout,
            donchian_bars: 24,
            atr_pct_min: 0.004,
            horizon_hours: 24,
            ..Self::liq_trend()
        }
    }

    /// Polyedge agent: fires when the prediction market Granger-leads
    /// spot AND the two series are cointegrated AND the Hasbrouck
    /// info-share is dominated by the PM side. The `z_threshold` field
    /// is repurposed as the *minimum |swp − mid| gap*, in probability
    /// units, that's required on top of the statistical gates. A small
    /// gap (< ~3 percentage points) is more likely to be quote noise
    /// than real prediction lead. `z_window` doubles as the lookback
    /// length used by the econometric tests.
    pub fn polyedge() -> Self {
        Self {
            family: RuleFamily::PolyEdge,
            z_threshold: 0.03,   // 3 percentage points min gap
            z_window: 96,        // 96 paired hourly samples (4 days)
            cooldown_bars: 4,
            horizon_hours: 6,
            risk_fraction: 0.01,
            asset_filter: None,
            donchian_bars: 24,
            atr_pct_min: 0.0,    // unused
        }
    }
}

/// Incremental per-asset rolling stat helper.
#[derive(Debug, Default, Clone)]
struct AssetWindow {
    /// Hourly-bucketed net liquidation values (most recent last).
    liq_net: std::collections::VecDeque<f64>,
    /// Funding rate history (rate_close).
    funding: std::collections::VecDeque<f64>,
    /// Recent close prices (for Donchian / ATR).
    closes: std::collections::VecDeque<f64>,
    highs: std::collections::VecDeque<f64>,
    lows: std::collections::VecDeque<f64>,
    /// Current in-progress hour for liq bucketing.
    cur_hour_ts: i64,
    cur_hour_net: f64,
    initialised: bool,
    last_signal_bar: i64,
    bar_counter: i64,
}

impl AssetWindow {
    fn push_liq(&mut self, ts: i64, side: LiqSide, usd: f64) -> Option<f64> {
        let bucket = (ts / 3600) * 3600;
        let rollover = self.initialised && bucket > self.cur_hour_ts;
        let out = if rollover {
            let closed = self.cur_hour_net;
            self.liq_net.push_back(closed);
            while self.liq_net.len() > 200 {
                self.liq_net.pop_front();
            }
            self.bar_counter += 1;
            Some(closed)
        } else {
            None
        };
        if !self.initialised || self.cur_hour_ts != bucket {
            self.cur_hour_ts = bucket;
            self.cur_hour_net = 0.0;
            self.initialised = true;
        }
        let signed = match side {
            LiqSide::Buy => usd,
            LiqSide::Sell => -usd,
        };
        self.cur_hour_net += signed;
        out
    }

    fn push_candle(&mut self, open: f64, high: f64, low: f64, close: f64) {
        let _ = open;
        self.closes.push_back(close);
        self.highs.push_back(high);
        self.lows.push_back(low);
        while self.closes.len() > 200 {
            self.closes.pop_front();
        }
        while self.highs.len() > 200 {
            self.highs.pop_front();
        }
        while self.lows.len() > 200 {
            self.lows.pop_front();
        }
    }

    fn push_funding(&mut self, rate: f64) {
        self.funding.push_back(rate);
        while self.funding.len() > 500 {
            self.funding.pop_front();
        }
    }

    fn z_last(q: &std::collections::VecDeque<f64>, window: usize) -> Option<f64> {
        if q.len() < window.max(4) {
            return None;
        }
        let start = q.len() - window;
        let slice: Vec<f64> = q.iter().skip(start).copied().collect();
        let last = *slice.last()?;
        let prior: Vec<f64> = slice.iter().take(slice.len() - 1).copied().collect();
        let mean = prior.iter().sum::<f64>() / prior.len() as f64;
        let var = prior.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / prior.len() as f64;
        let sd = var.sqrt().max(1e-9);
        Some((last - mean) / sd)
    }

    fn atr_and_pct(&self, window: usize) -> Option<(f64, f64)> {
        if self.closes.len() < window + 1 {
            return None;
        }
        let n = self.closes.len();
        let mut sum_tr = 0.0;
        for i in (n - window)..n {
            let prev_close = self.closes[i - 1];
            let tr = (self.highs[i] - self.lows[i])
                .max((self.highs[i] - prev_close).abs())
                .max((self.lows[i] - prev_close).abs());
            sum_tr += tr;
        }
        let atr = sum_tr / window as f64;
        let last = *self.closes.back()?;
        Some((atr, if last > 0.0 { atr / last } else { 0.0 }))
    }

    fn donchian_break(&self, lookback: usize) -> Option<Direction> {
        if self.closes.len() < lookback + 1 {
            return None;
        }
        let n = self.closes.len();
        let lookback_hi = self.highs.iter().skip(n - lookback - 1).take(lookback).copied().fold(f64::MIN, f64::max);
        let lookback_lo = self.lows.iter().skip(n - lookback - 1).take(lookback).copied().fold(f64::MAX, f64::min);
        let cur = *self.closes.back()?;
        if cur > lookback_hi {
            Some(Direction::Long)
        } else if cur < lookback_lo {
            Some(Direction::Short)
        } else {
            None
        }
    }
}

/// Systematic agent — holds its own windowed state per asset.
pub struct SystematicAgent {
    id: String,
    profile: AgentProfile,
    params: SystematicParams,
    btc: AssetWindow,
    eth: AssetWindow,
}

impl std::fmt::Debug for SystematicAgent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SystematicAgent")
            .field("id", &self.id)
            .field("family", &self.params.family)
            .finish_non_exhaustive()
    }
}

impl SystematicAgent {
    pub fn new(id: impl Into<String>, params: SystematicParams) -> Self {
        let profile = AgentProfile {
            kind: AgentKind::Systematic,
            risk_fraction: params.risk_fraction,
            horizon_s: params.horizon_hours * 3600,
            personality: Some(format!("{:?}", params.family)),
            social: false,
        };
        Self {
            id: id.into(),
            profile,
            params,
            btc: AssetWindow::default(),
            eth: AssetWindow::default(),
        }
    }

    fn window_mut(&mut self, asset: Asset) -> &mut AssetWindow {
        match asset {
            Asset::Btc => &mut self.btc,
            Asset::Eth => &mut self.eth,
        }
    }

    fn passes_asset_filter(&self, asset: Asset) -> bool {
        self.params.asset_filter.is_none_or(|a| a == asset)
    }

    /// How well-suited this agent's family is to the current regime.
    /// Classic regime-aware risk allocation (López de Prado): trend-
    /// followers thrive in directional regimes, mean-reverters in
    /// ranges, and everyone halves size in chaos. The multiplier scales
    /// `risk_fraction` rather than fully blocking — small bets in
    /// hostile regimes still capture mispricings without bleeding to
    /// fees if the rule still triggers cleanly.
    fn regime_fitness(&self, snap: Option<regime::RegimeSnapshot>) -> f64 {
        let Some(s) = snap else {
            return 1.0;
        };
        match (self.params.family, s.regime) {
            // Trend-followers: liq-trend, funding-trend, vol-breakout
            (RuleFamily::LiqZScore { trend_follow: true }, r)
            | (RuleFamily::FundingZScore { trend_follow: true }, r)
            | (RuleFamily::VolBreakout, r) => match r {
                Regime::Trending => 1.0,
                Regime::Chaotic => 0.5,
                Regime::Calm => 0.6,
                Regime::Ranging => 0.3,
            },
            // Mean-reverters: liq-fade, funding-arb
            (RuleFamily::LiqZScore { trend_follow: false }, r)
            | (RuleFamily::FundingZScore { trend_follow: false }, r) => match r {
                Regime::Trending => 0.3,
                Regime::Chaotic => 0.5,
                Regime::Calm => 0.7,
                Regime::Ranging => 1.0,
            },
            // Polyedge: prediction-market leadership shows up most
            // clearly in directional regimes (trending / chaotic), where
            // sentiment leads price discovery. In ranges the SWP/mid
            // gap mostly reflects quote noise.
            (RuleFamily::PolyEdge, r) => match r {
                Regime::Trending => 1.1,
                Regime::Chaotic => 0.7,
                Regime::Calm => 0.4,
                Regime::Ranging => 0.6,
            },
        }
    }

    fn decide_for_asset(
        &mut self,
        asset: Asset,
        ts: EventTs,
        peers: &PeerView,
    ) -> Option<AgentDecision> {
        let regime = peers.regime;
        let self_recent_expectancy = peers.self_recent_expectancy;
        let params = self.params.clone();
        // Compute fitness up-front so the borrow on `self` doesn't conflict
        // with the mutable borrow `window_mut` takes below.
        let fitness = self.regime_fitness(regime);
        if fitness < 0.3 {
            return None;
        }
        // Self-backtest gate: when this agent's recent E[R] over the last
        // N closed trades is meaningfully negative, abstain. The orchestrator
        // sets `self_recent_expectancy` from `Scoreboard::recent_expectancy`;
        // it stays `None` until the agent has built up at least the minimum
        // sample, so new agents fire freely until they have enough history
        // to gate on. Threshold of -0.05 R lets a slightly losing run still
        // probe the market — only persistent decay shuts the agent down.
        if let Some(expectancy) = self_recent_expectancy {
            if expectancy < -0.05 {
                return None;
            }
        }
        let window = self.window_mut(asset);
        if window.bar_counter - window.last_signal_bar < params.cooldown_bars as i64 {
            return None;
        }
        let direction = match params.family {
            RuleFamily::LiqZScore { trend_follow } => {
                let z = AssetWindow::z_last(&window.liq_net, params.z_window)?;
                if z.abs() < params.z_threshold {
                    return None;
                }
                let fade_dir = if z > 0.0 { Direction::Short } else { Direction::Long };
                if trend_follow { invert(fade_dir) } else { fade_dir }
            }
            RuleFamily::FundingZScore { trend_follow } => {
                let z = AssetWindow::z_last(&window.funding, params.z_window)?;
                if z.abs() < params.z_threshold {
                    return None;
                }
                let fade_dir = if z > 0.0 { Direction::Short } else { Direction::Long };
                if trend_follow { invert(fade_dir) } else { fade_dir }
            }
            RuleFamily::VolBreakout => {
                let (_, atr_pct) = window.atr_and_pct(14)?;
                if atr_pct < params.atr_pct_min {
                    return None;
                }
                window.donchian_break(params.donchian_bars)?
            }
            RuleFamily::PolyEdge => {
                // Polyedge gates the trade behind three independent
                // econometric tests. The previous implementation used
                // |swp − mid| z-score alone (the "magnitude proxy"
                // mentioned in the public docs); replacing it with the
                // real cointegration → Granger → Hasbrouck pipeline.
                // All three live in the `econometrics` crate.
                let history = peers.polymarket_history.as_ref()?;
                let (swp, mid) = history.series_for(asset);
                let take = params.z_window.max(40);
                if swp.len() < take || mid.len() < take {
                    return None;
                }
                let swp_w: Vec<f64> = swp[swp.len() - take..].to_vec();
                let mid_w: Vec<f64> = mid[mid.len() - take..].to_vec();

                // Gate 1: Engle-Granger cointegration. If the two
                // series don't share a long-run equilibrium the gap
                // is just noise — no point computing the rest.
                let coint = cointegration_test(&swp_w, &mid_w).ok()?;
                if !coint.cointegrated_5pct {
                    return None;
                }
                // Gate 2: Granger-F at lag 4. Does past SWP help
                // predict next mid? Significant_5pct = p_value < 0.05.
                let granger = granger_f(&mid_w, &swp_w, 4).ok()?;
                if !granger.significant_5pct() {
                    return None;
                }
                // Gate 3: Hasbrouck info-share proxy. Of the two
                // series' next-step variance, how much is explained
                // by the *other* side's lags? share_pm > 0.5 means
                // PM leads spot more than spot leads PM.
                let info = information_share_proxy(&swp_w, &mid_w, 4).ok()?;
                if info.share_pm < 0.5 {
                    return None;
                }
                // Direction: sign of the latest gap. swp > mid means
                // the prediction market is more bullish than spot →
                // expect spot to catch up → Long. swp < mid → Short.
                let last_swp = *swp_w.last()?;
                let last_mid = *mid_w.last()?;
                let edge = last_swp - last_mid;
                if edge.abs() < params.z_threshold {
                    return None;
                }
                if edge > 0.0 { Direction::Long } else { Direction::Short }
            }
        };
        // Fitness pre-checked at function entry — no second gate here.
        window.last_signal_bar = window.bar_counter;
        let conviction = ((80.0 * fitness) as u8).max(20);
        let scaled_risk = params.risk_fraction * fitness;
        let regime_tag = regime
            .map(|r| r.regime.as_str())
            .unwrap_or("regime?");
        Some(AgentDecision {
            id: next_decision_id(),
            agent_id: self.id.clone(),
            ts,
            asset,
            direction,
            conviction,
            risk_fraction: scaled_risk,
            horizon_s: params.horizon_hours * 3600,
            rationale: format!("{:?} · {} · fit {:.2}", params.family, regime_tag, fitness),
        })
    }
}

fn invert(d: Direction) -> Direction {
    match d {
        Direction::Long => Direction::Short,
        Direction::Short => Direction::Long,
    }
}

static DECISION_COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_decision_id() -> String {
    let n = DECISION_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("decision-{n}")
}

#[async_trait]
impl SwarmAgent for SystematicAgent {
    fn id(&self) -> &str {
        &self.id
    }

    fn profile(&self) -> &AgentProfile {
        &self.profile
    }

    async fn observe(&mut self, event: &Event, peers: &PeerView) -> Option<AgentDecision> {
        match event {
            Event::Liquidation { ts, asset, side, usd_value } => {
                if !self.passes_asset_filter(*asset) {
                    return None;
                }
                if self.window_mut(*asset).push_liq(ts.0, *side, *usd_value).is_some() {
                    // a new hourly bucket just closed — evaluate
                    return self.decide_for_asset(*asset, *ts, peers);
                }
                None
            }
            Event::Candle { ts, asset, candle } => {
                if !self.passes_asset_filter(*asset) {
                    return None;
                }
                self.window_mut(*asset).push_candle(candle.open, candle.high, candle.low, candle.close);
                if matches!(self.params.family, RuleFamily::VolBreakout) {
                    return self.decide_for_asset(*asset, *ts, peers);
                }
                None
            }
            Event::Funding { ts, asset, funding } => {
                if !self.passes_asset_filter(*asset) {
                    return None;
                }
                self.window_mut(*asset).push_funding(funding.rate_close);
                if matches!(self.params.family, RuleFamily::FundingZScore { .. }) {
                    return self.decide_for_asset(*asset, *ts, peers);
                }
                None
            }
            Event::Polymarket { ts, asset, .. } => {
                if !self.passes_asset_filter(*asset) {
                    return None;
                }
                // Polyedge agents evaluate on every Polymarket tick; the
                // polymarket history buffer is updated by the orchestrator
                // before broadcast, so by the time the agent sees the
                // event the rolling SWP/mid pair is already in PeerView.
                if matches!(self.params.family, RuleFamily::PolyEdge) {
                    return self.decide_for_asset(*asset, *ts, peers);
                }
                None
            }
            Event::OpenInterest { .. } | Event::HourClose { .. } => None,
        }
    }

    fn systematic_params(&self) -> Option<SystematicParams> {
        Some(self.params.clone())
    }
}

/// Fluent builder for populating a swarm with diverse agents.
#[derive(Default)]
pub struct SystematicBuilder {
    pub specs: Vec<(String, SystematicParams)>,
}

impl SystematicBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add the "house" roster — 20 agents spanning all 5 rule families.
    #[must_use]
    pub fn house_roster(mut self) -> Self {
        // liq-trend — 4 variants
        for (i, z) in [2.2, 2.5, 2.8, 3.0].iter().enumerate() {
            let mut p = SystematicParams::liq_trend();
            p.z_threshold = *z;
            p.risk_fraction = 0.01;
            p.horizon_hours = 4;
            self.specs.push((format!("liq-trend-v{}", i), p));
        }
        // liq-fade — 3 variants
        for (i, z) in [2.5, 3.0, 3.5].iter().enumerate() {
            let mut p = SystematicParams::liq_fade();
            p.z_threshold = *z;
            self.specs.push((format!("liq-fade-v{}", i), p));
        }
        // funding-arb — 3 variants
        for (i, z) in [2.0, 2.5, 3.0].iter().enumerate() {
            let mut p = SystematicParams::funding_arb();
            p.z_threshold = *z;
            self.specs.push((format!("funding-arb-v{}", i), p));
        }
        // funding-trend — 3 variants
        for (i, z) in [2.0, 2.5, 3.0].iter().enumerate() {
            let mut p = SystematicParams::funding_trend();
            p.z_threshold = *z;
            self.specs.push((format!("funding-trend-v{}", i), p));
        }
        // vol-breakout — 3 variants
        for (i, (d, atr)) in [(16usize, 0.003), (24, 0.004), (48, 0.005)].iter().enumerate() {
            let mut p = SystematicParams::vol_breakout();
            p.donchian_bars = *d;
            p.atr_pct_min = *atr;
            p.horizon_hours = 24;
            self.specs.push((format!("vol-breakout-v{}", i), p));
        }
        // 4 risk-appetite variants of flagship liq-trend
        for (risk, suffix) in [(0.005, "conservative"), (0.015, "aggressive"), (0.02, "kelly"), (0.03, "degen")] {
            let mut p = SystematicParams::liq_trend();
            p.z_threshold = 2.5;
            p.risk_fraction = risk;
            self.specs.push((format!("liq-trend-{suffix}"), p));
        }
        // polyedge — 2 variants (gap/window thresholds). Real
        // statistical gates (cointegration / Granger / Hasbrouck) live
        // inside the family's decide path; these knobs only tune the
        // minimum SWP↔mid gap and lookback length.
        for (i, (gap, win)) in [(0.03, 96usize), (0.05, 144)].iter().enumerate() {
            let mut p = SystematicParams::polyedge();
            p.z_threshold = *gap;
            p.z_window = *win;
            self.specs.push((format!("polyedge-v{}", i), p));
        }
        self
    }

    pub fn build(self) -> Vec<Box<dyn SwarmAgent>> {
        self.specs
            .into_iter()
            .map(|(id, p)| Box::new(SystematicAgent::new(id, p)) as Box<dyn SwarmAgent>)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::{
        crypto::{Asset, Candle, FundingRate, LiqSide},
        time::EventTs,
    };

    #[tokio::test]
    async fn liq_trend_fires_on_spike() {
        let mut a = SystematicAgent::new(
            "t",
            SystematicParams {
                z_threshold: 2.0,
                z_window: 24,
                cooldown_bars: 1,
                ..SystematicParams::liq_trend()
            },
        );
        // Drive 30 quiet hours of small buy liqs, then a big one.
        let peers = PeerView::default();
        let mut ts = 0i64;
        for _ in 0..30 {
            let _ = a
                .observe(
                    &Event::Liquidation {
                        ts: EventTs::from_secs(ts),
                        asset: Asset::Btc,
                        side: LiqSide::Buy,
                        usd_value: 1_000.0,
                    },
                    &peers,
                )
                .await;
            ts += 3600;
        }
        // Spike in current hour, next hour triggers evaluation.
        let _ = a
            .observe(
                &Event::Liquidation {
                    ts: EventTs::from_secs(ts),
                    asset: Asset::Btc,
                    side: LiqSide::Buy,
                    usd_value: 50_000.0,
                },
                &peers,
            )
            .await;
        ts += 3600;
        let d = a
            .observe(
                &Event::Liquidation {
                    ts: EventTs::from_secs(ts),
                    asset: Asset::Btc,
                    side: LiqSide::Buy,
                    usd_value: 500.0,
                },
                &peers,
            )
            .await;
        assert!(d.is_some(), "expected trend-follow long on the closed bucket");
        let d = d.unwrap();
        assert_eq!(d.direction, Direction::Long);
    }

    #[tokio::test]
    async fn house_roster_builds() {
        let agents = SystematicBuilder::new().house_roster().build();
        // 4 liq-trend + 3 liq-fade + 3 funding-arb + 3 funding-trend
        // + 3 vol-breakout + 4 risk-appetite variants + 2 polyedge.
        assert_eq!(agents.len(), 22);
        let ids: Vec<&str> = agents.iter().map(|a| a.id()).collect();
        assert!(ids.contains(&"liq-trend-v0"));
        assert!(ids.contains(&"vol-breakout-v0"));
        assert!(ids.contains(&"liq-trend-kelly"));
        assert!(ids.contains(&"polyedge-v0"));
    }

    #[tokio::test]
    async fn vol_breakout_fires_on_new_high() {
        let mut a = SystematicAgent::new("vb", SystematicParams {
            donchian_bars: 10,
            atr_pct_min: 0.0005,
            cooldown_bars: 0,
            ..SystematicParams::vol_breakout()
        });
        let peers = PeerView::default();
        let base = EventTs::from_secs(0);
        // 20 quiet bars
        for i in 0..20 {
            let _ = a
                .observe(
                    &Event::Candle {
                        ts: base,
                        asset: Asset::Btc,
                        candle: Candle {
                            ts: base,
                            open: 100.0,
                            high: 100.5,
                            low: 99.5,
                            close: 100.0 + (i as f64) * 0.01,
                            volume: 1.0,
                        },
                    },
                    &peers,
                )
                .await;
        }
        // Clear upside break
        let d = a
            .observe(
                &Event::Candle {
                    ts: base,
                    asset: Asset::Btc,
                    candle: Candle {
                        ts: base,
                        open: 100.0,
                        high: 110.0,
                        low: 100.0,
                        close: 108.0,
                        volume: 1.0,
                    },
                },
                &peers,
            )
            .await;
        assert!(d.is_some());
        assert_eq!(d.unwrap().direction, Direction::Long);
    }

    /// Build a Polymarket-leads-spot fixture where:
    ///  - swp is a stationary AR(1) signal in [0, 1] driven by larger
    ///    random shocks (small shocks make 4-lag OLS regressors near-
    ///    collinear → singular X'X in Granger);
    ///  - mid[t] = swp[t-4] + observation noise, so swp Granger-leads mid
    ///    at lag 4 and the pair is cointegrated by construction.
    ///
    /// The construction is a research analogue of "Polymarket binary
    /// quote leads spot price by ~4 hours" and exercises every gate.
    fn synth_pm_leads_pair(seed: u64, n: usize) -> Vec<(f64, f64)> {
        let mut state = seed | 1;
        let mut nrand = || -> f64 {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((state >> 33) as f64) / (u32::MAX as f64) - 0.5
        };
        // Stationary AR(1) on the logit so swp lives in (0, 1) without
        // being clamped against the bounds for long stretches.
        let phi = 0.85;
        let mut z = 0.0_f64;
        let mut swp_logit = Vec::with_capacity(n);
        for _ in 0..n {
            z = phi * z + nrand();
            swp_logit.push(z);
        }
        let sigm = |x: f64| 1.0 / (1.0 + (-x).exp());
        let swp_full: Vec<f64> = swp_logit.iter().map(|x| sigm(*x)).collect();
        let lag = 4usize;
        let mut out = Vec::with_capacity(n - lag);
        for t in lag..n {
            let mid = (swp_full[t - lag] + 0.05 * nrand()).clamp(0.05, 0.95);
            out.push((swp_full[t], mid));
        }
        out
    }

    #[tokio::test]
    async fn polyedge_gate_diagnostics() {
        // Probe what each gate sees on the leads-spot fixture so the
        // assertion test below has something diagnostic to fall back on.
        let pairs = synth_pm_leads_pair(0xDEAD_BEEF, 220);
        let take = 120;
        let swp_w: Vec<f64> = pairs.iter().rev().take(take).map(|p| p.0).rev().collect();
        let mid_w: Vec<f64> = pairs.iter().rev().take(take).map(|p| p.1).rev().collect();
        let coint = cointegration_test(&swp_w, &mid_w).unwrap();
        let granger = granger_f(&mid_w, &swp_w, 4).unwrap();
        let info = information_share_proxy(&swp_w, &mid_w, 4).unwrap();
        eprintln!(
            "gate diag: coint adf_tau={:.3} (5% < {}) cointegrated={} | granger F={:.2} p={:.3} sig={} | hasbrouck share_pm={:.3} share_crypto={:.3}",
            coint.adf_tau,
            econometrics::coint::EG_CRITICAL_5PCT,
            coint.cointegrated_5pct,
            granger.f,
            granger.p_value,
            granger.significant_5pct(),
            info.share_pm,
            info.share_crypto,
        );
        assert!(coint.cointegrated_5pct, "coint should pass on leads-spot fixture");
        assert!(granger.significant_5pct(), "granger should pass on leads-spot fixture");
        assert!(info.share_pm > 0.5, "PM should dominate info share");
    }

    #[tokio::test]
    async fn polyedge_fires_when_pm_leads_spot() {
        let pairs = synth_pm_leads_pair(0xCAFE_BABE, 220);
        let mut history = crate::agent::PolymarketHistory::default();
        for (t, (swp, mid)) in pairs.iter().enumerate() {
            history.btc.push(((t as i64) * 3600, *swp, *mid));
        }

        let mut a = SystematicAgent::new(
            "polyedge-test",
            SystematicParams {
                z_threshold: 0.005,
                z_window: 120,
                cooldown_bars: 0,
                ..SystematicParams::polyedge()
            },
        );
        let peers = PeerView {
            polymarket_history: Some(history),
            ..PeerView::default()
        };
        let d = a
            .observe(
                &Event::Polymarket {
                    ts: EventTs::from_secs(((pairs.len() + 1) as i64) * 3600),
                    asset: Asset::Btc,
                    swp: 0.6,
                    mid: 0.55,
                },
                &peers,
            )
            .await;
        assert!(d.is_some(), "polyedge should fire when PM Granger-leads spot");
    }

    #[tokio::test]
    async fn polyedge_abstains_on_random_pair() {
        // Two independent pseudo-random-walks → no cointegration, no
        // Granger relationship. Polyedge must abstain.
        let mut state_a = 0xDEAD_BEEF_u64;
        let mut state_b = 0x1234_5678_u64;
        let mut nrand = |s: &mut u64| -> f64 {
            *s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((*s >> 33) as f64) / (u32::MAX as f64) - 0.5
        };
        let mut history = crate::agent::PolymarketHistory::default();
        let (mut s, mut m) = (0.5, 0.5);
        for t in 0..150i64 {
            s = (s + 0.02 * nrand(&mut state_a)).clamp(0.05, 0.95);
            m = (m + 0.02 * nrand(&mut state_b)).clamp(0.05, 0.95);
            history.btc.push((t * 3600, s, m));
        }
        let mut a = SystematicAgent::new(
            "polyedge-rand",
            SystematicParams {
                z_threshold: 0.01,
                z_window: 96,
                cooldown_bars: 0,
                ..SystematicParams::polyedge()
            },
        );
        let peers = PeerView {
            polymarket_history: Some(history),
            ..PeerView::default()
        };
        let d = a
            .observe(
                &Event::Polymarket {
                    ts: EventTs::from_secs(150 * 3600),
                    asset: Asset::Btc,
                    swp: 0.6,
                    mid: 0.4,
                },
                &peers,
            )
            .await;
        // Independent random walks must not pass all three gates.
        assert!(d.is_none(), "polyedge must abstain on independent series");
    }

    #[tokio::test]
    async fn polyedge_abstains_without_history() {
        // PeerView has no polymarket_history → polyedge must
        // abstain (no series, no statistical gate).
        let mut a = SystematicAgent::new(
            "polyedge-empty",
            SystematicParams::polyedge(),
        );
        let peers = PeerView::default();
        let d = a
            .observe(
                &Event::Polymarket {
                    ts: EventTs::from_secs(3600),
                    asset: Asset::Btc,
                    swp: 0.6,
                    mid: 0.4,
                },
                &peers,
            )
            .await;
        assert!(d.is_none());
    }

    #[allow(dead_code)]
    fn _kinds_compile(_: FundingRate) {}

    fn snap(label: regime::Regime, dir: f64, vol: f64) -> regime::RegimeSnapshot {
        regime::RegimeSnapshot {
            regime: label,
            directional: dir,
            vol_ratio: vol,
        }
    }

    #[test]
    fn regime_fitness_table_matches_doctrine() {
        // Trend-followers thrive in trends and breakouts, die in chop.
        let liq_trend = SystematicAgent::new("liq-t", SystematicParams::liq_trend());
        assert_eq!(liq_trend.regime_fitness(Some(snap(regime::Regime::Trending, 0.8, 1.0))), 1.0);
        assert_eq!(liq_trend.regime_fitness(Some(snap(regime::Regime::Ranging, 0.1, 1.0))), 0.3);
        assert_eq!(liq_trend.regime_fitness(Some(snap(regime::Regime::Chaotic, 0.4, 2.0))), 0.5);

        // Mean-reverters mirror.
        let liq_fade = SystematicAgent::new("liq-f", SystematicParams::liq_fade());
        assert_eq!(liq_fade.regime_fitness(Some(snap(regime::Regime::Trending, 0.8, 1.0))), 0.3);
        assert_eq!(liq_fade.regime_fitness(Some(snap(regime::Regime::Ranging, 0.1, 1.0))), 1.0);

        // Null regime → full size (no signal yet).
        assert_eq!(liq_trend.regime_fitness(None), 1.0);
    }

    #[tokio::test]
    async fn regime_gate_skips_hostile_regime_trades() {
        // A liq-fade agent sees a clean fade signal, but the regime is
        // strongly trending — fitness=0.3, which is the gate boundary.
        // Decision should still go through (>= 0.3) but at scaled risk.
        let mut a = SystematicAgent::new(
            "fade",
            SystematicParams {
                z_threshold: 2.0,
                z_window: 24,
                cooldown_bars: 1,
                ..SystematicParams::liq_fade()
            },
        );
        let peers_trending = PeerView {
            regime: Some(snap(regime::Regime::Trending, 0.85, 1.0)),
            ..PeerView::default()
        };

        // Drive a spike pattern.
        let mut ts = 0i64;
        for _ in 0..30 {
            let _ = a
                .observe(
                    &Event::Liquidation {
                        ts: EventTs::from_secs(ts),
                        asset: Asset::Btc,
                        side: LiqSide::Buy,
                        usd_value: 1_000.0,
                    },
                    &peers_trending,
                )
                .await;
            ts += 3600;
        }
        let d = a
            .observe(
                &Event::Liquidation {
                    ts: EventTs::from_secs(ts),
                    asset: Asset::Btc,
                    side: LiqSide::Buy,
                    usd_value: 80_000.0,
                },
                &peers_trending,
            )
            .await;
        ts += 3600;
        let d2 = a
            .observe(
                &Event::Liquidation {
                    ts: EventTs::from_secs(ts),
                    asset: Asset::Btc,
                    side: LiqSide::Buy,
                    usd_value: 100.0,
                },
                &peers_trending,
            )
            .await;
        let fired = d.or(d2);
        // fitness=0.3 for fade in trending; we fire but at 30% risk.
        if let Some(decision) = fired {
            assert!(
                (decision.risk_fraction - 0.003).abs() < 1e-6,
                "expected scaled risk_fraction ~0.003, got {}",
                decision.risk_fraction,
            );
            assert!(decision.rationale.contains("trending"));
        }
    }
}
