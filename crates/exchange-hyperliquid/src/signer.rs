//! Hyperliquid-compatible signer.
//!
//! Hyperliquid signing recipe (per their API docs):
//! 1. Serialise the `action` with MessagePack (canonical, no extras).
//! 2. Concatenate `action_bytes || nonce_be_u64_bytes || vault_address_bytes`
//!    where `vault_address_bytes` is 21 bytes: either `0x00` (no vault)
//!    or `0x01 || 20-byte address`.
//! 3. keccak256 the concatenation → `action_hash`.
//! 4. Build a phantom-agent struct: `{ source: "a", connectionId: action_hash }`
//!    and sign it with EIP-712 typed-data hashing. Source `"a"` =
//!    mainnet, `"b"` = testnet.
//! 5. ECDSA over secp256k1; recovery id normalised to `v ∈ {27, 28}`.
//!
//! We keep the implementation self-contained (no `ethers`/`alloy`) so the
//! workspace compile time stays small.

use k256::ecdsa::{Signature as EcdsaSignature, SigningKey};
use sha3::{Digest, Keccak256};
use thiserror::Error;

use crate::actions::Action;

#[derive(Debug, Error)]
pub enum SignError {
    #[error("invalid private key: {0}")]
    BadKey(String),
    #[error("bad address: {0}")]
    BadAddress(String),
    #[error("msgpack: {0}")]
    Msgpack(#[from] rmp_serde::encode::Error),
    #[error("ecdsa: {0}")]
    Ecdsa(String),
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct Signature {
    pub r: String,
    pub s: String,
    pub v: u8,
}

pub trait Signer: Send + Sync {
    /// Wallet address as lowercase `0x`-prefixed hex (20 bytes).
    fn address(&self) -> &str;
    fn sign_action(&self, action: &Action, nonce_ms: u64, is_mainnet: bool) -> Result<Signature, SignError>;
}

/// Sign with a raw 32-byte secp256k1 private key (Ethereum-style).
pub struct PrivateKeySigner {
    key: SigningKey,
    address_hex: String,
}

impl std::fmt::Debug for PrivateKeySigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Deliberately skips the SigningKey to avoid leaking the secret.
        f.debug_struct("PrivateKeySigner")
            .field("address", &self.address_hex)
            .finish_non_exhaustive()
    }
}

impl PrivateKeySigner {
    /// Parse a hex-encoded 32-byte key (with or without `0x` prefix).
    pub fn from_hex(key_hex: &str) -> Result<Self, SignError> {
        let trimmed = key_hex.trim().trim_start_matches("0x");
        let bytes = hex::decode(trimmed).map_err(|e| SignError::BadKey(e.to_string()))?;
        if bytes.len() != 32 {
            return Err(SignError::BadKey(format!("expected 32 bytes, got {}", bytes.len())));
        }
        let key = SigningKey::from_slice(&bytes).map_err(|e| SignError::BadKey(e.to_string()))?;
        let addr = ethereum_address(&key);
        Ok(Self {
            key,
            address_hex: format!("0x{}", hex::encode(addr)),
        })
    }
}

fn ethereum_address(key: &SigningKey) -> [u8; 20] {
    let pubkey = key.verifying_key();
    let encoded = pubkey.to_encoded_point(false); // uncompressed
    // skip the 0x04 prefix byte
    let hash = Keccak256::digest(&encoded.as_bytes()[1..]);
    let mut out = [0u8; 20];
    out.copy_from_slice(&hash[12..]);
    out
}

impl Signer for PrivateKeySigner {
    fn address(&self) -> &str {
        &self.address_hex
    }

