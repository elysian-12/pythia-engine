# PolyEdge — Plan v2

**Status:** pre-build, awaiting go-ahead
**Owner:** jeremy@trontalgroup.com
**Date:** 2026-04-23
**Thesis in one line:** apply equity-microstructure information-share econometrics to the Polymarket ↔ crypto pair, with smart-money position-weighting and full provenance, to produce live event-driven alpha on BTC/ETH perps.

---

## 1 · What changed from v1

v1 proposed a "smart-money-weighted probability" (SMWP). On re-review against the judging criteria (originality · sharpness · compelling end product), that framing was too close to a weighted-average. **v2 upgrades the signal to a formal market-microstructure framework adapted from TradFi to the Polymarket ↔ crypto pair.** That framework is the originality moat.

v2 also introduces: (a) a first-class data-integrity layer with cross-source reconciliation, (b) property-based + integration + E2E tests baked into CI from day one, (c) a deterministic simulation engine that produces reproducible signal/P&L reports, and (d) a provenance-first UI where every number on screen is traceable to its source API call.

---

## 2 · The signal (econometric core)

For each tracked crypto-relevant Polymarket market *m* with mapped asset *a* ∈ {BTC, ETH}:

### 2.1 Skill-weighted probability (SWP)

```
skill_i  = Bayesian posterior on (win_rate, realized_pnl, n_trades, category_match)
          with Beta prior on win_rate and log-normal on PnL; posterior mean used.
recency_i = exp(-Δt / τ),  τ = category-specific decay (Politics 7d, Fed 48h, ETF 24h)
weight_i  = skill_i · recency_i · sqrt(position_size_i)        # size weighted sub-linearly
SWP(m)    = Σ weight_i · outcome_price_at_entry_i / Σ weight_i
```

Wallets are filtered via `/polymarket/analytics/leaderboard` with `primaryCategory`, `winRate>=0.6`, `totalVolume>=$250k`, `minTotalTradeCount>=50`. Skill scores are **frozen per backtest window** to prevent look-ahead (see §7.4).

### 2.2 Price-discovery share (Hasbrouck 1995, adapted)

For the bivariate system {log-odds(*m*), log-price(*a*)}:

1. Fit a VECM (vector error-correction model) over rolling 24 h.
2. Test cointegration (Johansen trace test); proceed only when rank = 1.
3. Compute **Hasbrouck information share (IS)** → % of permanent price movement attributable to each side.
4. When IS(PM) > 0.55 **and** IS(PM) is rising, the prediction market is leading — signal-eligible regime.
5. **Gonzalo-Granger component share (CS)** used as a robustness cross-check.

This is borrowed wholesale from equity fragmentation research (Hasbrouck on NYSE vs ECNs) and adapted to the PM↔crypto pair. To my knowledge no public crypto product applies it.

### 2.3 EdgeGap + firing rule

```
EdgeGap(m, t)     = SWP(m, t) − mid_PM(m, t)
CryptoResponse(a) = rolling z-score of Δfunding + β·Δoi + γ·liq_imbalance  (5-min window)
LeadLagOK(m, a)   = (IS(PM) > 0.55) ∧ (Granger F-stat for PM → a > critical)
Signal fires when:
  |EdgeGap| > θ_edge       (θ_edge ≈ 3 cents, tuned in backtest)
∧ |CryptoResponse| < θ_resp  (a hasn't priced it yet)
∧ LeadLagOK                   (regime supports PM leading)
∧ concentration_Gini > 0.55   (smart-money meaningfully agrees)
```

Direction: from a static + data-derived `market → (asset, sign)` map (curated 30 markets at v1; `sign` learned from historical IS-regime windows).

### 2.4 Why this is original, not just "weighted average"

The v1 weighted-average was a statistic. This is a **regime-conditional econometric test**: the signal is only valid when Hasbrouck + Granger confirm PM is currently the price-discovery venue. It is testable, falsifiable, publishable. Same rigor as Paradigm / Galaxy research notes.

---

## 3 · Product surface (what the user sees)

