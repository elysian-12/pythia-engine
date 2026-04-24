//! `pythia-swarm-live` — live trader binary driven by the agent swarm.
//!
//! Pipeline:
//!
//! ```text
//!   Binance public WS ──▶ unified swarm::Event
//!                                │
//!                                ▼
//!                  Swarm::broadcast → Vec<AgentDecision>
//!                                │
//!                                ├──▶ Scoreboard.record (pending)
//!                                │
//!                                └──▶ consensus() ─▶ Hyperliquid REST
//!
//!   tokio ticker (60 s) ──▶ mark expired pending decisions
//!                                        (using current HL mids)
//!   tokio ticker (10 s) ──▶ write snapshot JSON for the UI
//! ```
//!
//! Env:
//!   HL_PRIVATE_KEY           — required for `--mode live`. Hex.
//!   HL_ADDRESS               — optional; derived from key if absent.
//!   PYTHIA_MODE              — "dryrun" (default) | "live"
//!   PYTHIA_RISK              — risk fraction floor, default 0.005
//!   PYTHIA_SNAPSHOT          — snapshot JSON path, default data/swarm-snapshot.json

use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

use domain::{
    crypto::{Asset, LiqSide},
    signal::Direction,
    time::EventTs,
};
use exchange_hyperliquid::{
    HyperliquidClient, OrderRequest, OrderSide, PrivateKeySigner, Signer, Tif,
};
use kiyotaka_client::binance_ws::spawn_binance_liq;
use kiyotaka_client::ws::LiveEvent;
use live_executor::{RiskCfg, RiskGuard};
use parking_lot::Mutex;
use serde::Serialize;
use swarm::{
    agent::Event as SwarmEvent,
    consensus::{consensus, ConsensusCfg, ConsensusDecision},
    population::Swarm,
    scoring::{AgentStats, Scoreboard},
    systematic::SystematicBuilder,
};
use tokio::sync::mpsc;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,live_executor=debug,swarm=debug")),
        )
        .init();
    dotenvy::from_filename(".env").ok();

    let mode = match std::env::var("PYTHIA_MODE").as_deref() {
        Ok("live") => Mode::Live,
        _ => Mode::DryRun,
    };
    let risk_floor = std::env::var("PYTHIA_RISK")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.005);
    let snapshot_path: PathBuf = std::env::var("PYTHIA_SNAPSHOT")
        .unwrap_or_else(|_| "data/swarm-snapshot.json".into())
        .into();
    if let Some(parent) = snapshot_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    // HL signer — dummy in dry-run, mandatory in live.
    let hl_key = match (std::env::var("HL_PRIVATE_KEY"), mode) {
        (Ok(k), _) => k,
        (Err(_), Mode::Live) => return Err("HL_PRIVATE_KEY required in live mode".into()),
        (Err(_), Mode::DryRun) => {
            warn!("HL_PRIVATE_KEY unset — using throwaway key for dry-run");
            "0x0000000000000000000000000000000000000000000000000000000000000001".into()
        }
    };
    let signer = PrivateKeySigner::from_hex(&hl_key)?;
    let address = std::env::var("HL_ADDRESS").unwrap_or_else(|_| signer.address().to_string());
    let hl_base = std::env::var("HL_BASE_URL")
        .unwrap_or_else(|_| exchange_hyperliquid::MAINNET_API.into());
    let client = Arc::new(HyperliquidClient::new(signer, hl_base)?);

    // Prime equity + risk guard.
    let initial_equity = client
        .user_state(&address)
        .await
        .map(|us| us.margin_summary.account_value_f64())
        .unwrap_or(0.0);
    let guard = Arc::new(RiskGuard::new(RiskCfg::default(), initial_equity.max(1.0)));

    // Build swarm — 20 diverse systematic agents from the house roster.
    // `Swarm` stays single-owner in the main task (avoids holding a
    // sync mutex across an await). The snapshot writer only needs the
    // fixed agent-id roster, which we take once up front.
    let agents = SystematicBuilder::new().house_roster().build();
    let n_agents = agents.len();
    let agent_ids: Vec<String> = agents.iter().map(|a| a.id().to_string()).collect();
    let mut swarm = Swarm::new(agents);
    let scoreboard = Arc::new(Scoreboard::new());
    let pending: Arc<Mutex<HashMap<String, PendingOutcome>>> = Arc::new(Mutex::new(HashMap::new()));
    let consensus_stats = Arc::new(Mutex::new(ConsensusStats::default()));
    let cons_cfg = ConsensusCfg::default();

    info!(
        ?mode, n_agents, initial_equity, %address,
        "pythia-swarm-live starting"
    );

    // Spawn Binance WS → unified event stream.
    let symbols = vec!["BTCUSDT".to_string(), "ETHUSDT".to_string()];
    let mut rx = spawn_binance_liq(symbols);

    // Internal channel between ingest and swarm handler — keeps the WS
    // receiver responsive even if the swarm briefly blocks on outbound
    // HL REST calls.
    let (swarm_tx, mut swarm_rx) = mpsc::channel::<SwarmEvent>(1024);

    // Ingest task.
    tokio::spawn(async move {
        let mut last_hour: i64 = 0;
        while let Some(ev) = rx.recv().await {
            if let Some(e) = into_swarm_event(ev) {
                // Emit HourClose whenever the hour rolls over — lets
                // agents finalise their local aggregators.
                let h = e.ts().0 / 3600;
                if last_hour != 0 && h > last_hour {
                    let _ = swarm_tx
                        .send(SwarmEvent::HourClose {
                            ts: EventTs::from_secs(h * 3600),
                        })
                        .await;
                }
                last_hour = h;
                let _ = swarm_tx.send(e).await;
            }
        }
    });

    // Periodic ticker that resolves expired pending decisions + writes
    // the snapshot JSON for the UI. Does not need the `Swarm` — only the
    // scoreboard (which has its own internal Mutex) + fixed agent-id list.
    {
        let client = client.clone();
        let scoreboard = scoreboard.clone();
        let pending = pending.clone();
        let consensus_stats = consensus_stats.clone();
        let agent_ids = agent_ids.clone();
        let snapshot_path = snapshot_path.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(10));
            ticker.tick().await;
            loop {
                ticker.tick().await;
                if let Ok(mids) = client.all_mids().await {
                    mark_expired(&pending, &scoreboard, &mids);
                }
                let stats_clone = consensus_stats.lock().clone();
                let snap = build_snapshot(&scoreboard, &stats_clone, &agent_ids, n_agents);
                write_snapshot(&snapshot_path, &snap);
            }
        });
    }

    // Main loop — drain the internal event channel, broadcast to the
    // swarm, run consensus, place orders.
    while let Some(event) = swarm_rx.recv().await {
        // Refresh champion so social agents + consensus see it.
        swarm.current_champion = scoreboard
            .champion(cons_cfg.min_decisions_for_champion)
            .map(|c| c.agent_id);

        let decisions = swarm.broadcast(&event).await;

        // Opportunistically fetch mids to value entries. One REST per
        // event that produced decisions — skip when none did.
        let mids = if decisions.is_empty() {
            HashMap::new()
        } else {
            client.all_mids().await.unwrap_or_default()
        };

        // Record every decision in the scoreboard + pending map.
        for d in &decisions {
            scoreboard.record(d.clone());
            let entry_px = mid_for_asset(&mids, d.asset).unwrap_or(0.0);
            pending.lock().insert(
                d.id.clone(),
                PendingOutcome {
                    decision_id: d.id.clone(),
                    asset: d.asset,
                    direction: d.direction,
                    entry_price: entry_px,
                    exit_ts: d.ts.0 + d.horizon_s,
                    risk_fraction: d.risk_fraction,
                },
            );
        }

        // Consensus across all decisions on this event.
        if let Some(c) = consensus(&decisions, &scoreboard, &cons_cfg) {
            consensus_stats.lock().fires += 1;
            if let Err(e) = try_place_consensus_order(
                &client,
                &address,
                &guard,
                &c,
                &mids,
                mode,
                risk_floor,
            )
            .await
            {
                warn!(error=%e, "consensus order failed");
            }
        }
    }
    Ok(())
}

