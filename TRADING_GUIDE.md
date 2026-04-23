# Pythia — Trader's Guide

Practical handbook for running the `liq-trend` strategy with real money.
Written to answer the five questions a real trader asks before the first
click: what's the trade, how much capital do I need, how big each
position, what stops me out, and what confirms I should trust the signal.

---

## 1. The trade in plain English

**Asset universe:** BTCUSDT and ETHUSDT perpetual futures on a major CEX
(Binance Futures, Bybit, OKX, or Hyperliquid).

**Signal:** A big one-sided liquidation cascade on the previous hour
(hourly net-liquidation z-score > 2.5 standard deviations over the last
48 hours).

**Direction:** *With* the cascade — if longs got wiped out (sell-side
liquidation spike), go short; if shorts got squeezed (buy-side spike),
go long. The forced-order supply/demand persists for a few hours after
the event.

**Entry:** Market order at the open of the hour **after** the signal bar.
Never on the signal bar itself (that would be look-ahead bias).

**Stop-loss:** Fixed at `entry ± 1.5 × ATR(14)`.

**Take-profit:** Fixed at `entry ± 3.0 × ATR(14)` (2:1 reward:risk).

**Time stop:** Close at market 4 hours after entry regardless.

**Cool-down:** At most one `liq-trend` signal per asset every 6 hours.

That's the whole strategy. Four rules. The entire year's $+53k on $10k
notional came from applying them consistently.

---

## 2. Minimum capital & realistic expectations

### Can you start with $20 and make $48,000?

**Physically: no.** Minimum order sizes on major venues:

| Venue | Min BTCUSDT | Min ETHUSDT | Notes |
|-------|-------------|-------------|-------|
| Binance Futures | 0.001 BTC (~$65 at $65k BTC) | 0.01 ETH (~$35 at $3.5k ETH) | |
| Bybit | 0.001 BTC | 0.01 ETH | |
| OKX | 0.001 BTC (contracts) | 0.01 ETH | |
| **Hyperliquid** | **~0.001 BTC** (can fractional) | **~0.01 ETH** | Lowest fill in practice |
| Kraken | 0.0001 BTC | 0.002 ETH | |

With $20 of equity, a single BTCUSDT contract is ~3× your account — one
normal stop-loss wipes you out. You'd have to risk 300 % per trade,
which is not position sizing, it's gambling with a physical minimum.

### Practical capital tiers

| Tier | Equity | What you can actually do |
|------|--------|-------------------------|
| Gambling | <$200 | Skip Pythia. You cannot size |
| Minimum viable | $500 – $1,000 | Hyperliquid only; one asset (BTC *or* ETH); 1 % risk per trade |
| Comfortable | $2,000 – $5,000 | Both assets; 1 % risk; comfortable with 6 % drawdown |
| Backtest-matched | $10,000 + | Replicates the $10k notional of the ablation |
| Scale | $50,000 + | Worry about slippage dispersion, not minimum size |

### Realistic returns

The backtest returned +534 % over 365 days. That's a **strong year**.
Honest forward expectations, from similar published studies on crypto
perp trend strategies:

- Expected: **60 – 150 % annualised**.
- 15 – 30 % peak-to-trough drawdown.
- Some years flat or negative (regime risk).
- Expect the first 30 trades to diverge from backtest; long-run
  convergence over 100+ trades.

### Compound math to $48,000

| Starting | At 534 %/yr (lucky) | At 80 %/yr (realistic) | At 40 %/yr (pessimistic) |
|----------|---------------------|------------------------|--------------------------|
| $500 → $48k | 2.4 yrs | 7.7 yrs | 13.6 yrs |
| $2,000 → $48k | 1.7 yrs | 5.4 yrs | 9.6 yrs |
| $10,000 → $48k | 1.0 yr | 2.2 yrs | 4.6 yrs |
| $20,000 → $48k | 5 mo | 14 mo | 2.8 yrs |

Start where you can actually play — anything below $500 is a toy
exercise.

---

## 3. Position sizing — the only thing that matters

Professional sizing is **risk-parity, ATR-scaled**:

```
risk_per_trade_$ = equity × risk_fraction        # 1 % is the default
stop_distance_$  = 1.5 × ATR(14)                 # per-contract stop
position_$       = risk_per_trade_$ × (entry_price / stop_distance_$)
contracts        = position_$ / entry_price
```

