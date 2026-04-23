# Pythia — real-data profitability report

- Dataset: Binance Futures BTC + ETH, hourly candles + funding + OI + liquidations, 365 days.
- Window: 2025-04-25 → 2026-04-23 UTC (1 year).
- Paper execution: 5 bps taker, 3 bps slippage, funding accrued at market rate.
- Sizing: $10,000 notional per signal; no compounding; no leverage.
- PBO across grid: **0.00**
- Wall-clock: 0.36 s

## Strategy ranking

| # | Strategy | Signals | Trades | PnL USD | WinRate | PF | Sharpe | Sortino | MaxDD | Calmar | PSR | DSR | Sharpe 95% CI | Score |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `vol-breakout` | 410 | 410 | +48003 | 67.8% | 4.09 | +0.62 | +0.85 | 3.3% | 146.31 | 1.00 | 0.00 | [+0.51, +0.73] | +0.000 |
| 2 | `liq-trend` | 578 | 578 | +53421 | 74.9% | 6.01 | +0.65 | +1.04 | 1.7% | 319.27 | 1.00 | 0.00 | [+0.58, +0.74] | +0.000 |
| 3 | `ensemble-trend` | 654 | 613 | +50190 | 65.9% | 3.39 | +0.48 | +0.72 | 3.3% | 151.86 | 1.00 | 0.00 | [+0.40, +0.57] | +0.000 |
| 4 | `oi-trend` | 199 | 199 | +7778 | 52.3% | 1.77 | +0.23 | +0.35 | 7.6% | 10.25 | 1.00 | 0.00 | [+0.08, +0.37] | +0.000 |
| 5 | `funding-trend` | 312 | 312 | +8082 | 49.0% | 1.44 | +0.15 | +0.23 | 12.2% | 6.61 | 1.00 | 0.00 | [+0.04, +0.25] | +0.000 |
| 6 | `ensemble` | 576 | 560 | -37802 | 22.0% | 0.31 | -0.51 | -0.88 | 100.0% | -3.78 | 0.00 | 0.00 | [-0.62, -0.40] | -0.000 |
| 7 | `liq-fade` | 578 | 578 | -56979 | 11.1% | 0.08 | -1.10 | -1.59 | 100.0% | -5.70 | 0.00 | 0.00 | [-1.27, -0.96] | -0.000 |
| 8 | `funding-reversion` | 312 | 312 | -13057 | 28.5% | 0.51 | -0.28 | -0.46 | 100.0% | -1.31 | 0.00 | 0.00 | [-0.42, -0.16] | -0.000 |
| 9 | `oi-divergence` | 199 | 199 | -10980 | 30.7% | 0.41 | -0.39 | -0.65 | 100.0% | -1.10 | 0.00 | 0.00 | [-0.57, -0.22] | -0.000 |

## Stress test — doubled costs (10 bps fee + 5 bps slippage)

| Strategy | Trades | PnL USD | Sharpe | MaxDD | Δ PnL vs base |
|---|---|---|---|---|---|
| `liq-trend-stress` | 578 | +46645 | +0.57 | 1.9% | -6776 |
| `vol-breakout-stress` | 410 | +42719 | +0.55 | 4.1% | -5284 |
| `ensemble-trend-stress` | 613 | +42750 | +0.41 | 4.8% | -7440 |
| `oi-trend-stress` | 199 | +5584 | +0.16 | 10.0% | -2193 |
| `funding-trend-stress` | 312 | +3560 | +0.06 | 19.6% | -4522 |
| `funding-reversion-stress` | 312 | -16605 | -0.36 | 100.0% | -3549 |
| `oi-divergence-stress` | 199 | -13250 | -0.47 | 100.0% | -2270 |
| `ensemble-stress` | 561 | -44608 | -0.60 | 100.0% | -6805 |
| `liq-fade-stress` | 578 | -63074 | -1.22 | 100.0% | -6095 |

## Buy-and-hold baselines