#[derive(Copy, Clone, Debug)]
enum Mode {
    DryRun,
    Live,
}

fn into_swarm_event(ev: LiveEvent) -> Option<SwarmEvent> {
    match ev {
        LiveEvent::Liquidation {
            ts,
            symbol,
            side,
            usd_value,
            ..
        } => {
            let asset = match symbol.as_str() {
                "BTCUSDT" => Asset::Btc,
                "ETHUSDT" => Asset::Eth,
                _ => return None,
            };
            Some(SwarmEvent::Liquidation {
                ts,
                asset,
                side: match side {
                    LiqSide::Buy => LiqSide::Buy,
                    LiqSide::Sell => LiqSide::Sell,
                },
                usd_value,
            })
        }
        LiveEvent::Funding { .. } | LiveEvent::Candle { .. } => None,
    }
}

fn mid_for_asset(mids: &HashMap<String, String>, asset: Asset) -> Option<f64> {
    let key = match asset {
        Asset::Btc => "BTC",
        Asset::Eth => "ETH",
    };
    mids.get(key).and_then(|s| s.parse().ok())
}

/// Walk `pending` and mark anything whose `exit_ts` has elapsed. Uses
/// the current HL mid as the exit price — an acceptable approximation
/// because the swarm is a discovery layer, not the live execution PnL.
/// The real execution PnL is tracked via HL's own position API.
fn mark_expired(
    pending: &Mutex<HashMap<String, PendingOutcome>>,
    scoreboard: &Scoreboard,
    mids: &HashMap<String, String>,
) {
    let now = chrono::Utc::now().timestamp();
    let expired: Vec<String> = {
        let g = pending.lock();
        g.iter()
            .filter(|(_, p)| p.exit_ts <= now)
            .map(|(k, _)| k.clone())
            .collect()
    };
    for id in expired {
        let Some(p) = pending.lock().remove(&id) else {
            continue;
        };
        let Some(exit_px) = mid_for_asset(mids, p.asset) else {
            continue;
        };
        if p.entry_price <= 0.0 || exit_px <= 0.0 {
            continue;
        }
        let dir_mult = match p.direction {
            Direction::Long => 1.0,
            Direction::Short => -1.0,
        };
        let ret = dir_mult * (exit_px - p.entry_price) / p.entry_price;
        // Normalise: 0.5 % move ≈ 1 R on a 1.5 × ATR stop at 1 %-daily vol.
        let r = ret / 0.005;
        let pnl = ret * 1_000.0 * (p.risk_fraction / 0.01);
        scoreboard.mark_outcome(&p.decision_id, r, pnl);
    }
}

