//! `ablate` — run the default ablation grid on a dataset.
//!
//! Modes:
//! - `--synthetic <N>`: generate N deterministic states (default 500) and
//!   run the harness. Useful to sanity-check the pipeline.
//! - `--from-store <path>`: (future) load `MarketState` snapshots from the
//!   DuckDB store populated by the live ingestor.
//!
//! Writes `reports/ablation/<timestamp>/ablation.{md,json}`.

use std::path::PathBuf;
use std::time::Instant;

use backtest::synthetic;
use domain::crypto::Asset;
use reports::write_pair;
use strategy::{default_grid, run_ablation};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(|s| s.as_str()).unwrap_or("--synthetic");
    let scn_n: usize = args
        .get(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(500);

    let wall = Instant::now();
    println!("mode={mode} n={scn_n}");

    let (states, forward) = match mode {
        "--synthetic" => {
            let scn = synthetic::generate(scn_n, 1_234, Asset::Btc);
            let fwd = synthetic::to_forward_data(&scn);
            (scn.states, fwd)
        }
        "--mixed" => {
            let scn = synthetic::generate_mixed(scn_n, 1_234, Asset::Btc);
            let fwd = synthetic::to_forward_data(&scn);
            (scn.states, fwd)
        }
        _ => {
            eprintln!("unsupported mode '{mode}'; falling back to --synthetic");
            let scn = synthetic::generate(scn_n, 1_234, Asset::Btc);
            let fwd = synthetic::to_forward_data(&scn);
            (scn.states, fwd)
        }
    };

    let variants = default_grid();
    println!("variants={}", variants.len());

    let report = run_ablation(&states, &forward, &variants);
    println!(
        "winner={:?}  pbo={:.2}  wall_elapsed_ms={:.1}",
        report.winner,
        report.pbo,
        wall.elapsed().as_millis()
    );
    for r in &report.rows {
        println!(
            "  {:<18} trades={:>3} pnl={:+8.0} sharpe={:+.2} dsr={:.2} score={:+.3}",
            r.name,
            r.backtest.main.n_trades,
            r.backtest.main.total_pnl_usd,
            r.backtest.main.sharpe,
            r.dsr_after_selection,
            r.score
        );
    }

    let ts = chrono::Utc::now().timestamp();
    let dir = PathBuf::from(format!("reports/ablation/{ts}"));
    let md = report.render_markdown();
    write_pair(&dir, "ablation", &md, &report)?;
    println!("wrote {}", dir.display());
    Ok(())
}
