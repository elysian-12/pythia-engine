//! Binance Futures public WebSocket feed.
//!
//! The `!forceOrder@arr` stream pushes every forced liquidation across
//! all USDⓈ-M perps in real time. It requires no auth, no tier, no key —
//! it's the cleanest way to get the `liq-trend` signal inputs on any
//! Kiyotaka plan.
//!
//! Frame shape (one example):
//! ```json
//! {"e":"forceOrder","E":1773896981123,"o":{
//!   "s":"BTCUSDT","S":"SELL","o":"LIMIT","f":"IOC",
//!   "q":"0.050","p":"65123.45","ap":"65120.10",
//!   "X":"FILLED","l":"0.050","z":"0.050","T":1773896981122
//! }}
//! ```
//! We care only about `s`, `S`, `q`, `ap`, `T`.

use std::time::Duration;

use domain::{crypto::LiqSide, time::EventTs};
use futures_util::StreamExt;
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, info, warn};

use crate::ws::LiveEvent;

pub const BINANCE_FORCE_ORDER: &str = "wss://fstream.binance.com/ws/!forceOrder@arr";

#[derive(Debug, Deserialize)]
struct ForceOrderMsg {
    #[serde(rename = "E")]
    _event_time: i64,
    #[serde(rename = "o")]
    order: ForceOrder,
}

#[derive(Debug, Deserialize)]
struct ForceOrder {
    #[serde(rename = "s")]
    symbol: String,
    #[serde(rename = "S")]
    side: String,
    #[serde(rename = "q")]
    qty: String,
    #[serde(rename = "ap")]
    avg_price: String,
    #[serde(rename = "T")]
    trade_time_ms: i64,
}

/// Spawn a background task consuming the Binance `!forceOrder@arr`
/// stream. The receiver accepts a `symbols` allow-list; anything outside
/// it is discarded before reaching the channel.
pub fn spawn_binance_liq(symbols: Vec<String>) -> mpsc::Receiver<LiveEvent> {
    let (tx, rx) = mpsc::channel(4096);
    tokio::spawn(run(symbols, tx));
    rx
}

async fn run(symbols: Vec<String>, tx: mpsc::Sender<LiveEvent>) {
    let mut backoff = Duration::from_secs(2);
    loop {
        match one(symbols.as_slice(), &tx).await {
            Ok(()) => backoff = Duration::from_secs(2),
            Err(e) => warn!(error=%e, backoff_s=backoff.as_secs(), "binance ws error"),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(60));
    }
}

async fn one(symbols: &[String], tx: &mpsc::Sender<LiveEvent>) -> Result<(), BinanceWsError> {
    let (mut ws, _) = connect_async(BINANCE_FORCE_ORDER).await.map_err(BinanceWsError::Connect)?;
    info!(url = BINANCE_FORCE_ORDER, "binance ws connected");
    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(BinanceWsError::Recv)?;
        if let Message::Text(text) = msg {
            handle_text(&text, symbols, tx).await;
        }
    }
    Ok(())
}

async fn handle_text(text: &str, symbols: &[String], tx: &mpsc::Sender<LiveEvent>) {
    let Ok(msg) = serde_json::from_str::<ForceOrderMsg>(text) else {
        debug!(%text, "binance: unparseable frame");
        return;
    };
    if !symbols.iter().any(|s| s == &msg.order.symbol) {
        return;
    }
    let qty: f64 = msg.order.qty.parse().unwrap_or(0.0);
    let px: f64 = msg.order.avg_price.parse().unwrap_or(0.0);
    if qty <= 0.0 || px <= 0.0 {
        return;
    }
    let side = match msg.order.side.as_str() {
        "BUY" => LiqSide::Buy,
        "SELL" => LiqSide::Sell,
        _ => return,
    };
    let event = LiveEvent::Liquidation {
        ts: EventTs::from_secs(msg.order.trade_time_ms / 1000),
        exchange: "BINANCE_FUTURES".into(),
        symbol: msg.order.symbol,
        side,
        usd_value: qty * px,
    };
    if tx.send(event).await.is_err() {
        // receiver gone
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BinanceWsError {
    #[error("connect: {0}")]
    Connect(tokio_tungstenite::tungstenite::Error),
    #[error("recv: {0}")]
    Recv(tokio_tungstenite::tungstenite::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_force_order() {
        let raw = r#"{"e":"forceOrder","E":1773896981123,"o":{"s":"BTCUSDT","S":"SELL","o":"LIMIT","f":"IOC","q":"0.050","p":"65123.45","ap":"65120.10","X":"FILLED","l":"0.050","z":"0.050","T":1773896981122}}"#;
        let m: ForceOrderMsg = serde_json::from_str(raw).unwrap();
        assert_eq!(m.order.symbol, "BTCUSDT");
        assert_eq!(m.order.side, "SELL");
        let qty: f64 = m.order.qty.parse().unwrap();
        assert!((qty - 0.050).abs() < 1e-9);
    }
}
