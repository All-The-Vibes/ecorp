//! Durable bounded sweeps of immutable observation evidence. No network call holds these locks.
use crate::PgStore;
use anyhow::{Result, ensure};
use crony_base::rpc::SealedHeader;
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub const OBSERVATION_PAGE_ROWS: i64 = 64;

/// Trusted worker capability, deliberately not serializable or accepted from an API.
pub struct BaseObservationPage {
    pub anchor: SealedHeader,
    pub headers: Vec<SealedHeader>,
    pub evidence_ids: Vec<i64>,
    corp: Uuid,
    destination: Uuid,
    version: i64,
    revision: i64,
    after: i64,
    through: i64,
    end: i64,
}

pub struct BaseObservationFence {
    corp: Uuid,
    destination: Uuid,
    version: i64,
    revision: i64,
    through: i64,
}

async fn lock_destination(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    destination: Uuid,
) -> Result<i64> {
    let row = sqlx::query(
        "SELECT version,status FROM base_audit_destinations WHERE corp_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(corp)
    .bind(destination)
    .fetch_one(&mut **tx)
    .await?;
    ensure!(
        !matches!(
            row.get::<String, _>("status").as_str(),
            "finalized_contradiction" | "conflicting_anchor" | "invalid_evidence"
        ),
        "terminal integrity incident requires linked recovery"
    );
    Ok(row.get("version"))
}

async fn watermark(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    destination: Uuid,
) -> Result<i64> {
    Ok(sqlx::query_scalar("SELECT COALESCE(max(id),0) FROM base_audit_evidence WHERE corp_id=$1 AND destination_id=$2 AND kind IN ('inclusion','observed_event','finalized','spend_finalized')")
        .bind(corp).bind(destination).fetch_one(&mut **tx).await?)
}

impl PgStore {
    pub async fn base_observation_page(
        &self,
        corp: Uuid,
        destination: Uuid,
        tip: &SealedHeader,
    ) -> Result<BaseObservationPage> {
        ensure!(!tip.hash.is_zero(), "sealed observation tip required");
        let mut tx = self.pool().begin().await?;
        let version = lock_destination(&mut tx, corp, destination).await?;
        sqlx::query("INSERT INTO base_audit_observation_sweeps(corp_id,destination_id) VALUES($1,$2) ON CONFLICT DO NOTHING")
            .bind(corp).bind(destination).execute(&mut *tx).await?;
        let mut row = sqlx::query(
            "SELECT * FROM base_audit_observation_sweeps WHERE corp_id=$1 AND destination_id=$2",
        )
        .bind(corp)
        .bind(destination)
        .fetch_one(&mut *tx)
        .await?;
        if row.get::<Option<Value>, _>("anchor").is_none() {
            let through = watermark(&mut tx, corp, destination).await?;
            row=sqlx::query("UPDATE base_audit_observation_sweeps SET revision=revision+1,through_id=$3,anchor=$4 WHERE corp_id=$1 AND destination_id=$2 RETURNING *")
                .bind(corp).bind(destination).bind(through).bind(serde_json::to_value(tip)?).fetch_one(&mut *tx).await?;
        }
        let after: i64 = row.get("after_id");
        let through: i64 = row.get("through_id");
        let anchor: SealedHeader = serde_json::from_value(row.get::<Value, _>("anchor"))?;
        let rows=sqlx::query("SELECT id,kind,jsonb_path_query_array(evidence,'$.block') || jsonb_path_query_array(evidence,'$.included') || jsonb_path_query_array(evidence,'$.observations[*].finalized') AS headers FROM base_audit_evidence WHERE corp_id=$1 AND destination_id=$2 AND id>$3 AND id<=$4 AND kind IN ('inclusion','observed_event','finalized','spend_finalized') ORDER BY id LIMIT $5")
            .bind(corp).bind(destination).bind(after).bind(through).bind(OBSERVATION_PAGE_ROWS).fetch_all(&mut *tx).await?;
        let mut evidence_ids = Vec::with_capacity(rows.len());
        let mut headers = BTreeMap::new();
        let mut finalized = BTreeSet::new();
        for evidence in rows {
            evidence_ids.push(evidence.get("id"));
            let is_finalized = matches!(
                evidence.get::<String, _>("kind").as_str(),
                "finalized" | "spend_finalized"
            );
            let candidates: Vec<SealedHeader> = serde_json::from_value(evidence.get("headers"))?;
            ensure!(
                !candidates.is_empty() && candidates.len() <= 4,
                "invalid bounded observation header set"
            );
            for header in candidates {
                if is_finalized {
                    finalized.insert(header.hash);
                }
                if let Some(prior) = headers.insert(header.hash, header.clone()) {
                    ensure!(
                        prior == header,
                        "same retained header hash has conflicting fields"
                    );
                }
            }
        }
        let hashes: Vec<String> = headers.keys().map(ToString::to_string).collect();
        let orphaned:Vec<String>=sqlx::query_scalar("SELECT hash FROM unnest($3::text[]) AS hashes(hash) WHERE EXISTS(SELECT 1 FROM base_audit_evidence WHERE corp_id=$1 AND destination_id=$2 AND kind='reorged' AND evidence->>'old_block_hash'=hash)")
            .bind(corp).bind(destination).bind(&hashes).fetch_all(&mut *tx).await?;
        // A previously orphaned tentative block may later be re-included and finalized.
        headers.retain(|hash, _| finalized.contains(hash) || !orphaned.contains(&hash.to_string()));
        let end = evidence_ids.last().copied().unwrap_or(through);
        let page = BaseObservationPage {
            corp,
            destination,
            version,
            revision: row.get("revision"),
            after,
            through,
            end,
            anchor,
            headers: headers.into_values().collect(),
            evidence_ids,
        };
        tx.commit().await?;
        Ok(page)
    }

    /// Acknowledge only after BOTH providers checked every header and the pinned tip.
    pub async fn acknowledge_base_observation_page(
        &self,
        page: &BaseObservationPage,
        checked_tip: &SealedHeader,
    ) -> Result<Option<BaseObservationFence>> {
        ensure!(
            !checked_tip.hash.is_zero()
                && checked_tip.number >= page.anchor.number
                && checked_tip.timestamp >= page.anchor.timestamp
                && (checked_tip.number != page.anchor.number || checked_tip == &page.anchor),
            "observation tip regressed"
        );
        let mut tx = self.pool().begin().await?;
        ensure!(
            lock_destination(&mut tx, page.corp, page.destination).await? == page.version,
            "stale observation destination version"
        );
        let row = sqlx::query(
            "SELECT * FROM base_audit_observation_sweeps WHERE corp_id=$1 AND destination_id=$2",
        )
        .bind(page.corp)
        .bind(page.destination)
        .fetch_one(&mut *tx)
        .await?;
        ensure!(
            row.get::<i64, _>("revision") == page.revision
                && row.get::<i64, _>("after_id") == page.after
                && row.get::<i64, _>("through_id") == page.through
                && row.get::<Option<Value>, _>("anchor")
                    == Some(serde_json::to_value(&page.anchor)?),
            "stale observation page fence"
        );
        let through = if page.end == page.through {
            watermark(&mut tx, page.corp, page.destination).await?
        } else {
            page.through
        };
        ensure!(
            through >= page.through,
            "retained observation watermark regressed"
        );
        let complete = page.end == through;
        let revision:i64=sqlx::query_scalar("UPDATE base_audit_observation_sweeps SET revision=revision+1,after_id=$3,through_id=$4,complete=$5,anchor=$6 WHERE corp_id=$1 AND destination_id=$2 RETURNING revision")
            .bind(page.corp).bind(page.destination).bind(page.end).bind(through).bind(complete)
            .bind(serde_json::to_value(checked_tip)?).fetch_one(&mut *tx).await?;
        tx.commit().await?;
        Ok(complete.then_some(BaseObservationFence {
            corp: page.corp,
            destination: page.destination,
            version: page.version,
            revision,
            through,
        }))
    }

    /// Consume after the bounded event rescan and canonical-head checks. New rows defer publication.
    pub async fn finish_base_observation_sweep(
        &self,
        fence: &BaseObservationFence,
    ) -> Result<bool> {
        let mut tx = self.pool().begin().await?;
        ensure!(
            lock_destination(&mut tx, fence.corp, fence.destination).await? == fence.version,
            "stale observation destination version"
        );
        let row=sqlx::query("SELECT revision,through_id,complete FROM base_audit_observation_sweeps WHERE corp_id=$1 AND destination_id=$2")
            .bind(fence.corp).bind(fence.destination).fetch_one(&mut *tx).await?;
        ensure!(
            row.get::<i64, _>("revision") == fence.revision
                && row.get::<i64, _>("through_id") == fence.through
                && row.get::<bool, _>("complete"),
            "stale completed observation fence"
        );
        let latest = watermark(&mut tx, fence.corp, fence.destination).await?;
        ensure!(
            latest >= fence.through,
            "retained observation watermark regressed"
        );
        let complete = latest == fence.through;
        if complete {
            sqlx::query("UPDATE base_audit_observation_sweeps SET revision=revision+1,after_id=0,through_id=0,complete=false,anchor=NULL WHERE corp_id=$1 AND destination_id=$2")
                .bind(fence.corp).bind(fence.destination).execute(&mut *tx).await?;
        } else {
            sqlx::query("UPDATE base_audit_observation_sweeps SET revision=revision+1,through_id=$3,complete=false WHERE corp_id=$1 AND destination_id=$2")
                .bind(fence.corp).bind(fence.destination).bind(latest).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(complete)
    }
}

pub(crate) async fn reset_sweep_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    destination: Uuid,
) -> Result<()> {
    sqlx::query("UPDATE base_audit_observation_sweeps SET revision=revision+1,after_id=0,through_id=0,complete=false,anchor=NULL WHERE corp_id=$1 AND destination_id=$2")
        .bind(corp).bind(destination).execute(&mut **tx).await?;
    Ok(())
}