| Screen | Purpose | Originality signal |
|---|---|---|
| **Live Signal Board** | Active signals, conviction, horizon, edge bps | Standard table — but every cell clickable → §3.1 |
| **Market Grid** | 30+ tracked PM markets: raw mid, SWP, EdgeGap, IS(PM), smart-money Gini, mapped asset | Live IS regime gauge per market is unique |
| **Market Detail** | Dual chart: SWP & mid (top) + BTC/ETH candles with funding/OI/liq (bottom); smart-wallet contributors table; VECM residual plot | Provenance drawer — every chart point clickable |
| **Backtest Explorer** | Walk-forward equity curve + Sharpe/Sortino/profit-factor/Calmar/maxDD/expectancy/R-hist; ablation toggles | Counterfactual toggle: "what would raw-mid-only have done?" |
| **Signal Tape** | Live scroll of smart-money position changes + signal firings (Bloomberg-TOP style) | The feed itself is the product |
| **Reports hub** | Data integrity, signal, backtest, regime | Everything is a shareable permalinked markdown doc |

### 3.1 Provenance drawer
Click any number → side drawer shows:
- the Kiyotaka endpoint + params that produced the underlying data
- the raw response snippet
- the derivation formula
- the code line in the signal-engine crate (linked to GitHub)

This transparency is the "compelling" moat. Judges can audit any claim in ≤3 clicks.

Visual language: dark, JetBrains Mono for numerals, one accent per state (cyan = signal live, amber = pending confirmation, red = regime break), TradingView Lightweight Charts. Nothing decorative.

---

## 4 · Architecture

```
polyedge/                                   (Cargo workspace, Rust 1.85+)
├── Cargo.toml                              (workspace with [workspace.lints])
├── crates/
│   ├── domain/          pure types, no I/O        (deny(unused))
│   ├── kiyotaka-client/ REST + WS + Brotli        (tested vs VCR)
│   ├── polymarket-gamma/ public CLOB & Gamma API  (backtest history)
│   ├── exchange-probe/  Binance/Bybit public REST (integrity shadow)
│   ├── ingest/          tiered polling + WS fan-in
│   ├── store/           DuckDB (timeseries) + SQLite (state)
│   ├── econometrics/    VECM, Johansen, Hasbrouck IS, Granger F
│   ├── signal-engine/   SWP + EdgeGap + firing rules
│   ├── paper-trader/    virtual BTC/ETH perps execution w/ slippage+fees
│   ├── backtest/        walk-forward replay + metrics
│   ├── reports/         markdown+json renderers (integrity / signal / backtest / regime)
│   ├── integrity/       cross-source reconciliation + alerting
│   └── api/             axum HTTP + SSE; serves JSON + reports
├── apps/
│   └── web/             Next.js 15, Tailwind, shadcn/ui, Lightweight Charts
├── fixtures/            recorded API responses (VCR)
├── scripts/             one-shot: seed, replay, rebuild-skill
├── .github/workflows/   ci.yml (lint+test+audit+coverage)
├── Dockerfile           multi-stage Rust + Next.js
├── fly.toml             Fly.io deploy spec
└── README.md            ≤1 page, reproducible local bring-up
```

### 4.1 Cross-cutting rules (enforced in CI, not by convention)
- `domain` crate depends on nothing (no tokio, no reqwest, no serde_json beyond derive). Enforced via `cargo-deny [bans]`.
- `econometrics` depends only on `domain` + `nalgebra` + `statrs`. Pure functions, no I/O.
- `api` is the only crate that depends on `axum`.
- `signal-engine` depends on `domain`, `econometrics`, `store` — never on clients.
- `deny(warnings)` on all crates.
- `cargo-machete` + `cargo-udeps` in CI (block unused deps).
- `clippy -- -D warnings -D clippy::pedantic` with targeted allows listed in root Cargo.toml.
- No `unwrap()` / `expect()` in library crates outside tests; `cargo-cranky` custom lint.