struct PendingOutcome {
    decision_id: String,
    asset: Asset,
    direction: Direction,
    entry_price: f64,
    exit_ts: i64,
    risk_fraction: f64,
}

#[derive(Default, Clone, Serialize)]
struct ConsensusStats {
    fires: usize,
}

async fn try_place_consensus_order<S: Signer>(
    client: &HyperliquidClient<S>,
    address: &str,
    guard: &RiskGuard,
    c: &ConsensusDecision,
    mids: &HashMap<String, String>,
    mode: Mode,
    risk_floor: f64,
) -> Result<(), Box<dyn std::error::Error>> {
    // Per-asset symbol translation.
    let (symbol, asset_ix, hl_coin) = match c.asset {
        Asset::Btc => ("BTCUSDT", 0u32, "BTC"),
        Asset::Eth => ("ETHUSDT", 1u32, "ETH"),
    };

    match guard.permit_signal(symbol) {
        live_executor::risk::GuardDecision::Ok => {}
        other => {
            info!(symbol, decision=?other, "consensus rejected by risk guard");
            return Ok(());
        }
    }

    let Some(mid) = mids.get(hl_coin).and_then(|s| s.parse::<f64>().ok()) else {
        return Ok(());
    };

    let us = client.user_state(address).await?;
    let equity = us.margin_summary.account_value_f64();
    guard.update_equity(equity);
    if guard.is_disabled() {
        warn!("guard disabled; skipping consensus order");
        return Ok(());
    }

    // Use max(agent preferences, risk_floor). Consensus already averaged
    // across the contributing agents; clamp for safety.
    let risk_fraction = c.avg_risk_fraction.clamp(risk_floor, 0.02);
    let atr = (mid * 0.005).max(10.0);
    let stop_dist = 1.5 * atr;
    let risk_dollars = equity * risk_fraction;
    let notional = (risk_dollars * mid / stop_dist).min(equity * 3.0);
    let size = notional / mid;
    if size <= 0.0 {
        return Ok(());
    }

    let side = match c.direction {
        Direction::Long => OrderSide::Buy,
        Direction::Short => OrderSide::Sell,
    };
    let entry_est = match side {
        OrderSide::Buy => mid * 1.0005,
        OrderSide::Sell => mid * 0.9995,
    };
    let stop_price = match side {
        OrderSide::Buy => entry_est - stop_dist,
        OrderSide::Sell => entry_est + stop_dist,
    };
    let tp_price = match side {
        OrderSide::Buy => entry_est + 3.0 * atr,
        OrderSide::Sell => entry_est - 3.0 * atr,
    };

    info!(
        ?mode, symbol, side=?side, size, entry=entry_est, stop=stop_price, tp=tp_price,
        direction=?c.direction, champ_n=c.champion_count,
        champ_agree=format!("{:.2}", c.champion_agreement),
        overall=format!("{:.2}", c.overall_agreement),
        "CONSENSUS FIRE"
    );

    match mode {
        Mode::DryRun => {
            info!("DRY-RUN: no order sent");
        }
        Mode::Live => {
            let req = OrderRequest {
                asset: asset_ix,
                side,
                size,
                limit_px: entry_est,
                reduce_only: false,
                tif: Tif::Ioc,
                trigger: None,
            };
            match client.place_order(&req).await {
                Ok(r) => info!(resp=?r.status, "entry placed"),
                Err(e) => {
                    warn!(error=%e, "entry failed");
                    return Ok(());
                }
            }
            let sl_req = OrderRequest {
                asset: asset_ix,
                side: opposite(side),
                size,
                limit_px: stop_price,
                reduce_only: true,
                tif: Tif::Ioc,
                trigger: Some(exchange_hyperliquid::types::TriggerSpec {
                    px: stop_price,
                    is_market: true,
                    kind: "sl",
                }),
            };
            let _ = client.place_order(&sl_req).await;
            let tp_req = OrderRequest {
                asset: asset_ix,
                side: opposite(side),
                size,
                limit_px: tp_price,
                reduce_only: true,
                tif: Tif::Ioc,
                trigger: Some(exchange_hyperliquid::types::TriggerSpec {
                    px: tp_price,
                    is_market: true,
                    kind: "tp",
                }),
            };
            let _ = client.place_order(&tp_req).await;
        }
    }
    Ok(())
}

