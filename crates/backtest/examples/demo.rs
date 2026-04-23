//! Synthetic backtest demo — proves the harness end-to-end.

use backtest::{run, synthetic};
// `domain::crypto::Asset` comes through backtest's public API indirectly, but
// we import it explicitly for readability.
use domain::crypto::Asset;
use paper_trader::TraderConfig;
use reports::write_pair;
use signal_engine::SignalConfig;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let scn = synthetic::generate(500, 1_234, Asset::Btc);
    let forward = synthetic::to_forward_data(&scn);

    let cfg = SignalConfig {
        min_edge: 0.02,
        min_is_pm: 0.01,
        min_granger_f: 1.0,
        min_gini: 0.4,
        max_crypto_z: 5.0,
        econ_lookback: 80,
        z_window: 20,
        granger_lag: 4,
        ..Default::default()
    };
    let trader = TraderConfig::default();

    let report = run("synthetic-v1", &scn.states, &forward, &cfg, &trader);
    println!("n_trades: {}", report.main.n_trades);
    println!("win_rate: {:.2}%", report.main.win_rate * 100.0);
    println!("total_pnl_usd: {:.2}", report.main.total_pnl_usd);
    println!("sharpe: {:.2}", report.main.sharpe);
    println!("profit_factor: {:.2}", report.main.profit_factor);
    println!("max_drawdown: {:.2}%", report.main.max_drawdown * 100.0);

    let md = report.render_markdown();
    let dir = PathBuf::from("reports/backtest/synthetic");
    write_pair(&dir, &format!("{}", chrono::Utc::now().timestamp()), &md, &report)?;
    Ok(())
}
