//! Timestamp types.
//!
//! `AsofTs` is when we observed a fact (wall clock at ingest).
//! `EventTs` is when the fact happened (exchange/on-chain timestamp).
//! Keeping these distinct prevents look-ahead bugs in backtests: queries
//! always specify "state known as of X" via `AsofTs`.

use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(
    Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct AsofTs(pub i64);

#[derive(
    Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct EventTs(pub i64);

impl AsofTs {
    pub fn now() -> Self {
        Self(Utc::now().timestamp())
    }

    pub fn to_datetime(self) -> DateTime<Utc> {
        Utc.timestamp_opt(self.0, 0).single().unwrap_or_else(Utc::now)
    }
}

impl EventTs {
    pub fn from_secs(s: i64) -> Self {
        Self(s)
    }

    pub fn to_datetime(self) -> DateTime<Utc> {
        Utc.timestamp_opt(self.0, 0).single().unwrap_or_else(Utc::now)
    }
}

impl fmt::Display for AsofTs {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_datetime().format("%Y-%m-%dT%H:%M:%SZ"))
    }
}

impl fmt::Display for EventTs {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_datetime().format("%Y-%m-%dT%H:%M:%SZ"))
    }
}
