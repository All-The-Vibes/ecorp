//! Durable, opt-in Base publication. Network and gateway calls live outside transactions.
use super::*;
use anyhow::ensure;
use chrono::{DateTime, Datelike, NaiveDate};
use crony_base::{
    B256, U256,
    abi::AnchorCall,
    config::BaseDestinationConfig,
    fees::{AdmissionContext, FeeQuote, admit},
    manifest::{ManifestTrust, SignedManifest, TrustPin},
    rpc::{AnchorEvent, FinalizedAnchor, ReceiptEvidence, SealedHeader},
    signing::{AuthorizedAttempt, FrozenTransaction, SignRequest, SignedTransaction},
};
use std::str::FromStr;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BaseDestinationInput {
    pub id: Uuid,
    pub config: BaseDestinationConfig,
    /// This is an administrator's explicit enrollment pin, not a key accepted from an export.
    pub trust_pin: TrustPin,
    pub manifests: Vec<SignedManifest>,
    pub retention_days: u32,
}

impl BaseDestinationInput {
    pub fn trusted_manifest(&self) -> Result<&SignedManifest> {
        ensure!(
            !self.id.is_nil() && (1..=36525).contains(&self.retention_days),
            "invalid Base identity or retention"
        );
        ensure!(
            !self.config.enabled,
            "configure disabled, then validate and explicitly enable"
        );
        self.config.validate()?;
        ensure!(
            self.config.require_github_archive,
            "alternate archive enrollment is unsupported; retained native GitHub receipt required"
        );
        ensure!(
            !self.manifests.is_empty() && self.manifests.len() <= 128,
            "bounded manifest chain required"
        );
        let mut trust = ManifestTrust::bootstrap(&self.trust_pin, &self.manifests[0])?;
        for next in self.manifests.iter().skip(1) {
            trust.advance(next)?;
        }
        let signed = self.manifests.last().context("manifest chain missing")?;
        let m = &signed.manifest;
        ensure!(
            self.config.manifest_digest == signed.digest
                && self.config.chain_id == m.chain_id
                && self.config.contract_address == m.contract_address
                && self.config.stream_id == m.stream_id
                && self.config.assurance == m.assurance_policy,
            "configuration and trusted manifest disagree"
        );
        Ok(signed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaseDestination {
    pub id: Uuid,
    pub corp_id: Uuid,
    pub input: BaseDestinationInput,
    pub enabled: bool,
    pub restore_required: bool,
    pub version: i64,
    pub status: String,
    pub next_due: DateTime<Utc>,
    pub observed_sequence: i64,
    pub observed_digest: Option<String>,
    pub verified_sequence: i64,
    pub verified_digest: Option<String>,
    pub scan_block: Option<i64>,
    pub scan_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaseIntent {
    pub id: Uuid,
    pub corp_id: Uuid,
    pub destination_id: Uuid,
    pub checkpoint_digest: String,
    pub sequence: i64,
    pub previous_digest: String,
    pub state: String,
    pub nonce: Option<i64>,
    pub terminal: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BaseAnchorPreview {
    pub destination: BaseDestination,
    pub checkpoint: Option<crony_audit::SignedCheckpoint>,
    pub archive_ready: bool,
}

/// Trusted-worker capability. Never serializable, never accepted by an HTTP handler.
#[derive(Debug, Clone)]
pub struct BaseClaim {
    pub intent: BaseIntent,
    worker_id: Uuid,
    fence: i64,
}

/// Constructed by the trusted worker after network checks, never deserialized from an API request.
pub struct BaseValidation<'a> {
    pub epoch: &'a str,
    pub cursor: i64,
    pub requests: &'a [SignRequest],
    pub pending_nonce: u64,
    pub observation: &'a Value,
}

fn destination_row(r: sqlx::postgres::PgRow) -> Result<BaseDestination> {
    Ok(BaseDestination {
        id: r.try_get("id")?,
        corp_id: r.try_get("corp_id")?,
        input: serde_json::from_value(r.try_get("config")?)?,
        enabled: r.try_get("enabled")?,
        restore_required: r.try_get("restore_required")?,
        version: r.try_get("version")?,
        status: r.try_get("status")?,
        next_due: r.try_get("next_due")?,
        observed_sequence: r.try_get("observed_sequence")?,
        observed_digest: r.try_get("observed_digest")?,
        verified_sequence: r.try_get("verified_sequence")?,
        verified_digest: r.try_get("verified_digest")?,
        scan_block: r.try_get("scan_block")?,
        scan_hash: r.try_get("scan_hash")?,
    })
}
fn intent_row(r: &sqlx::postgres::PgRow) -> Result<BaseIntent> {
    Ok(BaseIntent {
        id: r.try_get("id")?,
        corp_id: r.try_get("corp_id")?,
        destination_id: r.try_get("destination_id")?,
        checkpoint_digest: r.try_get("checkpoint_digest")?,
        sequence: r.try_get("sequence")?,
        previous_digest: r.try_get("previous_digest")?,
        state: r.try_get("state")?,
        nonce: r.try_get("nonce")?,
        terminal: r.try_get("terminal")?,
    })
}
fn wei(s: &str) -> Result<U256> {
    U256::from_str(s).context("invalid persisted integer wei")
}

#[async_trait::async_trait]
impl crony_base::signing::IntentAuthorizer for PgStore {
    async fn authorize(
        &self,
        attempt_id: Uuid,
        corp_id: Uuid,
    ) -> crony_base::Result<AuthorizedAttempt> {
        self.authorized_base_attempt(corp_id, attempt_id)
            .await
            .map_err(|_| {
                crony_base::Error::Signing("durable attempt authority unavailable or revoked")
            })
    }
}

#[derive(Debug, Clone)]
pub struct BaseAttempt {
    pub request: SignRequest,
    pub ordinal: u32,
    pub created_at: DateTime<Utc>,
    pub signed: Option<SignedTransaction>,
}

async fn fenced_tx(
    tx: &mut Transaction<'_, Postgres>,
    claim: &BaseClaim,
    publication: bool,
) -> Result<sqlx::postgres::PgRow> {
    let d = sqlx::query("SELECT d.enabled,d.restore_required,l.paused FROM base_audit_destinations d JOIN base_audit_sender_lanes l ON l.chain_id=d.chain_id AND l.sender=d.sender WHERE d.corp_id=$1 AND d.id=$2 FOR UPDATE OF d")
        .bind(claim.intent.corp_id).bind(claim.intent.destination_id).fetch_one(&mut **tx).await?;
    ensure!(
        (!publication || d.get::<bool, _>("enabled"))
            && !d.get::<bool, _>("restore_required")
            && !d.get::<bool, _>("paused"),
        "publication paused"
    );
    sqlx::query("SELECT *,reservation::text FROM base_audit_intents WHERE corp_id=$1 AND id=$2 AND worker_id=$3 AND fence=$4 AND lease_until>now() AND NOT terminal FOR UPDATE")
        .bind(claim.intent.corp_id).bind(claim.intent.id).bind(claim.worker_id).bind(claim.fence)
        .fetch_optional(&mut **tx).await?.context("stale Base worker fence")
}

async fn base_authorize(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    actor: Uuid,
    manage: bool,
) -> Result<()> {
    // Owner/admin also needs every covered room: an all-Corp proof must never hide filtered rows.
    if manage {
        super::budget_revision::ensure_budget_manager_tx(tx, corp, actor).await?;
    } else {
        assert_actor_scope_tx(tx, corp, actor).await?;
        let kind: String =
            sqlx::query_scalar("SELECT kind FROM actors WHERE id=$1 AND corp_id=$2 FOR SHARE")
                .bind(actor)
                .bind(corp)
                .fetch_one(&mut **tx)
                .await?;
        ensure!(kind == "human", "human audit authority required");
    }
    let rooms = sqlx::query_scalar::<_, Uuid>("SELECT DISTINCT m.room_id FROM state_audit_coverage c JOIN missions m ON m.id=c.mission_id AND m.corp_id=c.corp_id WHERE c.corp_id=$1")
        .bind(corp).fetch_all(&mut **tx).await?;
    for room in rooms {
        assert_room_membership_tx(tx, corp, room, actor).await?;
    }
    Ok(())
}

async fn evidence_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    destination: Uuid,
    intent: Option<Uuid>,
    kind: &str,
    identity: &str,
    evidence: &Value,
) -> Result<()> {
    // Allocate evidence IDs only under the same destination lock used by sweep watermarks.
    sqlx::query("SELECT id FROM base_audit_destinations WHERE corp_id=$1 AND id=$2 FOR UPDATE")
        .bind(corp)
        .bind(destination)
        .fetch_one(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO base_audit_evidence(corp_id,destination_id,intent_id,kind,identity,evidence) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(destination_id,kind,identity) DO NOTHING")
        .bind(corp).bind(destination).bind(intent).bind(kind).bind(identity).bind(evidence).execute(&mut **tx).await?;
    let prior: Value = sqlx::query_scalar("SELECT evidence FROM base_audit_evidence WHERE corp_id=$1 AND destination_id=$2 AND kind=$3 AND identity=$4")
        .bind(corp).bind(destination).bind(kind).bind(identity).fetch_one(&mut **tx).await?;
    ensure!(
        prior == *evidence,
        "immutable Base evidence replay conflict"
    );
    Ok(())
}

impl PgStore {
    pub async fn configure_base_destination(
        &self,
        corp: Uuid,
        actor: Uuid,
        input: &BaseDestinationInput,
    ) -> Result<BaseDestination> {
        let signed = input.trusted_manifest()?;
        let manifest = &signed.manifest;
        let mut tx = self.pool.begin().await?;
        base_authorize(&mut tx, corp, actor, true).await?;
        let ledger: Uuid = sqlx::query_scalar(
            "SELECT ledger_id FROM state_audit_ledgers WHERE corp_id=$1 FOR UPDATE",
        )
        .bind(corp)
        .fetch_one(&mut *tx)
        .await?;
        ensure!(
            manifest.ledger_id == ledger.to_string(),
            "manifest ledger is outside Corp"
        );
        if let Some(existing) = sqlx::query(
            "SELECT * FROM base_audit_destinations WHERE corp_id=$1 AND id=$2 FOR UPDATE",
        )
        .bind(corp)
        .bind(input.id)
        .fetch_optional(&mut *tx)
        .await?
        {
            let existing = destination_row(existing)?;
            ensure!(
                existing.input == *input,
                "immutable Base destination configuration conflict"
            );
            tx.commit().await?;
            return Ok(existing);
        }
        sqlx::query("INSERT INTO base_audit_customer_trust(customer_id,authority) VALUES($1,$2) ON CONFLICT DO NOTHING")
            .bind(manifest.customer_trust_id.as_slice()).bind(input.trust_pin.authority.as_slice()).execute(&mut *tx).await?;
        let customer_authority: Vec<u8> = sqlx::query_scalar(
            "SELECT authority FROM base_audit_customer_trust WHERE customer_id=$1 FOR SHARE",
        )
        .bind(manifest.customer_trust_id.as_slice())
        .fetch_one(&mut *tx)
        .await?;
        ensure!(
            customer_authority == input.trust_pin.authority,
            "customer trust ID cannot be claimed by a different authority"
        );
        let stream_lock = format!(
            "base-stream:{}:{}:{}",
            manifest.chain_id, manifest.contract_address, manifest.stream_id
        );
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
            .bind(stream_lock)
            .execute(&mut *tx)
            .await?;
        let previous=sqlx::query("SELECT id,corp_id,customer_id,config,enabled FROM base_audit_destinations WHERE chain_id=$1 AND registry=$2 AND stream_id=$3 ORDER BY created_at,id FOR UPDATE")
            .bind(i64::try_from(manifest.chain_id)?).bind(manifest.contract_address.as_slice()).bind(manifest.stream_id.as_slice()).fetch_all(&mut *tx).await?;
        for prior in previous
            .iter()
            .filter(|r| r.get::<Uuid, _>("id") != input.id)
        {
            ensure!(
                prior.get::<Uuid, _>("corp_id") == corp
                    && prior.get::<Vec<u8>, _>("customer_id")
                        == manifest.customer_trust_id.as_slice(),
                "public stream belongs to a different Corp/customer"
            );
            let old: BaseDestinationInput = serde_json::from_value(prior.get("config"))?;
            let old_manifest = old.trusted_manifest()?;
            ensure!(
                !prior.get::<bool, _>("enabled")
                    && manifest.manifest_version > old_manifest.manifest.manifest_version
                    && input
                        .manifests
                        .iter()
                        .any(|m| m.digest == old_manifest.digest),
                "configuration revision requires a paused predecessor and authorized manifest succession"
            );
            let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM base_audit_intents WHERE corp_id=$1 AND destination_id=$2 AND NOT terminal)")
                .bind(corp).bind(old.id).fetch_one(&mut *tx).await?;
            ensure!(
                !active,
                "drain predecessor publication before changing its immutable configuration"
            );
        }
        let mut predecessors: Vec<Uuid> = previous.iter().map(|row| row.get("id")).collect();
        if previous.is_empty()
            && let Some(migration) = &manifest.migration
        {
            let old_identity = &migration.old_destination;
            let old = sqlx::query("SELECT * FROM base_audit_destinations WHERE chain_id=$1 AND registry=$2 AND stream_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE")
                .bind(i64::try_from(old_identity.chain_id)?).bind(old_identity.contract.as_slice())
                .bind(old_identity.stream_id.as_slice()).fetch_optional(&mut *tx).await?
                .context("recovery predecessor is not retained")?;
            let old = destination_row(old)?;
            ensure!(
                old.corp_id == corp
                    && old.input.trusted_manifest()?.manifest.customer_trust_id
                        == manifest.customer_trust_id
                    && !old.enabled
                    && input
                        .manifests
                        .iter()
                        .any(|m| m.digest == old.input.config.manifest_digest),
                "recovery needs the paused same-Corp predecessor and its trusted manifest chain"
            );
            let superseded:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM base_audit_evidence WHERE corp_id=$1 AND destination_id=$2 AND kind='superseded')")
                .bind(corp).bind(old.id).fetch_one(&mut *tx).await?;
            ensure!(
                !superseded,
                "recovery predecessor already superseded; use its current successor"
            );
            ensure!(
                old.observed_sequence == old.verified_sequence
                    || migration.incident_event.is_some(),
                "recovery of an unverified public head requires its retained incident event"
            );
            let verified = &migration.last_verified_anchor;
            ensure!(
                old.verified_sequence == i64::try_from(verified.sequence)?
                    && old.verified_digest.as_deref()
                        == Some(&hex::encode(verified.checkpoint_digest)),
                "recovery last verified prefix does not match retained evidence"
            );
            for (kind, anchor) in [
                ("finalized", Some(verified)),
                ("observed_event", migration.incident_event.as_ref()),
            ] {
                if let Some(anchor) = anchor {
                    let events:Vec<Value>=sqlx::query_scalar("SELECT evidence->'event' FROM base_audit_evidence WHERE corp_id=$1 AND destination_id=$2 AND kind=$3")
                        .bind(corp).bind(old.id).bind(kind).fetch_all(&mut *tx).await?;
                    let mut found = false;
                    for event in events {
                        let event: AnchorEvent = serde_json::from_value(event)?;
                        found |= event.call.sequence == anchor.sequence
                            && event.call.checkpoint_digest == anchor.checkpoint_digest
                            && event.transaction_hash == anchor.transaction_hash
                            && event.log_index == anchor.log_index;
                    }
                    ensure!(found, "signed migration anchor is not retained");
                }
            }
            let first = hex::encode(migration.first_new_checkpoint);
            let archive = base_pinned_archive(
                Self::load_archive(&mut tx, corp, ledger).await?,
                Some(&first),
            )?;
            verify_base_archive(input, &archive)?;
            ensure!(
                archive
                    .checkpoints
                    .last()
                    .is_some_and(|c| c.checkpoint.last_sequence >= verified.sequence),
                "recovery first checkpoint regresses the verified prefix"
            );
            predecessors.push(old.id);
        }
        let value = serde_json::to_value(input)?;
        sqlx::query("INSERT INTO base_audit_destinations(id,corp_id,customer_id,config,manifest_digest,chain_id,sender,registry,stream_id,next_due) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING")
            .bind(input.id).bind(corp).bind(manifest.customer_trust_id.as_slice()).bind(&value)
            .bind(signed.digest.to_string()).bind(i64::try_from(manifest.chain_id)?)
            .bind(input.config.publisher.as_slice()).bind(manifest.contract_address.as_slice()).bind(manifest.stream_id.as_slice())
            .bind(input.config.schedule.next_after(Utc::now())?).execute(&mut *tx).await?;
        let stored = destination_row(
            sqlx::query(
                "SELECT * FROM base_audit_destinations WHERE corp_id=$1 AND id=$2 FOR UPDATE",
            )
            .bind(corp)
            .bind(input.id)
            .fetch_one(&mut *tx)
            .await?,
        )?;
        ensure!(
            stored.input == *input,
            "immutable Base destination configuration conflict"
        );
        let policy = input
            .config
            .spending_policy
            .as_ref()
            .context("spending policy missing")?;
        sqlx::query("INSERT INTO base_audit_sender_lanes(chain_id,sender,customer_id,monthly_budget) VALUES($1,$2,$3,$4::numeric) ON CONFLICT(chain_id,sender) DO NOTHING")
            .bind(i64::try_from(manifest.chain_id)?).bind(input.config.publisher.as_slice())
            .bind(manifest.customer_trust_id.as_slice()).bind(policy.monthly_budget.to_string()).execute(&mut *tx).await?;
        let lane = sqlx::query("SELECT customer_id,monthly_budget::text FROM base_audit_sender_lanes WHERE chain_id=$1 AND sender=$2 FOR UPDATE")
            .bind(i64::try_from(manifest.chain_id)?).bind(input.config.publisher.as_slice()).fetch_one(&mut *tx).await?;
        ensure!(
            lane.get::<Vec<u8>, _>("customer_id") == manifest.customer_trust_id.as_slice()
                && wei(&lane.get::<String, _>("monthly_budget"))? == policy.monthly_budget,
            "wallet customer boundary or shared-wallet budget differs"
        );
        evidence_tx(
            &mut tx,
            corp,
            input.id,
            None,
            "configured",
            "1",
            &json!({"actor_id":actor,"manifest_digest":signed.digest}),
        )
        .await?;
        for predecessor in predecessors {
            evidence_tx(&mut tx,corp,predecessor,None,"superseded",&input.id.to_string(),
                &json!({"successor_destination_id":input.id,"manifest_digest":signed.digest,"migration":manifest.migration})).await?;
            evidence_tx(&mut tx,corp,input.id,None,"predecessor",&predecessor.to_string(),
                &json!({"predecessor_destination_id":predecessor,"manifest_digest":signed.digest,"migration":manifest.migration})).await?;
        }
        tx.commit().await?;
        Ok(stored)
    }

    pub async fn base_destination(
        &self,
        corp: Uuid,
        actor: Uuid,
        id: Uuid,
    ) -> Result<BaseDestination> {
        let mut tx = self.pool.begin().await?;
        base_authorize(&mut tx, corp, actor, false).await?;
        let result = destination_row(
            sqlx::query("SELECT * FROM base_audit_destinations WHERE corp_id=$1 AND id=$2")
                .bind(corp)
                .bind(id)
                .fetch_one(&mut *tx)
                .await?,
        )?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn base_destination_for_admin(
        &self,
        corp: Uuid,
        actor: Uuid,
        id: Uuid,
    ) -> Result<BaseDestination> {
        let mut tx = self.pool.begin().await?;
        base_authorize(&mut tx, corp, actor, true).await?;
        let result = destination_row(
            sqlx::query("SELECT * FROM base_audit_destinations WHERE corp_id=$1 AND id=$2")
                .bind(corp)
                .bind(id)
                .fetch_one(&mut *tx)
                .await?,
        )?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn base_status(&self, corp: Uuid, actor: Uuid) -> Result<Value> {
        let mut tx = self.pool.begin().await?;
        base_authorize(&mut tx, corp, actor, false).await?;
        let rows = sqlx::query(
            "SELECT * FROM base_audit_destinations WHERE corp_id=$1 ORDER BY id LIMIT 64",
        )
        .bind(corp)
        .fetch_all(&mut *tx)
        .await?;
        let destinations = rows
            .into_iter()
            .map(destination_row)
            .collect::<Result<Vec<_>>>()?;
        let intents: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'destination_id',destination_id,'sequence',sequence,'checkpoint_digest',checkpoint_digest,'state',state,'nonce',nonce,'reservation_wei',reservation::text,'settled_wei',settled::text,'fee_warning',fee_warning) FROM base_audit_intents WHERE corp_id=$1 AND NOT terminal ORDER BY created_at LIMIT 64")
            .bind(corp).fetch_all(&mut *tx).await?;
        tx.commit().await?;
        Ok(
            json!({"destinations":destinations,"intents":intents,"assurance_note":"RPC observations are not offline cryptographic finality proofs"}),
        )
    }

    pub async fn base_audit_preview(
        &self,
        corp: Uuid,
        actor: Uuid,
        id: Uuid,
    ) -> Result<BaseAnchorPreview> {
        let mut tx = self.pool.begin().await?;
        base_authorize(&mut tx, corp, actor, false).await?;
        let destination = destination_row(
            sqlx::query(
                "SELECT * FROM base_audit_destinations WHERE corp_id=$1 AND id=$2 FOR SHARE",
            )
            .bind(corp)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?,
        )?;
        let ledger: Uuid = sqlx::query_scalar(
            "SELECT ledger_id FROM state_audit_ledgers WHERE corp_id=$1 FOR SHARE",
        )
        .bind(corp)
        .fetch_one(&mut *tx)
        .await?;
        let first_migration_checkpoint = destination
            .input
            .trusted_manifest()?
            .manifest
            .migration
            .as_ref()
            .filter(|_| destination.verified_sequence == 0)
            .map(|m| hex::encode(m.first_new_checkpoint));
        let archive = base_pinned_archive(
            Self::load_archive(&mut tx, corp, ledger).await?,
            first_migration_checkpoint.as_deref(),
        )?;
        let checkpoint = archive.checkpoints.last().cloned();
        let mut archive_ready = false;
        if let Some(checkpoint) = &checkpoint {
            verify_base_archive(&destination.input, &archive)?;
            archive_ready=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM state_audit_anchor_receipts r JOIN state_audit_destinations g ON g.id=r.destination_id AND g.corp_id=r.corp_id WHERE r.corp_id=$1 AND r.checkpoint_digest=$2 AND r.status='published' AND g.kind='github')")
                .bind(corp).bind(&checkpoint.digest).fetch_one(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(BaseAnchorPreview {
            destination,
            checkpoint,
            archive_ready,
        })
    }

    pub async fn base_history(
        &self,
        corp: Uuid,
        actor: Uuid,
        destination: Uuid,
        after: Option<i64>,
        limit: u32,
    ) -> Result<Value> {
        ensure!(
            (1..=100).contains(&limit) && after.is_none_or(|v| v >= 0),
            "invalid evidence page"
        );
        let mut tx = self.pool.begin().await?;
        base_authorize(&mut tx, corp, actor, false).await?;
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM base_audit_destinations WHERE corp_id=$1 AND id=$2)",
        )
        .bind(corp)
        .bind(destination)
        .fetch_one(&mut *tx)
        .await?;
        ensure!(exists, "Base destination not found in Corp");
        let rows: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'kind',kind,'identity',identity,'evidence',evidence,'created_at',created_at) FROM base_audit_evidence WHERE corp_id=$1 AND destination_id=$2 AND id>$3 ORDER BY id LIMIT $4")
            .bind(corp).bind(destination).bind(after.unwrap_or(0)).bind(i64::from(limit)).fetch_all(&mut *tx).await?;
        tx.commit().await?;
        Ok(json!({"items":rows}))
    }

    pub async fn control_base_destination(
        &self,
        corp: Uuid,
        actor: Uuid,
        id: Uuid,
        expected_version: i64,
        enabled: bool,
    ) -> Result<BaseDestination> {
        let mut tx = self.pool.begin().await?;
        base_authorize(&mut tx, corp, actor, true).await?;
        let r = sqlx::query(
            "SELECT * FROM base_audit_destinations WHERE corp_id=$1 AND id=$2 FOR UPDATE",
        )
        .bind(corp)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        ensure!(
            r.get::<i64, _>("version") == expected_version,
            "stale Base destination version"
        );
        if enabled {
            let superseded:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM base_audit_evidence WHERE corp_id=$1 AND destination_id=$2 AND kind='superseded')")
                .bind(corp).bind(id).fetch_one(&mut *tx).await?;
            ensure!(!superseded, "superseded destination cannot be reenabled");
            ensure!(
                !r.get::<bool, _>("restore_required")
                    && r.get::<Option<DateTime<Utc>>, _>("validation_expires")
                        .is_some_and(|t| t > Utc::now())
                    && r.get::<Option<Value>, _>("validation").is_some(),
                "trusted worker validation and journal reconciliation required"
            );
            ensure!(
                !matches!(
                    r.get::<String, _>("status").as_str(),
                    "conflicting_anchor" | "finalized_contradiction" | "invalid_evidence"
                ),
                "incident requires linked recovery, not resume"
            );
            let other:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM base_audit_destinations other JOIN base_audit_destinations current ON current.chain_id=other.chain_id AND current.registry=other.registry AND current.stream_id=other.stream_id JOIN base_audit_intents i ON i.destination_id=other.id AND i.corp_id=other.corp_id WHERE current.corp_id=$1 AND current.id=$2 AND other.id<>current.id AND NOT i.terminal)")
                .bind(corp).bind(id).fetch_one(&mut *tx).await?;
            ensure!(
                !other,
                "another revision of this public stream has unresolved publication"
            );
        }
        let result = destination_row(sqlx::query("UPDATE base_audit_destinations SET enabled=$3,version=version+1,status=$4 WHERE corp_id=$1 AND id=$2 RETURNING *")
            .bind(corp).bind(id).bind(enabled).bind(if enabled {"ready"} else {"paused"}).fetch_one(&mut *tx).await?)?;
        evidence_tx(
            &mut tx,
            corp,
            id,
            None,
            "administration",
            &result.version.to_string(),
            &json!({"actor_id":actor,"enabled":enabled,"pending_transactions_canceled":false}),
        )
        .await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn request_base_anchor(
        &self,
        corp: Uuid,
        actor: Uuid,
        destination: Uuid,
        operation: Uuid,
    ) -> Result<BaseIntent> {
        ensure!(!operation.is_nil(), "publication idempotency key required");
        let mut tx = self.pool.begin().await?;
        // The HTTP boundary additionally requires PublishAnchor. Native store admission is owner/admin only.
        base_authorize(&mut tx, corp, actor, true).await?;
        let d = destination_row(
            sqlx::query(
                "SELECT * FROM base_audit_destinations WHERE corp_id=$1 AND id=$2 FOR UPDATE",
            )
            .bind(corp)
            .bind(destination)
            .fetch_one(&mut *tx)
            .await?,
        )?;
        if let Some(prior) = sqlx::query("SELECT o.destination_id,i.* FROM base_audit_operations o JOIN base_audit_intents i ON i.id=o.intent_id AND i.corp_id=o.corp_id WHERE o.corp_id=$1 AND o.actor_id=$2 AND o.operation_id=$3")
            .bind(corp).bind(actor).bind(operation).fetch_optional(&mut *tx).await? {
            ensure!(prior.get::<Uuid,_>("destination_id")==destination, "publication key reused for another destination");
            let intent = intent_row(&prior)?;
            tx.commit().await?;
            return Ok(intent);
        }
        let intent = Self::enqueue_base_tx(&mut tx, &d, false)
            .await?
            .context("no checkpoint advancement")?;
        sqlx::query("INSERT INTO base_audit_operations(corp_id,actor_id,operation_id,destination_id,intent_id) VALUES($1,$2,$3,$4,$5)")
            .bind(corp).bind(actor).bind(operation).bind(destination).bind(intent.id).execute(&mut *tx).await?;
        evidence_tx(
            &mut tx,
            corp,
            destination,
            Some(intent.id),
            "requested",
            &operation.to_string(),
            &json!({"actor_id":actor}),
        )
        .await?;
        tx.commit().await?;
        Ok(intent)
    }

