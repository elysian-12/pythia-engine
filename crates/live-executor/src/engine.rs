//! Main executor loop — consumes WS events, runs the signal, places orders.
//!
//! All the heavy work (liquidation aggregation, z-score, sizing) is
//! sub-microsecond. The expensive thing is the HL REST round-trip on
//! order placement, which we measure on every fire.

use std::sync::Arc;
use std::time::{Duration, Instant};

use exchange_hyperliquid::{
    HyperliquidClient, OrderRequest, OrderSide, Signer, Tif,
};
use kiyotaka_client::binance_ws::spawn_binance_liq;
use kiyotaka_client::ws::LiveEvent;
use tracing::{debug, info, warn};

use crate::aggregator::{Aggregator, AggregatorSnapshot};
use crate::risk::{GuardDecision, RiskGuard};
use crate::state::{LiveState, StatePath};

#[derive(Clone, Debug)]
pub struct ExecutorCfg {
    pub z_threshold: f64,
    pub risk_fraction: f64,
    pub stop_atr_mult: f64,
    pub tp_atr_mult: f64,
    pub horizon_hours: i64,
    pub atr_floor_usd: f64,
    pub mode: LiveMode,
    pub symbols: Vec<(&'static str, u32)>, // (Kiyotaka symbol, HL asset index)
}

impl Default for ExecutorCfg {
    fn default() -> Self {
        Self {
            z_threshold: 2.5,
            risk_fraction: 0.01,
            stop_atr_mult: 1.5,
            tp_atr_mult: 3.0,
            horizon_hours: 4,
            atr_floor_usd: 10.0,
            mode: LiveMode::DryRun,
            symbols: vec![("BTCUSDT", 0), ("ETHUSDT", 1)],
        }
    }
}

/// Execution mode — default is safe.
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum LiveMode {
    /// Log only. No orders placed. Default.
    DryRun,
    /// Real orders. Only switch to this after 30 successful dry runs.
    Live,
}

/// Main entry point. Runs forever until the process is killed.
///
/// Data source: Binance Futures public `!forceOrder@arr` WebSocket —
/// free, no auth, no rate limit. The same liquidation stream Kiyotaka
/// aggregates internally. (`_api_key` is reserved for future use with
/// the authenticated Kiyotaka WS on Advanced tier.)
pub async fn run_executor<S: Signer + 'static>(
    _api_key: String,
    _kiyotaka_url: String,
    client: Arc<HyperliquidClient<S>>,
    address: String,
    cfg: ExecutorCfg,
    guard: Arc<RiskGuard>,
    state_path: StatePath,
) -> Result<(), ExecutorError> {
    info!(
        mode=?cfg.mode,
        z_threshold=cfg.z_threshold,
        risk_frac=cfg.risk_fraction,
        "executor starting"
    );

    // Live equity from HL → prime the risk guard.
    match client.user_state(&address).await {
        Ok(us) => {
            let eq = us.margin_summary.account_value_f64();
            info!(equity_usd = eq, address = %address, "initial equity");
            if eq > 0.0 {
                guard.update_equity(eq);
            }
        }
        Err(e) => warn!(error=%e, "could not fetch initial user state"),
    }

    // Subscribe to Binance's public force-order stream, filtered to our
    // symbols of interest. Free + no auth, so this works on any plan.
    let symbols: Vec<String> = cfg.symbols.iter().map(|(s, _)| (*s).to_string()).collect();
    let mut rx = spawn_binance_liq(symbols);

    let mut agg = Aggregator::new(
        &cfg.symbols.iter().map(|(s, _)| *s).collect::<Vec<_>>(),
    );
    let mut state = LiveState::load_or_default(&state_path.0);
    if state.starting_equity == 0.0 {
        state.starting_equity = guard_equity(&guard);
        state.peak_equity = state.starting_equity;
        let _ = state.save(&state_path.0);
    }

    // Minute-level heartbeat.
    let mut hb = tokio::time::interval(Duration::from_secs(60));
    hb.tick().await;

    loop {
        tokio::select! {
            Some(ev) = rx.recv() => {
                if let Some(snap) = handle_event(&mut agg, ev) {
                    if let Err(e) = on_bar_close(
                        &client,
                        &address,
                        &cfg,
                        &guard,
                        &mut state,
                        &state_path,
                        snap,
                    ).await {
                        warn!(error=%e, "bar-close handler failed");
                    }
                }
            }
            _ = hb.tick() => {
                heartbeat(&agg, &state, &guard).await;
            }
            else => break,
        }
    }
    Ok(())
}

