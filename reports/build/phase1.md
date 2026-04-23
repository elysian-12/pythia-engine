# Phase 1 — Review

**Scope:** Rust workspace, `domain`, `kiyotaka-client`, `polymarket-gamma`, `store`, VCR fixtures, live smoke test.

## Built

- **Workspace** (Cargo, Rust 1.88): 12 member crates. 4 fully implemented, 8 stubs for later phases.
- **`domain`**: pure types — `Asset`, `Candle`, `FundingRate`, `OpenInterest`, `Liquidation`, `UserPosition`, `TraderProfile`, `MarketSummary`, `Signal`, `Trade`. Dual-timestamp model (`AsofTs` vs `EventTs`) that structurally prevents look-ahead. Bayesian skill-score with Beta(2,2) prior on win-rate, log-normalised PnL signal, volume penalty for small samples.
- **`kiyotaka-client`**: typed REST client for all endpoints PolyEdge needs — candles, funding rate, open interest, liquidations, Polymarket leaderboard/trader-profile/positions/market-summary. `RateTracker` reads response headers.
- **`polymarket-gamma`**: public Gamma-API shadow client for integrity cross-check and backtest odds continuity.
- **`store`**: DuckDB embedded store with full schema (candles, funding, OI, liq, positions, trader profiles, market summaries, signals, trades), append-only snapshot semantics, indexed by `(asset, event_ts DESC)`.

## Tests

```
cargo test -p domain -p kiyotaka-client
```
- `domain::trader::tests::*` — 4/4 (skill bounds, small-sample penalty, elite high-score, negative-pnl capped).
- `kiyotaka_client::parsing::tests::*` — 7/7 decoding candles/funding/OI/liquidations/leaderboard/positions/market-summary from VCR fixtures recorded from the live API.
- `store::tests::*` — 2/2 (schema boot, roundtrip).

## Live smoke

```
cargo run -p kiyotaka-client --example smoke
```
```
candles: n=2 last_close=78823.00
funding: n=24 last_close=-2.209e-5
oi: n=24 last_close=104370.00
liquidations: n=47
leaderboard: n=10
  0xf1302aafc43aa3a69bcd8058fc7a0259dac246ab pnl=94916520 win_rate=80.7% trades=1047
  0x3d8a89a20aa73fba0f30d080e8120de9f9555724 pnl=49366828 win_rate=83.8% trades=291
trader-profile: pnl=94916520
positions(wallet): 'Which party will control the U.S. Senate after the 2022 election?' (Politics)
market-summary: event_id=3506 open=25 closed=1890 win_rate=0.53
OK
```

Every endpoint returned live data and decoded cleanly.

## Quality gates

| Gate | Result |
|---|---|
| `cargo build --workspace` | green, zero warnings |
| Unit tests (`domain` + `kiyotaka-client` + `store`) | 13/13 green |
| Live API smoke | all endpoints green |
| `unwrap()` in library code | none outside `#[cfg(test)]` |
| Dead DTO fields | stripped |
| Toolchain pin | rust-toolchain.toml = 1.88 |

## Risks tracked into Phase 2

1. Kiyotaka does not appear to populate `X-RateLimit-*` headers for our key. Scheduler must self-govern via a rolling in-process weight counter.
2. `positions(conditionId)` returned a small n in the smoke test — the sample condition is historical (2022 US Senate). Phase 2 market discovery must filter by live/active status.
3. WebSocket client not yet implemented. REST cadence is sufficient for signal horizons (minutes-to-hours), so WS is deferred to a later phase for live-feed latency compression.

## Phase 1 ✅ — proceeding to Phase 2
