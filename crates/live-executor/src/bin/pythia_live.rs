//! `pythia-live` — live trader binary.
//!
//! Env (loaded from .env):
//!   KIYOTAKA_API_KEY         — required
//!   HL_PRIVATE_KEY           — required for `--mode live`. Ed25519 hex.
//!   HL_ADDRESS               — optional; derived from key if absent.
//!   PYTHIA_MODE              — "dryrun" (default) | "live"
//!   PYTHIA_Z                 — z-threshold, default 2.5
//!   PYTHIA_RISK              — risk fraction, default 0.01
//!   PYTHIA_KIYOTAKA_WS_URL   — default Singapore endpoint
//!
//! Always starts in DryRun unless explicitly `PYTHIA_MODE=live`. Reads
//! + writes `data/pythia-live.json` for crash-safe restarts.

use std::sync::Arc;

use exchange_hyperliquid::{HyperliquidClient, PrivateKeySigner, Signer};
use kiyotaka_client::ws::WS_SIN;
use live_executor::{run_executor, ExecutorCfg, LiveMode, RiskCfg, RiskGuard, StatePath};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,live_executor=debug")),
        )
        .init();
    dotenvy::from_filename(".env").ok();

    let api_key = std::env::var("KIYOTAKA_API_KEY")
        .map_err(|_| "KIYOTAKA_API_KEY required")?;
    let ws_url = std::env::var("PYTHIA_KIYOTAKA_WS_URL").unwrap_or_else(|_| WS_SIN.into());
    let mode = match std::env::var("PYTHIA_MODE").as_deref() {
        Ok("live") => LiveMode::Live,
        _ => LiveMode::DryRun,
    };
    let z_threshold = std::env::var("PYTHIA_Z")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2.5);
    let risk_fraction = std::env::var("PYTHIA_RISK")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.01);

    // HL signer — required for live mode. For dry-run we still need an
    // address to query user_state, but we accept a dummy key if none
    // is set.
    let hl_key = std::env::var("HL_PRIVATE_KEY")
        .unwrap_or_else(|_| {
            tracing::warn!("HL_PRIVATE_KEY unset — using a throwaway key for dry-run");
            "0x0000000000000000000000000000000000000000000000000000000000000001".into()
        });
    let signer = PrivateKeySigner::from_hex(&hl_key)?;
    let address = std::env::var("HL_ADDRESS").unwrap_or_else(|_| signer.address().to_string());

    let hl_base = std::env::var("HL_BASE_URL")
        .unwrap_or_else(|_| exchange_hyperliquid::MAINNET_API.into());
    let client = Arc::new(HyperliquidClient::new(signer, hl_base)?);

    // Prime the guard with whatever equity HL reports up front.
    let initial_equity = client
        .user_state(&address)
        .await
        .map(|us| us.margin_summary.account_value_f64())
        .unwrap_or(0.0);
    let guard = Arc::new(RiskGuard::new(RiskCfg::default(), initial_equity.max(1.0)));

    let cfg = ExecutorCfg {
        z_threshold,
        risk_fraction,
        mode,
        ..ExecutorCfg::default()
    };
    tracing::info!(
        ?mode,
        z_threshold,
        risk_fraction,
        initial_equity,
        %address,
        "pythia-live starting"
    );
    run_executor(
        api_key,
        ws_url,
        client,
        address,
        cfg,
        guard,
        StatePath::default_path(),
    )
    .await?;
    Ok(())
}