fn guard_equity(guard: &Arc<RiskGuard>) -> f64 {
    // Guard holds equity internally; here we just pull 0 as a placeholder.
    // Replaced by user_state calls in the loop.
    let _ = guard;
    0.0
}

fn handle_event(agg: &mut Aggregator, ev: LiveEvent) -> Option<AggregatorSnapshot> {
    match ev {
        LiveEvent::Liquidation {
            ts,
            symbol,
            side,
            usd_value,
            ..
        } => agg.on_liquidation(&symbol, ts.0, side, usd_value),
        LiveEvent::Funding { .. } | LiveEvent::Candle { .. } => None,
    }
}

async fn on_bar_close<S: Signer>(
    client: &HyperliquidClient<S>,
    address: &str,
    cfg: &ExecutorCfg,
    guard: &Arc<RiskGuard>,
    state: &mut LiveState,
    state_path: &StatePath,
    snap: AggregatorSnapshot,
) -> Result<(), ExecutorError> {
    let z = if let Some(z) = snap.z_score {
        z
    } else {
        debug!(
            symbol = %snap.symbol,
            window = snap.window_size,
            "bar close, z not yet available (warming up)"
        );
        return Ok(());
    };
    info!(
        symbol = %snap.symbol,
        ts = snap.bucket_ts,
        net_usd = snap.net_usd,
        z = z,
        "bar close"
    );

    if z.abs() < cfg.z_threshold {
        return Ok(());
    }

    match guard.permit_signal(&snap.symbol) {
        GuardDecision::Ok => {}
        other => {
            info!(symbol=%snap.symbol, decision=?other, "signal rejected by risk guard");
            return Ok(());
        }
    }

    let side = if z > 0.0 { OrderSide::Buy } else { OrderSide::Sell };
    let asset_ix = cfg
        .symbols
        .iter()
        .find(|(s, _)| *s == snap.symbol)
        .map(|(_, ix)| *ix)
        .ok_or_else(|| ExecutorError::UnknownAsset(snap.symbol.clone()))?;

    // Fresh mid to size against.
    let mids = client.all_mids().await.map_err(ExecutorError::Client)?;
    let hl_coin = hl_coin_for_symbol(&snap.symbol);
    let mid: f64 = mids
        .get(hl_coin)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| ExecutorError::NoMid(hl_coin.into()))?;

    // Fresh equity.
    let us = client.user_state(address).await.map_err(ExecutorError::Client)?;
    let equity = us.margin_summary.account_value_f64();
    guard.update_equity(equity);
    if guard.is_disabled() {
        warn!("guard disabled after equity refresh; skipping order");
        return Ok(());
    }

    // Placeholder ATR — derived from recent mid volatility. For v1 we use
    // a fixed fraction of price (0.5 %) as a safe proxy when we don't yet
    // have a candle feed. The Rust signal engine's ATR(14) requires 14
    // bars; wire that once the TRADE_AGG stream is plumbed end-to-end.
    let atr = (mid * 0.005).max(cfg.atr_floor_usd);
    let stop_dist = cfg.stop_atr_mult * atr;
    let risk_dollars = equity * cfg.risk_fraction;
    let notional = (risk_dollars * mid / stop_dist).min(equity * 3.0);
    let size = notional / mid;
    if size <= 0.0 {
        warn!(size, "computed size <= 0; skipping");
        return Ok(());
    }

    let entry_est = match side {
        OrderSide::Buy => mid * 1.0005,
        OrderSide::Sell => mid * 0.9995,
    };
    let stop_price = match side {
        OrderSide::Buy => entry_est - stop_dist,
        OrderSide::Sell => entry_est + stop_dist,
    };
    let tp_price = match side {
        OrderSide::Buy => entry_est + cfg.tp_atr_mult * atr,
        OrderSide::Sell => entry_est - cfg.tp_atr_mult * atr,
    };

    info!(
        mode=?cfg.mode,
        symbol=%snap.symbol, side=?side, size=size, entry=entry_est,
        stop=stop_price, tp=tp_price, z=z,
        "FIRE"
    );

    let t0 = Instant::now();
    match cfg.mode {
        LiveMode::DryRun => {
            info!("DRY-RUN: no order sent");
        }
        LiveMode::Live => {
            // Place market-ish entry: IOC limit just past mid.
            let req = OrderRequest {
                asset: asset_ix,
                side,
                size,
                limit_px: entry_est,
                reduce_only: false,
                tif: Tif::Ioc,
                trigger: None,
            };
            match client.place_order(&req).await {
                Ok(r) => info!(resp=?r.status, latency_ms=t0.elapsed().as_millis(), "entry filled"),
                Err(e) => {
                    warn!(error=%e, "entry failed");
                    return Ok(());
                }
            }
            // TP + SL as trigger orders (reduce-only).
            let sl_req = OrderRequest {
                asset: asset_ix,
                side: opposite(side),
                size,
                limit_px: stop_price,
                reduce_only: true,
                tif: Tif::Ioc,
                trigger: Some(exchange_hyperliquid::types::TriggerSpec {
                    px: stop_price,
                    is_market: true,
                    kind: "sl",
                }),
            };
            let _ = client.place_order(&sl_req).await;
            let tp_req = OrderRequest {
                asset: asset_ix,
                side: opposite(side),
                size,
                limit_px: tp_price,
                reduce_only: true,
                tif: Tif::Ioc,
                trigger: Some(exchange_hyperliquid::types::TriggerSpec {
                    px: tp_price,
                    is_market: true,
                    kind: "tp",
                }),
            };
            let _ = client.place_order(&tp_req).await;
        }
    }

    state.total_signals_fired += 1;
    state.total_trades_opened += 1;
    state.last_signal_ts.insert(snap.symbol.clone(), snap.bucket_ts);
    state.open_positions.insert(
        snap.symbol.clone(),
        crate::state::OpenPosition {
            symbol: snap.symbol.clone(),
            side: match side {
                OrderSide::Buy => "LONG".into(),
                OrderSide::Sell => "SHORT".into(),
            },
            size,
            entry_price: entry_est,
            stop_price,
            tp_price,
            entry_ts: snap.bucket_ts,
            time_stop_ts: snap.bucket_ts + cfg.horizon_hours * 3600,
        },
    );
    let _ = state.save(&state_path.0);
    Ok(())
}

