//! `export_vis` — dump the winning-strategy dataset as JSON files under
//! `apps/web/public/data/` so the Three.js front-end can render it
//! without touching the backend.
//!
//! Writes:
//!   public/data/equity.json    — chronological equity-curve for the winner
//!   public/data/trades.json    — every trade with (ts, asset, direction, pnl, R)
//!   public/data/liquidations.json — hourly net liquidation series (downsampled)
//!   public/data/candles.json   — downsampled BTC+ETH candles
//!   public/data/grid.json      — all 30 strategy variants with their metrics
//!   public/data/summary.json   — headline numbers for the hero card
//!
//! Run: `cargo run --release -p strategy --bin export_vis`

use std::{fs, path::Path};

use backtest::{run_signal_stream_compound, ForwardData};
use domain::{
    crypto::{Asset, Candle, FundingRate, LiqSide, Liquidation, OpenInterest},
    signal::{Direction, Signal},
    time::EventTs,
};
use paper_trader::{Sizing, TraderConfig};
use serde::Serialize;
use store::Store;
use strategy::crypto_native::{
    ensemble::Ensemble, liq_fade::LiquidationFade, vol_bo::VolBreakout, AssetInput,
    CryptoStrategy,
};

const STARTING: f64 = 1_000.0;
const OUT_DIR: &str = "apps/web/public/data";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let db_path = std::env::var("PYTHIA_DB").unwrap_or_else(|_| "data/pythia.duckdb".into());
    let store = Store::open(&db_path)?;
    let btc = load_asset(&store, Asset::Btc)?;
    let eth = load_asset(&store, Asset::Eth)?;
    println!("loaded btc={} eth={}", btc.candles.len(), eth.candles.len());

    let mut forward = ForwardData::default();
    forward.candles.insert(Asset::Btc, btc.candles.clone());
    forward.candles.insert(Asset::Eth, eth.candles.clone());
    forward.funding.insert(Asset::Btc, btc.funding.clone());
    forward.funding.insert(Asset::Eth, eth.funding.clone());

    // The winner: liq-trend @ 1% compound.
    let strat: Box<dyn CryptoStrategy> = Box::new(LiquidationFade::trend());
    let mut sigs: Vec<Signal> = strat.signals(&btc.as_input(Asset::Btc));
    sigs.extend(strat.signals(&eth.as_input(Asset::Eth)));
    sigs.sort_by_key(|s| s.ts.0);

    let trader = TraderConfig {
        sizing: Sizing::AtrRisk {
            risk_fraction: 0.01,
            max_notional_mult: 5.0,
        },
        equity_usd: STARTING,
        ..TraderConfig::default()
    };
    let bt = run_signal_stream_compound("liq-trend@1%compound", &sigs, &forward, &trader);

    fs::create_dir_all(OUT_DIR)?;

    // --- equity curve --------------------------------------------------
    let equity: Vec<EquityPoint> = {
        let mut out = vec![EquityPoint {
            ts: bt.equity_curve.first().map(|p| p.0).unwrap_or(0),
            equity: STARTING,
        }];
        let mut e = STARTING;
        let mut last_pnl = 0.0;
        for (ts, cum_pnl) in &bt.equity_curve {
            let delta = cum_pnl - last_pnl;
            e += delta;
            out.push(EquityPoint { ts: *ts, equity: e });
            last_pnl = *cum_pnl;
        }
        out
    };
    write_json(&format!("{OUT_DIR}/equity.json"), &equity)?;
    println!("wrote equity.json ({} points)", equity.len());

    // --- trades --------------------------------------------------------
    let trades: Vec<TradePoint> = bt
        .main
        .n_trades
        .checked_sub(0)
        .map(|_| {
            // `bt` does not expose per-trade detail directly; re-run the
            // simulator but keep the `Trade` objects. Simpler: rebuild the
            // trade stream via run_signal_stream_compound and read the
            // `trades` table from the database? No — we have the
            // equity-curve deltas already. Each equity delta corresponds
            // to one closed trade, so we synthesise trade records from
            // the equity deltas paired with signal metadata.
            pair_trades_with_signals(&bt.equity_curve, &sigs)
        })
        .unwrap_or_default();
    write_json(&format!("{OUT_DIR}/trades.json"), &trades)?;
    println!("wrote trades.json ({} trades)", trades.len());

    // --- liquidations (hourly net, downsampled to every 6 h) -----------
    let liqs = build_net_liq(&btc.liquidations, &eth.liquidations, 6);
    write_json(&format!("{OUT_DIR}/liquidations.json"), &liqs)?;
    println!("wrote liquidations.json ({} points)", liqs.len());

    // --- candles (downsampled to daily) -------------------------------
    let btc_daily = downsample_candles(&btc.candles, 24);
    let eth_daily = downsample_candles(&eth.candles, 24);
    write_json(
        &format!("{OUT_DIR}/candles.json"),
        &CandleBundle {
            btc: btc_daily,
            eth: eth_daily,
        },
    )?;
    println!("wrote candles.json");

    // --- grid ----------------------------------------------------------
    let grid = build_grid(&btc, &eth, &forward);
    write_json(&format!("{OUT_DIR}/grid.json"), &grid)?;
    println!("wrote grid.json ({} variants)", grid.len());

    // --- summary -------------------------------------------------------
    let m = &bt.main;
    let summary = Summary {
        starting_equity: STARTING,
        final_equity: STARTING + m.total_pnl_usd,
        pnl_usd: m.total_pnl_usd,
        roi_pct: m.total_pnl_usd / STARTING * 100.0,
        n_trades: m.n_trades,
        win_rate: m.win_rate,
        profit_factor: m.profit_factor,
        sharpe: m.sharpe,
        sortino: m.sortino,
        max_drawdown: m.max_drawdown,
        calmar: if m.max_drawdown > 0.0 {
            (m.total_pnl_usd / STARTING) / m.max_drawdown
        } else {
            0.0
        },
        start_ts: bt.start_ts,
        end_ts: bt.end_ts,
        strategy: "liq-trend @ 1% risk, compounded".into(),
        universe: "Binance Futures BTCUSDT + ETHUSDT perps".into(),
        data_points: btc.candles.len() + eth.candles.len()
            + btc.funding.len() + eth.funding.len()
            + btc.oi.len() + eth.oi.len()
            + btc.liquidations.len() + eth.liquidations.len(),
    };
    write_json(&format!("{OUT_DIR}/summary.json"), &summary)?;
    println!("wrote summary.json");

    println!("\ndone. drop /visualize in the web app.");
    Ok(())
}

