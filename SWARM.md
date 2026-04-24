# Swarm — trade discovery via tournament of agents

Pythia's core discovery mechanism.

> **Core idea:** rather than hand-pick one strategy and hope, instantiate a
> heterogeneous *population* of simulated traders, feed them all the same
> real-time event stream, rank them by realised PnL, and route the
> **current champion's** decisions to the live executor. As the regime
> shifts, a different agent rises to the top and the executor follows.

Code lives in [`crates/swarm/`](crates/swarm/).

## Flow

```
  Event (Liquidation / Candle / Funding / OI / HourClose)
            │
            ▼
     Swarm::broadcast(event)
        │     │     │
        ▼     ▼     ▼
      Agent₁ Agent₂ … Agent_N        PeerView shared across all
        │     │     │
        └──┬──┴─────┘
           │
           ▼  Vec<AgentDecision>
    Scoreboard.record()
           │            ≤ horizon later, once outcome known
           ▼
    Scoreboard.mark_outcome(decision_id, r_multiple, pnl_usd)
           │
           ▼
    Scoreboard.champion()      → agent_id of the leader
           │
           ▼
    if champion emitted a decision this event:
        Executor ──▶ Hyperliquid REST (EIP-712 signed order)
           │
           └──(every N events) ──▶  Evolution.advance()
                                          │
                                          └──▶ new population
```

`consensus()` is still computed and exported to the snapshot for
diagnostics, but the default live path is **champion-driven**.

## Agent taxonomy

### `SystematicAgent`

Wraps a parameterised rule family. Five families ship:

| Family | Signal | Trade direction |
|---|---|---|
| `LiqZScore { trend: true }` | hourly net-liquidation z > 2.5 σ | with the cascade |
| `LiqZScore { trend: false }` | same trigger | against the cascade |
| `FundingZScore { trend: true }` | funding z > 2 σ | with funding sign |
| `FundingZScore { trend: false }` | same trigger | against funding sign |
| `VolBreakout` | Donchian-24 breakout, ATR% in band | breakout direction |

Parameters that vary across agents: `z_threshold`, `z_window`,
`cooldown_bars`, `horizon_hours`, `risk_fraction`, `donchian_bars`,
`atr_pct_min`. `SystematicBuilder::house_roster()` instantiates 20
diverse starting points.

### `LlmAgent`

Per-event context assembled into a short prompt, sent to an LLM with
tool-use forcing structured output. Five personality presets:

```rust
Personality::cautious()       // low risk, long horizons, rare trades
Personality::momentum()       // fast horizon, rides trends hard
Personality::contrarian()     // mean-revert bias, fades extremes
Personality::degen()          // max risk, overrides cooldowns
Personality::macro_ranger()   // skips individual bars, looks at regime
```

Throttled: only calls the LLM every `N` events to keep tokens finite.
The `MockLlmDecider` is hash-based and deterministic for tests + offline
runs; `AnthropicDecider` uses Anthropic tool-use when
`ANTHROPIC_API_KEY` is set.

### `MomentumFollower` / `Contrarian` (meta)

Don't watch raw events — watch `PeerView`. Amplify or fade whatever
fraction of peers are currently long. A social-influence layer that
matters when a few strong agents converge.

## Peer influence

Every broadcast computes a rolling `PeerView`:

```rust
pub struct PeerView {
    pub recent: Vec<AgentDecision>,   // last 64 decisions
    pub long_fraction: f64,           // 0.0 .. 1.0
    pub champion_agreement: f64,      // fraction agreeing with champion
}
```

Non-social agents ignore it. Social agents weight it directly. Cost is
one VecDeque push per broadcast — negligible.

## Scoring

`Scoreboard` maintains per-agent:

```rust
pub struct AgentStats {
    agent_id: String,
    total_decisions: usize,
    wins: usize, losses: usize,
    total_r: f64,           // sum of R-multiples
    total_pnl_usd: f64,
    rolling_sharpe: f64,    // rolling last N closed decisions
    win_rate: f64,
    last_r: f64,
    active: bool,
}
```

