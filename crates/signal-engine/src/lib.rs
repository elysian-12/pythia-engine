//! Signal engine.
//!
//! Pure-functional core: given a `MarketState` and a `SignalConfig` decide
//! whether to fire a `Signal`, what direction, and with what conviction.
//!
//! The engine does not touch I/O; callers (api, backtest) build `MarketState`
//! snapshots from the store and feed them in.

#![deny(unused_must_use)]

pub mod mapping;
pub mod state;
pub mod swp;

use domain::signal::{Direction, Signal};
use econometrics::{
    cointegration_test, granger_f, information_share_proxy, zscore_last,
};
use serde::{Deserialize, Serialize};

pub use mapping::{CryptoRelevance, MarketAssetMapping};
pub use state::MarketState;
pub use swp::{swp_from_positions, swp_from_distribution, PositionWithSkill};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SignalConfig {
    /// Minimum |EdgeGap| in probability points to consider firing (0..1).
    pub min_edge: f64,
    /// Max allowed |z-score| of crypto response (signal needs crypto *not*
    /// yet to have priced it in).
    pub max_crypto_z: f64,
    /// Minimum info-share(PM) for the regime to be eligible.
    pub min_is_pm: f64,
    /// Minimum Granger F for PM → crypto at lag `granger_lag`.
    pub min_granger_f: f64,
    /// Granger / info-share lag (candles).
    pub granger_lag: usize,
    /// Minimum Gini of skill-weighted positions (to filter low-concentration).
    pub min_gini: f64,
    /// Lookback for cointegration + Granger (candles).
    pub econ_lookback: usize,
    /// Z-score rolling window for crypto response.
    pub z_window: usize,
    /// Category-specific horizon in seconds (fallback when map has no entry).
    pub default_horizon_s: i64,
}

impl Default for SignalConfig {
    fn default() -> Self {
        Self {
            min_edge: 0.03,
            max_crypto_z: 1.0,
            min_is_pm: 0.15,
            min_granger_f: 3.0,
            granger_lag: 4,
            min_gini: 0.45,
            econ_lookback: 100,
            z_window: 60,
            default_horizon_s: 8 * 3600,
        }
    }
}

/// Why a signal didn't fire — used for UI diagnostics and tests.
#[derive(Clone, Debug, PartialEq)]
pub enum RejectReason {
    MissingInputs,
    SmallEdge(f64),
    LowGini(f64),
    InsufficientHistory { have: usize, need: usize },
    IsPmTooLow(f64),
    GrangerWeak(f64),
    GrangerInsignificant,
    CryptoAlreadyMoved(f64),
    NoMapping,
    NumericFailure,
}

/// Evaluate all gates. Returns `Ok(signal)` if fires, `Err(reason)` otherwise.
pub fn evaluate_with_reason(state: &MarketState, cfg: &SignalConfig) -> Result<Signal, RejectReason> {
    let swp = state.swp.ok_or(RejectReason::MissingInputs)?;
    let mid = state.mid.ok_or(RejectReason::MissingInputs)?;
    let edge = swp - mid;
    if edge.abs() < cfg.min_edge {
        return Err(RejectReason::SmallEdge(edge));
    }
    if state.gini < cfg.min_gini {
        return Err(RejectReason::LowGini(state.gini));
    }
    let need = cfg.econ_lookback;
    if state.pm_series.len() < need || state.crypto_series.len() < need {
        return Err(RejectReason::InsufficientHistory {
            have: state.pm_series.len().min(state.crypto_series.len()),
            need,
        });
    }
    let pm_window = &state.pm_series[state.pm_series.len() - need..];
    let cx_window = &state.crypto_series[state.crypto_series.len() - need..];

    let is = information_share_proxy(pm_window, cx_window, cfg.granger_lag)
        .map_err(|_| RejectReason::NumericFailure)?;
    if is.share_pm < cfg.min_is_pm {
        return Err(RejectReason::IsPmTooLow(is.share_pm));
    }

    let gr = granger_f(cx_window, pm_window, cfg.granger_lag)
        .map_err(|_| RejectReason::NumericFailure)?;
    if gr.f < cfg.min_granger_f {
        return Err(RejectReason::GrangerWeak(gr.f));
    }
    if !gr.significant_5pct() {
        return Err(RejectReason::GrangerInsignificant);
    }

    let z = zscore_last(&state.crypto_response, cfg.z_window)
        .ok_or(RejectReason::NumericFailure)?;
    if z.abs() > cfg.max_crypto_z {
        return Err(RejectReason::CryptoAlreadyMoved(z));
    }

    let (asset, sign) = state.asset_mapping.ok_or(RejectReason::NoMapping)?;
    let dir = if edge * f64::from(sign) > 0.0 {
        Direction::Long
    } else {
        Direction::Short
    };
    let conviction = compose_conviction(edge.abs(), is.share_pm, gr.f, state.gini, z);

    Ok(Signal {
        id: format!(
            "{}-{}-{}",
            state.condition_id.as_str().chars().take(10).collect::<String>(),
            state.asof.0,
            asset.coin()
        ),
        ts: state.asof,
        condition_id: state.condition_id.clone(),
        market_name: state.market_name.clone(),
        asset,
        direction: dir,
        swp,
        mid,
        edge,
        is_pm: is.share_pm,
        granger_f: gr.f,
        gini: state.gini,
        conviction,
        horizon_s: state.horizon_s.unwrap_or(cfg.default_horizon_s),
    })
}