#[derive(Serialize)]
struct EquityPoint {
    ts: i64,
    equity: f64,
}

#[derive(Serialize)]
struct TradePoint {
    ts: i64,
    asset: String,
    dir: String,
    pnl: f64,
    r: f64,
}

#[derive(Serialize)]
struct LiqPoint {
    ts: i64,
    net_usd: f64,
    gross_usd: f64,
}

#[derive(Serialize)]
struct CandleLite {
    ts: i64,
    close: f64,
}

#[derive(Serialize)]
struct CandleBundle {
    btc: Vec<CandleLite>,
    eth: Vec<CandleLite>,
}

#[derive(Serialize)]
struct GridRow {
    name: String,
    risk: f64,
    compound: bool,
    trades: usize,
    pnl: f64,
    roi: f64,
    sharpe: f64,
    max_dd: f64,
    realistic: bool,
}

#[derive(Serialize)]
struct Summary {
    starting_equity: f64,
    final_equity: f64,
    pnl_usd: f64,
    roi_pct: f64,
    n_trades: usize,
    win_rate: f64,
    profit_factor: f64,
    sharpe: f64,
    sortino: f64,
    max_drawdown: f64,
    calmar: f64,
    start_ts: i64,
    end_ts: i64,
    strategy: String,
    universe: String,
    data_points: usize,
}

fn pair_trades_with_signals(equity_curve: &[(i64, f64)], signals: &[Signal]) -> Vec<TradePoint> {
    // `equity_curve` has one entry per closed trade (ts at exit).
    // Match each to the nearest prior signal by timestamp.
    let mut out: Vec<TradePoint> = Vec::with_capacity(equity_curve.len());
    let mut last_cum = 0.0_f64;
    for (exit_ts, cum_pnl) in equity_curve {
        let pnl = cum_pnl - last_cum;
        last_cum = *cum_pnl;
        // Find the latest signal with ts <= exit_ts (within a 24h window).
        let sig = signals
            .iter()
            .rev()
            .find(|s| s.ts.0 <= *exit_ts && (*exit_ts - s.ts.0) <= 24 * 3600);
        let (asset, dir) = match sig {
            Some(s) => (
                s.asset.coin().to_string(),
                match s.direction {
                    Direction::Long => "LONG",
                    Direction::Short => "SHORT",
                }
                .to_string(),
            ),
            None => ("?".to_string(), "?".to_string()),
        };
        let r = if pnl.abs() > 1e-9 { pnl.signum() } else { 0.0 };
        out.push(TradePoint {
            ts: *exit_ts,
            asset,
            dir,
            pnl,
            r,
        });
    }
    out
}