`Scoreboard::top_n(k, min_decisions)` and
`Scoreboard::champion(min_decisions)` expose the oracle the executor
and evolution both read.

## Executor routing

Each event, after `Swarm::broadcast()` returns the slate of
`AgentDecision`s:

```rust
let champion = scoreboard.champion(min_decisions_for_champion);
if let Some(champ) = champion {
    if let Some(d) = decisions.iter().find(|d| d.agent_id == champ.agent_id) {
        // Champion emitted a decision this event — apply it.
        executor.place(d).await?;
    }
}
```

One agent drives trading at a time. If the champion passes on this
event, no trade. If a different agent climbs the scoreboard, the
executor follows it smoothly — no config change, no restart.

## Consensus (diagnostic)

`consensus()` runs on every event and is reported in the snapshot /
UI, but it no longer drives execution. Useful for:

- visualising how much the top-K agree (filaments in the 3D arena)
- catching regimes where the champion is a statistical fluke
- optional alternative firing rule for research

```rust
let cfg = ConsensusCfg {
    top_k: 5,
    min_decisions_for_champion: 3,  // ignore newbies with < 3 decisions
    champion_agreement: 0.6,        // 60 % of champions must agree
    min_agent_count: 3,             // at least 3 agents vote this event
    overall_agreement: 0.5,         // > 50 % overall tilt
};
let diagnostic = consensus(&decisions, &scoreboard, &cfg);
```

## Evolution — the self-improvement loop

Every `PYTHIA_EVOLVE_EVERY` events (default 500) in the live binary:

```rust
let current: Vec<(SystematicParams, String)> = swarm
    .agents()
    .filter_map(|a| a.systematic_params().map(|p| (p, a.id().into())))
    .collect();
let next = evolution.advance(current, &scoreboard);
swarm = Swarm::new(next);
```

What happens inside `advance()`:

1. Score every current agent via the scoreboard — uses the realised
   PnL from decisions that have already closed.
2. Retain the top `elite_fraction` (default 0.5) verbatim.
3. Fill the rest via:
   - **rank-weighted parent selection** — index 0 has 2× the odds of the
     last-ranked elite
   - **log-space Gaussian mutation** — `param · exp(N(0, σ)·σ_mut)` then
     clamped to family bounds; `σ_mut = 0.15` default
   - **same-family crossover** (prob 0.3) — never blend LiqZScore params
     with FundingZScore
4. Evicted agents' decisions stay recorded in the scoreboard (history
   is never lost), they just stop firing.

Result: the population drifts toward parameter regions that are
actually paying out on the live feed. The feedback loop is
**scoreboard → evolution → new agents → broadcast → scoreboard**. No
LLM in the critical path; PnL is the only signal. Context stays O(1)
because the scoreboard holds aggregate stats, not per-decision
history.

Slow monotone improvement, not population collapse — the elite are
preserved verbatim and mutation sigmas are conservative by default.

## Backtest result (reference)

365 days of Binance BTC + ETH perps (69,026 events) replayed through 20
agents in **0.7 s wall** on an M-series Mac.

Top 5 by total R:

| # | Agent | Trades | Win % | Σ R | PnL$ |
|---|---|---|---|---|---|
| 1 | `vol-breakout-v2` | 467 | 45.0 | +74.52 | +373 |
| 2 | `liq-trend-v0` | 671 | 48.6 | +74.46 | +372 |
| 3 | `liq-trend-conservative` | 577 | 48.9 | +66.86 | +167 |
| 4 | `liq-trend-aggressive` | 577 | 48.9 | +66.86 | +501 |
| 5 | `liq-trend-degen` | 577 | 48.9 | +66.86 | +1003 |

Naïve consensus voting fired 751× with 49 % directional wins (coin-flip)
— confirming that the **value of the swarm is picking the champion**,
not averaging votes. The live executor routes the champion's own
decisions; consensus is kept only as a diagnostic.

## Sizing + uncertainty filter — ideas from PolySwarm (arXiv 2604.03888)

