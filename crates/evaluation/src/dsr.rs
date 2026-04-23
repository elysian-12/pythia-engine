//! Probabilistic and Deflated Sharpe Ratio.
//!
//! Bailey, D. H. and López de Prado, M. M. (2012): "The Sharpe Ratio
//! Efficient Frontier." *Journal of Risk*.
//!
//! Bailey, D. H. and López de Prado, M. M. (2014): "The Deflated Sharpe
//! Ratio: Correcting for Selection Bias, Backtest Overfitting, and
//! Non-Normality." *Journal of Portfolio Management*.
//!
//! These metrics answer two questions a naive Sharpe cannot:
//! 1. Is the observed Sharpe statistically distinguishable from a benchmark
//!    given the sample size and distributional moments?
//! 2. After trying N strategy variants, is the selected winner's Sharpe
//!    still meaningful after the multiple-testing adjustment?

use serde::{Deserialize, Serialize};
use statrs::distribution::{ContinuousCDF, Normal};

/// Compute Sharpe, skew, kurtosis of a return series.
fn moments(r: &[f64]) -> (f64, f64, f64, f64) {
    let n = r.len() as f64;
    if n < 2.0 {
        return (0.0, 0.0, 0.0, 3.0);
    }
    let m1: f64 = r.iter().sum::<f64>() / n;
    let var: f64 = r.iter().map(|x| (x - m1).powi(2)).sum::<f64>() / n;
    let sd = var.sqrt().max(1e-18);
    let sharpe = m1 / sd;
    let m3: f64 = r.iter().map(|x| (x - m1).powi(3)).sum::<f64>() / n;
    let m4: f64 = r.iter().map(|x| (x - m1).powi(4)).sum::<f64>() / n;
    let skew = m3 / sd.powi(3);
    let kurt = m4 / sd.powi(4); // non-excess
    (sharpe, sd, skew, kurt)
}

#[derive(Copy, Clone, Debug, Serialize, Deserialize)]
pub struct PsrResult {
    pub sharpe: f64,
    pub psr: f64,
    pub n: usize,
    pub skew: f64,
    pub kurtosis: f64,
}

/// Probabilistic Sharpe Ratio for benchmark `sr_star`.
///
/// PSR = CDF( (SR - SR*) · sqrt((n-1) / (1 - γ3·SR + 0.25·(γ4-1)·SR²)) )
///
/// where γ3 = skew, γ4 = kurtosis (raw, not excess).
pub fn probabilistic_sharpe_ratio(returns: &[f64], sr_star: f64) -> PsrResult {
    let (sharpe, _sd, skew, kurt) = moments(returns);
    let n = returns.len();
    if n < 4 {
        return PsrResult {
            sharpe,
            psr: 0.5,
            n,
            skew,
            kurtosis: kurt,
        };
    }
    // (γ4 - 1): kurt is raw 4th standardised moment; excess kurt = kurt - 3,
    // and the formula uses γ4 - 1 where γ4 is raw; but many references use
    // (1 - skew·SR + 0.25·(kurt_excess)·SR²). We use the raw-kurt form that
    // matches Bailey & López de Prado 2012 eq. (7).
    let denom = 1.0 - skew * sharpe + 0.25 * (kurt - 1.0) * sharpe.powi(2);
    let denom_safe = denom.max(1e-12);
    let z = (sharpe - sr_star) * ((n as f64 - 1.0) / denom_safe).sqrt();
    let norm = Normal::new(0.0, 1.0).expect("N(0,1) is well-defined");
    PsrResult {
        sharpe,
        psr: norm.cdf(z),
        n,
        skew,
        kurtosis: kurt,
    }
}