fn opposite(s: OrderSide) -> OrderSide {
    match s {
        OrderSide::Buy => OrderSide::Sell,
        OrderSide::Sell => OrderSide::Buy,
    }
}

fn hl_coin_for_symbol(sym: &str) -> &'static str {
    match sym {
        "ETHUSDT" => "ETH",
        // BTCUSDT and all unknown symbols default to BTC as the safe fallback.
        _ => "BTC",
    }
}

async fn heartbeat(agg: &Aggregator, state: &LiveState, guard: &Arc<RiskGuard>) {
    let snaps = agg.snapshots();
    let mut summary = String::new();
    for s in snaps {
        use std::fmt::Write as _;
        let _ = write!(
            summary,
            "{} net=${:.0} z={}  ",
            s.symbol,
            s.net_usd,
            s.z_score.map(|z| format!("{z:+.2}")).unwrap_or_else(|| "—".into())
        );
    }
    let _ = guard; // live equity logged elsewhere
    info!(
        fired_total = state.total_signals_fired,
        open = state.open_positions.len(),
        %summary,
        "heartbeat"
    );
}

#[derive(Debug, thiserror::Error)]
pub enum ExecutorError {
    #[error("client: {0}")]
    Client(exchange_hyperliquid::client::ClientError),
    #[error("no mid for {0}")]
    NoMid(String),
    #[error("unknown asset {0}")]
    UnknownAsset(String),
}
