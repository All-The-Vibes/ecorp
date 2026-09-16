use crate::{Address, B256, Error, Result, fees::SpendingPolicy, schedule::Schedule};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Assurance {
    #[default]
    ProviderObservedFinalized,
    IndependentlyDerivedFinalized,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct BaseDestinationConfig {
    pub enabled: bool,
    pub chain_id: u64,
    pub manifest_digest: B256,
    pub contract_address: Address,
    pub stream_id: B256,
    pub publisher: Address,
    pub primary_rpc_secret: String,
    pub secondary_rpc_secret: String,
    pub primary_operator: String,
    pub secondary_operator: String,
    pub signer_gateway_identity: String,
    pub signer_key_identity: String,
    pub schedule: Schedule,
    pub require_github_archive: bool,
    pub alternate_archive_policy: Option<String>,
    pub assurance: Assurance,
    pub spending_policy: Option<SpendingPolicy>,
    pub customer_accepted_network_risk: bool,
    pub customer_accepted_public_metadata: bool,
}

impl Default for BaseDestinationConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            chain_id: 8453,
            manifest_digest: B256::ZERO,
            contract_address: Address::ZERO,
            stream_id: B256::ZERO,
            publisher: Address::ZERO,
            primary_rpc_secret: String::new(),
            secondary_rpc_secret: String::new(),
            primary_operator: String::new(),
            secondary_operator: String::new(),
            signer_gateway_identity: String::new(),
            signer_key_identity: String::new(),
            schedule: Schedule::default(),
            require_github_archive: true,
            alternate_archive_policy: None,
            assurance: Assurance::default(),
            spending_policy: None,
            customer_accepted_network_risk: false,
            customer_accepted_public_metadata: false,
        }
    }
}

pub(crate) fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-/:.".contains(&b))
        && !value.contains("://")
        && !value.contains("..")
        && !value.contains("placeholder")
}

impl BaseDestinationConfig {
    /// Syntactic enrollment checks only. Trust and live read-only startup checks are separately mandatory.
    pub fn validate(&self) -> Result<()> {
        if !matches!(self.chain_id, 8453 | 84532)
            || self.manifest_digest.is_zero()
            || self.contract_address.is_zero()
            || self.stream_id.is_zero()
            || self.publisher.is_zero()
        {
            return Err(Error::Config("destination not enrolled"));
        }
        for s in [
            &self.primary_rpc_secret,
            &self.secondary_rpc_secret,
            &self.primary_operator,
            &self.secondary_operator,
            &self.signer_gateway_identity,
            &self.signer_key_identity,
        ] {
            if !identifier(s) {
                return Err(Error::Config("invalid secret reference or identity"));
            }
        }
        if self
            .primary_operator
            .eq_ignore_ascii_case(&self.secondary_operator)
            || self.primary_rpc_secret == self.secondary_rpc_secret
        {
            return Err(Error::Config("independently operated RPCs required"));
        }
        if !self.require_github_archive
            && !self
                .alternate_archive_policy
                .as_deref()
                .is_some_and(identifier)
        {
            return Err(Error::Config("explicit durable alternate archive required"));
        }
        if !self.customer_accepted_network_risk || !self.customer_accepted_public_metadata {
            return Err(Error::Config(
                "customer network and metadata approval required",
            ));
        }
        self.schedule.validate()?;
        self.spending_policy
            .as_ref()
            .ok_or(Error::Config("spending policy required"))?
            .validate()
    }
}
