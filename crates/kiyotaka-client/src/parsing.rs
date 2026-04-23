//! DTO → domain converters. Isolated so error handling and defaults live in
//! one place.

use domain::{
    crypto::{Candle, FundingRate, LiqSide, Liquidation, OpenInterest},
    ids::{AssetId, ConditionId, Wallet},
    market::{Category, MarketSummary, OutcomePricing},
    position::UserPosition,
    time::EventTs,
    trader::TraderProfile,
};

use crate::dto;

pub(crate) fn flatten_series<P, T, F>(env: dto::SeriesEnvelope<P>, f: F) -> Vec<T>
where
    F: Fn(&P) -> Option<T>,
{
    let mut out = Vec::new();
    for s in env.series {
        for pw in s.points {
            if let Some(v) = f(&pw.point) {
                out.push(v);
            }
        }
    }
    out
}

pub(crate) fn candle_from(p: &dto::CandlePoint) -> Option<Candle> {
    Some(Candle {
        ts: EventTs::from_secs(p.timestamp.seconds),
        open: p.open?,
        high: p.high?,
        low: p.low?,
        close: p.close?,
        volume: p.volume.unwrap_or(0.0),
    })
}

pub(crate) fn funding_from(p: &dto::FundingPoint) -> Option<FundingRate> {
    let rate_close = p.rate_close?;
    Some(FundingRate {
        ts: EventTs::from_secs(p.timestamp.seconds),
        rate_open: p.rate_open.unwrap_or(rate_close),
        rate_close,
        predicted_close: p.predicted_close,
    })
}

pub(crate) fn oi_from(p: &dto::OpenInterestPoint) -> Option<OpenInterest> {
    Some(OpenInterest {
        ts: EventTs::from_secs(p.timestamp.seconds),
        close: p.close?,
        high: p.high.unwrap_or(p.close?),
        low: p.low.unwrap_or(p.close?),
    })
}

pub(crate) fn flatten_liquidations(env: dto::SeriesEnvelope<dto::LiquidationPoint>) -> Vec<Liquidation> {
    let mut out = Vec::new();
    for s in env.series {
        let side = match s.id.side.as_deref() {
            Some("BUY") => LiqSide::Buy,
            Some("SELL") => LiqSide::Sell,
            _ => continue,
        };
        for pw in s.points {
            let Some(v) = pw.point.liquidations else { continue };
            out.push(Liquidation {
                ts: EventTs::from_secs(pw.point.timestamp.seconds),
                side,
                volume_usd: v,
            });
        }
    }
    out
}

pub(crate) fn trader_from(r: dto::RawTraderProfile) -> TraderProfile {
    TraderProfile {
        wallet: Wallet::new(r.wallet_address),
        total_position_count: r.total_position_count,
        open_position_count: r.open_position_count,
        closed_position_count: r.closed_position_count,
        total_size: r.total_size,
        total_realized_pnl: r.total_realized_pnl,
        total_unrealized_pnl: r.total_unrealized_pnl,
        total_roi: r.total_roi,
        win_rate_by_positions: r.win_rate_by_positions,
        largest_win: r.largest_win,
        largest_loss: r.largest_loss,
        avg_holding_duration: r.avg_holding_duration,
    }
}

pub(crate) fn position_from(r: dto::RawPosition) -> UserPosition {
    UserPosition {
        wallet: Wallet::new(r.wallet_address),
        asset_id: AssetId::new(r.asset_id),
        condition_id: ConditionId::new(r.condition_id),
        unrealized_size: r.unrealized_size,
        realized_size: r.realized_size,
        avg_price: r.avg_price,
        avg_exit_price: r.avg_exit_price,
        realized_pnl: r.realized_pnl,
        resolved_price: r.resolved_price,
        latest_open_ts: r.latest_open_ts,
        prev_hold_duration: r.prev_hold_duration,
        buy_count: r.buy_count,
        sell_count: r.sell_count,
        market_name: r.market_name,
        outcome_name: r.outcome_name,
        category: category_from_str(&r.category),
        sub_category: r.sub_category,
    }
}

