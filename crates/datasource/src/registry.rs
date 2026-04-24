//! The `DataSource` trait + a tiny registry that spawns all registered
//! sources onto a single bus.

use async_trait::async_trait;
use std::sync::Arc;
use tokio::sync::Notify;
use tracing::{info, warn};

use crate::bus::{Bus, BusHandle};

/// Anything that can publish `Event`s. Implementations own their
/// connection loops and reconnect logic internally.
#[async_trait]
pub trait DataSource: Send + Sync {
    fn id(&self) -> &'static str;

    /// Spawn the source's background task(s) and return once the source
    /// has published its first frame or timed out. `bus` is cloned into
    /// the task(s).
    async fn start(&self, bus: BusHandle, shutdown: Arc<Notify>);
}

#[derive(Default)]
pub struct SourceRegistry {
    sources: Vec<Box<dyn DataSource>>,
}

impl std::fmt::Debug for SourceRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourceRegistry")
            .field("sources", &self.sources.iter().map(|s| s.id()).collect::<Vec<_>>())
            .finish()
    }
}

impl SourceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with(mut self, source: Box<dyn DataSource>) -> Self {
        self.sources.push(source);
        self
    }

    pub fn ids(&self) -> Vec<&'static str> {
        self.sources.iter().map(|s| s.id()).collect()
    }

    /// Start every registered source onto the supplied bus.
    pub async fn start_all(self, bus: &Bus, shutdown: Arc<Notify>) {
        info!(n = self.sources.len(), ids = ?self.ids(), "starting data sources");
        for source in self.sources {
            let handle = bus.handle();
            let sd = Arc::clone(&shutdown);
            tokio::spawn(async move {
                let id = source.id();
                info!(source = id, "source starting");
                source.start(handle, sd).await;
                warn!(source = id, "source exited");
            });
        }
    }
}
