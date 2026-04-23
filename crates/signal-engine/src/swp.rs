//! SWP (Skill-Weighted Probability) computation.

use domain::{market::distribution_mid, position::UserPosition, trader::skill_score, trader::TraderProfile};
use std::collections::HashMap;

/// Wrapped per-wallet position with the wallet's skill score at the relevant time.
#[derive(Debug)]
pub struct PositionWithSkill<'a> {
    pub position: &'a UserPosition,
    pub skill: f64,
}

/// SWP from positions + skill scores + current YES outcome price (from mid).
///
/// Formula: `Σ weight_i * side_i / Σ weight_i`, where
/// - `side_i` = probability the wallet bets on YES at entry (`avg_price`).
/// - `weight_i = skill_i * sqrt(size_i)` (sub-linear size to avoid whale dominance).
/// - `side_i` in [0, 1]; the wallet's `avg_price` is the price they paid for the
///   YES outcome, so it is already the implied probability they think the
///   outcome has (for a rational price).
pub fn swp_from_positions(
    positions: &[&UserPosition],
    skills: &HashMap<String, f64>,
) -> Option<f64> {
    if positions.is_empty() {
        return None;
    }
    let mut num = 0.0;
    let mut den = 0.0;
    for p in positions {
        let size = p.net_size().abs();
        if size <= 0.0 || p.avg_price <= 0.0 || p.avg_price >= 1.0 {
            continue;
        }
        let skill = skills.get(p.wallet.as_str()).copied().unwrap_or(0.0);
        let w = skill * size.sqrt();
        if w <= 0.0 {
            continue;
        }
        // Convert "yes" vs "no" outcome into YES-probability.
        let implied = if p.outcome_name.eq_ignore_ascii_case("yes") {
            p.avg_price
        } else if p.outcome_name.eq_ignore_ascii_case("no") {
            1.0 - p.avg_price
        } else {
            p.avg_price
        };
        num += w * implied;
        den += w;
    }
    if den <= 0.0 {
        None
    } else {
        Some(num / den)
    }
}

/// Convenience that wraps the (wallet → TraderProfile) lookup.
pub fn swp_with_profiles(
    positions: &[&UserPosition],
    profiles: &HashMap<String, TraderProfile>,
) -> Option<f64> {
    let skills: HashMap<String, f64> = profiles
        .iter()
        .map(|(k, v)| (k.clone(), skill_score(v)))
        .collect();
    swp_from_positions(positions, &skills)
}

/// Market-summary distribution mid (wrapper for the domain fn).
pub fn swp_from_distribution(buckets: &[f64]) -> Option<f64> {
    distribution_mid(buckets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::{
        ids::{AssetId, ConditionId, Wallet},
        market::Category,
    };

    fn mk(wallet: &str, market: &str, avg: f64, size: f64, outcome: &str) -> UserPosition {
        UserPosition {
            wallet: Wallet::new(wallet),
            asset_id: AssetId::new(""),
            condition_id: ConditionId::new(""),
            unrealized_size: size,
            realized_size: 0.0,
            avg_price: avg,
            avg_exit_price: 0.0,
            realized_pnl: 0.0,
            resolved_price: None,
            latest_open_ts: 0,
            prev_hold_duration: 0,
            buy_count: 1,
            sell_count: 0,
            market_name: market.into(),
            outcome_name: outcome.into(),
            category: Category::Crypto,
            sub_category: String::new(),
        }
    }

    #[test]
    fn swp_equals_avg_when_skills_equal() {
        let a = mk("0xa", "M", 0.6, 1000.0, "Yes");
        let b = mk("0xb", "M", 0.8, 1000.0, "Yes");
        let positions = vec![&a, &b];
        let mut skills = HashMap::new();
        skills.insert("0xa".into(), 0.5);
        skills.insert("0xb".into(), 0.5);
        let swp = swp_from_positions(&positions, &skills).unwrap();
        assert!((swp - 0.7).abs() < 1e-9, "swp={swp}");
    }

    #[test]
    fn swp_biases_toward_skilled() {
        let a = mk("0xa", "M", 0.6, 1000.0, "Yes"); // lower skill
        let b = mk("0xb", "M", 0.8, 1000.0, "Yes"); // higher skill
        let positions = vec![&a, &b];
        let mut skills = HashMap::new();
        skills.insert("0xa".into(), 0.1);
        skills.insert("0xb".into(), 0.9);
        let swp = swp_from_positions(&positions, &skills).unwrap();
        assert!(swp > 0.76, "swp={swp} should tilt toward 0.8");
    }

    #[test]
    fn no_vs_yes_flipped() {
        let a = mk("0xa", "M", 0.7, 1000.0, "No"); // paid 0.7 for NO → implied YES=0.3
        let positions = vec![&a];
        let mut skills = HashMap::new();
        skills.insert("0xa".into(), 0.5);
        let swp = swp_from_positions(&positions, &skills).unwrap();
        assert!((swp - 0.3).abs() < 1e-9);
    }
}
