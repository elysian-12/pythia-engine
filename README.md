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
> SWP-vs-mid lead, fusion) → 27 quant personas evaluate independently →
> scoreboard ranks them by **per-trade Sharpe** (≥30 closed trades to
> qualify) → the single highest-Sharpe agent is the **champion** →
> when the champion fires, the executor copy-trades it on Hyperliquid
> at quarter-Kelly on the champion's profit factor → realised PnL feeds
> back → every agent gates its next decision on its own recent
> expectancy → every N events, `Evolution` replaces the weakest half
> with mutated + crossed elite.**

### The eight steps in plain English

1. **Event** — A market tick from Kiyotaka: forced liquidation, funding
   spike, price breakout, Polymarket lead, or two of those at once.
2. **Evaluate** — All 27 agents see the event simultaneously. Each one
   decides independently: trade or sit out. 22 follow rules, 5 reason
   as LLM personas in plain English.
3. **Self-check** — Before deciding, every agent reads its own recent
   results. Losing money lately? It benches itself until it recovers.
   The regime fitness gate also throws out trades hostile to the
   current regime classifier.
4. **Scoreboard** — When trades close, the realised win or loss flows
   back. Each agent's running profit, win rate, and statistical
   confidence (per-trade Sharpe / PSR / DSR) update.
5. **Champion** — The single highest-Sharpe agent with ≥30 closed
   trades wins the crown. **Sharpe is a ratio, so lifespan can't
   inflate it** — a long-lived mediocre agent doesn't beat a
   short-lived high-quality one (the way Σ R would have ranked it).
   No champion exists until at least one agent clears the 30-trade
   floor; the executor sits out until then.
6. **Copy-trade** — When (and only when) the champion reacts to an
   event, the executor follows: same direction, sized at quarter-Kelly
   on the champion's profit factor, scaled by the user's risk budget,
   capped at 2× equity per trade. Rest of the swarm vote is computed
   for transparency and for the swarm-flip exit signal but does NOT
   gate the entry — the champion's own decision is the conviction
   signal.
7. **Evolution** — Every N events, the worst agents get replaced by
   tweaked copies of the best (small parameter shifts + same-family
   crossover). Fitness-ranked by `recent_expectancy × √n_recent` so
   a fresh winner can rotate into the elite slot, not just the
   long-lived seed.
8. **Manage** — The paper position lives until: (a) stop or take
   profit hits, (b) trailing stop trails to break-even at +1 R then
   ratchets up, (c) time stop force-exits stale entries, or (d) the
   rest of the swarm votes opposite at high conviction (swarm-flip
   exit). When it closes, realised R flows back to step 4 — the loop
   closes.

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

### Hourly auto-refresh of the deployed snapshot

GitHub Actions' native `schedule:` cron is lossy under load and
Vercel Hobby's cron is daily-only. The reliable free path is
**cron-job.org → GitHub `repository_dispatch` → workflow → commit →
Vercel auto-redeploy**. Setup walkthrough in
[docs/CRON_SETUP.md](docs/CRON_SETUP.md). Each run takes ~2-3 min
warm and produces an evolved snapshot that's bundled into the next
deploy. Gen counter in `/api/swarm` increments after each successful
refresh — that's the externally-visible heartbeat.

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

The demo's thesis: **out of 27 agents the swarm surfaces the single
best trader, and you copy that one.** The path is intentionally
simple so the narrative reads cleanly:

1. **All 27 agents evaluate the event independently.** Each one runs
   its own family rule (z-threshold, Donchian breakout, three-gate
   polyedge, etc.) and its own gates (regime fitness gate, recent
   expectancy gate). It either fires (with a direction) or sits out.

2. **Champion check.** The global champion is the highest-Sharpe
   agent with ≥30 closed trades — Sharpe is a ratio so lifespan
   doesn't inflate it the way Σ R would. **If the champion did NOT
   fire on this event, the copy-trader skips it entirely.** Every
   trade in the demo can be attributed to one specific agent: the
   champion at that moment.

