import {
  agentFamily,
  type AgentFam,
  type AgentStats,
} from "@/lib/swarm";
import type { SimEvent, SimEventKind, SimReaction } from "@/lib/simulate";

/**
 * Trade-selection router.
 *
 * The global Σ R-champion is a fragile policy: vol-breakout-v0 dominates
 * the historical ranking but abstains on Polymarket leadership signals,
 * so a vol-breakout-only copy-trader misses every PM event the swarm
 * would otherwise have caught. The router below replaces that policy
 * with two layered decisions:
 *
 *   1. Per-event-kind specialist — for a given event kind we pick the
 *      *best agent on that kind*. Polymarket leads route to polyedge,
 *      liquidation cascades route to liq-trend, etc. Each family has a
 *      historical edge specific to its signal type, and treating one
 *      generalist as the oracle throws away that information.
 *
 *   2. Sharpe-weighted ensemble vote — among the agents that DID react
 *      to this event, weight each by their historical Sharpe (clipped),
 *      sum the weighted votes, and only fire if the leading direction
 *      crosses a confidence threshold. Adapts the PolySwarm Bayesian
 *      aggregation idea (p = 0.7·swarm + 0.3·market) to a finite-asset
 *      scoreboard. Solo-fired events still trade but at a smaller
 *      conviction; split events skip rather than chasing whichever
 *      agent fired loudest.
 *
 * Quarter-Kelly position sizing then scales the dollar notional by the
 * specialist's empirical profit factor on this kind. The chosen
 * direction is the ensemble's, not the specialist's — even the
 * specialist can be voted down by the rest.
 */

/** Best-suited family for each event kind. Used as a prior so the
 *  specialist picker doesn't pick a bad-but-lucky outlier from a wrong
 *  family. */
const KIND_TO_FAMILY: Record<SimEventKind, AgentFam[]> = {
  "liq-spike": ["liq-trend", "liq-fade", "polyfusion", "llm"],
  "funding-spike": ["funding-trend", "funding-arb", "polyfusion", "llm"],
  "vol-breakout": ["vol-breakout", "polyfusion", "llm"],
  "polymarket-lead": ["polyedge", "polyfusion", "llm"],
  fusion: ["polyfusion", "vol-breakout", "liq-trend", "polyedge", "llm"],
};

/** Sharpe → vote-weight transform. Clip to [-2, 2], shift to [0, 4],
 *  then softmax-light. Negative-Sharpe agents barely vote. */
function sharpeWeight(sharpe: number): number {
  const clipped = Math.max(-2, Math.min(2, sharpe));
  return Math.max(0.05, clipped + 2);
}

/** Pick the specialist for an event kind. Among agents whose family
 *  matches the kind's preferred families, take the highest Sharpe with
 *  ≥10 decisions. Falls back to global Σ R champion if no eligible
 *  specialist exists yet (e.g. fresh swarm). */
export function pickSpecialist(
  kind: SimEventKind,
  agents: AgentStats[],
): AgentStats | null {
  if (agents.length === 0) return null;
  const preferredFamilies = KIND_TO_FAMILY[kind] ?? [];
  // Try preferred families in order; first non-empty pool wins.
  for (const fam of preferredFamilies) {
    const pool = agents
      .filter((a) => agentFamily(a.agent_id) === fam && a.total_decisions >= 10)
      .sort((a, b) => b.rolling_sharpe - a.rolling_sharpe);
    if (pool.length > 0) return pool[0];
  }
  // Fallback: global champion by Σ R.
  return [...agents].sort((a, b) => b.total_r - a.total_r)[0] ?? null;
}

export type EnsembleVote = {
  /** "long" / "short" / "flat" — flat means below confidence threshold. */
  direction: "long" | "short" | "flat";
  /** [-1, +1]. Positive = long-leaning, sign + magnitude. */
  conviction: number;
  weight_long: number;
  weight_short: number;
  fired_count: number;
  /** Each individual agent's contribution, sorted by absolute weight. */
  contributions: Array<{
    agent_id: string;
    direction: "long" | "short";
    weight: number;
    family: AgentFam;
  }>;
};

const MIN_CONVICTION = 0.25;

