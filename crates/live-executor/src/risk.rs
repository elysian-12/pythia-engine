//! Runtime risk guard — kill-switch, daily loss limit, drawdown halt.
//!
//! Sits between signal firing and order placement. Before every trade we
//! consult the guard; any vote of "no" blocks the order.

use std::time::{Duration, Instant};

use parking_lot::Mutex;

#[derive(Clone, Debug)]
pub struct RiskCfg {
    /// Daily loss limit as a fraction of starting equity (e.g. 0.03).
    pub daily_loss_fraction: f64,
    /// Halt entirely if live equity drops below this fraction of peak.
    pub drawdown_halt: f64,
    /// Per-asset cooldown (seconds) after a signal fires. Duplicates the
    /// aggregator cooldown but protects against restart races.
    pub cooldown_secs: u64,
    /// Max simultaneously open trades across all assets.
    pub max_open: usize,
}

impl Default for RiskCfg {
    fn default() -> Self {
        Self {
            daily_loss_fraction: 0.03,
            drawdown_halt: 0.85,
            cooldown_secs: 6 * 3600,
            max_open: 2,
        }
    }
}

#[derive(Debug)]
pub struct RiskGuard {
    cfg: RiskCfg,
    inner: Mutex<Inner>,
}

#[derive(Debug)]
struct Inner {
    starting_equity: f64,
    peak_equity: f64,
    open_trades: usize,
    last_signal_at: std::collections::HashMap<String, Instant>,
    disabled: bool,
}

impl RiskGuard {
    pub fn new(cfg: RiskCfg, starting_equity: f64) -> Self {
        Self {
            cfg,
            inner: Mutex::new(Inner {
                starting_equity,
                peak_equity: starting_equity,
                open_trades: 0,
                last_signal_at: std::collections::HashMap::new(),
                disabled: false,
            }),
        }
    }

    /// Update equity — called after every paper fill or live query.
    pub fn update_equity(&self, equity: f64) -> GuardDecision {
        let mut g = self.inner.lock();
        if equity > g.peak_equity {
            g.peak_equity = equity;
        }
        let daily_threshold = g.starting_equity * (1.0 - self.cfg.daily_loss_fraction);
        let dd_threshold = g.peak_equity * self.cfg.drawdown_halt;
        if equity < dd_threshold {
            g.disabled = true;
            return GuardDecision::Halt(format!(
                "equity {:.2} below drawdown threshold {:.2}",
                equity, dd_threshold
            ));
        }
        if equity < daily_threshold {
            return GuardDecision::DailyLossLimit(format!(
                "equity {:.2} below daily loss limit {:.2}",
                equity, daily_threshold
            ));
        }
        GuardDecision::Ok
    }

    pub fn permit_signal(&self, symbol: &str) -> GuardDecision {
        let mut g = self.inner.lock();
        if g.disabled {
            return GuardDecision::Halt("guard disabled".into());
        }
        if g.open_trades >= self.cfg.max_open {
            return GuardDecision::MaxOpen;
        }
        if let Some(last) = g.last_signal_at.get(symbol) {
            if last.elapsed() < Duration::from_secs(self.cfg.cooldown_secs) {
                return GuardDecision::Cooldown;
            }
        }
        g.last_signal_at.insert(symbol.to_string(), Instant::now());
        g.open_trades += 1;
        GuardDecision::Ok
    }

    pub fn on_position_closed(&self) {
        let mut g = self.inner.lock();
        if g.open_trades > 0 {
            g.open_trades -= 1;
        }
    }

    pub fn disable(&self, reason: &str) {
        let mut g = self.inner.lock();
        g.disabled = true;
        tracing::warn!(reason, "risk guard disabled");
    }

    pub fn is_disabled(&self) -> bool {
        self.inner.lock().disabled
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum GuardDecision {
    Ok,
    Cooldown,
    MaxOpen,
    DailyLossLimit(String),
    Halt(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drawdown_halts_guard() {
        let g = RiskGuard::new(RiskCfg::default(), 1_000.0);
        g.update_equity(1_200.0);
        let d = g.update_equity(800.0); // peak was 1200, 85% of 1200 = 1020
        assert!(matches!(d, GuardDecision::Halt(_)));
    }

    #[test]
    fn cooldown_blocks_repeat() {
        let g = RiskGuard::new(RiskCfg::default(), 1_000.0);
        assert_eq!(g.permit_signal("BTCUSDT"), GuardDecision::Ok);
        assert_eq!(g.permit_signal("BTCUSDT"), GuardDecision::Cooldown);
    }

    #[test]
    fn max_open_blocks_third() {
        let g = RiskGuard::new(
            RiskCfg {
                max_open: 2,
                cooldown_secs: 0,
                ..RiskCfg::default()
            },
            1_000.0,
        );
        assert_eq!(g.permit_signal("A"), GuardDecision::Ok);
        assert_eq!(g.permit_signal("B"), GuardDecision::Ok);
        assert_eq!(g.permit_signal("C"), GuardDecision::MaxOpen);
    }
}
