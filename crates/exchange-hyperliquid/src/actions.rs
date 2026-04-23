//! Typed Hyperliquid actions.
//!
//! The `order` action wraps a list of `wire`-format orders. Each wire
//! order has the asset index, limit px formatted as an API-compatible
//! string, size formatted as a string, reduce-only flag, and the
//! order-type tag.

use serde::Serialize;

use crate::types::{OrderRequest, OrderSide, Tif};

/// Top-level action envelope — what we sign and POST.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    Order(OrderAction),
    Cancel(CancelAction),
}

#[derive(Debug, Serialize)]
pub struct OrderAction {
    pub orders: Vec<WireOrder>,
    pub grouping: &'static str,
}

#[derive(Debug, Serialize)]
pub struct CancelAction {
    pub cancels: Vec<CancelSpec>,
}

#[derive(Debug, Serialize)]
pub struct CancelSpec {
    pub a: u32,
    pub o: u64,
}

/// The on-wire order shape. Field names are 1-char to match Hyperliquid's
/// msgpack schema bit-for-bit.
#[derive(Debug, Serialize)]
pub struct WireOrder {
    /// asset index
    pub a: u32,
    /// is_buy
    pub b: bool,
    /// price
    pub p: String,
    /// size
    pub s: String,
    /// reduce-only
    pub r: bool,
    /// order type
    pub t: OrderType,
}

#[derive(Debug, Serialize)]
pub enum OrderType {
    #[serde(rename = "limit")]
    Limit { tif: String },
    #[serde(rename = "trigger")]
    Trigger { trigger: Trigger },
}

#[derive(Debug, Serialize)]
pub struct Trigger {
    #[serde(rename = "isMarket")]
    pub is_market: bool,
    #[serde(rename = "triggerPx")]
    pub trigger_px: String,
    pub tpsl: &'static str,
}

impl OrderAction {
    pub fn single(req: &OrderRequest) -> Self {
        let tif_str = match req.tif {
            Tif::Gtc => "Gtc",
            Tif::Ioc => "Ioc",
            Tif::Alo => "Alo",
        };
        let t = match &req.trigger {
            None => OrderType::Limit {
                tif: tif_str.into(),
            },
            Some(sp) => OrderType::Trigger {
                trigger: Trigger {
                    is_market: sp.is_market,
                    trigger_px: fmt_px(sp.px),
                    tpsl: sp.kind,
                },
            },
        };
        Self {
            orders: vec![WireOrder {
                a: req.asset,
                b: matches!(req.side, OrderSide::Buy),
                p: fmt_px(req.limit_px),
                s: fmt_sz(req.size),
                r: req.reduce_only,
                t,
            }],
            grouping: "na",
        }
    }
}

/// Hyperliquid price formatting: <= 5 significant figures, <= 6 decimals.
/// Most integer prices format fine with up to 2 decimals.
pub fn fmt_px(p: f64) -> String {
    // Simplified: 2 decimals for prices ≥ 100, else scale.
    if p.abs() >= 100.0 {
        format!("{p:.2}")
    } else if p.abs() >= 1.0 {
        format!("{p:.4}")
    } else {
        format!("{p:.6}")
    }
}

pub fn fmt_sz(s: f64) -> String {
    // 6 decimal places — Hyperliquid accepts trailing zero-stripping on
    // the server side.
    let raw = format!("{s:.6}");
    // trim trailing zeros + trailing dot
    let trimmed = raw.trim_end_matches('0').trim_end_matches('.').to_string();
    if trimmed.is_empty() { "0".into() } else { trimmed }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn px_format_stable() {
        assert_eq!(fmt_px(65_000.123), "65000.12");
        assert_eq!(fmt_px(3_500.5), "3500.50");
        assert_eq!(fmt_px(1.2345), "1.2345");
        assert_eq!(fmt_px(0.001234), "0.001234");
    }

    #[test]
    fn sz_strips_trailing() {
        assert_eq!(fmt_sz(0.005000), "0.005");
        assert_eq!(fmt_sz(0.000010), "0.00001");
        assert_eq!(fmt_sz(1.0), "1");
    }

    #[test]
    fn action_round_trips() {
        let req = OrderRequest {
            asset: 0,
            side: OrderSide::Buy,
            size: 0.01,
            limit_px: 65_000.0,
            reduce_only: false,
            tif: Tif::Ioc,
            trigger: None,
        };
        let action = OrderAction::single(&req);
        let j = serde_json::to_string(&action).unwrap();
        assert!(j.contains("\"a\":0"));
        assert!(j.contains("\"b\":true"));
        assert!(j.contains("\"tif\":\"Ioc\""));
    }
}
