# CLAUDE.md — repo conventions for AI assistants

Pythia is an agent-swarm crypto trading system. Rust for the trading core,
Next.js/React for the live-tournament UI. Read [README.md](README.md) and
[SWARM.md](SWARM.md) before touching code.

## Flow map (where everything lives)

```
Kiyotaka REST ──▶ ingest ──▶ store (DuckDB) ──▶ signal-engine ──▶ paper-trader ──▶ reports
                                                   │
                                                   └──▶ swarm (25 agents) ──▶ scoreboard ──▶ champion
                                                                                  │
                                                                                  ▼
Binance WS ──────▶ live-executor ─────────── champion ─────────▶ exchange-hyperliquid (EIP-712)
                         │
                         └──▶ data/swarm-snapshot.json ──▶ apps/web/api/swarm ──▶ tournament UI
```

- Crate-to-crate calls go through the path above. Do not call `store` from
  the UI; always via `crates/api` or a bundled snapshot.
- The UI polls `data/swarm-snapshot.json` (via `/api/swarm`) and never reads
  DuckDB directly — Vercel has no filesystem for the live file, so prod uses
  the bundled copy in `apps/web/public/swarm-snapshot.json` (built by
  `scripts/bundle-snapshot.mjs`).

## Crate ownership (don't duplicate; extend the right one)

| Concern | Crate | Notes |
| --- | --- | --- |
| Types (Asset, Signal, Trade) | `domain` | Shared across everything |
| Kiyotaka HTTP client | `kiyotaka-client` | All API calls route here |
| DuckDB persistence | `store` | Candles, funding, liquidations, OI |
| Ingestion loop | `ingest` | Scrapers + scheduler |
| Rule evaluation | `signal-engine` | Stateless; inputs `MarketState` |
| Paper-trader | `paper-trader` | ATR-risk sizing, fees, funding, slippage |
| Risk metrics (Sharpe etc.) | `backtest::metrics` | Also used by strategy |
| Walk-forward runner | `backtest` | `run`, `run_signal_stream`, `_compound` |
| PSR / DSR / PBO / bootstrap | `evaluation` | Quant-grade significance tests; PBO is wired into `swarm-backtest` certification (matrix from agent R-histories ÷ 8 splits) |
| Grid search, ablations | `strategy` | Calls `backtest` + `evaluation` |
| Cointegration, Granger F, Hasbrouck IS | `econometrics` | Wired into `RuleFamily::PolyEdge` — `decide_for_asset` runs `cointegration_test` → `granger_f` → `information_share_proxy` against `PeerView::polymarket_history` before firing |
| Agent roster, scoreboard, evolution | `swarm` | The tournament runtime — `Evolution::advance` ranks elites by `recent_expectancy_r × √n_recent` (NOT lifetime `total_r`), so long-running seeds don't permanently lock the elite slot |
| WS + HL execution | `live-executor`, `exchange-hyperliquid` | `swarm_live.rs` binary is canonical |
| HTTP API for the UI | `api` (axum) | `/overview`, `/markets`, `/rate` |
| Regime tagging | `regime` | Trending/ranging/chaotic/calm |
| Portfolio accounting | `portfolio` | |
| Hyperparameter tuning | `tuner` | |

Before adding a new crate, check whether the concern lives in one of these.

## Evaluation / backtest integration (do not leave dead code)

Any new metric must be wired in end-to-end:

1. Add the pure function to `evaluation` (if a significance test) or to
   `backtest::metrics` (if a per-trade roll-up).
2. Call it from the runner(s) that produce reports:
   - `strategy::runner` for research runs
   - `strategy::bin::find_best_v2` for grid search
   - `strategy::bin::real_ablate` for ablations (writes JSON under `reports/`)
3. Surface the number in the report struct (`reports` crate) so the UI or
   CLI summary prints it.
4. If the UI should show it, extend `apps/web/lib/swarm.ts` and the
   snapshot writer in `swarm/src/bin/swarm_backtest.rs` /
   `live-executor/src/bin/swarm_live.rs`.

If a new function in `evaluation` or `backtest` isn't called from one of
the bins listed in step 2, it's dead code — either wire it in or delete it.

## Determinism + provenance

- All randomness uses a **seeded PRNG** (`rand::rngs::SmallRng::seed_from_u64`).
  Seeds are logged in the report's `config_hash` so replays match bit-for-bit.
- Every paper trade records `data_provenance` in the report. If you source
  candles / funding / liquidations from a new endpoint, thread that endpoint
  URL through `reports::BacktestReport::data_provenance`.

## Commit style

**No Claude watermark.** Skip the `Co-Authored-By: Claude` trailer. One-line
imperative subject, then a one-paragraph body describing _why_ (the what is
in the diff). Group related changes into a single commit.

## Rust conventions

- Workspace lints are on `clippy::pedantic = warn`. Clean up lints you
  introduce rather than adding allows.
- `unsafe_code = forbid` workspace-wide. If you think you need unsafe, you
  don't.
- `unused_must_use = deny`. Return `Result` from anything that can fail and
  let the caller decide.
- `#![deny(unused_must_use)]` at every crate root.
- Prefer `anyhow::Result<_>` in bins, `thiserror`-derived types in libs.
- Time is always `i64` seconds in `EventTs` / `AsOfTs` (two-timestamp
  integrity rule: candle timestamps vs decision timestamps, never mixed).

## UI conventions (`apps/web`)

