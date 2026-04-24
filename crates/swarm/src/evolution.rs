//! Genetic evolution for the systematic agent population.
//!
//! Every `generation_interval` events, we:
//!   1. Rank agents by total R (from the scoreboard).
//!   2. Keep the top `elite_fraction` as-is (survival).
//!   3. Fill the rest via **mutation** of elites (Gaussian perturbation of
//!      their parameters) and **crossover** (swap parameters between pairs
//!      of elites to spawn new individuals).
//!   4. Evicted agents' decisions remain in history but stop firing.
//!
//! Evolution is conservative by default — small mutation sigmas, no
//! cross-family crossover (we don't blend liq-trend params into
//! funding-arb), and the elite is always preserved verbatim. The goal is
//! a slow, monotone improvement rather than population collapse.

use std::sync::atomic::{AtomicU64, Ordering};

use crate::agent::SwarmAgent;
use crate::scoring::{AgentStats, Scoreboard};
use crate::systematic::{RuleFamily, SystematicAgent, SystematicParams};

#[derive(Clone, Debug)]
pub struct EvolutionCfg {
    /// Fraction of population that survives each generation.
    pub elite_fraction: f64,
    /// Stdev of the log-space mutation applied to each numeric parameter.
    pub mutation_sigma: f64,
    /// Minimum trades an agent needs before it's eligible to be ranked
    /// (without this, unlucky newcomers with 0 trades would tie at 0 R).
    pub min_decisions: usize,
    /// Probability that a new individual is produced via crossover
    /// instead of pure mutation.
    pub crossover_prob: f64,
    /// Hard cap on population size — evolution preserves this.
    pub population_cap: usize,
}

impl Default for EvolutionCfg {
    fn default() -> Self {
        Self {
            elite_fraction: 0.5,
            mutation_sigma: 0.15, // log-space
            min_decisions: 5,
            crossover_prob: 0.3,
            population_cap: 20,
        }
    }
}

pub struct Evolution {
    cfg: EvolutionCfg,
    generation: u64,
    rng_state: u64,
}

impl std::fmt::Debug for Evolution {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Evolution")
            .field("generation", &self.generation)
            .finish_non_exhaustive()
    }
}

