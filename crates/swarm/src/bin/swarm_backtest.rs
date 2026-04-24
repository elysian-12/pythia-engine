//! `swarm-backtest` — replays 365 days of real BTC + ETH liquidations,
//! funding, and hourly candles through a 20-agent swarm. Tracks each
//! agent's realised R, picks the champion, and shows how often the
//! consensus would have fired.
//!
//! Run: `cargo run --release -p swarm --bin swarm-backtest`

use std::{collections::HashMap, path::PathBuf, time::Instant};

use domain::{
    crypto::{Asset, Candle, FundingRate, LiqSide, Liquidation, OpenInterest},
    signal::Direction,
    time::EventTs,
};
use store::Store;
use swarm::{
    agent::Event,
    consensus::{consensus, ConsensusCfg},
    evolution::{Evolution, EvolutionCfg},
    llm_agent::{LlmAgent, MockLlmDecider, Personality},
    population::Swarm,
    scoring::Scoreboard,
    systematic::SystematicBuilder,
};
use tracing_subscriber::EnvFilter;

const STARTING_EQUITY: f64 = 1_000.0;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let db_path = std::env::var("PYTHIA_DB").unwrap_or_else(|_| "data/pythia.duckdb".into());
    let store = Store::open(&db_path)?;
    let wall = Instant::now();

    // Build the house roster: 20 systematic agents + 5 LLM personas.
    // In backtest mode LLM personas use MockLlmDecider so everything
    // is deterministic — the whole replay stays reproducible.
    let mut agents = SystematicBuilder::new().house_roster().build();
    for p in Personality::roster() {
        agents.push(Box::new(LlmAgent::new(
            p,
            Box::<MockLlmDecider>::default(),
        )));
    }
    let n_agents = agents.len();
    let mut swarm = Swarm::new(agents);
    let scoreboard = Scoreboard::new();
    // Evolution: same configuration the live executor uses, so the backtest
    // measures the evolved population's PnL — not just the static seed roster.
    // PYTHIA_EVOLVE_EVERY controls the cadence (default: 500 events).
    let evolution_interval: usize = std::env::var("PYTHIA_EVOLVE_EVERY")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(500);
    let mut evolution = Evolution::new(
        EvolutionCfg {
            // Only evolve the systematic half — LLM personas are fixed.
            population_cap: n_agents.saturating_sub(Personality::roster().len()).max(1),
            ..Default::default()
        },
        0xDEADBEEF, // deterministic seed so the backtest is reproducible
    );

    // Load data.
    tracing::info!("loading 365d dataset");
    let btc = load_asset(&store, Asset::Btc)?;
    let eth = load_asset(&store, Asset::Eth)?;

    // Merge all events chronologically.
    let events = interleave(btc, eth);
    tracing::info!(n_agents, n_events = events.len(), "starting replay");

    // For outcome marking we need forward BTC/ETH close prices.
    let close_lookup = build_close_lookup_from_store(&store)?;

    // Track pending decisions: decision_id -> (entry_price_est, asset, direction, horizon_s).
    let mut pending: HashMap<String, PendingOutcome> = HashMap::new();

    // Consensus stats while replaying.
    let mut consensus_count = 0usize;
    let mut consensus_wins = 0usize;
    let cons_cfg = ConsensusCfg::default();
    let mut event_counter: usize = 0;

    for event in &events {
        // Before broadcasting, close any pending decision whose horizon has expired.
        let ts_now = event.ts().0;
        close_expired(&mut pending, ts_now, &close_lookup, &scoreboard);

        swarm.current_champion = scoreboard
            .champion(cons_cfg.min_decisions_for_champion)
            .map(|c| c.agent_id);

        event_counter += 1;
        // Every N events: replace weak systematic agents with elite-seeded
        // mutants / crossovers, exactly like the live path. LLM personas are
        // re-attached verbatim so the final population remains 20 systematic
        // + 5 LLM.
        if event_counter.is_multiple_of(evolution_interval) {
            let current_params: Vec<_> = swarm
                .agents()
                .filter_map(|a| a.systematic_params().map(|p| (p, a.id().to_string())))
                .collect();
            if !current_params.is_empty() {
                let mut next_agents = evolution.advance(current_params, &scoreboard);
                for p in Personality::roster() {
                    next_agents.push(Box::new(LlmAgent::new(
                        p,
                        Box::<MockLlmDecider>::default(),
                    )));
                }
                swarm = Swarm::new(next_agents);
                tracing::info!(
                    generation = evolution.generation(),
                    event = event_counter,
                    "evolution: next generation spawned"
                );
            }
        }

        let decisions = swarm.broadcast(event).await;
        for d in &decisions {
            scoreboard.record(d.clone());
            let entry = close_at_or_before(&close_lookup, d.asset, ts_now).unwrap_or(0.0);
            pending.insert(
                d.id.clone(),
                PendingOutcome {
                    decision_id: d.id.clone(),
                    agent_id: d.agent_id.clone(),
                    entry_ts: ts_now,
                    entry_price: entry,
                    exit_ts: ts_now + d.horizon_s,
                    asset: d.asset,
                    direction: d.direction,
                    risk_fraction: d.risk_fraction,
                },
            );
        }

        // Compute consensus decision at this event (stateless, no execution).
        if let Some(c) = consensus(&decisions, &scoreboard, &cons_cfg) {
            consensus_count += 1;
            // Score the consensus decision against a 4-hour forward
            // close — independent of the individual agents' outcomes.
            let exit_ts = ts_now + 4 * 3600;
            let exit_px = close_at_or_before(&close_lookup, c.asset, exit_ts).unwrap_or(0.0);
            let entry_px = close_at_or_before(&close_lookup, c.asset, ts_now).unwrap_or(0.0);
            if entry_px > 0.0 && exit_px > 0.0 {
                let directional = match c.direction {
                    Direction::Long => exit_px - entry_px,
                    Direction::Short => entry_px - exit_px,
                };
                if directional > 0.0 {
                    consensus_wins += 1;
                }
            }
        }
    }
    // Close any still-pending at the end of data.
    close_expired(&mut pending, i64::MAX, &close_lookup, &scoreboard);

    // Rank + print. Pad with zero-stat rows for agents that never fired
    // (e.g. LLM personas in a fully deterministic mock run) so the UI
    // renders the full population, not just the scorers.
    let mut ranked = scoreboard.all();
    {
        let seen: std::collections::HashSet<String> =
            ranked.iter().map(|s| s.agent_id.clone()).collect();
        for a in swarm.agents() {
            if !seen.contains(a.id()) {
                ranked.push(swarm::AgentStats {
                    agent_id: a.id().into(),
                    active: true,
                    ..Default::default()
                });
            }
        }
    }
    ranked.sort_by(|a, b| {
        b.total_r
            .partial_cmp(&a.total_r)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    println!(
        "\n=== swarm-backtest · {} agents · {} events · wall {:.1} s ===\n",
        n_agents,
        events.len(),
        wall.elapsed().as_secs_f64()
    );
    println!(
        "{:<26} {:>8} {:>8} {:>8} {:>10} {:>8}",
        "agent", "trades", "wins", "wrate%", "total_r", "pnl$"
    );
    for s in &ranked {
        println!(
            "{:<26} {:>8} {:>8} {:>7.1}% {:>+10.2} {:>+8.0}",
            s.agent_id,
            s.wins + s.losses,
            s.wins,
            s.win_rate * 100.0,
            s.total_r,
            s.total_pnl_usd
        );
    }

    let champion = ranked.first();
    if let Some(c) = champion {
        println!(
            "\nCHAMPION: {} · total_r={:+.2} · win_rate={:.1}% · pnl=${:+.0}",
            c.agent_id,
            c.total_r,
            c.win_rate * 100.0,
            c.total_pnl_usd
        );
    }
    println!(
        "\nConsensus fires: {} · directional wins: {} ({:.1}%)",
        consensus_count,
        consensus_wins,
        if consensus_count > 0 {
            100.0 * consensus_wins as f64 / consensus_count as f64
        } else {
            0.0
        }
    );

    // Persist the full result.
    let ts = chrono::Utc::now().timestamp();
    let dir = PathBuf::from(format!("reports/swarm/{ts}"));
    std::fs::create_dir_all(&dir).ok();
    let md = render_markdown(&ranked, consensus_count, consensus_wins, wall.elapsed().as_secs_f64(), n_agents);
    std::fs::write(dir.join("swarm.md"), &md)?;
    std::fs::write(dir.join("swarm.json"), serde_json::to_string_pretty(&ranked)?)?;
    println!("\nreport: {}/swarm.md", dir.display());

    // Regime classification on the final candle window — surfaced in
    // the UI so users know which strategy family should be favoured.
    let regime_info = regime::classify(
        &store.candles_asc(Asset::Btc, 200).unwrap_or_default(),
        &regime::RegimeCfg::default(),
    );

    // Also write data/swarm-snapshot.json so the /tournament UI shows
    // the backtest run directly (same schema the live daemon uses).
    let snapshot = serde_json::json!({
        "generated_at": ts,
        "generation": evolution.generation(),
        "n_agents": n_agents,
        "champion": ranked.first(),
        "agents": ranked,
        "recent_decisions": [],
        "consensus": { "fires": consensus_count, "wins": consensus_wins },
        "regime": regime_info.map(|r| serde_json::json!({
            "label": r.regime.as_str(),
            "directional": r.directional,
            "vol_ratio": r.vol_ratio,
        })),
        "source": "backtest"
    });
    let data_dir = PathBuf::from("data");
    std::fs::create_dir_all(&data_dir).ok();
    std::fs::write(
        data_dir.join("swarm-snapshot.json"),
        serde_json::to_vec_pretty(&snapshot)?,
    )?;
    println!("snapshot: data/swarm-snapshot.json → /tournament will render this run");
    Ok(())
}

struct PendingOutcome {
    decision_id: String,
    agent_id: String,
    entry_ts: i64,
    entry_price: f64,
    exit_ts: i64,
    asset: Asset,
    direction: Direction,
    risk_fraction: f64,
}

fn close_expired(
    pending: &mut HashMap<String, PendingOutcome>,
    now: i64,
    lookup: &CloseLookup,
    scoreboard: &Scoreboard,
) {
    let expired: Vec<String> = pending
        .iter()
        .filter(|(_, p)| p.exit_ts <= now)
        .map(|(k, _)| k.clone())
        .collect();
    for id in expired {
        let Some(p) = pending.remove(&id) else {
            continue;
        };
        let exit_px = close_at_or_before(lookup, p.asset, p.exit_ts).unwrap_or(0.0);
        if p.entry_price <= 0.0 || exit_px <= 0.0 {
            continue;
        }
        let dir_mult = if matches!(p.direction, Direction::Long) { 1.0 } else { -1.0 };
        let ret = dir_mult * (exit_px - p.entry_price) / p.entry_price;
        // 0.5 % move ≈ 1 R on a 1.5 × ATR stop in a 1 % daily-vol market.
        let r = ret / 0.005;
        let pnl = ret * STARTING_EQUITY * (p.risk_fraction / 0.01);
        scoreboard.mark_outcome(&p.decision_id, r, pnl);
        let _ = p.agent_id;
        let _ = p.entry_ts;
    }
}

type CloseLookup = HashMap<(Asset, i64), f64>;

fn build_close_lookup_from_store(store: &Store) -> Result<CloseLookup, Box<dyn std::error::Error>> {
    let mut out = HashMap::new();
    for asset in [Asset::Btc, Asset::Eth] {
        let candles = store.candles_asc(asset, 9000)?;
        for c in candles {
            out.insert((asset, c.ts.0), c.close);
        }
    }
    Ok(out)
}

fn close_at_or_before(lookup: &CloseLookup, asset: Asset, ts: i64) -> Option<f64> {
    // Snap `ts` to the 1 h bucket floor and walk backwards up to 48 h.
    let mut t = (ts / 3600) * 3600;
    for _ in 0..48 {
        if let Some(v) = lookup.get(&(asset, t)) {
            return Some(*v);
        }
        t -= 3600;
    }
    None
}

fn interleave(btc: AssetHistory, eth: AssetHistory) -> Vec<Event> {
    let mut out = Vec::new();
    for l in &btc.liquidations {
        out.push(Event::Liquidation {
            ts: l.ts,
            asset: Asset::Btc,
            side: l.side,
            usd_value: l.volume_usd,
        });
    }
    for l in &eth.liquidations {
        out.push(Event::Liquidation {
            ts: l.ts,
            asset: Asset::Eth,
            side: l.side,
            usd_value: l.volume_usd,
        });
    }
    for c in &btc.candles {
        out.push(Event::Candle {
            ts: c.ts,
            asset: Asset::Btc,
            candle: c.clone(),
        });
    }
    for c in &eth.candles {
        out.push(Event::Candle {
            ts: c.ts,
            asset: Asset::Eth,
            candle: c.clone(),
        });
    }
    for f in &btc.funding {
        out.push(Event::Funding {
            ts: f.ts,
            asset: Asset::Btc,
            funding: f.clone(),
        });
    }
    for f in &eth.funding {
        out.push(Event::Funding {
            ts: f.ts,
            asset: Asset::Eth,
            funding: f.clone(),
        });
    }
    out.sort_by_key(|e| e.ts().0);
    out
}

struct AssetHistory {
    candles: Vec<Candle>,
    funding: Vec<FundingRate>,
    #[allow(dead_code)]
    oi: Vec<OpenInterest>,
    liquidations: Vec<Liquidation>,
}

fn load_asset(store: &Store, asset: Asset) -> Result<AssetHistory, Box<dyn std::error::Error>> {
    let conn = store.connection();
    let symbol = asset.symbol();
    let candles = conn
        .prepare(
            "SELECT event_ts, open, high, low, close, volume FROM candles \
             WHERE asset = ? ORDER BY event_ts ASC",
        )?
        .query_map([symbol], |r| {
            Ok(Candle {
                ts: EventTs::from_secs(r.get::<_, i64>(0)?),
                open: r.get(1)?,
                high: r.get(2)?,
                low: r.get(3)?,
                close: r.get(4)?,
                volume: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let funding = conn
        .prepare(
            "SELECT event_ts, rate_open, rate_close, predicted_close FROM funding \
             WHERE asset = ? ORDER BY event_ts ASC",
        )?
        .query_map([symbol], |r| {
            Ok(FundingRate {
                ts: EventTs::from_secs(r.get::<_, i64>(0)?),
                rate_open: r.get(1)?,
                rate_close: r.get(2)?,
                predicted_close: r.get::<_, Option<f64>>(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let oi: Vec<OpenInterest> = vec![];
    let liquidations = conn
        .prepare(
            "SELECT event_ts, side, volume_usd FROM liquidations \
             WHERE asset = ? ORDER BY event_ts ASC",
        )?
        .query_map([symbol], |r| {
            let side_str: String = r.get(1)?;
            let side = if side_str == "BUY" { LiqSide::Buy } else { LiqSide::Sell };
            Ok(Liquidation {
                ts: EventTs::from_secs(r.get::<_, i64>(0)?),
                side,
                volume_usd: r.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(AssetHistory {
        candles,
        funding,
        oi,
        liquidations,
    })
}

fn render_markdown(
    ranked: &[swarm::AgentStats],
    consensus_count: usize,
    consensus_wins: usize,
    wall_s: f64,
    n_agents: usize,
) -> String {
    use std::fmt::Write as _;
    let mut s = String::new();
    let _ = writeln!(s, "# Swarm backtest — {} agents, 365 d BTC+ETH\n", n_agents);
    let _ = writeln!(s, "Wall-clock: {wall_s:.1} s\n");
    let _ = writeln!(s, "## Ranking\n");
    let _ = writeln!(s, "| # | Agent | Trades | Wins | Win % | Σ R | PnL$ |");
    let _ = writeln!(s, "|---|---|---|---|---|---|---|");
    for (i, a) in ranked.iter().enumerate() {
        let _ = writeln!(
            s,
            "| {} | `{}` | {} | {} | {:.1} | {:+.2} | {:+.0} |",
            i + 1,
            a.agent_id,
            a.wins + a.losses,
            a.wins,
            a.win_rate * 100.0,
            a.total_r,
            a.total_pnl_usd
        );
    }
    let _ = writeln!(
        s,
        "\n## Consensus\n- fires: {consensus_count}\n- directional wins: {consensus_wins} ({:.1} %)",
        if consensus_count > 0 {
            100.0 * consensus_wins as f64 / consensus_count as f64
        } else {
            0.0
        }
    );
    s
}
