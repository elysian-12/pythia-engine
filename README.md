# Pythia

An **agent-swarm** for crypto derivatives trade discovery.

Pythia stands up a heterogeneous population of simulated traders — each with
its own rule family, risk appetite, horizon, and (optionally) LLM persona —
feeds them the same Kiyotaka event stream (liquidations, funding, OI,
hourly candles, volume, **Polymarket leadership**), and ranks them by
realised PnL. The scoreboard picks the **champion**; the champion's
strategy is then applied via the live **executor** that signs + sends
orders to Hyperliquid.

One monolithic strategy is fragile; a tournament of disagreeing agents
surfaces the rule that is actually paying out under the current regime.

### The feedback loop in one sentence

> **Kiyotaka events (liquidation, funding, vol-breakout, Polymarket
> SWP-vs-mid lead, fusion) → 27 quant personas vote independently →
> scoreboard tallies per-event-kind expertise → router picks the
> specialist for *this* event kind → Sharpe-weighted ensemble vote sets
> direction + conviction → quarter-Kelly sizes the trade → executor
> copy-trades on Hyperliquid → realised PnL feeds back → every agent
> gates its next decision on its own recent expectancy → every N events,
> `Evolution` replaces the weakest half with mutated + crossed elite.**

### The eight steps in plain English

1. **Event** — every agent sees the same Kiyotaka tick at the same time.
2. **Vote** — each one fires or abstains independently using its own
   rule family (7 systematic + 5 LLM personas).
3. **PeerView** — social agents read peer + champion directions; every
   agent also sees its own recent expectancy and abstains when its E[R]
   turns negative (self-backtest gate).
4. **Scoreboard** — closed trades update Σ R, rolling Sharpe, profit
   factor, PSR, DSR — the oracle the router reads.
5. **Specialist** — per-event-kind routing. Polymarket leads → polyedge;
   liquidation cascades → liq-trend; funding spikes → funding-trend;
   confluence events → polyfusion. No global oracle missing the
   specialist's edge.
6. **Ensemble** — Sharpe-weighted vote across the agents that *did*
   fire. Trade only when conviction > 0.25; size scales with quarter-
   Kelly on the specialist's profit factor.
7. **Evolution** — every N events, weak agents replaced by log-space
   Gaussian mutants + elite crossovers (same family). The specialist
   roster itself evolves to fit the regime, not just the params.
8. **Copy trade** — specialist + ensemble direction + Kelly-scaled size
   → paper Hyperliquid (live signing wired in next pass). Closed-trade
   R feeds back into the scoreboard, closing the loop on the next event.

- **PeerView** = what agents see *of each other* within one event
  (momentum / contrarian meta-behaviour) plus their *own* recent
  expectancy from the scoreboard (live self-backtest gate).
- **Evolution** = how the population *improves* across events
  (log-space mutation + same-family crossover on the elite).
- **Self-backtest gate** = `Scoreboard::recent_expectancy(agent_id, N,
  min_sample)` is layered into PeerView so a `SystematicAgent` whose
  recent E[R] turns negative abstains until it recovers — turning the
  post-hoc scoreboard into a live filter.

Full details in [SWARM.md](SWARM.md).

```
  Kiyotaka REST + WS ──▶ Swarm (27 agents) ──▶ Scoreboard ──▶ Champion ──▶ Executor ──▶ Hyperliquid
   ├ liquidations            │                      ▲                            │
   ├ funding                 │                      │                            └─ EIP-712 + risk guard
   ├ hourly candles          │                      │
   ├ volume                  │                      └── realised PnL · self-backtest gate
   └ Polymarket SWP/mid      │
                             ├──▶ Evolution (every N events) — mutate + crossover
                             └──▶ PeerView (social + own recent expectancy)
```

## Quick start

Requires Rust 1.88+, Node 20+.

```sh
cp .env.sample .env              # KIYOTAKA_API_KEY, ANTHROPIC_API_KEY (opt)

# 1. Build + backtest the swarm on 365 d of real BTC + ETH data
cargo run --release -p swarm --bin swarm-backtest

# 2. Grid-search the underlying systematic rules (still useful for seeding)
cargo run --release -p strategy --bin find_best_v2

# 3. Live execution — swarm drives the trades
cargo run --release -p live-executor --bin pythia-swarm-live
#    (legacy single-strategy path: --bin pythia-live)

# 4. Watch the tournament live in the browser (bundles the latest
#    snapshot into public/ so it works even without the daemon)
cd apps/web && npm install && npm run dev
#    open http://localhost:3000/tournament
```

### Deploying `/tournament` to Vercel

```sh
cd apps/web
npx vercel deploy --prod
```

