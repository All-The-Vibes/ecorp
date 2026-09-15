//! Optional Base destination. No deployment, funding, or implicit signing authority.
pub mod abi;
pub mod ancestry;
pub mod config;
pub mod fees;
#[cfg(feature = "gateway-service")]
pub mod gateway;
#[cfg(feature = "aws-kms")]
pub mod kms;
pub mod manifest;
pub mod rpc;
mod rpc_json;
pub mod schedule;
pub mod signing;
pub use alloy::primitives::{Address, B256, Bytes, U256};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("invalid Base configuration: {0}")]
    Config(&'static str),
    #[error("untrusted manifest: {0}")]
    Trust(&'static str),
    #[error("fee admission refused: {0}")]
    Admission(&'static str),
    #[error("RPC unavailable or invalid: {0}")]
    Rpc(&'static str),
    #[error("chain evidence invalid: {0}")]
    Evidence(&'static str),
    #[error("signing refused: {0}")]
    Signing(&'static str),
}
pub type Result<T> = std::result::Result<T, Error>;

mod wei_u128 {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};
    pub fn serialize<S: Serializer>(value: &u128, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u128, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.is_empty()
            || value.len() > 39
            || !value.bytes().all(|b| b.is_ascii_digit())
            || (value.len() > 1 && value.starts_with('0'))
        {
            return Err(D::Error::custom(
                "wei must be a canonical unsigned decimal string",
            ));
        }
        value.parse().map_err(D::Error::custom)
    }
}
