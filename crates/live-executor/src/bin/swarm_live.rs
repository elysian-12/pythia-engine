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
//!                                ├──▶ Scoreboard.champion() → agent_id
//!                                │
//!                                └──▶ if champion emitted a decision,
//!                                       the Executor places the trade
//!                                       on Hyperliquid REST.
//!
//!   tokio ticker (10 s) ──▶ mark expired pending decisions (using HL mids)
//!                           + write snapshot JSON for the UI
//! ```
//!
//! `consensus()` is still computed per event but only as a diagnostic
//! (exported to the snapshot for the UI) — the champion drives live
//! execution.
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
use serde::{Deserialize, Serialize};
use swarm::{
    agent::{Event as SwarmEvent, SwarmAgent},
    consensus::{consensus, ConsensusCfg},
    evolution::{Evolution, EvolutionCfg},
    llm_agent::{AnthropicDecider, LlmAgent, LlmDecider, MockLlmDecider, Personality},
    persistence::{PersistedAgent, PersistedPopulation},
    population::Swarm,
    scoring::{AgentStats, Scoreboard},
    systematic::{SystematicAgent, SystematicBuilder},
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
    let config_path: PathBuf = std::env::var("PYTHIA_CONFIG")
        .unwrap_or_else(|_| "data/swarm-config.json".into())
        .into();
    // Shared user-tuned config — reloaded every 15 s so edits from the
    // /tournament UI take effect without restarting the daemon.
    let user_config: Arc<Mutex<UserConfig>> = Arc::new(Mutex::new(
        UserConfig::load_or_default(&config_path),
    ));
    {
        let user_config = user_config.clone();
        let p = config_path.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(15));
            ticker.tick().await;
            loop {
                ticker.tick().await;
                *user_config.lock() = UserConfig::load_or_default(&p);
            }
        });
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

    // Build swarm — 20 systematic agents (each a quant persona with its
    // own rule-family parameters) PLUS 5 LLM-driven personas that reason
    // over the same event stream. Together they form the "trading floor":
    // every persona competes, scoreboard ranks, champion drives execution.
    //
    // LLM deciders use AnthropicDecider when ANTHROPIC_API_KEY is set,
    // otherwise MockLlmDecider (deterministic, hash-based) so the personas
    // still participate offline.
    // Resume from a persisted population if one exists. swarm-backtest
    // writes data/swarm-population.json after each run; live runs write
    // it periodically (every evolution cycle) so a restart picks up where
    // the prior live session left off. Override path with PYTHIA_POPULATION.
    let population_path = std::env::var("PYTHIA_POPULATION")
        .unwrap_or_else(|_| "data/swarm-population.json".into());
    let prior_population = PersistedPopulation::load(&population_path);
    let starting_generation = prior_population.as_ref().map(|p| p.generation).unwrap_or(0);

    let scoreboard = Arc::new(Scoreboard::new());
    let mut agents: Vec<Box<dyn SwarmAgent>> = if let Some(prior) = &prior_population {
        let mut out: Vec<Box<dyn SwarmAgent>> = Vec::with_capacity(prior.agents.len() + 5);
        for a in &prior.agents {
            if let Some(stats) = &a.stats {
                scoreboard.seed(a.id.clone(), stats.clone());
            }
            out.push(Box::new(SystematicAgent::new(a.id.clone(), a.params.clone())));
        }
        info!(
            generation = prior.generation,
            n_agents = prior.agents.len(),
            "loaded persisted population — resuming evolution"
        );
        out
    } else {
        SystematicBuilder::new().house_roster().build()
    };
    let llm_decider_factory: Box<dyn Fn() -> Box<dyn LlmDecider>> =
        match std::env::var("ANTHROPIC_API_KEY").ok() {
            Some(k) if !k.is_empty() => {
                info!("LLM personas using AnthropicDecider");
                let k = k.clone();
                Box::new(move || Box::new(AnthropicDecider::new(k.clone())) as Box<dyn LlmDecider>)
            }
            _ => {
                info!("LLM personas using MockLlmDecider (no ANTHROPIC_API_KEY)");
                Box::new(|| Box::<MockLlmDecider>::default() as Box<dyn LlmDecider>)
            }
        };
    for persona in Personality::roster() {
        agents.push(Box::new(LlmAgent::new(persona, llm_decider_factory())));
    }
    let n_agents = agents.len();
    let agent_ids: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(
        agents.iter().map(|a| a.id().to_string()).collect(),
    ));
    let mut swarm = Swarm::new(agents);
    let pending: Arc<Mutex<HashMap<String, PendingOutcome>>> = Arc::new(Mutex::new(HashMap::new()));
    let consensus_stats = Arc::new(Mutex::new(ConsensusStats::default()));
    let cons_cfg = ConsensusCfg::default();
    let mut evolution = Evolution::new(
        EvolutionCfg {
            population_cap: n_agents,
            ..Default::default()
        },
        chrono::Utc::now().timestamp() as u64,
    );
    evolution.set_generation(starting_generation);
    let evolution_interval: usize = std::env::var("PYTHIA_EVOLVE_EVERY")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(500); // ~every few hours at typical liq cadence
    let generation_arc: Arc<Mutex<u64>> = Arc::new(Mutex::new(starting_generation));

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
    // scoreboard (which has its own internal Mutex) + the current
    // agent-id list (refreshed by evolution in the main task).
    {
        let client = client.clone();
        let scoreboard = scoreboard.clone();
        let pending = pending.clone();
        let consensus_stats = consensus_stats.clone();
        let agent_ids = agent_ids.clone();
        let generation_arc = generation_arc.clone();
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
                let ids = agent_ids.lock().clone();
                let generation = *generation_arc.lock();
                let snap =
                    build_snapshot(&scoreboard, &stats_clone, &ids, n_agents, generation);
                write_snapshot(&snapshot_path, &snap);
            }
        });
    }

    // Main loop — drain the internal event channel, broadcast to the
    // swarm, place orders on the **champion's** decisions. Consensus is
    // still computed for diagnostic purposes (shown in the snapshot)
    // but does not drive execution. Every `evolution_interval` events,
    // the scoreboard feeds the Evolution engine and the weaker half
    // of the population is replaced by mutants / crossovers of the elite.
    let mut event_counter: usize = 0;
    while let Some(event) = swarm_rx.recv().await {
        event_counter += 1;

        // Evolution — self-improvement based on realised PnL in the
        // scoreboard. Extracts the current systematic agents' params,
        // hands them + the scoreboard to `Evolution::advance`, and
        // rebuilds the Swarm with the new generation.
        if event_counter.is_multiple_of(evolution_interval) {
            let current_params: Vec<_> = swarm
                .agents()
                .filter_map(|a| {
                    a.systematic_params().map(|p| (p, a.id().to_string()))
                })
                .collect();
            if !current_params.is_empty() {
                let next_agents = evolution.advance(current_params, &scoreboard);
                let new_ids: Vec<String> =
                    next_agents.iter().map(|a| a.id().to_string()).collect();
                *agent_ids.lock() = new_ids;
                *generation_arc.lock() = evolution.generation();
                // Persist the new generation immediately so a crash mid-run
                // doesn't lose this evolution step. Failure to write is
                // logged but non-fatal — the live loop must keep trading.
                let persisted = PersistedPopulation {
                    saved_at: chrono::Utc::now().timestamp(),
                    generation: evolution.generation(),
                    n_events: event_counter as u64,
                    agents: next_agents
                        .iter()
                        .filter_map(|a| {
                            a.systematic_params().map(|params| PersistedAgent {
                                id: a.id().to_string(),
                                params,
                                stats: scoreboard.stats(a.id()),
                            })
                        })
                        .collect(),
                };
                if let Err(e) = persisted.save(&population_path) {
                    warn!(?e, "failed to persist evolved population");
                }
                swarm = Swarm::new(next_agents);
                info!(
                    generation = evolution.generation(),
                    population_cap = n_agents,
                    "evolution: next generation spawned + persisted"
                );
            }
        }

        // Refresh champion so social agents + downstream routing see it.
        let champion_id = scoreboard
            .champion(cons_cfg.min_decisions_for_champion)
            .map(|c| c.agent_id);
        swarm.current_champion = champion_id.clone();

        let decisions = swarm.broadcast(&event).await;

        // Opportunistically fetch mids to value entries. One REST per
        // event that produced decisions — skip when none did.
        let mids = if decisions.is_empty() {
            HashMap::new()
        } else {
            client.all_mids().await.unwrap_or_default()
        };

        // Record every decision in the scoreboard + pending map so the
        // whole population stays ranked over time.
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

        // Consensus — diagnostic only.
        if consensus(&decisions, &scoreboard, &cons_cfg).is_some() {
            consensus_stats.lock().fires += 1;
        }

        // Execution — place an order iff the current champion emitted a
        // decision on this event. No champion yet (early in the run) →
        // no trade. Multiple decisions from champion (unlikely) → fire
        // on the first, others ignored for this tick.
        let Some(champ_id) = champion_id.as_deref() else {
            continue;
        };
        if let Some(d) = decisions.iter().find(|d| d.agent_id == champ_id) {
            // Uncertainty filter (PolySwarm §III.D):
            // skip when the top-K agents disagree with the champion
            // beyond a user-tuned threshold. Computed on *this event's*
            // decisions only — stateless and cheap.
            let cfg_now = user_config.lock().clone();
            let dissent = top_k_dissent(
                &decisions,
                &scoreboard,
                &cons_cfg,
                d.direction,
                d.asset,
            );
            if dissent > cfg_now.uncertainty_filter {
                info!(
                    dissent = format!("{:.2}", dissent),
                    threshold = format!("{:.2}", cfg_now.uncertainty_filter),
                    "uncertainty gate rejected champion trade"
                );
                continue;
            }
            if let Err(e) = try_place_champion_order(
                &client,
                &address,
                &guard,
                d,
                &mids,
                mode,
                &cfg_now,
                risk_floor,
            )
            .await
            {
                warn!(error=%e, "champion order failed");
            }
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct UserConfig {
    #[serde(default = "default_risk")]
    risk_fraction: f64,
    #[serde(default = "default_cap")]
    position_cap_mult: f64,
    #[serde(default)]
    kelly_enabled: bool,
    #[serde(default = "default_uncertainty")]
    uncertainty_filter: f64,
}

fn default_risk() -> f64 { 0.005 }
fn default_cap() -> f64 { 3.0 }
fn default_uncertainty() -> f64 { 0.4 }

impl Default for UserConfig {
    fn default() -> Self {
        Self {
            risk_fraction: default_risk(),
            position_cap_mult: default_cap(),
            kelly_enabled: false,
            uncertainty_filter: default_uncertainty(),
        }
    }
}

impl UserConfig {
    fn load_or_default(p: &PathBuf) -> Self {
        std::fs::read_to_string(p)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }
}

/// Fraction of the current top-K champions whose latest decision
/// disagrees with `dir` on `asset`. 0.0 = unanimous agreement;
/// 1.0 = unanimous disagreement. Newly spawned agents with fewer than
/// `min_decisions_for_champion` decisions are ignored.
fn top_k_dissent(
    decisions: &[swarm::agent::AgentDecision],
    scoreboard: &Scoreboard,
    cfg: &ConsensusCfg,
    dir: domain::signal::Direction,
    asset: Asset,
) -> f64 {
    let top = scoreboard.top_n(cfg.top_k, cfg.min_decisions_for_champion);
    if top.is_empty() {
        return 0.0;
    }
    let ids: std::collections::HashSet<String> =
        top.iter().map(|s| s.agent_id.clone()).collect();
    // Only count top-K agents that emitted a decision on this same
    // asset this tick — otherwise abstention != disagreement.
    let relevant: Vec<_> = decisions
        .iter()
        .filter(|d| ids.contains(&d.agent_id) && d.asset == asset)
        .collect();
    if relevant.is_empty() {
        return 0.0;
    }
    let dissenting = relevant.iter().filter(|d| d.direction != dir).count();
    dissenting as f64 / relevant.len() as f64
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
        // 1.5×ATR stop on a ~0.5% ATR market = 0.75% stop distance — that
        // is the denominator that makes R-multiples comparable across the
        // backtest and live paths. The previous 0.5% denominator inflated
        // R by 1.5× and the previous PnL formula assumed unleveraged 1×
        // sizing instead of the executor's risk_fraction × equity /
        // stop_pct ≈ 1.33× notional, understating wins and losses by ~25%.
        const STOP_PCT: f64 = 0.0075;
        let r = ret / STOP_PCT;
        let equity = 1_000.0_f64;
        let notional = (equity * p.risk_fraction / STOP_PCT).min(equity * 3.0);
        let pnl = ret * notional;
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

async fn try_place_champion_order<S: Signer>(
    client: &HyperliquidClient<S>,
    address: &str,
    guard: &RiskGuard,
    d: &swarm::agent::AgentDecision,
    mids: &HashMap<String, String>,
    mode: Mode,
    cfg: &UserConfig,
    risk_floor: f64,
) -> Result<(), Box<dyn std::error::Error>> {
    // Per-asset symbol translation.
    let (symbol, asset_ix, hl_coin) = match d.asset {
        Asset::Btc => ("BTCUSDT", 0u32, "BTC"),
        Asset::Eth => ("ETHUSDT", 1u32, "ETH"),
    };

    match guard.permit_signal(symbol) {
        live_executor::risk::GuardDecision::Ok => {}
        other => {
            info!(symbol, decision=?other, "champion order rejected by risk guard");
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
        warn!("guard disabled; skipping champion order");
        return Ok(());
    }

    // Sizing — two modes:
    //   ATR-risk (default): risk_fraction of equity hits the stop.
    //   Quarter-Kelly (PolySwarm §III.E): f = 0.25 × (pb − q) / b
    //     p = agent's calibrated win prob ≈ conviction / 100
    //     b = reward:risk ratio = TP_mult / SL_mult = 3.0 / 1.5 = 2.0
    //     q = 1 − p
    //   Both honour `position_cap_mult` and `risk_floor`.
    let atr = (mid * 0.005).max(10.0);
    let stop_dist = 1.5 * atr;
    let notional_cap = equity * cfg.position_cap_mult.max(1.0);

    let notional = if cfg.kelly_enabled {
        let p = (f64::from(d.conviction) / 100.0).clamp(0.05, 0.95);
        let b = 3.0 / 1.5; // TP_mult / SL_mult
        let kelly_f = ((p * b) - (1.0 - p)) / b;
        let qk = (0.25 * kelly_f).max(0.0);
        (equity * qk).min(notional_cap)
    } else {
        let risk_fraction = cfg
            .risk_fraction
            .max(risk_floor)
            .min(0.02)
            .max(d.risk_fraction.clamp(risk_floor, 0.02));
        let risk_dollars = equity * risk_fraction;
        (risk_dollars * mid / stop_dist).min(notional_cap)
    };
    let size = notional / mid;
    if size <= 0.0 {
        return Ok(());
    }

    let side = match d.direction {
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
        direction=?d.direction, agent=%d.agent_id,
        conviction=d.conviction,
        "CHAMPION FIRE"
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
    generation: u64,
    n_agents: usize,
    champion: Option<AgentStats>,
    agents: Vec<AgentStats>,
    recent_decisions: Vec<RecentDecision>,
    consensus: ConsensusStats,
    source: &'static str,
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
    generation: u64,
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
        generation,
        n_agents,
        champion,
        agents,
        recent_decisions: Vec::new(),
        consensus: consensus_stats.clone(),
        source: "live",
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