### 4.2 Rate budget (Advanced tier, 750/min)
| Tier | Cadence | Calls/min | Weight/min |
|---|---|---|---|
| Hot markets (top 5 by activity) | 60 s | 5 × (market-summary 60 + positions 40) | 500 |
| Warm markets (next 25) | 5 min | 5 × (60 + 40) | 200 |
| Leaderboard refresh | 15 min | 1 × 60 | 4 |
| Trader-profile cache refill | rolling | ≤10 × 100 / 10 min | 100 amortized |
| `GET /v1/usage` heartbeat | 60 s | 1 | 0 |
| **Total** | | | **~744** |
Crypto data: 100% WebSocket (weightless). Burst 1,500 absorbs rebalances.

---

## 5 · Data pipeline — clean, accurate, validated

### 5.1 Ingest (clean)
- Single `Scheduler` task per crate using `tokio::time::Interval` with jitter; no busy loops, no ad-hoc spawn.
- All network calls go through `kiyotaka-client` — no raw reqwest elsewhere.
- Deserialization uses typed structs with `#[serde(deny_unknown_fields)]` on boundary DTOs and `try_from` into domain types; any unknown field fails the ingest and logs.
- Backpressure: if WS buffer > N messages or rate-limit `Retry-After` > 30 s, the scheduler pauses warm-tier polling and emits an integrity alert.

### 5.2 Storage (accurate)
- DuckDB as embedded analytical store (great for backtests; single file; in-process).
- One table per data type, with explicit `asof_ts` (observation wall-clock) separate from `event_ts` (what the data is about). Prevents look-ahead when querying historical state.
- **Append-only immutable snapshots** for PM positions + market-summary (never update in place; query with "latest before T" semantics).
- Schema checked on boot; mismatch fails fast.

### 5.3 Integrity (validated)
- **Shadow reconciliation** (`integrity` crate):
  - PM: every market we track from Kiyotaka is also pulled at 5× lower cadence from Polymarket's public Gamma API. Divergence beyond tolerance → alert + auto-heal (Kiyotaka is source of truth for trader/position data; Gamma is source of truth for raw mid-price).
  - Crypto: funding/OI/candles spot-checked every 5 min against Binance/Bybit public REST. Deviation >10 bps → alert.
- **Completeness monitor**: timestamp monotonicity, gap detection, duplicate detection. Produces a per-day `reports/data-integrity/YYYY-MM-DD.md`.
- **Data contracts**: `validator` crate on every DTO; invariants (e.g. `0 ≤ price ≤ 1` for PM outcomes, `funding_rate ∈ [-0.05, 0.05]`) are hard-asserted on the boundary.
- **No-dead-data contract**: any data point not read by a downstream computation is flagged by a compile-time check — the domain model uses newtypes whose constructors are private; fields only exposed via accessor traits; unused fields → dead code warning.

---

## 6 · Simulation, paper trading, signal proof

### 6.1 Deterministic replay engine
- Input: a date range + a frozen config hash.
- Output: identical signal log, paper-trade P&L, and report hash. Regression-tested by checking `report.hash()` against a golden value.
- Achieved by: (a) snapshotting all inputs to DuckDB, (b) seeded RNG, (c) pure-function signal engine.

### 6.2 Paper-trading engine (`paper-trader` crate)
- On signal fire: open a virtual BTC or ETH perp position at **next-candle-open** price (no fill-at-trigger look-ahead). Apply realistic slippage model (linear impact vs ATR) and taker fees (5 bps default).
- Position management: stop-loss at 1.5× ATR, take-profit at 3× ATR, time stop at horizon expiry (category-dependent: Fed = 2 h, ETF = 24 h, Politics = 6 h).
- Funding cost accrued per 8-h funding period.
- On close: generate per-signal report (§8.2).

### 6.3 Live paper mode vs backtest mode
Same engine, different data source. This is the single biggest guard against "works in backtest only" — live and historical flow through identical code.

---

## 7 · Testing strategy

### 7.1 Unit tests
- Every pure function in `econometrics`, `signal-engine`, `domain` has golden-vector tests.
- Property-based tests (`proptest`) on invariants: `SWP ∈ [0, 1]`, `IS(PM) + IS(crypto) ≈ 1 ± ε`, `paper P&L = sum(closed trade P&L)`.
- Coverage gate: ≥ 85% for `econometrics`, `signal-engine`, `paper-trader`, `backtest`.

