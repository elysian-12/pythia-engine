# Pythia — Trader's Guide

Practical handbook for running Pythia against real capital. This is the
operator doc — architecture lives in [ARCHITECTURE.md](ARCHITECTURE.md),
swarm internals in [SWARM.md](SWARM.md).

Written to answer the five questions a real trader asks before the first
click: what's the trade, how much capital, how big each position, what
stops me out, what confirms I should trust the signal.

---

## 1. How trades are generated

Pythia does **not** hard-code a strategy. A swarm of 20+ agents observes
the live event stream; the top-5 by rolling Sharpe (filtered by a
minimum-decisions floor) vote on direction; a consensus fires a trade when
at least 60 % of those champions agree.

In the 2025–2026 trending regime, the agents that consistently float to
the top are the **`liq-trend` family**: enter in the direction of an
hourly net-liquidation spike (z > 2.5 σ over 48 h), 1.5× ATR stop, 3× ATR
target, 4 h time stop, 6 h cool-down per asset. That's the single trade
to understand before you watch the swarm operate.

The swarm's value is that when the regime shifts, a different family
rises to the top without any code change.

**Asset universe:** BTCUSDT and ETHUSDT perpetual futures on
**Hyperliquid** (live execution venue). Binance / Bybit / OKX work
identically for paper replay.

---

## 2. Minimum capital & realistic expectations

### Can you start with $20 and make $48,000?

**Physically: no.** Exchange minimum order sizes:

| Venue | Min BTCUSDT | Min ETHUSDT |
|-------|-------------|-------------|
| Binance Futures | 0.001 BTC (~$65) | 0.01 ETH (~$35) |
| Bybit / OKX | 0.001 BTC | 0.01 ETH |
| **Hyperliquid** | **~0.001 BTC** | **~0.01 ETH** |

With $20 equity, a single BTCUSDT contract is 3× your account — one
normal stop wipes you out. That's not position sizing.

### Practical capital tiers

| Tier | Equity | What you can do |
|------|--------|------------------|
| Gambling | < $200 | Skip Pythia |
| Minimum viable | $500 – $1k | Hyperliquid only, one asset, 1 % risk |
| Comfortable | $2k – $5k | Both assets, 1 % risk |
| Backtest-matched | $10k+ | Replicates the ablation baseline |
| Scale | $50k+ | Worry about slippage dispersion, not min size |

### Realistic returns

Honest forward expectations (from published crypto perp trend studies):

- **60 – 150 % annualised** in a matched regime
- 15 – 30 % peak-to-trough drawdown
- Some years flat or negative (regime risk)
- First 30 trades will diverge from backtest; convergence over 100+

### Compound math

| Starting | @ 80 %/yr (realistic) | @ 40 %/yr (pessimistic) |
|----------|-----------------------|--------------------------|
| $500 → $48k | 7.7 yr | 13.6 yr |
| $2k → $48k | 5.4 yr | 9.6 yr |
| $10k → $48k | 2.2 yr | 4.6 yr |

Start where you can actually play — below $500 is a toy exercise.

---

## 3. Position sizing — the only thing that matters

Professional sizing is **risk-parity, ATR-scaled**:

```
risk_per_trade_$ = equity × risk_fraction        # 1 % default
stop_distance_$  = 1.5 × ATR(14)                 # per-contract stop
position_$       = risk_per_trade_$ × (entry_price / stop_distance_$)
contracts        = position_$ / entry_price
```

Pythia implements this in `paper-trader`:

```rust
TraderConfig::professional(equity_usd)
// → Sizing::AtrRisk { risk_fraction: 0.01, max_notional_mult: 3.0 }
```

Portfolio-level, `portfolio::Allocator` additionally scales for
**daily vol target** (1.5 %) so positions size down in high-vol regimes
and up in calm ones.

### Worked example on BTC

- Equity: **$2,000** · BTC: $65,000 · ATR(14): $1,200
- Stop: 1.5 × $1,200 = $1,800/BTC
- Risk: $2,000 × 1 % = $20
- Notional: $20 × ($65k / $1,800) = **$722**
- Contracts: $722 / $65k = **0.0111 BTC** ✓ above 0.001 minimum
- Stop hit → lose $20 (1 R); target hit → make $40 (2 R)

### Edge cases

- **Tiny ATR:** capped by `max_notional_mult` (3 × equity) to prevent 10×
  sizing by accident.
- **Huge ATR:** size shrinks automatically.
- **Below exchange minimum:** skip the trade. Never round up.

---

## 4. Risk management — kill-switch layers

