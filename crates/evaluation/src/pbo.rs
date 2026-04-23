//! Probability of Backtest Overfitting (PBO).
//!
//! Bailey, D. H., Borwein, J. M., López de Prado, M. M., Zhu, Q. J. (2014):
//! "The Probability of Backtest Overfitting." *Journal of Computational
//! Finance*.
//!
//! Split performance series into S = 2k chunks, form C(S, k) combinations
//! that split into IS / OOS, pick the IS winner, and check whether the
//! same strategy is still top-50% OOS. PBO is the frequency of
//! rank-inversion (winner IS goes below median OOS).

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PboResult {
    pub pbo: f64,
    pub n_splits: usize,
    pub s: usize,
    pub k: usize,
}

/// Compute PBO from a matrix of per-strategy returns: rows are strategies,
/// columns are time chunks. All rows must be the same length.
///
/// If `matrix` has N strategies and T columns, we split T into `s = 2k`
/// chunks (dropping trailing leftovers) and enumerate all ways to pick
/// half the chunks as IS. For each split, compute Sharpe per strategy on
/// IS, find the winner, and check its OOS rank. PBO is the fraction of
/// splits where the IS winner is below OOS median.
pub fn probability_of_backtest_overfitting(matrix: &[Vec<f64>], s: usize) -> PboResult {
    if matrix.is_empty() || matrix.len() < 2 || s < 2 || s % 2 != 0 {
        return PboResult {
            pbo: 0.5,
            n_splits: 0,
            s,
            k: s / 2,
        };
    }
    let t = matrix[0].len();
    let chunk_size = t / s;
    if chunk_size < 2 {
        return PboResult {
            pbo: 0.5,
            n_splits: 0,
            s,
            k: s / 2,
        };
    }

    let k = s / 2;
    let mut inversions = 0usize;
    let mut total = 0usize;

    // Enumerate C(s, k) combinations.
    for combo in combinations(s, k) {
        let is_chunks: Vec<usize> = combo.clone();
        let oos_chunks: Vec<usize> = (0..s).filter(|i| !is_chunks.contains(i)).collect();
        let n_strats = matrix.len();
        let mut is_sharpe = vec![0.0; n_strats];
        let mut oos_sharpe = vec![0.0; n_strats];
        for (si, row) in matrix.iter().enumerate() {
            let is_data = gather(row, &is_chunks, chunk_size);
            let oos_data = gather(row, &oos_chunks, chunk_size);
            is_sharpe[si] = sharpe(&is_data);
            oos_sharpe[si] = sharpe(&oos_data);
        }
        let winner = argmax(&is_sharpe);
        // OOS rank of the winner (ascending). 0 = worst, n_strats-1 = best.
        let mut sorted: Vec<usize> = (0..n_strats).collect();
        sorted.sort_by(|a, b| oos_sharpe[*a].partial_cmp(&oos_sharpe[*b]).unwrap_or(std::cmp::Ordering::Equal));
        let oos_rank = sorted.iter().position(|&i| i == winner).unwrap_or(0);
        if oos_rank < n_strats / 2 {
            inversions += 1;
        }
        total += 1;
    }
    PboResult {
        pbo: if total == 0 { 0.5 } else { inversions as f64 / total as f64 },
        n_splits: total,
        s,
        k,
    }
}

fn sharpe(r: &[f64]) -> f64 {
    if r.len() < 2 {
        return 0.0;
    }
    let m: f64 = r.iter().sum::<f64>() / r.len() as f64;
    let var: f64 = r.iter().map(|x| (x - m).powi(2)).sum::<f64>() / r.len() as f64;
    m / var.sqrt().max(1e-18)
}

fn gather(row: &[f64], chunks: &[usize], chunk_size: usize) -> Vec<f64> {
    let mut out = Vec::with_capacity(chunks.len() * chunk_size);
    for &c in chunks {
        let start = c * chunk_size;
        let end = (start + chunk_size).min(row.len());
        if start < end {
            out.extend_from_slice(&row[start..end]);
        }
    }
    out
}

fn argmax(v: &[f64]) -> usize {
    let mut best = 0usize;
    for (i, x) in v.iter().enumerate() {
        if x > &v[best] {
            best = i;
        }
    }
    best
}

/// Enumerate k-combinations of {0..n}. Returned in lexicographic order.
fn combinations(n: usize, k: usize) -> Vec<Vec<usize>> {
    let mut out = Vec::new();
    if k == 0 || k > n {
        return out;
    }
    let mut idx: Vec<usize> = (0..k).collect();
    loop {
        out.push(idx.clone());
        let mut i = k;
        while i > 0 {
            i -= 1;
            if idx[i] < n - (k - i) {
                idx[i] += 1;
                for j in (i + 1)..k {
                    idx[j] = idx[j - 1] + 1;
                }
                break;
            }
            if i == 0 {
                return out;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pbo_zero_for_dominant_strategy() {
        // Strategy 0 dominates across all chunks.
        let rows = vec![
            (0..400).map(|_| 0.01).collect::<Vec<_>>(),    // consistent winner
            (0..400).map(|_| -0.01).collect::<Vec<_>>(),
            (0..400).map(|_| 0.0).collect::<Vec<_>>(),
        ];
        let r = probability_of_backtest_overfitting(&rows, 4);
        assert!(r.pbo < 0.1, "pbo={}", r.pbo);
    }

    #[test]
    fn pbo_high_for_noise() {
        // 5 strategies with i.i.d. N(0,1) — the IS winner is random;
        // expect PBO around 0.5 but certainly > 0.3.
        let mut s = 1u64;
        let mut row = || {
            (0..400)
                .map(|_| {
                    s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                    (((s >> 32) as u32) as f64 / f64::from(u32::MAX)) - 0.5
                })
                .collect::<Vec<_>>()
        };
        let rows: Vec<Vec<f64>> = (0..5).map(|_| row()).collect();
        let r = probability_of_backtest_overfitting(&rows, 6);
        assert!(r.pbo >= 0.25 && r.pbo <= 0.8, "pbo={}", r.pbo);
    }

    #[test]
    fn combinations_count() {
        assert_eq!(combinations(4, 2).len(), 6);
        assert_eq!(combinations(6, 3).len(), 20);
        assert_eq!(combinations(10, 5).len(), 252);
    }
}
