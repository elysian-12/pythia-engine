# Pythia — most profitable strategy on $1,000

**Grid:** 3 strategies × 3 risk fractions × 2 confluence modes = 18 runs
**Dataset:** 365 days of Binance Futures BTC + ETH (17,520 hourly bars)
**Starting capital:** $1000 · Costs: 5 bps taker + 3 bps slippage · Funding accrued
**Grid runtime:** 403 ms wall-clock

## 🏆 Winner — `liq-trend@2.0%-conf(off)`

| Metric | Value |
|---|---|
| Starting | $1000 |
| Final equity | $9379 |
| Net PnL | **+8378.67 USD (+837.9 %)** |
| Trades | 578 |
| Win rate | 74.9 % |
| Profit factor | 5.49 |
| Sharpe (per trade) | +0.71 |
| Sortino | +1.01 |
| **Max drawdown** | **0.6 %** |
| **Calmar (ROI / MaxDD)** | **+1428.18** |
| Avg R-multiple | +0.727 |
| Sharpe 95 % CI | [+0.62, +0.80] |
| PSR vs 0 | 1.00 |
| Mean hold | 10551 s (2.9 h) |

## Full grid — ranked

| Rank | Variant | Trades | PnL $ | ROI % | Sharpe | MaxDD % | Calmar | Survived filter |
|---|---|---|---|---|---|---|---|---|
| 1 | `liq-trend@2.0%-conf(off)` | 578 | +8378.67 | +837.9 | +0.71 | 0.6 | +1428.18 | ✅ |
| 2 | `liq-trend@2.0%+conf(3)` | 497 | +7653.18 | +765.3 | +0.75 | 0.6 | +1376.45 | ✅ |
| 3 | `liq-trend@1.0%-conf(off)` | 578 | +4201.43 | +420.1 | +0.71 | 0.4 | +1166.51 | ✅ |
| 4 | `liq-trend@1.0%+conf(3)` | 497 | +3836.90 | +383.7 | +0.75 | 0.3 | +1142.76 | ✅ |
| 5 | `liq-trend@0.5%-conf(off)` | 578 | +2100.71 | +210.1 | +0.71 | 0.2 | +1032.56 | ✅ |
| 6 | `liq-trend@0.5%+conf(3)` | 497 | +1918.45 | +191.8 | +0.75 | 0.2 | +1023.17 | ✅ |
| 7 | `ensemble-trend@2.0%-conf(off)` | 613 | +7898.57 | +789.9 | +0.54 | 0.8 | +979.97 | ✅ |
| 8 | `ensemble-trend@1.0%-conf(off)` | 613 | +3953.94 | +395.4 | +0.54 | 0.4 | +920.61 | ✅ |
| 9 | `ensemble-trend@2.0%+conf(3)` | 545 | +7370.98 | +737.1 | +0.56 | 0.8 | +893.03 | ✅ |
| 10 | `ensemble-trend@0.5%-conf(off)` | 613 | +1976.97 | +197.7 | +0.54 | 0.2 | +877.66 | ✅ |
| 11 | `ensemble-trend@1.0%+conf(3)` | 545 | +3694.72 | +369.5 | +0.56 | 0.4 | +824.69 | ✅ |
| 12 | `ensemble-trend@0.5%+conf(3)` | 545 | +1847.36 | +184.7 | +0.56 | 0.2 | +788.67 | ✅ |
| 13 | `vol-breakout@2.0%-conf(off)` | 410 | +7336.98 | +733.7 | +0.67 | 0.9 | +785.36 | ✅ |
| 14 | `vol-breakout@2.0%+conf(3)` | 402 | +7204.59 | +720.5 | +0.67 | 0.9 | +764.33 | ✅ |
| 15 | `vol-breakout@1.0%-conf(off)` | 410 | +3668.63 | +366.9 | +0.67 | 0.6 | +656.58 | ✅ |
| 16 | `vol-breakout@1.0%+conf(3)` | 402 | +3602.44 | +360.2 | +0.67 | 0.6 | +641.30 | ✅ |
| 17 | `vol-breakout@0.5%-conf(off)` | 410 | +1834.32 | +183.4 | +0.67 | 0.3 | +592.17 | ✅ |
| 18 | `vol-breakout@0.5%+conf(3)` | 402 | +1801.22 | +180.1 | +0.67 | 0.3 | +579.77 | ✅ |

## Ranking rules

1. **Eliminate** variants with MaxDD > 20 % (hard floor on a $1k account).
2. **Eliminate** variants with negative total PnL.
3. **Rank survivors by Calmar** (ROI / MaxDD) — balances absolute return and drawdown.
4. **Tie-break by Sharpe.**
