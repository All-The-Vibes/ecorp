//! Opt-in atomic mission governance history.
use super::*;
use anyhow::ensure;
use chrono::{Datelike, TimeZone};
use crony_audit::{Change, Decision, DecisionBundle, Object, Version, canonical, digest};
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};

const EVALUATOR: &str = "native-mission-governance-v1";

/// A failed database read is not evidence that a retained witness diverged.
/// These diagnostics intentionally omit database details and audit contents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditWitnessError {
    Unavailable,
    Diverged,
}

impl std::fmt::Display for AuditWitnessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unavailable => {
                "audit witness verification unavailable; publication remains pending"
            }
            Self::Diverged => "audit witness diverged; explicit witness reconciliation required",
        })
    }
}
impl std::error::Error for AuditWitnessError {}

#[derive(Clone, Copy)]
pub enum AuditPublicationRetry {
    WitnessUnavailable,
    AttemptTimedOut,
    TransportUnavailable,
}

#[derive(Debug)]
pub(crate) struct NativePolicyRefusal(pub String);
impl std::fmt::Display for NativePolicyRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for NativePolicyRefusal {}

#[derive(Debug)]
struct AuditedPolicyRefusal {
    receipt: AuditReceipt,
    message: String,
}
impl std::fmt::Display for AuditedPolicyRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}; audit refusal receipt {}:{}:{}",
            self.message, self.receipt.ledger_id, self.receipt.sequence, self.receipt.row_hash
        )
    }
}
impl std::error::Error for AuditedPolicyRefusal {}
macro_rules! native_policy {
    ($($message:tt)*) => {anyhow::Error::new($crate::state_audit::NativePolicyRefusal(format!($($message)*)))};
}
pub(crate) use native_policy;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditDestination {
    pub id: Uuid,
    pub corp_id: Uuid,
    pub kind: String,
    pub interval_seconds: i64,
    #[serde(default)]
    pub calendar_schedule: Option<AuditCalendarSchedule>,
    #[serde(default = "default_overdue_after_seconds")]
    pub overdue_after_seconds: i64,
    #[serde(default = "default_workflow_gate")]
    pub workflow_gate: String,
    pub config: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditCalendarSchedule {
    pub day_of_month: u32,
    pub hour_utc: u32,
    pub minute_utc: u32,
}

const fn default_overdue_after_seconds() -> i64 {
    86_400
}

fn default_workflow_gate() -> String {
    "none".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GitHubDestination {
    pub repository: String,
    pub branch: String,
    pub path: String,
}

pub struct AuditReconciliation<'a> {
    pub ledger_id: Uuid,
    pub checkpoint_digest: &'a str,
    pub github_commit: &'a str,
}

impl AuditDestination {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.id.is_nil()
                && (60..=315_360_000).contains(&self.interval_seconds)
                && (60..=630_720_000).contains(&self.overdue_after_seconds),
            "invalid audit destination interval/identity"
        );
        ensure!(
            matches!(
                self.workflow_gate.as_str(),
                "none" | "published" | "finalized"
            ),
            "invalid audit workflow gate"
        );
        if let Some(calendar) = &self.calendar_schedule {
            ensure!(
                (1..=28).contains(&calendar.day_of_month)
                    && calendar.hour_utc < 24
                    && calendar.minute_utc < 60,
                "invalid monthly UTC audit schedule"
            );
        }
        match self.kind.as_str() {
            "github" => {
                ensure!(
                    self.workflow_gate != "finalized",
                    "GitHub destinations cannot satisfy a finality gate"
                );
                let config: GitHubDestination = serde_json::from_value(self.config.clone())?;
                crony_audit::validate_destination(
                    &config.repository,
                    &config.branch,
                    &config.path,
                )?;
                ensure!(config.path.len() <= 128, "audit root exceeds bound");
            }
            // A disabled V2 placeholder, not an executable onchain destination.
            "ethereum" => ensure!(
                self.config.as_object().is_some_and(|m| m.len() == 2
                    && m.get("chain_id").is_some_and(Value::is_u64)
                    && m.get("contract")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty() && s.len() <= 128)),
                "invalid future ETH destination"
            ),
            _ => anyhow::bail!("unsupported audit destination"),
        }
        Ok(())
    }

    fn next_due_after(&self, now: chrono::DateTime<Utc>) -> Result<chrono::DateTime<Utc>> {
        let Some(calendar) = &self.calendar_schedule else {
            return Ok(now + chrono::Duration::seconds(self.interval_seconds));
        };
        let mut year = now.year();
        let mut month = now.month();
        let candidate = Utc
            .with_ymd_and_hms(
                year,
                month,
                calendar.day_of_month,
                calendar.hour_utc,
                calendar.minute_utc,
                0,
            )
            .single()
            .context("invalid monthly UTC audit schedule")?;
        if candidate > now {
            return Ok(candidate);
        }
        if month == 12 {
            year += 1;
            month = 1;
        } else {
            month += 1;
        }
        Utc.with_ymd_and_hms(
            year,
            month,
            calendar.day_of_month,
            calendar.hour_utc,
            calendar.minute_utc,
            0,
        )
        .single()
        .context("invalid next monthly UTC audit schedule")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuditReceipt {
    pub ledger_id: Uuid,
    pub sequence: u64,
    pub row_hash: String,
    pub decision: String,
    pub reason_code: String,
    pub resource_results: Vec<Change>,
}

pub(crate) struct Operation {
    pub corp: Uuid,
    pub actor: Uuid,
    pub mission: Uuid,
    pub request_id: Uuid,
    pub name: &'static str,
    pub request: Value,
}

pub(crate) struct FactoryAuditIdentity {
    pub raw_request_id: Uuid,
    pub canonical_key: String,
    pub work_item_id: Uuid,
    pub claim_token: Uuid,
}

pub(crate) trait AuditOutcome: Serialize + serde::de::DeserializeOwned {
    fn replay(self) -> Self;
    fn was_replayed(&self) -> bool;
    fn requires_native_replay_validation() -> bool {
        false
    }
}
impl AuditOutcome for MissionContractRevisionOutcome {
    fn replay(mut self) -> Self {
        self.event = None;
        self.replayed = true;
        self
    }
    fn was_replayed(&self) -> bool {
        self.replayed
    }
}
impl AuditOutcome for MissionBudgetRevisionOutcome {
    fn replay(mut self) -> Self {
        self.event = None;
        self.replayed = true;
        self
    }
    fn was_replayed(&self) -> bool {
        self.replayed
    }
}
impl AuditOutcome for FactoryWorkItemOutcome {
    fn replay(mut self) -> Self {
        self.event = None;
        self.replayed = true;
        self
    }
    fn was_replayed(&self) -> bool {
        self.replayed
    }
    fn requires_native_replay_validation() -> bool {
        true
    }
}

impl PgStore {
    pub async fn disable_audit_destination_for_divergence(&self, destination: Uuid) -> Result<()> {
        let changed = sqlx::query(
            "UPDATE state_audit_destinations SET publication_disabled=true,reconciliation_error='retained_witness_divergence',last_error='retained_witness_divergence',failures=failures+1,last_attempted_publication=now() WHERE id=$1",
        )
        .bind(destination)
        .execute(&self.pool)
        .await?
        .rows_affected();
        ensure!(changed == 1, "audit destination not found");
        Ok(())
    }

    pub async fn reconcile_audit_destination(
        &self,
        corp: Uuid,
        actor: Uuid,
        destination: Uuid,
        witness: AuditReconciliation<'_>,
        transport: &impl crony_audit::PublicationTransport,
        key: &crony_audit::VerifyingKey,
    ) -> Result<()> {
        crony_audit::validate_github_commit(witness.github_commit)?;
        let current_head = transport.head().await?;
        ensure!(
            transport
                .descends_from(witness.github_commit, &current_head)
                .await?,
            "GitHub audit branch no longer descends from the retained commit"
        );
        let mut tx = self.pool.begin().await?;
        super::budget_revision::ensure_budget_manager_tx(&mut tx, corp, actor).await?;
        let missions = sqlx::query_scalar::<_, Uuid>(
            "SELECT mission_id FROM state_audit_coverage WHERE corp_id=$1 ORDER BY mission_id",
        )
        .bind(corp)
        .fetch_all(&mut *tx)
        .await?;
        for mission in missions {
            authorize(&mut tx, corp, actor, mission, "destination").await?;
        }
        // Match configuration's ledger-before-destination lock order.
        ensure!(
            lock_ledger(&mut tx, corp).await? == Some(witness.ledger_id),
            "retained witness ledger identity missing or changed"
        );
        let destination_corp: Uuid = sqlx::query_scalar(
            "SELECT corp_id FROM state_audit_destinations WHERE id=$1 AND corp_id=$2 FOR UPDATE",
        )
        .bind(destination)
        .bind(corp)
        .fetch_optional(&mut *tx)
        .await?
        .context("audit destination not found in Corp")?;
        ensure!(destination_corp == corp, "foreign Corp destination");
        let archive = Self::load_archive(&mut tx, corp, witness.ledger_id).await?;
        if archive.signing_keys.is_empty() {
            archive.verify_history(key)?;
        } else {
            let active = archive
                .signing_keys
                .last()
                .context("missing active signing key")?;
            ensure!(
                active.retired_sequence.is_none() && active.verifying_key()? == *key,
                "configured signer does not match retained signing-key history"
            );
            archive.verify_history_with_key_history(&archive.signing_keys)?;
        }
        ensure!(
            archive
                .checkpoints
                .iter()
                .any(|checkpoint| checkpoint.digest == witness.checkpoint_digest),
            "retained checkpoint missing from restored history"
        );
        sqlx::query("UPDATE state_audit_destinations SET publication_disabled=false,reconciliation_error=NULL,last_error=NULL,last_commit=$2,next_due=now(),scheduled_due=now() WHERE id=$1")
            .bind(destination).bind(witness.github_commit).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn audit_github_destination_config(
        &self,
        corp: Uuid,
        destination: Uuid,
    ) -> Result<GitHubDestination> {
        let config: Value = sqlx::query_scalar(
            "SELECT config FROM state_audit_destinations WHERE id=$1 AND corp_id=$2 AND kind='github'",
        )
        .bind(destination)
        .bind(corp)
        .fetch_optional(&self.pool)
        .await?
        .context("GitHub audit destination not found in Corp")?;
        Ok(serde_json::from_value(config)?)
    }

    pub async fn validate_audit_witness(
        &self,
        corp: Uuid,
        ledger: Uuid,
        expected: &str,
        key: &crony_audit::VerifyingKey,
    ) -> std::result::Result<(), AuditWitnessError> {
        self.validate_audit_witness_inner(corp, ledger, expected, key)
            .await
            .map_err(|error| {
                if error.chain().any(|cause| cause.is::<sqlx::Error>()) {
                    AuditWitnessError::Unavailable
                } else {
                    AuditWitnessError::Diverged
                }
            })
    }

    async fn validate_audit_witness_inner(
        &self,
        corp: Uuid,
        ledger: Uuid,
        expected: &str,
        key: &crony_audit::VerifyingKey,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        ensure!(
            lock_ledger(&mut tx, corp).await? == Some(ledger),
            "retained witness ledger identity missing or changed"
        );
        let archive = Self::load_archive(&mut tx, corp, ledger).await?;
        if archive.signing_keys.is_empty() {
            archive.verify_history(key)?;
        } else {
            let active = archive
                .signing_keys
                .last()
                .context("missing active signing key")?;
            ensure!(
                active.retired_sequence.is_none() && active.verifying_key()? == *key,
                "configured signer does not match retained signing-key history"
            );
            archive.verify_history_with_key_history(&archive.signing_keys)?;
        }
        ensure!(
            archive.checkpoints.iter().any(|c| c.digest == expected),
            "retained checkpoint missing from restored history"
        );
        tx.commit().await?;
        Ok(())
    }

    pub async fn request_audit_publication(
        &self,
        corp: Uuid,
        actor: Uuid,
        destination: Uuid,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        super::budget_revision::ensure_budget_manager_tx(&mut tx, corp, actor).await?;
        let missions = sqlx::query_scalar::<_, Uuid>(
            "SELECT mission_id FROM state_audit_coverage WHERE corp_id=$1",
        )
        .bind(corp)
        .fetch_all(&mut *tx)
        .await?;
        for mission in missions {
            authorize(&mut tx, corp, actor, mission, "publish").await?;
        }
        let changed=sqlx::query("UPDATE state_audit_destinations SET next_due=now(),scheduled_due=LEAST(scheduled_due,now()) WHERE id=$1 AND corp_id=$2 AND kind='github'")
            .bind(destination).bind(corp).execute(&mut *tx).await?.rows_affected();
        ensure!(
            changed == 1,
            "executable audit destination not found in Corp"
        );
        tx.commit().await?;
        Ok(())
    }
    pub async fn audit_ledgers_needing_checkpoint(&self, after: Option<Uuid>) -> Result<Vec<Uuid>> {
        Ok(sqlx::query_scalar("SELECT l.corp_id FROM state_audit_ledgers l WHERE ($1::uuid IS NULL OR l.corp_id>$1) AND l.last_sequence>COALESCE((SELECT max(sequence) FROM state_audit_checkpoints c WHERE c.corp_id=l.corp_id),0) ORDER BY l.corp_id LIMIT 16").bind(after).fetch_all(&self.pool).await?)
    }

    pub async fn defer_audit_publication(
        &self,
        destination: Uuid,
        reason: AuditPublicationRetry,
    ) -> Result<()> {
        let code = match reason {
            AuditPublicationRetry::WitnessUnavailable => "witness_unavailable",
            AuditPublicationRetry::AttemptTimedOut => "publication_attempt_timed_out",
            AuditPublicationRetry::TransportUnavailable => "publication_transport_unavailable",
        };
        // A racing successful publication or established divergence wins over
        // this best-effort retry marker. Never reopen a disabled destination.
        sqlx::query("UPDATE state_audit_destinations SET failures=failures+1,last_error=$2,last_attempted_publication=now(),next_due=now()+interval '60 seconds' WHERE id=$1 AND publication_disabled=false AND next_due<=now()")
            .bind(destination).bind(code).execute(&self.pool).await?;
        Ok(())
    }
    pub async fn configure_audit_destination(
        &self,
        actor: Uuid,
        d: &AuditDestination,
    ) -> Result<()> {
        d.validate()?;
        let mut tx = self.pool.begin().await?;
        super::budget_revision::ensure_budget_manager_tx(&mut tx, d.corp_id, actor).await?;
        lock_ledger(&mut tx, d.corp_id)
            .await?
            .context("initialize ledger before destination")?;
        let missions = sqlx::query_scalar::<_, Uuid>(
            "SELECT mission_id FROM state_audit_coverage WHERE corp_id=$1",
        )
        .bind(d.corp_id)
        .fetch_all(&mut *tx)
        .await?;
        for mission in missions {
            authorize(&mut tx, d.corp_id, actor, mission, "destination").await?;
        }
        let calendar_schedule = d
            .calendar_schedule
            .as_ref()
            .map(serde_json::to_value)
            .transpose()?;
        let configured_next_due = if d.calendar_schedule.is_some() {
            d.next_due_after(Utc::now())?
        } else {
            Utc::now()
        };
        sqlx::query("INSERT INTO state_audit_destinations(id,corp_id,kind,config,interval_seconds,calendar_schedule,overdue_after_seconds,workflow_gate,next_due,scheduled_due) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT(id) DO NOTHING")
            .bind(d.id).bind(d.corp_id).bind(&d.kind).bind(&d.config).bind(d.interval_seconds)
            .bind(&calendar_schedule).bind(d.overdue_after_seconds).bind(&d.workflow_gate)
            .bind(configured_next_due).execute(&mut *tx).await?;
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM state_audit_destinations WHERE corp_id=$1")
                .bind(d.corp_id)
                .fetch_one(&mut *tx)
                .await?;
        ensure!(count <= 64, "Corp audit destination bound exceeded");
        let prior = sqlx::query(
            "SELECT corp_id,kind,config FROM state_audit_destinations WHERE id=$1 FOR UPDATE",
        )
        .bind(d.id)
        .fetch_one(&mut *tx)
        .await?;
        ensure!(
            prior.get::<Uuid, _>("corp_id") == d.corp_id
                && prior.get::<String, _>("kind") == d.kind
                && prior.get::<Value, _>("config") == d.config,
            "destination identities/configuration are immutable; create a new destination"
        );
        sqlx::query("UPDATE state_audit_destinations SET interval_seconds=$2,calendar_schedule=$3,overdue_after_seconds=$4,workflow_gate=$5,next_due=LEAST(next_due,$6),scheduled_due=LEAST(scheduled_due,$6) WHERE id=$1")
            .bind(d.id)
            .bind(d.interval_seconds)
            .bind(calendar_schedule)
            .bind(d.overdue_after_seconds)
            .bind(&d.workflow_gate)
            .bind(d.next_due_after(Utc::now())?)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO state_audit_anchor_receipts(corp_id,destination_id,checkpoint_digest,status) SELECT corp_id,$2,digest,'pending' FROM state_audit_checkpoints WHERE corp_id=$1 ON CONFLICT DO NOTHING")
            .bind(d.corp_id).bind(d.id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn due_audit_destinations(&self) -> Result<Vec<AuditDestination>> {
        let rows=sqlx::query("SELECT id,corp_id,kind,config,interval_seconds,calendar_schedule,overdue_after_seconds,workflow_gate FROM state_audit_destinations WHERE kind='github' AND publication_disabled=false AND next_due<=now() ORDER BY next_due,id LIMIT 16").fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|r| -> Result<AuditDestination> {
                Ok(AuditDestination {
                    id: r.get("id"),
                    corp_id: r.get("corp_id"),
                    kind: r.get("kind"),
                    config: r.get("config"),
                    interval_seconds: r.get("interval_seconds"),
                    calendar_schedule: r
                        .get::<Option<Value>, _>("calendar_schedule")
                        .map(serde_json::from_value)
                        .transpose()?,
                    overdue_after_seconds: r.get("overdue_after_seconds"),
                    workflow_gate: r.get("workflow_gate"),
                })
            })
            .collect::<Result<Vec<_>>>()
    }

    pub async fn audit_workflow_gate_satisfied(
        &self,
        corp: Uuid,
        destination: Uuid,
        required_sequence: u64,
    ) -> Result<bool> {
        ensure!(
            required_sequence > 0,
            "required audit sequence must be positive"
        );
        let row = sqlx::query(
            "SELECT workflow_gate,last_published_sequence,last_finalized_sequence,publication_disabled FROM state_audit_destinations WHERE id=$1 AND corp_id=$2",
        )
        .bind(destination)
        .bind(corp)
        .fetch_optional(&self.pool)
        .await?
        .context("audit destination not found in Corp")?;
        if row.get::<bool, _>("publication_disabled") {
            return Ok(false);
        }
        let required = i64::try_from(required_sequence)?;
        Ok(match row.get::<String, _>("workflow_gate").as_str() {
            "none" => true,
            "published" => row
                .get::<Option<i64>, _>("last_published_sequence")
                .is_some_and(|sequence| sequence >= required),
            "finalized" => row
                .get::<Option<i64>, _>("last_finalized_sequence")
                .is_some_and(|sequence| sequence >= required),
            _ => anyhow::bail!("invalid stored audit workflow gate"),
        })
    }

    pub(crate) async fn ensure_audit_workflow_gates_tx(
        tx: &mut Transaction<'_, Postgres>,
        corp: Uuid,
    ) -> Result<()> {
        let Some(required_sequence) = sqlx::query_scalar::<_, i64>(
            "SELECT last_sequence FROM state_audit_ledgers WHERE corp_id=$1 FOR SHARE",
        )
        .bind(corp)
        .fetch_optional(&mut **tx)
        .await?
        else {
            return Ok(());
        };
        let blocked: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM state_audit_destinations
                WHERE corp_id=$1
                  AND workflow_gate<>'none'
                  AND (
                    publication_disabled
                    OR CASE workflow_gate
                        WHEN 'published' THEN COALESCE(last_published_sequence,0)
                        WHEN 'finalized' THEN COALESCE(last_finalized_sequence,0)
                        ELSE 0
                    END < $2
                  )
            )
            "#,
        )
        .bind(corp)
        .bind(required_sequence)
        .fetch_one(&mut **tx)
        .await?;
        ensure!(
            !blocked,
            "audit assurance workflow gate has not reached the latest committed sequence"
        );
        Ok(())
    }

    pub async fn audit_status(&self, corp: Uuid, actor: Uuid) -> Result<Value> {
        let mut tx = self.pool.begin().await?;
        super::budget_revision::ensure_budget_manager_tx(&mut tx, corp, actor).await?;
        let missions = sqlx::query_scalar::<_, Uuid>(
            "SELECT mission_id FROM state_audit_coverage WHERE corp_id=$1",
        )
        .bind(corp)
        .fetch_all(&mut *tx)
        .await?;
        for mission in missions {
            authorize(&mut tx, corp, actor, mission, "status").await?;
        }
        let ledger: Option<Value> =
            sqlx::query_scalar("SELECT to_jsonb(l) FROM state_audit_ledgers l WHERE corp_id=$1")
                .bind(corp)
                .fetch_optional(&mut *tx)
                .await?;
        let destinations:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(d) FROM state_audit_destinations d WHERE corp_id=$1 ORDER BY id LIMIT 65").bind(corp).fetch_all(&mut *tx).await?;
        ensure!(
            destinations.len() <= 64,
            "destination status bound exceeded"
        );
        let receipts:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(r) FROM state_audit_anchor_receipts r WHERE corp_id=$1 ORDER BY updated_at DESC,destination_id LIMIT 100").bind(corp).fetch_all(&mut *tx).await?;
        let assurance: Value = sqlx::query_scalar(
            r#"
            SELECT jsonb_build_object(
                'latest_committed_sequence', l.last_sequence,
                'latest_github_published_sequence', COALESCE((
                    SELECT max(c.sequence)
                    FROM state_audit_destinations d
                    JOIN state_audit_anchor_receipts r ON r.destination_id=d.id
                    JOIN state_audit_checkpoints c
                      ON c.corp_id=r.corp_id AND c.digest=r.checkpoint_digest
                    WHERE d.corp_id=l.corp_id AND d.kind='github' AND r.status='published'
                ),0),
                'latest_ethereum_finalized_sequence', COALESCE((
                    SELECT max(c.sequence)
                    FROM state_audit_destinations d
                    JOIN state_audit_anchor_receipts r ON r.destination_id=d.id
                    JOIN state_audit_checkpoints c
                      ON c.corp_id=r.corp_id AND c.digest=r.checkpoint_digest
                    WHERE d.corp_id=l.corp_id AND d.kind='ethereum' AND r.status='finalized'
                ),0),
                'last_successful_publication', (
                    SELECT max(d.last_successful_publication)
                    FROM state_audit_destinations d WHERE d.corp_id=l.corp_id
                ),
                'next_scheduled_publication', (
                    SELECT min(d.scheduled_due) FROM state_audit_destinations d
                    WHERE d.corp_id=l.corp_id AND d.publication_disabled=false
                ),
                'publication_errors', (
                    SELECT count(*) FROM state_audit_destinations d
                    WHERE d.corp_id=l.corp_id AND d.last_error IS NOT NULL
                ),
                'overdue_destinations', (
                    SELECT count(*) FROM state_audit_destinations d
                    WHERE d.corp_id=l.corp_id AND d.publication_disabled=false
                      AND now() > d.scheduled_due + d.overdue_after_seconds * interval '1 second'
                ),
                'publication_disabled_destinations', (
                    SELECT count(*) FROM state_audit_destinations d
                    WHERE d.corp_id=l.corp_id AND d.publication_disabled=true
                )
            )
            FROM state_audit_ledgers l
            WHERE l.corp_id=$1
            "#,
        )
        .bind(corp)
        .fetch_optional(&mut *tx)
        .await?
        .unwrap_or_else(|| {
            json!({
                "latest_committed_sequence":0,
                "latest_github_published_sequence":0,
                "latest_ethereum_finalized_sequence":0,
                "last_successful_publication":null,
                "next_scheduled_publication":null,
                "publication_errors":0,
                "overdue_destinations":0,
                "publication_disabled_destinations":0
            })
        });
        tx.commit().await?;
        Ok(
            json!({"ledger":ledger,"assurance":assurance,"destinations":destinations,"receipts":receipts,"receipt_limit":100,"publication_is_independent_verification":false,"ethereum_enabled":false}),
        )
    }

    pub async fn publish_audit_destination<T: crony_audit::PublicationTransport>(
        &self,
        destination: Uuid,
        transport: &T,
        key: &crony_audit::VerifyingKey,
        retained_commit: Option<&str>,
    ) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        // Serialize destination updates without blocking the key-share locks
        // taken by a new checkpoint's outbox foreign keys. Publication never
        // changes the destination identity or holds the governed ledger head.
        let Some(d)=sqlx::query("SELECT corp_id,config,last_commit,last_checkpoint_digest,interval_seconds,calendar_schedule,overdue_after_seconds,workflow_gate FROM state_audit_destinations WHERE id=$1 AND kind='github' AND publication_disabled=false AND next_due<=now() FOR NO KEY UPDATE SKIP LOCKED").bind(destination).fetch_optional(&mut *tx).await? else {tx.commit().await?;return Ok(false)};
        let corp: Uuid = d.get("corp_id");
        let config: GitHubDestination = serde_json::from_value(d.get("config"))?;
        let schedule = AuditDestination {
            id: destination,
            corp_id: corp,
            kind: "github".into(),
            interval_seconds: d.get("interval_seconds"),
            calendar_schedule: d
                .get::<Option<Value>, _>("calendar_schedule")
                .map(serde_json::from_value)
                .transpose()?,
            overdue_after_seconds: d.get("overdue_after_seconds"),
            workflow_gate: d.get("workflow_gate"),
            config: serde_json::to_value(&config)?,
        };
        let Some(record) = sqlx::query_scalar::<_, Value>(
            "SELECT record FROM state_audit_checkpoints WHERE corp_id=$1 ORDER BY sequence DESC LIMIT 1",
        )
        .bind(corp)
        .fetch_optional(&mut *tx)
        .await?
        else {
            // Leave room in the bounded discovery page for other Corps. This
            // is only a retry delay: retain scheduled_due so overdue assurance
            // stays visible, without claiming a failed or attempted publication.
            sqlx::query("UPDATE state_audit_destinations SET next_due=now()+interval '60 seconds' WHERE id=$1 AND corp_id=$2")
                .bind(destination).bind(corp).execute(&mut *tx).await?;
            tx.commit().await?;
            return Ok(false);
        };
        let checkpoint: crony_audit::SignedCheckpoint = serde_json::from_value(record)?;
        let ledger_sequence: i64 =
            sqlx::query_scalar("SELECT last_sequence FROM state_audit_ledgers WHERE corp_id=$1")
                .bind(corp)
                .fetch_one(&mut *tx)
                .await?;
        if i64::try_from(checkpoint.checkpoint.last_sequence)? != ledger_sequence {
            sqlx::query("UPDATE state_audit_destinations SET failures=failures+1,last_error='covering_checkpoint_pending',last_attempted_publication=now(),next_due=now()+interval '60 seconds' WHERE id=$1")
                .bind(destination).execute(&mut *tx).await?;
            tx.commit().await?;
            anyhow::bail!("latest audit checkpoint does not cover the committed ledger head");
        }
        let key_record = sqlx::query(
            "SELECT public_key,activated_sequence,retired_sequence FROM state_audit_signing_keys WHERE corp_id=$1 AND key_id=$2",
        )
        .bind(corp)
        .bind(&checkpoint.checkpoint.key_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(key_record) = key_record {
            let public: [u8; 32] = key_record
                .get::<Vec<u8>, _>("public_key")
                .try_into()
                .map_err(|_| anyhow!("stored audit public key is malformed"))?;
            let checkpoint_key = crony_audit::VerifyingKey::from_bytes(&public)?;
            let sequence = i64::try_from(checkpoint.checkpoint.last_sequence)?;
            ensure!(
                sequence >= key_record.get::<i64, _>("activated_sequence")
                    && key_record
                        .get::<Option<i64>, _>("retired_sequence")
                        .is_none_or(|retired| sequence <= retired),
                "checkpoint lies outside stored signing-key activation range"
            );
            checkpoint.verify(&checkpoint_key, None)?;
        } else {
            let has_key_history: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM state_audit_signing_keys WHERE corp_id=$1)",
            )
            .bind(corp)
            .fetch_one(&mut *tx)
            .await?;
            ensure!(
                !has_key_history,
                "checkpoint signing key is missing from retained key history"
            );
            // Only pre-history ledgers may rely on the configured runtime key.
            // A partial retained history must never be repaired by that fallback.
            checkpoint.verify(key, None)?;
        }
        let previous: Option<String> = d.get("last_commit");
        let result = crony_audit::publish_checkpoint(
            transport,
            &config.path,
            &checkpoint,
            previous.as_deref(),
            retained_commit,
        )
        .await;
        match result {
            Ok(commit) => {
                sqlx::query("UPDATE state_audit_anchor_receipts r SET status='superseded',witness=$3,updated_at=now() FROM state_audit_checkpoints c WHERE r.destination_id=$1 AND r.status='pending' AND c.corp_id=r.corp_id AND c.digest=r.checkpoint_digest AND c.sequence<$2")
                    .bind(destination).bind(i64::try_from(checkpoint.checkpoint.last_sequence)?).bind(json!({"covered_by":checkpoint.digest})).execute(&mut *tx).await?;
                sqlx::query("UPDATE state_audit_anchor_receipts SET status='published',witness=$3,updated_at=now() WHERE destination_id=$1 AND checkpoint_digest=$2 AND status<>'published'")
                    .bind(destination).bind(&checkpoint.digest).bind(json!({"provider":"github","repository":config.repository,"branch":config.branch,"path":config.path,"commit":commit,"previous_destination_checkpoint":d.get::<Option<String>,_>("last_checkpoint_digest"),"independently_verified":false,"finalized":false})).execute(&mut *tx).await?;
                sqlx::query("UPDATE state_audit_destinations SET last_commit=$2,last_checkpoint_digest=$3,last_published_sequence=$4,last_attempted_publication=now(),last_successful_publication=now(),next_due=$5,scheduled_due=$5,failures=0,last_error=NULL,reconciliation_error=NULL WHERE id=$1")
                    .bind(destination).bind(commit).bind(&checkpoint.digest)
                    .bind(i64::try_from(checkpoint.checkpoint.last_sequence)?)
                    .bind(schedule.next_due_after(Utc::now())?).execute(&mut *tx).await?;
                tx.commit().await?;
                Ok(true)
            }
            Err(error) => {
                let message = error.to_string();
                let divergence = message.contains("history rewrite")
                    || message.contains("GitHub branch changed ancestry")
                    || message.contains("conflicting checkpoint")
                    || message.contains("conflicting existing checkpoint");
                sqlx::query("UPDATE state_audit_destinations SET failures=failures+1,last_error=$2,last_attempted_publication=now(),next_due=now()+interval '60 seconds',publication_disabled=$3,reconciliation_error=CASE WHEN $3 THEN $2 ELSE reconciliation_error END WHERE id=$1")
                    .bind(destination).bind(if divergence {"external_history_divergence"} else {"publication_failed"}).bind(divergence).execute(&mut *tx).await?;
                tx.commit().await?;
                Err(error.context("audit publication pending durable retry"))
            }
        }
    }

    /// Server-side only: keys are supplied by the trusted service, never runners.
    pub async fn audit_checkpoint(
        &self,
        corp: Uuid,
        key_id: &str,
        key: &crony_audit::SigningKey,
    ) -> Result<crony_audit::SignedCheckpoint> {
        let mut tx = self.pool.begin().await?;
        let ledger = lock_ledger(&mut tx, corp)
            .await?
            .context("audit ledger not initialized")?;
        let mut archive = Self::load_archive(&mut tx, corp, ledger).await?;
        if archive.signing_keys.is_empty() && !archive.checkpoints.is_empty() {
            archive.verify_history(&key.verifying_key())?;
            ensure!(
                archive
                    .checkpoints
                    .iter()
                    .all(|checkpoint| checkpoint.checkpoint.key_id == key_id),
                "legacy checkpoints require their original trusted key id"
            );
            let activation_sequence = archive
                .checkpoints
                .first()
                .expect("nonempty checkpoints")
                .checkpoint
                .last_sequence;
            sqlx::query("INSERT INTO state_audit_signing_keys(corp_id,key_id,public_key,activated_sequence) VALUES($1,$2,$3,$4)")
                .bind(corp).bind(key_id).bind(key.verifying_key().as_bytes())
                .bind(i64::try_from(activation_sequence)?).execute(&mut *tx).await?;
            archive.signing_keys = Self::load_signing_keys(&mut tx, corp).await?;
        }
        let verified = if archive.signing_keys.is_empty() {
            archive.verify_history(&key.verifying_key())?
        } else {
            archive.verify_history_with_key_history(&archive.signing_keys)?
        };
        let covered = sqlx::query_scalar::<_, Uuid>(
            "SELECT mission_id FROM state_audit_coverage WHERE corp_id=$1 ORDER BY mission_id",
        )
        .bind(corp)
        .fetch_all(&mut *tx)
        .await?;
        for mission in covered {
            let content = Object::new("content", snapshot(&mut tx, corp, mission, ledger).await?)?;
            let key = format!("mission/{mission}/governance");
            let (version_hash, _) = archive.refs.get(&key).context("coverage missing ref")?;
            let stored: Value = sqlx::query_scalar(
                "SELECT value FROM state_audit_objects WHERE corp_id=$1 AND hash=$2",
            )
            .bind(corp)
            .bind(version_hash)
            .fetch_one(&mut *tx)
            .await?;
            ensure!(
                stored["content_hash"] == content.hash,
                "operational state disagrees with audit head"
            );
        }
        if let Some(last) = archive.checkpoints.last()
            && last.checkpoint.last_sequence == verified.sequence()
        {
            let result = last.clone();
            tx.commit().await?;
            return Ok(result);
        }
        ensure!(
            !key_id.is_empty() && key_id.len() <= 128,
            "invalid audit key id"
        );
        let public_key = key.verifying_key().to_bytes();
        let activation_sequence = verified.sequence();
        let active = sqlx::query(
            "SELECT key_id,public_key,activated_sequence FROM state_audit_signing_keys WHERE corp_id=$1 AND retired_sequence IS NULL FOR UPDATE",
        )
        .bind(corp)
        .fetch_optional(&mut *tx)
        .await?;
        match active {
            Some(active)
                if active.get::<String, _>("key_id") == key_id
                    && active.get::<Vec<u8>, _>("public_key") == public_key =>
            {
                ensure!(
                    u64::try_from(active.get::<i64, _>("activated_sequence"))?
                        <= activation_sequence,
                    "audit signing key activation is in the future"
                );
            }
            Some(active) => {
                let prior_key_id: String = active.get("key_id");
                ensure!(
                    prior_key_id != key_id,
                    "audit signing key bytes changed without a new key id"
                );
                let retired_sequence = activation_sequence
                    .checked_sub(1)
                    .context("cannot rotate signing key before the first sequence")?;
                sqlx::query("UPDATE state_audit_signing_keys SET retired_sequence=$3 WHERE corp_id=$1 AND key_id=$2 AND retired_sequence IS NULL")
                    .bind(corp).bind(&prior_key_id).bind(i64::try_from(retired_sequence)?)
                    .execute(&mut *tx).await?;
                sqlx::query("INSERT INTO state_audit_signing_keys(corp_id,key_id,public_key,activated_sequence) VALUES($1,$2,$3,$4)")
                    .bind(corp).bind(key_id).bind(public_key.as_slice())
                    .bind(i64::try_from(activation_sequence)?).execute(&mut *tx).await?;
            }
            None => {
                ensure!(
                    archive.signing_keys.is_empty(),
                    "audit signing-key history has no active key"
                );
                sqlx::query("INSERT INTO state_audit_signing_keys(corp_id,key_id,public_key,activated_sequence) VALUES($1,$2,$3,$4)")
                    .bind(corp).bind(key_id).bind(public_key.as_slice())
                    .bind(i64::try_from(activation_sequence)?).execute(&mut *tx).await?;
            }
        }
        archive.signing_keys = Self::load_signing_keys(&mut tx, corp).await?;
        let signed = crony_audit::SignedCheckpoint::sign(
            crony_audit::Checkpoint {
                protocol_version: 1,
                ledger_id: ledger.to_string(),
                last_sequence: verified.sequence(),
                last_row_hash: verified.row_hash().context("empty history")?.into(),
                previous_checkpoint_digest: archive.checkpoints.last().map(|c| c.digest.clone()),
                key_id: key_id.into(),
            },
            key,
        )?;
        archive.checkpoints.push(signed.clone());
        archive.verify_with_key_history(&archive.signing_keys, Some(&signed.digest))?;
        sqlx::query("INSERT INTO state_audit_checkpoints(corp_id,sequence,digest,record) VALUES($1,$2,$3,$4)")
            .bind(corp).bind(i64::try_from(signed.checkpoint.last_sequence)?).bind(&signed.digest).bind(serde_json::to_value(&signed)?).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(signed)
    }

    async fn load_signing_keys(
        tx: &mut Transaction<'_, Postgres>,
        corp: Uuid,
    ) -> Result<Vec<crony_audit::TrustedSigningKey>> {
        let rows = sqlx::query(
            "SELECT key_id,public_key,activated_sequence,retired_sequence FROM state_audit_signing_keys WHERE corp_id=$1 ORDER BY activated_sequence",
        )
        .bind(corp)
        .fetch_all(&mut **tx)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(crony_audit::TrustedSigningKey {
                    key_id: row.get("key_id"),
                    public_key_hex: hex::encode(row.get::<Vec<u8>, _>("public_key")),
                    activated_sequence: u64::try_from(row.get::<i64, _>("activated_sequence"))?,
                    retired_sequence: row
                        .get::<Option<i64>, _>("retired_sequence")
                        .map(u64::try_from)
                        .transpose()?,
                })
            })
            .collect()
    }

    pub async fn audit_export(&self, corp: Uuid, actor: Uuid) -> Result<crony_audit::Archive> {
        let mut tx = self.pool.begin().await?;
        super::budget_revision::ensure_budget_manager_tx(&mut tx, corp, actor).await?;
        let ledger = lock_ledger(&mut tx, corp)
            .await?
            .context("audit ledger not initialized")?;
        let missions = sqlx::query_scalar::<_, Uuid>(
            "SELECT mission_id FROM state_audit_coverage WHERE corp_id=$1 ORDER BY mission_id",
        )
        .bind(corp)
        .fetch_all(&mut *tx)
        .await?;
        for mission in missions {
            authorize(&mut tx, corp, actor, mission, "export").await?;
        }
        let archive = Self::load_archive(&mut tx, corp, ledger).await?;
        ensure!(
            archive.rows.last().map(|r| r.decision.sequence)
                == archive
                    .checkpoints
                    .last()
                    .map(|c| c.checkpoint.last_sequence),
            "create a covering checkpoint before complete export"
        );
        tx.commit().await?;
        Ok(archive)
    }

    pub async fn initialize_state_audit(
        &self,
        corp: Uuid,
        actor: Uuid,
        ledger: Uuid,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        super::budget_revision::ensure_budget_manager_tx(&mut tx, corp, actor).await?;
        ensure!(!ledger.is_nil(), "nil ledger identity");
        sqlx::query("INSERT INTO state_audit_ledgers(corp_id,ledger_id) VALUES($1,$2) ON CONFLICT(corp_id) DO NOTHING")
            .bind(corp).bind(ledger).execute(&mut *tx).await?;
        let stored: Uuid = sqlx::query_scalar(
            "SELECT ledger_id FROM state_audit_ledgers WHERE corp_id=$1 FOR UPDATE",
        )
        .bind(corp)
        .fetch_one(&mut *tx)
        .await?;
        ensure!(
            stored == ledger,
            "ledger identity mismatch: restore must not reset ledger identity"
        );
        tx.commit().await?;
        Ok(())
    }

    async fn load_archive(
        tx: &mut Transaction<'_, Postgres>,
        corp: Uuid,
        ledger: Uuid,
    ) -> Result<crony_audit::Archive> {
        use crony_audit::{Archive, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_ROWS};
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM state_audit_decisions WHERE corp_id=$1")
                .bind(corp)
                .fetch_one(&mut **tx)
                .await?;
        ensure!(
            count <= MAX_ARCHIVE_ROWS as i64,
            "complete audit export exceeds V1 row bound; archive retention requires a future streaming exporter"
        );
        let size:i64=sqlx::query_scalar("SELECT COALESCE(sum(size),0)::bigint FROM (SELECT octet_length(bytes)+octet_length(value::text) AS size FROM state_audit_objects WHERE corp_id=$1 UNION ALL SELECT octet_length(bytes)+octet_length(decision::text)+octet_length(receipt::text)+octet_length(object_hashes::text) FROM state_audit_decisions WHERE corp_id=$1 UNION ALL SELECT octet_length(record::text) FROM state_audit_checkpoints WHERE corp_id=$1) s").bind(corp).fetch_one(&mut **tx).await?;
        ensure!(
            size <= MAX_ARCHIVE_BYTES as i64 / 2,
            "complete audit export exceeds V1 byte bound"
        );
        let all_objects =
            sqlx::query("SELECT hash,kind,bytes,value FROM state_audit_objects WHERE corp_id=$1")
                .bind(corp)
                .fetch_all(&mut **tx)
                .await?;
        let objects: std::collections::BTreeMap<String, Object> = all_objects
            .into_iter()
            .map(|r| {
                let object = Object {
                    hash: r.get("hash"),
                    kind: r.get("kind"),
                    bytes: r.get("bytes"),
                    value: r.get("value"),
                };
                (object.hash.clone(), object)
            })
            .collect();
        let records=sqlx::query("SELECT sequence,row_hash,bytes,decision,object_hashes,request_digest,actor_id,request_id,mission_id,receipt FROM state_audit_decisions WHERE corp_id=$1 ORDER BY sequence").bind(corp).fetch_all(&mut **tx).await?;
        let mut rows = Vec::new();
        for r in records {
            let decision: Decision = serde_json::from_value(r.get("decision"))?;
            ensure!(
                decision.sequence == u64::try_from(r.get::<i64, _>("sequence"))?
                    && decision.request_digest == r.get::<String, _>("request_digest")
                    && decision.actor == r.get::<Uuid, _>("actor_id").to_string()
                    && decision.request_id == r.get::<Uuid, _>("request_id").to_string(),
                "decision SQL indexes disagree with canonical fields"
            );
            ensure!(
                decision.correlation_id == r.get::<Uuid, _>("mission_id").to_string(),
                "decision mission SQL index disagrees with canonical fields"
            );
            let expected_receipt = AuditReceipt {
                ledger_id: ledger,
                sequence: decision.sequence,
                row_hash: r.get("row_hash"),
                decision: decision.decision.clone(),
                reason_code: decision.reason_code.clone(),
                resource_results: decision.changes.clone(),
            };
            ensure!(
                serde_json::from_value::<AuditReceipt>(r.get("receipt"))? == expected_receipt,
                "decision SQL receipt disagrees with canonical fields"
            );
            let hashes: Vec<String> = serde_json::from_value(r.get("object_hashes"))?;
            let mut referenced = Vec::new();
            for h in hashes {
                referenced.push(
                    objects
                        .get(&h)
                        .context("missing historical object")?
                        .clone(),
                );
            }
            rows.push(DecisionBundle {
                decision,
                bytes: r.get("bytes"),
                row_hash: r.get("row_hash"),
                objects: referenced,
            });
        }
        let checkpoints=sqlx::query("SELECT sequence,digest,record FROM state_audit_checkpoints WHERE corp_id=$1 ORDER BY sequence").bind(corp).fetch_all(&mut **tx).await?;
        let mut signed = Vec::new();
        for c in checkpoints {
            let record: crony_audit::SignedCheckpoint = serde_json::from_value(c.get("record"))?;
            ensure!(
                record.digest == c.get::<String, _>("digest")
                    && record.checkpoint.last_sequence
                        == u64::try_from(c.get::<i64, _>("sequence"))?,
                "checkpoint SQL index mismatch"
            );
            signed.push(record);
        }
        let refs=sqlx::query("SELECT resource_key,version_hash,revision FROM state_audit_refs WHERE corp_id=$1 ORDER BY resource_key").bind(corp).fetch_all(&mut **tx).await?;
        let mut heads = std::collections::BTreeMap::new();
        for r in refs {
            heads.insert(
                r.get("resource_key"),
                (
                    r.get("version_hash"),
                    u64::try_from(r.get::<i64, _>("revision"))?,
                ),
            );
        }
        let head = sqlx::query(
            "SELECT last_sequence,last_row_hash FROM state_audit_ledgers WHERE corp_id=$1",
        )
        .bind(corp)
        .fetch_one(&mut **tx)
        .await?;
        ensure!(
            rows.last().map_or(0, |r| r.decision.sequence)
                == u64::try_from(head.get::<i64, _>("last_sequence"))?
                && rows.last().map(|r| r.row_hash.clone())
                    == head.get::<Option<String>, _>("last_row_hash"),
            "ledger head disagrees with ordered history"
        );
        let archive = Archive {
            schema_version: 1,
            ledger_id: ledger.to_string(),
            rows,
            checkpoints: signed,
            signing_keys: Self::load_signing_keys(tx, corp).await?,
            refs: heads,
        };
        ensure!(
            serde_json::to_vec(&archive)?.len() <= MAX_ARCHIVE_BYTES as usize,
            "encoded complete archive exceeds byte bound"
        );
        Ok(archive)
    }

    pub async fn cover_mission(
        &self,
        corp: Uuid,
        actor: Uuid,
        mission: Uuid,
    ) -> Result<AuditReceipt> {
        let mut tx = self.pool.begin().await?;
        authorize(&mut tx, corp, actor, mission, "baseline").await?;
        lock_ledger(&mut tx, corp)
            .await?
            .context("explicit ledger initialization required")?;
        sqlx::query("SELECT id FROM missions WHERE id=$1 AND corp_id=$2 FOR UPDATE")
            .bind(mission)
            .bind(corp)
            .fetch_one(&mut *tx)
            .await?;
        ensure!(
            !sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM state_audit_coverage WHERE mission_id=$1)"
            )
            .bind(mission)
            .fetch_one(&mut *tx)
            .await?,
            "mission already covered"
        );
        let op = Operation {
            corp,
            actor,
            mission,
            request_id: Uuid::new_v4(),
            name: "baseline",
            request: json!({"mission_id":mission}),
        };
        let receipt = append(&mut tx, &op, "baseline", true).await?;
        sqlx::query("INSERT INTO state_audit_coverage(corp_id,mission_id,fingerprint) VALUES($1,$2,state_audit_fingerprint($2))").bind(corp).bind(mission).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(receipt)
    }

    pub async fn audit_receipt(
        &self,
        corp: Uuid,
        actor: Uuid,
        request: Uuid,
    ) -> Result<Option<AuditReceipt>> {
        let mut tx = self.pool.begin().await?;
        assert_actor_scope_tx(&mut tx, corp, actor).await?;
        let row=sqlx::query("SELECT mission_id,receipt,decision->>'operation' AS operation FROM state_audit_decisions WHERE corp_id=$1 AND actor_id=$2 AND request_id=COALESCE((SELECT request_id FROM state_audit_factory_replay_aliases WHERE corp_id=$1 AND actor_id=$2 AND canonical_request_id=$3),$3)")
            .bind(corp).bind(actor).bind(request).fetch_optional(&mut *tx).await?;
        let Some(row) = row else {
            tx.commit().await?;
            return Ok(None);
        };
        authorize(
            &mut tx,
            corp,
            actor,
            row.get("mission_id"),
            &row.get::<String, _>("operation"),
        )
        .await?;
        let receipt = serde_json::from_value(row.get("receipt"))?;
        tx.commit().await?;
        Ok(Some(receipt))
    }

    pub(crate) async fn audited<O, F>(&self, op: Operation, action: F) -> Result<O>
    where
        O: AuditOutcome,
        F: for<'a> FnOnce(&'a mut Transaction<'static, Postgres>) -> BoxFuture<'a, Result<O>>,
    {
        self.audited_inner(op, None, action).await
    }

    pub(crate) async fn audited_factory<F>(
        &self,
        op: Operation,
        identity: FactoryAuditIdentity,
        action: F,
    ) -> Result<FactoryWorkItemOutcome>
    where
        F: for<'a> FnOnce(
            &'a mut Transaction<'static, Postgres>,
        ) -> BoxFuture<'a, Result<FactoryWorkItemOutcome>>,
    {
        self.audited_inner(op, Some(identity), action).await
    }

    async fn audited_inner<O, F>(
        &self,
        mut op: Operation,
        factory: Option<FactoryAuditIdentity>,
        action: F,
    ) -> Result<O>
    where
        O: AuditOutcome,
        F: for<'a> FnOnce(&'a mut Transaction<'static, Postgres>) -> BoxFuture<'a, Result<O>>,
    {
        let mut tx = self.pool.begin().await?;
        // Every opted-in mutation shares the Corp head lock, before native locks.
        let covered: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM state_audit_coverage WHERE corp_id=$1 AND mission_id=$2)",
        )
        .bind(op.corp)
        .bind(op.mission)
        .fetch_one(&mut *tx)
        .await?;
        if !covered {
            let result = action(&mut tx).await?;
            tx.commit().await?;
            return Ok(result);
        }
        authorize(&mut tx, op.corp, op.actor, op.mission, op.name).await?;
        lock_ledger(&mut tx, op.corp)
            .await?
            .context("covered mission missing ledger")?;
        let request_digest = request_digest(&op)?;
        let canonical_request_id = op.request_id;
        if let Some(identity) = &factory {
            op.request_id =
                resolve_factory_audit_identity(&mut tx, &op, identity, &request_digest).await?;
        }
        let prior=sqlx::query("SELECT request_digest,receipt,mission_id FROM state_audit_decisions WHERE corp_id=$1 AND actor_id=$2 AND request_id=$3")
            .bind(op.corp).bind(op.actor).bind(op.request_id).fetch_optional(&mut *tx).await?;
        if let Some(prior) = &prior {
            ensure!(
                prior.get::<String, _>("request_digest") == request_digest
                    && prior.get::<Uuid, _>("mission_id") == op.mission,
                "audit request UUID reused with different semantic inputs"
            );
            let receipt: AuditReceipt = serde_json::from_value(prior.get("receipt"))?;
            let value:Value=sqlx::query_scalar("SELECT result FROM state_audit_local_results WHERE corp_id=$1 AND actor_id=$2 AND request_id=$3")
                .bind(op.corp).bind(op.actor).bind(op.request_id).fetch_one(&mut *tx).await?;
            if factory.is_some() {
                bind_factory_audit_identity(&mut tx, &op, canonical_request_id).await?;
            }
            if receipt.decision == "refused" {
                let message = value
                    .get("audit_refusal")
                    .and_then(Value::as_str)
                    .context("audit refusal result is malformed")?
                    .to_owned();
                tx.commit().await?;
                return Err(anyhow::Error::new(AuditedPolicyRefusal {
                    receipt,
                    message,
                }));
            }
            if O::requires_native_replay_validation() {
                let replayed = action(&mut tx).await?;
                ensure!(
                    replayed.was_replayed(),
                    "audited retry did not match the native idempotency record"
                );
                tx.commit().await?;
                return Ok(replayed);
            }
            let original: O = serde_json::from_value(value)?;
            tx.commit().await?;
            return Ok(original.replay());
        }
        let result = action(&mut tx).await;
        if result.as_ref().is_ok_and(AuditOutcome::was_replayed) {
            return Err(anyhow!(
                "native idempotency result predates audit coverage; no retroactive decision was recorded"
            ));
        }
        // Infrastructure/integrity errors are not policy refusals. Dropping the
        // outer transaction rolls everything back, including any savepoint work.
        if let Err(error) = &result
            && !error.chain().any(|cause| cause.is::<NativePolicyRefusal>())
        {
            return result;
        }
        if prior.is_none() {
            let receipt = append(
                &mut tx,
                &op,
                if result.is_ok() {
                    "accepted"
                } else {
                    "refused"
                },
                false,
            )
            .await?;
            let local_result = match &result {
                Ok(outcome) => serde_json::to_value(outcome)?,
                Err(error) => json!({"audit_refusal":error.to_string()}),
            };
            sqlx::query("INSERT INTO state_audit_local_results(corp_id,actor_id,request_id,result) VALUES($1,$2,$3,$4)")
                .bind(op.corp).bind(op.actor).bind(op.request_id).bind(local_result).execute(&mut *tx).await?;
            if factory.is_some() {
                bind_factory_audit_identity(&mut tx, &op, canonical_request_id).await?;
            }
            sqlx::query("UPDATE state_audit_coverage SET fingerprint=state_audit_fingerprint(mission_id) WHERE corp_id=$1 AND mission_id=$2")
                .bind(op.corp).bind(op.mission).execute(&mut *tx).await?;
            if let Err(error) = result {
                let message = error.to_string();
                tx.commit().await?;
                return Err(anyhow::Error::new(AuditedPolicyRefusal {
                    receipt,
                    message,
                }));
            }
        }
        tx.commit().await?;
        result
    }
}