The prebuild hook (`scripts/bundle-snapshot.mjs`) copies the most
recent `data/swarm-snapshot.json` → `public/swarm-snapshot.json` so
the arena renders real Σ R numbers from your latest backtest even
without a running daemon. Re-run `swarm-backtest` and redeploy to
refresh.

Risk + sizing settings entered in `/tournament` POST to `/api/config`
and land at `data/swarm-config.json`, which `pythia-swarm-live`
reloads every 15 s — so you can tune live.

## Architecture

Six layers — see [ARCHITECTURE.md](ARCHITECTURE.md) for details.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. DATA          Kiyotaka REST + WS — liqs · funding · candles · vol    │
│                  · Polymarket SWP-mid gap (skill-weighted probability)  │
│ 2. REGIME        trending / ranging / chaotic / calm classifier         │
│ 3. SWARM         27 agents — 7 rule families incl. polyedge + polyfusion│
│                  · self-backtest gate per decide() · LLM personas       │
│ 4. SCOREBOARD    rolling Sharpe · PSR · DSR · expectancy_for_recent_N   │
│ 5. EXECUTOR      champion's decision → Hyperliquid EIP-712 + risk guard │
│    EVOLUTION     every N events: elite preserve + mutate + crossover    │
└─────────────────────────────────────────────────────────────────────────┘
```

## Workspace layout

```
crates/
├── domain/                  pure types — Asset, Candle, Signal, Trade
├── kiyotaka-client/         the only data path — REST + WS for candles,
│                            funding, OI, liquidations, Polymarket SWP/mid
├── store/                   embedded warehouse (event + asof timestamps)
├── econometrics/            cointegration, Granger, Hasbrouck IS, Gini
├── signal-engine/           SWP + gate evaluator (Polymarket research)
├── paper-trader/            deterministic ATR-based simulator
├── evaluation/              Deflated Sharpe, PSR, PBO, bootstrap CI
├── strategy/                7 crypto-native rule families + ablation bins
├── backtest/                walk-forward runner + compounding equity
├── datasource/              pluggable DataSource trait + broadcast Bus
├── regime/                  ADX/Donchian/vol classifier
├── portfolio/               vol-targeted allocator + regime weights
├── tuner/                   bounded-autonomy AI tuner (LLM tool-use)
├── exchange-hyperliquid/    EIP-712 signing + typed REST client
├── live-executor/           pythia-swarm-live binary (24/7 daemon)
└── swarm/ ★                 the tournament — 7 rule families (incl.
                             polyedge + polyfusion), Scoreboard with
                             recent_expectancy gate, evolution, LLM
                             personas, regime-aware fitness
apps/web/                    Next.js 15 · three.js · Vercel-deployed
├── /                        landing — equity curve, champion HUD, auto-
│                            replay loop, trade-settings panel
├── /visualize               trade replay rescaled to user equity + risk
└── /tournament ★            live Pythian arena: wireframe regime
                             surface, gilded tripod + omphalos at the
                             centre with the champion oracle floating
                             above, prophecy filaments to the top-3
                             specialists, agent totems flash on fire,
                             event-to-trade latency meter in the header
