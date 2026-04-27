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

use std::collections::HashMap;
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
    /// Minimum seats reserved per `RuleFamily`. Without this, evolution
    /// converges hard onto whichever family had the highest Σ R during
    /// the seed era (e.g. vol-breakout) and the population collapses to
    /// one family — the "specialist for event kind X" router then has
    /// no candidates for kinds X owned by the extinct families. The
    /// router falls back to global champion, defeating the routing.
    /// Each family listed here is guaranteed at least `min_per_family`
    /// agents in every generation; if the elite alone doesn't supply
    /// enough, surviving agents are imported from the prior population
    /// (mutated) before generic mutants fill the rest.
    pub family_quotas: Vec<(RuleFamilyKind, usize)>,
}

/// Discriminant-only tag for `RuleFamily` (since the variants carry data).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuleFamilyKind {
    LiqTrend,
    LiqFade,
    FundingTrend,
    FundingArb,
    VolBreakout,
    PolyEdge,
}

impl RuleFamilyKind {
    fn matches(self, family: RuleFamily) -> bool {
        match (self, family) {
            (Self::LiqTrend, RuleFamily::LiqZScore { trend_follow: true }) => true,
            (Self::LiqFade, RuleFamily::LiqZScore { trend_follow: false }) => true,
            (Self::FundingTrend, RuleFamily::FundingZScore { trend_follow: true }) => true,
            (Self::FundingArb, RuleFamily::FundingZScore { trend_follow: false }) => true,
            (Self::VolBreakout, RuleFamily::VolBreakout) => true,
            (Self::PolyEdge, RuleFamily::PolyEdge) => true,
            _ => false,
        }
    }
}

