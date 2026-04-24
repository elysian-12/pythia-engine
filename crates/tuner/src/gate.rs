//! Statistical gate: decide whether to invoke the expensive LLM call.
//!
//! A tuning cycle is only useful when something has *actually changed*.
//! We save both money and risk by skipping the LLM when the strategy
//! is performing within its historical envelope.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GateStats {
    pub rolling_sharpe_30: f64,
    pub baseline_sharpe: f64,
    pub rolling_win_rate: f64,
    pub baseline_win_rate: f64,
    pub current_drawdown: f64,
    pub regime_changed: bool,
    pub days_since_last_tune: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum GateDecision {
    /// No tuning needed — metrics are within the historical envelope.
    Skip(String),
    /// Tune, but confidence threshold is high (small anomaly).
    Tune { confidence_floor: f64, reason: String },
    /// Urgent tuning — confidence floor relaxed because evidence is strong.
    UrgentTune { reason: String },
}

/// Decide whether to invoke the LLM. Pure function.
pub fn gate(s: &GateStats) -> GateDecision {
    // Never tune with fresh data in drawdown — recency-bias overfit trap.
    if s.current_drawdown > 0.08 {
        return GateDecision::Skip(format!(
            "in drawdown ({:.1} %) — hold parameters until recovery to avoid overfitting",
            s.current_drawdown * 100.0
        ));
    }

    // Always tune after 14 days regardless.
    if s.days_since_last_tune > 14.0 {
        return GateDecision::Tune {
            confidence_floor: 70.0,
            reason: "scheduled periodic review".into(),
        };
    }

    // Regime flip trumps everything — strategy weights may need rebalancing.
    if s.regime_changed {
        return GateDecision::UrgentTune {
            reason: "regime changed since last tune".into(),
        };
    }

    // Statistically material Sharpe degradation (≥ 1σ drop vs baseline).
    let sharpe_drop = s.baseline_sharpe - s.rolling_sharpe_30;
    if sharpe_drop > 0.3 {
        return GateDecision::UrgentTune {
            reason: format!("Sharpe dropped {:.2} below baseline", sharpe_drop),
        };
    }
    if sharpe_drop > 0.15 {
        return GateDecision::Tune {
            confidence_floor: 75.0,
            reason: format!("mild Sharpe decay ({:.2})", sharpe_drop),
        };
    }

    // Win-rate regime shift.
    if (s.rolling_win_rate - s.baseline_win_rate).abs() > 0.10 {
        return GateDecision::Tune {
            confidence_floor: 75.0,
            reason: "win-rate shifted > 10 pts".into(),
        };
    }

    // Skip.
    GateDecision::Skip("metrics within historical envelope".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh(win: f64, sharpe: f64) -> GateStats {
        GateStats {
            rolling_sharpe_30: sharpe,
            baseline_sharpe: 0.65,
            rolling_win_rate: win,
            baseline_win_rate: 0.75,
            current_drawdown: 0.02,
            regime_changed: false,
            days_since_last_tune: 3.0,
        }
    }

    #[test]
    fn healthy_skipped() {
        assert!(matches!(gate(&fresh(0.73, 0.62)), GateDecision::Skip(_)));
    }

    #[test]
    fn sharpe_drop_triggers() {
        assert!(matches!(
            gate(&fresh(0.70, 0.20)),
            GateDecision::UrgentTune { .. }
        ));
    }

    #[test]
    fn deep_dd_blocks_tune() {
        let mut s = fresh(0.70, 0.20);
        s.current_drawdown = 0.15;
        assert!(matches!(gate(&s), GateDecision::Skip(_)));
    }
}
