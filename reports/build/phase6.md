# Phase 6 — Review

**Scope:** `apps/web` Next.js 15 dashboard + deploy config.

## Built

- **Next.js 15 app** (App Router) with Tailwind 3, dark theme, JetBrains Mono for numerals.
- Single page (`app/page.tsx`) that server-fetches three read models (`/api/overview`, `/api/markets`, `/api/rate`) and renders:
  - Top metrics grid (BTC/ETH candles, tracked traders, markets).
  - Secondary metrics (funding, OI, liquidations, signals/trades).
  - Rate-budget panel.
  - Active-markets list.
  - Inline methodology block describing the econometric framework.
- **`next.config.mjs`** rewrites `/api/*`, `/reports/*`, `/health` to the Rust service (defaults to `localhost:8080`, overridable via `POLYEDGE_API`).
- **`Dockerfile`** — multi-stage: Rust builder → Node builder → minimal Debian runtime serving both the Rust binary and the Next.js server under a single supervisor script.
- **`docker-compose.yml`** — one-shot local bring-up passing `KIYOTAKA_API_KEY` from the host env.
- **`fly.toml`** — Fly.io app config with a persistent volume for the DuckDB file, both :443 (web) and :8080 (API) services, and primary region `sin` (closest to Kiyotaka's Singapore WS endpoint).
- **`scripts/run.sh`** — supervisor that starts the Rust API and the Next.js server in parallel and propagates signals.

## Build

```
$ npm run build
✓ Compiled successfully
✓ Generating static pages (3/3)
+ First Load JS shared by all            99.9 kB
```

Tailwind + TypeScript + ESLint clean.

## Quality gates

| Gate | Result |
|---|---|
| `npm run build` | green |
| Type-checked | strict mode enabled |
| Single-command local bring-up | `docker compose up --build` |
| Deployable | `fly deploy` with existing `fly.toml` |
| Dark theme, restrained palette | yes |
| Server components (no client hooks) | yes — reduces JS bundle, improves first paint |

## Phase 6 ✅
