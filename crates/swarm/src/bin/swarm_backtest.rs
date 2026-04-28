//! `swarm-backtest` — replays 365 days of real BTC + ETH liquidations,
//! funding, and hourly candles through a 20-agent swarm. Tracks each
//! agent's realised R, picks the champion, and shows how often the
//! consensus would have fired.
//!
//! Run: `cargo run --release -p swarm --bin swarm-backtest`

use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Instant};

use domain::{
    crypto::{Asset, Candle, FundingRate, LiqSide, Liquidation, OpenInterest},
    ids::ConditionId,
    signal::Signal,
    time::EventTs,
};
use evaluation::{
    block_bootstrap_sharpe, deflated_sharpe_ratio, probabilistic_sharpe_ratio,
    probability_of_backtest_overfitting,
};
use paper_trader::{atr, simulate, Sizing, TraderConfig};
use store::Store;
use swarm::{
    agent::{AgentDecision, Event, SwarmAgent},
    consensus::{consensus, ConsensusCfg},
    evolution::{Evolution, EvolutionCfg},
    llm_agent::{LlmAgent, MockLlmDecider, Personality},
    persistence::{PersistedAgent, PersistedPopulation},
    population::Swarm,
    scoring::Scoreboard,
    systematic::{SystematicAgent, SystematicBuilder},
};
use tracing_subscriber::EnvFilter;