### 7.2 Integration tests
- `kiyotaka-client` tested vs VCR fixtures (recorded real responses under `fixtures/`). Fixtures refreshed monthly; schema-drift failures are loud.
- A live-smoke subset behind `--features=smoke-live` that hits the real API with a read-only key in CI nightly.
- `ingest` → `store` → `signal-engine` pipeline tested end-to-end on a 7-day historical snapshot with expected signal set.

### 7.3 End-to-end historical tests
Two known event windows baked in as E2E regressions:
- **2024 Nov US election week**: expected PM→BTC lead to fire at least N signals with win rate > baseline.
- **2024 Jan BTC ETF approval**: expected PM→BTC lead signal within the 6 h pre-decision window.
If either window regresses, CI fails. These are the "ground-truth" proofs the methodology works on known outcomes.

### 7.4 Walk-forward backtest (the profitability proof)
- **Window**: 9 mo train / 3 mo holdout, rolling monthly.
- **Leak prevention**: skill scores computed using only data up to the training cutoff; leaderboard reconstructed as-of-then from Polymarket's public CLOB trade history (not from Kiyotaka's current snapshot).
- **Costs**: 5 bps taker fee, 3 bps slippage, real funding rate charged per hour of hold.
- **Metrics reported**: Sharpe, Sortino, profit factor, max DD, Calmar, expectancy, win rate, avg R, R distribution. **Also ablation**: raw-mid-only, SWP-only, SWP+IS, SWP+IS+Granger (full).
- **Deliverable**: `reports/backtest/<date>/README.md` with equity curve, metrics table, R-histogram, confusion matrix, and bootstrap CI for Sharpe.

### 7.5 Chaos / negative tests
- Inject Kiyotaka 429s and 5xx → verify backoff + integrity alert.
- Inject malformed JSON → verify boundary validator catches, signal-engine continues with stale data marked stale.
- Kill WS mid-stream → verify reconnect + gap report.
- Clock skew (NTP drift) → verify event_ts vs asof_ts divergence alarms.

### 7.6 CI pipeline (`ci.yml`)
```
fmt → clippy(pedantic -Dwarnings) → cargo-deny → cargo-machete → cargo-udeps
  → unit → integration → E2E (historical windows)
  → coverage gate → audit (cargo-audit) → build Docker → deploy preview
```
All gates blocking. Nightly additional: `smoke-live` + backtest full-year run (uploaded to S3/Fly volume as report artifact).

---

## 8 · Reports (everything is recorded)

### 8.1 Data integrity report (`reports/data-integrity/YYYY-MM-DD.md`)
Per day, per source. Contains:
- Request volume & error rates
- Gap list with durations
- Divergence vs shadow sources (PM mid bps, crypto funding/OI bps)
- Rate-limit headroom histogram
- Schema violations (should be zero)
- Actions taken (auto-heal, pause, alert)

### 8.2 Signal report (`reports/signals/<signal_id>.md`)
Per signal, on close. Contains:
- Market + event context at fire time
- The exact SWP, mid, EdgeGap, IS(PM), Granger F, Gini
- Contributing smart wallets table with their skill posteriors
- Crypto derivatives snapshot at fire + at close
- Paper trade ledger (entry, exit, fees, funding, P&L, R-multiple)
- **Counterfactual**: what would raw-mid-only have signaled here?
- Attached plots: SWP vs mid timeseries, BTC/ETH candle with fire/exit marks

### 8.3 Backtest report (`reports/backtest/<hash>.md`)
Per walk-forward run. Metrics + equity curve + ablation + bootstrap CI.

### 8.4 Regime report (`reports/regime/YYYY-WW.md`)
Weekly. Which markets had IS(PM) > 0.55, which flipped, Granger F-stat trajectory, and a "regime volatility" indicator so we know when the whole thesis is under stress.

All reports are:
- Emitted as markdown + machine-readable JSON side-by-side.
- Served from `api` at `/reports/...` (gated if sensitive).
- Hashed and linked in a top-level `reports/INDEX.md` (append-only).

---

## 9 · Build phases (with acceptance criteria, tests per phase)