```

★ = the hero crate. Everything else feeds it or is fed by it.

## Trade selection — how a single event becomes a paper trade

A common failure mode of swarm trading: one agent dominates the global
ranking, but its rule family doesn't react to *every* event kind. The
"global champion" copy-trader then misses entire categories — a
vol-breakout-only champion abstains on every Polymarket leadership
signal, and the user wonders why the swarm went quiet. The router
in `apps/web/lib/router.ts` (mirroring the Rust path in
`crates/swarm/src/scoring.rs`) replaces that policy with three
layered decisions:

1. **Specialist for the event kind.** Each event arrives tagged with a
   kind (`liq-spike`, `funding-spike`, `vol-breakout`, `polymarket-lead`,
   `fusion`). The router picks the agent whose rule family is
   preferred for that kind *and* whose rolling Sharpe is highest among
   peers with ≥10 closed decisions. Falls back to the global Σ R
   leader if no eligible specialist exists yet.

2. **Sharpe-weighted ensemble vote.** Among the agents that fired on
   this event, each one's vote is weighted by `clip(rolling_sharpe,
   -2, +2) + 2`. Negative-Sharpe agents barely vote. The signed
   conviction is `(weight_long − weight_short) / total_weight ∈
   [−1, +1]`; if its absolute value is below 0.25, the copy-trader
   sits the event out (split votes are noise).

3. **Quarter-Kelly sizing.** Final notional is
   `equity × user_risk_fraction × kelly_frac × |conviction|`, where
   `kelly_frac = clip(0.5 · log₂(specialist_PF), 0, 1)`. A specialist
   with PF=2 gets 0.5 of the risk budget, PF=4 gets 1.0, PF<1 sits
   out. Conviction further scales the size so a 0.3-conviction trade
   is smaller than a 0.9-conviction one with the same specialist.

Every event the user fires (manually or via autopilot) walks this
exact path on the Vercel-deployed `/tournament` page; the trade-feed
footer surfaces the chosen specialist, fired count, vote direction,
conviction, and size factor. The Rust `Scoreboard` exposes a
`recent_expectancy(agent_id, n, min_sample)` that already feeds the
self-backtest gate; threading the same per-kind expectancy table into
`Scoreboard::champion_for_kind()` is the next-pass migration so the
live executor can use the same policy without TS-side mirroring.

### Verification — the steps in the UI actually do what they say

| UI step | Where it runs in Rust | Where it runs in TS (UI mirror) |
|---|---|---|
| 1. Event | `Swarm::broadcast(&Event)` | `simulateReactions(ev, agents)` |
| 2. Vote | each `SwarmAgent::observe` independently | each agent's reaction emitted in `lib/simulate.ts` |
| 3. PeerView + self-backtest gate | `PeerView { regime, self_recent_expectancy }` populated by `Swarm.with_scoreboard()` | regime fitness mirror in `lib/simulate.ts::regimeFitness` |
| 4. Scoreboard | `Scoreboard::mark_outcome` updates per-trade R, Sharpe, PSR, DSR | `applySessionDelta` mutates the local snapshot live so the leaderboard re-ranks during a session |
| 5. Specialist | (next-pass: `Scoreboard::champion_for_kind`) | `router::pickSpecialist(kind, agents)` |
| 6. Ensemble | (next-pass) | `router::weightedVote(reactions, agents)` |
| 7. Evolution | `Evolution::advance` every `PYTHIA_EVOLVE_EVERY` events | snapshot bundler injects evolved population at deploy time |
| 8. Copy trade | `live-executor` signs EIP-712 + sends to Hyperliquid | TournamentClient opens a paper position with stop + TP, marks live PnL against Kiyotaka prices |

## Quantitative integration

Pythia is built on a stack of well-defined quantitative pieces. The
table below is the authoritative truth about what's actually called
during a swarm event, vs. what lives in the workspace but isn't yet
fed into the agent decision path. Be honest with yourself before
trusting any number — research code drifts, this list does not.

| Concept | Crate / fn | Wired into the swarm? | Where it fires |
|---|---|:-:|---|
| **R-multiple ledger** (Van Tharp expectancy) | `swarm::scoring::Scoreboard::mark_outcome` | ✅ live | every closed trade in `swarm-backtest` and `pythia-swarm-live` |
| **Probabilistic Sharpe Ratio** (Bailey & López de Prado 2012) | `evaluation::probabilistic_sharpe_ratio` | ✅ live | end-of-run certification block in `swarm-backtest`; PSR shown on the champion HUD and in the snapshot |
| **Deflated Sharpe Ratio** (B&LdP 2014, multiple-testing correction) | `evaluation::deflated_sharpe_ratio` | ✅ live | same call site as PSR; uses every agent's Sharpe as the trial set |
| **Block-bootstrap CI on Sharpe** (block size 7) | `evaluation::block_bootstrap_sharpe` | ✅ live | 95% CI lower/upper around the champion's Sharpe |
| **Quarter-Kelly position sizing** | `live-executor::pythia-swarm-live` | ✅ live, opt-in | toggled by `kelly_enabled` in user settings; falls back to risk-fraction sizing |
| **Regime classifier** (Trending / Ranging / Chaotic / Calm) | `regime::classify` | ✅ live | rolling BTC candle buffer feeds `Swarm.current_regime`; agents see it via `PeerView.regime` |
| **Per-family regime fitness gate** | `swarm::systematic::SystematicAgent::regime_fitness` | ✅ live | every `decide_for_asset()` — agents abstain when fitness < 0.3, scale risk by fitness otherwise |
| **Self-backtest gate** (live recent-expectancy filter) | `swarm::scoring::Scoreboard::recent_expectancy` → `PeerView.self_recent_expectancy` | ✅ live | `Swarm::with_scoreboard(...)` populates per-agent before each `observe()`; `decide_for_asset()` abstains on E[R] < −0.05R |
| **Realistic execution simulation** (taker fees 5bps × 2, slippage 3bps × 2, funding cost, within-bar stop/TP, ATR R) | `paper_trader::simulate` | ✅ live | every closed trade in backtest and live-loop replay |
| **Genetic evolution** (log-space Gaussian mutation + same-family crossover, rank-weighted parent selection, elite preservation) | `swarm::evolution::Evolution::advance` | ✅ live | every `PYTHIA_EVOLVE_EVERY` events; carries generation counter across runs via `data/swarm-population.json` |
| **Population persistence** (id + params + stats + r_history round-trip) | `swarm::persistence::PersistedPopulation` | ✅ live | save at end of run, load at start; resume preserves prior R-history so PSR/DSR survive restarts |
| **Granger F-statistic** (lag-4 prediction-market lead test) | `econometrics::granger_f` | ⚠️ present, **not** wired | `signal-engine` evaluates it offline; the `polyedge` agent uses a magnitude-z proxy instead. |
| **Hasbrouck information share** | `econometrics::information_share` | ⚠️ present, **not** wired | same — `signal-engine` only |
| **Engle-Granger cointegration gate** | `econometrics::engle_granger` | ⚠️ present, **not** wired | same — `signal-engine` only |
| **Probabilistic Backtest Overfit (PBO)** | `evaluation::pbo` | ⚠️ wired in `strategy::ablate`, **not** in `swarm-backtest` | grid-search ablation only |

The honest gap: `polyedge` agents currently fire on a Polymarket
event's z-magnitude alone. The "real" PolyEdge thesis — fire when
Granger-F passes its threshold AND Hasbrouck IS exceeds 0.5 AND the
two series are cointegrated — needs those three calls threaded into
`SystematicAgent::observe` for the `polyedge` family. That's the
next-pass follow-up; everything else above is exercised on every
event.

## What's validated

- **365 days · BTC + ETH perps via Kiyotaka · ~69k events** replayed through
  the swarm in <1 s wall. Ranking + champion report at
  `reports/swarm/<ts>/swarm.md`.
- **Concurrent broadcast verified**: `broadcast_scales_constant_with_agent_count`
  proves 25 agents complete in roughly the same wall-clock as 5 (single
  cohort × 50 ms each) — i.e. agent observe() futures actually overlap
  via `futures::join_all`, not iterate. Serial implementation would be
  5× slower at n=25. Run `cargo test -p swarm broadcast` to verify
  locally; all 4 broadcast tests + 19 other unit tests finish in 0.2 s.
- Underlying systematic rules (grid-searched independently of the swarm) —
  `liq-trend` at 1 % risk compound: $1k → $64k over the same year with
  3 % max-DD, Sharpe 0.43, 75 % win rate across 578 trades.
- The swarm currently **discovers** this champion autonomously without
  being told which rule to run, then **gates each agent's next decision**
  on its own recent expectancy so a once-good rule shuts itself off when
  the regime stops paying.

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — six-layer system design
- [SWARM.md](SWARM.md) — agent types, scoring, evolution, LLM personas
- [TRADING_GUIDE.md](TRADING_GUIDE.md) — operator handbook, capital sizing,
  risk layers, go-live checklist

## Environment

| Var | Required | Default | Purpose |
|-----|:-:|---|---|
| `KIYOTAKA_API_KEY` | ✓ | — | REST for candles / funding / OI / liquidations |
| `ANTHROPIC_API_KEY` | ○ | — | LLM-driven swarm agents (mock used if unset) |
| `HL_PRIVATE_KEY` | ○ | — | Hyperliquid signer (required in live mode) |
| `PYTHIA_MODE` | ○ | `dryrun` | `dryrun` \| `live` — live places real orders |
| `PYTHIA_RISK` | ○ | `0.005` | risk-fraction floor applied on top of agent prefs |
| `PYTHIA_EVOLVE_EVERY` | ○ | `500` | events between evolution generations |
| `PYTHIA_SNAPSHOT` | ○ | `data/swarm-snapshot.json` | swarm state dump for `/tournament` |
| `PYTHIA_CONFIG` | ○ | `data/swarm-config.json` | user-tuned risk + sizing (written by UI) |
| `PYTHIA_BIND` | ○ | `0.0.0.0:8080` | axum bind |
| `PYTHIA_DB` | ○ | `data/pythia.duckdb` | DuckDB path |
| `RUST_LOG` | ○ | `info,pythia=debug` | tracing filter |

## Testing

```sh
cargo test --workspace           # 80+ tests across 17 crates
cargo bench                      # criterion on hot paths
```

## License / disclaimer

Research code. No guaranteed profits — the swarm raises the odds, it does
not remove risk. Every statement of "expected return" in this repo is
probabilistic. Read [TRADING_GUIDE.md](TRADING_GUIDE.md) before putting real
capital behind it.
