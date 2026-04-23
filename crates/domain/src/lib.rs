//! Pythia domain model.
//!
//! Pure types. No I/O, no async runtime, no external clients. Everything
//! downstream (clients, storage, signal engine, backtest) uses these types as
//! the canonical representation.
//!
//! Invariants:
//! - Prices on Polymarket outcomes are in [0.0, 1.0].
//! - Timestamps separate observation (`asof`) from event (`ts`).
//! - Newtypes wrap identifiers so they cannot be accidentally swapped.

#![deny(unused_must_use)]

pub mod ids;
pub mod market;
pub mod position;
pub mod trader;
pub mod crypto;
pub mod signal;
pub mod time;

pub use ids::{AssetId, ConditionId, Wallet};
pub use time::{AsofTs, EventTs};
