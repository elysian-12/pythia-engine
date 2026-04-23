//! Live signal firing.
//!
//! After each PM refresh cycle, walk every active condition and:
//! 1. Build a `MarketState` from the store.
//! 2. Call `signal_engine::evaluate`.
//! 3. When the gates admit, record the signal in the store and open a
//!    virtual paper trade against the forward candle stream.
//!
//! Latency per evaluation is recorded in the shared `LatencyCollector` so
//! the runtime report can highlight hot paths.

use std::collections::HashMap;
use std::sync::Arc;

use domain::{
    crypto::{Asset, Candle, FundingRate},
    ids::ConditionId,
    signal::{Signal, Trade},
    time::EventTs,
    trader::skill_score,
};
use evaluation::LatencyCollector;
use paper_trader::{atr, simulate, TraderConfig};
use signal_engine::{
    evaluate_with_reason, mapping, state::MarketState, swp, RejectReason, SignalConfig,
};
use store::Store;
use tracing::{debug, info};

use crate::{DataSource, IngestError, Ingestor};

/// Configuration for the live signal runner.
#[derive(Clone, Debug)]
pub struct LiveSignalCfg {
    pub signal: SignalConfig,
    pub trader: TraderConfig,
    pub econ_lookback: usize,
}

impl Default for LiveSignalCfg {
    fn default() -> Self {
        Self {
            // Live thresholds are permissive compared to backtest — the
            // rolling window is shorter and we want early firings for
            // validation. Tighten after calibration.
            signal: SignalConfig {
                min_edge: 0.03,
                min_is_pm: 0.05,
                min_granger_f: 1.5,
                min_gini: 0.4,
                max_crypto_z: 1.5,
                econ_lookback: 80,
                z_window: 24,
                granger_lag: 4,
                default_horizon_s: 6 * 3600,
            },
            trader: TraderConfig::default(),
            econ_lookback: 80,
        }
    }
}

/// Drive one live signal-evaluation pass across every tracked condition.
pub async fn evaluate_once<S: DataSource + Send + Sync>(
    ing: &Ingestor<S>,
    cfg: &LiveSignalCfg,
    latency: &LatencyCollector,
) -> Result<LiveStats, IngestError> {
    let conditions: Vec<ConditionId> = {
        let _s = latency.span("signal:load_conditions");
        ing.store.active_conditions()?
    };
    let profiles = {
        let _s = latency.span("signal:load_profiles");
        ing.store.latest_trader_profiles()?
    };
    let skill_lookup: HashMap<String, f64> = profiles
        .into_iter()
        .map(|p| (p.wallet.as_str().to_string(), skill_score(&p)))
        .collect();

    let btc_candles = ing.store.candles_asc(Asset::Btc, 200)?;
    let eth_candles = ing.store.candles_asc(Asset::Eth, 200)?;

    let mut stats = LiveStats::default();

    for cid in conditions {
        let _eval = latency.span("signal:evaluate");
        match build_and_evaluate(
            &ing.store,
            &cid,
            &skill_lookup,
            &btc_candles,
            &eth_candles,
            cfg,
            latency,
        )? {
            Outcome::Fired(sig) => {
                ing.store.insert_signal(&sig)?;
                stats.fired += 1;
                info!(cond=%cid, dir=?sig.direction, edge=%sig.edge, conv=%sig.conviction, "signal fired");
                // Open virtual paper trade — we don't wait for candles to
                // evolve; instead the trade is stored open and closed on a
                // later pass (see `maybe_close_trades`).
                if let Some(trade) = open_paper_trade(&sig, &ing.store, cfg)? {
                    ing.store.upsert_trade(&trade)?;
                    stats.trades_opened += 1;
                }
            }
            Outcome::Rejected(reason) => {
                debug!(cond=%cid, reject=?reason, "signal rejected");
                *stats.rejections.entry(classify(&reason)).or_insert(0) += 1;
            }
            Outcome::NoData => {
                stats.skipped += 1;
            }
        }
    }

    stats.wall_ns = latency.report(0).wall_clock_ns;
    Ok(stats)
}

enum Outcome {
    Fired(Signal),
    Rejected(RejectReason),
    NoData,
}

