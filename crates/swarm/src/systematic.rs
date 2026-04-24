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

use crate::agent::{AgentDecision, AgentKind, AgentProfile, Event, PeerView, SwarmAgent};

/// The family of rule each systematic agent belongs to. Determines
/// which inputs it consumes.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum RuleFamily {
    /// Fires on rolling-z of hourly net liquidation.
    LiqZScore { trend_follow: bool },
    /// Fires on rolling-z of funding rate.
    FundingZScore { trend_follow: bool },
    /// Fires on Donchian breakout with ATR floor.
    VolBreakout,
}

#[derive(Clone, Debug)]
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

    fn decide_for_asset(&mut self, asset: Asset, ts: EventTs) -> Option<AgentDecision> {
        let params = self.params.clone();
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
        };
        window.last_signal_bar = window.bar_counter;
        let conviction = 80; // simple constant; future: derive from |z|
        Some(AgentDecision {
            id: next_decision_id(),
            agent_id: self.id.clone(),
            ts,
            asset,
            direction,
            conviction,
            risk_fraction: params.risk_fraction,
            horizon_s: params.horizon_hours * 3600,
            rationale: format!("{:?}", params.family),
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

    async fn observe(&mut self, event: &Event, _peers: &PeerView) -> Option<AgentDecision> {
        match event {
            Event::Liquidation { ts, asset, side, usd_value } => {
                if !self.passes_asset_filter(*asset) {
                    return None;
                }
                if self.window_mut(*asset).push_liq(ts.0, *side, *usd_value).is_some() {
                    // a new hourly bucket just closed — evaluate
                    return self.decide_for_asset(*asset, *ts);
                }
                None
            }
            Event::Candle { ts, asset, candle } => {
                if !self.passes_asset_filter(*asset) {
                    return None;
                }
                self.window_mut(*asset).push_candle(candle.open, candle.high, candle.low, candle.close);
                if matches!(self.params.family, RuleFamily::VolBreakout) {
                    return self.decide_for_asset(*asset, *ts);
                }
                None
            }
            Event::Funding { ts, asset, funding } => {
                if !self.passes_asset_filter(*asset) {
                    return None;
                }
                self.window_mut(*asset).push_funding(funding.rate_close);
                if matches!(self.params.family, RuleFamily::FundingZScore { .. }) {
                    return self.decide_for_asset(*asset, *ts);
                }
                None
            }
            Event::OpenInterest { .. } | Event::HourClose { .. } => None,
        }
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
        assert_eq!(agents.len(), 20);
        let ids: Vec<&str> = agents.iter().map(|a| a.id()).collect();
        assert!(ids.contains(&"liq-trend-v0"));
        assert!(ids.contains(&"vol-breakout-v0"));
        assert!(ids.contains(&"liq-trend-kelly"));
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

    #[allow(dead_code)]
    fn _kinds_compile(_: FundingRate) {}
}
