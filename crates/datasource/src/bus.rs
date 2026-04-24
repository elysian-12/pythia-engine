//! Broadcast bus for `Event`s.
//!
//! Uses `tokio::sync::broadcast` — lossy under extreme back-pressure
//! (consumers that fall behind by more than the buffer lose events),
//! which is the right tradeoff for a real-time trading system. If a
//! strategy needs lossless ingest it should use a dedicated channel.

use tokio::sync::broadcast;

use crate::events::Event;

/// Default buffer size — 4096 events is ~1 s of peak Binance liq flow
/// with headroom. Subscribers that process events in <100 µs (i.e. any
/// reasonable aggregator) will never drop.
pub const DEFAULT_CAPACITY: usize = 4096;

#[derive(Debug)]
pub struct Bus {
    tx: broadcast::Sender<Event>,
}

impl Default for Bus {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY)
    }
}

impl Bus {
    pub fn new(capacity: usize) -> Self {
        let (tx, _rx) = broadcast::channel(capacity);
        Self { tx }
    }

    pub fn handle(&self) -> BusHandle {
        BusHandle { tx: self.tx.clone() }
    }

    pub fn subscribe(&self) -> BusSubscriber {
        BusSubscriber { rx: self.tx.subscribe() }
    }
}

#[derive(Clone, Debug)]
pub struct BusHandle {
    tx: broadcast::Sender<Event>,
}

impl BusHandle {
    pub fn publish(&self, event: Event) {
        // `send` fails only when there are no subscribers — treat that
        // as "no one cares yet" and drop silently. Later subscribers
        // will start catching events from the next publish.
        let _ = self.tx.send(event);
    }

    pub fn subscriber_count(&self) -> usize {
        self.tx.receiver_count()
    }
}

#[derive(Debug)]
pub struct BusSubscriber {
    rx: broadcast::Receiver<Event>,
}

impl BusSubscriber {
    /// Await the next event. Returns `Ok(Event)` or `Err(Lag)` when the
    /// subscriber has fallen behind.
    pub async fn recv(&mut self) -> Result<Event, broadcast::error::RecvError> {
        self.rx.recv().await
    }

    pub fn try_recv(&mut self) -> Result<Event, broadcast::error::TryRecvError> {
        self.rx.try_recv()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::*;
    use domain::{crypto::LiqSide, time::EventTs};

    #[tokio::test]
    async fn broadcasts_to_all_subscribers() {
        let bus = Bus::default();
        let mut a = bus.subscribe();
        let mut b = bus.subscribe();

        let h = bus.handle();
        h.publish(Event::Liquidation(LiqEvent {
            ts: EventTs::from_secs(1),
            exchange: "BINANCE_FUTURES".into(),
            symbol: "BTCUSDT".into(),
            side: LiqSide::Buy,
            usd_value: 10_000.0,
        }));

        assert!(matches!(a.recv().await, Ok(Event::Liquidation(_))));
        assert!(matches!(b.recv().await, Ok(Event::Liquidation(_))));
    }
}
