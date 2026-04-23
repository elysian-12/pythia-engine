//! Embedded DuckDB store.
//!
//! Schema is append-only for snapshots. Two timestamp columns per fact:
//! `event_ts` = when the fact happened, `asof_ts` = when we observed it.
//! Queries specify "state as of T" to prevent look-ahead bias.

#![deny(unused_must_use)]

use domain::{
    crypto::{Asset, Candle, FundingRate, Liquidation, OpenInterest},
    ids::{ConditionId, Wallet},
    market::MarketSummary,
    position::UserPosition,
    signal::{Signal, Trade},
    time::{AsofTs, EventTs},
    trader::TraderProfile,
};
use parking_lot::Mutex;
use std::{path::Path, sync::Arc};
use thiserror::Error;

pub mod queries;

pub use queries::{StoredSignalRow, StoredTrade};

pub type Result<T> = std::result::Result<T, StoreError>;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("duckdb: {0}")]
    Db(#[from] duckdb::Error),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
}

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<duckdb::Connection>>,
}

impl Store {
    fn inner_conn_lock(&self) -> parking_lot::MutexGuard<'_, duckdb::Connection> {
        self.conn.lock()
    }
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store").finish_non_exhaustive()
    }
}

const SCHEMA: &str = r"
CREATE TABLE IF NOT EXISTS candles (
    asset TEXT NOT NULL,
    event_ts BIGINT NOT NULL,
    asof_ts BIGINT NOT NULL,
    open DOUBLE NOT NULL,
    high DOUBLE NOT NULL,
    low DOUBLE NOT NULL,
    close DOUBLE NOT NULL,
    volume DOUBLE NOT NULL,
    PRIMARY KEY (asset, event_ts)
);

CREATE TABLE IF NOT EXISTS funding (
    asset TEXT NOT NULL,
    event_ts BIGINT NOT NULL,
    asof_ts BIGINT NOT NULL,
    rate_open DOUBLE NOT NULL,
    rate_close DOUBLE NOT NULL,
    predicted_close DOUBLE,
    PRIMARY KEY (asset, event_ts)
);

CREATE TABLE IF NOT EXISTS open_interest (
    asset TEXT NOT NULL,
    event_ts BIGINT NOT NULL,
    asof_ts BIGINT NOT NULL,
    close DOUBLE NOT NULL,
    high DOUBLE NOT NULL,
    low DOUBLE NOT NULL,
    PRIMARY KEY (asset, event_ts)
);

CREATE TABLE IF NOT EXISTS liquidations (
    asset TEXT NOT NULL,
    event_ts BIGINT NOT NULL,
    asof_ts BIGINT NOT NULL,
    side TEXT NOT NULL,
    volume_usd DOUBLE NOT NULL,
    PRIMARY KEY (asset, event_ts, side)
);

CREATE TABLE IF NOT EXISTS trader_profiles (
    wallet TEXT NOT NULL,
    asof_ts BIGINT NOT NULL,
    total_position_count BIGINT NOT NULL,
    open_position_count BIGINT NOT NULL,
    closed_position_count BIGINT NOT NULL,
    total_realized_pnl DOUBLE NOT NULL,
    total_unrealized_pnl DOUBLE NOT NULL,
    total_size DOUBLE NOT NULL,
    win_rate DOUBLE NOT NULL,
    avg_holding_duration BIGINT NOT NULL,
    PRIMARY KEY (wallet, asof_ts)
);

CREATE TABLE IF NOT EXISTS user_positions (
    wallet TEXT NOT NULL,
    condition_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    asof_ts BIGINT NOT NULL,
    unrealized_size DOUBLE NOT NULL,
    realized_size DOUBLE NOT NULL,
    avg_price DOUBLE NOT NULL,
    avg_exit_price DOUBLE NOT NULL,
    realized_pnl DOUBLE NOT NULL,
    latest_open_ts BIGINT NOT NULL,
    market_name TEXT NOT NULL,
    outcome_name TEXT NOT NULL,
    category TEXT NOT NULL,
    sub_category TEXT NOT NULL,
    PRIMARY KEY (wallet, condition_id, asof_ts)
);

CREATE TABLE IF NOT EXISTS market_summaries (
    condition_id TEXT NOT NULL,
    asof_ts BIGINT NOT NULL,
    event_id TEXT NOT NULL,
    total_open_positions BIGINT NOT NULL,
    total_closed_positions BIGINT NOT NULL,
    total_size DOUBLE NOT NULL,
    win_rate DOUBLE NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (condition_id, asof_ts)
);

CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY,
    fired_ts BIGINT NOT NULL,
    condition_id TEXT NOT NULL,
    market_name TEXT NOT NULL,
    asset TEXT NOT NULL,
    direction TEXT NOT NULL,
    swp DOUBLE NOT NULL,
    mid DOUBLE NOT NULL,
    edge DOUBLE NOT NULL,
    is_pm DOUBLE NOT NULL,
    granger_f DOUBLE NOT NULL,
    gini DOUBLE NOT NULL,
    conviction INTEGER NOT NULL,
    horizon_s BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
    signal_id TEXT PRIMARY KEY,
    asset TEXT NOT NULL,
    direction TEXT NOT NULL,
    entry_ts BIGINT NOT NULL,
    entry_price DOUBLE NOT NULL,
    exit_ts BIGINT,
    exit_price DOUBLE,
    fees DOUBLE NOT NULL,
    funding_paid DOUBLE NOT NULL,
    slippage DOUBLE NOT NULL,
    close_reason TEXT,
    r_multiple DOUBLE,
    pnl_usd DOUBLE
);

CREATE INDEX IF NOT EXISTS idx_candles_asset_ts ON candles(asset, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_funding_asset_ts ON funding(asset, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_oi_asset_ts ON open_interest(asset, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_liq_asset_ts ON liquidations(asset, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_positions_cond ON user_positions(condition_id, asof_ts DESC);
CREATE INDEX IF NOT EXISTS idx_ms_cond ON market_summaries(condition_id, asof_ts DESC);
";

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = duckdb::Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = duckdb::Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn upsert_candles(&self, asset: Asset, candles: &[Candle]) -> Result<usize> {
        let asof = AsofTs::now().0;
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "INSERT OR REPLACE INTO candles \
             (asset, event_ts, asof_ts, open, high, low, close, volume) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )?;
        let mut n = 0;
        for c in candles {
            stmt.execute(duckdb::params![
                asset.symbol(),
                c.ts.0,
                asof,
                c.open,
                c.high,
                c.low,
                c.close,
                c.volume
            ])?;
            n += 1;
        }
        Ok(n)
    }

    pub fn upsert_funding(&self, asset: Asset, rates: &[FundingRate]) -> Result<usize> {
        let asof = AsofTs::now().0;
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "INSERT OR REPLACE INTO funding \
             (asset, event_ts, asof_ts, rate_open, rate_close, predicted_close) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )?;
        let mut n = 0;
        for r in rates {
            stmt.execute(duckdb::params![
                asset.symbol(),
                r.ts.0,
                asof,
                r.rate_open,
                r.rate_close,
                r.predicted_close
            ])?;
            n += 1;
        }
        Ok(n)
    }

    pub fn upsert_oi(&self, asset: Asset, oi: &[OpenInterest]) -> Result<usize> {
        let asof = AsofTs::now().0;
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "INSERT OR REPLACE INTO open_interest \
             (asset, event_ts, asof_ts, close, high, low) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )?;
        let mut n = 0;
        for o in oi {
            stmt.execute(duckdb::params![asset.symbol(), o.ts.0, asof, o.close, o.high, o.low])?;
            n += 1;
        }
        Ok(n)
    }

    pub fn upsert_liquidations(&self, asset: Asset, liqs: &[Liquidation]) -> Result<usize> {
        let asof = AsofTs::now().0;
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "INSERT OR REPLACE INTO liquidations \
             (asset, event_ts, asof_ts, side, volume_usd) \
             VALUES (?, ?, ?, ?, ?)",
        )?;
        let mut n = 0;
        for l in liqs {
            let side = match l.side {
                domain::crypto::LiqSide::Buy => "BUY",
                domain::crypto::LiqSide::Sell => "SELL",
            };
            stmt.execute(duckdb::params![asset.symbol(), l.ts.0, asof, side, l.volume_usd])?;
            n += 1;
        }
        Ok(n)
    }

    pub fn upsert_trader_profile(&self, p: &TraderProfile) -> Result<()> {
        let asof = AsofTs::now().0;
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO trader_profiles \
             (wallet, asof_ts, total_position_count, open_position_count, closed_position_count, \
              total_realized_pnl, total_unrealized_pnl, total_size, win_rate, avg_holding_duration) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            duckdb::params![
                p.wallet.as_str(),
                asof,
                p.total_position_count,
                p.open_position_count,
                p.closed_position_count,
                p.total_realized_pnl,
                p.total_unrealized_pnl,
                p.total_size,
                p.win_rate_by_positions,
                p.avg_holding_duration
            ],
        )?;
        Ok(())
    }

    pub fn upsert_positions(&self, positions: &[UserPosition]) -> Result<usize> {
        let asof = AsofTs::now().0;
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "INSERT OR REPLACE INTO user_positions \
             (wallet, condition_id, asset_id, asof_ts, unrealized_size, realized_size, avg_price, \
              avg_exit_price, realized_pnl, latest_open_ts, market_name, outcome_name, category, sub_category) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )?;
        let mut n = 0;
        for p in positions {
            stmt.execute(duckdb::params![
                p.wallet.as_str(),
                p.condition_id.as_str(),
                p.asset_id.as_str(),
                asof,
                p.unrealized_size,
                p.realized_size,
                p.avg_price,
                p.avg_exit_price,
                p.realized_pnl,
                p.latest_open_ts,
                p.market_name,
                p.outcome_name,
                p.category.to_string(),
                p.sub_category
            ])?;
            n += 1;
        }
        Ok(n)
    }

    pub fn upsert_market_summary(&self, cid: &ConditionId, ms: &MarketSummary) -> Result<()> {
        let asof = ms.asof.0;
        let conn = self.conn.lock();
        let payload = serde_json::to_string(ms)?;
        conn.execute(
            "INSERT OR REPLACE INTO market_summaries \
             (condition_id, asof_ts, event_id, total_open_positions, total_closed_positions, \
              total_size, win_rate, payload_json) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            duckdb::params![
                cid.as_str(),
                asof,
                ms.event_id,
                ms.total_open_positions,
                ms.total_closed_positions,
                ms.total_size,
                ms.win_rate,
                payload
            ],
        )?;
        Ok(())
    }

    pub fn insert_signal(&self, s: &Signal) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO signals \
             (id, fired_ts, condition_id, market_name, asset, direction, swp, mid, edge, is_pm, \
              granger_f, gini, conviction, horizon_s) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            duckdb::params![
                s.id,
                s.ts.0,
                s.condition_id.as_str(),
                s.market_name,
                match s.asset {
                    Asset::Btc => "BTC",
                    Asset::Eth => "ETH",
                },
                match s.direction {
                    domain::signal::Direction::Long => "LONG",
                    domain::signal::Direction::Short => "SHORT",
                },
                s.swp,
                s.mid,
                s.edge,
                s.is_pm,
                s.granger_f,
                s.gini,
                s.conviction,
                s.horizon_s
            ],
        )?;
        Ok(())
    }

    pub fn upsert_trade(&self, t: &Trade) -> Result<()> {
        let conn = self.conn.lock();
        let dir = match t.direction {
            domain::signal::Direction::Long => "LONG",
            domain::signal::Direction::Short => "SHORT",
        };
        let close_reason = t.close_reason.as_ref().map(|r| match r {
            domain::signal::CloseReason::TakeProfit => "TP",
            domain::signal::CloseReason::StopLoss => "SL",
            domain::signal::CloseReason::TimeStop => "TIME",
            domain::signal::CloseReason::RegimeBreak => "REGIME",
        });
        conn.execute(
            "INSERT OR REPLACE INTO trades \
             (signal_id, asset, direction, entry_ts, entry_price, exit_ts, exit_price, \
              fees, funding_paid, slippage, close_reason, r_multiple, pnl_usd) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            duckdb::params![
                t.signal_id,
                match t.asset {
                    Asset::Btc => "BTC",
                    Asset::Eth => "ETH",
                },
                dir,
                t.entry_ts.0,
                t.entry_price,
                t.exit_ts.map(|e| e.0),
                t.exit_price,
                t.fees,
                t.funding_paid,
                t.slippage,
                close_reason,
                t.r_multiple,
                t.pnl_usd
            ],
        )?;
        Ok(())
    }

    pub fn recent_candles(&self, asset: Asset, n: usize) -> Result<Vec<Candle>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT event_ts, open, high, low, close, volume FROM candles \
             WHERE asset = ? ORDER BY event_ts DESC LIMIT ?",
        )?;
        let rows = stmt.query_map(duckdb::params![asset.symbol(), n as i64], |r| {
            Ok(Candle {
                ts: EventTs::from_secs(r.get::<_, i64>(0)?),
                open: r.get(1)?,
                high: r.get(2)?,
                low: r.get(3)?,
                close: r.get(4)?,
                volume: r.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        out.reverse();
        Ok(out)
    }

    pub fn active_conditions(&self) -> Result<Vec<ConditionId>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT DISTINCT condition_id FROM user_positions \
             WHERE unrealized_size > 0 ORDER BY condition_id",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(ConditionId::new(r?));
        }
        Ok(out)
    }

    pub fn tracked_wallets(&self) -> Result<Vec<Wallet>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT wallet FROM trader_profiles")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(Wallet::new(r?));
        }
        Ok(out)
    }

    pub fn count_table(&self, name: &str) -> Result<i64> {
        let conn = self.conn.lock();
        // name must be a static table name; we defensively whitelist
        let ok = matches!(
            name,
            "candles"
                | "funding"
                | "open_interest"
                | "liquidations"
                | "trader_profiles"
                | "user_positions"
                | "market_summaries"
                | "signals"
                | "trades"
        );
        if !ok {
            return Ok(-1);
        }
        let q = format!("SELECT COUNT(*) FROM {name}");
        let n: i64 = conn.query_row(&q, [], |r| r.get(0))?;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::crypto::Candle;

    #[test]
    fn boots_schema() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.count_table("candles").unwrap(), 0);
    }

    #[test]
    fn roundtrips_candles() {
        let s = Store::open_in_memory().unwrap();
        let c = vec![Candle {
            ts: EventTs::from_secs(1),
            open: 10.0,
            high: 11.0,
            low: 9.0,
            close: 10.5,
            volume: 100.0,
        }];
        s.upsert_candles(Asset::Btc, &c).unwrap();
        let out = s.recent_candles(Asset::Btc, 10).unwrap();
        assert_eq!(out.len(), 1);
        assert!((out[0].close - 10.5).abs() < 1e-9);
    }
}