async fn resolve_factory_audit_identity(
    tx: &mut Transaction<'_, Postgres>,
    op: &Operation,
    identity: &FactoryAuditIdentity,
    request_digest: &str,
) -> Result<Uuid> {
    // The caller holds the Corp ledger first. Acquire both native locks in
    // their native sorted order before inspecting the canonical operation.
    super::lock_factory_keys_tx(
        tx,
        &[
            format!("factory:idempotency:{}:{}", op.corp, identity.canonical_key),
            format!("factory:item:{}:{}", op.corp, identity.work_item_id),
        ],
    )
    .await?;
    let alias: Option<Uuid> = sqlx::query_scalar(
        "SELECT request_id FROM state_audit_factory_replay_aliases WHERE corp_id=$1 AND actor_id=$2 AND canonical_request_id=$3",
    )
    .bind(op.corp).bind(op.actor).bind(op.request_id)
    .fetch_optional(&mut **tx).await?;
    let mut candidates: std::collections::BTreeSet<Uuid> = sqlx::query_scalar(
        "SELECT request_id FROM state_audit_decisions WHERE corp_id=$1 AND actor_id=$2 AND (request_id=$3 OR request_id=$4 OR request_id=$5)",
    )
    .bind(op.corp).bind(op.actor).bind(op.request_id)
    .bind(identity.raw_request_id).bind(alias)
    .fetch_all(&mut **tx).await?.into_iter().collect();

    if let Some(native) = super::factory_operation_tx(tx, op.corp, &identity.canonical_key).await? {
        super::ensure_factory_operation_matches(
            &native,
            "upgrade_source_commit",
            op.actor,
            Some(identity.work_item_id),
            Some(identity.claim_token),
            &op.request,
        )?;
        // Raw historical keys cannot be recovered from their UUID hashes.
        // An accepted operation has an independent native identity: its Corp,
        // actor, item, claim, semantic request and unique resulting version.
        // Never identify an old request by matching semantic inputs alone.
        let retained: Vec<Uuid> = sqlx::query_scalar(
            "SELECT d.request_id FROM state_audit_decisions d JOIN state_audit_local_results r USING(corp_id,actor_id,request_id) WHERE d.corp_id=$1 AND d.actor_id=$2 AND d.mission_id=$3 AND d.request_digest=$4 AND d.decision->>'operation'='source_commit_upgrade' AND d.receipt->>'decision'='accepted' AND r.result->'work_item'->>'id'=$5 AND r.result->'work_item'->>'version'=$6 ORDER BY d.request_id LIMIT 2",
        )
        .bind(op.corp).bind(op.actor).bind(op.mission).bind(request_digest)
        .bind(native.work_item_id.to_string()).bind(native.resulting_version.to_string())
        .fetch_all(&mut **tx).await?;
        ensure!(
            retained.len() == 1,
            "native idempotency result has no unique retained audit decision; pre-coverage or ambiguous history cannot be adopted"
        );
        candidates.extend(retained);
    }
    ensure!(
        candidates.len() <= 1,
        "conflicting historical Factory replay identities require explicit reconciliation"
    );
    // Old refusals have no native operation and did not retain the raw key.
    // Even different semantic inputs may be a changed-input retry of that key.
    // A direct canonical match cannot disprove another padded legacy refusal.
    // Before creating an alias, require every other historical refusal to be
    // bound; otherwise choosing one record could silently hide a conflict.
    // Multiple ambiguous old refusals require explicit reconciliation. Neither
    // matching semantic inputs nor an unrelated new key proves their spelling.
    let unbound_refusal: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM state_audit_decisions d WHERE d.corp_id=$1 AND d.actor_id=$2 AND d.decision->>'operation'='source_commit_upgrade' AND d.receipt->>'decision'='refused' AND ($3::uuid IS NULL OR d.request_id<>$3) AND NOT EXISTS(SELECT 1 FROM state_audit_factory_replay_aliases a WHERE a.corp_id=d.corp_id AND a.actor_id=d.actor_id AND a.request_id=d.request_id))",
    )
    .bind(op.corp).bind(op.actor).bind(candidates.first().copied())
    .fetch_one(&mut **tx).await?;
    ensure!(
        alias.is_some() || !unbound_refusal,
        "legacy Factory refusal requires its original idempotency-key spelling or explicit reconciliation before canonical replay"
    );
    Ok(candidates.first().copied().unwrap_or(op.request_id))
}