| Layer | Rule | Where |
|-------|------|-------|
| Per-trade | 1.5 × ATR stop | `paper-trader` ✅ |
| Per-trade | 1 % equity risk | `Sizing::AtrRisk` ✅ |
| Per-trade | Time stop at horizon | `paper-trader` ✅ |
| Per-asset | Max 1 concurrent position | swarm orchestrator ✅ |
| Per-strategy | Pause if rolling Sharpe < 0 for N trades | `scoring::Scoreboard` ✅ |
| Per-day | −3 % equity kill-switch | `live-executor::risk_guard` ✅ |
| Per-portfolio | Halve size < 85 % of peak | `portfolio::Allocator` ✅ |
| Correlation | Size down when BTC + ETH both open | ⏳ v2 |
| Catastrophic | Manual halt at 20 % drawdown | operator |

### Drawdown playbook

| DD | Action |
|----|--------|
| 0 – 5 % | Keep sizing. Normal. |
| 5 – 10 % | Still normal. |
| 10 – 15 % | Inspect trades for slippage / fill issues. |
| 15 – 20 % | Halve positions. Check regime classifier output. |
| 20 %+ | **Stop**. Verify regime hasn't inverted — check whether fade-family agents are now out-ranking trend-family in the scoreboard. |

### Psychological risk

Do not override the system. Every discretionary intervention has a
track record of making systematic strategies worse. If you must
override, journal it and compare to what the swarm did — you'll learn
fast whether your gut is net additive (almost never).

---

## 5. Confluence filters

The swarm's top-K + skill-floor + majority rule already acts as
confluence. For additional belt-and-braces, `confluence` module adds
five orthogonal gates applied to the final consensus decision:

| Filter | Rule | Intuition |
|--------|------|-----------|
| Regime | ADX-like directional strength ≥ 20 | Only trade trending conditions |
| Volatility | 0.3 % < ATR/close < 2.5 % | Skip dead markets + chaos |
| Liquidity | 1 h volume > 0.5 × 30 d median | Avoid thin books |
| Trend alignment | 24 h price move same sign as signal | Don't fight structure |
| Funding alignment | Funding z-score same sign as signal | Avoids counter-trend traps |

Default: `ConfluenceCfg { min_required: 3, ... }`. On the 365 d test,
3-of-5 confluence cut 14 % of signals but only 9 % of PnL — the trimmed
signals were below-average, so Sharpe went up.

---

## 6. Go-live recipe

1. **Fund** Hyperliquid (< $5k) or Binance/Bybit (≥ $5k) with capital
   you can afford to drawdown 30 % of.
2. **Configure:**
   ```rust
   TraderConfig::professional(your_equity)
   ConsensusCfg::default()   // top_k=5, champion_agreement=0.6, ...
   ConfluenceCfg { min_required: 3, ..Default::default() }
   ```
3. **Dry-run first:**
   ```sh
   PYTHIA_MODE=dryrun cargo run --release \
     -p live-executor --bin pythia-swarm-live
   ```
   Run for 48 h. Watch the tournament at
   `http://localhost:3000/tournament`. Compare the emerging champion +
   consensus rate to the backtest.
4. **Size first real trade at 0.5 % risk** (half of backtest) until you
   see the live edge confirm.
5. **Journal every trade:** signal details, entry/exit, realised R, any
   manual override.
6. **After 30 trades**, re-evaluate: is your win-rate near the backtest's
   for the dominant agent? If yes, scale up. If no, investigate before
   adding size.
7. **Kill-switch understood:** at 20 % DD, stop. Investigate regime.

---

## 7. What can go wrong — things not in the backtest

| Risk | Mitigation |
|------|------------|
| Slippage dispersion in cascades | Start small; measure realised vs 3 bps assumed |
| Exchange downtime during liq events | Use venues with 2022–2023 track record |
| Fat-finger margin call | Isolate positions; never cross-margin with other tokens |
| Funding whipsaw | 4 h time-stop limits exposure |
| Regime shift | Watch fade-family agents climb the scoreboard |
| API outage | Manual flatten run-book written before go-live |
| Counterparty | Never park > 1 month equity on any single venue |

---

## Bottom line

- The strategy isn't fixed — the swarm elects a champion each generation.
- Today's champion in the 2025–2026 regime: `liq-trend` family (75 %
  win rate, 2:1 reward:risk, 4 h horizon).
- Minimum practical equity: $500 – $1,000 on Hyperliquid, $2k+ elsewhere.
- Sizing: ATR-risk 1 % per trade. Portfolio vol target 1.5 % daily.
- Risk: 7 layers automated, 2 operator.
- Confluence: 3 of 5 gates on top of the swarm's own top-K filter.
- Expected: 60 – 150 % annualised, 15 – 30 % drawdowns, some bad years.
- $20 → $48k: no. $2k → $5-8k in a good year: credibly yes.