impl Evolution {
    pub fn new(cfg: EvolutionCfg, seed: u64) -> Self {
        Self {
            cfg,
            generation: 0,
            rng_state: seed.wrapping_add(1),
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Produce the next generation from `current` agents + the `scoreboard`.
    /// Returns a fresh Vec of agents, sized at `population_cap`.
    ///
    /// Tries to identify each `current` agent's parameters by probing the
    /// scoreboard for a recorded `AgentStats`. Agents without a stats
    /// entry (fresh boot) are kept unchanged.
    pub fn advance(
        &mut self,
        current: Vec<(SystematicParams, String)>, // (params, id)
        scoreboard: &Scoreboard,
    ) -> Vec<Box<dyn SwarmAgent>> {
        self.generation += 1;
        // Score every current agent.
        let mut scored: Vec<ScoredAgent> = current
            .into_iter()
            .map(|(params, id)| {
                let stats = scoreboard.stats(&id).unwrap_or_default();
                ScoredAgent { id, params, stats }
            })
            .collect();

        // Elite — top N by total_R with enough decisions.
        scored.retain(|a| a.stats.wins + a.stats.losses >= self.cfg.min_decisions);
        scored.sort_by(|a, b| {
            b.stats
                .total_r
                .partial_cmp(&a.stats.total_r)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let elite_n = ((scored.len() as f64) * self.cfg.elite_fraction).ceil() as usize;
        let elite_n = elite_n.max(1).min(scored.len());
        let elite: Vec<ScoredAgent> = scored.into_iter().take(elite_n).collect();

        let mut next: Vec<Box<dyn SwarmAgent>> = Vec::with_capacity(self.cfg.population_cap);

        // 1. Preserve elite unchanged.
        for a in &elite {
            next.push(Box::new(SystematicAgent::new(a.id.clone(), a.params.clone())));
        }

        // 2. Fill remainder with mutants / crossovers.
        while next.len() < self.cfg.population_cap && !elite.is_empty() {
            let parent_a = self.pick_parent(&elite);
            let new_id = self.new_id(&parent_a.id);
            let params = if self.coin(self.cfg.crossover_prob) && elite.len() > 1 {
                let parent_b = self.pick_parent(&elite);
                self.crossover(&parent_a.params, &parent_b.params)
            } else {
                self.mutate(&parent_a.params)
            };
            next.push(Box::new(SystematicAgent::new(new_id, params)));
        }
        next
    }

    fn pick_parent<'a>(&mut self, elite: &'a [ScoredAgent]) -> &'a ScoredAgent {
        // Rank-weighted: index 0 has 2× the odds of index last.
        let n = elite.len() as f64;
        // Inverse-rank weights: w_i = n - i
        let total: f64 = (1..=elite.len() as u64).map(|i| i as f64).sum();
        let mut pick = self.uniform() * total;
        for (i, a) in elite.iter().enumerate() {
            let w = n - i as f64;
            pick -= w;
            if pick <= 0.0 {
                return a;
            }
        }
        &elite[0]
    }

    fn crossover(&mut self, a: &SystematicParams, b: &SystematicParams) -> SystematicParams {
        // Same family only — don't blend liq-trend with funding-arb.
        if !same_family(a.family, b.family) {
            return self.mutate(a);
        }
        let mut out = a.clone();
        if self.coin(0.5) {
            out.z_threshold = b.z_threshold;
        }
        if self.coin(0.5) {
            out.cooldown_bars = b.cooldown_bars;
        }
        if self.coin(0.5) {
            out.horizon_hours = b.horizon_hours;
        }
        if self.coin(0.5) {
            out.risk_fraction = b.risk_fraction;
        }
        if self.coin(0.5) {
            out.z_window = b.z_window;
        }
        if self.coin(0.5) {
            out.donchian_bars = b.donchian_bars;
        }
        self.mutate(&out)
    }

    fn mutate(&mut self, p: &SystematicParams) -> SystematicParams {
        let mut out = p.clone();
        // Log-space Gaussian on continuous params.
        out.z_threshold = self.log_jitter(out.z_threshold).clamp(1.5, 4.0);
        out.risk_fraction = self.log_jitter(out.risk_fraction).clamp(0.003, 0.03);
        out.horizon_hours = self.int_log_jitter(out.horizon_hours).clamp(2, 48);
        out.cooldown_bars = self.usize_jitter(out.cooldown_bars).clamp(2, 48);
        out.z_window = self.usize_jitter(out.z_window).clamp(12, 400);
        out.donchian_bars = self.usize_jitter(out.donchian_bars).clamp(8, 96);
        out.atr_pct_min = self.log_jitter(out.atr_pct_min).clamp(0.001, 0.02);
        out
    }

    fn log_jitter(&mut self, v: f64) -> f64 {
        let delta = self.normal() * self.cfg.mutation_sigma;
        v * delta.exp()
    }
    fn int_log_jitter(&mut self, v: i64) -> i64 {
        let jittered = self.log_jitter(v as f64);
        jittered.round() as i64
    }
    fn usize_jitter(&mut self, v: usize) -> usize {
        let jittered = self.log_jitter(v as f64);
        jittered.round().max(1.0) as usize
    }

    fn uniform(&mut self) -> f64 {
        self.rng_state = self.rng_state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let u = (self.rng_state >> 32) as u32;
        f64::from(u) / f64::from(u32::MAX)
    }
    fn coin(&mut self, p: f64) -> bool {
        self.uniform() < p
    }
    /// Box–Muller transform for a zero-mean, unit-variance sample.
    fn normal(&mut self) -> f64 {
        let u1 = self.uniform().max(1e-12);
        let u2 = self.uniform();
        (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
    }

    fn new_id(&self, parent_id: &str) -> String {
        static COUNTER: AtomicU64 = AtomicU64::new(1);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        format!("gen{}-mut{}-{}", self.generation, n, parent_id)
    }
}

fn same_family(a: RuleFamily, b: RuleFamily) -> bool {
    std::mem::discriminant(&a) == std::mem::discriminant(&b)
}

#[derive(Clone, Debug)]
struct ScoredAgent {
    id: String,
    params: SystematicParams,
    stats: AgentStats,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::systematic::SystematicParams;

    fn make_current() -> Vec<(SystematicParams, String)> {
        vec![
            (SystematicParams::liq_trend(), "liq-trend-v0".into()),
            (SystematicParams::liq_trend(), "liq-trend-v1".into()),
            (SystematicParams::vol_breakout(), "vol-breakout-v0".into()),
            (SystematicParams::vol_breakout(), "vol-breakout-v1".into()),
            (SystematicParams::funding_arb(), "funding-arb-v0".into()),
        ]
    }

    #[test]
    fn advance_produces_population_cap_new_agents() {
        let sb = Scoreboard::new();
        // Give the first agent a clear edge.
        for i in 0..20 {
            let d = crate::agent::AgentDecision {
                id: format!("d{}", i),
                agent_id: "liq-trend-v0".into(),
                ts: domain::time::EventTs::from_secs(0),
                asset: domain::crypto::Asset::Btc,
                direction: domain::signal::Direction::Long,
                conviction: 80,
                risk_fraction: 0.01,
                horizon_s: 3600,
                rationale: "t".into(),
            };
            sb.record(d);
            sb.mark_outcome(&format!("d{}", i), 1.0, 50.0);
        }
        let mut e = Evolution::new(
            EvolutionCfg {
                population_cap: 6,
                ..Default::default()
            },
            42,
        );
        let next = e.advance(make_current(), &sb);
        assert_eq!(next.len(), 6);
    }

    #[test]
    fn mutation_stays_in_bounds() {
        let mut e = Evolution::new(EvolutionCfg::default(), 1);
        let mut p = SystematicParams::liq_trend();
        for _ in 0..1000 {
            p = e.mutate(&p);
            assert!(p.z_threshold >= 1.5 && p.z_threshold <= 4.0);
            assert!(p.risk_fraction >= 0.003 && p.risk_fraction <= 0.03);
        }
    }
}
