use crate::{Error, Result, U256};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SpendingPolicy {
    pub max_gas: u64,
    #[serde(with = "crate::wei_u128")]
    pub max_fee_per_gas: u128,
    #[serde(with = "crate::wei_u128")]
    pub max_priority_fee_per_gas: u128,
    pub max_attempt_fee: U256,
    pub monthly_budget: U256,
    pub safety_margin_bps: u32,
    pub max_replacements: u32,
    pub quote_max_age_seconds: u32,
    pub max_deferral_seconds: u64,
    pub low_balance_threshold: U256,
}

impl SpendingPolicy {
    pub fn validate(&self) -> Result<()> {
        if self.max_gas < 21_000
            || self.max_fee_per_gas == 0
            || self.max_priority_fee_per_gas > self.max_fee_per_gas
            || self.max_attempt_fee.is_zero()
            || self.monthly_budget.is_zero()
            || self.safety_margin_bps < 1000
            || self.safety_margin_bps > 100_000
            || self.quote_max_age_seconds == 0
            || self.quote_max_age_seconds > 300
            || self.max_deferral_seconds == 0
            || self.max_replacements > 32
        {
            return Err(Error::Config("incomplete or invalid spending policy"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FeeQuote {
    pub gas_limit: u64,
    #[serde(with = "crate::wei_u128")]
    pub max_fee_per_gas: u128,
    #[serde(with = "crate::wei_u128")]
    pub max_priority_fee_per_gas: u128,
    pub l1_data_fee: U256,
    pub observed_at: DateTime<Utc>,
    pub fee_model_qualified: bool,
}

#[derive(Debug, Clone)]
pub struct AdmissionContext {
    pub now: DateTime<Utc>,
    pub balance: U256,
    pub settled_this_month: U256,
    /// Every unresolved lane, including reservations carried across month boundaries.
    pub other_unresolved: U256,
    pub same_nonce_exposure: U256,
    pub replacement_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeeAdmission {
    pub attempt_exposure: U256,
    pub reservation: U256,
    pub low_balance: bool,
}

fn add(a: U256, b: U256) -> Result<U256> {
    a.checked_add(b).ok_or(Error::Admission("wei overflow"))
}
pub fn exposure(policy: &SpendingPolicy, quote: &FeeQuote) -> Result<U256> {
    policy.validate()?;
    let execution = U256::from(quote.gas_limit)
        .checked_mul(U256::from(quote.max_fee_per_gas))
        .ok_or(Error::Admission("wei overflow"))?;
    let l1 = quote
        .l1_data_fee
        .checked_mul(U256::from(10_000 + policy.safety_margin_bps))
        .ok_or(Error::Admission("wei overflow"))?;
    let l1 = add(l1, U256::from(9999))? / U256::from(10_000);
    add(execution, l1)
}

/// An admission budget, NOT an absolute cap on Base's uncapped L1 component.
pub fn admit(
    policy: &SpendingPolicy,
    quote: &FeeQuote,
    ctx: &AdmissionContext,
) -> Result<FeeAdmission> {
    policy.validate()?;
    if !quote.fee_model_qualified {
        return Err(Error::Admission("fee model unqualified"));
    }
    let age = ctx.now.signed_duration_since(quote.observed_at);
    if age < chrono::Duration::zero()
        || age > chrono::Duration::seconds(policy.quote_max_age_seconds.into())
    {
        return Err(Error::Admission("stale fee quote"));
    }
    if quote.gas_limit < 21_000
        || quote.gas_limit > policy.max_gas
        || quote.max_fee_per_gas == 0
        || quote.max_fee_per_gas > policy.max_fee_per_gas
        || quote.max_priority_fee_per_gas > policy.max_priority_fee_per_gas
        || quote.max_priority_fee_per_gas > quote.max_fee_per_gas
        || ctx.replacement_count > policy.max_replacements
    {
        return Err(Error::Admission("transaction limits exceeded"));
    }
    let attempt_exposure = exposure(policy, quote)?;
    if attempt_exposure > policy.max_attempt_fee {
        return Err(Error::Admission("attempt estimate exceeds policy"));
    }
    let reservation = attempt_exposure.max(ctx.same_nonce_exposure);
    let liabilities = add(ctx.other_unresolved, reservation)?;
    if add(ctx.settled_this_month, liabilities)? > policy.monthly_budget {
        return Err(Error::Admission("monthly admission budget exceeded"));
    }
    if liabilities > ctx.balance {
        return Err(Error::Admission("awaiting funds"));
    }
    Ok(FeeAdmission {
        attempt_exposure,
        reservation,
        low_balance: ctx.balance - liabilities < policy.low_balance_threshold,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SettledFee {
    pub execution_wei: U256,
    pub l1_fee_wei: Option<U256>,
    pub total_wei: Option<U256>,
}

impl SettledFee {
    pub fn from_receipt(
        gas_used: u64,
        effective_gas_price: u128,
        l1_fee: Option<U256>,
    ) -> Result<Self> {
        let execution_wei = U256::from(gas_used)
            .checked_mul(U256::from(effective_gas_price))
            .ok_or(Error::Admission("wei overflow"))?;
        Ok(Self {
            execution_wei,
            l1_fee_wei: l1_fee,
            total_wei: l1_fee.map(|l1| add(execution_wei, l1)).transpose()?,
        })
    }
}