/** Sharpe-weighted vote across all *fired* agents. Returns the ensemble
 *  direction + a normalised conviction in [-1, 1]; if |conviction| <
 *  MIN_CONVICTION we return "flat" so the copy-trader sits the event
 *  out instead of trading on disagreement. */
export function weightedVote(
  reactions: SimReaction[],
  agents: AgentStats[],
): EnsembleVote {
  const statsById = new Map(agents.map((a) => [a.agent_id, a]));
  let weight_long = 0;
  let weight_short = 0;
  const contributions: EnsembleVote["contributions"] = [];
  let fired = 0;

  for (const r of reactions) {
    if (!r.reacted) continue;
    fired += 1;
    const stats = statsById.get(r.agent_id);
    const sharpe = stats?.rolling_sharpe ?? 0;
    const w = sharpeWeight(sharpe);
    if (r.direction === "long") weight_long += w;
    else weight_short += w;
    contributions.push({
      agent_id: r.agent_id,
      direction: r.direction,
      weight: w,
      family: agentFamily(r.agent_id),
    });
  }

  contributions.sort((a, b) => b.weight - a.weight);

  const total = weight_long + weight_short;
  if (total === 0 || fired === 0) {
    return {
      direction: "flat",
      conviction: 0,
      weight_long: 0,
      weight_short: 0,
      fired_count: 0,
      contributions: [],
    };
  }
  // Normalised conviction in [-1, 1]. Positive = long-leaning.
  const conviction = (weight_long - weight_short) / total;
  const direction =
    Math.abs(conviction) < MIN_CONVICTION
      ? "flat"
      : conviction > 0
        ? "long"
        : "short";

  return {
    direction,
    conviction,
    weight_long,
    weight_short,
    fired_count: fired,
    contributions,
  };
}

export type RouteDecision = {
  event: SimEvent;
  specialist: AgentStats | null;
  vote: EnsembleVote;
  /** Final decision: trade direction + size factor. `null` direction =
   *  copy-trader sits this event out (too few agents fired, or no
   *  consensus). */
  decision: {
    direction: "long" | "short" | null;
    /** [0, 1] — fraction of the user's risk-budget to deploy on this
     *  trade. Combines ensemble conviction × specialist profit-factor
     *  edge × event magnitude. Quarter-Kelly heavy when the math says
     *  edge, near zero when the math is shaky. */
    size_factor: number;
    /** Human-readable explanation we render in the trade feed. */
    rationale: string;
  };
};

/** Main entry point. Combines specialist + ensemble vote + Kelly sizing.
 *  This is what `onFire` calls instead of "follow champion". */
export function routeTrade(
  event: SimEvent,
  reactions: SimReaction[],
  agents: AgentStats[],
): RouteDecision {
  const specialist = pickSpecialist(event.kind, agents);
  const vote = weightedVote(reactions, agents);

  // Specialist abstaining + ensemble flat → no trade.
  if (vote.direction === "flat") {
    return {
      event,
      specialist,
      vote,
      decision: {
        direction: null,
        size_factor: 0,
        rationale:
          vote.fired_count === 0
            ? "no agents fired — sit this one out"
            : `split vote (${vote.contributions.length} agents) — conviction ${vote.conviction.toFixed(2)} below ${MIN_CONVICTION} floor`,
      },
    };
  }

  // Quarter-Kelly-ish sizing. Map specialist's profit factor to a Kelly
  // fraction (PF=2 → ~25% of risk-budget; PF=1 → 0; PF→∞ caps at 100%).
  const pf = specialist?.profit_factor ?? 1;
  const kellyFrac = pf > 1 ? Math.min(1.0, 0.25 * Math.log2(pf) * 2) : 0;
  // Conviction-weight the size further so 0.3 conviction trades smaller
  // than 0.9 conviction even with the same specialist PF.
  const size_factor = Math.max(0, Math.min(1, kellyFrac * Math.abs(vote.conviction)));

  const specialistShort = specialist
    ? specialist.agent_id.replace(/^gen\d+-mut\d+-/, "")
    : "—";
  const direction: "long" | "short" = vote.direction;
  const rationale = `${specialistShort} specialist · ${vote.fired_count}/${reactions.length} fired · ${direction.toUpperCase()} conviction ${vote.conviction.toFixed(2)}`;

  return {
    event,
    specialist,
    vote,
    decision: {
      direction,
      size_factor,
      rationale,
    },
  };
}
