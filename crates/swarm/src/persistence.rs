//! Population persistence — survive restarts.
//!
//! At the end of every backtest (and periodically during live runs) we
//! serialise the *current* systematic agent population (id + params) plus
//! the generation counter and lifetime stats to a JSON file. On startup,
//! the binary attempts to load this file; if successful, the swarm boots
//! from the evolved roster instead of the static `house_roster`. If
//! deserialisation fails (schema drift, file missing) the binary falls
//! back to the seed roster — so persistence is best-effort and never
//! blocks startup.
//!
//! This is what makes "subsequent runs build on prior evolution" work.
//! Without it every restart would discard the genetic search progress.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::scoring::AgentStats;
use crate::systematic::SystematicParams;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PersistedAgent {
    pub id: String,
    pub params: SystematicParams,
    /// Lifetime stats from the prior run — used to seed the new
    /// scoreboard so evolution has signal from event 1, not event 500.
    #[serde(default)]
    pub stats: Option<AgentStats>,
    /// Per-trade R series (oldest first, capped). Used by the evaluation
    /// crate to recompute PSR / DSR / Sharpe CI on resumed runs without
    /// re-running 365 days of replay.
    #[serde(default)]
    pub r_history: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PersistedPopulation {
    pub saved_at: i64,
    pub generation: u64,
    pub n_events: u64,
    pub agents: Vec<PersistedAgent>,
}

impl PersistedPopulation {
    pub fn load<P: AsRef<Path>>(path: P) -> Option<Self> {
        let raw = fs::read_to_string(path).ok()?;
        serde_json::from_str(&raw).ok()
    }

    pub fn save<P: AsRef<Path>>(&self, path: P) -> std::io::Result<()> {
        if let Some(parent) = path.as_ref().parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        fs::write(path, json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scoring::AgentStats;
    use crate::systematic::SystematicParams;

    #[test]
    fn round_trip_preserves_params_stats_and_r_history() {
        let mut stats = AgentStats {
            agent_id: "liq-trend-v0".into(),
            total_decisions: 42,
            wins: 25,
            losses: 17,
            total_r: 12.34,
            ..Default::default()
        };
        stats.gross_win_r = 30.0;
        stats.gross_loss_r = 17.66;
        stats.profit_factor = 30.0 / 17.66;
        stats.expectancy_r = 12.34 / 42.0;

        let pop = PersistedPopulation {
            saved_at: 1_700_000_000,
            generation: 7,
            n_events: 3500,
            agents: vec![PersistedAgent {
                id: "liq-trend-v0".into(),
                params: SystematicParams::liq_trend(),
                stats: Some(stats.clone()),
                r_history: vec![1.0, -0.8, 2.5, -1.0, 0.3],
            }],
        };

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pop.json");
        pop.save(&path).unwrap();
        let loaded = PersistedPopulation::load(&path).expect("loads");
        assert_eq!(loaded.generation, 7);
        assert_eq!(loaded.agents.len(), 1);
        let a = &loaded.agents[0];
        assert_eq!(a.id, "liq-trend-v0");
        assert_eq!(a.r_history.len(), 5);
        let s = a.stats.as_ref().unwrap();
        assert_eq!(s.wins, 25);
        assert!((s.gross_win_r - 30.0).abs() < 1e-9);
    }

    #[test]
    fn missing_file_returns_none_without_error() {
        let path = std::path::Path::new("/tmp/this-file-should-not-exist-pythia.json");
        assert!(PersistedPopulation::load(path).is_none());
    }

    #[test]
    fn old_format_without_r_history_still_loads() {
        // Backward-compat: prior runs wrote files without `r_history`.
        // The #[serde(default)] should produce an empty vec.
        let json = r#"{
            "saved_at": 1,
            "generation": 1,
            "n_events": 1,
            "agents": [{
                "id": "x",
                "params": {
                    "family": {"LiqZScore": {"trend_follow": true}},
                    "z_threshold": 2.5, "z_window": 48, "cooldown_bars": 6,
                    "horizon_hours": 4, "risk_fraction": 0.01,
                    "asset_filter": null, "donchian_bars": 24, "atr_pct_min": 0.004
                }
            }]
        }"#;
        let p: PersistedPopulation = serde_json::from_str(json).unwrap();
        assert_eq!(p.agents.len(), 1);
        assert!(p.agents[0].r_history.is_empty());
        assert!(p.agents[0].stats.is_none());
    }
}
