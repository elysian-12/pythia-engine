//! Stationary block bootstrap confidence intervals.
//!
//! Politis & Romano (1994): "The Stationary Bootstrap." *JASA*.
//!
//! Traditional i.i.d. bootstrap breaks autocorrelation in time-series
//! returns. The stationary block bootstrap resamples geometrically
//! distributed block lengths — preserving dependence structure while
//! maintaining stationarity of the resampled series.

use rand::{rngs::StdRng, Rng, SeedableRng};
use serde::{Deserialize, Serialize};

#[derive(Copy, Clone, Debug, Serialize, Deserialize)]
pub struct Ci {
    pub lo: f64,
    pub hi: f64,
    pub median: f64,
    pub n_resamples: usize,
    pub level: f64,
}

/// Sharpe ratio of a series (mean / std).
fn sharpe(r: &[f64]) -> f64 {
    if r.len() < 2 {
        return 0.0;
    }
    let m: f64 = r.iter().sum::<f64>() / r.len() as f64;
    let var: f64 = r.iter().map(|x| (x - m).powi(2)).sum::<f64>() / r.len() as f64;
    m / var.sqrt().max(1e-18)
}

/// Generate one stationary-bootstrap sample of size `n` from `data` with
/// expected block length `mean_block`.
fn resample(data: &[f64], n: usize, mean_block: f64, rng: &mut StdRng) -> Vec<f64> {
    let len = data.len();
    if len == 0 {
        return Vec::new();
    }
    let p = 1.0 / mean_block.max(1.0); // prob of new-block draw
    let mut out = Vec::with_capacity(n);
    let mut idx = rng.gen_range(0..len);
    while out.len() < n {
        out.push(data[idx]);
        if rng.gen::<f64>() < p {
            idx = rng.gen_range(0..len);
        } else {
            idx = (idx + 1) % len;
        }
    }
    out
}

/// Stationary block bootstrap confidence interval on Sharpe at level
/// `level` (e.g. 0.95 → 2.5%/97.5% percentile).
pub fn block_bootstrap_sharpe(
    returns: &[f64],
    n_resamples: usize,
    mean_block: f64,
    level: f64,
    seed: u64,
) -> Ci {
    if returns.len() < 4 {
        return Ci {
            lo: 0.0,
            hi: 0.0,
            median: 0.0,
            n_resamples: 0,
            level,
        };
    }
    let mut rng = StdRng::seed_from_u64(seed);
    let mut stats = Vec::with_capacity(n_resamples);
    for _ in 0..n_resamples {
        let s = resample(returns, returns.len(), mean_block, &mut rng);
        stats.push(sharpe(&s));
    }
    stats.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let alpha = (1.0 - level) / 2.0;
    let lo_idx = ((stats.len() as f64) * alpha).floor() as usize;
    let hi_idx = ((stats.len() as f64) * (1.0 - alpha)).floor() as usize;
    let mid = stats[stats.len() / 2];
    Ci {
        lo: stats[lo_idx.min(stats.len() - 1)],
        hi: stats[hi_idx.min(stats.len() - 1)],
        median: mid,
        n_resamples,
        level,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ci_contains_true_sharpe_for_iid_signal() {
        // Generate N(0.01, 0.02) returns; true Sharpe ≈ 0.5.
        let mut r = Vec::with_capacity(500);
        let mut s = 42u64;
        for _ in 0..500 {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let u1 = (((s >> 32) as u32) as f64 / f64::from(u32::MAX)).max(1e-12);
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let u2 = ((s >> 32) as u32) as f64 / f64::from(u32::MAX);
            let g = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos();
            r.push(0.01 + 0.02 * g);
        }
        let ci = block_bootstrap_sharpe(&r, 500, 1.0, 0.95, 7);
        // Sharpe is mean/std = 0.01/0.02 = 0.5 expected.
        assert!(ci.lo > 0.1 && ci.hi < 1.0, "ci={ci:?}");
    }

    #[test]
    fn empty_returns_zero_ci() {
        let ci = block_bootstrap_sharpe(&[], 100, 1.0, 0.95, 1);
        assert_eq!(ci.n_resamples, 0);
    }
}
