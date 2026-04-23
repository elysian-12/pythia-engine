//! Basic statistical utilities used across the econometrics crate.

/// Pearson correlation.
pub fn pearson(x: &[f64], y: &[f64]) -> f64 {
    let n = x.len().min(y.len());
    if n == 0 {
        return 0.0;
    }
    let mx: f64 = x.iter().take(n).sum::<f64>() / n as f64;
    let my: f64 = y.iter().take(n).sum::<f64>() / n as f64;
    let mut num = 0.0;
    let mut dx = 0.0;
    let mut dy = 0.0;
    for i in 0..n {
        let a = x[i] - mx;
        let b = y[i] - my;
        num += a * b;
        dx += a * a;
        dy += b * b;
    }
    if dx <= 0.0 || dy <= 0.0 {
        return 0.0;
    }
    num / (dx.sqrt() * dy.sqrt())
}

/// Lag-k cross-correlation: corr(x[t-k], y[t]).
pub fn cross_corr(x: &[f64], y: &[f64], k: usize) -> f64 {
    if x.len() <= k || y.len() <= k {
        return 0.0;
    }
    let n = x.len().min(y.len()) - k;
    let xs = &x[..n];
    let ys = &y[k..k + n];
    pearson(xs, ys)
}

/// Returns `(best_lag, best_corr)` where `best_corr = corr(x[t-k], y[t])`
/// maximised over `k ∈ [1, max_lag]`. Positive lag means x leads y.
pub fn lead_lag_peak(x: &[f64], y: &[f64], max_lag: usize) -> (usize, f64) {
    let mut best = (0usize, f64::NEG_INFINITY);
    for k in 1..=max_lag {
        let c = cross_corr(x, y, k);
        if c > best.1 {
            best = (k, c);
        }
    }
    best
}

/// Full-series z-score (mean/std of `x` itself).
pub fn zscore(x: &[f64]) -> Vec<f64> {
    let n = x.len();
    if n == 0 {
        return vec![];
    }
    let m: f64 = x.iter().sum::<f64>() / n as f64;
    let var: f64 = x.iter().map(|v| (v - m).powi(2)).sum::<f64>() / n as f64;
    let sd = var.sqrt().max(1e-12);
    x.iter().map(|v| (v - m) / sd).collect()
}

/// Rolling z-score of the final point given the previous window.
pub fn zscore_last(x: &[f64], window: usize) -> Option<f64> {
    if x.len() < window.max(2) {
        return None;
    }
    let start = x.len() - window;
    let w = &x[start..];
    let m: f64 = w.iter().sum::<f64>() / w.len() as f64;
    let var: f64 = w.iter().map(|v| (v - m).powi(2)).sum::<f64>() / w.len() as f64;
    let sd = var.sqrt().max(1e-12);
    Some((x[x.len() - 1] - m) / sd)
}

/// Gini coefficient on a non-negative vector. Standard formula for sorted values.
/// Returns 0 (perfect equality) .. 1 (perfect concentration).
pub fn gini(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut v: Vec<f64> = values.iter().copied().map(f64::abs).collect();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len() as f64;
    let sum: f64 = v.iter().sum();
    if sum <= 0.0 {
        return 0.0;
    }
    let cumsum: f64 = v
        .iter()
        .enumerate()
        .map(|(i, x)| (i as f64 + 1.0) * x)
        .sum();
    ((2.0 * cumsum) / (n * sum)) - ((n + 1.0) / n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pearson_perfect_positive() {
        let x: Vec<f64> = (0..100).map(|i| i as f64).collect();
        let y: Vec<f64> = x.iter().map(|v| 2.0 * v + 1.0).collect();
        assert!((pearson(&x, &y) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn pearson_perfect_negative() {
        let x: Vec<f64> = (0..100).map(|i| i as f64).collect();
        let y: Vec<f64> = x.iter().map(|v| -v).collect();
        assert!((pearson(&x, &y) + 1.0).abs() < 1e-9);
    }

    #[test]
    fn gini_uniform_zero() {
        let v = vec![1.0; 20];
        assert!(gini(&v).abs() < 1e-9);
    }

    #[test]
    fn gini_concentrated_high() {
        let mut v = vec![0.0; 99];
        v.push(100.0);
        assert!(gini(&v) > 0.95);
    }

    #[test]
    fn zscore_constant_series() {
        let v = vec![5.0; 10];
        let z = zscore(&v);
        // std dev is 0 → falls back to small epsilon; result should be near 0 for all.
        assert!(z.iter().all(|x| x.abs() < 1e-6));
    }

    #[test]
    fn lead_lag_detects_shift() {
        // y is x shifted by 5.
        let x: Vec<f64> = (0..200).map(|i| (i as f64 * 0.1).sin()).collect();
        let mut y = vec![0.0; 5];
        y.extend_from_slice(&x[..x.len() - 5]);
        // y[t] = x[t-5]  => cross_corr(x[t-5], y[t]) = cross_corr(x[t-5], x[t-5]) ≈ 1
        // Implemented as cross_corr(x, y, k=5) ≈ 1.
        let (k, c) = lead_lag_peak(&x, &y, 10);
        assert_eq!(k, 5);
        assert!(c > 0.95, "peak corr {c} at lag {k}");
    }
}