pub(crate) fn market_summary_from(r: dto::RawMarketSummary, asof: EventTs) -> MarketSummary {
    MarketSummary {
        event_id: r.event_id,
        condition_ids: r.condition_id.into_iter().map(ConditionId::new).collect(),
        total_open_positions: r.total_open_positions,
        total_closed_positions: r.total_closed_positions,
        total_cost_basis: r.total_cost_basis,
        total_size: r.total_size,
        largest_open_position: r.largest_open_position,
        total_buy_count: r.total_buy_count,
        total_sell_count: r.total_sell_count,
        net_transfer_flow: r.net_transfer_flow,
        median_hold_duration: r.median_hold_duration,
        mean_hold_duration: r.mean_hold_duration,
        realized_pnl_min: r.realized_pnl_min,
        realized_pnl_max: r.realized_pnl_max,
        realized_pnl_distribution: r.realized_pnl_distribution,
        win_rate: r.win_rate,
        avg_size: r.avg_size,
        outcome_pricing: r
            .outcome_pricing
            .into_iter()
            .map(|o| OutcomePricing {
                condition_id: ConditionId::new(o.condition_id),
                token_id: AssetId::new(o.token_id),
                outcome_name: o.outcome_name,
                weighted_avg_entry_price: o.weighted_avg_entry_price,
                weighted_avg_exit_price: o.weighted_avg_exit_price,
                open_pos_avg_price_distribution: o.open_pos_avg_price_distribution,
                closed_pos_avg_exit_price_distribution: o.closed_pos_avg_exit_price_distribution,
            })
            .collect(),
        asof,
    }
}

fn category_from_str(s: &str) -> Category {
    match s {
        "Politics" => Category::Politics,
        "Crypto" => Category::Crypto,
        "Sports" => Category::Sports,
        "Pop" => Category::Pop,
        "Business" => Category::Business,
        "Science" => Category::Science,
        other => Category::Other(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANDLE_FIX: &str = include_str!("../../../fixtures/kiyotaka/candles_btc_1h.json");
    const FUNDING_FIX: &str = include_str!("../../../fixtures/kiyotaka/funding_btc_24h.json");
    const OI_FIX: &str = include_str!("../../../fixtures/kiyotaka/oi_btc_24h.json");
    const LIQ_FIX: &str = include_str!("../../../fixtures/kiyotaka/liq_btc_24h.json");
    const LB_FIX: &str = include_str!("../../../fixtures/kiyotaka/pm_leaderboard.json");
    const POS_FIX: &str = include_str!("../../../fixtures/kiyotaka/pm_positions_market.json");
    const MS_FIX: &str = include_str!("../../../fixtures/kiyotaka/pm_market_summary.json");

    #[test]
    fn decodes_candles() {
        let env: dto::SeriesEnvelope<dto::CandlePoint> = serde_json::from_str(CANDLE_FIX).unwrap();
        let out = flatten_series(env, candle_from);
        assert!(!out.is_empty());
        assert!(out[0].close > 0.0);
    }

    #[test]
    fn decodes_funding() {
        let env: dto::SeriesEnvelope<dto::FundingPoint> = serde_json::from_str(FUNDING_FIX).unwrap();
        let out = flatten_series(env, funding_from);
        assert!(!out.is_empty());
    }

    #[test]
    fn decodes_oi() {
        let env: dto::SeriesEnvelope<dto::OpenInterestPoint> =
            serde_json::from_str(OI_FIX).unwrap();
        let out = flatten_series(env, oi_from);
        assert!(!out.is_empty());
        assert!(out[0].close > 0.0);
    }

    #[test]
    fn decodes_liquidations_both_sides() {
        let env: dto::SeriesEnvelope<dto::LiquidationPoint> =
            serde_json::from_str(LIQ_FIX).unwrap();
        let out = flatten_liquidations(env);
        let has_buy = out.iter().any(|x| matches!(x.side, LiqSide::Buy));
        let has_sell = out.iter().any(|x| matches!(x.side, LiqSide::Sell));
        assert!(has_buy && has_sell);
    }

    #[test]
    fn decodes_leaderboard() {
        let env: dto::LeaderboardEnvelope = serde_json::from_str(LB_FIX).unwrap();
        let profiles: Vec<_> = env.trader_profiles.into_iter().map(trader_from).collect();
        assert!(!profiles.is_empty());
        assert!(profiles[0].total_realized_pnl > 0.0);
    }

    #[test]
    fn decodes_positions() {
        let env: dto::PositionsEnvelope = serde_json::from_str(POS_FIX).unwrap();
        let out: Vec<_> = env.user_positions.into_iter().map(position_from).collect();
        assert!(!out.is_empty());
        assert!(matches!(out[0].category, Category::Politics));
    }

    #[test]
    fn decodes_market_summary() {
        let env: dto::MarketSummaryEnvelope = serde_json::from_str(MS_FIX).unwrap();
        let ms = market_summary_from(env.market_summary.unwrap(), EventTs::from_secs(0));
        assert!(!ms.outcome_pricing.is_empty());
        assert_eq!(ms.outcome_pricing[0].open_pos_avg_price_distribution.len(), 101);
    }
}