async fn bind_factory_audit_identity(
    tx: &mut Transaction<'_, Postgres>,
    op: &Operation,
    canonical_request_id: Uuid,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO state_audit_factory_replay_aliases(corp_id,actor_id,canonical_request_id,request_id) VALUES($1,$2,$3,$4) ON CONFLICT(corp_id,actor_id,canonical_request_id) DO NOTHING",
    )
    .bind(op.corp).bind(op.actor).bind(canonical_request_id).bind(op.request_id)
    .execute(&mut **tx).await?;
    let retained: Uuid = sqlx::query_scalar(
        "SELECT request_id FROM state_audit_factory_replay_aliases WHERE corp_id=$1 AND actor_id=$2 AND canonical_request_id=$3",
    )
    .bind(op.corp).bind(op.actor).bind(canonical_request_id)
    .fetch_one(&mut **tx).await?;
    ensure!(
        retained == op.request_id,
        "conflicting immutable Factory replay alias"
    );
    Ok(())
}

fn request_digest(op: &Operation) -> Result<String> {
    Ok(digest(
        "request",
        &canonical(
            &json!({"schema_version":1,"corp_id":op.corp,"actor_id":op.actor,"mission_id":op.mission,"operation":op.name,"request":op.request}),
        )?,
    ))
}

