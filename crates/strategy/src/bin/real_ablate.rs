//! `real_ablate` — profitability test on the real 365-day dataset.
//!
//! Loads candles/funding/OI/liquidations from DuckDB for BTC and ETH,
//! runs every crypto-native strategy on each asset, combines results,
//! computes publication-grade metrics (Sharpe, PSR, DSR, bootstrap CI,
//! PBO across the grid), and writes a comprehensive PnL report.
//!
//! Run:  `cargo run --release -p strategy --bin real_ablate`

use std::{path::PathBuf, time::Instant};

use backtest::{run_signal_stream, ForwardData};
use domain::{
    crypto::{Asset, Candle, FundingRate, LiqSide, Liquidation, OpenInterest},
    signal::Signal,
    time::EventTs,
};
use evaluation::{
    block_bootstrap_sharpe, deflated_sharpe_ratio, probabilistic_sharpe_ratio,
    probability_of_backtest_overfitting, LatencyCollector,
};
use paper_trader::{Sizing, TraderConfig};
use reports::{backtest_report::RiskMetrics, write_pair, BacktestReport};
use strategy::confluence::{filter_signals, ConfluenceCfg};
use strategy::crypto_native::{
    baselines::buy_and_hold, ensemble::Ensemble, funding_rev::FundingReversion,
    liq_fade::LiquidationFade, oi_div::OiDivergence, vol_bo::VolBreakout, AssetInput,
    CryptoStrategy,
};
use store::Store;
use tracing_subscriber::EnvFilter;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    let db_path =
        std::env::var("PYTHIA_DB").unwrap_or_else(|_| "data/pythia.duckdb".into());
    let store = Store::open(&db_path)?;
    let latency = LatencyCollector::new();
    let wall = Instant::now();

    // Pull full history into memory: 8760 rows per series per asset — trivial.
    tracing::info!("loading {}", db_path);
    let btc = {
        let _s = latency.span("load:btc");
        load_asset(&store, Asset::Btc)?
    };
    let eth = {
        let _s = latency.span("load:eth");
        load_asset(&store, Asset::Eth)?
    };
    tracing::info!(
        btc_candles = btc.candles.len(),
        eth_candles = eth.candles.len(),
        "history loaded"
    );

    // Forward-data cache for the paper trader.
    let mut forward = ForwardData::default();
    forward.candles.insert(Asset::Btc, btc.candles.clone());
    forward.candles.insert(Asset::Eth, eth.candles.clone());
    forward.funding.insert(Asset::Btc, btc.funding.clone());
    forward.funding.insert(Asset::Eth, eth.funding.clone());

    // Strategy grid — fade + trend variants of every thesis plus two
    // ensembles (naive + trend-biased).
    let trader = TraderConfig::default();

    // Stress test with elevated costs: 10 bps taker + 5 bps slippage.
    let stress_trader = TraderConfig {
        taker_fee_bps: 10.0,
        slippage_bps: 5.0,
        ..TraderConfig::default()
    };

    let strategies: Vec<Box<dyn CryptoStrategy>> = vec![
        Box::new(FundingReversion::default()),
        Box::new(FundingReversion::trend()),
        Box::new(OiDivergence::default()),
        Box::new(OiDivergence::trend()),
        Box::new(LiquidationFade::default()),
        Box::new(LiquidationFade::trend()),
        Box::new(VolBreakout::default()),
        Box::new(Ensemble::default()),
        Box::new(Ensemble::trend()),
    ];

    // Run each strategy on each asset, merge, backtest, record metrics.
    let mut rows: Vec<Row> = Vec::new();
    let mut returns_matrix: Vec<Vec<f64>> = Vec::new();
    let mut sharpes: Vec<f64> = Vec::new();

    for strat in &strategies {
        let name = strat.name().to_string();
        let span = latency.span(format!("strategy:{name}"));
        let mut signals: Vec<Signal> = Vec::new();
        signals.extend(strat.signals(&btc.as_input(Asset::Btc)));
        signals.extend(strat.signals(&eth.as_input(Asset::Eth)));
        drop(span);

        let bt_span = latency.span(format!("backtest:{name}"));
        let bt = run_signal_stream(&name, &signals, &forward, &trader);
        drop(bt_span);

        let per_trade = per_trade_returns(&bt);
        let psr = probabilistic_sharpe_ratio(&per_trade, 0.0).psr;
        let ci = block_bootstrap_sharpe(&per_trade, 1000, 4.0, 0.95, 42);

        sharpes.push(bt.main.sharpe);
        returns_matrix.push(per_trade);

        rows.push(Row {
            name,
            n_signals: signals.len(),
            backtest: bt,
            psr,
            dsr: 0.0,
            ci_lo: ci.lo,
            ci_hi: ci.hi,
            ci_median: ci.median,
        });
    }

    // Buy-and-hold baselines for context.
    let bh_btc = buy_and_hold("buy-hold", Asset::Btc, &btc.candles, &trader);
    let bh_eth = buy_and_hold("buy-hold", Asset::Eth, &eth.candles, &trader);
    let baselines = vec![bh_btc, bh_eth];

    // --- ATR-risk sized variants (1 % risk per trade on $2k equity) ---
    let pro_trader = TraderConfig {
        sizing: Sizing::AtrRisk {
            risk_fraction: 0.01,
            max_notional_mult: 3.0,
        },
        equity_usd: 2_000.0,
        ..TraderConfig::default()
    };
    let mut pro_rows: Vec<Row> = Vec::new();
    for strat in &strategies {
        let name = format!("{}-atr1pct@2k", strat.name());
        let mut signals: Vec<Signal> = Vec::new();
        signals.extend(strat.signals(&btc.as_input(Asset::Btc)));
        signals.extend(strat.signals(&eth.as_input(Asset::Eth)));
        let bt = run_signal_stream(&name, &signals, &forward, &pro_trader);
        let per_trade = per_trade_returns(&bt);
        let psr = probabilistic_sharpe_ratio(&per_trade, 0.0).psr;
        let ci = block_bootstrap_sharpe(&per_trade, 500, 4.0, 0.95, 44);
        pro_rows.push(Row {
            name,
            n_signals: signals.len(),
            backtest: bt,
            psr,
            dsr: 0.0,
            ci_lo: ci.lo,
            ci_hi: ci.hi,
            ci_median: ci.median,
        });
    }
    pro_rows.sort_by(|a, b| {
        b.backtest
            .main
            .total_pnl_usd
            .partial_cmp(&a.backtest.main.total_pnl_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // --- Confluence-gated variants on the winning trend strategies ---
    let confluence_cfg = ConfluenceCfg::default();
    let trend_strats: Vec<Box<dyn CryptoStrategy>> = vec![
        Box::new(LiquidationFade::trend()),
        Box::new(VolBreakout::default()),
        Box::new(Ensemble::trend()),
    ];
    let mut confluence_rows: Vec<Row> = Vec::new();
    for strat in &trend_strats {
        let name = format!("{}+confluence", strat.name());
        let mut sigs_btc = strat.signals(&btc.as_input(Asset::Btc));
        sigs_btc.sort_by_key(|s| s.ts.0);
        let btc_filtered = filter_signals(&sigs_btc, &btc.candles, &btc.funding, &confluence_cfg);
        let mut sigs_eth = strat.signals(&eth.as_input(Asset::Eth));
        sigs_eth.sort_by_key(|s| s.ts.0);
        let eth_filtered = filter_signals(&sigs_eth, &eth.candles, &eth.funding, &confluence_cfg);
        let mut kept: Vec<Signal> = Vec::new();
        kept.extend(btc_filtered.kept);
        kept.extend(eth_filtered.kept);
        let n_in = sigs_btc.len() + sigs_eth.len();
        let bt = run_signal_stream(&name, &kept, &forward, &trader);
        let per_trade = per_trade_returns(&bt);
        let psr = probabilistic_sharpe_ratio(&per_trade, 0.0).psr;
        let ci = block_bootstrap_sharpe(&per_trade, 500, 4.0, 0.95, 45);
        tracing::info!(
            strategy = strat.name(),
            signals_in = n_in,
            signals_kept = kept.len(),
            "confluence filter"
        );
        confluence_rows.push(Row {
            name,
            n_signals: kept.len(),
            backtest: bt,
            psr,
            dsr: 0.0,
            ci_lo: ci.lo,
            ci_hi: ci.hi,
            ci_median: ci.median,
        });
    }
    confluence_rows.sort_by(|a, b| {
        b.backtest
            .main
            .sharpe
            .partial_cmp(&a.backtest.main.sharpe)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Stress test: re-run every strategy with doubled costs.
    let mut stress_rows: Vec<Row> = Vec::new();
    for strat in &strategies {
        let name = format!("{}-stress", strat.name());
        let mut signals: Vec<Signal> = Vec::new();
        signals.extend(strat.signals(&btc.as_input(Asset::Btc)));
        signals.extend(strat.signals(&eth.as_input(Asset::Eth)));
        let bt = run_signal_stream(&name, &signals, &forward, &stress_trader);
        let per_trade = per_trade_returns(&bt);
        let psr = probabilistic_sharpe_ratio(&per_trade, 0.0).psr;
        let ci = block_bootstrap_sharpe(&per_trade, 500, 4.0, 0.95, 43);
        stress_rows.push(Row {
            name,
            n_signals: signals.len(),
            backtest: bt,
            psr,
            dsr: 0.0,
            ci_lo: ci.lo,
            ci_hi: ci.hi,
            ci_median: ci.median,
        });
    }
    stress_rows.sort_by(|a, b| {
        b.backtest
            .main
            .sharpe
            .partial_cmp(&a.backtest.main.sharpe)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Deflated Sharpe with the selection-bias correction across the grid.
    for row in &mut rows {
        let per_trade = per_trade_returns(&row.backtest);
        row.dsr = deflated_sharpe_ratio(&per_trade, &sharpes).psr;
    }

    // PBO across the grid.
    let pbo = if returns_matrix.iter().all(|r| r.len() >= 16) {
        let min_len = returns_matrix.iter().map(Vec::len).min().unwrap_or(0);
        let trimmed: Vec<Vec<f64>> = returns_matrix
            .iter()
            .map(|r| r.iter().take(min_len).copied().collect())
            .collect();
        probability_of_backtest_overfitting(&trimmed, 8).pbo
    } else {
        0.5
    };

    rows.sort_by(|a, b| {
        b.score()
            .partial_cmp(&a.score())
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let wall_ns = wall.elapsed().as_nanos() as u64;
    let runtime = latency.report(wall_ns);

    println!(
        "\n=== Pythia real-data ablation  (elapsed {:.2}s) ===\n",
        wall.elapsed().as_secs_f64()
    );
    println!(
        "{:<20} {:>9} {:>8} {:>10} {:>8} {:>8} {:>8} {:>8} {:>8}",
        "strategy", "signals", "trades", "pnl_usd", "sharpe", "max_dd", "psr", "dsr", "score"
    );
    for r in &rows {
        println!(
            "{:<20} {:>9} {:>8} {:>+10.0} {:>+8.2} {:>7.1}% {:>8.2} {:>8.2} {:>+8.3}",
            r.name,
            r.n_signals,
            r.backtest.main.n_trades,
            r.backtest.main.total_pnl_usd,
            r.backtest.main.sharpe,
            r.backtest.main.max_drawdown * 100.0,
            r.psr,
            r.dsr,
            r.score()
        );
    }
    println!("\nPBO across grid: {pbo:.2}");

    println!("\n=== ATR-risk sizing on $2,000 equity (1% risk/trade) ===");
    for r in &pro_rows {
        let m = &r.backtest.main;
        println!(
            "{:<28} trades={:>4}  pnl={:+10.2}  sharpe={:+.2}  max_dd={:.1}%  winrate={:.1}%",
            r.name,
            m.n_trades,
            m.total_pnl_usd,
            m.sharpe,
            m.max_drawdown * 100.0,
            m.win_rate * 100.0
        );
    }

    println!("\n=== Confluence-gated trend strategies ===");
    for r in &confluence_rows {
        let m = &r.backtest.main;
        println!(
            "{:<32} trades={:>4}  pnl={:+10.0}  sharpe={:+.2}  max_dd={:.1}%  winrate={:.1}%",
            r.name,
            m.n_trades,
            m.total_pnl_usd,
            m.sharpe,
            m.max_drawdown * 100.0,
            m.win_rate * 100.0
        );
    }

    println!("\n=== Stress (10 bps fee + 5 bps slippage) ===");
    for r in &stress_rows {
        println!(
            "{:<22} pnl={:+10.0}  sharpe={:+.2}  max_dd={:.1}%",
            r.name,
            r.backtest.main.total_pnl_usd,
            r.backtest.main.sharpe,
            r.backtest.main.max_drawdown * 100.0
        );
    }

    println!("\n=== Baselines ===");
    for bh in &baselines {
        let m = &bh.main;
        println!(
            "{:<18} pnl={:+10.0}  sharpe={:+.2}  max_dd={:.1}%",
            bh.name,
            m.total_pnl_usd,
            m.sharpe,
            m.max_drawdown * 100.0
        );
    }

    let md = render_markdown(&rows, &stress_rows, &baselines, pbo, wall_ns, &runtime);
    let ts = chrono::Utc::now().timestamp();
    let dir = PathBuf::from(format!("reports/pnl/{ts}"));
    let serialisable = SerialisableReport {
        rows: rows.iter().map(Row::to_serialisable).collect(),
        stress_rows: stress_rows.iter().map(Row::to_serialisable).collect(),
        baselines: baselines.iter().map(bh_row).collect(),
        pbo,
        wall_ns,
        runtime: runtime.clone(),
    };
    write_pair(&dir, "pnl", &md, &serialisable)?;
    println!("\nReport: {}/pnl.md", dir.display());
    Ok(())
}

struct AssetHistory {
    candles: Vec<Candle>,
    funding: Vec<FundingRate>,
    oi: Vec<OpenInterest>,
    liquidations: Vec<Liquidation>,
}

impl AssetHistory {
    fn as_input(&self, asset: Asset) -> AssetInput<'_> {
        AssetInput {
            asset,
            candles: &self.candles,
            funding: &self.funding,
            oi: &self.oi,
            liquidations: &self.liquidations,
        }
    }
}

fn load_asset(store: &Store, asset: Asset) -> Result<AssetHistory, Box<dyn std::error::Error>> {
    // Use the connection directly for performant bulk reads.
    let conn = store.connection();
    let symbol = asset.symbol();
    let candles = {
        let mut s = conn.prepare(
            "SELECT event_ts, open, high, low, close, volume FROM candles \
             WHERE asset = ? ORDER BY event_ts ASC",
        )?;
        let rows = s.query_map([symbol], |r| {
            Ok(Candle {
                ts: EventTs::from_secs(r.get::<_, i64>(0)?),
                open: r.get(1)?,
                high: r.get(2)?,
                low: r.get(3)?,
                close: r.get(4)?,
                volume: r.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let funding = {
        let mut s = conn.prepare(
            "SELECT event_ts, rate_open, rate_close, predicted_close FROM funding \
             WHERE asset = ? ORDER BY event_ts ASC",
        )?;
        let rows = s.query_map([symbol], |r| {
            Ok(FundingRate {
                ts: EventTs::from_secs(r.get::<_, i64>(0)?),
                rate_open: r.get(1)?,
                rate_close: r.get(2)?,
                predicted_close: r.get::<_, Option<f64>>(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let oi = {
        let mut s = conn.prepare(
            "SELECT event_ts, close, high, low FROM open_interest \
             WHERE asset = ? ORDER BY event_ts ASC",
        )?;
        let rows = s.query_map([symbol], |r| {
            Ok(OpenInterest {
                ts: EventTs::from_secs(r.get::<_, i64>(0)?),
                close: r.get(1)?,
                high: r.get(2)?,
                low: r.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let liquidations = {
        let mut s = conn.prepare(
            "SELECT event_ts, side, volume_usd FROM liquidations \
             WHERE asset = ? ORDER BY event_ts ASC",
        )?;
        let rows = s.query_map([symbol], |r| {
            let side_str: String = r.get(1)?;
            let side = if side_str == "BUY" { LiqSide::Buy } else { LiqSide::Sell };
            Ok(Liquidation {
                ts: EventTs::from_secs(r.get::<_, i64>(0)?),
                side,
                volume_usd: r.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    Ok(AssetHistory {
        candles,
        funding,
        oi,
        liquidations,
    })
}

struct Row {
    name: String,
    n_signals: usize,
    backtest: BacktestReport,
    psr: f64,
    dsr: f64,
    ci_lo: f64,
    ci_hi: f64,
    ci_median: f64,
}

impl Row {
    fn score(&self) -> f64 {
        // Composite: DSR times sign of expectancy; penalty for < 10 trades.
        if self.backtest.main.n_trades < 10 {
            return 0.0;
        }
        self.dsr * self.backtest.main.expectancy_r.signum()
    }
    fn to_serialisable(&self) -> SerRow {
        SerRow {
            name: self.name.clone(),
            n_signals: self.n_signals,
            metrics: self.backtest.main.clone(),
            psr: self.psr,
            dsr: self.dsr,
            sharpe_ci: (self.ci_lo, self.ci_median, self.ci_hi),
            score: self.score(),
            equity_curve_last: self
                .backtest
                .equity_curve
                .last()
                .copied()
                .unwrap_or((0, 0.0)),
            r_histogram: self.backtest.r_histogram.clone(),
        }
    }
}

#[derive(serde::Serialize)]
struct SerRow {
    name: String,
    n_signals: usize,
    metrics: RiskMetrics,
    psr: f64,
    dsr: f64,
    sharpe_ci: (f64, f64, f64),
    score: f64,
    equity_curve_last: (i64, f64),
    r_histogram: Vec<(f64, usize)>,
}

#[derive(serde::Serialize)]
struct SerialisableReport {
    rows: Vec<SerRow>,
    stress_rows: Vec<SerRow>,
    baselines: Vec<SerRow>,
    pbo: f64,
    wall_ns: u64,
    runtime: evaluation::LatencyReport,
}

fn bh_row(bt: &BacktestReport) -> SerRow {
    SerRow {
        name: bt.name.clone(),
        n_signals: 1,
        metrics: bt.main.clone(),
        psr: 1.0,
        dsr: 1.0,
        sharpe_ci: (bt.main.sharpe, bt.main.sharpe, bt.main.sharpe),
        score: 0.0,
        equity_curve_last: bt.equity_curve.last().copied().unwrap_or((0, 0.0)),
        r_histogram: bt.r_histogram.clone(),
    }
}

fn per_trade_returns(bt: &BacktestReport) -> Vec<f64> {
    // Equity is reported against a $10k baseline; per-step return is
    // delta/10k which matches the metric used in DSR/PSR.
    bt.equity_curve
        .windows(2)
        .map(|w| (w[1].1 - w[0].1) / 10_000.0)
        .collect()
}

fn render_markdown(
    rows: &[Row],
    stress_rows: &[Row],
    baselines: &[BacktestReport],
    pbo: f64,
    wall_ns: u64,
    runtime: &evaluation::LatencyReport,
) -> String {
    use std::fmt::Write as _;
    let mut s = String::new();
    let _ = writeln!(s, "# Pythia — real-data profitability report\n");
    let _ = writeln!(
        s,
        "- Dataset: Binance Futures BTC + ETH, hourly candles + funding + OI + liquidations, 365 days."
    );
    let _ = writeln!(
        s,
        "- Window: {} → {} UTC (1 year).",
        fmt_ts(rows[0].backtest.start_ts.min(rows[0].backtest.end_ts)),
        fmt_ts(rows[0].backtest.end_ts.max(rows[0].backtest.start_ts))
    );
    let _ = writeln!(s, "- Paper execution: 5 bps taker, 3 bps slippage, funding accrued at market rate.");
    let _ = writeln!(s, "- Sizing: $10,000 notional per signal; no compounding; no leverage.");
    let _ = writeln!(s, "- PBO across grid: **{:.2}**", pbo);
    let _ = writeln!(s, "- Wall-clock: {:.2} s", (wall_ns as f64) / 1e9);
    let _ = writeln!(s, "\n## Strategy ranking\n");
    let _ = writeln!(s, "| # | Strategy | Signals | Trades | PnL USD | WinRate | PF | Sharpe | Sortino | MaxDD | Calmar | PSR | DSR | Sharpe 95% CI | Score |");
    let _ = writeln!(s, "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (i, r) in rows.iter().enumerate() {
        let m = &r.backtest.main;
        let _ = writeln!(
            s,
            "| {} | `{}` | {} | {} | {:+.0} | {:.1}% | {:.2} | {:+.2} | {:+.2} | {:.1}% | {:.2} | {:.2} | {:.2} | [{:+.2}, {:+.2}] | {:+.3} |",
            i + 1,
            r.name,
            r.n_signals,
            m.n_trades,
            m.total_pnl_usd,
            m.win_rate * 100.0,
            m.profit_factor,
            m.sharpe,
            m.sortino,
            m.max_drawdown * 100.0,
            m.calmar,
            r.psr,
            r.dsr,
            r.ci_lo,
            r.ci_hi,
            r.score()
        );
    }

    let _ = writeln!(s, "\n## Stress test — doubled costs (10 bps fee + 5 bps slippage)\n");
    let _ = writeln!(s, "| Strategy | Trades | PnL USD | Sharpe | MaxDD | Δ PnL vs base |");
    let _ = writeln!(s, "|---|---|---|---|---|---|");
    for r in stress_rows {
        let m = &r.backtest.main;
        let base_name = r.name.trim_end_matches("-stress");
        let base_pnl = rows
            .iter()
            .find(|x| x.name == base_name)
            .map(|x| x.backtest.main.total_pnl_usd)
            .unwrap_or(0.0);
        let delta = m.total_pnl_usd - base_pnl;
        let _ = writeln!(
            s,
            "| `{}` | {} | {:+.0} | {:+.2} | {:.1}% | {:+.0} |",
            r.name,
            m.n_trades,
            m.total_pnl_usd,
            m.sharpe,
            m.max_drawdown * 100.0,
            delta
        );
    }

    let _ = writeln!(s, "\n## Buy-and-hold baselines\n");
    let _ = writeln!(s, "| Asset | Final PnL USD | Sharpe (ann.) | Max DD | Calmar |");
    let _ = writeln!(s, "|---|---|---|---|---|");
    for b in baselines {
        let m = &b.main;
        let _ = writeln!(
            s,
            "| `{}` | {:+.0} | {:+.2} | {:.1}% | {:.2} |",
            b.name,
            m.total_pnl_usd,
            m.sharpe,
            m.max_drawdown * 100.0,
            m.calmar
        );
    }

    let _ = writeln!(s, "\n## Equity curves\n");
    for r in rows {
        if let Some((_, last_eq)) = r.backtest.equity_curve.last() {
            let _ = writeln!(
                s,
                "- `{}`: {} points, final equity `{:+.2} USD` on $10k base.",
                r.name,
                r.backtest.equity_curve.len(),
                last_eq
            );
        }
    }

    let _ = writeln!(s, "\n## R-multiple distribution (per strategy)\n");
    for r in rows {
        let _ = writeln!(s, "### `{}`\n", r.name);
        let _ = writeln!(s, "| R bucket | count |");
        let _ = writeln!(s, "|---|---|");
        for (bucket, n) in &r.backtest.r_histogram {
            let _ = writeln!(s, "| {:+.1} | {} |", bucket, n);
        }
    }

    let _ = writeln!(s, "\n## Runtime latency\n");
    let _ = writeln!(s, "| Phase | N | Total | Mean | P50 | P95 | P99 | Max |");
    let _ = writeln!(s, "|---|---|---|---|---|---|---|---|");
    for p in &runtime.phases {
        let _ = writeln!(
            s,
            "| {} | {} | {:.3}ms | {:.2}µs | {:.2}µs | {:.2}µs | {:.2}µs | {:.2}µs |",
            p.phase,
            p.count,
            (p.total_ns as f64) / 1e6,
            (p.mean_ns as f64) / 1e3,
            (p.p50_ns as f64) / 1e3,
            (p.p95_ns as f64) / 1e3,
            (p.p99_ns as f64) / 1e3,
            (p.max_ns as f64) / 1e3
        );
    }

    let _ = writeln!(s, "\n## Interpretation\n");
    let _ = writeln!(s, "Positive **DSR** and Sharpe CI strictly above 0 are the publish-grade bar.");
    let _ = writeln!(s, "Winner by composite score is shown top. High **PBO** (>0.5) warns that");
    let _ = writeln!(s, "the in-sample winner may not generalise; cross-check OOS and against");
    let _ = writeln!(s, "buy-and-hold before deploying.");

    s
}

fn fmt_ts(ts: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(ts, 0)
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| ts.to_string())
}