const STARTING_EQUITY: f64 = 1_000.0;
const ATR_WINDOW: usize = 14;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let db_path = std::env::var("PYTHIA_DB").unwrap_or_else(|_| "data/pythia.duckdb".into());
    let store = Store::open(&db_path)?;
    let wall = Instant::now();

    // Population persistence — if a prior run wrote data/swarm-population.json
    // we boot from that evolved roster and pre-load its lifetime stats into
    // the scoreboard, so this run's evolution starts from where the last
    // one left off. Without this, every restart would discard genetic
    // search progress. Override path with PYTHIA_POPULATION env var.
    let population_path = std::env::var("PYTHIA_POPULATION")
        .unwrap_or_else(|_| "data/swarm-population.json".into());
    let prior_population = PersistedPopulation::load(&population_path);
    let starting_generation = prior_population.as_ref().map(|p| p.generation).unwrap_or(0);

    // Build the house roster: 20 systematic agents + 5 LLM personas. If a
    // persisted population exists, replace the systematic half with its
    // surviving agents (LLM personas are always re-attached; their state
    // lives in the LLM, not in serialised params).
    let scoreboard = Arc::new(Scoreboard::new());
    let mut agents: Vec<Box<dyn SwarmAgent>> = if let Some(prior) = &prior_population {
        let mut out: Vec<Box<dyn SwarmAgent>> = Vec::with_capacity(prior.agents.len() + 5);
        for a in &prior.agents {
            // Pre-populate the scoreboard so champion / evolution have
            // signal from event 1.
            if let Some(stats) = &a.stats {
                scoreboard.seed(a.id.clone(), stats.clone());
            }
            if !a.r_history.is_empty() {
                scoreboard.seed_r_history(a.id.clone(), a.r_history.clone());
            }
            out.push(Box::new(SystematicAgent::new(a.id.clone(), a.params.clone())));
        }
        tracing::info!(
            generation = prior.generation,
            n_agents = prior.agents.len(),
            "loaded persisted population — continuing prior evolution"
        );
        out
    } else {
        SystematicBuilder::new().house_roster().build()
    };
    for p in Personality::roster() {
        agents.push(Box::new(LlmAgent::new(
            p,
            Box::<MockLlmDecider>::default(),
        )));
    }
    let n_agents = agents.len();
    // Hand the swarm a clone of the live scoreboard so it can populate
    // each agent's `self_recent_expectancy` per `observe()` — driving the
    // self-backtest gate inside SystematicAgent.
    let mut swarm = Swarm::new(agents).with_scoreboard(Arc::clone(&scoreboard));
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
    // Resume the generation counter from the prior run so logs + the
    // snapshot's `generation` field reflect cumulative evolution, not
    // just this single replay's deltas.
    evolution.set_generation(starting_generation);

    // Load data.
    tracing::info!("loading 365d dataset");
    let btc = load_asset(&store, Asset::Btc)?;
    let eth = load_asset(&store, Asset::Eth)?;

    // Build per-asset candle + funding lookups for the simulator before we
    // consume the histories into the event stream.
    let market_data = MarketData::from_histories(&btc, &eth);

    // Pre-compute a (ts → regime) timeline from BTC's hourly candles so the
    // swarm driver can fast-lookup the regime at each event ts. Recompute
    // every `REGIME_STEP` candles — re-running the classifier on every
    // event would dominate the wall time.
    let regime_cfg = regime::RegimeCfg::default();
    let regime_timeline = build_regime_timeline(
        market_data.candles.get(&Asset::Btc).cloned().unwrap_or_default().as_slice(),
        &regime_cfg,
    );

    // Synthesize a Polymarket SWP/mid series per asset so the polyedge
    // family has data to gate on. Real Polymarket ingestion is a
    // separate pipeline (kiyotaka-client → store → here) that hasn't
    // shipped yet; the synthetic version is causal — `swp` is derived
    // from past hourly returns only, and `mid` lags `swp` by 4 hours
    // plus small noise, so the pair is cointegrated by construction
    // and `swp` Granger-leads `mid`. Polyedge then proves the wiring
    // end-to-end against real cointegration / Granger / Hasbrouck
    // tests rather than a mocked branch.
    let btc_pm = synthesize_polymarket_series(
        market_data.candles.get(&Asset::Btc).cloned().unwrap_or_default().as_slice(),
        0xC0FFEE,
    );
    let eth_pm = synthesize_polymarket_series(
        market_data.candles.get(&Asset::Eth).cloned().unwrap_or_default().as_slice(),
        0xBADF00D,
    );

    // Merge all events chronologically (incl. polymarket samples).
    let events = interleave(btc, eth, &btc_pm, &eth_pm);
    tracing::info!(
        n_agents,
        n_events = events.len(),
        n_regimes = regime_timeline.len(),
        n_pm_btc = btc_pm.len(),
        n_pm_eth = eth_pm.len(),
        "starting replay (with synthetic polymarket lead series)"
    );
    let trader = TraderConfig {
        sizing: Sizing::AtrRisk {
            risk_fraction: 0.01,
            max_notional_mult: 3.0,
        },
        equity_usd: STARTING_EQUITY,
        ..TraderConfig::default()
    };

    // Track pending decisions: decision_id -> PendingOutcome.
    let mut pending: HashMap<String, PendingOutcome> = HashMap::new();

    // Consensus stats while replaying.
    let mut consensus_count = 0usize;
    let mut consensus_wins = 0usize;
    let cons_cfg = ConsensusCfg::default();
    let mut event_counter: usize = 0;

    for event in &events {
        // Before broadcasting, close any pending decision whose horizon has expired.
        let ts_now = event.ts().0;
        close_expired(&mut pending, ts_now, &market_data, &trader, &scoreboard);

        swarm.current_champion = scoreboard
            .champion(cons_cfg.min_decisions_for_champion)
            .map(|c| c.agent_id);
        // Update the regime PeerView attribute — agents read this to skip
        // hostile-regime trades and to scale `risk_fraction` by fitness.
        swarm.current_regime = regime_at(&regime_timeline, ts_now);

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
                swarm = Swarm::new(next_agents).with_scoreboard(Arc::clone(&scoreboard));
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
            pending.insert(
                d.id.clone(),
                PendingOutcome {
                    decision: d.clone(),
                    fire_ts: ts_now,
                    exit_ts: ts_now + d.horizon_s,
                },
            );
        }

        // Compute consensus decision at this event (stateless, no execution).
        if let Some(c) = consensus(&decisions, &scoreboard, &cons_cfg) {
            consensus_count += 1;
            // Score the consensus decision through the same simulator as
            // individual decisions so consensus-vs-individual comparisons
            // share the fee/funding/slippage assumptions.
            let synthetic = AgentDecision {
                id: format!("consensus-{}-{}", ts_now, consensus_count),
                agent_id: "consensus".into(),
                ts: EventTs::from_secs(ts_now),
                asset: c.asset,
                direction: c.direction,
                conviction: 70,
                risk_fraction: 0.01,
                horizon_s: 4 * 3600,
                rationale: "consensus".into(),
            };
            if let Some(trade) =
                run_simulator(&synthetic, ts_now, &market_data, &trader)
            {
                if trade.pnl_usd.unwrap_or(0.0) > 0.0 {
                    consensus_wins += 1;
                }
            }
        }
    }
    // Close any still-pending at the end of data.
    close_expired(&mut pending, i64::MAX, &market_data, &trader, &scoreboard);

    // Build a leaderboard for the *currently active* population only —
    // evolved generations accumulate retired agent IDs in the scoreboard,
    // so without filtering the snapshot would balloon to hundreds of
    // historical agents and the UI would render a stale roster.
    let live_ids: std::collections::HashSet<String> =
        swarm.agents().map(|a| a.id().to_string()).collect();
    let mut ranked: Vec<swarm::AgentStats> = scoreboard
        .all()
        .into_iter()
        .filter(|s| live_ids.contains(&s.agent_id))
        .collect();
    {
        let seen: std::collections::HashSet<String> =
            ranked.iter().map(|s| s.agent_id.clone()).collect();
        // Pad zero-stat rows for currently-live agents that never fired
        // (e.g. LLM personas with the mock decider in deterministic runs).
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
    // Rank by per-trade Sharpe (variance-aware quality), then Σ R as
    // tiebreak. Mirrors Scoreboard::top_n so the printed CHAMPION and
    // the snapshot's `champion` field match the live executor's pick
    // — Σ R alone rewards lifespan over per-trade quality.
    ranked.sort_by(|a, b| {
        b.rolling_sharpe
            .partial_cmp(&a.rolling_sharpe)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.total_r
                    .partial_cmp(&a.total_r)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
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

    // Apply the same min_decisions filter the executor uses — under
    // Sharpe ranking, an agent with <30 trades can have near-infinite
    // Sharpe via a zero-variance fluke. The full `ranked` is still
    // shown above as a leaderboard, but the printed CHAMPION (and
    // snapshot's `champion` field below) must respect the
    // statistical floor that the live binary's `Scoreboard::champion`
    // applies.
    let champion = ranked
        .iter()
        .find(|s| s.wins + s.losses >= cons_cfg.min_decisions_for_champion);
    // Statistical certification of the champion's edge.
    //
    // Three orthogonal tests from `evaluation`:
    //
    //  - **PSR** (Bailey & López de Prado 2012): probability the *true*
    //    Sharpe is positive given sample size, skew, and kurtosis. >0.95
    //    is the conventional "this is real" threshold.
    //  - **DSR** (Bailey & López de Prado 2014): PSR after deflating for
    //    multiple-testing bias — necessary because we picked the best of
    //    N agents. >0.95 means the champion's edge survives even after
    //    correcting for cherry-picking from the population.
    //  - **Block-bootstrap CI** on Sharpe at 95% confidence with block
    //    size = 7 trades — standard nonparametric range, autocorrelation
    //    aware. CI strictly above 0 = robust to resampling.
    let mut champion_psr = 0.0;
    let mut champion_dsr = 0.0;
    let mut champion_sharpe_ci_lo = f64::NAN;
    let mut champion_sharpe_ci_hi = f64::NAN;
    let mut champion_skew = 0.0;
    let mut champion_kurtosis = 0.0;
    // PBO (Probabilistic Backtest Overfitting, Bailey & López de Prado
    // 2014) — the rate at which the *winning* configuration on the
    // in-sample half ranks below median on the held-out half. <0.5 =
    // edge generalises better than chance; closer to 0 is better. We
    // build the trial matrix from each agent's R-history split into
    // `pbo_splits` chunks; each agent contributes one column of length
    // `splits × chunk_size`. Without this, the swarm's "look at how
    // many configs we tried" exposure went unmeasured — adding it
    // closes the multi-testing-correction loop alongside DSR.
    let mut champion_pbo: Option<f64> = None;
    let pbo_splits: usize = 8;
    if let Some(c) = champion {
        let r_series = scoreboard.r_history(&c.agent_id);
        let trial_sharpes: Vec<f64> = ranked
            .iter()
            .filter(|s| s.wins + s.losses >= 5)
            .map(|s| s.rolling_sharpe)
            .collect();
        if r_series.len() >= 10 {
            let psr = probabilistic_sharpe_ratio(&r_series, 0.0);
            let dsr = deflated_sharpe_ratio(&r_series, &trial_sharpes);
            let ci = block_bootstrap_sharpe(&r_series, 1_000, 1.0, 0.95, 7);
            champion_psr = psr.psr;
            champion_dsr = dsr.psr;
            champion_skew = psr.skew;
            champion_kurtosis = psr.kurtosis;
            champion_sharpe_ci_lo = ci.lo;
            champion_sharpe_ci_hi = ci.hi;
        }
        // Build the [chunk × trial] matrix the PBO test consumes. Each
        // column is one agent's R-history truncated + chunked into
        // `pbo_splits` equally-sized blocks; rows are time. Need ≥6
        // trials with enough closes to make the combinatorial split
        // meaningful — fewer than that and PBO degrades to noise.
        let chunk_target: usize = pbo_splits.max(2) * 4;
        let r_histories: Vec<Vec<f64>> = ranked
            .iter()
            .filter(|s| s.wins + s.losses >= chunk_target)
            .map(|s| scoreboard.r_history(&s.agent_id))
            .filter(|h| h.len() >= chunk_target)
            .collect();
        if r_histories.len() >= 6 {
            // Trim every agent's history to the same length (smallest
            // ≥ chunk_target * pbo_splits) so the matrix is rectangular.
            let max_per_split = r_histories
                .iter()
                .map(|h| h.len() / pbo_splits)
                .min()
                .unwrap_or(0);
            let rows = max_per_split * pbo_splits;
            if rows >= chunk_target {
                let mut matrix: Vec<Vec<f64>> = Vec::with_capacity(rows);
                for t in 0..rows {
                    let row: Vec<f64> = r_histories.iter().map(|h| h[t]).collect();
                    matrix.push(row);
                }
                let result = probability_of_backtest_overfitting(&matrix, pbo_splits);
                champion_pbo = Some(result.pbo);
            }
        }
        println!(
            "\nCHAMPION: {} · total_r={:+.2} · win_rate={:.1}% · pnl=${:+.0}",
            c.agent_id,
            c.total_r,
            c.win_rate * 100.0,
            c.total_pnl_usd
        );
        println!(
            "           Sharpe={:.3} (95% CI [{:.3}, {:.3}]) · PSR={:.3} · DSR={:.3} · skew={:.2} · kurt={:.2}",
            c.rolling_sharpe,
            champion_sharpe_ci_lo,
            champion_sharpe_ci_hi,
            champion_psr,
            champion_dsr,
            champion_skew,
            champion_kurtosis,
        );
        match champion_pbo {
            Some(pbo) => println!(
                "           PBO={:.3} (lower is better; <0.5 = edge generalises out-of-sample)",
                pbo
            ),
            None => println!("           PBO=insufficient sample for combinatorial split"),
        }
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
        "champion": champion,
        "agents": ranked,
        "recent_decisions": [],
        "consensus": { "fires": consensus_count, "wins": consensus_wins },
        "regime": regime_info.map(|r| serde_json::json!({
            "label": r.regime.as_str(),
            "directional": r.directional,
            "vol_ratio": r.vol_ratio,
        })),
        // Quant-grade certification of the champion's edge so the UI can
        // tell users whether the headline number is statistically real
        // (PSR/DSR > 0.95) or noise.
        "champion_certification": {
            "psr": champion_psr,
            "dsr": champion_dsr,
            "sharpe_ci_lo": if champion_sharpe_ci_lo.is_finite() { Some(champion_sharpe_ci_lo) } else { None },
            "sharpe_ci_hi": if champion_sharpe_ci_hi.is_finite() { Some(champion_sharpe_ci_hi) } else { None },
            "skew": champion_skew,
            "kurtosis": champion_kurtosis,
            "n_trials": ranked.iter().filter(|s| s.wins + s.losses >= 5).count(),
            // PBO (Bailey & López de Prado 2014). Lower is better;
            // <0.5 means the winning configuration generalises to
            // held-out splits more than half the time.
            "pbo": champion_pbo,
            "pbo_splits": pbo_splits,
        },
        "source": "backtest"
    });
    let data_dir = PathBuf::from("data");
    std::fs::create_dir_all(&data_dir).ok();
    std::fs::write(
        data_dir.join("swarm-snapshot.json"),
        serde_json::to_vec_pretty(&snapshot)?,
    )?;
    // Also drop the full enriched snapshot under the report dir so the
    // Vercel bundler can read it. `data/` is gitignored — bundle-snapshot.mjs
    // only sees the report dir on hosted builds, and reports/<ts>/swarm.json
    // is just the agents array (no generation, no regime, no cert). Without
    // this, every Vercel deploy produced a snapshot with generation=0
    // regardless of how many evolution cycles had run.
    std::fs::write(
        dir.join("snapshot.json"),
        serde_json::to_vec_pretty(&snapshot)?,
    )?;
    println!("snapshot: data/swarm-snapshot.json → /tournament will render this run");

    // Persist the live systematic population + their lifetime stats so
    // the next `swarm-backtest` (or `pythia-swarm-live`) run continues
    // evolving from here instead of reseeding `house_roster()`. LLM
    // personas are stateless and re-attached on boot — only systematic
    // params + scores need to round-trip.
    let persisted = PersistedPopulation {
        saved_at: ts,
        generation: evolution.generation(),
        n_events: events.len() as u64,
        agents: swarm
            .agents()
            .filter_map(|a| {
                a.systematic_params().map(|params| PersistedAgent {
                    id: a.id().to_string(),
                    params,
                    stats: scoreboard.stats(a.id()),
                    r_history: scoreboard.r_history(a.id()),
                })
            })
            .collect(),
    };
    let pop_path = data_dir.join("swarm-population.json");
    if let Err(e) = persisted.save(&pop_path) {
        tracing::warn!(?e, "failed to persist population — next run will reseed");
    } else {
        println!(
            "population: {} (gen {}, {} agents) → next run resumes evolution",
            pop_path.display(),
            persisted.generation,
            persisted.agents.len(),
        );
    }
    Ok(())
}

struct PendingOutcome {
    decision: AgentDecision,
    fire_ts: i64,
    exit_ts: i64,
}

/// Run a single decision through paper_trader::simulate using the asset's
/// chronological forward candles + funding. Returns None if there isn't
/// enough lookback to compute ATR or no forward data exists.
fn run_simulator(
    d: &AgentDecision,
    fire_ts: i64,
    market: &MarketData,
    trader: &TraderConfig,
) -> Option<domain::signal::Trade> {
    let candles = market.candles.get(&d.asset)?;
    let funding = market.funding.get(&d.asset)?;

    // ATR uses the candles strictly before the fire timestamp — no peek.
    let pre: Vec<Candle> = candles
        .iter()
        .filter(|c| c.ts.0 < fire_ts)
        .cloned()
        .collect();
    let entry_atr = atr(&pre, ATR_WINDOW)?;

    // Forward window: candles + funding from fire_ts through fire_ts+horizon.
    let horizon_end = fire_ts + d.horizon_s;
    let fwd_candles: Vec<Candle> = candles
        .iter()
        .filter(|c| c.ts.0 >= fire_ts && c.ts.0 <= horizon_end)
        .cloned()
        .collect();
    if fwd_candles.is_empty() {
        return None;
    }
    let fwd_funding: Vec<FundingRate> = funding
        .iter()
        .filter(|f| f.ts.0 >= fire_ts && f.ts.0 <= horizon_end)
        .cloned()
        .collect();

    // Build a Signal with the structural fields the simulator reads. The
    // PolyEdge-specific fields (swp/edge/granger_f/etc) are not used by
    // simulate(); we fill them with neutral values.
    let signal = Signal {
        id: d.id.clone(),
        ts: EventTs::from_secs(fire_ts),
        condition_id: ConditionId("swarm".into()),
        market_name: format!("{:?}-{}", d.asset, d.agent_id),
        asset: d.asset,
        direction: d.direction,
        swp: 0.5,
        mid: 0.5,
        edge: 0.0,
        is_pm: 0.0,
        granger_f: 0.0,
        gini: 0.0,
        conviction: d.conviction,
        horizon_s: d.horizon_s,
    };
    simulate(&signal, &fwd_candles, &fwd_funding, entry_atr, trader)
}

fn close_expired(
    pending: &mut HashMap<String, PendingOutcome>,
    now: i64,
    market: &MarketData,
    trader: &TraderConfig,
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
        let Some(trade) = run_simulator(&p.decision, p.fire_ts, market, trader) else {
            continue;
        };
        let r = trade.r_multiple.unwrap_or(0.0);
        let pnl = trade.pnl_usd.unwrap_or(0.0);
        scoreboard.mark_outcome(&p.decision.id, r, pnl);
    }
}

