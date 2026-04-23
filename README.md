# Pythia

Prediction markets as crypto's leading indicator.

Pythia is a research-grade signal engine that treats Polymarket's elite
traders as a macro-probability oracle. When the skill-weighted probability
of a crypto-relevant prediction market drifts away from its raw mid **and**
formal econometric tests (Engle–Granger cointegration, Granger F-test,
Hasbrouck information-share proxy) confirm the prediction market is
currently leading the crypto price, Pythia fires a directional signal on
BTC or ETH perps and paper-executes it with realistic slippage, fees, and
funding cost.

## Quick start

Requires Rust 1.88+, Node 20+, a Kiyotaka Advanced-tier API key.

```sh
cp .env.sample .env      # paste KIYOTAKA_API_KEY
cargo run --release -p api --bin pythia              # terminal 1
cd apps/web && npm install && npm run dev            # terminal 2
open http://localhost:3000
```

Docker Compose: `KIYOTAKA_API_KEY=... docker compose up --build`.

Fly.io: `fly launch --copy-config --no-deploy && fly deploy`.

## Architecture

```
pythia/                         Cargo workspace, Rust 1.88
├── crates/
│   ├── domain/                 pure types; no I/O
│   ├── kiyotaka-client/        typed REST client + VCR fixtures
│   ├── polymarket-gamma/       public Gamma client (shadow + backtest)
│   ├── store/                  embedded DuckDB store (event + asof timestamps)
│   ├── ingest/                 tiered scheduler with self-governed weight budget
│   ├── integrity/              gap scan + cross-source reconciliation
│   ├── econometrics/           Engle-Granger, Granger F, Hasbrouck IS, Gini
│   ├── signal-engine/          SWP + gate evaluator; pure functional
│   ├── paper-trader/           deterministic ATR-based simulator
│   ├── evaluation/             Deflated Sharpe, PSR, PBO, bootstrap CI, timing
│   ├── strategy/               declarative strategy registry + ablation runner
│   ├── backtest/               walk-forward runner + metrics + synthetic demo
│   ├── reports/                markdown + JSON rendering for all report types
│   └── api/                    axum HTTP server + binary `pythia`
├── apps/
│   └── web/                   Next.js 15 + Tailwind + Lightweight Charts
├── fixtures/                  captured live API responses for tests
├── reports/                   generated reports
├── scripts/                   run.sh, scrape, ablate
├── Dockerfile                 multi-stage build
├── docker-compose.yml         single-command local bring-up
└── fly.toml                   Fly.io deployment
```

## Econometric framework

For each tracked market *m* with mapped asset *a*:

1. **Skill-Weighted Probability (SWP).** Bayesian posterior
   `Beta(2 + wins, 2 + losses)` mean on win rate, scaled by a log-normalised
   PnL signal and a volume factor `sqrt(n_trades / 50)`. Each wallet's weight
   is `skill_i · √position_size_i` (sub-linear to avoid whale dominance).
   `SWP = Σ w_i · implied_i / Σ w_i`.

2. **EdgeGap.** `SWP(m) − mid(m)` in probability points.

3. **Regime gate.** On rolling 80-bar windows of the PM and crypto series we
   require:
   * Hasbrouck information-share proxy `share_pm ≥ 0.15`
   * Granger F (PM → crypto) significant at 5% with `F ≥ 3.0`
   * Engle–Granger residual ADF to confirm a stable pair
   * Crypto response z-score `|z| ≤ 1.0` (hasn't been priced in)

4. **Concentration.** Gini of skill-weighted positions `≥ 0.45`.

5. **Direction.** From `(asset, sign)` map; direction is `Long` when
   `edge · sign > 0`.

Signals execute at the next bar open, stop at `1.5 × ATR`, target at
`3.0 × ATR`, time-stopped at the mapping-defined horizon.

## Quant evaluation

Every backtest runs through the `evaluation` crate which computes:

* **Probabilistic Sharpe Ratio (PSR)** (Bailey & López de Prado 2012).
* **Deflated Sharpe Ratio (DSR)** correcting for the number of trials.
* **Bootstrap CI** on Sharpe / PF / expectancy (stationary block bootstrap).
* **Probability of Backtest Overfitting (PBO)** (Combinatorial Purged CV).
* **Drawdown duration** in bars, not just magnitude.
* **Per-phase latency** (ingest, signal eval, paper-trade, metrics).

A `strategy` registry runs an *ablation grid* across variants (no econo
gate, pure Granger, pure IS, wide/tight stops, different horizons) on the
same dataset, ranks by a composite score (DSR · sign(expectancy)), and
writes a comparison report to `reports/ablation/<timestamp>/`.

## Testing

```sh
cargo test --workspace           # 70+ tests
cargo bench                      # criterion benches for hot paths
cargo run --release -p strategy --bin ablate   # full ablation on scraped data
```

## Reports

* `reports/build/phase{1..7}.md` — build phase reviews
* `reports/backtest/<name>/<hash>.{md,json}` — walk-forward results
* `reports/signals/<id>.{md,json}` — per-signal trade reports (on close)
* `reports/data-integrity/<date>.{md,json}` — daily integrity audit
* `reports/ablation/<ts>/ablation.md` — multi-strategy comparison
* `reports/runtime/<ts>.md` — engine latency percentiles

## Environment

* `KIYOTAKA_API_KEY` — required, Advanced tier
* `PYTHIA_BIND` — default `0.0.0.0:8080`
* `PYTHIA_DB` — default `data/pythia.duckdb`
* `PYTHIA_API` — front-end rewrite target, default `http://localhost:8080`
* `RUST_LOG` — default `info,pythia=debug`
