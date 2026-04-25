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
