//! Granger causality F-test.
//!
//! Null hypothesis H0: past values of `y` do NOT help predict `x`.
//! Rejection threshold at 5% is ~3.0 for common (p=4, n>50) regressions.
//!
//! Method:
//! 1. Unrestricted:  x_t = c + Σ α_i x_{t-i} + Σ β_i y_{t-i} + u_t  → RSS_u
//! 2. Restricted:    x_t = c + Σ α_i x_{t-i} + u_t                  → RSS_r
//! 3. F = ((RSS_r - RSS_u)/p) / (RSS_u/(n - 2p - 1))

use nalgebra::{DMatrix, DVector};
use serde::{Deserialize, Serialize};
use statrs::distribution::{ContinuousCDF, FisherSnedecor};

use crate::EconError;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GrangerResult {
    pub f: f64,
    pub p_value: f64,
    pub lag: usize,
    pub n: usize,
}

impl GrangerResult {
    pub fn significant_5pct(&self) -> bool {
        self.p_value < 0.05
    }
}

/// Tests whether `cause` Granger-causes `target` at lag `p`.
pub fn granger_f(target: &[f64], cause: &[f64], lag: usize) -> Result<GrangerResult, EconError> {
    let n = target.len().min(cause.len());
    if n < 4 * lag + 10 {
        return Err(EconError::Insufficient {
            need: 4 * lag + 10,
            have: n,
        });
    }
    let start = lag;
    let m = n - start; // number of rows in regression

    // Restricted: const + p lags of target
    let cols_r = 1 + lag;
    let mut xr = Vec::with_capacity(m * cols_r);
    let mut y = Vec::with_capacity(m);
    for t in start..n {
        xr.push(1.0);
        for l in 1..=lag {
            xr.push(target[t - l]);
        }
        y.push(target[t]);
    }

    let rss_r = ols_rss(&xr, &y, cols_r)?;

    // Unrestricted: add p lags of cause
    let cols_u = 1 + 2 * lag;
    let mut xu = Vec::with_capacity(m * cols_u);
    for t in start..n {
        xu.push(1.0);
        for l in 1..=lag {
            xu.push(target[t - l]);
        }
        for l in 1..=lag {
            xu.push(cause[t - l]);
        }
    }
    let rss_u = ols_rss(&xu, &y, cols_u)?;

    let df_num = lag as f64;
    let df_den = (m as i64 - cols_u as i64).max(1) as f64;
    let f_stat = ((rss_r - rss_u).max(0.0) / df_num) / (rss_u / df_den);

    let fdist = FisherSnedecor::new(df_num, df_den)
        .map_err(|e| EconError::LinAlg(format!("fisher-snedecor: {e}")))?;
    let p_value = 1.0 - fdist.cdf(f_stat);

    Ok(GrangerResult {
        f: f_stat,
        p_value,
        lag,
        n,
    })
}

fn ols_rss(x_flat: &[f64], y: &[f64], cols: usize) -> Result<f64, EconError> {
    let rows = y.len();
    let x = DMatrix::from_row_slice(rows, cols, x_flat);
    let y_vec = DVector::from_column_slice(y);
    let xt_x = &x.transpose() * &x;
    let inv = xt_x
        .try_inverse()
        .ok_or_else(|| EconError::LinAlg("singular X'X in granger".into()))?;
    let beta = &inv * x.transpose() * &y_vec;
    let resid = &y_vec - &x * &beta;
    Ok(resid.dot(&resid))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rw(n: usize, seed: u64) -> Vec<f64> {
        let mut s = seed;
        let mut out = Vec::new();
        let mut v = 0.0;
        for _ in 0..n {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let u = ((s >> 33) as f64) / (u32::MAX as f64);
            v += u - 0.5;
            out.push(v);
        }
        out
    }

    #[test]
    fn no_causality_high_pvalue() {
        let a = rw(300, 10);
        let b = rw(300, 20);
        let g = granger_f(&a, &b, 4).unwrap();
        assert!(g.p_value > 0.05, "p={}", g.p_value);
    }

    #[test]
    fn strong_causality_detected() {
        // x_t = 0.8 * y_{t-2} + small noise  → y strongly Granger-causes x
        let y = rw(400, 30);
        let mut x = vec![0.0; 400];
        let noise = rw(400, 40);
        for t in 2..400 {
            x[t] = 0.8 * y[t - 2] + 0.1 * noise[t];
        }
        let g = granger_f(&x, &y, 4).unwrap();
        assert!(g.significant_5pct(), "f={} p={}", g.f, g.p_value);
    }

    #[test]
    fn insufficient_data() {
        let a = vec![1.0; 20];
        assert!(granger_f(&a, &a, 5).is_err());
    }
}
