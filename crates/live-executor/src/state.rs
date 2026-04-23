//! Persistent state for crash-safe restarts.
//!
//! Written atomically (write-to-tmp, rename) on every mutation so a
//! mid-update crash never leaves the file truncated.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct StatePath(pub PathBuf);

impl StatePath {
    pub fn default_path() -> Self {
        Self(PathBuf::from("data/pythia-live.json"))
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct LiveState {
    /// Last signal timestamp per symbol (seconds since epoch).
    pub last_signal_ts: HashMap<String, i64>,
    /// Open positions, keyed by symbol. `None` = flat.
    pub open_positions: HashMap<String, OpenPosition>,
    /// Starting equity recorded on first boot.
    pub starting_equity: f64,
    /// Highest observed equity — for drawdown calculation.
    pub peak_equity: f64,
    /// Counters for heartbeat / observability.
    pub total_signals_fired: u64,
    pub total_trades_opened: u64,
    pub total_trades_closed: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenPosition {
    pub symbol: String,
    pub side: String, // "LONG" | "SHORT"
    pub size: f64,
    pub entry_price: f64,
    pub stop_price: f64,
    pub tp_price: f64,
    pub entry_ts: i64,
    pub time_stop_ts: i64,
}

impl LiveState {
    pub fn load(path: &Path) -> std::io::Result<Self> {
        let bytes = std::fs::read(path)?;
        serde_json::from_slice(&bytes).map_err(std::io::Error::other)
    }

    pub fn load_or_default(path: &Path) -> Self {
        Self::load(path).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let tmp = path.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn roundtrip() {
        let dir = tempdir();
        let path = dir.join("state.json");
        let mut s = LiveState::default();
        s.starting_equity = 1_000.0;
        s.total_signals_fired = 42;
        s.save(&path).unwrap();

        let loaded = LiveState::load(&path).unwrap();
        assert_eq!(loaded.starting_equity, 1_000.0);
        assert_eq!(loaded.total_signals_fired, 42);
    }

    #[test]
    fn missing_file_returns_default() {
        let dir = tempdir();
        let path = dir.join("nope.json");
        let s = LiveState::load_or_default(&path);
        assert_eq!(s.total_signals_fired, 0);
    }

    fn tempdir() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("pythia-live-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        // ensure it isn't empty so rename works on CI
        let _ = std::fs::File::create(p.join(".marker")).map(|mut f| f.write_all(b""));
        p
    }
}
