//! Kiyotaka WebSocket client for low-latency live feeds.
//!
//! The WS API exposes two endpoint families: `book` (orderbook snapshots)
//! and `nonbook` (everything else — trades, liquidations, funding, OI,
//! volume profile). For `liq-trend` we only need `nonbook` with the
//! `LIQUIDATION`, `FUNDING_RATE`, and `TRADE_AGG` channels.
//!
//! Design:
//! - auth-then-subscribe handshake on connect
//! - one background task per connection, pushing typed events via `mpsc`
//! - automatic reconnect with exponential backoff
//! - zero mutex contention in the hot path (ownership of the socket
//!   lives in a single task; state changes go through channels)

use std::time::Duration;

use domain::{crypto::LiqSide, time::EventTs};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, info, warn};

pub const WS_SIN: &str = "wss://ap-sin3.ws.api.kiyotaka.ai/nonbook/ws?encoding=json";
pub const WS_EU: &str = "wss://eu-de3.ws.api.kiyotaka.ai/nonbook/ws?encoding=json";

/// Events emitted into the live-executor. Tiny structs to keep the hot
/// path allocation-light.
#[derive(Debug, Clone)]
pub enum LiveEvent {
    Liquidation {
        ts: EventTs,
        exchange: String,
        symbol: String,
        side: LiqSide,
        usd_value: f64,
    },
    Funding {
        ts: EventTs,
        symbol: String,
        rate: f64,
    },
    /// A hourly OHLCV batch (via TRADE_AGG with batchInterval=3600).
    Candle {
        ts: EventTs,
        symbol: String,
        open: f64,
        high: f64,
        low: f64,
        close: f64,
        volume: f64,
    },
}

#[derive(Clone, Debug)]
pub struct Subscription {
    pub channel_type: &'static str, // e.g. "LIQUIDATION"
    pub exchange: &'static str,     // "BINANCE_FUTURES"
    pub symbol: String,             // "BTCUSDT"
    pub category: &'static str,     // "*" or "PERPETUAL"
}

#[derive(Serialize)]
struct AuthMsg<'a> {
    jsonrpc: &'static str,
    id: u64,
    method: &'static str,
    params: AuthParams<'a>,
}

#[derive(Serialize)]
struct AuthParams<'a> {
    token: &'a str,
}

#[derive(Serialize)]
struct SubscribeMsg<'a> {
    jsonrpc: &'static str,
    id: u64,
    method: &'static str,
    params: SubscribeParams<'a>,
}

#[derive(Serialize)]
struct SubscribeParams<'a> {
    channels: Vec<ChannelDef<'a>>,
    compression: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
struct ChannelDef<'a> {
    #[serde(rename = "type")]
    type_: &'a str,
    exchange: &'a str,
    symbol: &'a str,
    category: &'a str,
}

/// Inbound wire envelope. Kiyotaka emits point-based payloads wrapped in
/// `{ "points": [...] }` per the public docs example.
#[derive(Debug, Deserialize)]
struct PointsEnvelope {
    #[serde(default)]
    points: Vec<PointWire>,
}

// Unused fields are reserved for channels we may wire later (TRADE,
// OPEN_INTEREST). Suppressed at the struct level so the Deserialize
// impl still sees them.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct PointWire {
    series: SeriesMeta,
    #[serde(default)]
    trade: Option<TradeWire>,
    #[serde(default)]
    liquidation: Option<LiqWire>,
    #[serde(default)]
    funding_rate: Option<FundingWire>,
    #[serde(default)]
    open_interest: Option<OiWire>,
}

