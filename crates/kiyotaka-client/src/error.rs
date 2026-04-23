use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("build http client: {0}")]
    Build(reqwest::Error),
    #[error("network: {0}")]
    Network(reqwest::Error),
    #[error("decode: {0}")]
    Decode(serde_json::Error),
    #[error("http {status}: {body}")]
    Http { status: u16, body: String },
    #[error("rate limited: {0}")]
    RateLimited(String),
    #[error("auth/forbidden: {0}")]
    Auth(String),
    #[error("missing field: {0}")]
    Missing(String),
}