fn build_net_liq(btc: &[Liquidation], eth: &[Liquidation], bucket_hours: i64) -> Vec<LiqPoint> {
    let bucket_secs = bucket_hours * 3600;
    let mut map: std::collections::BTreeMap<i64, (f64, f64)> = std::collections::BTreeMap::new();
    for l in btc.iter().chain(eth.iter()) {
        let key = (l.ts.0 / bucket_secs) * bucket_secs;
        let e = map.entry(key).or_insert((0.0, 0.0));
        let signed = match l.side {
            LiqSide::Buy => l.volume_usd,
            LiqSide::Sell => -l.volume_usd,
        };
        e.0 += signed;
        e.1 += l.volume_usd;
    }
    map.into_iter()
        .map(|(ts, (net, gross))| LiqPoint {
            ts,
            net_usd: net,
            gross_usd: gross,
        })
        .collect()
}

fn downsample_candles(c: &[Candle], factor: usize) -> Vec<CandleLite> {
    c.iter()
        .step_by(factor)
        .map(|x| CandleLite {
            ts: x.ts.0,
            close: x.close,
        })
        .collect()
}

fn build_grid(btc: &AssetHistory, eth: &AssetHistory, forward: &ForwardData) -> Vec<GridRow> {
    let mut rows = Vec::new();
    let strategies: Vec<(&'static str, Box<dyn CryptoStrategy>)> = vec![
        ("liq-trend", Box::new(LiquidationFade::trend())),
        ("vol-breakout", Box::new(VolBreakout::default())),
        ("ensemble-trend", Box::new(Ensemble::trend())),
    ];
    for (name, strat) in &strategies {
        let mut sigs: Vec<Signal> = strat.signals(&btc.as_input(Asset::Btc));
        sigs.extend(strat.signals(&eth.as_input(Asset::Eth)));
        for risk in [0.005_f64, 0.01, 0.02, 0.03, 0.05] {
            for compound in [false, true] {
                let trader = TraderConfig {
                    sizing: Sizing::AtrRisk {
                        risk_fraction: risk,
                        max_notional_mult: 5.0,
                    },
                    equity_usd: STARTING,
                    ..TraderConfig::default()
                };
                let bt = if compound {
                    run_signal_stream_compound(name, &sigs, forward, &trader)
                } else {
                    backtest::run_signal_stream(name, &sigs, forward, &trader)
                };
                let m = &bt.main;
                let realistic = if compound {
                    risk <= 0.01 && m.max_drawdown <= 0.05
                } else {
                    m.max_drawdown <= 0.20
                };
                rows.push(GridRow {
                    name: format!(
                        "{}@{:.1}%{}",
                        name,
                        risk * 100.0,
                        if compound { "·compound" } else { "·flat" }
                    ),
                    risk,
                    compound,
                    trades: m.n_trades,
                    pnl: m.total_pnl_usd,
                    roi: m.total_pnl_usd / STARTING * 100.0,
                    sharpe: m.sharpe,
                    max_dd: m.max_drawdown,
                    realistic,
                });
            }
        }
    }
    rows
}

fn write_json<P: AsRef<Path>, T: Serialize>(path: P, data: &T) -> std::io::Result<()> {
    let json = serde_json::to_string(data).map_err(std::io::Error::other)?;
    fs::write(path, json)
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
    let candles = conn
        .prepare(
            "SELECT event_ts, open, high, low, close, volume FROM candles \
             WHERE asset = ? ORDER BY event_ts ASC",
        )?
        .query_map([symbol], |r| {
            Ok(Candle {
                ts: EventTs::from_secs(r.get::<_, i64>(0)?),
                open: r.get(1)?,
                high: r.get(2)?,
                low: r.get(3)?,
                close: r.get(4)?,
                volume: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let funding = conn
        .prepare(
            "SELECT event_ts, rate_open, rate_close, predicted_close FROM funding \
             WHERE asset = ? ORDER BY event_ts ASC",
        )?
        .query_map([symbol], |r| {
            Ok(FundingRate {
                ts: EventTs::from_secs(r.get::<_, i64>(0)?),
                rate_open: r.get(1)?,
                rate_close: r.get(2)?,
                predicted_close: r.get::<_, Option<f64>>(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let oi = conn
        .prepare(
            "SELECT event_ts, close, high, low FROM open_interest \
             WHERE asset = ? ORDER BY event_ts ASC",
        )?
        .query_map([symbol], |r| {
            Ok(OpenInterest {
                ts: EventTs::from_secs(r.get::<_, i64>(0)?),
                close: r.get(1)?,
                high: r.get(2)?,
                low: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let liquidations = conn
        .prepare(
            "SELECT event_ts, side, volume_usd FROM liquidations \
             WHERE asset = ? ORDER BY event_ts ASC",
        )?
        .query_map([symbol], |r| {
            let side_str: String = r.get(1)?;
            let side = if side_str == "BUY" { LiqSide::Buy } else { LiqSide::Sell };
            Ok(Liquidation {
                ts: EventTs::from_secs(r.get::<_, i64>(0)?),
                side,
                volume_usd: r.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(AssetHistory {
        candles,
        funding,
        oi,
        liquidations,
    })
}
