# Pythia architecture

Six composable layers. A single event flows left-to-right; the loop closes
every `N` events via evolution.

```
 ┌───────────────────────────────────────────────────────────────────────┐
 │ 1. DATA                                                                │
 │    Binance public WS  ─┐                                               │
 │    Kiyotaka REST      ─┼──▶ unified Event ──▶ broadcast Bus            │
 │    DuckDB replay      ─┘                                               │
 ├───────────────────────────────────────────────────────────────────────┤
 │ 2. REGIME          Trending / Ranging / Chaotic / Calm classifier      │
 ├───────────────────────────────────────────────────────────────────────┤
 │ 3. SWARM           20+ heterogeneous agents observe every event        │
 │                      · SystematicAgent (rule families + params)        │
 │                      · LlmAgent (5 personality presets, throttled)     │
 │                      · MomentumFollower / Contrarian meta-agents       │
 │                      PeerView lets agents read recent peer decisions.  │
 ├───────────────────────────────────────────────────────────────────────┤
 │ 4. SCOREBOARD      per-agent rolling Sharpe + total-R + Bayesian skill │
 ├───────────────────────────────────────────────────────────────────────┤
 │ 5. CONSENSUS       majority-of-top-K champions → directional signal    │
 ├───────────────────────────────────────────────────────────────────────┤
 │ 6. EXECUTION       Hyperliquid EIP-712 REST + per-trade risk guard     │
 └───────────────────────────────────────────────────────────────────────┘
             ▲                                              │
             │                                              │
             │                                   every N events
             │                                              ▼
       new/mutated                                   EVOLUTION
         agents ◀──  elite preserve + crossover + log-Gaussian mutate
```

## Why each layer exists

### 1. Data — pluggable sources

Adding a new feed means one struct:

```rust
#[async_trait]
impl DataSource for DeribitSkew {
    fn id(&self) -> &'static str { "deribit-skew" }
    async fn subscribe(&self, tx: Sender<Event>) { ... }
    async fn backfill(&self, from: i64, to: i64) -> Vec<Event> { ... }
}
```

The `Bus` fan-outs to every subscriber (swarm, regime, tuner). Zero
coupling.

Production uses **Binance public `!forceOrder@arr` WS** for the
liquidation stream — no auth, same fidelity as the paid Kiyotaka WS feed
(which proved tier-gated in practice) — plus **Kiyotaka REST** for
funding / OI / candles.

### 2. Regime — the meta-context agents consume

`regime::classify(window) → Trending | Ranging | Chaotic | Calm`. Inputs
are ADX-proxy, Donchian width, realised vol percentiles over rolling
windows. Swarm agents don't see the regime directly — the portfolio
allocator does, so each regime tilts which top-K agents get promoted to
the consensus.

### 3. Swarm — the discovery engine

See [SWARM.md](SWARM.md) for full agent taxonomy. In one sentence: 20+
agents with different parameters, rule families, risk fractions,
horizons, and personas all see every event; each emits a decision or
abstains; the population is the unit of intelligence, not any single
agent.

### 4. Scoreboard

`Scoreboard::record(decision)` then later `mark_outcome(id, r, pnl)`
once the horizon elapses. Per-agent `AgentStats` aggregates:

- `total_r` — sum of realised R-multiples
- `win_rate` and `rolling_sharpe` (rolling last N decisions)
- `total_pnl_usd`, `last_r`, `total_decisions`, `active` flag

The scoreboard is the **oracle**. Evolution reads it; consensus reads
it; the UI reads it.

### 5. Consensus

```rust
ConsensusCfg {
    top_k: 5,
    min_decisions_for_champion: 3,
    champion_agreement: 0.6,      // 60 % of champions agree
    min_agent_count: 3,           // at least 3 agents voted
    overall_agreement: 0.5,
}
```

Bucket decisions by `(asset, direction)`, pick the largest group,
verify overall + champion agreement both clear their thresholds, emit a
`ConsensusDecision`. Size comes from vol-targeted
`portfolio::Allocator`.

