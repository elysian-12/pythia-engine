//! Pluggable data-source abstraction.
//!
//! The engine consumes `Event`s via an opaque `Bus`. Any data provider
//! (Binance WS, Deribit, Arkham on-chain, a sentiment LLM, etc.) that
//! implements [`DataSource`] can be hot-plugged — the rest of the
//! workspace never needs to know what's behind it.
//!
//! Design principles:
//!   1. **Single event type.** A pre-typed `Event` enum avoids
//!      dispatch-time string matching. New variants are added to the
//!      enum and consumers pattern-match exhaustively.
//!   2. **Single broadcast bus.** All sources publish into one
//!      `broadcast::Sender`. Strategies subscribe and filter by
//!      variant. Back-pressure propagates via lagging subscribers.
//!   3. **Async-trait boundary.** `DataSource::start` returns once
//!      connections are live; it owns its own reconnect loop.

#![deny(unused_must_use)]

pub mod bus;
pub mod events;
pub mod registry;

pub use bus::{Bus, BusHandle, BusSubscriber};
pub use events::{Event, EventKind, LiqEvent, FundingEvent, OiEvent, SentimentEvent, SkewEvent};
pub use registry::{DataSource, SourceRegistry};