/// Deflated Sharpe Ratio.
///
/// Given `n_trials` strategy variants tried, the expected maximum Sharpe
/// under the null (no skill) is
///
///   E[max SR] ≈ (1 - γ)·Φ⁻¹(1 - 1/N) + γ·Φ⁻¹(1 - 1/(Ne))
///
/// where γ = Euler-Mascheroni ≈ 0.5772, and `v` is the cross-sectional
/// variance of Sharpes across trials (not provided here — we pass it in).
/// DSR then evaluates PSR against that expected-max threshold.
///
/// `sharpes_across_trials` is used to estimate the variance term.
pub fn deflated_sharpe_ratio(
    returns: &[f64],
    sharpes_across_trials: &[f64],
) -> PsrResult {
    let n_trials = sharpes_across_trials.len().max(1) as f64;
    let var_sr = if sharpes_across_trials.len() < 2 {
        0.0
    } else {
        let m: f64 = sharpes_across_trials.iter().sum::<f64>() / n_trials;
        sharpes_across_trials
            .iter()
            .map(|x| (x - m).powi(2))
            .sum::<f64>()
            / n_trials
    };

    const EULER: f64 = 0.577_215_664_901_532_9;
    let norm = Normal::new(0.0, 1.0).expect("N(0,1) is well-defined");
    // Φ⁻¹(1 - 1/N)
    let inv1 = if n_trials >= 2.0 {
        norm.inverse_cdf(1.0 - 1.0 / n_trials)
    } else {
        0.0
    };
    let inv2 = if n_trials * std::f64::consts::E >= 2.0 {
        norm.inverse_cdf(1.0 - 1.0 / (n_trials * std::f64::consts::E))
    } else {
        0.0
    };
    let sr_star = var_sr.sqrt() * ((1.0 - EULER) * inv1 + EULER * inv2);
    probabilistic_sharpe_ratio(returns, sr_star)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synth_normal_returns(mean: f64, sd: f64, n: usize, seed: u64) -> Vec<f64> {
        // Box-Muller on an LCG.
        let mut s = seed;
        let mut out = Vec::with_capacity(n);
        while out.len() < n {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let u1 = (((s >> 32) as u32) as f64 / f64::from(u32::MAX)).max(1e-12);
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let u2 = ((s >> 32) as u32) as f64 / f64::from(u32::MAX);
            let r = (-2.0 * u1.ln()).sqrt();
            let z0 = r * (2.0 * std::f64::consts::PI * u2).cos();
            let z1 = r * (2.0 * std::f64::consts::PI * u2).sin();
            out.push(mean + sd * z0);
            if out.len() < n {
                out.push(mean + sd * z1);
            }
        }
        out
    }

    #[test]
    fn psr_skilled_beats_benchmark() {
        let r = synth_normal_returns(0.01, 0.02, 500, 1);
        let res = probabilistic_sharpe_ratio(&r, 0.0);
        assert!(res.psr > 0.99, "psr={}", res.psr);
    }

    #[test]
    fn psr_unskilled_averages_near_half() {
        // Average PSR across 20 unskilled seeds should be near 0.5 even when
        // individual seeds stray. This is the true statistical property.
        let mut psrs = Vec::new();
        for seed in 0..20u64 {
            let r = synth_normal_returns(0.0, 0.02, 500, seed + 100);
            psrs.push(probabilistic_sharpe_ratio(&r, 0.0).psr);
        }
        let mean = psrs.iter().sum::<f64>() / psrs.len() as f64;
        assert!(mean > 0.35 && mean < 0.65, "mean psr over 20 seeds = {mean}");
    }

    #[test]
    fn dsr_is_more_conservative_than_psr_under_multiple_trials() {
        let winner = synth_normal_returns(0.005, 0.02, 500, 3);
        // 50 trial Sharpes drawn from an unskilled distribution.
        let sharpes: Vec<f64> = (0..50)
            .map(|i| {
                let v = synth_normal_returns(0.0, 0.02, 200, 10 + i);
                moments(&v).0
            })
            .collect();
        let psr = probabilistic_sharpe_ratio(&winner, 0.0).psr;
        let dsr = deflated_sharpe_ratio(&winner, &sharpes).psr;
        assert!(dsr <= psr, "dsr={dsr} psr={psr} — DSR must be no larger");
    }
}
