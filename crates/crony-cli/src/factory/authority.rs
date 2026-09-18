use super::*;
use crony_domain::{FactoryAuthority, factory_claim_authority_id};

#[derive(Deserialize)]
struct Report {
    authority: FactoryAuthority,
    mode: String,
    new_claim_pin_required: bool,
}

pub(crate) async fn inspect(
    client: &Client,
    server: &str,
    corp_id: Uuid,
    actor_id: Uuid,
    expected: Option<Uuid>,
    executing: bool,
) -> Result<Value> {
    let endpoint = url::Url::parse(server).context("invalid control-plane endpoint")?;
    if !matches!(endpoint.scheme(), "http" | "https")
        || endpoint.host_str().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        bail!("control-plane endpoint must be HTTP(S) without credentials, query or fragment");
    }
    let mut target = url::Url::parse(&format!(
        "{}/api/corps/{corp_id}/factory/authority",
        server.trim_end_matches('/')
    ))?;
    target
        .query_pairs_mut()
        .append_pair("actor_id", &actor_id.to_string());
    let mut response = client
        .get(target.clone())
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()
        .context("claim authority unavailable; update or select the approved control plane")?;
    if !response.status().is_success() || response.url() != &target {
        bail!(
            "claim authority redirects are not supported; select the approved control plane directly"
        );
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 16_384 {
            bail!("claim authority report exceeds the 16384-byte limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    // Do not retain a serde error chain that could quote an untrusted response.
    let report: Report =
        serde_json::from_slice(&bytes).map_err(|_| anyhow!("invalid claim authority report"))?;
    validate(&report, corp_id, expected, executing)?;
    Ok(json!({
        "authority": report.authority,
        "mode": report.mode,
        "pin_verified": expected.is_some(),
        "new_claim_pin_required": report.new_claim_pin_required,
        "control_plane": endpoint.origin().ascii_serialization(),
        "notice": "Shared-backlog execution requires the same authenticated server, Corp and Project namespace. Unpinned development execution is not coordinated; database copies do not share locks."
    }))
}

fn validate(report: &Report, corp_id: Uuid, expected: Option<Uuid>, executing: bool) -> Result<()> {
    if report.authority.corp_id != corp_id
        || report.authority.claim_authority_id.is_nil()
        || !matches!(report.mode.as_str(), "production" | "development")
        || report.new_claim_pin_required != (report.mode == "production")
    {
        bail!("invalid or mismatched claim authority report");
    }
    if expected.is_some_and(|id| id.is_nil() || id != report.authority.claim_authority_id) {
        bail!("factory claim authority mismatch; no claim or dispatch was attempted");
    }
    if executing && report.new_claim_pin_required && expected.is_none() {
        bail!(
            "--claim-authority-id is required for production execution; inspect and confirm the approved shared authority first"
        );
    }
    Ok(())
}

pub(super) fn validate_recovery(args: &FactoryArgs, policy: &Value) -> Result<()> {
    if let Some(recorded) = factory_claim_authority_id(policy).map_err(anyhow::Error::msg)?
        && args.claim_authority_id != Some(recorded)
    {
        bail!(
            "recovery must retain its recorded --claim-authority-id; do not rebind an existing Factory lineage"
        );
    }
    // A pin on the request may check the current endpoint for legacy recovery,
    // but never adds a field to its persisted policy or idempotency snapshot.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue161_authority_report_rejects_wrong_ledger_corp_and_missing_production_pin() {
        let corp = Uuid::new_v4();
        let id = Uuid::new_v4();
        let mut report = Report {
            authority: FactoryAuthority {
                corp_id: corp,
                claim_authority_id: id,
            },
            mode: "production".into(),
            new_claim_pin_required: true,
        };
        assert!(validate(&report, corp, Some(id), true).is_ok());
        assert!(validate(&report, corp, None, false).is_ok());
        assert!(validate(&report, corp, None, true).is_err());
        assert!(validate(&report, corp, Some(Uuid::new_v4()), false).is_err());
        assert!(validate(&report, Uuid::new_v4(), Some(id), false).is_err());
        report.mode = "development".into();
        assert!(validate(&report, corp, Some(id), false).is_err());
        report.new_claim_pin_required = false;
        assert!(validate(&report, corp, None, true).is_ok());
    }
}
