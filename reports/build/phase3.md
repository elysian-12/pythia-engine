# Phase 3 — Review

**Scope:** `econometrics`, `signal-engine`, `paper-trader`.

## Built

- **`econometrics`** — pure math crate. Four modules:
  - `basic`: Pearson, lag-k cross-correlation, lead-lag peak finder, z-score (full + rolling last), Gini coefficient.
  - `coint`: Engle-Granger two-step cointegration test with ADF(1) on residuals. Returns `beta`, `adf_tau`, residual half-life, and a 5% rejection flag (critical value -3.37, MacKinnon 1991 asymptotic).
  - `granger`: Granger causality F-test on target's own lags vs with cause's lags. Uses Fisher-Snedecor CDF for p-value.
  - `info_share`: Hasbrouck information-share proxy via variance-decomposition of the restricted VAR. Documented as a proxy, not the full Cholesky VECM — pragmatic simplification that is monotonic in the true IS for bivariate systems.

- **`signal-engine`** — pure-functional gate evaluator. `MarketState → SignalConfig → Option<Signal>`. Gates in order: edge, Gini, history, info-share(PM) ≥ θ, Granger F ≥ θ and significant at 5%, crypto response z-score, mapping lookup. Sub-module `swp` computes the skill-weighted probability via `Σ skill·√size·implied / Σ skill·√size`. Sub-module `mapping` classifies crypto-relevance with keyword heuristics.

- **`paper-trader`** — deterministic ATR-based simulator. Slippage + taker fees + funding accrual. Stop-loss 1.5 × ATR, take-profit 3 × ATR, time stop at signal horizon. Pessimistic within-bar collision rule (stop assumed first). Every call with identical inputs produces identical `Trade`.

## Tests (matching the plan's property-based + golden-vector requirements)

- `econometrics` — 14/14 (pearson, gini bounds, lead-lag peak finder, zscore edge cases, cointegration passes on cointegrated synthetic pair + fails on independent RWs, Granger no-causality high-p + strong-causality detected, info-share pm-leads-crypto detected + bounds).
- `signal-engine` — 9/9 (mapping BTC/Fed/filters, SWP skill biasing, yes/no outcome flip, evaluator fires on strong signal, rejects small edge, rejects low gini).
- `paper-trader` — 5/5 (ATR, long TP, long SL, time stop, determinism).

## Quality gates

| Gate | Result |
|---|---|
| `cargo test` for Phase 3 crates | 28/28 pass |
| Pure-functional core (no I/O) | yes — econometrics + signal-engine + paper-trader all pure |
| Deterministic simulation | yes — `determinism` test proves identical output on identical input |
| No `unwrap`/`expect` outside tests | yes |
| `RejectReason` enum for UI diagnostics | yes — see `signal_engine::RejectReason` |

## Phase 3 ✅
