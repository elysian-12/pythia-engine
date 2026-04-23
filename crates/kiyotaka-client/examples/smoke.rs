//! Live smoke test — runs one request per endpoint with the API key from .env.
//! Prints a compact summary so we can eyeball that the client is wired right.

use domain::ids::ConditionId;
use kiyotaka_client::{Exchange, Interval, KiyotakaClient, LeaderboardFilter, SortBy};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::from_filename(".env").ok();
    let key = std::env::var("KIYOTAKA_API_KEY")?;
    let client = KiyotakaClient::new(key)?;

    let now = chrono::Utc::now().timestamp();

    let candles = client
        .candles(Exchange::BinanceFutures, "BTCUSDT", Interval::Hour, now - 7200, 7200)
        .await?;
    println!(
        "candles: n={} last_close={:.2} rate_remaining={}",
        candles.len(),
        candles.last().map(|c| c.close).unwrap_or(0.0),
        client.rate_snapshot().remaining
    );

    let funding = client
        .funding_rate(Exchange::BinanceFutures, "BTCUSDT", Interval::Hour, now - 86_400, 86_400)
        .await?;
    println!(
        "funding: n={} last_close={:.6e}",
        funding.len(),
        funding.last().map(|f| f.rate_close).unwrap_or(0.0)
    );

    let oi = client
        .open_interest(Exchange::BinanceFutures, "BTCUSDT", Interval::Hour, now - 86_400, 86_400)
        .await?;
    println!("oi: n={} last_close={:.2}", oi.len(), oi.last().map(|o| o.close).unwrap_or(0.0));

    let liq = client
        .liquidations(Exchange::BinanceFutures, "BTCUSDT", Interval::Hour, now - 86_400, 86_400)
        .await?;
    println!("liquidations: n={}", liq.len());

    let lb = client
        .leaderboard(&LeaderboardFilter {
            limit: Some(10),
            sort_by: Some(SortBy::RealizedPnl),
            min_win_rate: Some(60.0),
            ..Default::default()
        })
        .await?;
    println!("leaderboard: n={}", lb.len());
    for p in lb.iter().take(3) {
        println!(
            "  {} pnl={:.0} win_rate={:.1}% trades={}",
            p.wallet,
            p.total_realized_pnl,
            p.win_rate_by_positions,
            p.closed_position_count
        );
    }

    if let Some(top) = lb.first() {
        if let Some(prof) = client.trader_profile(&top.wallet).await? {
            println!(
                "trader-profile: wallet={} pnl={:.0}",
                prof.wallet, prof.total_realized_pnl
            );
        }

        let pos = client.positions(Some(&top.wallet), None, 5, 0).await?;
        println!("positions(wallet): n={}", pos.len());
        if let Some(p) = pos.first() {
            println!("  sample: '{}' ({})", p.market_name, p.category);

            let ms = client
                .market_summary(&p.condition_id, domain::time::EventTs::from_secs(now))
                .await?;
            println!(
                "market-summary: event_id={} open={} closed={} win_rate={:.2}",
                ms.event_id, ms.total_open_positions, ms.total_closed_positions, ms.win_rate
            );
        }
    }

    // Arbitrary live condition_id fallback so we always hit the endpoint.
    let probe = ConditionId::new("0xe0658c4beed2102c181b3987edff5edd578ad2952a6eb5fa8018925e5d7a48fd");
    let _ = client
        .positions(None, Some(&probe), 3, 0)
        .await
        .map(|p| println!("positions(conditionId): n={}", p.len()))?;

    println!("OK");
    Ok(())
}
