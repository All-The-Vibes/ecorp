use super::*;
use crony_domain::{FactoryAuthority, factory_claim_authority_id};

impl PgStore {
    /// Inspection must never provision or rotate an identity.
    pub async fn factory_authority(
        &self,
        corp_id: Uuid,
        actor_id: Uuid,
    ) -> Result<FactoryAuthority> {
        let id = sqlx::query_scalar::<_, Uuid>(
            "SELECT c.claim_authority_id FROM corps c JOIN actors a ON a.corp_id = c.id
             WHERE c.id = $1 AND a.id = $2 AND a.kind = 'human'",
        )
        .bind(corp_id)
        .bind(actor_id)
        .fetch_optional(&self.pool)
        .await?
        .context("forbidden: claim authority is not visible to this actor")?;
        Ok(FactoryAuthority {
            corp_id,
            claim_authority_id: id,
        })
    }
}

pub(super) async fn validate_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp_id: Uuid,
    policy: &Value,
) -> Result<()> {
    let Some(expected) = factory_claim_authority_id(policy).map_err(anyhow::Error::msg)? else {
        return Ok(()); // Historical policy remains byte-for-byte unbound.
    };
    let actual =
        sqlx::query_scalar::<_, Uuid>("SELECT claim_authority_id FROM corps WHERE id = $1")
            .bind(corp_id)
            .fetch_optional(&mut **tx)
            .await?
            .context("forbidden: claim authority Corp is unavailable")?;
    if expected != actual {
        return Err(anyhow!(
            "conflict: factory claim authority mismatch; use the approved shared control plane and Corp"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue161_policy_normalization_canonicalizes_pin_without_inventing_legacy_authority() {
        let original = json!({ "source_base_ref": "main", "source_base_commit": "a".repeat(40) });
        let legacy = normalize_factory_policy(original.clone()).unwrap();
        assert!(legacy.get("claim_authority_id").is_none());
        let id = Uuid::new_v4();
        let mut bound = original.clone();
        bound["claim_authority_id"] = json!(id.to_string().to_uppercase());
        let normalized = normalize_factory_policy(bound).unwrap();
        assert_eq!(normalized["claim_authority_id"], json!(id));
        assert_eq!(
            normalize_factory_policy(normalized.clone()).unwrap(),
            normalized
        );
        for bad in [
            Value::Null,
            json!(Uuid::nil()),
            json!(false),
            json!("invalid"),
        ] {
            let mut candidate = original.clone();
            candidate["claim_authority_id"] = bad;
            assert!(normalize_factory_policy(candidate).is_err());
        }
    }
}
