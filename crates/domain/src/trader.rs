//! Trader profile + skill score.

use crate::ids::Wallet;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TraderProfile {
    pub wallet: Wallet,
    pub total_position_count: i64,
    pub open_position_count: i64,
    pub closed_position_count: i64,
    pub total_size: f64,
    pub total_realized_pnl: f64,
    pub total_unrealized_pnl: f64,
    pub total_roi: f64,
    pub win_rate_by_positions: f64,
    pub largest_win: f64,
    pub largest_loss: f64,
    pub avg_holding_duration: i64,
}

/// Bayesian posterior-based skill score.
///
/// - `win_rate_posterior`: Beta(α=2+wins, β=2+losses) mean. Prior is uninformative Beta(2,2)
///   so a wallet with 5/5 record scores ~0.58, not 1.0. Prevents skill-score runaway.
/// - `pnl_signal`: `ln(1 + max(realized_pnl, 0)) / ln(1 + 1e7)` clamped to [0,1].
/// - `volume_factor`: `sqrt(n_trades / 50)` clamped to [0,1] — below 50 trades is uncertain.
/// - `skill = win_rate_posterior * (0.6 + 0.4 * pnl_signal) * volume_factor`.
///
/// Returns a value in [0, 1]. Deliberately conservative; the point is to filter
/// out lucky/noisy wallets, not to overweight heroes.
#[must_use]
pub fn skill_score(p: &TraderProfile) -> f64 {
    let closed = p.closed_position_count.max(0) as f64;
    let wins = (p.win_rate_by_positions / 100.0) * closed;

    // Beta(2,2) prior => (wins+2) / (closed + 4)
    let win_post = (wins + 2.0) / (closed + 4.0);

    // Log-scaled PnL signal, clamped
    let pnl_pos = p.total_realized_pnl.max(0.0);
    let pnl_sig = (1.0_f64 + pnl_pos).ln() / (1.0_f64 + 1.0e7).ln();
    let pnl_sig = pnl_sig.clamp(0.0, 1.0);

    let vol = (closed / 50.0).sqrt().clamp(0.0, 1.0);

    let raw = win_post * (0.6 + 0.4 * pnl_sig) * vol;
    raw.clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::Wallet;

    fn profile(wins: i64, losses: i64, pnl: f64) -> TraderProfile {
        let total = wins + losses;
        TraderProfile {
            wallet: Wallet::new("0x0"),
            total_position_count: total,
            open_position_count: 0,
            closed_position_count: total,
            total_size: pnl.abs() * 10.0,
            total_realized_pnl: pnl,
            total_unrealized_pnl: 0.0,
            total_roi: 0.0,
            win_rate_by_positions: if total > 0 {
                (wins as f64 / total as f64) * 100.0
            } else {
                0.0
            },
            largest_win: pnl.max(0.0),
            largest_loss: pnl.min(0.0),
            avg_holding_duration: 86400,
        }
    }

    #[test]
    fn skill_is_bounded() {
        assert!((0.0..=1.0).contains(&skill_score(&profile(0, 0, 0.0))));
        assert!((0.0..=1.0).contains(&skill_score(&profile(1000, 0, 1e9))));
        assert!((0.0..=1.0).contains(&skill_score(&profile(0, 1000, -1e9))));
    }

    #[test]
    fn small_sample_is_penalised() {
        // 5/5 but low volume — should not score near 1
        let s = skill_score(&profile(5, 0, 10_000.0));
        assert!(s < 0.4, "small-sample skill={s}");
    }

    #[test]
    fn elite_wallet_scores_high() {
        // 80% win rate, 1000 trades, $90M PnL (mirrors top leaderboard wallet)
        let s = skill_score(&profile(800, 200, 90_000_000.0));
        assert!(s > 0.7, "elite skill={s}");
    }

    #[test]
    fn negative_pnl_still_capped() {
        let s = skill_score(&profile(500, 500, -50_000_000.0));
        assert!((0.0..=1.0).contains(&s));
    }
}