| Asset | Final PnL USD | Sharpe (ann.) | Max DD | Calmar |
|---|---|---|---|---|
| `buy-hold/BTC` | -1675 | -0.23 | 50.1% | -0.33 |
| `buy-hold/ETH` | +3059 | +0.74 | 63.2% | 0.48 |

## Equity curves

- `vol-breakout`: 411 points, final equity `+48002.87 USD` on $10k base.
- `liq-trend`: 579 points, final equity `+53420.70 USD` on $10k base.
- `ensemble-trend`: 614 points, final equity `+50189.78 USD` on $10k base.
- `oi-trend`: 200 points, final equity `+7777.68 USD` on $10k base.
- `funding-trend`: 313 points, final equity `+8082.36 USD` on $10k base.
- `ensemble`: 561 points, final equity `-37802.26 USD` on $10k base.
- `liq-fade`: 579 points, final equity `-56979.39 USD` on $10k base.
- `funding-reversion`: 313 points, final equity `-13056.53 USD` on $10k base.
- `oi-divergence`: 200 points, final equity `-10979.67 USD` on $10k base.

## R-multiple distribution (per strategy)

### `vol-breakout`

| R bucket | count |
|---|---|
| -2.5 | 0 |
| -2.0 | 0 |
| -1.5 | 0 |
| -1.0 | 113 |
| -0.5 | 8 |
| +0.0 | 21 |
| +0.5 | 9 |
| +1.0 | 5 |
| +1.5 | 2 |
| +2.0 | 252 |
| +2.5 | 0 |
### `liq-trend`

| R bucket | count |
|---|---|
| -2.5 | 0 |
| -2.0 | 0 |
| -1.5 | 1 |
| -1.0 | 59 |
| -0.5 | 46 |
| +0.0 | 83 |
| +0.5 | 112 |
| +1.0 | 64 |
| +1.5 | 28 |
| +2.0 | 185 |
| +2.5 | 0 |
### `ensemble-trend`

| R bucket | count |
|---|---|
| -2.5 | 0 |
| -2.0 | 0 |
| -1.5 | 4 |
| -1.0 | 129 |
| -0.5 | 40 |
| +0.0 | 73 |
| +0.5 | 66 |
| +1.0 | 38 |
| +1.5 | 24 |
| +2.0 | 239 |
| +2.5 | 0 |
### `oi-trend`

| R bucket | count |
|---|---|
| -2.5 | 0 |
| -2.0 | 0 |
| -1.5 | 0 |
| -1.0 | 53 |
| -0.5 | 21 |
| +0.0 | 35 |
| +0.5 | 23 |
| +1.0 | 15 |
| +1.5 | 5 |
| +2.0 | 47 |
| +2.5 | 0 |
### `funding-trend`

| R bucket | count |
|---|---|
| -2.5 | 0 |
| -2.0 | 0 |
| -1.5 | 7 |
| -1.0 | 119 |
| -0.5 | 18 |
| +0.0 | 28 |
| +0.5 | 30 |
| +1.0 | 20 |
| +1.5 | 8 |
| +2.0 | 82 |
| +2.5 | 0 |
### `ensemble`

| R bucket | count |
|---|---|
| -2.5 | 0 |
| -2.0 | 0 |
| -1.5 | 9 |
| -1.0 | 379 |
| -0.5 | 33 |
| +0.0 | 37 |
| +0.5 | 30 |
| +1.0 | 20 |
| +1.5 | 7 |
| +2.0 | 45 |
| +2.5 | 0 |
### `liq-fade`

| R bucket | count |
|---|---|
| -2.5 | 0 |
| -2.0 | 0 |
| -1.5 | 10 |
| -1.0 | 435 |
| -0.5 | 37 |
| +0.0 | 57 |
| +0.5 | 17 |
| +1.0 | 12 |
| +1.5 | 2 |
| +2.0 | 8 |
| +2.5 | 0 |
### `funding-reversion`

| R bucket | count |
|---|---|
| -2.5 | 0 |
| -2.0 | 0 |
| -1.5 | 6 |
| -1.0 | 177 |
| -0.5 | 19 |
| +0.0 | 31 |
| +0.5 | 24 |
| +1.0 | 12 |
| +1.5 | 4 |
| +2.0 | 39 |
| +2.5 | 0 |
### `oi-divergence`

