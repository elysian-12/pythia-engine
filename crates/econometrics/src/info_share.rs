//! Information-share proxy (Hasbrouck 1995, simplified).
//!
//! Full Hasbrouck IS requires a VECM with Cholesky-ordered residual covariance.
//! This module computes an equivalent-rank proxy via a restricted VAR:
//!
//!   share_pm = 1 − RSS_unrestricted / RSS_restricted_using_only_own_lags
//!
//! where the restricted model is `target ~ own_lags` and the unrestricted adds
//! the other series' lags. Fraction of predictive variance attributable to the
//! *other* side. For bivariate systems this is monotonic in Hasbrouck IS and
//! gives the same regime signal (>0.5 = other side leads).

use nalgebra::{DMatrix, DVector};
use serde::{Deserialize, Serialize};

use crate::EconError;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InfoShare {
    /// Share of crypto-series predictive variance explained by lagged PM.
    pub share_pm: f64,
    /// Share of PM predictive variance explained by lagged crypto.
    pub share_crypto: f64,
    /// Rough upper bound: max(share_pm, share_crypto).
    pub dominant_side_share: f64,
}

/// Compute the proxy for a bivariate system {pm, crypto}.
pub fn information_share_proxy(
    pm: &[f64],
    crypto: &[f64],
    lag: usize,
) -> Result<InfoShare, EconError> {
    let share_pm = restricted_variance_share(crypto, pm, lag)?;
    let share_crypto = restricted_variance_share(pm, crypto, lag)?;
    let dominant = share_pm.max(share_crypto);
    Ok(InfoShare {
        share_pm,
        share_crypto,
        dominant_side_share: dominant,
    })
}

/// `target ~ target_lags + cause_lags`: returns share of RSS reduction
/// from adding `cause_lags`, normalised by the own-lags RSS.
fn restricted_variance_share(
    target: &[f64],
    cause: &[f64],
    lag: usize,
) -> Result<f64, EconError> {
    let n = target.len().min(cause.len());
    if n < 4 * lag + 10 {
        return Err(EconError::Insufficient { need: 4 * lag + 10, have: n });
    }
    let start = lag;
    let m = n - start;

    // Restricted
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

    // Unrestricted
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
    let share = ((rss_r - rss_u).max(0.0) / rss_r.max(1e-12)).clamp(0.0, 1.0);
    Ok(share)
}

fn ols_rss(x_flat: &[f64], y: &[f64], cols: usize) -> Result<f64, EconError> {
    let rows = y.len();
    let x = DMatrix::from_row_slice(rows, cols, x_flat);
    let y_vec = DVector::from_column_slice(y);
    let xt_x = &x.transpose() * &x;
    let inv = xt_x
        .try_inverse()
        .ok_or_else(|| EconError::LinAlg("singular X'X in info_share".into()))?;
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
    fn pm_leads_crypto_detected() {
        let pm = rw(300, 100);
        let mut crypto = vec![0.0; 300];
        let noise = rw(300, 200);
        for t in 2..300 {
            crypto[t] = 0.7 * pm[t - 2] + 0.1 * noise[t];
        }
        let is = information_share_proxy(&pm, &crypto, 4).unwrap();
        assert!(is.share_pm > 0.2, "share_pm={}", is.share_pm);
        assert!(is.share_pm > is.share_crypto);
    }

    #[test]
    fn shares_in_bounds() {
        let pm = rw(300, 10);
        let crypto = rw(300, 11);
        let is = information_share_proxy(&pm, &crypto, 4).unwrap();
        assert!((0.0..=1.0).contains(&is.share_pm));
        assert!((0.0..=1.0).contains(&is.share_crypto));
    }
}
