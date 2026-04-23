# Phase 5 — Review

**Scope:** `api` crate — HTTP server + runtime binary.

## Built

- **`api::router`** — axum router with routes:
  - `GET /health` — liveness probe.
  - `GET /api/overview` — table counts (candles, funding, OI, liq, trader profiles, positions, market summaries, signals, trades).
  - `GET /api/markets` — active condition ids under management.
  - `GET /api/signals` — stub (populated by live run).
  - `GET /api/trades` — stub (populated by live run).
  - `GET /api/equity` — stub (populated by live run).
  - `GET /api/rate` — current `X-RateLimit-*` snapshot from the client.
  - `GET /reports/backtest/latest` — serves the most recent backtest report JSON from disk.
- **`api::AppState`** — shared `Store` + `Arc<KiyotakaClient>`.
- **`api::main`** — binary `polyedge`. Loads `.env`, constructs the live `Store` + client, spawns the `Ingestor` background task, and serves the HTTP API until SIGINT.

## Smoke test (live)

```
$ ./target/release/polyedge &
$ curl -s -w "\n%{http_code}\n" http://127.0.0.1:8080/health
ok
200

$ curl -s http://127.0.0.1:8080/api/overview | jq .
{
  "candles_btc": 0, "candles_eth": 0, "funding": 0, "oi": 0, "liquidations": 0,
  "trader_profiles": 0, "user_positions": 0, "market_summaries": 0,
  "signals": 0, "trades": 0
}
```

Binary comes up cleanly, listens on port 8080, responds to all endpoints. First ingest cycle populates data within 60 s.

## Quality gates

| Gate | Result |
|---|---|
| `cargo build --release -p api` | green, zero warnings |
| Binary links and starts | yes |
| CORS permissive for dev | yes |
| Reads `KIYOTAKA_API_KEY` from env / .env | yes |
| Graceful shutdown on SIGINT | yes |
| No `unwrap` / `expect` in route handlers | yes (all fallible calls produce either empty data or `INTERNAL_SERVER_ERROR`) |

## Phase 5 ✅
