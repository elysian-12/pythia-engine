//! Multi-strategy risk allocator.
//!
//! Assigns a fraction of portfolio risk to each active strategy
//! according to its recent Sharpe and the current market regime.
//! Handles the per-strategy kill-switch (rolling Sharpe < 0 disables
//! the strategy until it crosses back above a floor).

use std::collections::HashMap;

use parking_lot::Mutex;
use regime::Regime;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AllocatorCfg {
    /// Min rolling Sharpe at which a strategy stays active.
    pub kill_sharpe_threshold: f64,
    /// Min rolling trades before Sharpe is meaningful.
    pub min_trades_for_sharpe: usize,
    /// Cap any single strategy's share of portfolio risk.
    pub max_strategy_share: f64,
    /// Floor any single strategy's share (once active).
    pub min_strategy_share: f64,
}

impl Default for AllocatorCfg {
    fn default() -> Self {
        Self {
            kill_sharpe_threshold: 0.0,
            min_trades_for_sharpe: 10,
            max_strategy_share: 0.40,
            min_strategy_share: 0.05,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct StrategyStats {
    pub id: String,
    pub n_closed_trades: usize,
    pub rolling_sharpe: f64,
    /// Strategy profile: which regime it prefers (1 = favoured, 0.5 = neutral).
    pub regime_weights: RegimeWeights,
    /// Operator / tuner hint — can be 0 to fully disable.
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RegimeWeights {
    pub trending: f64,
    pub ranging: f64,
    pub chaotic: f64,
    pub calm: f64,
}

impl Default for RegimeWeights {
    fn default() -> Self {
        Self {
            trending: 1.0,
            ranging: 1.0,
            chaotic: 0.5,
            calm: 1.0,
        }
    }
}

impl RegimeWeights {
    pub fn for_regime(&self, r: Regime) -> f64 {
        match r {
            Regime::Trending => self.trending,
            Regime::Ranging => self.ranging,
            Regime::Chaotic => self.chaotic,
            Regime::Calm => self.calm,
        }
    }

    /// Preset for a pure trend-follower (liq-trend, vol-breakout, oi-mom).
    pub fn trend_follower() -> Self {
        Self {
            trending: 1.0,
            ranging: 0.3,
            chaotic: 0.6,
            calm: 0.5,
        }
    }

    /// Preset for a mean-reverter (funding-arb, xsec-momentum).
    pub fn mean_reverter() -> Self {
        Self {
            trending: 0.4,
            ranging: 1.0,
            chaotic: 0.4,
            calm: 0.8,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllocatorSnapshot {
    pub regime: Regime,
    pub weights: HashMap<String, f64>,
    pub killed: Vec<String>,
}

#[derive(Debug)]
pub struct Allocator {
    cfg: AllocatorCfg,
    state: Mutex<State>,
}

#[derive(Debug, Default)]
struct State {
    stats: HashMap<String, StrategyStats>,
}

impl Allocator {
    pub fn new(cfg: AllocatorCfg) -> Self {
        Self {
            cfg,
            state: Mutex::new(State::default()),
        }
    }

    pub fn update(&self, stats: StrategyStats) {
        let mut s = self.state.lock();
        s.stats.insert(stats.id.clone(), stats);
    }

    /// Compute current weights given the regime.
    pub fn snapshot(&self, regime: Regime) -> AllocatorSnapshot {
        let s = self.state.lock();
        let mut raw: Vec<(String, f64)> = Vec::new();
        let mut killed = Vec::new();
        for (id, stat) in &s.stats {
            if !stat.enabled {
                killed.push(id.clone());
                continue;
            }
            if stat.n_closed_trades >= self.cfg.min_trades_for_sharpe
                && stat.rolling_sharpe < self.cfg.kill_sharpe_threshold
            {
                killed.push(id.clone());
                continue;
            }
            // Score = regime preference × max(0, rolling_sharpe) + small floor
            let sharpe_boost = stat.rolling_sharpe.max(0.0) + 0.1;
            let score = stat.regime_weights.for_regime(regime) * sharpe_boost;
            raw.push((id.clone(), score.max(1e-9)));
        }

        let total: f64 = raw.iter().map(|(_, s)| *s).sum();
        let mut weights: HashMap<String, f64> = HashMap::new();
        if total > 0.0 {
            for (id, score) in raw {
                let w = (score / total)
                    .clamp(self.cfg.min_strategy_share, self.cfg.max_strategy_share);
                weights.insert(id, w);
            }
            // Re-normalise after clamping.
            let s: f64 = weights.values().sum();
            if s > 0.0 {
                for w in weights.values_mut() {
                    *w /= s;
                }
            }
        }

        AllocatorSnapshot {
            regime,
            weights,
            killed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disables_strategy_with_neg_sharpe() {
        let a = Allocator::new(AllocatorCfg::default());
        a.update(StrategyStats {
            id: "liq-trend".into(),
            n_closed_trades: 30,
            rolling_sharpe: 0.8,
            regime_weights: RegimeWeights::trend_follower(),
            enabled: true,
        });
        a.update(StrategyStats {
            id: "funding-arb".into(),
            n_closed_trades: 30,
            rolling_sharpe: -0.2,
            regime_weights: RegimeWeights::mean_reverter(),
            enabled: true,
        });
        let snap = a.snapshot(Regime::Trending);
        assert!(snap.killed.contains(&"funding-arb".to_string()));
        assert!(snap.weights.contains_key("liq-trend"));
    }

    #[test]
    fn regime_tilts_weights() {
        let a = Allocator::new(AllocatorCfg::default());
        a.update(StrategyStats {
            id: "liq-trend".into(),
            n_closed_trades: 30,
            rolling_sharpe: 0.6,
            regime_weights: RegimeWeights::trend_follower(),
            enabled: true,
        });
        a.update(StrategyStats {
            id: "funding-arb".into(),
            n_closed_trades: 30,
            rolling_sharpe: 0.5,
            regime_weights: RegimeWeights::mean_reverter(),
            enabled: true,
        });
        let snap_trend = a.snapshot(Regime::Trending);
        let w_trend_liq = *snap_trend.weights.get("liq-trend").unwrap();
        let snap_range = a.snapshot(Regime::Ranging);
        let w_range_liq = *snap_range.weights.get("liq-trend").unwrap();
        assert!(w_trend_liq > w_range_liq, "{} vs {}", w_trend_liq, w_range_liq);
    }
}