| R bucket | count |
|---|---|
| -2.5 | 0 |
| -2.0 | 0 |
| -1.5 | 0 |
| -1.0 | 112 |
| -0.5 | 14 |
| +0.0 | 27 |
| +0.5 | 18 |
| +1.0 | 10 |
| +1.5 | 6 |
| +2.0 | 12 |
| +2.5 | 0 |

## Runtime latency

| Phase | N | Total | Mean | P50 | P95 | P99 | Max |
|---|---|---|---|---|---|---|---|
| load:btc | 1 | 15.648ms | 15648.21µs | 15648.21µs | 15648.21µs | 15648.21µs | 15648.21µs |
| backtest:ensemble-trend | 1 | 15.608ms | 15607.71µs | 15607.71µs | 15607.71µs | 15607.71µs | 15607.71µs |
| backtest:liq-fade | 1 | 15.334ms | 15334.04µs | 15334.04µs | 15334.04µs | 15334.04µs | 15334.04µs |
| backtest:ensemble | 1 | 14.138ms | 14137.75µs | 14137.75µs | 14137.75µs | 14137.75µs | 14137.75µs |
| backtest:liq-trend | 1 | 13.961ms | 13960.67µs | 13960.67µs | 13960.67µs | 13960.67µs | 13960.67µs |
| backtest:vol-breakout | 1 | 10.761ms | 10761.17µs | 10761.17µs | 10761.17µs | 10761.17µs | 10761.17µs |
| load:eth | 1 | 10.239ms | 10239.17µs | 10239.17µs | 10239.17µs | 10239.17µs | 10239.17µs |
| backtest:funding-reversion | 1 | 9.133ms | 9132.75µs | 9132.75µs | 9132.75µs | 9132.75µs | 9132.75µs |
| backtest:funding-trend | 1 | 8.066ms | 8065.50µs | 8065.50µs | 8065.50µs | 8065.50µs | 8065.50µs |
| backtest:oi-divergence | 1 | 4.901ms | 4900.83µs | 4900.83µs | 4900.83µs | 4900.83µs | 4900.83µs |
| backtest:oi-trend | 1 | 4.841ms | 4840.54µs | 4840.54µs | 4840.54µs | 4840.54µs | 4840.54µs |
| strategy:ensemble-trend | 1 | 3.509ms | 3509.08µs | 3509.08µs | 3509.08µs | 3509.08µs | 3509.08µs |
| strategy:ensemble | 1 | 3.331ms | 3331.04µs | 3331.04µs | 3331.04µs | 3331.04µs | 3331.04µs |
| strategy:liq-fade | 1 | 1.954ms | 1954.21µs | 1954.21µs | 1954.21µs | 1954.21µs | 1954.21µs |
| strategy:liq-trend | 1 | 1.914ms | 1913.96µs | 1913.96µs | 1913.96µs | 1913.96µs | 1913.96µs |
| strategy:vol-breakout | 1 | 0.815ms | 814.75µs | 814.75µs | 814.75µs | 814.75µs | 814.75µs |
| strategy:funding-reversion | 1 | 0.320ms | 319.54µs | 319.54µs | 319.54µs | 319.54µs | 319.54µs |
| strategy:funding-trend | 1 | 0.243ms | 242.92µs | 242.92µs | 242.92µs | 242.92µs | 242.92µs |
| strategy:oi-trend | 1 | 0.198ms | 198.04µs | 198.04µs | 198.04µs | 198.04µs | 198.04µs |
| strategy:oi-divergence | 1 | 0.195ms | 194.71µs | 194.71µs | 194.71µs | 194.71µs | 194.71µs |

## Interpretation

Positive **DSR** and Sharpe CI strictly above 0 are the publish-grade bar.
Winner by composite score is shown top. High **PBO** (>0.5) warns that
the in-sample winner may not generalise; cross-check OOS and against
buy-and-hold before deploying.