/// Pre-compute (ts, regime) checkpoints across the candle history so the
/// driver can resolve "what regime was the market in at time T" with a
/// binary search instead of re-running classify() on every event.
const REGIME_STEP: usize = 12; // re-classify every 12 hours
fn build_regime_timeline(
    candles: &[Candle],
    cfg: &regime::RegimeCfg,
) -> Vec<(i64, regime::RegimeSnapshot)> {
    let mut out = Vec::new();
    if candles.len() <= cfg.window {
        return out;
    }
    let start = cfg.window;
    let mut i = start;
    while i < candles.len() {
        if let Some(snap) = regime::classify(&candles[..=i], cfg) {
            out.push((candles[i].ts.0, snap));
        }
        i += REGIME_STEP;
    }
    out
}

fn regime_at(timeline: &[(i64, regime::RegimeSnapshot)], ts: i64) -> Option<regime::RegimeSnapshot> {
    if timeline.is_empty() {
        return None;
    }
    // Binary search for the latest checkpoint at or before ts.
    let idx = timeline.partition_point(|(t, _)| *t <= ts);
    if idx == 0 {
        return None;
    }
    Some(timeline[idx - 1].1)
}

/// Per-asset chronological candles + funding, indexed by Asset for cheap
/// forward-window slicing. Cloned out of the AssetHistory bundles loaded at
/// startup so the simulator can run on any decision without re-querying.
struct MarketData {
    candles: HashMap<Asset, Vec<Candle>>,
    funding: HashMap<Asset, Vec<FundingRate>>,
}