3. **Quarter-Kelly sizing on the champion.** When the champion fires,
   notional = `equity × user_risk_fraction × kelly_frac` where
   `kelly_frac = clip(0.5 · log₂(champion_PF), 0, 1)`. PF=2 gets 0.5
   of the risk budget, PF=4 gets 1.0. No ensemble-conviction
   multiplier — the champion's binary fire/no-fire IS the conviction
   signal in champion-only mode. Hard cap at 2× equity per trade.

4. **Mirror agent override.** A dropdown on the `/tournament` page
   lets the user pin any agent — the system follows that pin instead
   of the champion until it's cleared. This is the only way to copy
   a non-champion. Useful for "what if I followed polyedge-v0
   instead of the champion this week?" comparisons.

5. **Ensemble vote is still computed but doesn't gate entries.**
   The Sharpe-weighted vote across firing agents (in
   [`apps/web/lib/router.ts::weightedVote`](apps/web/lib/router.ts))
   feeds two downstream uses: (a) the swarm-flip exit rule in
   `manageOnEvent` closes a position when the rest of the swarm
   strongly disagrees with the champion's existing position, (b) the
   trade feed renders it as transparency context. It does NOT decide
   whether to enter.

Every event the user fires (manually or via autopilot) walks this
exact path on the Vercel-deployed `/tournament` page; the trade-feed
footer shows the champion's name, the swarm vote (e.g. `12/27`), the
direction, and the size factor.