#[derive(Debug, Deserialize)]
struct SeriesMeta {
    #[serde(rename = "type")]
    type_: String,
    #[serde(default)]
    symbol: String,
    #[serde(default)]
    exchange: String,
    #[serde(default)]
    side: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct TradeWire {
    #[serde(default)]
    price: f64,
    #[serde(default)]
    amount: f64,
    timestamp: TsWire,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiqWire {
    #[serde(default)]
    price: f64,
    #[serde(default)]
    amount: f64,
    timestamp: TsWire,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FundingWire {
    #[serde(default)]
    rate: f64,
    timestamp: TsWire,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct OiWire {
    #[serde(default)]
    open_interest: f64,
    timestamp: TsWire,
}

#[derive(Debug, Deserialize)]
struct TsWire {
    #[serde(default)]
    seconds: i64,
}

/// Spawn a background task that keeps the WS connection alive, resubscribes
/// on reconnect, and pushes `LiveEvent`s into the returned receiver.
pub fn spawn_ws(
    api_key: String,
    url: String,
    subs: Vec<Subscription>,
) -> mpsc::Receiver<LiveEvent> {
    let (tx, rx) = mpsc::channel::<LiveEvent>(4096);
    tokio::spawn(ws_driver(api_key, url, subs, tx));
    rx
}

async fn ws_driver(
    api_key: String,
    url: String,
    subs: Vec<Subscription>,
    tx: mpsc::Sender<LiveEvent>,
) {
    let mut backoff = Duration::from_secs(2);
    loop {
        match run_once(&api_key, &url, &subs, &tx).await {
            Ok(()) => {
                info!("ws closed cleanly, reconnecting in 2s");
                backoff = Duration::from_secs(2);
            }
            Err(e) => {
                warn!(error=%e, backoff_s=backoff.as_secs(), "ws error, reconnecting");
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(60));
    }
}

async fn run_once(
    api_key: &str,
    url: &str,
    subs: &[Subscription],
    tx: &mpsc::Sender<LiveEvent>,
) -> Result<(), WsError> {
    let (mut ws, _resp) = connect_async(url).await.map_err(WsError::Connect)?;
    info!(%url, "ws connected");

    // 1. authenticate
    let auth = serde_json::to_string(&AuthMsg {
        jsonrpc: "2.0",
        id: 0,
        method: "public/authenticate",
        params: AuthParams { token: api_key },
    })
    .map_err(WsError::Serde)?;
    ws.send(Message::Text(auth)).await.map_err(WsError::Send)?;

    // Wait for the auth ack before subscribing — some servers drop the
    // connection if the subscribe races in front of the auth response.
    if let Some(msg) = ws.next().await {
        let msg = msg.map_err(WsError::Recv)?;
        if let Message::Text(text) = &msg {
            debug!(%text, "auth response");
            if text.contains("\"error\"") {
                return Err(WsError::Auth(text.to_string()));
            }
        }
    }

    // 2. subscribe
    let channels: Vec<ChannelDef> = subs
        .iter()
        .map(|s| ChannelDef {
            type_: s.channel_type,
            exchange: s.exchange,
            symbol: &s.symbol,
            category: s.category,
        })
        .collect();
    let sub = serde_json::to_string(&SubscribeMsg {
        jsonrpc: "2.0",
        id: 1,
        method: "public/subscribe",
        params: SubscribeParams {
            channels,
            // We ask JSON (no brotli) to keep the parser simple; if
            // bandwidth becomes a concern, flip to "brotli" and add
            // `brotli` as a dep.
            compression: "none",
            version: "v2",
        },
    })
    .map_err(WsError::Serde)?;
    ws.send(Message::Text(sub)).await.map_err(WsError::Send)?;
    info!(n = subs.len(), "ws subscribed");

    // 3. consume
    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(WsError::Recv)?;
        match msg {
            Message::Text(text) => dispatch(&text, tx).await,
            Message::Ping(p) => {
                let _ = ws.send(Message::Pong(p)).await;
            }
            Message::Close(_) => break,
            // Binary (brotli-compressed) / Pong / Frame are ignored
            // uniformly — we don't need the payload.
            _ => {}
        }
    }
    Ok(())
}

async fn dispatch(raw: &str, tx: &mpsc::Sender<LiveEvent>) {
    // Kiyotaka sometimes sends jsonrpc ack frames; ignore those.
    if raw.contains("\"result\"") && !raw.contains("\"points\"") {
        return;
    }
    let Ok(env) = serde_json::from_str::<PointsEnvelope>(raw) else {
        debug!(%raw, "unparseable ws frame");
        return;
    };
    for p in env.points {
        let ev = match p.series.type_.as_str() {
            "LIQUIDATION" => {
                let (Some(liq), Some(side_str)) = (p.liquidation, p.series.side) else {
                    continue;
                };
                let side = match side_str.as_str() {
                    "BUY" => LiqSide::Buy,
                    "SELL" => LiqSide::Sell,
                    _ => continue,
                };
                LiveEvent::Liquidation {
                    ts: EventTs::from_secs(liq.timestamp.seconds),
                    exchange: p.series.exchange,
                    symbol: p.series.symbol,
                    side,
                    usd_value: liq.price * liq.amount,
                }
            }
            "FUNDING_RATE" => {
                let Some(f) = p.funding_rate else { continue };
                LiveEvent::Funding {
                    ts: EventTs::from_secs(f.timestamp.seconds),
                    symbol: p.series.symbol,
                    rate: f.rate,
                }
            }
            "TRADE_AGG" => {
                // Light mapping: we flatten a trade-agg payload to a Candle.
                // Full OHLC is encoded in the PointWire payload in another
                // shape; for now the aggregator pulls candles via REST
                // at bar-close, so this arm is a stub.
                continue;
            }
            "TRADE" | "OPEN_INTEREST" => {
                continue;
            }
            other => {
                debug!(type_=%other, "ignored ws event");
                continue;
            }
        };
        if tx.send(ev).await.is_err() {
            break; // receiver dropped
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum WsError {
    #[error("connect: {0}")]
    Connect(tokio_tungstenite::tungstenite::Error),
    #[error("send: {0}")]
    Send(tokio_tungstenite::tungstenite::Error),
    #[error("recv: {0}")]
    Recv(tokio_tungstenite::tungstenite::Error),
    #[error("serde: {0}")]
    Serde(serde_json::Error),
    #[error("auth rejected: {0}")]
    Auth(String),
}