/// Evaluate all gates. Returns `None` if any gate fails.
pub fn evaluate(state: &MarketState, cfg: &SignalConfig) -> Option<Signal> {
    let out = evaluate_with_reason(state, cfg).ok();
    // Best-effort cointegration log for observability.
    if out.is_some()
        && state.pm_series.len() >= cfg.econ_lookback
        && state.crypto_series.len() >= cfg.econ_lookback
    {
        let need = cfg.econ_lookback;
        let pmw = &state.pm_series[state.pm_series.len() - need..];
        let cxw = &state.crypto_series[state.crypto_series.len() - need..];
        if let Ok(c) = cointegration_test(pmw, cxw) {
            tracing::debug!(adf=%c.adf_tau, coint=%c.cointegrated_5pct, "coint aux");
        }
    }
    out
}

/// Compose a 0..100 conviction score. Weights tuned so a "perfect" signal
/// (edge 0.1, share_pm 0.6, F 20, gini 0.8, z 0) ≈ 90.
fn compose_conviction(edge_abs: f64, is_pm: f64, f: f64, gini: f64, z: f64) -> u8 {
    let edge_score = (edge_abs / 0.1).min(1.0);
    let is_score = (is_pm / 0.5).min(1.0);
    let f_score = (f / 20.0).min(1.0);
    let gini_score = ((gini - 0.4) / 0.5).clamp(0.0, 1.0);
    let z_penalty = (1.0 - (z.abs() / 1.0)).clamp(0.0, 1.0);

    let raw = 0.3 * edge_score
        + 0.25 * is_score
        + 0.2 * f_score
        + 0.15 * gini_score
        + 0.10 * z_penalty;
    (raw * 100.0).round().clamp(0.0, 100.0) as u8
}

/// Convenience: build the next-available `Signal` for a list of market states
/// under one config. The first one that passes all gates wins — ties are
/// broken by absolute edge.
pub fn best(states: &[MarketState], cfg: &SignalConfig) -> Option<Signal> {
    let mut candidates: Vec<Signal> =
        states.iter().filter_map(|s| evaluate(s, cfg)).collect();
    candidates.sort_by(|a, b| {
        b.edge
            .abs()
            .partial_cmp(&a.edge.abs())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    candidates.into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::{crypto::Asset, ids::ConditionId, time::EventTs};

    fn synthetic_state(edge: f64, gini: f64, asset: Asset) -> MarketState {
        // 200 points: pm is a shock-driven series; crypto depends on pm with
        // lag 2 plus its own shock. pm's past therefore strictly predicts
        // crypto beyond crypto's own history.
        fn lcg(state: &mut u64) -> f64 {
            *state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((*state >> 33) as f64) / (u32::MAX as f64) - 0.5
        }
        let mut seed = 42u64;
        let mut pm = vec![0.0; 200];
        let mut cx = vec![0.0; 200];
        for t in 1..200 {
            pm[t] = pm[t - 1] + 0.4 * lcg(&mut seed);
        }
        for t in 2..200 {
            cx[t] = 0.8 * pm[t - 2] + 0.4 * lcg(&mut seed);
        }
        MarketState {
            condition_id: ConditionId::new("0xcond"),
            market_name: "Test market".into(),
            asof: EventTs::from_secs(1_700_000_000),
            swp: Some(0.5 + edge / 2.0),
            mid: Some(0.5 - edge / 2.0),
            pm_series: pm.clone(),
            crypto_series: cx.clone(),
            crypto_response: (0..200).map(|i| (i as f64 * 0.11).sin()).collect(),
            gini,
            asset_mapping: Some((asset, 1)),
            horizon_s: Some(2 * 3600),
        }
    }

    #[test]
    fn fires_on_strong_signal() {
        let cfg = SignalConfig {
            min_is_pm: 0.01,
            min_granger_f: 1.0,
            min_gini: 0.4,
            max_crypto_z: 5.0,
            econ_lookback: 80,
            z_window: 20,
            ..Default::default()
        };
        let st = synthetic_state(0.08, 0.6, Asset::Btc);
        let r = evaluate_with_reason(&st, &cfg);
        let s = r.unwrap_or_else(|reason| panic!("should fire, got reject: {:?}", reason));
        assert!(s.edge.abs() >= cfg.min_edge);
        assert_eq!(s.asset, Asset::Btc);
    }

    #[test]
    fn rejects_small_edge() {
        let cfg = SignalConfig::default();
        let st = synthetic_state(0.005, 0.7, Asset::Btc);
        assert!(evaluate(&st, &cfg).is_none());
    }

    #[test]
    fn rejects_low_gini() {
        let cfg = SignalConfig {
            min_is_pm: 0.05,
            min_granger_f: 1.0,
            ..Default::default()
        };
        let st = synthetic_state(0.08, 0.2, Asset::Btc);
        assert!(evaluate(&st, &cfg).is_none());
    }
}