impl MarketData {
    fn from_histories(btc: &AssetHistory, eth: &AssetHistory) -> Self {
        let mut candles: HashMap<Asset, Vec<Candle>> = HashMap::new();
        let mut funding: HashMap<Asset, Vec<FundingRate>> = HashMap::new();
        for (asset, h) in [(Asset::Btc, btc), (Asset::Eth, eth)] {
            let mut cs = h.candles.clone();
            cs.sort_by_key(|c| c.ts.0);
            candles.insert(asset, cs);
            let mut fs = h.funding.clone();
            fs.sort_by_key(|f| f.ts.0);
            funding.insert(asset, fs);
        }
        Self { candles, funding }
    }
}

/// Build a causally-synthesized Polymarket SWP/mid hourly series from
/// the asset's candle history. SWP is a sigmoid of the past 24h
/// log-return (no peeking — the value at hour t depends only on
/// candles at t-25..=t-1), and mid is SWP lagged 4 hours plus small
/// Gaussian noise. Result: a pair where SWP Granger-leads mid by
/// construction and the residuals of mid ~ swp are stationary, so
/// the cointegration test passes. Polyedge agents then have a real
/// statistical signal to gate on. Replace this with the real ingestion
/// pipeline once kiyotaka-client + store land Polymarket SWP/mid feeds.
fn synthesize_polymarket_series(candles: &[Candle], seed: u64) -> Vec<(i64, f64, f64)> {
    if candles.len() < 30 {
        return Vec::new();
    }
    // Light-weight LCG so the noise is deterministic per seed.
    let mut state = seed | 1;
    let mut nrand = || -> f64 {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let u = ((state >> 33) as f64) / (u32::MAX as f64);
        (u - 0.5) * 2.0 // ~Uniform(-1, 1) — close enough for noise
    };

    // First pass: SWP from past 24h log-return only.
    let lookback = 24usize;
    let mut swp_series: Vec<(i64, f64)> = Vec::with_capacity(candles.len());
    for (i, c) in candles.iter().enumerate() {
        if i < lookback {
            continue;
        }
        let prev = candles[i - lookback].close;
        if prev <= 0.0 || c.close <= 0.0 {
            continue;
        }
        let ret = (c.close / prev).ln();
        // sigmoid scaled so a 5% return shifts SWP by ~0.2 from the
        // 0.5 baseline. Bounded in [0, 1].
        let z = ret / 0.05;
        let raw = 1.0 / (1.0 + (-z).exp());
        let jitter = 0.02 * nrand();
        let swp = (raw + jitter).clamp(0.01, 0.99);
        swp_series.push((c.ts.0, swp));
    }

    // Second pass: mid lags SWP by 4 hours + noise. Output triples.
    let lag = 4usize;
    let mut out = Vec::with_capacity(swp_series.len().saturating_sub(lag));
    for i in lag..swp_series.len() {
        let (ts, swp) = swp_series[i];
        let lagged_swp = swp_series[i - lag].1;
        let noise = 0.015 * nrand();
        let mid = (lagged_swp + noise).clamp(0.01, 0.99);
        out.push((ts, swp, mid));
    }
    out
}

fn interleave(
    btc: AssetHistory,
    eth: AssetHistory,
    btc_pm: &[(i64, f64, f64)],
    eth_pm: &[(i64, f64, f64)],
) -> Vec<Event> {
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
    for &(ts, swp, mid) in btc_pm {
        out.push(Event::Polymarket {
            ts: EventTs::from_secs(ts),
            asset: Asset::Btc,
            swp,
            mid,
        });
    }
    for &(ts, swp, mid) in eth_pm {
        out.push(Event::Polymarket {
            ts: EventTs::from_secs(ts),
            asset: Asset::Eth,
            swp,
            mid,
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
