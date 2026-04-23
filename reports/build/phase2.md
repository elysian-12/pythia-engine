# Phase 2 — Review

**Scope:** `ingest`, enhanced `store`, `integrity`, `reports` crate scaffolded.

## Built

- **`ingest`** — tiered polling orchestrator: hot markets every 60 s, leaderboard every 15 pm-ticks, crypto feeds every 60 s. Self-governed `WeightBudget` (token bucket) so the pipeline doesn't rely on server headers that may not be populated. `Ingestor<S: DataSource>` parametric over the data source for testability.
- **`store`** — DuckDB schema for candles, funding, OI, liquidations, trader profiles, user positions, market summaries, signals, trades. Dual timestamp (`event_ts` + `asof_ts`) prevents look-ahead. Upserts + queries + counts.
- **`integrity`** — gap scanner + non-monotonic detector over stored candles; markdown + JSON report renderer. Gamma-based shadow reconciliation wired in (active markets listing), ready for richer coverage once we have stored summaries in production.
- **`reports`** — markdown + JSON pair renderer for `BacktestReport` and `SignalReport`.

## Tests

- `ingest::budget` — 2/2 (token accumulation + wait-for-refill timing).
- `ingest::discovery` — 3/3 (crypto category match, keyword match, off-topic rejection).
- `ingest::tests` integration — 1/1 (mock `DataSource` → store roundtrip exercising every refresh path).
- `integrity` — 4/4 (gap detection, non-monotonic detection, clean sequence, report render).

## Quality gates

| Gate | Result |
|---|---|
| `cargo build -p ingest -p integrity -p reports -p store` | green, zero warnings |
| Unit + integration | 10/10 pass |
| `unwrap`/`expect` in library code | none |
| Dead code | none |
| Data-source trait abstraction | yes (`LiveSource` + `MockSource` in tests) |
| Self-governed rate budget | yes (token bucket, async reserve) |
| Dual-timestamp schema | yes |

## Phase 2 ✅

Risks carried: (1) shadow reconciliation with Gamma still covers only active-conditions listing — deep payload diff is a follow-up; (2) initial run may produce empty `market_summaries` because the first wallets surfaced from the leaderboard return historical positions (2022 US Senate) with no active crypto-relevant conditions. Mitigated by recursive position discovery via `/positions?conditionId=...` in subsequent ticks.