    async fn enqueue_base_tx(
        tx: &mut Transaction<'_, Postgres>,
        d: &BaseDestination,
        scheduled: bool,
    ) -> Result<Option<BaseIntent>> {
        ensure!(
            d.enabled && !d.restore_required,
            "Base publication disabled or restore reconciliation required"
        );
        let pending = sqlx::query("SELECT * FROM base_audit_intents WHERE corp_id=$1 AND destination_id=$2 AND NOT terminal FOR UPDATE")
            .bind(d.corp_id).bind(d.id).fetch_optional(&mut **tx).await?
            .map(|row|intent_row(&row)).transpose()?;
        if let Some(pending) = &pending
            && pending.nonce.is_some()
        {
            return Ok(Some(pending.clone()));
        }
        if scheduled && d.next_due > Utc::now() && pending.is_none() {
            return Ok(None);
        }
        ensure!(
            d.observed_sequence == d.verified_sequence && d.observed_digest == d.verified_digest,
            "unverified observed anchor blocks continuity"
        );
        let ledger: Uuid = sqlx::query_scalar(
            "SELECT ledger_id FROM state_audit_ledgers WHERE corp_id=$1 FOR UPDATE",
        )
        .bind(d.corp_id)
        .fetch_one(&mut **tx)
        .await?;
        let first_migration_checkpoint = d
            .input
            .trusted_manifest()?
            .manifest
            .migration
            .as_ref()
            .filter(|_| d.verified_sequence == 0)
            .map(|m| hex::encode(m.first_new_checkpoint));
        let archive = base_pinned_archive(
            Self::load_archive(tx, d.corp_id, ledger).await?,
            first_migration_checkpoint.as_deref(),
        )?;
        let Some(checkpoint) = archive.checkpoints.last() else {
            return Ok(None);
        };
        if checkpoint.checkpoint.last_sequence <= u64::try_from(d.verified_sequence)? {
            return Ok(None);
        }
        verify_base_archive(&d.input, &archive)?;
        let digest = &checkpoint.digest;
        if let Some(pending) = &pending
            && pending.checkpoint_digest == *digest
        {
            return Ok(Some(pending.clone()));
        }
        let archived: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM state_audit_anchor_receipts r JOIN state_audit_destinations g ON g.id=r.destination_id AND g.corp_id=r.corp_id WHERE r.corp_id=$1 AND r.checkpoint_digest=$2 AND r.status='published' AND g.kind='github')")
            .bind(d.corp_id).bind(digest).fetch_one(&mut **tx).await?;
        let ready = archived;
        sqlx::query("INSERT INTO base_audit_retained_history(corp_id,destination_id,checkpoint_digest,archive,retained_until) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING")
            .bind(d.corp_id).bind(d.id).bind(digest).bind(serde_json::to_value(&archive)?)
            .bind(Utc::now()+Duration::days(i64::from(d.input.retention_days))).execute(&mut **tx).await?;
        let id = Uuid::new_v4();
        if let Some(pending) = pending {
            ensure!(
                checkpoint.checkpoint.last_sequence > u64::try_from(pending.sequence)?,
                "coalescing cannot regress checkpoint coverage"
            );
            sqlx::query("UPDATE base_audit_intents SET terminal=true,state='coalesced',fence=fence+1,lease_until=NULL,updated_at=now() WHERE corp_id=$1 AND id=$2 AND nonce IS NULL")
                .bind(d.corp_id).bind(pending.id).execute(&mut **tx).await?;
            evidence_tx(tx,d.corp_id,d.id,Some(pending.id),"coalesced",&id.to_string(),
                &json!({"successor_intent_id":id,"checkpoint_digest":digest,"sequence":checkpoint.checkpoint.last_sequence})).await?;
        }
        let prior = d.verified_digest.clone().unwrap_or_else(|| "0".repeat(64));
        let row = sqlx::query("INSERT INTO base_audit_intents(id,corp_id,destination_id,checkpoint_digest,sequence,previous_digest,state) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(destination_id,checkpoint_digest) DO UPDATE SET updated_at=base_audit_intents.updated_at RETURNING *")
            .bind(id).bind(d.corp_id).bind(d.id).bind(digest).bind(i64::try_from(checkpoint.checkpoint.last_sequence)?)
            .bind(prior).bind(if ready {"ready"} else {"archive_pending"}).fetch_one(&mut **tx).await?;
        sqlx::query(
            "UPDATE base_audit_destinations SET next_due=$3,status=$4 WHERE corp_id=$1 AND id=$2",
        )
        .bind(d.corp_id)
        .bind(d.id)
        .bind(d.input.config.schedule.next_after(Utc::now())?)
        .bind(if ready { "ready" } else { "archive_pending" })
        .execute(&mut **tx)
        .await?;
        Ok(Some(intent_row(&row)?))
    }

    /// Trusted worker only. Configuration reads include no endpoint credential values.
    pub async fn base_worker_destinations(&self) -> Result<Vec<BaseDestination>> {
        sqlx::query("SELECT * FROM base_audit_destinations ORDER BY id LIMIT 1024")
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(destination_row)
            .collect()
    }

    pub async fn base_has_unresolved_attempt(&self, corp: Uuid, destination: Uuid) -> Result<bool> {
        Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM base_audit_intents WHERE corp_id=$1 AND destination_id=$2 AND NOT terminal AND nonce IS NOT NULL)")
            .bind(corp).bind(destination).fetch_one(&self.pool).await?)
    }

    pub async fn schedule_base_anchor(
        &self,
        corp: Uuid,
        destination: Uuid,
    ) -> Result<Option<BaseIntent>> {
        let mut tx = self.pool.begin().await?;
        let d = destination_row(
            sqlx::query(
                "SELECT * FROM base_audit_destinations WHERE corp_id=$1 AND id=$2 FOR UPDATE",
            )
            .bind(corp)
            .bind(destination)
            .fetch_one(&mut *tx)
            .await?,
        )?;
        let intent = Self::enqueue_base_tx(&mut tx, &d, true).await?;
        tx.commit().await?;
        Ok(intent)
    }

    pub async fn claim_base_intent(
        &self,
        corp: Uuid,
        destination: Uuid,
        worker: Uuid,
    ) -> Result<Option<BaseClaim>> {
        ensure!(!worker.is_nil(), "worker identity required");
        let mut tx = self.pool.begin().await?;
        let d = sqlx::query("SELECT enabled,restore_required FROM base_audit_destinations WHERE corp_id=$1 AND id=$2 FOR SHARE")
            .bind(corp).bind(destination).fetch_one(&mut *tx).await?;
        if d.get::<bool, _>("restore_required") {
            tx.commit().await?;
            return Ok(None);
        }
        sqlx::query("UPDATE base_audit_intents i SET state='ready' WHERE i.corp_id=$1 AND i.destination_id=$2 AND i.state='archive_pending' AND EXISTS(SELECT 1 FROM state_audit_anchor_receipts r JOIN state_audit_destinations g ON g.id=r.destination_id AND g.corp_id=r.corp_id WHERE r.corp_id=i.corp_id AND r.checkpoint_digest=i.checkpoint_digest AND r.status='published' AND g.kind='github')")
            .bind(corp).bind(destination).execute(&mut *tx).await?;
        let row = sqlx::query("UPDATE base_audit_intents SET worker_id=$3,fence=fence+1,lease_until=now()+interval '120 seconds',updated_at=now() WHERE id=(SELECT id FROM base_audit_intents WHERE corp_id=$1 AND destination_id=$2 AND ($4 OR nonce IS NOT NULL) AND NOT terminal AND state NOT IN ('archive_pending','conflicting_anchor','nonce_conflict','invalid_evidence') AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *")
            .bind(corp).bind(destination).bind(worker).bind(d.get::<bool,_>("enabled")).fetch_optional(&mut *tx).await?;
        let claim = row
            .map(|r| -> Result<BaseClaim> {
                Ok(BaseClaim {
                    intent: intent_row(&r)?,
                    worker_id: worker,
                    fence: r.try_get("fence")?,
                })
            })
            .transpose()?;
        tx.commit().await?;
        Ok(claim)
    }

    pub async fn release_base_claim(&self, claim: &BaseClaim, state: &str) -> Result<()> {
        ensure!(
            matches!(
                state,
                "ready"
                    | "rpc_unavailable"
                    | "signer_unavailable"
                    | "dropped_or_unknown"
                    | "awaiting_funds"
                    | "fee_deferred"
                    | "broadcast"
                    | "included"
                    | "safe"
                    | "reorged"
            ),
            "invalid worker retry state"
        );
        let changed = sqlx::query("UPDATE base_audit_intents SET state=$5,lease_until=NULL,updated_at=now() WHERE corp_id=$1 AND id=$2 AND worker_id=$3 AND fence=$4 AND lease_until>now() AND NOT terminal")
            .bind(claim.intent.corp_id).bind(claim.intent.id).bind(claim.worker_id).bind(claim.fence).bind(state).execute(&self.pool).await?;
        ensure!(changed.rows_affected() == 1, "stale Base worker fence");
        Ok(())
    }

    pub async fn check_base_fence(&self, claim: &BaseClaim) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        fenced_tx(&mut tx, claim, true).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Reads the original immutable attempt before considering new signing authority.
    pub async fn base_attempts(&self, claim: &BaseClaim) -> Result<Vec<BaseAttempt>> {
        let mut tx = self.pool.begin().await?;
        fenced_tx(&mut tx, claim, false).await?;
        let rows = sqlx::query("SELECT a.frozen,a.ordinal,a.created_at,s.raw_tx FROM base_audit_attempts a LEFT JOIN base_audit_signed_results s ON s.attempt_id=a.id AND s.corp_id=a.corp_id WHERE a.corp_id=$1 AND a.intent_id=$2 ORDER BY a.ordinal")
            .bind(claim.intent.corp_id).bind(claim.intent.id).fetch_all(&mut *tx).await?;
        let mut out = Vec::new();
        for r in rows {
            let request: SignRequest = serde_json::from_value(r.try_get("frozen")?)?;
            let raw: Option<Vec<u8>> = r.try_get("raw_tx")?;
            let signed = raw
                .map(|b| SignedTransaction::validate(&request, &b))
                .transpose()?;
            out.push(BaseAttempt {
                request,
                ordinal: u32::try_from(r.try_get::<i32, _>("ordinal")?)?,
                created_at: r.try_get("created_at")?,
                signed,
            });
        }
        tx.commit().await?;
        Ok(out)
    }

    /// Balance and pending nonce are fresh read-only RPC observations. No network I/O under lock.
    pub async fn reserve_base_attempt(
        &self,
        claim: &BaseClaim,
        quote: &FeeQuote,
        balance: U256,
        pending_nonce: u64,
        replacement: bool,
    ) -> Result<BaseAttempt> {
        let mut tx = self.pool.begin().await?;
        let r = fenced_tx(&mut tx, claim, true).await?;
        let d = destination_row(
            sqlx::query("SELECT * FROM base_audit_destinations WHERE corp_id=$1 AND id=$2")
                .bind(claim.intent.corp_id)
                .bind(claim.intent.destination_id)
                .fetch_one(&mut *tx)
                .await?,
        )?;
        ensure!(
            d.observed_sequence == d.verified_sequence && d.observed_digest == d.verified_digest,
            "unverified observed anchor"
        );
        let c = &d.input.config;
        let lane = sqlx::query(
            "SELECT * FROM base_audit_sender_lanes WHERE chain_id=$1 AND sender=$2 FOR UPDATE",
        )
        .bind(i64::try_from(c.chain_id)?)
        .bind(c.publisher.as_slice())
        .fetch_one(&mut *tx)
        .await?;
        ensure!(
            !lane.get::<bool, _>("paused"),
            "wallet journal reconciliation required"
        );
        ensure!(
            lane.get::<Option<Uuid>, _>("active_intent")
                .is_none_or(|i| i == claim.intent.id),
            "sender nonce lane occupied"
        );
        let attempts: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM base_audit_attempts WHERE corp_id=$1 AND intent_id=$2",
        )
        .bind(d.corp_id)
        .bind(claim.intent.id)
        .fetch_one(&mut *tx)
        .await?;
        ensure!(
            (attempts == 0 && !replacement) || (attempts > 0 && replacement),
            "reuse frozen attempt, or explicitly replace"
        );
        let reserved_nonce: Option<i64> = r.try_get("nonce")?;
        let nonce = reserved_nonce.unwrap_or(lane.get::<i64, _>("next_nonce"));
        let pending = i64::try_from(pending_nonce)?;
        if (reserved_nonce.is_none() && pending != nonce) || pending > nonce + 1 {
            sqlx::query(
                "UPDATE base_audit_sender_lanes SET paused=true WHERE chain_id=$1 AND sender=$2",
            )
            .bind(i64::try_from(c.chain_id)?)
            .bind(c.publisher.as_slice())
            .execute(&mut *tx)
            .await?;
            sqlx::query("UPDATE base_audit_destinations SET restore_required=true,status='nonce_conflict' WHERE chain_id=$1 AND sender=$2")
                .bind(i64::try_from(c.chain_id)?).bind(c.publisher.as_slice()).execute(&mut *tx).await?;
            evidence_tx(
                &mut tx,
                d.corp_id,
                d.id,
                Some(claim.intent.id),
                "nonce_conflict",
                &Uuid::new_v4().to_string(),
                &json!({"reserved":nonce,"pending":pending}),
            )
            .await?;
            tx.commit().await?;
            anyhow::bail!("unknown consumed nonce; wallet paused");
        }
        ensure!(
            r.get::<String, _>("state") != "included" && r.get::<String, _>("state") != "safe",
            "included attempt cannot be replaced"
        );
        if replacement {
            let included:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM base_audit_evidence e WHERE corp_id=$1 AND destination_id=$2 AND intent_id=$3 AND kind='inclusion' AND NOT EXISTS(SELECT 1 FROM base_audit_evidence r WHERE r.corp_id=e.corp_id AND r.destination_id=e.destination_id AND r.kind='reorged' AND r.evidence->>'old_block_hash'=e.evidence->'block'->>'hash'))")
                .bind(d.corp_id).bind(d.id).bind(claim.intent.id).fetch_one(&mut *tx).await?;
            ensure!(
                !included,
                "observed inclusion must be reconciled, not replaced"
            );
            let prior: Value = sqlx::query_scalar("SELECT frozen FROM base_audit_attempts WHERE corp_id=$1 AND intent_id=$2 ORDER BY ordinal DESC LIMIT 1")
                .bind(d.corp_id).bind(claim.intent.id).fetch_one(&mut *tx).await?;
            let prior: SignRequest = serde_json::from_value(prior)?;
            ensure!(
                quote.max_fee_per_gas > prior.transaction.max_fee_per_gas
                    && quote.max_priority_fee_per_gas > prior.transaction.max_priority_fee_per_gas,
                "replacement must increase both fee caps"
            );
        }
        let costs = sqlx::query("SELECT COALESCE(sum(CASE WHEN i.inclusion_month=date_trunc('month',now() AT TIME ZONE 'UTC')::date THEN i.settled ELSE 0 END),0)::text AS settled,COALESCE(sum(CASE WHEN i.id<>$3 THEN i.reservation ELSE 0 END),0)::text AS unresolved FROM base_audit_intents i JOIN base_audit_destinations d ON d.id=i.destination_id AND d.corp_id=i.corp_id WHERE d.chain_id=$1 AND d.sender=$2")
            .bind(i64::try_from(c.chain_id)?).bind(c.publisher.as_slice()).bind(claim.intent.id).fetch_one(&mut *tx).await?;
        let policy = c
            .spending_policy
            .as_ref()
            .context("missing spending policy")?;
        let admission = admit(
            policy,
            quote,
            &AdmissionContext {
                now: Utc::now(),
                balance,
                settled_this_month: wei(&costs.get::<String, _>("settled"))?,
                other_unresolved: wei(&costs.get::<String, _>("unresolved"))?,
                same_nonce_exposure: wei(&r.get::<String, _>("reservation"))?,
                replacement_count: u32::try_from(attempts)?,
            },
        )?;
        let call = AnchorCall {
            stream_id: c.stream_id,
            sequence: u64::try_from(claim.intent.sequence)?,
            checkpoint_digest: B256::from_str(&claim.intent.checkpoint_digest)?,
            previous_anchor_digest: B256::from_str(&claim.intent.previous_digest)?,
        };
        let calldata = call.calldata()?;
        let request = SignRequest {
            attempt_id: Uuid::new_v4(),
            intent_id: claim.intent.id,
            corp_id: d.corp_id,
            manifest_digest: c.manifest_digest,
            immutable_key_identity: c.signer_key_identity.clone(),
            transaction: FrozenTransaction {
                chain_id: c.chain_id,
                sender: c.publisher,
                contract: c.contract_address,
                nonce: u64::try_from(nonce)?,
                gas_limit: quote.gas_limit,
                max_fee_per_gas: quote.max_fee_per_gas,
                max_priority_fee_per_gas: quote.max_priority_fee_per_gas,
                call,
            },
        };
        request.validate()?;
        let retained: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM base_audit_retained_history WHERE corp_id=$1 AND destination_id=$2 AND checkpoint_digest=$3 AND retained_until>now())")
            .bind(d.corp_id).bind(d.id).bind(&claim.intent.checkpoint_digest).fetch_one(&mut *tx).await?;
        ensure!(retained, "retained source evidence required before signing");
        sqlx::query("INSERT INTO base_audit_attempts(id,corp_id,intent_id,ordinal,frozen,liability) VALUES($1,$2,$3,$4,$5,$6::numeric)")
            .bind(request.attempt_id).bind(d.corp_id).bind(claim.intent.id).bind(i32::try_from(attempts)?)
            .bind(serde_json::to_value(&request)?).bind(admission.attempt_exposure.to_string()).execute(&mut *tx).await?;
        sqlx::query("UPDATE base_audit_intents SET nonce=$3,calldata=$4,reservation=$5::numeric,state='nonce_reserved',updated_at=now() WHERE corp_id=$1 AND id=$2")
            .bind(d.corp_id).bind(claim.intent.id).bind(nonce).bind(calldata.as_ref()).bind(admission.reservation.to_string()).execute(&mut *tx).await?;
        sqlx::query("UPDATE base_audit_sender_lanes SET active_corp_id=$3,active_intent=$4,next_nonce=$5 WHERE chain_id=$1 AND sender=$2")
            .bind(i64::try_from(c.chain_id)?).bind(c.publisher.as_slice()).bind(d.corp_id).bind(claim.intent.id)
            .bind(nonce.checked_add(1).context("nonce overflow")?).execute(&mut *tx).await?;
        evidence_tx(&mut tx,d.corp_id,d.id,Some(claim.intent.id),"attempt_frozen",&request.attempt_id.to_string(),
            &json!({"attempt_id":request.attempt_id,"ordinal":attempts,"liability_wei":admission.attempt_exposure.to_string(),"low_balance":admission.low_balance})).await?;
        tx.commit().await?;
        Ok(BaseAttempt {
            request,
            ordinal: u32::try_from(attempts)?,
            created_at: Utc::now(),
            signed: None,
        })
    }

    pub async fn persist_base_signed(
        &self,
        claim: &BaseClaim,
        request: &SignRequest,
        signed: &SignedTransaction,
        journal_sequence: i64,
    ) -> Result<()> {
        ensure!(
            request.intent_id == claim.intent.id
                && request.corp_id == claim.intent.corp_id
                && journal_sequence >= 0,
            "signed result scope mismatch"
        );
        SignedTransaction::validate(request, signed.raw())?;
        let mut tx = self.pool.begin().await?;
        fenced_tx(&mut tx, claim, false).await?;
        let frozen: Value = sqlx::query_scalar(
            "SELECT frozen FROM base_audit_attempts WHERE corp_id=$1 AND id=$2 AND intent_id=$3",
        )
        .bind(request.corp_id)
        .bind(request.attempt_id)
        .bind(request.intent_id)
        .fetch_one(&mut *tx)
        .await?;
        ensure!(
            frozen == serde_json::to_value(request)?,
            "signing result differs from frozen attempt"
        );
        sqlx::query("INSERT INTO base_audit_signed_results(attempt_id,corp_id,raw_tx,tx_hash,journal_sequence) VALUES($1,$2,$3,$4,$5) ON CONFLICT(attempt_id) DO NOTHING")
            .bind(request.attempt_id).bind(request.corp_id).bind(signed.raw()).bind(signed.hash().to_string()).bind(journal_sequence).execute(&mut *tx).await?;
        let prior: Vec<u8> = sqlx::query_scalar(
            "SELECT raw_tx FROM base_audit_signed_results WHERE corp_id=$1 AND attempt_id=$2",
        )
        .bind(request.corp_id)
        .bind(request.attempt_id)
        .fetch_one(&mut *tx)
        .await?;
        ensure!(
            prior == signed.raw(),
            "gateway changed journaled signed bytes"
        );
        sqlx::query("UPDATE base_audit_intents SET state='signed' WHERE corp_id=$1 AND id=$2")
            .bind(request.corp_id)
            .bind(request.intent_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Read-only gateway authorization view; not an API accepting arbitrary transaction fields.
    pub async fn authorized_base_attempt(
        &self,
        corp: Uuid,
        attempt: Uuid,
    ) -> Result<AuthorizedAttempt> {
        let mut tx = self.pool.begin().await?;
        // One consistent snapshot, without row locks: the separate gateway has SELECT-only access.
        let r = sqlx::query("SELECT a.frozen,h.archive,h.retained_until,i.checkpoint_digest FROM base_audit_attempts a JOIN base_audit_intents i ON i.corp_id=a.corp_id AND i.id=a.intent_id JOIN base_audit_destinations d ON d.corp_id=i.corp_id AND d.id=i.destination_id JOIN base_audit_sender_lanes l ON l.chain_id=d.chain_id AND l.sender=d.sender AND l.active_intent=i.id AND l.active_corp_id=i.corp_id JOIN base_audit_retained_history h ON h.corp_id=i.corp_id AND h.destination_id=d.id AND h.checkpoint_digest=i.checkpoint_digest WHERE a.corp_id=$1 AND a.id=$2 AND d.enabled AND NOT d.restore_required AND NOT l.paused AND i.lease_until>now() AND NOT i.terminal AND i.reservation>0 AND h.retained_until>now()")
            .bind(corp).bind(attempt).fetch_one(&mut *tx).await?;
        let request: SignRequest = serde_json::from_value(r.get("frozen"))?;
        let result = AuthorizedAttempt {
            request,
            archive: serde_json::from_value(r.get("archive"))?,
            retained_until: r.get("retained_until"),
            archive_receipt_digest: B256::from_str(&r.get::<String, _>("checkpoint_digest"))?,
        };
        tx.commit().await?;
        Ok(result)
    }

    /// Every process start disables effects until the independent journal is checked.
    pub async fn begin_base_recovery(&self, corp: Uuid, destination: Uuid) -> Result<()> {
        sqlx::query("UPDATE base_audit_destinations SET restore_required=true,validation=NULL,validation_expires=NULL WHERE corp_id=$1 AND id=$2")
            .bind(corp).bind(destination).execute(&self.pool).await?;
        Ok(())
    }

    /// Called only with a complete authenticated gateway journal snapshot and qualified live RPC evidence.
    /// Missing application attempts are an incident, never permission to start a fresh nonce.
    pub async fn complete_base_validation(
        &self,
        corp: Uuid,
        destination: Uuid,
        validation: BaseValidation<'_>,
    ) -> Result<()> {
        let BaseValidation {
            epoch,
            cursor,
            requests,
            pending_nonce,
            observation,
        } = validation;
        ensure!(
            !epoch.is_empty() && epoch.len() <= 256 && cursor >= 0 && requests.len() <= 100_000,
            "invalid complete gateway journal snapshot"
        );
        let mut tx = self.pool.begin().await?;
        let d = destination_row(
            sqlx::query(
                "SELECT * FROM base_audit_destinations WHERE corp_id=$1 AND id=$2 FOR UPDATE",
            )
            .bind(corp)
            .bind(destination)
            .fetch_one(&mut *tx)
            .await?,
        )?;
        let c = &d.input.config;
        ensure!(
            !matches!(
                d.status.as_str(),
                "finalized_contradiction" | "conflicting_anchor" | "invalid_evidence"
            ),
            "terminal integrity incident requires linked recovery"
        );
        let lane = sqlx::query(
            "SELECT * FROM base_audit_sender_lanes WHERE chain_id=$1 AND sender=$2 FOR UPDATE",
        )
        .bind(i64::try_from(c.chain_id)?)
        .bind(c.publisher.as_slice())
        .fetch_one(&mut *tx)
        .await?;
        ensure!(
            lane.get::<Option<String>, _>("journal_epoch")
                .is_none_or(|old| old == epoch),
            "gateway journal identity changed"
        );
        ensure!(
            cursor >= lane.get::<i64, _>("journal_cursor"),
            "gateway journal rollback detected"
        );
        for request in requests {
            ensure!(
                request.transaction.chain_id == c.chain_id
                    && request.transaction.sender == c.publisher,
                "gateway snapshot is not wallet-scoped"
            );
            let local: Option<Value> = sqlx::query_scalar("SELECT a.frozen FROM base_audit_attempts a JOIN base_audit_destinations d ON d.corp_id=a.corp_id AND d.id=(SELECT destination_id FROM base_audit_intents WHERE id=a.intent_id AND corp_id=a.corp_id) WHERE a.corp_id=$1 AND a.id=$2 AND d.customer_id=$3")
                .bind(request.corp_id).bind(request.attempt_id).bind(d.input.trusted_manifest()?.manifest.customer_trust_id.as_slice())
                .fetch_optional(&mut *tx).await?;
            ensure!(
                local.as_ref() == Some(&serde_json::to_value(request)?),
                "application restored behind signing journal: publication remains paused"
            );
        }
        let saved: Vec<Value> = sqlx::query_scalar("SELECT a.frozen FROM base_audit_attempts a JOIN base_audit_intents i ON i.id=a.intent_id AND i.corp_id=a.corp_id JOIN base_audit_destinations d ON d.id=i.destination_id AND d.corp_id=i.corp_id JOIN base_audit_signed_results s ON s.attempt_id=a.id WHERE d.chain_id=$1 AND d.sender=$2")
            .bind(i64::try_from(c.chain_id)?).bind(c.publisher.as_slice()).fetch_all(&mut *tx).await?;
        for value in saved {
            let request: SignRequest = serde_json::from_value(value)?;
            ensure!(requests.contains(&request), "gateway journal is incomplete");
        }
        let active: Option<Uuid> = lane.get("active_intent");
        if active.is_none() {
            let stored = lane.get::<i64, _>("next_nonce");
            let pristine = lane.get::<Option<String>, _>("journal_epoch").is_none()
                && requests.is_empty()
                && stored == 0;
            ensure!(
                pristine || stored == i64::try_from(pending_nonce)?,
                "unknown nonce consumption while lane idle"
            );
        } else {
            ensure!(
                i64::try_from(pending_nonce)? <= lane.get::<i64, _>("next_nonce"),
                "unknown pending nonce beyond active sender lane"
            );
        }
        sqlx::query("UPDATE base_audit_sender_lanes SET paused=false,journal_epoch=$3,journal_cursor=$4,next_nonce=CASE WHEN active_intent IS NULL THEN $5 ELSE next_nonce END WHERE chain_id=$1 AND sender=$2")
            .bind(i64::try_from(c.chain_id)?).bind(c.publisher.as_slice()).bind(epoch).bind(cursor)
            .bind(i64::try_from(pending_nonce)?).execute(&mut *tx).await?;
        sqlx::query("UPDATE base_audit_destinations SET restore_required=false,validation=$3,validation_expires=now()+interval '5 minutes' WHERE corp_id=$1 AND id=$2")
            .bind(corp).bind(destination).bind(observation).execute(&mut *tx).await?;
        evidence_tx(
            &mut tx,
            corp,
            destination,
            None,
            "validated",
            &Uuid::new_v4().to_string(),
            &json!({"journal_epoch":epoch,"journal_cursor":cursor,"observation":observation}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn record_base_scan(
        &self,
        corp: Uuid,
        destination: Uuid,
        block: &SealedHeader,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT id FROM base_audit_destinations WHERE corp_id=$1 AND id=$2 FOR UPDATE")
            .bind(corp)
            .bind(destination)
            .fetch_one(&mut *tx)
            .await?;
        evidence_tx(
            &mut tx,
            corp,
            destination,
            None,
            "scan",
            &format!("{}:{}", block.number, block.hash),
            &serde_json::to_value(block)?,
        )
        .await?;
        sqlx::query("UPDATE base_audit_destinations SET scan_block=$3,scan_hash=$4 WHERE corp_id=$1 AND id=$2")
            .bind(corp).bind(destination).bind(i64::try_from(block.number)?).bind(block.hash.to_string()).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Adopt every discovered event, including events with no local publication intent.
    /// The observed projection is not itself a claim that private audit evidence is available.
    pub async fn observe_base_event(
        &self,
        corp: Uuid,
        destination: Uuid,
        event: &AnchorEvent,
        receipt: &ReceiptEvidence,
        block: &SealedHeader,
    ) -> Result<String> {
        let mut tx = self.pool.begin().await?;
        let d = destination_row(
            sqlx::query(
                "SELECT * FROM base_audit_destinations WHERE corp_id=$1 AND id=$2 FOR UPDATE",
            )
            .bind(corp)
            .bind(destination)
            .fetch_one(&mut *tx)
            .await?,
        )?;
        ensure!(
            event.call.stream_id == d.input.config.stream_id
                && event.block_number == block.number
                && event.block_hash == block.hash
                && event.transaction_hash == receipt.receipt.transaction_hash,
            "event scope or sealed receipt identity mismatch"
        );
        ensure!(
            receipt.exact_event(
                d.input.config.contract_address,
                &event.call,
                event.publisher
            )? == *event,
            "event and successful receipt differ"
        );
        let identity = format!(
            "{}:{}:{}",
            event.transaction_hash, event.log_index, event.block_hash
        );
        evidence_tx(
            &mut tx,
            corp,
            destination,
            None,
            "observed_event",
            &identity,
            &json!({"event":event,"receipt":receipt,"block":block}),
        )
        .await?;
        let seq = i64::try_from(event.call.sequence)?;
        let digest = hex::encode(event.call.checkpoint_digest);
        if seq <= d.verified_sequence
            && !(seq == d.observed_sequence && d.observed_digest.as_deref() != Some(&digest))
        {
            tx.commit().await?;
            return Ok(d.status);
        }
        let matches_observed = if d.observed_sequence == 0 {
            event.call.previous_anchor_digest.is_zero()
        } else {
            d.observed_digest.as_deref() == Some(&hex::encode(event.call.previous_anchor_digest))
        };
        let matches_verified = if d.verified_sequence == 0 {
            event.call.previous_anchor_digest.is_zero()
        } else {
            d.verified_digest.as_deref() == Some(&hex::encode(event.call.previous_anchor_digest))
        };
        let conflict = (seq > d.observed_sequence && !matches_observed)
            || (seq == d.observed_sequence && d.observed_digest.as_deref() != Some(&digest));
        let checkpoint: Option<Value> = sqlx::query_scalar("SELECT record FROM state_audit_checkpoints WHERE corp_id=$1 AND digest=$2 AND sequence=$3")
            .bind(corp).bind(&digest).bind(seq).fetch_optional(&mut *tx).await?;
        let status = if conflict {
            "conflicting_anchor"
        } else if let Some(record) = checkpoint {
            let checkpoint: crony_audit::SignedCheckpoint = serde_json::from_value(record)?;
            let manifest = &d.input.trusted_manifest()?.manifest;
            let ledger = Uuid::parse_str(&manifest.ledger_id)?;
            let archive = base_prefix_archive(
                Self::load_archive(&mut tx, corp, ledger).await?,
                Some(event.call.sequence),
            )?;
            if manifest.verify_checkpoint(&checkpoint).is_err()
                || verify_base_archive(&d.input, &archive).is_err()
            {
                "invalid_evidence"
            } else if matches_verified {
                "verified_included"
            } else {
                "evidence_unavailable"
            }
        } else {
            "evidence_unavailable"
        };
        sqlx::query("UPDATE base_audit_destinations SET observed_sequence=GREATEST(observed_sequence,$3),observed_digest=CASE WHEN observed_sequence<=$3 THEN $4 ELSE observed_digest END,status=$5,verified_sequence=CASE WHEN $6 THEN $3 ELSE verified_sequence END,verified_digest=CASE WHEN $6 THEN $4 ELSE verified_digest END WHERE corp_id=$1 AND id=$2")
            .bind(corp).bind(destination).bind(seq).bind(&digest).bind(status).bind(status=="verified_included").execute(&mut *tx).await?;
        if matches!(status, "conflicting_anchor" | "invalid_evidence") {
            sqlx::query("UPDATE base_audit_destinations SET enabled=false,restore_required=true WHERE corp_id=$1 AND id=$2")
                .bind(corp).bind(destination).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(status.into())
    }

    pub async fn record_base_inclusion(
        &self,
        claim: &BaseClaim,
        receipt: &ReceiptEvidence,
        block: &SealedHeader,
    ) -> Result<()> {
        ensure!(
            receipt.receipt.block_hash == Some(block.hash)
                && receipt.receipt.block_number == Some(block.number),
            "unsealed or noncanonical receipt"
        );
        let mut tx = self.pool.begin().await?;
        fenced_tx(&mut tx, claim, false).await?;
        let known: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM base_audit_signed_results s JOIN base_audit_attempts a ON a.id=s.attempt_id AND a.corp_id=s.corp_id WHERE a.corp_id=$1 AND a.intent_id=$2 AND s.tx_hash=$3)")
            .bind(claim.intent.corp_id).bind(claim.intent.id).bind(receipt.receipt.transaction_hash.to_string()).fetch_one(&mut *tx).await?;
        ensure!(known, "receipt does not match any durable signed attempt");
        let cost = receipt.cost()?;
        let settled = cost.total_wei.unwrap_or(cost.execution_wei);
        let liability:String=sqlx::query_scalar("SELECT COALESCE(max(liability),0)::text FROM base_audit_attempts WHERE corp_id=$1 AND intent_id=$2")
            .bind(claim.intent.corp_id).bind(claim.intent.id).fetch_one(&mut *tx).await?;
        let reservation = if cost.total_wei.is_some() {
            U256::ZERO
        } else {
            wei(&liability)?.saturating_sub(cost.execution_wei)
        };
        let included_at = DateTime::from_timestamp(i64::try_from(block.timestamp)?, 0)
            .context("inclusion timestamp outside range")?;
        let month: NaiveDate = included_at
            .date_naive()
            .with_day(1)
            .context("invalid UTC inclusion month")?;
        evidence_tx(
            &mut tx,
            claim.intent.corp_id,
            claim.intent.destination_id,
            Some(claim.intent.id),
            "inclusion",
            &format!("{}:{}", receipt.receipt.transaction_hash, block.hash),
            &json!({"receipt":receipt,"block":block,"fees":cost}),
        )
        .await?;
        sqlx::query("UPDATE base_audit_intents SET state='included',settled=$3::numeric,inclusion_month=$4,reservation=$5::numeric,fee_warning=$6 WHERE corp_id=$1 AND id=$2")
            .bind(claim.intent.corp_id).bind(claim.intent.id).bind(settled.to_string()).bind(month)
            .bind(reservation.to_string()).bind(cost.total_wei.is_none()).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Finality attaches to the ORIGINAL anchor event, not a successful no-op replay transaction.
    pub async fn finalize_base_anchor(
        &self,
        claim: &BaseClaim,
        anchor: &FinalizedAnchor,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        fenced_tx(&mut tx, claim, false).await?;
        let d = destination_row(
            sqlx::query("SELECT * FROM base_audit_destinations WHERE corp_id=$1 AND id=$2")
                .bind(claim.intent.corp_id)
                .bind(claim.intent.destination_id)
                .fetch_one(&mut *tx)
                .await?,
        )?;
        ensure!(
            anchor.event.call.stream_id == d.input.config.stream_id
                && anchor.event.call.sequence == u64::try_from(claim.intent.sequence)?
                && hex::encode(anchor.event.call.checkpoint_digest)
                    == claim.intent.checkpoint_digest
                && hex::encode(anchor.event.call.previous_anchor_digest)
                    == claim.intent.previous_digest,
            "finalized event differs from immutable intent"
        );
        ensure!(
            anchor.observations.len() == 2
                && anchor.observations[0].provider_identity
                    != anchor.observations[1].provider_identity,
            "independent finality observations required"
        );
        for observation in &anchor.observations {
            crate::base_ancestry::verify_observation_tx(
                &mut tx,
                claim.intent.corp_id,
                claim.intent.destination_id,
                anchor.receipt.receipt.transaction_hash,
                &anchor.included,
                observation,
            )
            .await?;
        }
        let archived: Value = sqlx::query_scalar("SELECT archive FROM base_audit_retained_history WHERE corp_id=$1 AND destination_id=$2 AND checkpoint_digest=$3 AND retained_until>now()")
            .bind(d.corp_id).bind(d.id).bind(&claim.intent.checkpoint_digest).fetch_one(&mut *tx).await?;
        verify_base_archive(&d.input, &serde_json::from_value(archived)?)?;
        // An adoption before nonce reservation is free. A no-op with a reserved nonce must first
        // have its own canonical cost recorded; an outstanding signed capability is not canceled.
        let r = sqlx::query("SELECT nonce FROM base_audit_intents WHERE corp_id=$1 AND id=$2")
            .bind(d.corp_id)
            .bind(claim.intent.id)
            .fetch_one(&mut *tx)
            .await?;
        let nonce: Option<i64> = r.get("nonce");
        if nonce.is_some() {
            let cost_recorded: bool = sqlx::query_scalar(
                "SELECT settled IS NOT NULL FROM base_audit_intents WHERE corp_id=$1 AND id=$2",
            )
            .bind(d.corp_id)
            .bind(claim.intent.id)
            .fetch_one(&mut *tx)
            .await?;
            ensure!(
                cost_recorded,
                "reserved nonce unresolved; original event alone cannot release signed capability"
            );
            let finalized_spend: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM base_audit_evidence WHERE corp_id=$1 AND destination_id=$2 AND intent_id=$3 AND kind='spend_finalized')")
                .bind(d.corp_id).bind(d.id).bind(claim.intent.id).fetch_one(&mut *tx).await?;
            ensure!(
                finalized_spend,
                "own nonce receipt is not finalized; keep sender lane occupied"
            );
        }
        evidence_tx(
            &mut tx,
            d.corp_id,
            d.id,
            Some(claim.intent.id),
            "finalized",
            &format!(
                "{}:{}:{}",
                anchor.event.transaction_hash, anchor.event.log_index, anchor.event.block_hash
            ),
            &serde_json::to_value(anchor)?,
        )
        .await?;
        sqlx::query("UPDATE base_audit_intents SET state='finalized',terminal=true,lease_until=NULL WHERE corp_id=$1 AND id=$2")
            .bind(d.corp_id).bind(claim.intent.id).execute(&mut *tx).await?;
        sqlx::query("UPDATE base_audit_sender_lanes SET active_intent=NULL,active_corp_id=NULL WHERE chain_id=$1 AND sender=$2 AND active_intent=$3 AND active_corp_id=$4")
            .bind(i64::try_from(d.input.config.chain_id)?).bind(d.input.config.publisher.as_slice())
            .bind(claim.intent.id).bind(d.corp_id).execute(&mut *tx).await?;
        sqlx::query("UPDATE base_audit_destinations SET observed_sequence=GREATEST(observed_sequence,$3),observed_digest=CASE WHEN observed_sequence<=$3 THEN $4 ELSE observed_digest END,verified_sequence=GREATEST(verified_sequence,$3),verified_digest=CASE WHEN verified_sequence<=$3 THEN $4 ELSE verified_digest END,status='provider_observed_finalized' WHERE corp_id=$1 AND id=$2")
            .bind(d.corp_id).bind(d.id).bind(claim.intent.sequence).bind(&claim.intent.checkpoint_digest).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn record_base_reorg(
        &self,
        corp: Uuid,
        destination: Uuid,
        old_block_hash: B256,
        replacement: &SealedHeader,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let d = destination_row(
            sqlx::query(
                "SELECT * FROM base_audit_destinations WHERE corp_id=$1 AND id=$2 FOR UPDATE",
            )
            .bind(corp)
            .bind(destination)
            .fetch_one(&mut *tx)
            .await?,
        )?;
        let finalized: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM base_audit_evidence WHERE corp_id=$1 AND destination_id=$2 AND kind IN ('finalized','spend_finalized') AND (evidence->'event'->>'block_hash'=$3 OR evidence->'block'->>'hash'=$3 OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(evidence->'observations','[]'::jsonb)) o WHERE o->'finalized'->>'hash'=$3)))")
            .bind(corp).bind(destination).bind(old_block_hash.to_string()).fetch_one(&mut *tx).await?;
        let kind = if finalized {
            "finalized_contradiction"
        } else {
            "reorged"
        };
        evidence_tx(
            &mut tx,
            corp,
            destination,
            None,
            kind,
            &format!("{}:{}", old_block_hash, replacement.hash),
            &json!({"old_block_hash":old_block_hash,"replacement":replacement}),
        )
        .await?;
        if finalized {
            sqlx::query("UPDATE base_audit_destinations SET enabled=false,restore_required=true,status=$3,scan_block=NULL,scan_hash=NULL WHERE corp_id=$1 AND id=$2")
                .bind(corp).bind(destination).bind(kind).execute(&mut *tx).await?;
        } else {
            let prefix:Option<Value>=sqlx::query_scalar("SELECT evidence->'event' FROM base_audit_evidence WHERE corp_id=$1 AND destination_id=$2 AND kind='finalized' ORDER BY (evidence->'event'->'call'->>'sequence')::bigint DESC LIMIT 1")
                .bind(corp).bind(destination).fetch_optional(&mut *tx).await?;
            let prefix: Option<AnchorEvent> = prefix.map(serde_json::from_value).transpose()?;
            let sequence = prefix
                .as_ref()
                .map(|e| i64::try_from(e.call.sequence))
                .transpose()?
                .unwrap_or(0);
            let digest = prefix.map(|e| hex::encode(e.call.checkpoint_digest));
            sqlx::query("UPDATE base_audit_destinations SET restore_required=true,status='reorged',scan_block=NULL,scan_hash=NULL,observed_sequence=$3,observed_digest=$4,verified_sequence=$3,verified_digest=$4 WHERE corp_id=$1 AND id=$2")
                .bind(corp).bind(destination).bind(sequence).bind(digest).execute(&mut *tx).await?;
        }
        sqlx::query(
            "UPDATE base_audit_sender_lanes SET paused=true WHERE chain_id=$1 AND sender=$2",
        )
        .bind(i64::try_from(d.input.config.chain_id)?)
        .bind(d.input.config.publisher.as_slice())
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE base_audit_intents i SET reservation=COALESCE((SELECT max(a.liability) FROM base_audit_attempts a WHERE a.corp_id=i.corp_id AND a.intent_id=i.id),i.reservation),settled=NULL,inclusion_month=NULL,state='reorged',fence=fence+1,lease_until=NULL WHERE i.corp_id=$1 AND i.destination_id=$2 AND NOT terminal")
            .bind(corp).bind(destination).execute(&mut *tx).await?;
        crate::base_observations::reset_sweep_tx(&mut tx, corp, destination).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn record_base_spend_finality(
        &self,
        claim: &BaseClaim,
        receipt: &ReceiptEvidence,
        block: &SealedHeader,
        observations: &[crony_base::rpc::FinalityObservation],
    ) -> Result<()> {
        ensure!(
            observations.len() == 2
                && observations[0].provider_identity != observations[1].provider_identity,
            "two independent finality observations required"
        );
        ensure!(
            receipt.receipt.block_hash == Some(block.hash)
                && receipt.receipt.block_number == Some(block.number),
            "receipt block mismatch"
        );
        let mut tx = self.pool.begin().await?;
        fenced_tx(&mut tx, claim, false).await?;
        for o in observations {
            crate::base_ancestry::verify_observation_tx(
                &mut tx,
                claim.intent.corp_id,
                claim.intent.destination_id,
                receipt.receipt.transaction_hash,
                block,
                o,
            )
            .await?;
        }
        let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM base_audit_evidence WHERE corp_id=$1 AND destination_id=$2 AND intent_id=$3 AND kind='inclusion' AND identity=$4)")
            .bind(claim.intent.corp_id).bind(claim.intent.destination_id).bind(claim.intent.id)
            .bind(format!("{}:{}",receipt.receipt.transaction_hash,block.hash)).fetch_one(&mut *tx).await?;
        ensure!(
            exists,
            "own canonical inclusion cost must be recorded before finality"
        );
        evidence_tx(
            &mut tx,
            claim.intent.corp_id,
            claim.intent.destination_id,
            Some(claim.intent.id),
            "spend_finalized",
            &format!("{}:{}", receipt.receipt.transaction_hash, block.hash),
            &json!({"receipt":receipt,"block":block,"observations":observations}),
        )
        .await?;
        if !receipt.receipt.status() {
            sqlx::query("UPDATE base_audit_intents SET terminal=true,state='reverted',lease_until=NULL WHERE corp_id=$1 AND id=$2")
                .bind(claim.intent.corp_id).bind(claim.intent.id).execute(&mut *tx).await?;
            sqlx::query("UPDATE base_audit_sender_lanes SET active_intent=NULL,active_corp_id=NULL WHERE active_corp_id=$1 AND active_intent=$2")
                .bind(claim.intent.corp_id).bind(claim.intent.id).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn base_original_event(
        &self,
        corp: Uuid,
        destination: Uuid,
        call: &AnchorCall,
    ) -> Result<Option<AnchorEvent>> {
        let rows:Vec<Value>=sqlx::query_scalar("SELECT evidence->'event' FROM base_audit_evidence e WHERE corp_id=$1 AND destination_id=$2 AND kind='observed_event' AND evidence->'event'->'call'->>'sequence'=$3 AND NOT EXISTS(SELECT 1 FROM base_audit_evidence r WHERE r.corp_id=e.corp_id AND r.destination_id=e.destination_id AND r.kind='reorged' AND r.evidence->>'old_block_hash'=e.evidence->'event'->>'block_hash') ORDER BY id DESC LIMIT 128")
            .bind(corp).bind(destination).bind(call.sequence.to_string()).fetch_all(&self.pool).await?;
        for row in rows {
            let event: AnchorEvent = serde_json::from_value(row)?;
            if event.call == *call {
                return Ok(Some(event));
            }
        }
        Ok(None)
    }

    pub async fn quarantine_base_wallet(&self, claim: &BaseClaim, reason: &str) -> Result<()> {
        ensure!(
            matches!(
                reason,
                "nonce_conflict" | "unexpected_code" | "invalid_evidence" | "conflicting_anchor"
            ),
            "invalid quarantine reason"
        );
        let mut tx = self.pool.begin().await?;
        fenced_tx(&mut tx, claim, true).await?;
        let d = destination_row(
            sqlx::query("SELECT * FROM base_audit_destinations WHERE corp_id=$1 AND id=$2")
                .bind(claim.intent.corp_id)
                .bind(claim.intent.destination_id)
                .fetch_one(&mut *tx)
                .await?,
        )?;
        sqlx::query(
            "UPDATE base_audit_sender_lanes SET paused=true WHERE chain_id=$1 AND sender=$2",
        )
        .bind(i64::try_from(d.input.config.chain_id)?)
        .bind(d.input.config.publisher.as_slice())
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE base_audit_destinations SET enabled=false,restore_required=true,status=$3 WHERE chain_id=$1 AND sender=$2")
            .bind(i64::try_from(d.input.config.chain_id)?).bind(d.input.config.publisher.as_slice()).bind(reason).execute(&mut *tx).await?;
        evidence_tx(
            &mut tx,
            d.corp_id,
            d.id,
            Some(claim.intent.id),
            reason,
            &Uuid::new_v4().to_string(),
            &json!({"wallet_paused":true}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
}

fn verify_base_archive(input: &BaseDestinationInput, archive: &crony_audit::Archive) -> Result<()> {
    let m = &input.trusted_manifest()?.manifest;
    ensure!(
        archive.ledger_id == m.ledger_id,
        "retained archive belongs to another ledger"
    );
    let mut history = crony_audit::HistoryVerifier::new(&m.ledger_id);
    let mut checkpoints = archive.checkpoints.iter().peekable();
    for row in &archive.rows {
        history.push(row)?;
        if checkpoints
            .peek()
            .is_some_and(|c| c.checkpoint.last_sequence == history.sequence())
        {
            let c = checkpoints.next().context("missing checkpoint")?;
            m.verify_checkpoint(c)?;
            let key = m
                .checkpoint_keys
                .iter()
                .find(|k| k.key_id == c.checkpoint.key_id)
                .context("untrusted checkpoint key")?;
            history.checkpoint(c, &crony_audit::VerifyingKey::from_bytes(&key.public_key)?)?;
        }
    }
    ensure!(
        checkpoints.next().is_none() && history.refs() == &archive.refs,
        "incomplete retained ledger evidence"
    );
    history.finish(archive.checkpoints.last().map(|c| c.digest.as_str()))?;
    Ok(())
}

fn base_pinned_archive(
    archive: crony_audit::Archive,
    digest: Option<&str>,
) -> Result<crony_audit::Archive> {
    let sequence = digest
        .map(|digest| {
            archive
                .checkpoints
                .iter()
                .find(|checkpoint| checkpoint.digest == digest)
                .map(|checkpoint| checkpoint.checkpoint.last_sequence)
                .context("signed recovery checkpoint is not retained")
        })
        .transpose()?;
    base_prefix_archive(archive, sequence)
}

fn base_prefix_archive(
    mut archive: crony_audit::Archive,
    sequence: Option<u64>,
) -> Result<crony_audit::Archive> {
    let Some(sequence) = sequence.or_else(|| {
        archive
            .checkpoints
            .last()
            .map(|c| c.checkpoint.last_sequence)
    }) else {
        return Ok(archive);
    };
    archive.rows.retain(|r| r.decision.sequence <= sequence);
    archive
        .checkpoints
        .retain(|c| c.checkpoint.last_sequence <= sequence);
    let mut history = crony_audit::HistoryVerifier::new(&archive.ledger_id);
    for row in &archive.rows {
        history.push(row)?;
    }
    archive.refs = history.refs().clone();
    Ok(archive)
}