async fn authorize(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    actor: Uuid,
    mission: Uuid,
    operation: &str,
) -> Result<()> {
    assert_actor_scope_tx(tx, corp, actor).await?;
    let row = sqlx::query("SELECT room_id,requested_by FROM missions WHERE id=$1 AND corp_id=$2")
        .bind(mission)
        .bind(corp)
        .fetch_optional(&mut **tx)
        .await?
        .context("mission not found in Corp")?;
    assert_room_membership_tx(tx, corp, row.get("room_id"), actor).await?;
    if operation == "contract_revision" {
        super::contract_revision::ensure_contract_revision_operator_tx(
            tx,
            corp,
            actor,
            row.get("requested_by"),
        )
        .await?;
    } else if operation == "source_commit_upgrade" {
        // The native factory operation validates the active claim, fencing
        // token, expected version, and immutable source policy in this same
        // transaction. Do not replace that authority with a broader role.
    } else {
        super::budget_revision::ensure_budget_manager_tx(tx, corp, actor).await?;
    }
    Ok(())
}

pub(crate) fn derived_request_id(
    domain: &str,
    corp: Uuid,
    actor: Uuid,
    idempotency_key: &str,
) -> Result<Uuid> {
    let bytes = canonical(&json!({
        "domain": domain,
        "corp_id": corp,
        "actor_id": actor,
        "idempotency_key": idempotency_key
    }))?;
    let hash = hex::decode(digest("derived-request-id", &bytes))?;
    Ok(Uuid::from_slice(&hash[..16])?)
}

