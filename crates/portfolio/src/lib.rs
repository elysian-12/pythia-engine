//! Portfolio-level risk allocator and volatility target.
//!
//! The allocator sits between strategies and the executor. Responsibilities:
//!
//!   1. **Volatility target.** Scale total portfolio notional so that
//!      realised daily vol stays near the target (default 1.5 %).
//!   2. **Strategy weights.** Allocate risk across active strategies
//!      based on their recent Sharpe and the current regime.
//!   3. **Correlation awareness.** When multiple strategies fire on
//!      the same side in the same hour, size them down pro-rata so
//!      the portfolio doesn't become a one-bet concentration.
//!   4. **Per-strategy kill-switch.** If a strategy's rolling 30-trade
//!      Sharpe drops below zero, it's disabled until it recovers.

#![deny(unused_must_use)]

pub mod allocator;
pub mod vol_target;

pub use allocator::{
    Allocator, AllocatorCfg, AllocatorSnapshot, StrategyStats,
};
pub use vol_target::{target_notional, VolTargetCfg};
