//! Report renderers — markdown + JSON side-by-side for every report type.
//!
//! Every report has:
//! - a typed struct (serde for JSON)
//! - a `render_markdown()` that produces a shareable document
//!
//! Reports consumed by the `api` crate for `/reports/*` routes and by the
//! backtest runner for filesystem artifacts.

#![deny(unused_must_use)]

pub mod backtest_report;
pub mod signal_report;

pub use backtest_report::BacktestReport;
pub use signal_report::SignalReport;

use serde::Serialize;
use std::{fs, io, path::Path};

pub fn write_pair<T: Serialize>(dir: &Path, name: &str, md: &str, data: &T) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    fs::write(dir.join(format!("{name}.md")), md)?;
    let json = serde_json::to_string_pretty(data).map_err(io::Error::other)?;
    fs::write(dir.join(format!("{name}.json")), json)?;
    Ok(())
}
