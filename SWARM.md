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

## PeerView — social influence *inside* one event

**Short answer to "does the swarm see each other?": yes, in two ways —
`PeerView` happens *during* an event; `Evolution` happens *across*
events.**

Every broadcast computes a rolling `PeerView`:

```rust
pub struct PeerView {
    pub recent: Vec<AgentDecision>,   // last 64 decisions
    pub long_fraction: f64,           // 0.0 .. 1.0
    pub champion_agreement: f64,      // fraction agreeing with champion
}
```

Non-social agents ignore it. Social agents weight it directly — the
`MomentumFollower` amplifies the dominant side, the `Contrarian` fades
it, and LLM personas are explicitly told in their prompt what the
peers/champion just did so they can account for it. Cost is one
VecDeque push per broadcast — negligible.

**What PeerView changes in practice:** when a liquidation cascade
fires and 12 of 27 agents go long, a momentum-follower amplifies
long exposure; a contrarian-fader inverts it. Over time the
scoreboard sorts out which peer-reading behaviour was right in this
regime — and that winner becomes the champion.

## Evolution — persistent improvement *across* events

Every `PYTHIA_EVOLVE_EVERY` events (default 500 ≈ a couple of trading
hours of live liquidations):

1. **Score** every current systematic agent by **fitness =
   `recent_expectancy_r × √n_recent`** — average R per trade over
   the last 50 closed trades, weighted by sample-size (capped at
   √50). This is a t-statistic-shaped metric: long-history seeds
   with high *average* trade R still win, but a fresh mutant with a
   small consistently-winning sample gets a real shot at the elite
   slot. Earlier versions ranked by **lifetime cumulative R**, which
   meant a long-running seed agent had unbeatable accumulated R
   simply by virtue of having lived through more generations — its
   elite slot was permanently locked, the swarm visibly stopped
   evolving, and the leaderboard filled with mutants that never
   rotated in. Fitness ranking fixes that.
2. **Keep the elite** — top `elite_fraction` (default 0.5) carry
   forward unchanged. No innovation loss.
3. **Rank-weighted parent selection** — pick two elite as parents,
   top rank has 2× the pick probability of the bottom rank.
4. **Log-space Gaussian mutation** — each continuous parameter
   (`z_threshold`, `risk_fraction`, `horizon_hours`, `donchian_bars`,
   `atr_pct_min`) gets `param · exp(N(0, σ_mut)·σ)` with `σ_mut = 0.15`
   default, then clamped to family-safe bounds.
5. **Same-family crossover** (prob 0.3) — blend two parents' params
   within the same `RuleFamily`. Never crosses `LiqZScore` with
   `FundingZScore` — different signal types wouldn't produce a
   coherent hybrid.
6. **Evicted agents** keep their history in the scoreboard (so the
   UI can still show what they did) but stop firing.

The result is a **self-improving quant floor**: each agent is its
own systematic or LLM persona, they compete concurrently on the same event (each `observe()` future runs in parallel via `futures::join_all`, so LLM network calls overlap), PnL selects
winners, mutation + crossover produce the next generation, and the
cycle repeats. No LLM judge in this loop — PnL *is* the judge.

## How the whole feedback loop closes

```
  Kiyotaka REST + WS ─ candles / funding / OI ─┐
                       liquidations              │
                       Polymarket SWP-mid lead   │
                                                 ├──▶ swarm::Event
  Local replay (warehouse, dev only) ────────────┘
                                 │
                                 ▼
                    Swarm::broadcast(event)
                                 │
                                 ├──▶ each agent decides (PeerView-aware)
                                 │
                                 ▼
                    Scoreboard.record(decision)
                                 │            ≤ horizon later, outcome known
                                 ▼
                 Scoreboard.mark_outcome(r, pnl)  ◀── realised PnL
                                 │                      feeds back in
                                 ▼
                    Scoreboard.champion()
                                 │
                                 ├──▶ Executor trades the champion's signal
                                 │    (Hyperliquid REST, EIP-712)
                                 │
                                 └──▶ every N events: Evolution.advance()
                                              │
                                              └─ swap out weak agents
                                                 for mutated + crossed elite
```

The loop closes at the scoreboard: every realised R flows *back*
into `mark_outcome`, which updates ranking, which changes who is
champion, which changes what the executor trades on the next event.
Separately, every N events the population mutates toward
parameter regions the scoreboard says are paying out. Over time, the
swarm *becomes* the strategy the current regime rewards.

## Local replay — the time machine

`store::Store` is an embedded warehouse at `data/pythia.duckdb` populated
exclusively from Kiyotaka REST endpoints (24 MB scraped) with four
tables per asset:

| Table | Source | Granularity |
|-------|--------|-------------|
| `candles` | Kiyotaka REST `/v1/points` (TRADE_SIDE_AGNOSTIC_AGG) | hourly OHLCV |
| `funding` | Kiyotaka REST `/v1/points` (FUNDING_RATE_AGG) | hourly |
| `open_interest` | Kiyotaka REST `/v1/points` (OPEN_INTEREST_AGG) | hourly |
| `liquidations` | Kiyotaka REST `/v1/points` (ASYMMETRIC_LIQ_USD_AGG) | 1-hour bucket |

Every row has both an **event timestamp** (when the thing happened in
the market) and an **asof timestamp** (when we ingested it) — so
backfilled data can coexist with live data without contaminating
walk-forward tests.

### Three places replay is used

1. **`swarm-backtest` binary** — reads all 365 days, interleaves the
   four event streams by timestamp, and pumps them through the swarm
   at full speed (69,026 events in 0.7 s wall). This is how the
   scoreboard you see in `/tournament` gets seeded: every agent
   already has hundreds of real-data trades before the live daemon
   even starts.
