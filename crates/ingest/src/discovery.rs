//! Crypto-relevance filter for Polymarket markets.

use domain::{market::Category, position::UserPosition};

const CRYPTO_KEYWORDS: &[&str] = &[
    "bitcoin", "btc", "ethereum", "eth", "solana", "sol", "crypto",
    "sec", "etf", "fed", "fomc", "interest rate", "rate cut", "rate hike",
    "inflation", "cpi", "recession",
];

const CRYPTO_CATEGORIES: &[&str] = &["Crypto", "Business", "Science", "Economics"];

/// Returns true if this position touches a PM market whose outcome is
/// *plausibly* relevant to BTC/ETH price action.
pub fn is_crypto_relevant(p: &UserPosition) -> bool {
    matches!(p.category, Category::Crypto) || matches!(&p.category, Category::Other(s) if CRYPTO_CATEGORIES.iter().any(|c| s.eq_ignore_ascii_case(c)))
        || name_hit(&p.market_name)
        || name_hit(&p.sub_category)
}

fn name_hit(s: &str) -> bool {
    let lower = s.to_lowercase();
    CRYPTO_KEYWORDS.iter().any(|k| lower.contains(k))
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::{
        ids::{AssetId, ConditionId, Wallet},
        market::Category,
    };

    fn p(market: &str, cat: Category) -> UserPosition {
        UserPosition {
            wallet: Wallet::new("0x0"),
            asset_id: AssetId::new(""),
            condition_id: ConditionId::new(""),
            unrealized_size: 0.0,
            realized_size: 0.0,
            avg_price: 0.0,
            avg_exit_price: 0.0,
            realized_pnl: 0.0,
            resolved_price: None,
            latest_open_ts: 0,
            prev_hold_duration: 0,
            buy_count: 0,
            sell_count: 0,
            market_name: market.into(),
            outcome_name: "YES".into(),
            category: cat,
            sub_category: String::new(),
        }
    }

    #[test]
    fn keyword_match_triggers() {
        let pos = p("Will the Fed cut rates in June?", Category::Other("Politics".into()));
        assert!(is_crypto_relevant(&pos));
    }

    #[test]
    fn crypto_category_triggers() {
        let pos = p("some market", Category::Crypto);
        assert!(is_crypto_relevant(&pos));
    }

    #[test]
    fn off_topic_rejected() {
        let pos = p("NFL Super Bowl winner", Category::Sports);
        assert!(!is_crypto_relevant(&pos));
    }
}
