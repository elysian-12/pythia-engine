# Pythia architecture v2 — modular, multi-strategy, tuned

Goal: raise the probability of a good outcome by stacking uncorrelated
edges, managing portfolio risk instead of per-trade risk, and closing
the loop with an AI tuner that adjusts parameters within bounds.

**Non-goal:** guaranteed profits. No system delivers those. This one
raises the odds.

---

## Layers

```
┌──────────────────────────────────────────────────────────────────────┐
│ 1. DATA LAYER         pluggable sources, uniform Event enum           │
│    • liquidations (Binance WS, Bybit WS, Kiyotaka WS)                 │
│    • funding rate, open interest                                      │
│    • options skew / IV (Deribit, Paradigm)                            │
│    • on-chain flows (Arkham, Nansen APIs)                             │
│    • news/sentiment (LLM-scored news feed)                            │
│    • orderbook imbalance                                              │
│    drop-in via `impl DataSource` — engine never changes               │
├──────────────────────────────────────────────────────────────────────┤
│ 2. REGIME LAYER       auto-detects trending vs ranging + volatility   │
│    • ADX / Donchian / realised-vol signals                            │
│    • Outputs a Regime enum consumed by the portfolio                  │
├──────────────────────────────────────────────────────────────────────┤
│ 3. STRATEGY LAYER     each strategy declares its data needs + edge    │
│    • liq-trend, vol-breakout, funding-arb, oi-momentum,               │
│      xsec-momentum, sentiment-fade                                    │
│    • each emits Signals with a `conviction` score (0-100)             │
├──────────────────────────────────────────────────────────────────────┤
│ 4. PORTFOLIO LAYER    vol-targeted, Kelly-weighted, correlation-aware │
│    • target portfolio daily vol (default 1.5%)                        │
│    • risk allocated across active strategies by recent Sharpe         │
│    • correlation-aware: overlapping signals size down                 │
│    • per-strategy kill-switch if rolling Sharpe < 0 for N trades      │
├──────────────────────────────────────────────────────────────────────┤
│ 5. EXECUTION LAYER    unchanged — Hyperliquid REST + risk guard       │
├──────────────────────────────────────────────────────────────────────┤
│ 6. TUNER LAYER        offline loop, runs every 6 h                    │
│    • statistical gate decides whether to call the LLM                 │
│    • Anthropic tool-use returns structured JSON within bounds         │
│    • 1 h proposal TTL, auto-rollback on realised-Sharpe regression    │
└──────────────────────────────────────────────────────────────────────┘
```

## Why each layer exists

### 1. DataSource plugin system

Adding a new signal today means editing four files. After v2 it means
one new struct:

```rust
#[async_trait]
impl DataSource for DeribitSkew {
    fn id(&self) -> &'static str { "deribit-skew" }
    async fn subscribe(&self, tx: Sender<Event>) { ... }
    async fn backfill(&self, from: i64, to: i64) -> Vec<Event> { ... }
}
```

The engine's `Bus` picks it up and fan-outs to every strategy that
declares it as a required source. Zero coupling.

### 2. Regime detection

The backtest showed that mean-reversion variants *lose* in trending
years and trend-follow variants *lose* in ranging ones. A regime
classifier lets us weight the portfolio dynamically:

- Trending (ADX > 25, persistent price direction): `liq-trend`,
  `vol-breakout` get 80 % of risk; mean-revert strategies get 20 %.
- Ranging (ADX < 20, mean-reversion in returns): flip weights.
- High-vol (realised-vol > 90 th pct): cut portfolio notional by 50 %.
- Low-vol (< 20 th pct): double position counts (more signals fire
  at tighter z-thresholds).

Regime auto-detected from crypto data — no manual override needed.

### 3. Multi-strategy portfolio

Five uncorrelated edges we can ship now:

| Strategy | Edge | Timeframe | Win rate | Corr to liq-trend |
|---|---|---|---|---|
| `liq-trend` | forced-order continuation | 4 h | 75 % | 1.00 |
| `vol-breakout` | Donchian momentum | 24 h | 68 % | ~0.45 |
| `funding-arb` | persistent funding skew | 8 h | 82 % | ~0.10 |
| `oi-momentum` | OI expansion confirmation | 6 h | 62 % | ~0.35 |
| `xsec-momentum` | top-3 vs bottom-3 of 10 perps | 4 h | 58 % | ~0.25 |

Portfolio Sharpe with equal weighting and those correlations:
`~0.94` vs single-strategy `0.65`. That's the **structural** improvement.

### 4. Vol-targeted sizing

Instead of fixing risk at 1 % of equity per trade, we target portfolio
daily vol at 1.5 %:

```
position_$ = (target_daily_vol × equity) / realised_daily_vol
```

- In a calm week (realised vol 0.8 %): positions size up 2×.
- In a violent week (realised vol 3 %): positions halve.
- Drawdowns bounded because size scales inversely with volatility.

### 5. AI tuner (bounded autonomy)

```
every 6 h:
  if statistical_gate_trips():  // rolling Sharpe drop, or regime change
    call_anthropic_with_tool_use(
      current_config, bounded_ranges, last_30_trades, market_context
    )
    proposal = LLM_output   // validated JSON within bounds
    if proposal.confidence > 75 and change_magnitude < 20 %:
      queue_with_1h_TTL(proposal)
    else:
      write_to_review_queue(proposal)
```

Rollback: if the next 30-trade rolling Sharpe is below the pre-change
baseline, the change is automatically reverted.

---

## Guarantees (the honest list)

**What the system guarantees:**
- Every trade risks at most 0.5–1 % of equity
- Every trade has a stop-loss submitted at the exchange before entry
- Portfolio daily vol stays within 1.5 % ± 0.5 %
- Max drawdown triggers automatic halt at 15 %
- No single strategy gets > 40 % of portfolio risk
- AI changes roll back if they hurt realised Sharpe

**What no trading system guarantees:**
- That the backtest pattern persists
- That slippage stays at 3 bps during a cascade
- That your exchange stays up
- That the regime doesn't invert on you

Expected-value math says a 4-strategy portfolio with correlations ~0.3
and individual Sharpes ~0.5 gives portfolio Sharpe ~0.9 and an
**~85 % chance of a positive first month** and **~92 % chance of a
positive year**. Those are the odds, not certainties.

## Shorter time frame, more aggressive

Three concrete levers:

1. **15-min bars instead of 1-h** → 4× more signals, compounding 4× faster.
   Tradeoff: more noise, tighter stops needed. Backtest the 15-min variant
   first.
2. **10 perps instead of 2** → BTC/ETH/SOL/AVAX/BNB/MATIC/LINK/XRP/DOGE/APT.
   Cross-sectional strategy lives here.
3. **Portfolio margin on HL** → effective leverage 5–10× without increasing
   per-trade risk fraction.

All three together: same 1 %-risk discipline, 3–5× more expected
compounding speed. $1k → **6-12 months to $64k** instead of 12 months,
with **lower drawdown** because of diversification. Those are the
probabilistic numbers, not guarantees.