async fn lock_ledger(tx: &mut Transaction<'_, Postgres>, corp: Uuid) -> Result<Option<Uuid>> {
    Ok(
        sqlx::query_scalar("SELECT ledger_id FROM state_audit_ledgers WHERE corp_id=$1 FOR UPDATE")
            .bind(corp)
            .fetch_optional(&mut **tx)
            .await?,
    )
}

async fn snapshot(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    mission: Uuid,
    ledger: Uuid,
) -> Result<Value> {
    let m=sqlx::query("SELECT room_id,requested_by,description,specification_version,budget_tokens,budget_cost_microusd FROM missions WHERE id=$1 AND corp_id=$2")
        .bind(mission).bind(corp).fetch_one(&mut **tx).await?;
    let tasks=sqlx::query("SELECT id,contract,contract_version,verification_policy FROM tasks WHERE mission_id=$1 AND corp_id=$2 ORDER BY id LIMIT 65")
        .bind(mission).bind(corp).fetch_all(&mut **tx).await?;
    ensure!(
        tasks.len() <= 64,
        "audit V1 coverage supports at most 64 mission tasks"
    );
    let mut task_content = Vec::new();
    for t in tasks {
        let contract: Value = t.get("contract");
        let verification: Value = t.get("verification_policy");
        task_content.push(json!({
            "task_id":t.get::<Uuid,_>("id"),"contract_version":t.get::<i64,_>("contract_version"),
            "contract_digest":digest("contract-input",&canonical(&contract)?),
            "verification_digest":digest("verification-input",&canonical(&verification)?),
            "allowed_tools":contract.get("allowed_tools"),"write_scope":contract.get("write_scope"),
            "budget_tokens":contract.get("budget_tokens"),"budget_cost_microusd":contract.get("budget_cost_microusd")
        }));
    }
    let pending=sqlx::query("SELECT id,proposed_budget_tokens,proposed_budget_cost_microusd,replacement_contract,replacement_verification_policy FROM mission_budget_revisions WHERE mission_id=$1 AND corp_id=$2 AND status='pending' ORDER BY id LIMIT 65")
        .bind(mission).bind(corp).fetch_all(&mut **tx).await?;
    ensure!(pending.len() <= 64, "audit pending proposal bound exceeded");
    let pending_content=pending.iter().map(|r|->Result<Value>{
        let contract=r.get::<Option<Value>,_>("replacement_contract")
            .map(|v|canonical(&v).map(|bytes|digest("contract-input",&bytes))).transpose()?;
        let verification=r.get::<Option<Value>,_>("replacement_verification_policy")
            .map(|v|canonical(&v).map(|bytes|digest("verification-input",&bytes))).transpose()?;
        Ok(json!({"id":r.get::<Uuid,_>("id"),"budget_tokens":r.get::<i64,_>("proposed_budget_tokens"),
            "budget_cost_microusd":r.get::<i64,_>("proposed_budget_cost_microusd"),
            "replacement_contract_digest":contract,"replacement_verification_digest":verification}))
    }).collect::<Result<Vec<_>>>()?;
    Ok(
        json!({"schema_version":1,"ledger_id":ledger,"corp_id":corp,"mission_id":mission,
        "room_id":m.get::<Uuid,_>("room_id"),"requested_by":m.get::<Uuid,_>("requested_by"),
        "resource_key":format!("mission/{mission}/governance"),
        "description_digest":digest("description-input",m.get::<String,_>("description").as_bytes()),
        "specification_version":m.get::<i64,_>("specification_version"),
        "budget_tokens":m.get::<i64,_>("budget_tokens"),"budget_cost_microusd":m.get::<i64,_>("budget_cost_microusd"),
        "tasks":task_content,"pending_budget_proposals":pending_content }),
    )
}

