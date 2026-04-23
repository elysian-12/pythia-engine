//! Engle-Granger cointegration test (two-step).
//!
//! 1. Run OLS y1 = α + β y2 + ε.
//! 2. Run an augmented Dickey-Fuller (ADF) test on the residuals — null is
//!    unit root (no cointegration). We use the τ-statistic with 5% critical
//!    value approx -2.86 (asymptotic, no constant in ADF regression with
//!    constant in cointegration).
//!
//! This implementation uses a **lag-1 ADF with no trend** for simplicity. It's
//! not as powerful as higher-lag variants but is robust and enough to gate
//! signal firing. Residuals must be stationary for cointegration.

use nalgebra::{DMatrix, DVector};
use serde::{Deserialize, Serialize};

use crate::EconError;

/// Approximate 5% critical value for residual-based ADF in Engle-Granger
/// with one regressor (MacKinnon 1991, asymptotic).
pub const EG_CRITICAL_5PCT: f64 = -3.37;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CointegrationResult {
    pub beta: f64,
    pub alpha: f64,
    pub adf_tau: f64,
    pub residual_half_life: f64,
    pub cointegrated_5pct: bool,
}

pub fn cointegration_test(y1: &[f64], y2: &[f64]) -> Result<CointegrationResult, EconError> {
    let n = y1.len().min(y2.len());
    if n < 30 {
        return Err(EconError::Insufficient { need: 30, have: n });
    }

    // Step 1: OLS y1 = alpha + beta * y2 + e.
    let y = DVector::from_column_slice(&y1[..n]);
    let ones = DVector::from_element(n, 1.0);
    let y2v = DVector::from_column_slice(&y2[..n]);
    let mut x_data = Vec::with_capacity(n * 2);
    for i in 0..n {
        x_data.push(ones[i]);
        x_data.push(y2v[i]);
    }
    let x = DMatrix::from_row_slice(n, 2, &x_data);

    let xt_x = &x.transpose() * &x;
    let inv = xt_x
        .try_inverse()
        .ok_or_else(|| EconError::LinAlg("singular X'X".into()))?;
    let beta_hat = inv * x.transpose() * &y;
    let alpha = beta_hat[0];
    let beta = beta_hat[1];
    let residuals: Vec<f64> = (0..n).map(|i| y1[i] - alpha - beta * y2[i]).collect();

    // Step 2: ADF(1) on residuals: Δe_t = γ e_{t-1} + δ Δe_{t-1} + ν_t (no constant, no trend).
    let (tau, half_life) = adf_lag1(&residuals)?;

    Ok(CointegrationResult {
        alpha,
        beta,
        adf_tau: tau,
        residual_half_life: half_life,
        cointegrated_5pct: tau < EG_CRITICAL_5PCT,
    })
}

fn adf_lag1(e: &[f64]) -> Result<(f64, f64), EconError> {
    let n = e.len();
    if n < 10 {
        return Err(EconError::Insufficient { need: 10, have: n });
    }
    let de: Vec<f64> = (1..n).map(|i| e[i] - e[i - 1]).collect();

    // Regression: de[i] = γ * e[i-1+1-1]  + δ * de[i-1]  for i = 1..de.len()
    let mut rows = Vec::new();
    let mut y_adf = Vec::new();
    for i in 1..de.len() {
        rows.push(e[i]); // e_{t-1} for de[i] = e[i+1] - e[i]; we model against e[i]
        rows.push(de[i - 1]);
        y_adf.push(de[i]);
    }
    let m = y_adf.len();
    if m < 5 {
        return Err(EconError::Insufficient { need: 5, have: m });
    }
    let y = DVector::from_column_slice(&y_adf);
    let x = DMatrix::from_row_slice(m, 2, &rows);

    let xt_x = &x.transpose() * &x;
    let inv = xt_x
        .try_inverse()
        .ok_or_else(|| EconError::LinAlg("singular ADF X'X".into()))?;
    let beta = &inv * x.transpose() * &y;
    let gamma = beta[0];

    let resid = &y - &x * &beta;
    let rss = resid.dot(&resid);
    let df = (m - 2) as f64;
    let sigma2 = rss / df.max(1.0);
    let se_gamma = (sigma2 * inv[(0, 0)]).abs().sqrt().max(1e-12);
    let tau = gamma / se_gamma;

    let half_life = if gamma < 0.0 {
        (0.5_f64.ln()) / (1.0 + gamma).ln().min(-1e-9)
    } else {
        f64::INFINITY
    };

    Ok((tau, half_life))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_random_walk(n: usize, seed: u64) -> Vec<f64> {
        // LCG-ish deterministic RNG so tests are reproducible without rand dep.
        let mut s = seed;
        let mut out = Vec::with_capacity(n);
        let mut v = 0.0;
        for _ in 0..n {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let u = ((s >> 33) as f64) / (u32::MAX as f64); // 0..1
            let g = u - 0.5;
            v += g;
            out.push(v);
        }
        out
    }

    #[test]
    fn non_cointegrated_rws_fail_test() {
        let a = make_random_walk(300, 1);
        let b = make_random_walk(300, 2);
        let r = cointegration_test(&a, &b).unwrap();
        assert!(!r.cointegrated_5pct, "independent RWs should not cointegrate (tau={})", r.adf_tau);
    }

    #[test]
    fn cointegrated_pair_passes() {
        // y2 is a random walk, y1 = 0.5 + 0.9*y2 + stationary (iid) noise
        let y2 = make_random_walk(500, 3);
        // Stationary noise from differences of an RW (which are iid increments).
        let src = make_random_walk(501, 4);
        let noise: Vec<f64> = (1..501).map(|i| (src[i] - src[i - 1]) * 0.2).collect();
        let y1: Vec<f64> = y2.iter().zip(noise.iter()).map(|(a, b)| 0.5 + 0.9 * a + b).collect();
        let r = cointegration_test(&y1, &y2).unwrap();
        assert!(r.cointegrated_5pct, "cointegrated pair should pass (tau={})", r.adf_tau);
        assert!((r.beta - 0.9).abs() < 0.1, "beta {} off target", r.beta);
    }

    #[test]
    fn insufficient_data_errors() {
        let a = vec![1.0; 10];
        let b = vec![1.0; 10];
        assert!(cointegration_test(&a, &b).is_err());
    }
}
