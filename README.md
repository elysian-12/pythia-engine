# Pythia

An **agent-swarm** for crypto derivatives trade discovery.

Pythia stands up a heterogeneous population of simulated traders — each with
its own rule family, risk appetite, horizon, and (optionally) LLM persona —
feeds them the same real-time event stream (liquidations, funding, OI,
candles), ranks them by realised PnL, and has the **consensus of the top
performers** drive live execution.

Inspired by [camel-ai/oasis](https://github.com/camel-ai/oasis): instead of
one monolithic strategy, use a tournament of disagreeing agents and let the
scoreboard pick the champion.

```
  Binance public WS ──┐
  Kiyotaka REST ──────┼──▶ Swarm (20+ agents) ──▶ Scoreboard ──▶ Consensus ──▶ Hyperliquid REST
  DuckDB replay ──────┘        │                      │
                                │                      └──▶ Evolution (every N events)
                                └──▶ PeerView (social influence)
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

# 4. Watch the tournament live in the browser
cd apps/web && npm install && npm run dev
#    open http://localhost:3000/tournament
```

## Architecture

Six layers — see [ARCHITECTURE.md](ARCHITECTURE.md) for details.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. DATA          Binance WS · Kiyotaka REST · DuckDB replay             │
│ 2. REGIME        trending / ranging / chaotic / calm classifier         │
│ 3. SWARM         20+ agents — systematic, LLM-driven, social            │
│ 4. SCOREBOARD    rolling Sharpe + total-R ranking, Bayesian skill       │
│ 5. CONSENSUS     majority-of-top-K champions → directional signal       │
│ 6. EXECUTION     Hyperliquid EIP-712 REST + per-trade risk guard        │
│    EVOLUTION     every N events: elite preserve + mutate + crossover    │
└─────────────────────────────────────────────────────────────────────────┘
```

## Workspace layout

```
crates/
├── domain/                  pure types — Asset, Candle, Signal, Trade
├── kiyotaka-client/         REST + WS (Kiyotaka, Binance public forceOrder)
├── store/                   embedded DuckDB (event + asof timestamps)
├── econometrics/            cointegration, Granger, Hasbrouck IS, Gini
├── signal-engine/           SWP + gate evaluator (legacy, for PM research)
├── paper-trader/            deterministic ATR-based simulator
├── evaluation/              Deflated Sharpe, PSR, PBO, bootstrap CI
├── strategy/                7 crypto-native rule families + ablation bins
├── backtest/                walk-forward runner + compounding equity
├── datasource/              pluggable DataSource trait + broadcast Bus
├── regime/                  ADX/Donchian/vol classifier
├── portfolio/               vol-targeted allocator + regime weights
├── tuner/                   bounded-autonomy AI tuner (LLM tool-use)
├── exchange-hyperliquid/    EIP-712 signing + typed REST client
├── live-executor/           pythia-live binary (24/7 daemon)
└── swarm/ ★                 the tournament — agents, scoring, consensus,
                             genetic evolution, LLM personalities
apps/web/                    Next.js 15 · three.js
├── /visualize               cinematic equity-curve + strategy grid
└── /tournament ★            live 3D arena: 20 agents, champion pedestal,
                             consensus filaments, auto-reshuffling ranks
```

★ = the hero crate. Everything else feeds it or is fed by it.

## What's validated

- **365 days · Binance BTC + ETH perps · 69,026 events** replayed through 20
  agents in 0.7 s wall. Ranking + consensus report at
  `reports/swarm/<ts>/swarm.md`.
- Underlying systematic rules (grid-searched independently of the swarm) —
  `liq-trend` at 1 % risk compound: $1k → $64k over the same year with
  3 % max-DD, Sharpe 0.43, 75 % win rate across 578 trades.
- The swarm currently **discovers** this champion autonomously without
  being told which rule to run.

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
| `PYTHIA_SNAPSHOT` | ○ | `data/swarm-snapshot.json` | swarm state dump for `/tournament` |
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