fn opposite(s: OrderSide) -> OrderSide {
    match s {
        OrderSide::Buy => OrderSide::Sell,
        OrderSide::Sell => OrderSide::Buy,
    }
}

// ---------- snapshot (consumed by the /tournament UI) ----------

#[derive(Serialize)]
struct Snapshot {
    generated_at: i64,
    n_agents: usize,
    champion: Option<AgentStats>,
    agents: Vec<AgentStats>,
    recent_decisions: Vec<RecentDecision>,
    consensus: ConsensusStats,
}

#[derive(Serialize)]
struct RecentDecision {
    id: String,
    agent_id: String,
    ts: i64,
    asset: String,
    direction: String,
    conviction: u8,
    rationale: String,
}

fn build_snapshot(
    scoreboard: &Scoreboard,
    consensus_stats: &ConsensusStats,
    agent_ids: &[String],
    n_agents: usize,
) -> Snapshot {
    let mut agents = scoreboard.all();
    agents.sort_by(|a, b| {
        b.total_r
            .partial_cmp(&a.total_r)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    // Pad with zero-stat placeholders for agents that haven't decided
    // yet, so the UI can still render all N slots.
    if agents.len() < n_agents {
        let known: std::collections::HashSet<String> =
            agents.iter().map(|s| s.agent_id.clone()).collect();
        for id in agent_ids {
            if !known.contains(id) {
                agents.push(AgentStats {
                    agent_id: id.clone(),
                    active: true,
                    ..Default::default()
                });
            }
        }
    }
    let champion = agents.first().cloned();
    Snapshot {
        generated_at: chrono::Utc::now().timestamp(),
        n_agents,
        champion,
        agents,
        recent_decisions: Vec::new(),
        consensus: consensus_stats.clone(),
    }
}

fn write_snapshot(path: &PathBuf, snap: &Snapshot) {
    let tmp = path.with_extension("json.tmp");
    if let Ok(bytes) = serde_json::to_vec_pretty(snap) {
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

