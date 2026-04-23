//! Higher-level queries for building `MarketState` snapshots and serving
//! API routes.

use crate::{Store, StoreError};
use domain::{
    crypto::{Asset, Candle},
    ids::{ConditionId, Wallet},
    position::UserPosition,
    trader::TraderProfile,
};

impl Store {
    /// Most recent trader profile per wallet.
    pub fn latest_trader_profiles(&self) -> Result<Vec<TraderProfile>, StoreError> {
        let conn = self.conn_lock();
        let mut stmt = conn.prepare(
            "SELECT wallet, total_position_count, open_position_count, closed_position_count, \
             total_size, total_realized_pnl, total_unrealized_pnl, win_rate, avg_holding_duration, \
             asof_ts FROM trader_profiles ORDER BY asof_ts DESC",
        )?;
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let rows = stmt.query_map([], |r| {
            Ok(TraderProfile {
                wallet: Wallet::new(r.get::<_, String>(0)?),
                total_position_count: r.get(1)?,
                open_position_count: r.get(2)?,
                closed_position_count: r.get(3)?,
                total_size: r.get(4)?,
                total_realized_pnl: r.get(5)?,
                total_unrealized_pnl: r.get(6)?,
                total_roi: 0.0,
                win_rate_by_positions: r.get(7)?,
                largest_win: 0.0,
                largest_loss: 0.0,
                avg_holding_duration: r.get(8)?,
            })
        })?;
        for row in rows {
            let p = row?;
            if seen.insert(p.wallet.as_str().to_string()) {
                out.push(p);
            }
        }
        Ok(out)
    }

    /// Most recent snapshot of positions per (wallet, condition_id).
    pub fn latest_positions_for_condition(
        &self,
        cid: &ConditionId,
    ) -> Result<Vec<UserPosition>, StoreError> {
        let conn = self.conn_lock();
        let mut stmt = conn.prepare(
            "SELECT wallet, asset_id, condition_id, unrealized_size, realized_size, avg_price, \
             avg_exit_price, realized_pnl, latest_open_ts, market_name, outcome_name, category, sub_category, asof_ts \
             FROM user_positions WHERE condition_id = ? \
             QUALIFY ROW_NUMBER() OVER (PARTITION BY wallet ORDER BY asof_ts DESC) = 1",
        )?;
        let rows = stmt.query_map([cid.as_str()], |r| {
            Ok(UserPosition {
                wallet: Wallet::new(r.get::<_, String>(0)?),
                asset_id: domain::ids::AssetId::new(r.get::<_, String>(1)?),
                condition_id: ConditionId::new(r.get::<_, String>(2)?),
                unrealized_size: r.get(3)?,
                realized_size: r.get(4)?,
                avg_price: r.get(5)?,
                avg_exit_price: r.get(6)?,
                realized_pnl: r.get(7)?,
                resolved_price: None,
                latest_open_ts: r.get(8)?,
                prev_hold_duration: 0,
                buy_count: 0,
                sell_count: 0,
                market_name: r.get::<_, String>(9)?,
                outcome_name: r.get::<_, String>(10)?,
                category: category_from_string(r.get::<_, String>(11)?),
                sub_category: r.get::<_, String>(12)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Latest N candles ordered ascending by event_ts.
    pub fn candles_asc(&self, asset: Asset, n: usize) -> Result<Vec<Candle>, StoreError> {
        let mut c = self.recent_candles(asset, n)?;
        c.sort_by_key(|x| x.ts.0);
        Ok(c)
    }

    /// Most recent market summary as JSON payload (already serialised
    /// during upsert). Useful for hydrating UI.
    pub fn latest_summary_payload(&self, cid: &ConditionId) -> Result<Option<String>, StoreError> {
        let conn = self.conn_lock();
        let mut stmt = conn.prepare(
            "SELECT payload_json FROM market_summaries \
             WHERE condition_id = ? ORDER BY asof_ts DESC LIMIT 1",
        )?;
        let mut rows = stmt.query([cid.as_str()])?;
        if let Some(r) = rows.next()? {
            Ok(Some(r.get::<_, String>(0)?))
        } else {
            Ok(None)
        }
    }

    /// Return every closed trade ordered by entry_ts for equity curve reporting.
    pub fn all_trades(&self) -> Result<Vec<StoredTrade>, StoreError> {
        let conn = self.conn_lock();
        let mut stmt = conn.prepare(
            "SELECT signal_id, asset, direction, entry_ts, entry_price, exit_ts, exit_price, \
             pnl_usd, r_multiple, close_reason FROM trades ORDER BY entry_ts ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(StoredTrade {
                signal_id: r.get(0)?,
                asset: r.get(1)?,
                direction: r.get(2)?,
                entry_ts: r.get(3)?,
                entry_price: r.get(4)?,
                exit_ts: r.get(5).ok(),
                exit_price: r.get(6).ok(),
                pnl_usd: r.get(7).ok(),
                r_multiple: r.get(8).ok(),
                close_reason: r.get(9).ok(),
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn all_signals(&self) -> Result<Vec<StoredSignalRow>, StoreError> {
        let conn = self.conn_lock();
        let mut stmt = conn.prepare(
            "SELECT id, fired_ts, condition_id, market_name, asset, direction, \
             swp, mid, edge, is_pm, granger_f, gini, conviction FROM signals ORDER BY fired_ts DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(StoredSignalRow {
                id: r.get(0)?,
                fired_ts: r.get(1)?,
                condition_id: r.get(2)?,
                market_name: r.get(3)?,
                asset: r.get(4)?,
                direction: r.get(5)?,
                swp: r.get(6)?,
                mid: r.get(7)?,
                edge: r.get(8)?,
                is_pm: r.get(9)?,
                granger_f: r.get(10)?,
                gini: r.get(11)?,
                conviction: r.get(12)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }
}

fn category_from_string(s: String) -> domain::market::Category {
    use domain::market::Category;
    match s.as_str() {
        "Politics" => Category::Politics,
        "Crypto" => Category::Crypto,
        "Sports" => Category::Sports,
        "Pop" => Category::Pop,
        "Business" => Category::Business,
        "Science" => Category::Science,
        _ => Category::Other(s),
    }
}

impl Store {
    fn conn_lock(&self) -> parking_lot::MutexGuard<'_, duckdb::Connection> {
        self.connection()
    }

    /// Access to the internal connection — module-scoped through the
    /// `queries` layer. Used by API routes that need custom SQL.
    pub fn connection(&self) -> parking_lot::MutexGuard<'_, duckdb::Connection> {
        self.inner_conn_lock()
    }
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct StoredTrade {
    pub signal_id: String,
    pub asset: String,
    pub direction: String,
    pub entry_ts: i64,
    pub entry_price: f64,
    pub exit_ts: Option<i64>,
    pub exit_price: Option<f64>,
    pub pnl_usd: Option<f64>,
    pub r_multiple: Option<f64>,
    pub close_reason: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct StoredSignalRow {
    pub id: String,
    pub fired_ts: i64,
    pub condition_id: String,
    pub market_name: String,
    pub asset: String,
    pub direction: String,
    pub swp: f64,
    pub mid: f64,
    pub edge: f64,
    pub is_pm: f64,
    pub granger_f: f64,
    pub gini: f64,
    pub conviction: u8,
}