### 6. Execution

`exchange-hyperliquid` signs an EIP-712 `{Order, Tif}` action with a
k256 private key, POSTs to `https://api.hyperliquid.xyz/exchange`, and
`live-executor` maintains local state to reconcile fills. A per-trade
risk guard enforces:

- per-trade ≤ 1 % equity risk (ATR-scaled)
- per-day stop at −3 % equity
- portfolio halt at 15 % drawdown

**Two binaries:**

- `pythia-live` — legacy single-strategy executor (hourly liquidation
  z-score > 2.5 σ → direct HL order). Still useful as a minimal
  reference.
- `pythia-swarm-live` — swarm-driven. Converts Binance WS events into
  `swarm::Event`, broadcasts to the 20-agent population, runs
  `consensus()`, places one order per firing. Writes a
  `data/swarm-snapshot.json` every 10 s for the `/tournament` UI.

### Evolution — the loop close

Every `generation_interval` events:

1. Score every current systematic agent via the scoreboard.
2. Retain the top `elite_fraction` unchanged (survival of the best).
3. Fill the rest via rank-weighted parent selection, **log-space Gaussian
   mutation** of continuous params (z-threshold, risk fraction, horizon),
   and **same-family crossover** (never blend liq-trend params with
   funding-arb).
4. Evicted agents keep their decision history but stop firing.

Cf. `crates/swarm/src/evolution.rs`. Mutation sigmas are conservative by
default (0.15 log-space) — the goal is monotone improvement, not
population collapse.

### UI — `/tournament` (apps/web)

A Three.js arena that renders the 20-agent scoreboard in 3D:

- each agent is an icosahedron floating in an elliptical band; size
  scales with `total_r`, colour with rule family
- the champion sits on a centre pedestal with a rotating halo + light
  beam
- faint cyan filaments connect the top-5 to imply consensus
- positions lerp smoothly when ranks reshuffle — so you literally watch
  evolution happen
- bloom + vignette post-processing, orbit camera rig

The page polls `/api/swarm` every 5 s, which reads
`data/swarm-snapshot.json`. If the daemon isn't running, a deterministic
demo snapshot is served so the route renders standalone.

## What the layering buys you

**Add a new edge:** drop in a `SystematicParams` preset, the swarm picks
it up at next generation. No engine changes.

**Add an LLM persona:** implement `LlmDecider` or push a new
`Personality` into the roster. Same.

**Add a new data source:** one `impl DataSource` — every agent sees it
automatically on the bus.

**Change ranking rule:** edit `ConsensusCfg` — every downstream layer
unaffected.

**Change execution venue:** new `impl ExchangeClient` in
`exchange-hyperliquid` (or a sibling crate). Swarm doesn't know or care.

---

## Guarantees — the honest list

**What the system guarantees:**
- Every trade risks ≤ 1 % of equity
- Every trade has a stop-loss submitted at the exchange before entry
- Portfolio daily vol stays within 1.5 % ± 0.5 %
- Max drawdown triggers automatic halt at 15 %
- No single strategy / agent gets > 40 % of portfolio risk
- AI + LLM changes roll back if they hurt realised Sharpe

**What no trading system guarantees:**
- That the backtest pattern persists
- That slippage stays flat during a cascade
- That your exchange stays up
- That the regime doesn't invert on you

## Shorter time frame, more aggressive — the three levers

1. **15-min bars** instead of 1-h → 4× more signals, 4× faster
   compounding. Tradeoff: tighter stops, more noise. Backtest first.
2. **10 perps** instead of 2 — cross-sectional agents can then rank
   BTC/ETH/SOL/AVAX/BNB/MATIC/LINK/XRP/DOGE/APT instead of picking one.
3. **Portfolio margin on HL** → effective leverage 5–10× without
   increasing per-trade risk fraction.

All three together: same 1 % risk discipline, 3–5× more expected
compounding speed. Those are probabilistic numbers, not guarantees.