> **Why champion-only and not per-event-kind specialist?** An
> earlier design picked a specialist for each event kind (polyedge
> for Polymarket events, liq-trend for liquidation cascades, etc.)
> with a Sharpe-weighted ensemble vote setting conviction. It worked,
> but it diluted the demo narrative ("who is the swarm telling me to
> copy?" had a different answer per event). Champion-only is one
> name, one trade-driver, the cleanest expression of the thesis.
> The specialist-mode router (`routeTrade` in `lib/router.ts`) is
> kept for the research scripts in `apps/web/scripts/backtest/`
> that compare routing strategies offline.

### Portfolio meta-agent — exits + portfolio balancing

The router decides which specialist to follow on entry. The
meta-agent in [`apps/web/lib/portfolio.ts`](apps/web/lib/portfolio.ts)
handles everything *after* — both exits and portfolio-level risk:

- **Exits** — stepped trailing stop (1R→BE, 2R→+1R, 3R→+2R, 4R→+3R,
  6R→+5R), `time_stop_hours` force-exit, swarm-flip close when the
  swarm votes opposite at ≥ `swarm_flip_conviction`, plus a
  `min_hold_minutes` floor so fresh entries can't be cut at $0.
- **Balancing** — `max_open_positions` cap; `min_conviction` floor on
  entries; correlation-aware sizing (BTC and ETH ≈ 0.7-correlated
  → second-asset notional × `correlation_size_factor`); session
  drawdown circuit-breaker that halts new entries below
  `−max_session_dd_pct × equity` (reversals still allowed).

Closes carry distinct chips (`stop` / `take profit` / `trail` /
`time` / `reverse` / `swarm flip` / `manual`) so the session log
shows whether the loop is closing in profit or being walked out.
Every threshold is exposed in Settings and persists through
`/api/config`. Detailed rules in [SWARM.md](SWARM.md#portfolio-meta-agent--exits--position-management).

### Verification — the steps in the UI actually do what they say

| UI step | Where it runs in Rust | Where it runs in TS (UI mirror) |
|---|---|---|
| 1. Event | `Swarm::broadcast(&Event)` | `simulateReactions(ev, agents)` |
| 2. Evaluate | each `SwarmAgent::observe` independently | each agent's reaction emitted in `lib/simulate.ts` |
| 3. PeerView + self-backtest gate | `PeerView { regime, self_recent_expectancy }` populated by `Swarm.with_scoreboard()` | regime fitness mirror in `lib/simulate.ts::regimeFitness` |
| 4. Scoreboard | `Scoreboard::mark_outcome` updates per-trade R, Sharpe, PSR, DSR | `applySessionDelta` mutates local snapshot — sorts by Sharpe to match Rust |
| 5. Champion | `Scoreboard::top_n(1, 30)` ranks by `rolling_sharpe`, Σ R as tiebreak (`min_decisions_for_champion = 30` floor) | `applySessionDelta` mirrors the same sort key |
| 6. Copy trade routing | (next-pass: per-trade Kelly in Rust) | `router::routeTradeChampion(ev, rxs, agents, championId)` |
| 7. Evolution | `Evolution::advance` every `PYTHIA_EVOLVE_EVERY` events | snapshot bundler injects evolved population at deploy time |
| 8. Manage | `live-executor` signs EIP-712 + sends to Hyperliquid + manages exits | TournamentClient opens paper position with 2× equity cap + 2 ATR stop / 3 ATR TP, portfolio meta-agent (`apps/web/lib/portfolio.ts`) handles trail / time-stop / swarm-flip / DD breaker |

## Quantitative integration

Pythia is built on a stack of well-defined quantitative pieces. The
table below is the authoritative truth about what's actually called
during a swarm event, vs. what lives in the workspace but isn't yet
fed into the agent decision path. Be honest with yourself before
trusting any number — research code drifts, this list does not.

| Concept | Crate / fn | Wired into the swarm? | Where it fires |
|---|---|:-:|---|
| **R-multiple ledger** (Van Tharp expectancy) | `swarm::scoring::Scoreboard::mark_outcome` | ✅ live | every closed trade in `swarm-backtest` and `pythia-swarm-live` |
| **Per-trade Sharpe ranking** (champion = highest Sharpe, ≥30 closed trades, Σ R as tiebreak) | `swarm::scoring::Scoreboard::top_n` | ✅ live | every event in both bins; **fixes the lifespan bias of raw Σ R ranking** — a long-lived mediocre agent can no longer beat a short-lived high-quality one |
| **Probabilistic Sharpe Ratio** (Bailey & López de Prado 2012) | `evaluation::probabilistic_sharpe_ratio` | ✅ live | end-of-run certification block in `swarm-backtest`; PSR shown on the champion HUD and in the snapshot |
| **Deflated Sharpe Ratio** (B&LdP 2014, multiple-testing correction) | `evaluation::deflated_sharpe_ratio` | ✅ live | same call site as PSR; uses every agent's Sharpe as the trial set |
| **Block-bootstrap CI on Sharpe** (block size 7) | `evaluation::block_bootstrap_sharpe` | ✅ live | 95% CI lower/upper around the champion's Sharpe |
| **Quarter-Kelly position sizing** | `apps/web/lib/router.ts::routeTradeChampion` (UI) · `live-executor::pythia-swarm-live` (Rust) | ✅ live | UI: `kelly_frac = clip(0.5·log₂(champion_PF), 0, 1)`, capped at 2× equity; Rust: same curve, opt-in via `kelly_enabled` |
| **Regime classifier** (Trending / Ranging / Chaotic / Calm) | `regime::classify` | ✅ live | rolling BTC candle buffer feeds `Swarm.current_regime`; agents see it via `PeerView.regime` |
| **Per-family regime fitness gate** | `swarm::systematic::SystematicAgent::regime_fitness` | ✅ live | every `decide_for_asset()` — agents abstain when fitness < 0.3, scale risk by fitness otherwise |
| **Self-backtest gate** (live recent-expectancy filter) | `swarm::scoring::Scoreboard::recent_expectancy` → `PeerView.self_recent_expectancy` | ✅ live | `Swarm::with_scoreboard(...)` populates per-agent before each `observe()`; `decide_for_asset()` abstains on E[R] < −0.05R |
| **Realistic execution simulation** (taker fees 5bps × 2, slippage 3bps × 2, funding cost, within-bar stop/TP, ATR R) | `paper_trader::simulate` | ✅ live | every closed trade in backtest and live-loop replay |
| **Genetic evolution** (log-space Gaussian mutation + same-family crossover, rank-weighted parent selection, elite preservation) | `swarm::evolution::Evolution::advance` | ✅ live | every `PYTHIA_EVOLVE_EVERY` events; carries generation counter across runs via `data/swarm-population.json` |
| **Population persistence** (id + params + stats + r_history round-trip) | `swarm::persistence::PersistedPopulation` | ✅ live | save at end of run, load at start; resume preserves prior R-history so PSR/DSR survive restarts |
| **Granger F-statistic** (lag-4 prediction-market lead test) | `econometrics::granger_f` | ✅ live | `polyedge` family decide path — fires only when SWP Granger-leads mid at p < 0.05 |
| **Hasbrouck information share** | `econometrics::information_share_proxy` | ✅ live | `polyedge` family decide path — fires only when `share_pm > 0.5` |
| **Engle-Granger cointegration gate** | `econometrics::cointegration_test` | ✅ live | `polyedge` family decide path — first gate; rejects unless residuals are stationary at 5 % |
| **Probabilistic Backtest Overfit (PBO)** | `evaluation::probability_of_backtest_overfitting` | ✅ live | swarm-backtest certification block; surfaced in snapshot.`champion_certification.pbo` |

The polyedge family now runs the real three-gate pipeline:
**Engle-Granger cointegration** on `(swp, mid)` →
**Granger F-test** at lag 4 on `mid ~ swp_lags` →
**Hasbrouck information share** with PM dominance check. Only when
all three pass simultaneously does the agent fire, in the direction
of the latest `swp − mid` gap. The wiring lives in
[`crates/swarm/src/systematic.rs`](crates/swarm/src/systematic.rs)
under the `RuleFamily::PolyEdge` branch; the rolling SWP/mid history
flows through `PeerView::polymarket_history` updated by
[`Swarm::broadcast_timed`](crates/swarm/src/population.rs) on every
`Event::Polymarket` tick.

PBO joins PSR / DSR / block-bootstrap CI in the certification block.
The matrix is built from each agent's R-history split into 8 chunks;
columns are agents that have ≥ 32 closed trades. Result lands in
`snapshot.champion_certification.pbo` so the UI can show it alongside
the other significance numbers — < 0.5 means the winning config
generalises out-of-sample more than half the time.

## What's validated

Numbers below come from the deployed bundled snapshot
(`apps/web/public/swarm-snapshot.json`) — what the `/performance` page
actually shows, not a hypothetical backtest. Replay updates them every
hour via cron.

- **Deployed champion (gen 168):** `vol-breakout-v1` — 738 closed
  trades, 67.5 % win rate, Σ R = **+650.11**, E[R] / trade =
  **+0.88 R**, profit factor **3.66**, per-trade Sharpe **0.647**.
  Selected by Sharpe-rank with a ≥30-trade floor, so newer agents
  with genuine edge can rotate in without being overshadowed by
  long-lived seeds with more accumulated R.
- **Statistical certification:** PSR ≈ **1.000**, DSR ≈ **1.000**
  (multi-testing-corrected across all 27 agents), Sharpe 95 % CI =
  **[0.541, 0.759]** — lower bound clears zero, so the edge survives
  block-bootstrap resampling. PBO computes once the R-history
  matrix is dense enough for 8 splits × ≥32-trade columns.
- **365 days · BTC + ETH perps via Kiyotaka · ~69 k events** replayed
  through the swarm in **<1 s wall** on an M-series Mac. Ranking +
  champion report at `reports/swarm/<ts>/swarm.md`.
- **Concurrent broadcast verified:** `broadcast_scales_constant_with_agent_count`
  proves 25 agents complete in roughly the same wall-clock as 5 (single
  cohort × 50 ms each) — agent `observe()` futures actually overlap via
  `futures::join_all`, not iterate. Serial would be 5× slower at n=25.
  Run `cargo test -p swarm broadcast` locally; all 4 broadcast tests +
  19 other unit tests finish in 0.2 s.
- The swarm **discovered** the current champion autonomously (no rule
  was hand-picked), then **gates each agent's next decision** on its
  own recent expectancy, so a once-good rule shuts itself off when
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
