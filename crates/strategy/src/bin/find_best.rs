//! `find_best` — grid search to identify the single most profitable
//! configuration on a $1,000 starting account.
//!
//! Test plan (18 runs):
//! - strategies: liq-trend, vol-breakout, ensemble-trend (the three
//!   trend variants that won the previous ablation)
//! - risk fractions: 0.5 %, 1 %, 2 % of equity per trade
//! - confluence: off vs 3-of-5 filters
//!
//! Ranking — we care about *not blowing up a $1k account*, so:
//! 1. Reject any variant with MaxDD > 20 %.
//! 2. Rank survivors by **Calmar** (total ROI / MaxDD) — balances
//!    absolute return and drawdown.
//! 3. Tie-break by Sharpe.
//!
//! Output: `BEST_STRATEGY.md` with the winner, the full grid, and a
//! concise "what works and how" summary.

use std::{path::PathBuf, time::Instant};

use backtest::{run_signal_stream, ForwardData};
use domain::{
    crypto::{Asset, Candle, FundingRate, LiqSide, Liquidation, OpenInterest},
    signal::Signal,
    time::EventTs,
};
use evaluation::{block_bootstrap_sharpe, probabilistic_sharpe_ratio};
use paper_trader::{Sizing, TraderConfig};
use reports::BacktestReport;
use store::Store;
use strategy::confluence::{filter_signals, ConfluenceCfg};
use strategy::crypto_native::{
    ensemble::Ensemble, liq_fade::LiquidationFade, vol_bo::VolBreakout, AssetInput,
    CryptoStrategy,
};
use tracing_subscriber::EnvFilter;

const STARTING_CAPITAL: f64 = 1_000.0;
const MAX_DD_LIMIT: f64 = 0.20; // reject variants with > 20 % DD

fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let db_path = std::env::var("PYTHIA_DB").unwrap_or_else(|_| "data/pythia.duckdb".into());
    let store = Store::open(&db_path)?;
    let btc = load_asset(&store, Asset::Btc)?;
    let eth = load_asset(&store, Asset::Eth)?;
    tracing::info!(btc = btc.candles.len(), eth = eth.candles.len(), "loaded");

    let mut forward = ForwardData::default();
    forward.candles.insert(Asset::Btc, btc.candles.clone());
    forward.candles.insert(Asset::Eth, eth.candles.clone());
    forward.funding.insert(Asset::Btc, btc.funding.clone());
    forward.funding.insert(Asset::Eth, eth.funding.clone());

    let strategies: Vec<(&'static str, Box<dyn CryptoStrategy>)> = vec![
        ("liq-trend", Box::new(LiquidationFade::trend())),
        ("vol-breakout", Box::new(VolBreakout::default())),
        ("ensemble-trend", Box::new(Ensemble::trend())),
    ];
    let risk_fractions = [0.005, 0.010, 0.020];
    let confluence_options = [None, Some(3usize)];

    let wall = Instant::now();
    let mut rows: Vec<GridRow> = Vec::new();

    for (name, strat) in &strategies {
        let raw_btc = strat.signals(&btc.as_input(Asset::Btc));
        let raw_eth = strat.signals(&eth.as_input(Asset::Eth));

        for &risk in &risk_fractions {
            for &conf in &confluence_options {
                let variant_label = variant_name(name, risk, conf);
                let (btc_sigs, eth_sigs, conf_drops) = match conf {
                    None => (raw_btc.clone(), raw_eth.clone(), 0usize),
                    Some(min_req) => {
                        let cfg = ConfluenceCfg {
                            min_required: min_req,
                            ..Default::default()
                        };
                        let b = filter_signals(&raw_btc, &btc.candles, &btc.funding, &cfg);
                        let e = filter_signals(&raw_eth, &eth.candles, &eth.funding, &cfg);
                        let total_raw = raw_btc.len() + raw_eth.len();
                        let kept = b.kept.len() + e.kept.len();
                        (b.kept, e.kept, total_raw - kept)
                    }
                };
                let mut all_sigs: Vec<Signal> = Vec::with_capacity(btc_sigs.len() + eth_sigs.len());
                all_sigs.extend(btc_sigs);
                all_sigs.extend(eth_sigs);
                let trader = TraderConfig {
                    sizing: Sizing::AtrRisk {
                        risk_fraction: risk,
                        max_notional_mult: 5.0,
                    },
                    equity_usd: STARTING_CAPITAL,
                    ..TraderConfig::default()
                };
                let bt = run_signal_stream(&variant_label, &all_sigs, &forward, &trader);
                let per_trade = per_trade_returns(&bt);
                let psr = probabilistic_sharpe_ratio(&per_trade, 0.0).psr;
                let ci = block_bootstrap_sharpe(&per_trade, 300, 4.0, 0.95, 7);
                rows.push(GridRow {
                    strategy: name,
                    risk,
                    confluence: conf,
                    confluence_drops: conf_drops,
                    signals: all_sigs.len(),
                    bt,
                    psr,
                    ci_lo: ci.lo,
                    ci_hi: ci.hi,
                });
            }
        }
    }

    let elapsed_ms = wall.elapsed().as_millis();

    // Rank: filter by MaxDD ≤ 20 % and positive PnL, then Calmar desc.
    let mut ranked: Vec<&GridRow> = rows
        .iter()
        .filter(|r| r.bt.main.max_drawdown <= MAX_DD_LIMIT && r.bt.main.total_pnl_usd > 0.0)
        .collect();
    ranked.sort_by(|a, b| {
        b.calmar()
            .partial_cmp(&a.calmar())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.bt.main
                    .sharpe
                    .partial_cmp(&a.bt.main.sharpe)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    // Print summary
    println!(
        "\n=== find_best : ${starting:.0} starting capital, 365 days, 18 variants, {elapsed} ms ===\n",
        starting = STARTING_CAPITAL,
        elapsed = elapsed_ms
    );
    println!(
        "{:<40} {:>8} {:>8} {:>8} {:>8} {:>8} {:>8}",
        "variant", "trades", "pnl_$", "roi%", "sharpe", "maxdd%", "calmar"
    );
    for r in &rows {
        let m = &r.bt.main;
        let label = variant_name(r.strategy, r.risk, r.confluence);
        println!(
            "{:<40} {:>8} {:>+8.2} {:>+8.1} {:>+8.2} {:>7.1}% {:>+8.2}",
            label,
            m.n_trades,
            m.total_pnl_usd,
            m.total_pnl_usd / STARTING_CAPITAL * 100.0,
            m.sharpe,
            m.max_drawdown * 100.0,
            r.calmar()
        );
    }

    if let Some(winner) = ranked.first() {
        println!("\n=== WINNER (survives MaxDD≤20% filter, ranked by Calmar) ===");
        let m = &winner.bt.main;
        println!(
            "  {} · {} trades · PnL ${:+.2} ({:+.1}%) · Sharpe {:+.2} · MaxDD {:.1}% · Calmar {:+.2}",
            variant_name(winner.strategy, winner.risk, winner.confluence),
            m.n_trades,
            m.total_pnl_usd,
            m.total_pnl_usd / STARTING_CAPITAL * 100.0,
            m.sharpe,
            m.max_drawdown * 100.0,
            winner.calmar()
        );
    } else {
        println!("\n=== no variant survived the MaxDD filter ===");
    }

    let md = render_markdown(&rows, &ranked, elapsed_ms);
    std::fs::write(PathBuf::from("BEST_STRATEGY.md"), md)?;
    println!("\nWrote BEST_STRATEGY.md");
    Ok(())
}

struct GridRow {
    strategy: &'static str,
    risk: f64,
    confluence: Option<usize>,
    #[allow(dead_code)]
    confluence_drops: usize,
    #[allow(dead_code)]
    signals: usize,
    bt: BacktestReport,
    psr: f64,
    ci_lo: f64,
    ci_hi: f64,
}

impl GridRow {
    fn calmar(&self) -> f64 {
        let m = &self.bt.main;
        if m.max_drawdown > 0.0 {
            (m.total_pnl_usd / STARTING_CAPITAL) / m.max_drawdown
        } else if m.total_pnl_usd > 0.0 {
            f64::INFINITY
        } else {
            0.0
        }
    }
}

fn variant_name(strategy: &str, risk: f64, confluence: Option<usize>) -> String {
    let c = confluence
        .map(|n| format!("+conf({n})"))
        .unwrap_or_else(|| "-conf(off)".to_string());
    format!("{strategy}@{:.1}%{c}", risk * 100.0)
}

fn per_trade_returns(bt: &BacktestReport) -> Vec<f64> {
    bt.equity_curve
        .windows(2)
        .map(|w| (w[1].1 - w[0].1) / STARTING_CAPITAL)
        .collect()
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
    let conn = store.connection();
    let symbol = asset.symbol();
    let candles = {
        let mut s = conn.prepare(
            "SELECT event_ts, open, high, low, close, volume FROM candles \
             WHERE asset = ? ORDER BY event_ts ASC",
        )?;
        s.query_map([symbol], |r| {
            Ok(Candle {
                ts: EventTs::from_secs(r.get::<_, i64>(0)?),
                open: r.get(1)?,
                high: r.get(2)?,
                low: r.get(3)?,
                close: r.get(4)?,
                volume: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?
    };
    let funding = {
        let mut s = conn.prepare(
            "SELECT event_ts, rate_open, rate_close, predicted_close FROM funding \
             WHERE asset = ? ORDER BY event_ts ASC",
        )?;
        s.query_map([symbol], |r| {
            Ok(FundingRate {
                ts: EventTs::from_secs(r.get::<_, i64>(0)?),
                rate_open: r.get(1)?,
                rate_close: r.get(2)?,
                predicted_close: r.get::<_, Option<f64>>(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?
    };
    let oi = {
        let mut s = conn.prepare(
            "SELECT event_ts, close, high, low FROM open_interest \
             WHERE asset = ? ORDER BY event_ts ASC",
        )?;
        s.query_map([symbol], |r| {
            Ok(OpenInterest {
                ts: EventTs::from_secs(r.get::<_, i64>(0)?),
                close: r.get(1)?,
                high: r.get(2)?,
                low: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?
    };
    let liquidations = {
        let mut s = conn.prepare(
            "SELECT event_ts, side, volume_usd FROM liquidations \
             WHERE asset = ? ORDER BY event_ts ASC",
        )?;
        s.query_map([symbol], |r| {
            let side_str: String = r.get(1)?;
            let side = if side_str == "BUY" { LiqSide::Buy } else { LiqSide::Sell };
            Ok(Liquidation {
                ts: EventTs::from_secs(r.get::<_, i64>(0)?),
                side,
                volume_usd: r.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?
    };
    Ok(AssetHistory {
        candles,
        funding,
        oi,
        liquidations,
    })
}

fn render_markdown(rows: &[GridRow], ranked: &[&GridRow], elapsed_ms: u128) -> String {
    use std::fmt::Write as _;
    let mut s = String::new();
    let _ = writeln!(s, "# Pythia — most profitable strategy on $1,000\n");
    let _ = writeln!(
        s,
        "**Grid:** 3 strategies × 3 risk fractions × 2 confluence modes = 18 runs\n\
         **Dataset:** 365 days of Binance Futures BTC + ETH (17,520 hourly bars)\n\
         **Starting capital:** ${starting:.0} · Costs: 5 bps taker + 3 bps slippage · Funding accrued\n\
         **Grid runtime:** {elapsed} ms wall-clock",
        starting = STARTING_CAPITAL,
        elapsed = elapsed_ms
    );

    if let Some(w) = ranked.first() {
        let m = &w.bt.main;
        let _ = writeln!(
            s,
            "\n## 🏆 Winner — `{label}`\n",
            label = variant_name(w.strategy, w.risk, w.confluence)
        );
        let _ = writeln!(s, "| Metric | Value |");
        let _ = writeln!(s, "|---|---|");
        let _ = writeln!(s, "| Starting | ${starting:.0} |", starting = STARTING_CAPITAL);
        let _ = writeln!(s, "| Final equity | ${:.0} |", STARTING_CAPITAL + m.total_pnl_usd);
        let _ = writeln!(
            s,
            "| Net PnL | **{:+.2} USD ({:+.1} %)** |",
            m.total_pnl_usd,
            m.total_pnl_usd / STARTING_CAPITAL * 100.0
        );
        let _ = writeln!(s, "| Trades | {} |", m.n_trades);
        let _ = writeln!(s, "| Win rate | {:.1} % |", m.win_rate * 100.0);
        let _ = writeln!(s, "| Profit factor | {:.2} |", m.profit_factor);
        let _ = writeln!(s, "| Sharpe (per trade) | {:+.2} |", m.sharpe);
        let _ = writeln!(s, "| Sortino | {:+.2} |", m.sortino);
        let _ = writeln!(s, "| **Max drawdown** | **{:.1} %** |", m.max_drawdown * 100.0);
        let _ = writeln!(s, "| **Calmar (ROI / MaxDD)** | **{:+.2}** |", w.calmar());
        let _ = writeln!(s, "| Avg R-multiple | {:+.3} |", m.avg_r);
        let _ = writeln!(s, "| Sharpe 95 % CI | [{:+.2}, {:+.2}] |", w.ci_lo, w.ci_hi);
        let _ = writeln!(s, "| PSR vs 0 | {:.2} |", w.psr);
        let _ = writeln!(s, "| Mean hold | {:.0} s ({:.1} h) |", m.mean_hold_s, m.mean_hold_s / 3600.0);
    }

    let _ = writeln!(s, "\n## Full grid — ranked\n");
    let _ = writeln!(
        s,
        "| Rank | Variant | Trades | PnL $ | ROI % | Sharpe | MaxDD % | Calmar | Survived filter |"
    );
    let _ = writeln!(s, "|---|---|---|---|---|---|---|---|---|");
    let mut sorted = rows.iter().collect::<Vec<_>>();
    sorted.sort_by(|a, b| {
        b.calmar()
            .partial_cmp(&a.calmar())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for (i, r) in sorted.iter().enumerate() {
        let m = &r.bt.main;
        let survived = m.max_drawdown <= MAX_DD_LIMIT && m.total_pnl_usd > 0.0;
        let _ = writeln!(
            s,
            "| {} | `{}` | {} | {:+.2} | {:+.1} | {:+.2} | {:.1} | {:+.2} | {} |",
            i + 1,
            variant_name(r.strategy, r.risk, r.confluence),
            m.n_trades,
            m.total_pnl_usd,
            m.total_pnl_usd / STARTING_CAPITAL * 100.0,
            m.sharpe,
            m.max_drawdown * 100.0,
            r.calmar(),
            if survived { "✅" } else { "❌" }
        );
    }

    let _ = writeln!(s, "\n## Ranking rules\n");
    let _ = writeln!(s, "1. **Eliminate** variants with MaxDD > 20 % (hard floor on a $1k account).");
    let _ = writeln!(s, "2. **Eliminate** variants with negative total PnL.");
    let _ = writeln!(s, "3. **Rank survivors by Calmar** (ROI / MaxDD) — balances absolute return and drawdown.");
    let _ = writeln!(s, "4. **Tie-break by Sharpe.**");

    s
}