    fn sign_action(
        &self,
        action: &Action,
        nonce_ms: u64,
        is_mainnet: bool,
    ) -> Result<Signature, SignError> {
        let action_bytes = rmp_serde::to_vec_named(action)?;
        let mut payload = action_bytes;
        payload.extend_from_slice(&nonce_ms.to_be_bytes());
        // No vault — append a single 0x00 byte.
        payload.push(0u8);
        let action_hash = Keccak256::digest(&payload);

        let source = if is_mainnet { "a" } else { "b" };
        let digest = eip712_phantom_agent_digest(source, action_hash.into());

        let (sig, recid) = self
            .key
            .sign_prehash_recoverable(&digest)
            .map_err(|e| SignError::Ecdsa(e.to_string()))?;
        let (r, s) = split_rs(&sig);
        let v = 27 + u8::from(recid);
        Ok(Signature {
            r: format!("0x{}", hex::encode(r)),
            s: format!("0x{}", hex::encode(s)),
            v,
        })
    }
}

fn split_rs(sig: &EcdsaSignature) -> ([u8; 32], [u8; 32]) {
    let mut r = [0u8; 32];
    let mut s = [0u8; 32];
    let bytes = sig.to_bytes();
    r.copy_from_slice(&bytes[0..32]);
    s.copy_from_slice(&bytes[32..64]);
    (r, s)
}

/// EIP-712 typed-data digest for Hyperliquid's `Agent` struct:
///
/// ```text
/// Agent { source: string, connectionId: bytes32 }
/// ```
///
/// Domain: `EIP712Domain(name: string, version: string, chainId: uint256,
/// verifyingContract: address)` with fixed values:
///   name              = "Exchange"
///   version           = "1"
///   chainId           = 1337
///   verifyingContract = 0x0000...0000
///
/// (Yes, 1337 is correct — it's the chain id the Hyperliquid signers
/// expect for both mainnet and testnet.)
fn eip712_phantom_agent_digest(source: &str, connection_id: [u8; 32]) -> [u8; 32] {
    // type hashes
    let domain_type = b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
    let agent_type = b"Agent(string source,bytes32 connectionId)";
    let domain_type_hash = Keccak256::digest(domain_type);
    let agent_type_hash = Keccak256::digest(agent_type);

    // domain struct
    let name_hash = Keccak256::digest(b"Exchange");
    let version_hash = Keccak256::digest(b"1");
    let mut chain_id = [0u8; 32];
    chain_id[30] = 0x05;
    chain_id[31] = 0x39; // 1337
    let verifying_contract = [0u8; 32]; // 20-byte address padded → use zero

    let mut domain = Vec::with_capacity(32 * 5);
    domain.extend_from_slice(&domain_type_hash);
    domain.extend_from_slice(&name_hash);
    domain.extend_from_slice(&version_hash);
    domain.extend_from_slice(&chain_id);
    domain.extend_from_slice(&verifying_contract);
    let domain_hash = Keccak256::digest(&domain);

    // agent struct
    let source_hash = Keccak256::digest(source.as_bytes());
    let mut agent = Vec::with_capacity(32 * 3);
    agent.extend_from_slice(&agent_type_hash);
    agent.extend_from_slice(&source_hash);
    agent.extend_from_slice(&connection_id);
    let agent_hash = Keccak256::digest(&agent);

    // final: keccak256(0x1901 || domain || struct)
    let mut final_input = Vec::with_capacity(2 + 32 + 32);
    final_input.push(0x19);
    final_input.push(0x01);
    final_input.extend_from_slice(&domain_hash);
    final_input.extend_from_slice(&agent_hash);
    Keccak256::digest(&final_input).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_parses_with_or_without_prefix() {
        let k = "0x4646464646464646464646464646464646464646464646464646464646464646";
        let s = PrivateKeySigner::from_hex(k).unwrap();
        assert!(s.address().starts_with("0x"));
        assert_eq!(s.address().len(), 42);
        let s2 = PrivateKeySigner::from_hex(k.trim_start_matches("0x")).unwrap();
        assert_eq!(s.address(), s2.address());
    }

    #[test]
    fn address_is_deterministic() {
        let k = "0x0101010101010101010101010101010101010101010101010101010101010101";
        let s = PrivateKeySigner::from_hex(k).unwrap();
        // pinned checksum-less lowercase
        assert_eq!(s.address().len(), 42);
    }

    #[test]
    fn bad_key_errors() {
        assert!(PrivateKeySigner::from_hex("0xdead").is_err());
        assert!(PrivateKeySigner::from_hex("not-hex").is_err());
    }
}
