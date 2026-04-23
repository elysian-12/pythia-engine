//! Hyperliquid REST client + EIP-712 signing.
//!
//! Minimal surface for a live trading bot:
//!   - [`HyperliquidClient::user_state`]   — account equity + open positions
//!   - [`HyperliquidClient::place_order`]  — market or limit with stops
//!   - [`HyperliquidClient::cancel_order`]
//!   - [`HyperliquidClient::mid_price`]    — for entry slippage calculation
//!
//! Signing follows Hyperliquid's msgpack-encoded "action hash" plus a
//! phantom-agent domain separator, then ECDSA over keccak256. See
//! <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api>.
//! The implementation is deliberately dependency-light: no `ethers` or
//! `alloy` — just `k256`, `sha3`, and `rmp_serde`.

#![deny(unused_must_use)]

pub mod actions;
pub mod client;
pub mod signer;
pub mod types;

pub use client::HyperliquidClient;
pub use signer::{PrivateKeySigner, Signer};
pub use types::{OrderRequest, OrderResponse, OrderSide, Tif, UserState};

pub const MAINNET_API: &str = "https://api.hyperliquid.xyz";
pub const TESTNET_API: &str = "https://api.hyperliquid-testnet.xyz";