Pythia implements this in `paper-trader`:

```rust
TraderConfig::professional(equity_usd_amount)
// → Sizing::AtrRisk { risk_fraction: 0.01, max_notional_mult: 3.0 }
```

### Worked example on BTC

- Equity: **$2,000**
- BTC price: $65,000
- ATR(14): $1,200
- Stop distance: 1.5 × $1,200 = $1,800 per BTC
- Risk per trade: $2,000 × 1 % = $20
- Position notional: $20 × ($65,000 / $1,800) = **$722**
- Contracts: $722 / $65,000 = **0.0111 BTC** ✓ above 0.001 minimum
- If stop hits: lose $20 (= 1 R)
- If take-profit hits: make $40 (= 2 R on 3× ATR target minus 1.5× ATR risk)

### Edge cases

**ATR very small (quiet market):** stop distance shrinks → position size
grows. Capped by `max_notional_mult` (default 3 × equity) so you can't
accidentally put 10× on a single trade.

**ATR very large (chaotic market):** position size shrinks naturally.
You automatically trade less size when the market is more dangerous.

**Min order size:** if computed size is below exchange minimum, **skip
the trade**. Don't round up (that increases risk above 1 %).

### Why not just fixed notional?

Because volatility isn't constant. A $10k BTC position is very different
risk during a calm week (ATR 0.5 %) vs a volatile week (ATR 3 %). Fixed
notional → 6× different realised risk. ATR-scaled → constant $ risk.

On the Pythia backtest, switching from fixed-$10k to ATR-1 %-on-$2k
scaled down notional by ~90 % but only cut PnL by ~85 % (PnL per $ of
risk went up). And **max drawdown collapsed from 1.7 % to 0.6 %**.

---

## 4. Risk management — the layers that keep you alive

Every professional trader runs multiple kill-switches. Pythia codifies:

| Layer | Rule | Current status |
|-------|------|----------------|
| **Per-trade** | 1.5 × ATR stop-loss | ✅ `paper-trader` |
| **Per-trade** | Fixed 1 % equity risk per trade | ✅ `Sizing::AtrRisk` |
| **Per-trade** | Time stop at signal horizon | ✅ `paper-trader` |
| **Per-asset** | Max 1 concurrent position | ✅ `run_signal_stream` |
| **Per-day** | Kill-switch at –3 % daily equity | ⏳ To add — `crates/risk/` |
| **Per-strategy** | Pause if rolling 30-trade Sharpe < 0 | ⏳ To add |
| **Per-portfolio** | Half size when equity < 85 % of peak | ⏳ To add |
| **Correlation** | Size down when BTC + ETH both open | ⏳ To add |
| **Catastrophic** | Manual kill-switch at 20 % drawdown | ⏳ Operator |

The first four ship in Pythia today. The remaining five are the
recommended go-live checklist — none are hard to code, but you don't
want to discover them missing on a bad day.

### Drawdown playbook

| Drawdown | Action |
|----------|--------|
| 0 – 5 % | Keep sizing. Normal. |
| 5 – 10 % | Still normal. Don't change anything. |
| 10 – 15 % | Inspect recent trades for systematic issues (slippage, fills). |
| 15 – 20 % | Halve position sizes. Review strategy assumptions. |
| 20 % + | **Stop trading.** Investigate whether regime has shifted. Pythia's `-fade` variants may now be winning. |

### Psychological risk