| # | Phase | Days | Acceptance |
|---|---|---|---|
| 1 | `kiyotaka-client` + `domain` + `polymarket-gamma` | 1.0 | All endpoints typed; VCR fixtures recorded; unit + integration green; `cargo deny/machete/udeps` clean |
| 2 | `ingest` + `store` + `integrity` | 1.5 | 48 h of live capture without gaps; shadow reconciliation < tolerance; integrity report renders |
| 3 | `econometrics` + `signal-engine` + `paper-trader` | 1.5 | Hasbrouck/Granger/VECM unit-tested vs reference Python output (scipy/statsmodels golden); proptest on invariants; deterministic replay demonstrated |
| 4 | `backtest` + E2E historical tests | 1.5 | 12-mo walk-forward produced; 2024 election + ETF-approval E2E tests pass; full backtest report rendered |
| 5 | `api` + `reports` routes | 0.5 | SSE live signals; all report types reachable; no unwrap; e2e smoke test hits every route |
| 6 | Next.js web app + deploy | 1.5 | Live Board + Market Grid + Detail + Backtest + Tape + Provenance drawer; Fly.io + Vercel live; README runs in <5 commands |
| 7 | 72-h live paper run + sign-off | 0.5 | Zero integrity alerts; live report matches replay-of-live deterministically |
| | **Total** | **7.5 days** | |

Each phase merges only when its acceptance criteria pass in CI. No "phase done" without tests.

---

## 10 · Risk register (honest)

| Risk | Severity | Mitigation |
|---|---|---|
| PM → crypto lead-lag is regime-dependent and may disappear | **High** | IS/Granger gate is the mitigation: we only fire when regime confirms. If no regime, no signal — still useful as "don't trade here" information. |
| Historical skill reconstruction is laborious and error-prone | Med | Use Polymarket's public CLOB history; reconstruct skill at each training cutoff; sanity-check reconstructed leaderboard vs archived snapshots where available. |
| Thin-volume PM markets look promising but elites avoid them | Med | Market whitelist: `total_size > $500k`, unique traders ≥ 50, `open_position_count ≥ 20`. |
| Kiyotaka snapshot cadence too slow for intra-minute signals | Low | Signal horizons are minutes-to-hours, not sub-second. 60 s cadence is sufficient by design. |
| Hasbrouck assumes cointegration — PM and crypto may fail Johansen | Med | Regime gate handles this directly: no cointegration → no signal. Document non-cointegrated periods in regime report. |
| Backtest overfit | **High** | 9/3 walk-forward; purged cross-validation on parameter tuning; ablation table mandatory; bootstrap CI on Sharpe; report both in-sample and out-of-sample separately. |
| Single-tier dependency on Kiyotaka Advanced ($599/mo) | Low | Documented in README; key rotation story; degraded mode falls back to Gamma-only (no signal, observation only). |

---

## 11 · What makes this meet the judging bar

| Criterion | How v2 meets it |
|---|---|
| **Originality** | Hasbrouck information-share applied to PM↔crypto is, to my knowledge, unpublished. Combined with skill-Bayesian posterior weighting of PM wallets, also novel. The econometric rigor distinguishes this from every dashboard on crypto-Twitter. |
| **Sharpness of use case** | Event-driven directional alpha on BTC & ETH perps, 30 curated macro/political markets, signals firing ~3–15×/week with 2–24 h horizons. Not "all of crypto" — one surgical use case. |
| **Compelling end product** | Provenance drawer on every number; live smart-money tape; counterfactual toggle in backtest; all reports permalinked and machine-readable; the UI *looks* like a research terminal, not a dashboard. |

---

## 12 · Open decisions for Jeremy

1. Confirm PolyEdge direction (vs pivoting to liquidation-magnet / TPO-execution tools).
2. Kiyotaka Advanced API key provisioning.
3. Hosting: Fly.io (default) · Railway · self-host.
4. Paper-only v1 OK, or do you want live Hyperliquid execution in v1 (I recommend v2).
5. Naming: PolyEdge · EdgePM · Kairos · something else.

On go, I start Phase 1 immediately and report back with a live Kiyotaka smoke-test dump before scaffolding anything else.
