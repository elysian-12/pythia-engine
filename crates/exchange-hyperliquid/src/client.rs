//! Hyperliquid REST client.
//!
//! Two endpoints:
//!   POST /info       — public queries (user state, meta, mid prices)
//!   POST /exchange   — signed actions (orders, cancels)

use reqwest::Client;
use serde_json::json;
use std::time::Duration;
use thiserror::Error;
use tracing::{debug, warn};

use crate::actions::{Action, OrderAction};
use crate::signer::{Signature, SignError, Signer};
use crate::types::{OrderRequest, OrderResponse, UserState};

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("build http client: {0}")]
    Build(reqwest::Error),
    #[error("network: {0}")]
    Network(reqwest::Error),
    #[error("decode: {0}")]
    Decode(serde_json::Error),
    #[error("http {status}: {body}")]
    Http { status: u16, body: String },
    #[error("sign: {0}")]
    Sign(#[from] SignError),
    #[error("api: {0}")]
    Api(String),
}

#[derive(Debug)]
pub struct HyperliquidClient<S: Signer> {
    http: Client,
    base_url: String,
    signer: S,
    is_mainnet: bool,
}

impl<S: Signer> HyperliquidClient<S> {
    pub fn new(signer: S, base_url: impl Into<String>) -> Result<Self, ClientError> {
        let base = base_url.into();
        let is_mainnet = base.contains("hyperliquid.xyz") && !base.contains("testnet");
        let http = Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("pythia-live/0.1")
            .build()
            .map_err(ClientError::Build)?;
        Ok(Self {
            http,
            base_url: base,
            signer,
            is_mainnet,
        })
    }

    /// Query account state by wallet address.
    pub async fn user_state(&self, address: &str) -> Result<UserState, ClientError> {
        let body = json!({ "type": "clearinghouseState", "user": address });
        self.post_info(&body).await
    }

    /// All-mids snapshot as coin → price.
    pub async fn all_mids(&self) -> Result<std::collections::HashMap<String, String>, ClientError> {
        let body = json!({ "type": "allMids" });
        self.post_info(&body).await
    }

    async fn post_info<T: serde::de::DeserializeOwned>(&self, body: &serde_json::Value) -> Result<T, ClientError> {
        let url = format!("{}/info", self.base_url);
        let resp = self
            .http
            .post(&url)
            .json(body)
            .send()
            .await
            .map_err(ClientError::Network)?;
        let status = resp.status();
        let text = resp.text().await.map_err(ClientError::Network)?;
        if !status.is_success() {
            return Err(ClientError::Http { status: status.as_u16(), body: text });
        }
        serde_json::from_str(&text).map_err(ClientError::Decode)
    }

    /// Place a single order. Returns the exchange response on success.
    pub async fn place_order(&self, req: &OrderRequest) -> Result<OrderResponse, ClientError> {
        let action = Action::Order(OrderAction::single(req));
        let nonce_ms = current_nonce_ms();
        let signature = self.signer.sign_action(&action, nonce_ms, self.is_mainnet)?;
        self.post_exchange(&action, nonce_ms, &signature).await
    }

    async fn post_exchange(
        &self,
        action: &Action,
        nonce_ms: u64,
        signature: &Signature,
    ) -> Result<OrderResponse, ClientError> {
        let url = format!("{}/exchange", self.base_url);
        let body = json!({
            "action": action,
            "nonce": nonce_ms,
            "signature": signature,
            "vaultAddress": null,
        });
        debug!(?body, "hl post /exchange");
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(ClientError::Network)?;
        let status = resp.status();
        let text = resp.text().await.map_err(ClientError::Network)?;
        if !status.is_success() {
            warn!(%status, body=%text, "hl exchange err");
            return Err(ClientError::Http { status: status.as_u16(), body: text });
        }
        let parsed: OrderResponse = serde_json::from_str(&text).map_err(ClientError::Decode)?;
        if parsed.status != "ok" {
            return Err(ClientError::Api(text));
        }
        Ok(parsed)
    }
}

fn current_nonce_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
