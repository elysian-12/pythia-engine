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

> **Kiyotaka events (incl. Polymarket SWP-vs-mid leads) → 27 quant
> personas compete → scoreboard picks the champion → executor copy-trades
> the champion → realised PnL feeds back into the scoreboard → each agent
> gates its next decision on its own recent expectancy → every N events,
> `Evolution` replaces the weakest half with mutated + crossed elite.**

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
└── /tournament ★            live arena (Roman Colosseum theme): 27
                             agent orbs, elite filaments with traveling
                             sparks, activity-driven flash, latency meter
```

★ = the hero crate. Everything else feeds it or is fed by it.

## What's validated

- **365 days · BTC + ETH perps via Kiyotaka · ~69k events** replayed through
  the swarm in <1 s wall. Ranking + champion report at
  `reports/swarm/<ts>/swarm.md`.
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