2. **Walk-forward CV in `backtest`** — replays rolling training /
   test splits to compute PBO and out-of-sample Sharpe CIs.
3. **`pythia-swarm-live` warm-start** (planned) — replay the last
   48 h of DuckDB data through a fresh swarm so new agents have
   *some* scoreboard history before their first live decision,
   instead of firing blind.

The same `swarm::Event` type is produced whether the source is
Kiyotaka WS (live) and Kiyotaka REST (historical scrape) — both stored in the local
(replay). Agents can't tell the difference — which is exactly what
makes the backtest honest.

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

## Consensus and the new ensemble router

The original Rust `consensus()` is **equal-weight majority voting**
across all firing agents. On 365 days of replayed data it fired 751×
with **49 % directional wins (coin-flip)** — averaging 27 votes
destroys signal because weak agents drown the strong. That's why the
live executor is champion-driven rather than consensus-driven.

The Vercel UI ships a smarter alternative in
[`apps/web/lib/router.ts`](apps/web/lib/router.ts):

1. **Per-event-kind specialist** — pick the highest-Sharpe agent in
   the family preferred for *this* event kind. Polymarket leads → polyedge,
   liq cascades → liq-trend, funding spikes → funding-trend, etc.
2. **Sharpe-weighted ensemble vote** across the agents that fired, not
   equal-weight. Negative-Sharpe agents barely vote; positive-Sharpe
   agents dominate. Trade only when conviction > 0.25.
3. **Quarter-Kelly** sizing on the specialist's profit factor.

This is what the `/tournament` page actually executes today. The Rust
`consensus()` is preserved as a diagnostic counter (it still fires per
event so backtests can compare champion-vs-consensus PnL) but does not
drive execution. The next-pass migration is to expose
`Scoreboard::champion_for_kind()` + `weighted_vote()` from Rust so the
live executor uses the same router.

## Portfolio meta-agent — exits + position management

The router decides *who to follow* on a fresh event; the **portfolio
meta-agent** decides *how to manage* what gets opened. Without it, an
autopilot session piles up correlated entries (one per event), every
position uses the same fixed stop/TP, and the swarm changing its mind
on an asset never closes existing exposure. The meta-agent is the
"smart copy-trader on top of the copy-trader" the user actually sees
on the Hyperliquid panel.

It lives in [`apps/web/lib/portfolio.ts`](apps/web/lib/portfolio.ts)
and exposes three pure functions, orchestrated by `TournamentClient`:

| Step | Function | When it runs | What it returns |
|---|---|---|---|
| Entry | `decideEntry` | on each fresh router decision | `skip` / `open` / `reverse` (with the id to close first) |
| Mark sweep | `manageOnMark` | on every Kiyotaka mark refresh (~6 s) | per-position `peak` + trail-stop adjustments + `time` closes |
| Event sweep | `manageOnEvent` | on each fresh event, *before* `decideEntry` | ids of open positions to close because the swarm just voted opposite at high conviction |

### Rules implemented

- **One position per (asset, side).** If a long-BTC is already open,
  a fresh long-BTC signal is skipped. Pyramiding is intentionally not
  enabled — preference is to size correctly on entry, not double down.
- **Reversal close.** A fresh signal opposite an existing position on
  the same asset closes the existing position first, then opens the
  new one with full size. The closed position carries the
  `close_reason: "reverse"` chip in the panel.
- **Conviction floor on entry.** New entries below `min_conviction`
  (default 30 %) are skipped entirely — split votes are noise.
- **Global cap.** `max_open_positions` (default 8) hard-limits open
  exposure regardless of agent activity.
- **Trailing stop.** Once unrealized R clears `trail_after_r`
  (default 1 R), the stop ratchets to break-even. At 2× the threshold
  it trails the high-water mark by 1 R. Closes the position with the
  `trail` chip when hit. Set `trail_after_r = 0` to disable.
- **Time stop.** Positions older than `time_stop_hours` (default 12 h)
  force-exit at the current mark with the `time` chip. Stops paper
  sessions from carrying stale entries forever. Set to 0 to disable.
- **Swarm-flip exit.** On every fresh event, if the ensemble votes
  *opposite* an existing position with conviction ≥
  `swarm_flip_conviction` (default 40 %), close immediately with the
  `swarm-flip` chip. This is the "follow the swarm out as well as in"
  rule — the trader is a meta-agent over the swarm, not a one-shot
  signal-follower.

All five thresholds are user-configurable in the
[Settings panel → Exit rules · meta-agent](apps/web/components/tournament/SettingsForm.tsx)
and persist via `/api/config` (or fall back to `localStorage` on
read-only Vercel).

### Why this lives in TS, not Rust

The meta-agent is *paper-side state*: it manages the user's session
ledger in the browser, separate from the Rust scoreboard which manages
agent stats. Once `pythia-swarm-live` is wired to a real Hyperliquid
key, the same five rules ship to the live executor as
`crates/portfolio/src/meta.rs` — the contracts are identical. Until
then the TS path is the source of truth so users can tune knobs and
see the effect on session PnL without redeploying Rust.

```rust
// Diagnostic only — surfaced in the snapshot for research, not execution.
let cfg = ConsensusCfg {
    top_k: 5,
    min_decisions_for_champion: 3,
    champion_agreement: 0.6,
    min_agent_count: 3,
    overall_agreement: 0.5,
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

365 days of Kiyotaka BTC + ETH perp data (69,026 events) replayed through 27
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

# 2. live daemon — Kiyotaka WS+REST → swarm → champion → executor → HL REST
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

A 3D arena renders all 27 agents simultaneously:

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