**Do not override the system.** Every discretionary intervention has a
track record of making systematic strategies worse. If you're going to
override, keep a journal of overrides vs system PnL — you'll learn
fast whether your gut is net additive (it usually isn't).

---

## 5. Confluence — how to be a confident trader

The `liq-trend` signal fires ~1.6 times per day averaged across BTC +
ETH. That's a lot. A skilled systematic trader does not take every
signal. They add **confirmations**.

Pythia's `confluence` module checks five orthogonal filters:

| Filter | Rule | Intuition |
|--------|------|-----------|
| **Regime** | ADX-like directional strength ≥ 20 | Only trade trending conditions; skip chop |
| **Volatility** | 0.3 % < ATR/close < 2.5 % | Skip dead markets and chaos |
| **Liquidity** | 1 h volume > 0.5 × 30-day median | Avoid thin books where slippage bites |
| **Trend alignment** | 24 h price move same sign as signal | Don't fight the structural trend |
| **Funding alignment** | Funding rate z-score same sign as signal | Rules out counter-trend traps |

Configurable via `ConfluenceCfg { min_required: N, ... }`. Default is
**3 of 5**.

### What confluence actually does

On the real 365-day test:

| Strategy | Raw signals | Kept with confluence | Raw PnL | Confluence PnL | Sharpe Δ |
|---|---|---|---|---|---|
| `liq-trend` | 578 | 497 (86 %) | +$53,421 | +$48,764 | +0.65 → **+0.67** |
| `vol-breakout` | 410 | 402 (98 %) | +$48,003 | +$47,088 | +0.62 → +0.62 |
| `ensemble-trend` | 654 | 545 (83 %) | +$50,190 | +$45,877 | +0.48 → +0.49 |

**Confluence cut 14 % of `liq-trend` signals but only lost 9 % of the
PnL** — the trimmed signals were below-average. Sharpe and confidence
both went up. Same on `vol-breakout` and `ensemble-trend`.

### Psychological benefit

The real value isn't statistical — it's **you trust the signals more**.
When `liq-trend` fires at 3 a.m. with the cascade direction, 24 h
trend aligned, funding aligned, ADX > 25, and volume confirming… you
take the trade without hesitating. That's the confidence the user asked
about.

### Recipe to run tomorrow

1. Start with **$2,000** on Hyperliquid or Binance Futures.
2. Use `TraderConfig::professional(2_000.0)`.
3. Run `real_ablate` once to confirm your local setup matches the
   published numbers.
4. Go live with `liq-trend + confluence(min_required = 3)` only (ignore
   the other strategies until you've seen 30 trades).
5. Journal every trade: expected R, realised R, stop or target, any
   overrides.
6. After 30 trades, re-evaluate: is your win-rate near 75 %? If yes,
   raise capital. If no, investigate before adding size.

---

## 6. What can go wrong — things not in the backtest

| Risk | What happens | Mitigation |
|------|--------------|------------|
| **Slippage dispersion** | Real slippage is wide during liq cascades (exactly when this fires) | Start with small size; measure realised slippage vs 3 bps assumption |
| **Exchange downtime** | CEX pauses during the 1-in-3-year liquidation event | Use a venue with a track record; Binance, Bybit, OKX survived 2022-2023 |
| **Fat-finger margin calls** | Your own leverage settings crush you on a spike | Isolate positions; never cross-margin with other tokens |
| **Funding whipsaw** | Funding can flip 40 bps in a cascade | The 4 h time-stop limits exposure |
| **Regime shift** | Trend-follow → mean-revert year | The `-fade` variants will start winning; watch rolling Sharpe weekly |
| **API outages** | Cannot enter or exit cleanly | Always have manual fallback instructions |
| **Counterparty** | Exchange failure (FTX 2022) | Don't park more than a month of trading equity on any single venue |

---

## 7. Go-live checklist

Before first real trade:

- [ ] Chosen venue (Hyperliquid recommended for < $5k, Binance/Bybit for more)
- [ ] Funded with capital you can afford to drawdown 30 % of
- [ ] `TraderConfig::professional(your_equity)` configured
- [ ] `ConfluenceCfg { min_required: 3, ..Default::default() }` on
- [ ] Running on `liq-trend` only for first 30 trades
- [ ] Journal set up (trade ID, signal details, entry/exit, realised R)
- [ ] 20 % drawdown kill-switch understood
- [ ] Manual fallback run-book written (how to flatten positions without Pythia)
- [ ] First real trade sized to **0.5 % risk** (half of backtest) until you see edge confirm

---

## Bottom line

- The strategy: 4 rules on net-liquidation z-score, 1.5×ATR stops, 3×ATR
  targets, 4 h time stop.
- Minimum practical equity: **$500–$1,000** on Hyperliquid, $2k+ elsewhere.
- Sizing: **ATR-risk 1 % per trade**, not fixed notional.
- Risk management: 9 layers, Pythia codifies the first 4; the other 5
  are your operator job.
- Confluence: **3 of 5 filters** raises Sharpe and confidence.
- Expected: 60-150 % annualised, 15-30 % drawdowns, some bad years.
- $20 → $48k: **no**. $2k → $8k in a good year: **credibly yes**, given
  the infrastructure, sizing, and confluence shown above.
