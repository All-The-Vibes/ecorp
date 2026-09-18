//! Non-secret identity of a Corp's authoritative claim ledger.
//! Authentication and existing claim locks remain the authority, not this ID.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FactoryAuthority {
    pub corp_id: Uuid,
    pub claim_authority_id: Uuid,
}

/// Missing is legacy unbound policy. Explicit null/invalid values are not omission.
pub fn factory_claim_authority_id(policy: &Value) -> Result<Option<Uuid>, String> {
    let policy = policy
        .as_object()
        .ok_or("factory policy must be a JSON object")?;
    match policy.get("claim_authority_id") {
        None => Ok(None),
        Some(Value::String(value)) => Uuid::parse_str(value)
            .ok()
            .filter(|id| !id.is_nil())
            .map(Some)
            .ok_or_else(|| "factory claim_authority_id must be a non-nil UUID".to_owned()),
        Some(_) => Err("factory claim_authority_id must be a non-nil UUID".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn issue161_policy_preserves_legacy_omission_and_exact_pin() {
        assert_eq!(factory_claim_authority_id(&json!({})), Ok(None));
        let id = Uuid::new_v4();
        assert_eq!(
            factory_claim_authority_id(&json!({"claim_authority_id": id})),
            Ok(Some(id))
        );
    }

    #[test]
    fn issue161_malformed_pin_fails_without_echoing_input() {
        for value in [
            Value::Null,
            json!(""),
            json!(Uuid::nil()),
            json!("private-input"),
            json!(1),
            json!({}),
            json!([]),
        ] {
            let error =
                factory_claim_authority_id(&json!({"claim_authority_id": value})).unwrap_err();
            assert!(!error.contains("private-input"));
        }
        assert!(factory_claim_authority_id(&Value::Null).is_err());
    }
}
