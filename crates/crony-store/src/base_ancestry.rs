//! Corp-scoped append-only full-header ancestry evidence; no caller-supplied summary is trusted.
use crate::{PgStore, base_audit::BaseDestinationInput};
use anyhow::{Context, Result, ensure};
use crony_base::{
    B256,
    ancestry::{AncestrySegment, AncestryState, AncestryStore, ConsensusHeader, RetainedAncestry},
    rpc::{FinalityObservation, SealedHeader},
};
use futures_util::TryStreamExt;
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub struct BaseAncestryStore {
    store: PgStore,
    corp: Uuid,
    destination: Uuid,
}

impl PgStore {
    pub fn base_ancestry(&self, corp: Uuid, destination: Uuid) -> BaseAncestryStore {
        BaseAncestryStore {
            store: self.clone(),
            corp,
            destination,
        }
    }
}

async fn load_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    destination: Uuid,
    key: B256,
) -> Result<Option<AncestryState>> {
    let mut rows=sqlx::query("SELECT ordinal,segment FROM base_audit_ancestry_segments WHERE corp_id=$1 AND destination_id=$2 AND ancestry_key=$3 ORDER BY ordinal")
        .bind(corp).bind(destination).bind(key.as_slice()).fetch(&mut **tx);
    let mut state: Option<AncestryState> = None;
    while let Some(row) = rows.try_next().await? {
        let ordinal: i64 = row.try_get("ordinal")?;
        ensure!(
            u64::try_from(ordinal)? == state.as_ref().map_or(0, |s| s.segments),
            "retained ancestry segment gap"
        );
        let segment: AncestrySegment = serde_json::from_value(row.try_get("segment")?)?;
        ensure!(
            segment.binding.key() == key,
            "retained ancestry key mismatch"
        );
        state = Some(AncestryState::apply_segment(state.as_ref(), &segment)?);
    }
    Ok(state)
}

#[async_trait::async_trait]
impl AncestryStore for BaseAncestryStore {
    async fn load(&self, key: B256) -> crony_base::Result<Option<AncestryState>> {
        let result: Result<_> = async {
            let mut tx = self.store.pool().begin().await?;
            let state = load_tx(&mut tx, self.corp, self.destination, key).await?;
            tx.commit().await?;
            Ok(state)
        }
        .await;
        result.map_err(|_| {
            crony_base::Error::Evidence("durable ancestry load failed integrity or availability")
        })
    }
    async fn append(
        &self,
        key: B256,
        expected_segments: u64,
        segment: &AncestrySegment,
    ) -> crony_base::Result<()> {
        let result:Result<()>=async {
            ensure!(segment.binding.key()==key,"ancestry key mismatch");
            let mut tx=self.store.pool().begin().await?;
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
                .bind(format!("base-ancestry:{}:{}:{}",self.corp,self.destination,key)).execute(&mut *tx).await?;
            let input:Value=sqlx::query_scalar("SELECT config FROM base_audit_destinations WHERE corp_id=$1 AND id=$2")
                .bind(self.corp).bind(self.destination).fetch_one(&mut *tx).await?;
            let input:BaseDestinationInput=serde_json::from_value(input)?;
            ensure!(segment.binding.manifest_digest==input.config.manifest_digest
                && segment.binding.chain_id==input.config.chain_id
                && [input.config.primary_operator.as_str(),input.config.secondary_operator.as_str()].contains(&segment.binding.provider_identity.as_str()),
                "ancestry destination/provider scope mismatch");
            let state=load_tx(&mut tx,self.corp,self.destination,key).await?;
            let ordinal=i64::try_from(expected_segments)?;
            if state.as_ref().map_or(0,|s|s.segments)!=expected_segments {
                let saved:Option<Value>=sqlx::query_scalar("SELECT segment FROM base_audit_ancestry_segments WHERE corp_id=$1 AND destination_id=$2 AND ancestry_key=$3 AND ordinal=$4")
                    .bind(self.corp).bind(self.destination).bind(key.as_slice()).bind(ordinal).fetch_optional(&mut *tx).await?;
                ensure!(saved==Some(serde_json::to_value(segment)?),"conflicting ancestry compare-and-swap");
            } else {
                AncestryState::apply_segment(state.as_ref(),segment)?;
                sqlx::query("INSERT INTO base_audit_ancestry_segments(corp_id,destination_id,ancestry_key,ordinal,segment) VALUES($1,$2,$3,$4,$5)")
                    .bind(self.corp).bind(self.destination).bind(key.as_slice()).bind(ordinal).bind(serde_json::to_value(segment)?)
                    .execute(&mut *tx).await?;
            }
            tx.commit().await?;
            Ok(())
        }.await;
        result.map_err(|_| {
            crony_base::Error::Evidence("durable ancestry append refused or unavailable")
        })
    }
    async fn header(&self, key: B256, number: u64) -> crony_base::Result<Option<ConsensusHeader>> {
        let result:Result<_>=async {
            let mut tx=self.store.pool().begin().await?;
            if load_tx(&mut tx,self.corp,self.destination,key).await?.is_none() {return Ok(None);}
            let mut rows=sqlx::query_scalar::<_,Value>("SELECT segment FROM base_audit_ancestry_segments WHERE corp_id=$1 AND destination_id=$2 AND ancestry_key=$3 ORDER BY ordinal")
                .bind(self.corp).bind(self.destination).bind(key.as_slice()).fetch(&mut *tx);
            let mut found=None;
            while let Some(value)=rows.try_next().await? {
                let segment:AncestrySegment=serde_json::from_value(value)?;
                for header in segment.headers {
                    if header.number==number {found=Some(header);}
                }
            }
            drop(rows);
            tx.commit().await?;
            Ok(found)
        }.await;
        result.map_err(|_| {
            crony_base::Error::Evidence("retained consensus header unavailable or corrupt")
        })
    }
}

pub(crate) async fn verify_observation_tx(
    tx: &mut Transaction<'_, Postgres>,
    corp: Uuid,
    destination: Uuid,
    transaction: B256,
    included: &SealedHeader,
    observation: &FinalityObservation,
) -> Result<()> {
    if let Some(reference) = &observation.retained_ancestry {
        ensure!(
            observation.ancestry.is_empty(),
            "ambiguous ancestry evidence"
        );
        let state = load_tx(tx, corp, destination, reference.key)
            .await?
            .context("retained ancestry missing")?;
        ensure!(
            RetainedAncestry::from_complete(&state)? == *reference
                && state.binding.transaction_hash == transaction
                && state.binding.provider_identity == observation.provider_identity
                && state.binding.included == *included
                && state.binding.finalized == observation.finalized
                && state.binding.observed_at == observation.observed_at,
            "retained ancestry observation binding mismatch"
        );
    } else {
        crony_base::rpc::verify_ancestry(included, &observation.finalized, &observation.ancestry)?;
    }
    Ok(())
}
