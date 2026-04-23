//! Shared app state for the API.

use std::sync::Arc;

use evaluation::LatencyCollector;
use kiyotaka_client::KiyotakaClient;
use store::Store;

#[derive(Clone)]
#[allow(missing_debug_implementations)]
pub struct AppState {
    pub store: Store,
    pub client: Arc<KiyotakaClient>,
    pub latency: Arc<LatencyCollector>,
}