Two concrete techniques from Barot & Borkhatariya's *PolySwarm:
Multi-Agent LLM Framework for Prediction Market Trading* are
integrated as opt-in executor behaviours, exposed via the
`/tournament` settings form (which writes `data/swarm-config.json`):

- **Quarter-Kelly sizing (§III.E).** When `kelly_enabled = true`,
  position notional is `0.25 × ((p·b − q) / b) × equity` where
  `p = conviction / 100`, `b = TP_mult / SL_mult = 2.0`, `q = 1 − p`.
  Falls back to ATR-risk sizing otherwise. Clamped by `position_cap_mult`.
- **Uncertainty filter (§III.D).** Before firing, the executor
  computes the fraction of top-K agents (on the same asset this
  event) whose direction *differs* from the champion's. If that
  dissent exceeds `uncertainty_filter` (default 0.4), the trade is
  skipped. Stateless, cheap, and prevents trading against a
  divided swarm.

Not integrated (yet): KL/JS divergence between swarm and market
distributions, cross-market consistency checks. Those require a
probability-distribution output from agents that the current
`AgentDecision` (direction + conviction) doesn't expose directly.

Full report: [reports/swarm/1777015617/swarm.md](reports/swarm/1777015617/swarm.md)

## Underlying-strategy validation

Independent grid-search on the same year confirms the systematic families
the swarm builds on are profitable in isolation:

| Variant | $1k → $? (365 d) | Max DD | Sharpe | Trades |
|---|---|---|---|---|
| `liq-trend@1 %/compound·BTC+ETH` | $64k | 3.1 % | 0.43 | 578 |
| `liq-trend@2 %/compound·BTC+ETH` | $3.6M | 8.8 % | 0.29 | 578 |
| `ensemble-trend@1 %/compound·BTC+ETH` | $49k | 3.9 % | 0.34 | 613 |
| `vol-breakout@1 %/compound·BTC+ETH` | $37k | 3.7 % | 0.44 | 410 |

Read those **probabilistically**. The 2025–2026 BTC/ETH regime was
trending — trend variants dominate fade variants on this sample.
Regime shift (2018/2023-style mean-reversion) and the ranking will
invert. That's exactly what evolution + the meta-agents are there to
detect.

## Running it

```sh
# 1. full swarm backtest on scraped data → reports/swarm/<ts>/swarm.md
cargo run --release -p swarm --bin swarm-backtest

# 2. live daemon — Binance WS → swarm → champion → executor → HL REST
#    writes data/swarm-snapshot.json every 10 s for the UI
cargo run --release -p live-executor --bin pythia-swarm-live

# 3. unit tests (broadcast, scoring, evolution, LLM mock, consensus)
cargo test -p swarm
```

### UI — `/tournament`

```sh
cd apps/web && npm install && npm run dev
# open http://localhost:3000/tournament
```

A 3D arena renders all 20 agents simultaneously:

- size ∝ `|total_r|`, colour by rule family (liq-trend green,
  liq-fade red, vol-breakout amber, funding-trend blue,
  funding-arb purple)
- champion sits on a centre pedestal with a rotating halo + light beam
- top-5 connected by faint cyan filaments (the elite cluster)
- positions lerp smoothly when ranks reshuffle — evolution visualised

Falls back to a deterministic demo snapshot when the daemon isn't
running, so the page renders standalone.

## Extending

New systematic rule family → add a variant to `RuleFamily` in
`systematic.rs`, implement its evaluator, add a constructor to
`SystematicBuilder`. Done.

New LLM persona → push a new `Personality` preset into
`llm_agent::Personality` and into the default roster.

New meta-behaviour (e.g. regime-aware contrarian) → implement
`SwarmAgent` directly with whatever logic it needs. The trait is one
method.

```rust
#[async_trait]
pub trait SwarmAgent: Send + Sync {
    fn profile(&self) -> &AgentProfile;
    async fn observe(&mut self, event: &Event, peers: &PeerView) -> Option<AgentDecision>;
}
```

That's it. Zero friction to experiment.
