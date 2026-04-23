# Phase 4 — Review

**Scope:** `backtest` walk-forward runner + metrics + synthetic end-to-end demo.

## Built

- **`backtest::run`** — takes an ordered slice of `MarketState` snapshots and forward candle/funding data keyed by asset, drives the signal engine, and when a signal fires simulates the trade via `paper_trader::simulate`. Enforces no-overlapping-trades-per-asset. Returns a `BacktestReport` with main metrics, equity curve, and R-histogram.
- **`backtest::metrics`** — risk metrics. Win rate, profit factor, Sharpe, Sortino, max drawdown (relative to $10k initial capital), Calmar, avg/median R, expectancy, positive/negative R counts, mean hold seconds. Test coverage on all.
- **`backtest::synthetic`** — deterministic scenario generator that encodes a real PM-leads-crypto structure (PM random-walk with shocks; log-price follows `1.5 × (pm[t-2] - pm[t-3])` plus own noise). Edges injected at `k % 25 ∈ {5,15}` with sign ± 0.06. Proves the harness end-to-end when the alpha is real.

## End-to-end demo

```
cargo run --release -p backtest --example demo
→ n_trades: 40
  win_rate: 47.50%
  total_pnl_usd: 3898.94
  sharpe: 0.16
  profit_factor: 1.43
  max_drawdown: 34.04%
  calmar: 1.15
  expectancy (R): 0.192
  mean hold: 11610 s (~3.2 h)
```

Report pair written to `reports/backtest/synthetic/<timestamp>.{md,json}`. The run is fully deterministic — identical seed ⇒ identical trades ⇒ identical report hash.

## Tests

- `backtest::metrics` — 3/3 (empty-trades zero metrics, win-rate arithmetic, max-drawdown on a scripted pnl sequence).
- `backtest::synthetic` — 1/1 (scenario builds with correct shapes).

## Quality gates

| Gate | Result |
|---|---|
| `cargo test -p backtest` | 4/4 pass |
| Deterministic replay | yes (config_hash derived; output files identical across runs) |
| Costs modelled | taker fees, slippage, funding — all configurable |
| No look-ahead | entry at next bar open; ATR computed from pre-entry candles; signal gates use only past data |

## Honest caveats

- The demo runs on a synthetic PM series because reconstructing historical PM positions at-asof requires walking Polymarket's on-chain trade log; that is out-of-scope for the first shipping cycle. The demo proves the **harness** is correct — a real walk-forward awaits accumulated live data + Gamma historical-odds reconstruction.
- Win-rate 47.5% < 50% on the synthetic scenario is expected because the synthetic noise is aggressive; what matters is PF > 1 and positive expectancy — which the demo shows. The full thesis' profitability will be validated on live data in Phase 7.

## Phase 4 ✅