fn build_and_evaluate(
    store: &Store,
    cid: &ConditionId,
    skill_lookup: &HashMap<String, f64>,
    btc_candles: &[Candle],
    eth_candles: &[Candle],
    cfg: &LiveSignalCfg,
    latency: &LatencyCollector,
) -> Result<Outcome, IngestError> {
    let positions = {
        let _s = latency.span("signal:load_positions");
        store.latest_positions_for_condition(cid)?
    };
    if positions.is_empty() {
        return Ok(Outcome::NoData);
    }

    // Derive mapping from the first position's fields.
    let position_ref: Vec<&_> = positions.iter().collect();
    let Some(mapping) = mapping::map_position(&positions[0]) else {
        return Ok(Outcome::NoData);
    };
    let asset = match mapping.relevance {
        mapping::CryptoRelevance::Direct(a)
        | mapping::CryptoRelevance::Macro(a)
        | mapping::CryptoRelevance::Political(a) => a,
        mapping::CryptoRelevance::None => return Ok(Outcome::NoData),
    };

    let swp_value = swp::swp_from_positions(&position_ref, skill_lookup);
    let payload = store.latest_summary_payload(cid)?;
    let (mid, gini) = mid_and_gini_from_payload(payload.as_deref(), &position_ref, skill_lookup);

    let candles = match asset {
        Asset::Btc => btc_candles,
        Asset::Eth => eth_candles,
    };
    if candles.len() < cfg.econ_lookback + 2 {
        return Ok(Outcome::NoData);
    }

    // pm_series proxy from market_summary distribution is a single point;
    // for the regime gate we need a time series. During bootstrap we use
    // the position avg_prices ordered by latest_open_ts as a proxy.
    let mut pm_series: Vec<f64> = positions
        .iter()
        .filter(|p| p.avg_price > 0.0 && p.avg_price < 1.0)
        .map(|p| (p.latest_open_ts, p.avg_price))
        .collect::<Vec<_>>()
        .into_iter()
        .map(|(_, p)| p)
        .collect();
    pm_series.truncate(cfg.econ_lookback);
    if pm_series.len() < cfg.econ_lookback {
        return Ok(Outcome::NoData);
    }

    let crypto_series: Vec<f64> = candles
        .iter()
        .rev()
        .take(cfg.econ_lookback)
        .map(|c| c.close.ln())
        .collect();
    let crypto_response: Vec<f64> = candles
        .windows(2)
        .rev()
        .take(cfg.z_window_or_default())
        .map(|w| (w[1].close - w[0].close) / w[0].close)
        .collect();

    let state = MarketState {
        condition_id: cid.clone(),
        market_name: positions[0].market_name.clone(),
        asof: EventTs::from_secs(chrono::Utc::now().timestamp()),
        swp: swp_value,
        mid: Some(mid),
        pm_series,
        crypto_series,
        crypto_response,
        gini,
        asset_mapping: Some((asset, mapping.sign)),
        horizon_s: Some(mapping.horizon_s),
    };

    match evaluate_with_reason(&state, &cfg.signal) {
        Ok(sig) => Ok(Outcome::Fired(sig)),
        Err(reason) => Ok(Outcome::Rejected(reason)),
    }
}

impl LiveSignalCfg {
    fn z_window_or_default(&self) -> usize {
        self.signal.z_window.max(10)
    }
}

fn mid_and_gini_from_payload(
    payload_json: Option<&str>,
    positions: &[&domain::position::UserPosition],
    skill_lookup: &HashMap<String, f64>,
) -> (f64, f64) {
    use domain::market::{distribution_mid, MarketSummary};
    let mid = payload_json
        .and_then(|s| serde_json::from_str::<MarketSummary>(s).ok())
        .and_then(|ms| {
            ms.outcome_pricing
                .first()
                .and_then(|op| distribution_mid(&op.open_pos_avg_price_distribution))
        })
        .unwrap_or_else(|| {
            // Fallback: average of position avg_prices.
            let xs: Vec<f64> = positions.iter().map(|p| p.avg_price).collect();
            if xs.is_empty() {
                0.5
            } else {
                xs.iter().sum::<f64>() / xs.len() as f64
            }
        });

    let weights: Vec<f64> = positions
        .iter()
        .map(|p| {
            let size = (p.unrealized_size + p.realized_size).abs().sqrt();
            let skill = skill_lookup.get(p.wallet.as_str()).copied().unwrap_or(0.0);
            size * skill
        })
        .collect();
    let gini = econometrics::gini(&weights);
    (mid, gini)
}

fn open_paper_trade(
    sig: &Signal,
    store: &Store,
    cfg: &LiveSignalCfg,
) -> Result<Option<Trade>, IngestError> {
    let candles = store.candles_asc(sig.asset, 50)?;
    if candles.len() < cfg.trader.atr_window + 2 {
        return Ok(None);
    }
    let Some(entry_atr) = atr(&candles, cfg.trader.atr_window) else {
        return Ok(None);
    };
    // For live mode, the "entry" is the next-candle open we don't yet
    // have; we open the trade at the most recent close and let a future
    // close-pass mark it to market. This is what the UI shows as "open".
    let last = candles.last().cloned().expect("non-empty");
    let forward = vec![last.clone()];
    let empty_funding: Vec<FundingRate> = vec![];
    Ok(simulate(sig, &forward, &empty_funding, entry_atr, &cfg.trader))
}

#[derive(Debug, Default)]
pub struct LiveStats {
    pub fired: usize,
    pub trades_opened: usize,
    pub skipped: usize,
    pub rejections: HashMap<String, usize>,
    pub wall_ns: u64,
}

fn classify(r: &RejectReason) -> String {
    match r {
        RejectReason::SmallEdge(_) => "SmallEdge".into(),
        RejectReason::LowGini(_) => "LowGini".into(),
        RejectReason::IsPmTooLow(_) => "IsPmTooLow".into(),
        RejectReason::GrangerWeak(_) => "GrangerWeak".into(),
        RejectReason::GrangerInsignificant => "GrangerInsignificant".into(),
        RejectReason::CryptoAlreadyMoved(_) => "CryptoAlreadyMoved".into(),
        RejectReason::InsufficientHistory { .. } => "InsufficientHistory".into(),
        RejectReason::NoMapping => "NoMapping".into(),
        RejectReason::MissingInputs => "MissingInputs".into(),
        RejectReason::NumericFailure => "NumericFailure".into(),
    }
}

/// Convenience re-export so `Ingestor` can reach it.
pub use LiveSignalCfg as Cfg;

// `Arc` is held by the caller; no-op usage here to keep `Arc` in scope for
// doc-tests.
#[allow(dead_code)]
fn _arc_witness<T>(_: Arc<T>) {}