async fn append(
    tx: &mut Transaction<'_, Postgres>,
    op: &Operation,
    outcome: &str,
    baseline: bool,
) -> Result<AuditReceipt> {
    let row=sqlx::query("SELECT ledger_id,last_sequence,last_row_hash FROM state_audit_ledgers WHERE corp_id=$1 FOR UPDATE")
        .bind(op.corp).fetch_one(&mut **tx).await?;
    let ledger: Uuid = row.get("ledger_id");
    let sequence: u64 = u64::try_from(row.get::<i64, _>("last_sequence"))?
        .checked_add(1)
        .context("audit sequence overflow")?;
    let now = Utc::now().timestamp_millis();
    let key = format!("mission/{}/governance", op.mission);
    let mut objects = vec![Object::new(
        "policy",
        json!({"schema_version":1,"evaluator_version":EVALUATOR,"authority":"native-mission-contract-and-budget-rules","coverage":"mission-governance-v1"}),
    )?];
    let mut changes = Vec::new();
    if outcome != "refused" {
        let content = Object::new("content", snapshot(tx, op.corp, op.mission, ledger).await?)?;
        let previous=sqlx::query("SELECT r.version_hash,r.revision,o.value FROM state_audit_refs r JOIN state_audit_objects o ON o.corp_id=r.corp_id AND o.hash=r.version_hash WHERE r.corp_id=$1 AND r.resource_key=$2")
            .bind(op.corp).bind(&key).fetch_optional(&mut **tx).await?;
        ensure!(
            baseline == previous.is_none(),
            "missing or already initialized governance ref"
        );
        let unchanged = previous
            .as_ref()
            .is_some_and(|p| p.get::<Value, _>("value")["content_hash"] == content.hash);
        if !unchanged {
            let before = previous
                .as_ref()
                .map(|p| p.get::<String, _>("version_hash"));
            let revision =
                u64::try_from(previous.as_ref().map_or(0, |p| p.get::<i64, _>("revision")))?;
            let version = Object::new(
                "version",
                serde_json::to_value(Version {
                    schema_version: 1,
                    ledger_id: ledger.to_string(),
                    resource_key: key.clone(),
                    content_hash: content.hash.clone(),
                    parents: before.iter().cloned().collect(),
                    actor: op.actor.to_string(),
                    recorded_at: now,
                    provenance_assertions: Vec::new(),
                    observed_execution_context: Some(crony_audit::ExecutionContext {
                        authority: "native-postgres".into(),
                        evaluator_version: EVALUATOR.into(),
                    }),
                    evidence_references: op
                        .request
                        .get("source_run_id")
                        .and_then(Value::as_str)
                        .map(|id| format!("run:{id}"))
                        .into_iter()
                        .collect(),
                })?,
            )?;
            changes.push(Change {
                resource_key: key.clone(),
                before,
                after: version.hash.clone(),
                before_revision: revision,
                after_revision: revision + 1,
            });
            objects.extend([content, version]);
        }
    }
    let reason = if baseline {
        "coverage_started"
    } else if outcome == "refused" {
        "native_policy_refused"
    } else {
        "native_policy_accepted"
    };
    let bundle = DecisionBundle::new(
        Decision {
            schema_version: 1,
            ledger_id: ledger.to_string(),
            sequence,
            previous_row_hash: row.get("last_row_hash"),
            actor: op.actor.to_string(),
            operation: op.name.into(),
            recorded_at: now,
            request_id: op.request_id.to_string(),
            request_digest: request_digest(op)?,
            decision: outcome.into(),
            reason_code: reason.into(),
            policy_hash: objects[0].hash.clone(),
            evaluator_version: EVALUATOR.into(),
            changes: changes.clone(),
            correlation_id: op.mission.to_string(),
            causation_id: None,
        },
        objects,
    )?;
    for object in &bundle.objects {
        sqlx::query("INSERT INTO state_audit_objects(corp_id,hash,kind,bytes,value) VALUES($1,$2,$3,$4,$5) ON CONFLICT(corp_id,hash) DO NOTHING")
            .bind(op.corp).bind(&object.hash).bind(&object.kind).bind(&object.bytes).bind(&object.value).execute(&mut **tx).await?;
        let stored = sqlx::query(
            "SELECT bytes,kind,value FROM state_audit_objects WHERE corp_id=$1 AND hash=$2",
        )
        .bind(op.corp)
        .bind(&object.hash)
        .fetch_one(&mut **tx)
        .await?;
        ensure!(
            stored.get::<Vec<u8>, _>("bytes") == object.bytes
                && stored.get::<String, _>("kind") == object.kind
                && stored.get::<Value, _>("value") == object.value,
            "existing object conflict"
        );
    }
    for change in &changes {
        sqlx::query("INSERT INTO state_audit_refs(corp_id,resource_key,version_hash,revision) VALUES($1,$2,$3,$4) ON CONFLICT(corp_id,resource_key) DO UPDATE SET version_hash=EXCLUDED.version_hash,revision=EXCLUDED.revision")
            .bind(op.corp).bind(&change.resource_key).bind(&change.after).bind(i64::try_from(change.after_revision)?).execute(&mut **tx).await?;
    }
    let receipt = AuditReceipt {
        ledger_id: ledger,
        sequence,
        row_hash: bundle.row_hash.clone(),
        decision: outcome.into(),
        reason_code: reason.into(),
        resource_results: changes,
    };
    sqlx::query("INSERT INTO state_audit_decisions(corp_id,sequence,mission_id,actor_id,request_id,request_digest,row_hash,bytes,decision,object_hashes,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)")
        .bind(op.corp).bind(i64::try_from(sequence)?).bind(op.mission).bind(op.actor).bind(op.request_id).bind(&bundle.decision.request_digest)
        .bind(&bundle.row_hash).bind(&bundle.bytes).bind(serde_json::to_value(&bundle.decision)?)
        .bind(json!(bundle.objects.iter().map(|o|&o.hash).collect::<Vec<_>>())).bind(serde_json::to_value(&receipt)?).execute(&mut **tx).await?;
    sqlx::query(
        "UPDATE state_audit_ledgers SET last_sequence=$2,last_row_hash=$3 WHERE corp_id=$1",
    )
    .bind(op.corp)
    .bind(i64::try_from(sequence)?)
    .bind(&bundle.row_hash)
    .execute(&mut **tx)
    .await?;
    // V1 is a deliberately bounded complete archive. Reject the entire native
    // transaction before it could accept state that cannot be exported/signed.
    let archive = PgStore::load_archive(tx, op.corp, ledger).await?;
    const CHECKPOINT_RESERVE: usize = 8192;
    ensure!(
        serde_json::to_vec(&archive)?.len() + CHECKPOINT_RESERVE
            <= crony_audit::MAX_ARCHIVE_BYTES as usize,
        "V1 complete archive capacity reached"
    );
    let stored_bytes:i64=sqlx::query_scalar("SELECT COALESCE(sum(size),0)::bigint FROM (SELECT octet_length(bytes)+octet_length(value::text) AS size FROM state_audit_objects WHERE corp_id=$1 UNION ALL SELECT octet_length(bytes)+octet_length(decision::text)+octet_length(receipt::text)+octet_length(object_hashes::text) FROM state_audit_decisions WHERE corp_id=$1 UNION ALL SELECT octet_length(record::text) FROM state_audit_checkpoints WHERE corp_id=$1) s")
        .bind(op.corp).fetch_one(&mut **tx).await?;
    ensure!(
        stored_bytes + CHECKPOINT_RESERVE as i64 <= crony_audit::MAX_ARCHIVE_BYTES as i64 / 2,
        "V1 stored audit capacity reached"
    );
    Ok(receipt)
}
