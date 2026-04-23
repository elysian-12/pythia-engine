//! Self-governed weight budget.
//!
//! Implements a token-bucket that refills at `per_minute / 60` per second with
//! a maximum of `burst` tokens. All calls to the Kiyotaka API must `reserve`
//! the weight they need before issuing the request.
//!
//! This is independent of the server-side rate limiter; we assume headers may
//! not be populated for our key and must self-govern.

use std::time::Instant;
use tokio::sync::Mutex;
use tokio::time::{sleep_until, Instant as TokioInstant};

#[derive(Copy, Clone, Debug)]
pub struct BudgetCfg {
    pub per_minute: u32,
    pub burst: u32,
}

impl Default for BudgetCfg {
    fn default() -> Self {
        // Advanced tier.
        Self {
            per_minute: 750,
            burst: 1_500,
        }
    }
}

#[derive(Debug)]
pub struct WeightBudget {
    cfg: BudgetCfg,
    inner: Mutex<Inner>,
}

#[derive(Debug)]
struct Inner {
    tokens: f64,
    last: Instant,
}

impl WeightBudget {
    pub fn new(cfg: BudgetCfg) -> Self {
        Self {
            cfg,
            inner: Mutex::new(Inner {
                tokens: f64::from(cfg.burst),
                last: Instant::now(),
            }),
        }
    }

    /// Reserve `n` weight, waiting if necessary. Always resolves.
    pub async fn reserve(&self, n: u32) {
        loop {
            let wait = {
                let mut g = self.inner.lock().await;
                let now = Instant::now();
                let elapsed = now.duration_since(g.last).as_secs_f64();
                let refill = elapsed * f64::from(self.cfg.per_minute) / 60.0;
                g.tokens = (g.tokens + refill).min(f64::from(self.cfg.burst));
                g.last = now;
                if g.tokens >= f64::from(n) {
                    g.tokens -= f64::from(n);
                    return;
                }
                // Time needed to accrue enough tokens.
                let deficit = f64::from(n) - g.tokens;
                let secs = deficit * 60.0 / f64::from(self.cfg.per_minute);
                secs.max(0.050)
            };
            let until = TokioInstant::now() + std::time::Duration::from_secs_f64(wait);
            sleep_until(until).await;
        }
    }

    /// Non-blocking snapshot of current token count.
    pub async fn snapshot(&self) -> f64 {
        let g = self.inner.lock().await;
        g.tokens
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn immediate_within_burst() {
        let b = WeightBudget::new(BudgetCfg {
            per_minute: 60,
            burst: 10,
        });
        // Should complete quickly — bucket is full at 10.
        let t0 = std::time::Instant::now();
        for _ in 0..10 {
            b.reserve(1).await;
        }
        assert!(t0.elapsed().as_millis() < 200, "elapsed={:?}", t0.elapsed());
        // Tokens near zero — allow tiny refill during the loop.
        assert!(b.snapshot().await < 1.0);
    }

    #[tokio::test]
    async fn waits_for_refill_when_empty() {
        let b = WeightBudget::new(BudgetCfg {
            per_minute: 6_000, // 100/sec refill
            burst: 10,
        });
        // Drain the bucket.
        for _ in 0..10 {
            b.reserve(1).await;
        }
        // Now reserve 5 more — must wait ~50ms.
        let t0 = std::time::Instant::now();
        b.reserve(5).await;
        let elapsed = t0.elapsed();
        assert!(
            elapsed.as_millis() >= 40 && elapsed.as_millis() < 500,
            "elapsed={elapsed:?}"
        );
    }
}
