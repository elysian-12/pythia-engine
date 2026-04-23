//! Declarative strategy variants.

use paper_trader::TraderConfig;
use serde::{Deserialize, Serialize};
use signal_engine::SignalConfig;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StrategyVariant {
    pub name: String,
    pub signal: SignalConfig,
    pub trader: TraderConfig,
}

/// Default ablation grid. Deliberately kept tight — too many variants
/// inflates PBO and makes DSR punish everything.
pub fn default_grid() -> Vec<StrategyVariant> {
    // Base thresholds are deliberately loose so every variant produces
    // enough trades to evaluate. Production `SignalConfig::default()` is
    // tighter; the ablation measures which gate adds statistical value
    // relative to a permissive baseline.
    let base_signal = SignalConfig {
        min_edge: 0.02,
        min_is_pm: 0.01,
        min_granger_f: 1.0,
        min_gini: 0.4,
        max_crypto_z: 5.0,
        econ_lookback: 80,
        z_window: 20,
        granger_lag: 4,
        default_horizon_s: 6 * 3600,
    };
    let base_trader = TraderConfig::default();

    let mut v = Vec::new();

    v.push(StrategyVariant {
        name: "flagship".into(),
        signal: base_signal.clone(),
        trader: base_trader.clone(),
    });

    v.push(StrategyVariant {
        name: "no-econ-gate".into(),
        signal: SignalConfig {
            min_is_pm: 0.0,
            min_granger_f: 0.0,
            ..base_signal.clone()
        },
        trader: base_trader.clone(),
    });

    v.push(StrategyVariant {
        name: "granger-strict".into(),
        signal: SignalConfig {
            min_granger_f: 3.0,
            ..base_signal.clone()
        },
        trader: base_trader.clone(),
    });

    v.push(StrategyVariant {
        name: "info-share-strict".into(),
        signal: SignalConfig {
            min_is_pm: 0.10,
            ..base_signal.clone()
        },
        trader: base_trader.clone(),
    });

    v.push(StrategyVariant {
        name: "wide-edge".into(),
        signal: SignalConfig {
            min_edge: 0.05,
            ..base_signal.clone()
        },
        trader: base_trader.clone(),
    });

    v.push(StrategyVariant {
        name: "tight-stops".into(),
        signal: base_signal.clone(),
        trader: TraderConfig {
            stop_atr_mult: 1.0,
            tp_atr_mult: 2.0,
            ..base_trader.clone()
        },
    });

    v.push(StrategyVariant {
        name: "wide-stops".into(),
        signal: base_signal.clone(),
        trader: TraderConfig {
            stop_atr_mult: 2.0,
            tp_atr_mult: 5.0,
            ..base_trader.clone()
        },
    });

    v.push(StrategyVariant {
        name: "short-horizon".into(),
        signal: SignalConfig {
            default_horizon_s: 2 * 3600,
            ..base_signal.clone()
        },
        trader: base_trader.clone(),
    });

    v.push(StrategyVariant {
        name: "long-horizon".into(),
        signal: SignalConfig {
            default_horizon_s: 24 * 3600,
            ..base_signal.clone()
        },
        trader: base_trader.clone(),
    });

    v.push(StrategyVariant {
        name: "low-gini".into(),
        signal: SignalConfig {
            min_gini: 0.2,
            ..base_signal
        },
        trader: base_trader,
    });

    v
}
