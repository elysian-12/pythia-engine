//! Map PM markets → crypto asset + direction sign + horizon.

use domain::{crypto::Asset, market::Category, position::UserPosition};

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum CryptoRelevance {
    /// Direct crypto market (BTC price target, etc.)
    Direct(Asset),
    /// Macro (Fed, rate) — primary effect on BTC.
    Macro(Asset),
    /// Political / event — possible but weak link.
    Political(Asset),
    /// Not crypto-relevant.
    None,
}

#[derive(Copy, Clone, Debug)]
pub struct MarketAssetMapping {
    pub relevance: CryptoRelevance,
    pub sign: i8,
    pub horizon_s: i64,
}

/// Cheap keyword-based classifier. Returns None if not crypto-relevant.
pub fn map_position(p: &UserPosition) -> Option<MarketAssetMapping> {
    let name = p.market_name.to_lowercase();
    let outcome = p.outcome_name.to_lowercase();

    if name.contains("bitcoin") || name.contains("btc") {
        let sign = outcome_direction_sign(&outcome, &name);
        return Some(MarketAssetMapping {
            relevance: CryptoRelevance::Direct(Asset::Btc),
            sign,
            horizon_s: 24 * 3600,
        });
    }
    if name.contains("ethereum") || name.contains("eth ") || name.contains("ether ") {
        return Some(MarketAssetMapping {
            relevance: CryptoRelevance::Direct(Asset::Eth),
            sign: outcome_direction_sign(&outcome, &name),
            horizon_s: 24 * 3600,
        });
    }
    if name.contains("fed") || name.contains("fomc") || name.contains("rate cut")
        || name.contains("rate hike") || name.contains("interest rate")
    {
        let sign = if outcome.contains("cut") || outcome.contains("lower") {
            1
        } else if outcome.contains("hike") || outcome.contains("raise") {
            -1
        } else {
            1
        };
        return Some(MarketAssetMapping {
            relevance: CryptoRelevance::Macro(Asset::Btc),
            sign,
            horizon_s: 2 * 3600,
        });
    }
    if name.contains("etf") && (name.contains("crypto") || name.contains("bitcoin") || name.contains("ethereum")) {
        return Some(MarketAssetMapping {
            relevance: CryptoRelevance::Macro(Asset::Btc),
            sign: if outcome.contains("yes") || outcome.contains("approve") { 1 } else { -1 },
            horizon_s: 8 * 3600,
        });
    }
    if matches!(p.category, Category::Politics) || matches!(&p.category, Category::Other(s) if s.eq_ignore_ascii_case("politics")) {
        // Generic political → very weak, small horizon, default BTC long on Yes.
        return Some(MarketAssetMapping {
            relevance: CryptoRelevance::Political(Asset::Btc),
            sign: 1,
            horizon_s: 6 * 3600,
        });
    }
    None
}

fn outcome_direction_sign(outcome: &str, market: &str) -> i8 {
    // Market phrased as "BTC above $X" → YES means BTC up → sign +1.
    // Market phrased as "BTC below $X" → YES means BTC down → sign -1.
    if outcome == "yes" {
        if market.contains("above") || market.contains("hit") || market.contains("reach") || market.contains("break") {
            1
        } else if market.contains("below") || market.contains("under") || market.contains("drop") {
            -1
        } else {
            1
        }
    } else if outcome == "no" {
        -1
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::ids::{AssetId, ConditionId, Wallet};

    fn pos(market: &str, outcome: &str, cat: Category) -> UserPosition {
        UserPosition {
            wallet: Wallet::new("0x0"),
            asset_id: AssetId::new(""),
            condition_id: ConditionId::new(""),
            unrealized_size: 1.0,
            realized_size: 0.0,
            avg_price: 0.5,
            avg_exit_price: 0.0,
            realized_pnl: 0.0,
            resolved_price: None,
            latest_open_ts: 0,
            prev_hold_duration: 0,
            buy_count: 1,
            sell_count: 0,
            market_name: market.into(),
            outcome_name: outcome.into(),
            category: cat,
            sub_category: String::new(),
        }
    }

    #[test]
    fn btc_direct_above() {
        let p = pos("Will BTC hit $150k by December?", "Yes", Category::Crypto);
        let m = map_position(&p).unwrap();
        assert!(matches!(m.relevance, CryptoRelevance::Direct(Asset::Btc)));
        assert_eq!(m.sign, 1);
    }

    #[test]
    fn fed_cut() {
        let p = pos("Will the Fed cut rates in June?", "Yes", Category::Other("Politics".into()));
        let m = map_position(&p).unwrap();
        assert!(matches!(m.relevance, CryptoRelevance::Macro(Asset::Btc)));
        assert_eq!(m.sign, 1);
    }

    #[test]
    fn sports_filtered() {
        let p = pos("NFL Super Bowl winner", "Yes", Category::Sports);
        assert!(map_position(&p).is_none());
    }
}
