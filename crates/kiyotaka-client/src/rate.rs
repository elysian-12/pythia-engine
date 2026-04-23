//! Parses `X-RateLimit-*` headers into a thread-safe snapshot.

use reqwest::header::HeaderMap;
use std::sync::Mutex;

#[derive(Copy, Clone, Debug, Default)]
pub struct RateLimitSnapshot {
    pub limit: u32,
    pub remaining: u32,
    pub used: u32,
    pub reset_at: i64,
}

#[derive(Debug, Default)]
pub struct RateTracker {
    inner: Mutex<RateLimitSnapshot>,
}

impl Clone for RateTracker {
    fn clone(&self) -> Self {
        Self {
            inner: Mutex::new(self.snapshot()),
        }
    }
}

impl RateTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> RateLimitSnapshot {
        self.inner.lock().map(|g| *g).unwrap_or_default()
    }

    pub(crate) fn update_from_headers(&self, h: &HeaderMap) {
        if let Ok(mut s) = self.inner.lock() {
            if let Some(v) = header_u32(h, "X-RateLimit-Limit") {
                s.limit = v;
            }
            if let Some(v) = header_u32(h, "X-RateLimit-Remaining") {
                s.remaining = v;
            }
            if let Some(v) = header_u32(h, "X-RateLimit-Used") {
                s.used = v;
            }
            if let Some(v) = header_i64(h, "X-RateLimit-Reset") {
                s.reset_at = v;
            }
        }
    }
}

fn header_u32(h: &HeaderMap, k: &str) -> Option<u32> {
    h.get(k).and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok())
}

fn header_i64(h: &HeaderMap, k: &str) -> Option<i64> {
    h.get(k).and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok())
}
