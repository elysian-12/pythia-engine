# Pythia — extended grid search: compounding + aggressive risk

**Grid:** 3 strategies × 4 risk tiers × 2 modes (flat vs compound) + 4 z-thresholds + 2 asset-isolation = 30 runs
**Start:** $1000 · **Data:** 365 d BTC + ETH hourly · **Runtime:** 416 ms

**Ranking rule:** survive MaxDD ≤ 25 %, rank by final equity.

## 🏆 Winner — `liq-trend@5%/compound·BTC+ETH`

| Metric | Value |
|---|---|
| Starting equity | $1000 |
| **Final equity** | **$90420103505** |
| **Final multiplier** | **90420103.5×** |
| **PnL USD** | **+$90420102505 (+9042010250.5 %)** |
| Trades | 578 |
| Win rate | 74.9 % |
| Profit factor | 5.91 |
| Sharpe per-trade | +0.19 |
| Sortino | +0.59 |
| Max drawdown | 14.7 % |
| Calmar | +614319320.66 |

## Full grid — ranked by final equity

| # | Variant | Trades | Final $ | ROI % | Sharpe | MaxDD % | Survived |
|---|---|---|---|---|---|---|---|
| 1 | `liq-trend@5%/compound·BTC+ETH` | 578 | +90420103505 | +9042010250.5 | +0.19 | 14.7 | ✅ |
| 2 | `ensemble-trend@5%/compound·BTC+ETH` | 613 | +28098550732 | +2809854973.2 | +0.15 | 22.2 | ✅ |
| 3 | `vol-breakout@5%/compound·BTC+ETH` | 410 | +8959450391 | +895944939.1 | +0.18 | 27.9 | ❌ |
| 4 | `liq-trend@3%/compound·BTC+ETH` | 578 | +173810062 | +17380906.2 | +0.24 | 12.5 | ✅ |
| 5 | `ensemble-trend@3%/compound·BTC+ETH` | 613 | +81243624 | +8124262.4 | +0.19 | 14.0 | ✅ |
| 6 | `vol-breakout@3%/compound·BTC+ETH` | 410 | +36353873 | +3635287.3 | +0.24 | 19.0 | ✅ |
| 7 | `liq-trend(z2.0)@2%compound` | 750 | +15397658 | +1539665.8 | +0.26 | 6.8 | ✅ |
| 8 | `liq-trend@2%/compound·BTC+ETH` | 578 | +3648221 | +364722.1 | +0.29 | 8.8 | ✅ |
| 9 | `liq-trend(z2.5)@2%compound` | 578 | +3648221 | +364722.1 | +0.29 | 8.8 | ✅ |
| 10 | `ensemble-trend@2%/compound·BTC+ETH` | 613 | +2154221 | +215322.1 | +0.24 | 9.3 | ✅ |
| 11 | `vol-breakout@2%/compound·BTC+ETH` | 410 | +1246124 | +124512.4 | +0.30 | 12.2 | ✅ |
| 12 | `liq-trend(z3.0)@2%compound` | 466 | +839513 | +83851.3 | +0.33 | 5.5 | ✅ |
| 13 | `liq-trend(z3.5)@2%compound` | 392 | +370185 | +36918.5 | +0.37 | 5.3 | ✅ |
| 14 | `liq-trend@2%compound·ETH-only` | 295 | +77653 | +7665.3 | +0.44 | 4.2 | ✅ |
| 15 | `liq-trend@1%/compound·BTC+ETH` | 578 | +63858 | +6285.8 | +0.43 | 3.1 | ✅ |
| 16 | `ensemble-trend@1%/compound·BTC+ETH` | 613 | +49272 | +4827.2 | +0.34 | 3.9 | ✅ |
| 17 | `liq-trend@2%compound·BTC-only` | 283 | +46981 | +4598.1 | +0.42 | 4.2 | ✅ |
| 18 | `vol-breakout@1%/compound·BTC+ETH` | 410 | +37182 | +3618.2 | +0.44 | 3.7 | ✅ |
| 19 | `liq-trend@5%/flat·BTC+ETH` | 578 | +20210 | +1921.0 | +0.72 | 0.7 | ✅ |
| 20 | `ensemble-trend@5%/flat·BTC+ETH` | 613 | +19298 | +1829.8 | +0.54 | 1.3 | ✅ |
| 21 | `vol-breakout@5%/flat·BTC+ETH` | 410 | +18117 | +1711.7 | +0.67 | 1.5 | ✅ |
| 22 | `liq-trend@3%/flat·BTC+ETH` | 578 | +13449 | +1244.9 | +0.72 | 0.7 | ✅ |
| 23 | `ensemble-trend@3%/flat·BTC+ETH` | 613 | +12792 | +1179.2 | +0.54 | 1.0 | ✅ |
| 24 | `vol-breakout@3%/flat·BTC+ETH` | 410 | +11965 | +1096.5 | +0.67 | 1.3 | ✅ |
| 25 | `liq-trend@2%/flat·BTC+ETH` | 578 | +9379 | +837.9 | +0.71 | 0.6 | ✅ |
| 26 | `ensemble-trend@2%/flat·BTC+ETH` | 613 | +8899 | +789.9 | +0.54 | 0.8 | ✅ |
| 27 | `vol-breakout@2%/flat·BTC+ETH` | 410 | +8337 | +733.7 | +0.67 | 0.9 | ✅ |
| 28 | `liq-trend@1%/flat·BTC+ETH` | 578 | +5201 | +420.1 | +0.71 | 0.4 | ✅ |
| 29 | `ensemble-trend@1%/flat·BTC+ETH` | 613 | +4954 | +395.4 | +0.54 | 0.4 | ✅ |
| 30 | `vol-breakout@1%/flat·BTC+ETH` | 410 | +4669 | +366.9 | +0.67 | 0.6 | ✅ |

## Reading the result

- **Compound vs flat**: same strategy, same signals, different sizing rule. Compounding lets winning trades grow the risk base, so each later trade sizes bigger.
- **Aggressive risk**: 5 % per trade is Kelly-territory. The backtest survives because the strategy's 75 % win rate + 2:1 reward:risk pushes theoretical Kelly to 62 %. That does *not* mean 5 % is safe — it means the strategy's in-sample edge absorbs it. Real deployment: start at 1 %.
- **Z-threshold**: tighter thresholds (3.0σ+) trade less but with higher quality. Looser (2.0σ) trades more but with lower edge per trade.
- **Asset isolation**: shows whether BTC or ETH carries the alpha, or whether both do.