- Tailwind only. Custom colors: `ink`/`panel`/`edge`/`mist`/`cyan`/`amber`/
  `red`/`green`. The `.panel` / `.chip` / `.num` utility classes in
  `globals.css` are the design system — use them instead of raw colors.
- Numeric UI uses `font-mono` + `tabular-nums` via the `.num` class so
  trade tickers don't jitter as digits change.
- Client state lives in the component that owns it. Cross-cutting state
  lives in `TournamentClient.tsx` (paper positions, marks, autopilot
  status). Don't add global state managers.
- Components talk to Next route handlers under `app/api/*`. No direct
  `fetch()` to api.kiyotaka.ai from the browser — the key lives server-side.
- `lib/simulate.ts` mirrors the Rust `SystematicAgent` decision logic at a
  coarse level for the what-if UI preview. If you change agent rules in
  Rust (`swarm/src/systematic.rs`), update `simulateReactions` to match.
- Paper HL ledger (`lib/paper.ts`) is the source of truth for the
  Hyperliquid panel. Stop / TP checks flow through `checkTriggers` so the
  same invariants hold whether positions close via mark sweep or user
  click.
- Portfolio meta-agent (`lib/portfolio.ts`) sits between the router and
  the ledger. `decideEntry` decides skip / open / reverse on a fresh
  signal; `manageOnMark` runs trail + time-stop sweeps on every mark
  refresh; `manageOnEvent` closes positions when the swarm votes
  opposite at high conviction. The five rules
  (`max_open_positions` / `min_conviction` / `time_stop_hours` /
  `trail_after_r` / `swarm_flip_conviction`) live in `PortfolioConfig`,
  are exposed in `SettingsForm`, and persist through `/api/config`.
  Once the live executor gets a real HL key, the same rules port to
  Rust as `crates/portfolio/src/meta.rs` with identical semantics.

## Adding a new feature

Checklist for the AI assistant:

1. **Where does the logic live?** Match it to an existing crate /
   directory before creating a new one.
2. **Is it wired in?** Library code must have a caller in a bin, test, or
   exposed API. If you're adding a new `pub fn`, add a call-site in the
   same commit.
3. **Tests?** Unit tests go next to the module. Integration tests under
   `crates/<crate>/tests/`. UI work: run `npx tsc --noEmit` from
   `apps/web` and fix all errors before committing.
4. **Provenance?** New data source → `reports::BacktestReport::data_provenance`.
5. **Docs?** Update `SWARM.md` if you change the tournament flow,
   `ARCHITECTURE.md` for structural changes, and README only for
   user-visible workflow changes.

## Environment

Required for live UI work:

```
KIYOTAKA_API_KEY=...       # apps/web/api/kiyotaka + /api/signals + /api/marks
ANTHROPIC_API_KEY=...      # LLM agents; falls back to MockLlmDecider if absent
```

Optional:

```
PYTHIA_SNAPSHOT=/path/to/swarm-snapshot.json    # override snapshot source
PYTHIA_EVOLVE_EVERY=500                          # evolution cadence
```

## Vercel deployment

- Root Directory = `apps/web`
- Build Command = default (`next build`; `prebuild` bundles the snapshot)
- Env vars: `KIYOTAKA_API_KEY` (required for the live badges to go green),
  optional `GITHUB_DISPATCH_PAT` + `CRON_SECRET` if you use the relay
  route at `/api/cron/refresh`.
- The repo-root `data/swarm-snapshot.json` is NOT available on Vercel — the
  bundler script copies it into `apps/web/public/` at build time.

## Hourly snapshot refresh (production)

The deployed snapshot stays fresh via cron-job.org → GitHub's
`repository_dispatch` endpoint → `.github/workflows/refresh-snapshot.yml`.
Workflow runs `swarm-backtest`, bundles, prunes
`reports/swarm/<ts>/` older than the last 168, commits, Vercel
auto-redeploys. Runtime ~2-3 min warm. **The PAT must have `Contents:
Read and write`** — `Actions: Write` alone returns `403 Forbidden`
(the GitHub docs at the top of the dispatch endpoint say "must have
admin access" but the actual fine-grained scope is `contents=write`,
visible in the response's `x-accepted-github-permissions` header).
Full walkthrough + troubleshooting in [docs/CRON_SETUP.md](docs/CRON_SETUP.md).

## Persistent state TTL

- `r_history` per agent capped at `R_HISTORY_CAP = 500` in
  `crates/swarm/src/scoring.rs`. Keeps `swarm-population.json` ≤ ~100 KB.
- `reports/swarm/<ts>/` pruned to the last 168 (one week of hourly runs)
  by the workflow's "Prune old reports" step. Local helper:
  `scripts/prune-reports.sh --keep N --dry-run`.
- `localStorage["pythia-closed-positions"]` capped at 500 trades in
  `apps/web/components/tournament/TournamentClient.tsx`.

## Known pitfalls

- Don't store timestamps as `f64`. Always `i64` seconds.
- Don't call `fs.readFile` in Next route handlers without falling back to
  the bundled `public/` copy — Vercel's filesystem is read-only and does
  not include the repo root.
- Don't mock in integration tests that hit `store` — use the in-memory
  DuckDB fixture from `crates/store/tests/common.rs`.
- PeerView reads from the scoreboard _snapshot_ from the previous event,
  not live. Do not wire in-flight decisions — creates feedback loops.
