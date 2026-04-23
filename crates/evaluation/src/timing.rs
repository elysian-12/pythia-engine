//! Per-phase latency collector.
//!
//! A thread-safe histogram-style collector used across the engine to
//! measure per-phase latency. Each `observe(phase, nanos)` call appends to
//! the phase's sample buffer; rendering produces P50/P95/P99/max tables.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc, time::Instant};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PhaseTiming {
    pub phase: String,
    pub count: usize,
    pub total_ns: u64,
    pub p50_ns: u64,
    pub p95_ns: u64,
    pub p99_ns: u64,
    pub max_ns: u64,
    pub mean_ns: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LatencyReport {
    pub phases: Vec<PhaseTiming>,
    pub wall_clock_ns: u64,
}

#[derive(Default)]
struct Inner {
    samples: HashMap<String, Vec<u64>>,
}

#[derive(Clone, Default)]
pub struct LatencyCollector {
    inner: Arc<Mutex<Inner>>,
}

impl std::fmt::Debug for LatencyCollector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LatencyCollector").finish_non_exhaustive()
    }
}

impl LatencyCollector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a single observation in nanoseconds.
    pub fn observe(&self, phase: &str, ns: u64) {
        let mut g = self.inner.lock();
        g.samples.entry(phase.to_string()).or_default().push(ns);
    }

    /// Start an RAII guard that records on drop.
    pub fn span(&self, phase: impl Into<String>) -> Span<'_> {
        Span {
            collector: self,
            phase: phase.into(),
            start: Instant::now(),
        }
    }

    pub fn report(&self, wall_clock_ns: u64) -> LatencyReport {
        let g = self.inner.lock();
        let mut phases: Vec<PhaseTiming> = g
            .samples
            .iter()
            .map(|(phase, xs)| {
                let mut v = xs.clone();
                v.sort_unstable();
                let total: u64 = v.iter().sum();
                let count = v.len();
                let pct = |p: f64| {
                    if count == 0 {
                        0u64
                    } else {
                        let idx = ((count as f64) * p).floor() as usize;
                        v[idx.min(count - 1)]
                    }
                };
                PhaseTiming {
                    phase: phase.clone(),
                    count,
                    total_ns: total,
                    p50_ns: pct(0.50),
                    p95_ns: pct(0.95),
                    p99_ns: pct(0.99),
                    max_ns: *v.last().unwrap_or(&0),
                    mean_ns: if count == 0 { 0 } else { total / count as u64 },
                }
            })
            .collect();
        phases.sort_by(|a, b| b.total_ns.cmp(&a.total_ns));
        LatencyReport {
            phases,
            wall_clock_ns,
        }
    }

    /// Erase all samples (used between runs).
    pub fn reset(&self) {
        self.inner.lock().samples.clear();
    }
}

pub struct Span<'a> {
    collector: &'a LatencyCollector,
    phase: String,
    start: Instant,
}

impl std::fmt::Debug for Span<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Span").field("phase", &self.phase).finish()
    }
}

impl Drop for Span<'_> {
    fn drop(&mut self) {
        let elapsed = self.start.elapsed().as_nanos() as u64;
        self.collector.observe(&self.phase, elapsed);
    }
}

impl LatencyReport {
    pub fn render_markdown(&self) -> String {
        use std::fmt::Write as _;
        let mut s = String::from("# Runtime latency\n\n");
        let _ = writeln!(s, "- Wall-clock: {:.2} ms", self.wall_clock_ns as f64 / 1e6);
        let _ = writeln!(s, "\n| Phase | N | Total | Mean | P50 | P95 | P99 | Max |");
        let _ = writeln!(s, "|---|---|---|---|---|---|---|---|");
        for p in &self.phases {
            let _ = writeln!(
                s,
                "| {} | {} | {:.3}ms | {:.1}µs | {:.1}µs | {:.1}µs | {:.1}µs | {:.1}µs |",
                p.phase,
                p.count,
                (p.total_ns as f64) / 1e6,
                (p.mean_ns as f64) / 1e3,
                (p.p50_ns as f64) / 1e3,
                (p.p95_ns as f64) / 1e3,
                (p.p99_ns as f64) / 1e3,
                (p.max_ns as f64) / 1e3,
            );
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn span_records_elapsed() {
        let c = LatencyCollector::new();
        {
            let _s = c.span("test");
            thread::sleep(Duration::from_millis(5));
        }
        let r = c.report(0);
        assert_eq!(r.phases.len(), 1);
        assert!(r.phases[0].total_ns > 3_000_000);
    }

    #[test]
    fn percentiles_ordering() {
        let c = LatencyCollector::new();
        for i in 1..=100u64 {
            c.observe("phase", i * 1000);
        }
        let r = c.report(0);
        let p = &r.phases[0];
        assert!(p.p50_ns < p.p95_ns);
        assert!(p.p95_ns <= p.p99_ns);
        assert!(p.p99_ns <= p.max_ns);
    }
}