impl Default for EvolutionCfg {
    fn default() -> Self {
        Self {
            elite_fraction: 0.5,
            mutation_sigma: 0.15, // log-space
            min_decisions: 5,
            crossover_prob: 0.3,
            population_cap: 20,
            // Two seats per family by default → 5 families × 2 = 10 seats
            // reserved, leaving 10 free for free-range competition. Tune
            // per-deployment via the live config.
            family_quotas: vec![
                (RuleFamilyKind::LiqTrend, 2),
                (RuleFamilyKind::LiqFade, 2),
                (RuleFamilyKind::FundingTrend, 2),
                (RuleFamilyKind::FundingArb, 2),
                (RuleFamilyKind::VolBreakout, 2),
                (RuleFamilyKind::PolyEdge, 2),
            ],
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

    /// Resume the generation counter from a persisted run so logs and the
    /// UI's `Gen N` indicator reflect cumulative evolution across restarts.
    pub fn set_generation(&mut self, generation: u64) {
        self.generation = generation;
    }

    /// Produce the next generation from `current` agents + the `scoreboard`.
    /// Returns a fresh Vec of agents, sized at `population_cap`.
    ///
    /// Tries to identify each `current` agent's parameters by probing the
    /// scoreboard for a recorded `AgentStats`. Agents without a stats
    /// entry (fresh boot) are kept unchanged.
    ///
    /// If no agent in `current` has reached `min_decisions` trades, the
    /// entire population is returned verbatim — there is no signal yet to
    /// drive selection, so wiping the floor would just throw away the seed
    /// roster. The generation counter is still bumped so callers can see
    /// the cycle ran.
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

        // Save the original population in case no one is eligible — we
        // return a clone of it rather than collapsing to empty.
        let fallback: Vec<Box<dyn SwarmAgent>> = scored
            .iter()
            .map(|a| {
                Box::new(SystematicAgent::new(a.id.clone(), a.params.clone())) as Box<dyn SwarmAgent>
            })
            .collect();

        // Elite — top N by **fitness score**, not raw total_R. The
        // earlier ranking sorted by lifetime cumulative R, which meant
        // a long-running seed with hundreds of trades had unbeatable
        // R against any fresh mutant simply by virtue of having lived
        // through more generations. The seed's elite slot was locked
        // for the lifetime of the run, the swarm visibly stopped
        // evolving, and the leaderboard filled with mutants that never
        // got rotated in.
        //
        // The new score is `recent_expectancy_r × √n_recent` —
        // expectancy normalized for sample size. Conceptually a
        // t-statistic on R-per-trade. Long-history seeds with high R
        // still win when their *average* trade is strong; mutants with
        // a small but consistently winning sample get a real shot at
        // the elite slot. Falls back to `expectancy_r` (lifetime mean)
        // when recent_expectancy is unavailable.
        scored.retain(|a| a.stats.wins + a.stats.losses >= self.cfg.min_decisions);
        if scored.is_empty() {
            return fallback;
        }
        const RECENT_WINDOW: usize = 50;
        let fitness = |a: &ScoredAgent| -> f64 {
            let n = (a.stats.wins + a.stats.losses) as f64;
            let recent = scoreboard
                .recent_expectancy(&a.id, RECENT_WINDOW, self.cfg.min_decisions)
                .unwrap_or(a.stats.expectancy_r);
            // sample size weight — capped at √RECENT_WINDOW so an
            // ageing elite doesn't accumulate unbeatable mass.
            let weight = n.min(RECENT_WINDOW as f64).sqrt();
            recent * weight
        };
        scored.sort_by(|a, b| {
            fitness(b)
                .partial_cmp(&fitness(a))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let elite_n = ((scored.len() as f64) * self.cfg.elite_fraction).ceil() as usize;
        let elite_n = elite_n.max(1).min(scored.len());
        let elite: Vec<ScoredAgent> = scored.iter().take(elite_n).cloned().collect();
        // Full ranked list (elite + non-elite) — we draw from this when
        // a family quota isn't met by the elite alone, so the family
        // doesn't go extinct before getting a fair sample.
        let ranked_all: Vec<ScoredAgent> = scored;

        let mut next: Vec<Box<dyn SwarmAgent>> = Vec::with_capacity(self.cfg.population_cap);
        let mut family_counts: HashMap<RuleFamilyKind, usize> = HashMap::new();

        // 1. Preserve elite unchanged.
        for a in &elite {
            next.push(Box::new(SystematicAgent::new(a.id.clone(), a.params.clone())));
            increment_family(&mut family_counts, a.params.family);
        }

        // 2. Enforce per-family quotas BEFORE generic mutant fill. For
        //    each family that's underfilled, draw the best-ranked
        //    representative from `ranked_all` that isn't already in
        //    `next`; if none exists, spawn a fresh seed agent for the
        //    family. This stops single-family lock-in across many gens.
        for (kind, quota) in self.cfg.family_quotas.clone() {
            while *family_counts.get(&kind).unwrap_or(&0) < quota
                && next.len() < self.cfg.population_cap
            {
                let already: std::collections::HashSet<&str> =
                    next.iter().map(|a| a.id()).collect();
                // Try to pull a survivor of this family from the
                // full ranked list first.
                let import = ranked_all.iter().find(|a| {
                    kind.matches(a.params.family) && !already.contains(a.id.as_str())
                });
                if let Some(survivor) = import {
                    let mutated = self.mutate(&survivor.params);
                    let new_id = self.new_id(&survivor.id);
                    next.push(Box::new(SystematicAgent::new(new_id, mutated)));
                    increment_family(&mut family_counts, kind_to_family(kind));
                    continue;
                }
                // Family went extinct — re-seed from the canonical params.
                let seed = seed_params_for(kind);
                let new_id =
                    format!("gen{}-revive-{}", self.generation, family_label(kind));
                next.push(Box::new(SystematicAgent::new(new_id, seed)));
                increment_family(&mut family_counts, kind_to_family(kind));
            }
        }

        // 3. Fill remainder with **family-balanced** mutants. For each
        //    new slot, pick the family with the smallest current seat
        //    count; tiebreak by alphabetical order so it's deterministic.
        //    Then mutate (or crossover) within that family using its
        //    best-ranked representative as parent.
        //
        //    The earlier implementation drew all parents from `elite`,
        //    which is dominated by whichever family is winning right
        //    now (vol-breakout in trending regimes). Result: every
        //    spare seat became another vol-breakout mutant, the
        //    population converged to one family after a handful of
        //    generations, and other families never got the genetic
        //    search budget needed to find their own optimum. The
        //    leaderboard skew that prompted this fix:
        //
        //        family            seats  total_trades
        //        vol-breakout         12      1813
        //        liq-fade              2        11
        //        liq-trend             2         8
        //
        //    Round-robin across families guarantees each one gets a
        //    fair share of mutation slots; bias within a family still
        //    rewards the local best parent. Falls back to elite parent
        //    selection only when the chosen family has no
        //    representatives at all (extinct mid-run).
        let known_families = [
            RuleFamilyKind::LiqTrend,
            RuleFamilyKind::LiqFade,
            RuleFamilyKind::FundingTrend,
            RuleFamilyKind::FundingArb,
            RuleFamilyKind::VolBreakout,
            RuleFamilyKind::PolyEdge,
        ];
        while next.len() < self.cfg.population_cap && !elite.is_empty() {
            // Pick the family with the fewest seats. Stable order
            // (struct definition order) is the deterministic tiebreak.
            let target = known_families
                .iter()
                .min_by_key(|kind| family_counts.get(kind).copied().unwrap_or(0))
                .copied()
                .unwrap_or(RuleFamilyKind::VolBreakout);

            // Best representative of the target family across the full
            // ranked list (not just elite). Falls back to top-of-elite
            // if the family has no representatives this generation.
            let in_family: Vec<&ScoredAgent> = ranked_all
                .iter()
                .filter(|a| target.matches(a.params.family))
                .collect();
            let parent_a: &ScoredAgent = in_family.first().copied().unwrap_or(&elite[0]);

            let new_id = self.new_id(&parent_a.id);
            let params = if self.coin(self.cfg.crossover_prob) && in_family.len() > 1 {
                // Same-family crossover when the family has ≥2 reps.
                let parent_b = in_family[1];
                self.crossover(&parent_a.params, &parent_b.params)
            } else {
                self.mutate(&parent_a.params)
            };
            next.push(Box::new(SystematicAgent::new(new_id, params)));
            increment_family(&mut family_counts, parent_a.params.family);
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
        // Strip prior gen{N}-mut{n}- ancestry so IDs stay readable across
        // many generations. Without this an agent at gen 30 would carry
        // 30 lineage segments and overflow the leaderboard column.
        format!("gen{}-mut{}-{}", self.generation, n, family_root(parent_id))
    }
}

/// Skip past any leading `gen{N}-mut{n}-` segments to recover the root
/// family identifier (e.g. `liq-fade-v2`). Used so that mutation IDs do
/// not stack ancestry indefinitely.
fn family_root(id: &str) -> &str {
    let mut s = id;
    loop {
        let Some((first, rest)) = s.split_once('-') else {
            return s;
        };
        let is_gen = first.strip_prefix("gen")
            .is_some_and(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_digit()));
        if !is_gen {
            return s;
        }
        let Some((second, after)) = rest.split_once('-') else {
            return s;
        };
        let is_mut = second.strip_prefix("mut")
            .is_some_and(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_digit()));
        if !is_mut {
            return s;
        }
        s = after;
    }
}

fn same_family(a: RuleFamily, b: RuleFamily) -> bool {
    std::mem::discriminant(&a) == std::mem::discriminant(&b)
}

fn family_kind(f: RuleFamily) -> RuleFamilyKind {
    match f {
        RuleFamily::LiqZScore { trend_follow: true } => RuleFamilyKind::LiqTrend,
        RuleFamily::LiqZScore { trend_follow: false } => RuleFamilyKind::LiqFade,
        RuleFamily::FundingZScore { trend_follow: true } => RuleFamilyKind::FundingTrend,
        RuleFamily::FundingZScore { trend_follow: false } => RuleFamilyKind::FundingArb,
        RuleFamily::VolBreakout => RuleFamilyKind::VolBreakout,
        RuleFamily::PolyEdge => RuleFamilyKind::PolyEdge,
    }
}

fn increment_family(counts: &mut HashMap<RuleFamilyKind, usize>, family: RuleFamily) {
    let kind = family_kind(family);
    *counts.entry(kind).or_insert(0) += 1;
}

fn kind_to_family(kind: RuleFamilyKind) -> RuleFamily {
    match kind {
        RuleFamilyKind::LiqTrend => RuleFamily::LiqZScore { trend_follow: true },
        RuleFamilyKind::LiqFade => RuleFamily::LiqZScore { trend_follow: false },
        RuleFamilyKind::FundingTrend => RuleFamily::FundingZScore { trend_follow: true },
        RuleFamilyKind::FundingArb => RuleFamily::FundingZScore { trend_follow: false },
        RuleFamilyKind::VolBreakout => RuleFamily::VolBreakout,
        RuleFamilyKind::PolyEdge => RuleFamily::PolyEdge,
    }
}

fn family_label(kind: RuleFamilyKind) -> &'static str {
    match kind {
        RuleFamilyKind::LiqTrend => "liq-trend",
        RuleFamilyKind::LiqFade => "liq-fade",
        RuleFamilyKind::FundingTrend => "funding-trend",
        RuleFamilyKind::FundingArb => "funding-arb",
        RuleFamilyKind::VolBreakout => "vol-breakout",
        RuleFamilyKind::PolyEdge => "polyedge",
    }
}

/// Canonical seed parameters for a family — used when evolution needs to
/// re-spawn an extinct family to honour the quota. Mirrors what
/// `SystematicParams::*` constructors return so a revived agent starts
/// from a sensible baseline rather than a random param vector.
fn seed_params_for(kind: RuleFamilyKind) -> SystematicParams {
    match kind {
        RuleFamilyKind::LiqTrend => SystematicParams::liq_trend(),
        RuleFamilyKind::LiqFade => SystematicParams::liq_fade(),
        RuleFamilyKind::FundingTrend => SystematicParams::funding_trend(),
        RuleFamilyKind::FundingArb => SystematicParams::funding_arb(),
        RuleFamilyKind::VolBreakout => SystematicParams::vol_breakout(),
        RuleFamilyKind::PolyEdge => SystematicParams::polyedge(),
    }
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

    #[test]
    fn advance_falls_back_when_no_agent_meets_min_decisions() {
        // Empty scoreboard → no agent has any trades → with min_decisions=5
        // the elite filter wipes the pool. Without the fallback, advance()
        // would return an empty Vec and downstream Swarm::new(empty) would
        // silently kill all firing for the rest of the run.
        let sb = Scoreboard::new();
        let mut e = Evolution::new(
            EvolutionCfg {
                population_cap: 5,
                min_decisions: 5,
                ..Default::default()
            },
            7,
        );
        let next = e.advance(make_current(), &sb);
        assert_eq!(next.len(), 5, "fallback returns the original population");
        assert_eq!(e.generation(), 1, "generation counter still bumps");
    }

    #[test]
    fn quotas_keep_every_family_alive_across_many_gens() {
        // Drive a run where vol-breakout has the only decisive edge, so
        // greedy elite selection would normally evict every other family
        // within a generation. Family quotas should keep at least 2
        // representatives of each kind alive even after many generations.
        let sb = Scoreboard::new();
        // 30 closed +1R trades on vol-breakout → it dominates Σ R.
        for i in 0..30 {
            let d = crate::agent::AgentDecision {
                id: format!("vb-{i}"),
                agent_id: "vol-breakout-v0".into(),
                ts: domain::time::EventTs::from_secs(0),
                asset: domain::crypto::Asset::Btc,
                direction: domain::signal::Direction::Long,
                conviction: 80,
                risk_fraction: 0.01,
                horizon_s: 3600,
                rationale: "t".into(),
            };
            sb.record(d);
            sb.mark_outcome(&format!("vb-{i}"), 1.0, 50.0);
        }
        // 10 closed +0.1R trades on liq-trend so it's eligible but boring.
        for i in 0..10 {
            let d = crate::agent::AgentDecision {
                id: format!("lt-{i}"),
                agent_id: "liq-trend-v0".into(),
                ts: domain::time::EventTs::from_secs(0),
                asset: domain::crypto::Asset::Btc,
                direction: domain::signal::Direction::Long,
                conviction: 60,
                risk_fraction: 0.01,
                horizon_s: 3600,
                rationale: "t".into(),
            };
            sb.record(d);
            sb.mark_outcome(&format!("lt-{i}"), 0.1, 1.0);
        }
        let cfg = EvolutionCfg {
            population_cap: 12,
            min_decisions: 5,
            ..Default::default()
        };
        let mut e = Evolution::new(cfg, 99);
        let mut current = make_current();
        // Run 5 generations.
        for _ in 0..5 {
            let next = e.advance(current.clone(), &sb);
            // Map next back to (params, id) pairs for the next round.
            current = next
                .iter()
                .filter_map(|a| a.systematic_params().map(|p| (p, a.id().to_string())))
                .collect();
        }
        // Tally families in the final population.
        let mut by_kind: HashMap<RuleFamilyKind, usize> = HashMap::new();
        for (params, _id) in &current {
            *by_kind.entry(family_kind(params.family)).or_insert(0) += 1;
        }
        for kind in [
            RuleFamilyKind::LiqTrend,
            RuleFamilyKind::LiqFade,
            RuleFamilyKind::FundingTrend,
            RuleFamilyKind::FundingArb,
            RuleFamilyKind::VolBreakout,
        ] {
            let count = by_kind.get(&kind).copied().unwrap_or(0);
            assert!(
                count >= 2,
                "family {} fell below quota after 5 gens: {} agents",
                family_label(kind),
                count
            );
        }
    }

    #[test]
    fn fill_distributes_mutants_across_families_not_just_elite() {
        // Regression for the family-skew bug: when one family has a
        // commanding lifetime R lead, the elite slot is dominated by
        // that family, and the prior step-3 fill drew every spare
        // mutant slot from elite — so the dominant family got 12 of
        // 20 seats while every other family stayed pinned at quota
        // (2). The new round-robin fill should give each known family
        // roughly equal representation in the new generation.
        let sb = Scoreboard::new();
        // Heavy lifetime R for vol-breakout-v0.
        for i in 0..50 {
            let d = crate::agent::AgentDecision {
                id: format!("vb-{i}"),
                agent_id: "vol-breakout-v0".into(),
                ts: domain::time::EventTs::from_secs(0),
                asset: domain::crypto::Asset::Btc,
                direction: domain::signal::Direction::Long,
                conviction: 80,
                risk_fraction: 0.01,
                horizon_s: 3600,
                rationale: "t".into(),
            };
            sb.record(d);
            sb.mark_outcome(&format!("vb-{i}"), 2.0, 100.0);
        }
        // Modest history on every other family — eligible (≥5
        // decisions) but unimpressive.
        for (agent, prefix) in [
            ("liq-trend-v0", "lt"),
            ("liq-fade-v0", "lf"),
            ("funding-trend-v0", "ft"),
            ("funding-arb-v0", "fa"),
            ("polyedge-v0", "pe"),
        ] {
            for i in 0..6 {
                let id = format!("{prefix}-{i}");
                let d = crate::agent::AgentDecision {
                    id: id.clone(),
                    agent_id: agent.into(),
                    ts: domain::time::EventTs::from_secs(0),
                    asset: domain::crypto::Asset::Btc,
                    direction: domain::signal::Direction::Long,
                    conviction: 60,
                    risk_fraction: 0.01,
                    horizon_s: 3600,
                    rationale: "t".into(),
                };
                sb.record(d);
                sb.mark_outcome(&id, 0.05, 0.5);
            }
        }
        let cfg = EvolutionCfg {
            population_cap: 18,
            min_decisions: 5,
            ..Default::default()
        };
        let mut e = Evolution::new(cfg, 7);
        let current = vec![
            (SystematicParams::vol_breakout(), "vol-breakout-v0".to_string()),
            (SystematicParams::liq_trend(), "liq-trend-v0".to_string()),
            (SystematicParams::liq_fade(), "liq-fade-v0".to_string()),
            (SystematicParams::funding_trend(), "funding-trend-v0".to_string()),
            (SystematicParams::funding_arb(), "funding-arb-v0".to_string()),
            (SystematicParams::polyedge(), "polyedge-v0".to_string()),
        ];
        let next = e.advance(current, &sb);
        let mut by_kind: HashMap<RuleFamilyKind, usize> = HashMap::new();
        for a in &next {
            if let Some(p) = a.systematic_params() {
                *by_kind.entry(family_kind(p.family)).or_insert(0) += 1;
            }
        }
        // With cap=18 and 6 known families, round-robin fill should
        // give each family roughly 3 seats. We assert ≥3 to catch the
        // regression: under the old logic vol-breakout would have
        // claimed 12+ seats and at least one other family would sit
        // at the bare quota of 2.
        for kind in [
            RuleFamilyKind::LiqTrend,
            RuleFamilyKind::LiqFade,
            RuleFamilyKind::FundingTrend,
            RuleFamilyKind::FundingArb,
            RuleFamilyKind::VolBreakout,
            RuleFamilyKind::PolyEdge,
        ] {
            let count = by_kind.get(&kind).copied().unwrap_or(0);
            assert!(
                count >= 3,
                "family {} got only {} seats — round-robin fill regressed",
                family_label(kind),
                count
            );
        }
    }

    #[test]
    fn family_root_strips_nested_lineage() {
        assert_eq!(family_root("liq-trend-v0"), "liq-trend-v0");
        assert_eq!(family_root("gen1-mut2-liq-trend-v0"), "liq-trend-v0");
        assert_eq!(
            family_root("gen11-mut115-gen7-mut74-gen6-mut61-liq-fade-v2"),
            "liq-fade-v2"
        );
        // Don't strip non-numeric pseudo-prefixes.
        assert_eq!(family_root("genome-mutation-blah"), "genome-mutation-blah");
    }
}
