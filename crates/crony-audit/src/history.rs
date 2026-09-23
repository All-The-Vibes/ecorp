use crate::{SignedCheckpoint, VerifyingKey, canonical, digest, valid_hash};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Object {
    pub kind: String,
    pub hash: String,
    pub bytes: Vec<u8>,
    pub value: Value,
}

impl Object {
    pub fn new(kind: &str, value: Value) -> Result<Self> {
        ensure!(
            matches!(kind, "content" | "version" | "policy"),
            "unknown object domain"
        );
        let bytes = canonical(&value)?;
        Ok(Self {
            kind: kind.into(),
            hash: digest(kind, &bytes),
            bytes,
            value,
        })
    }
    pub fn verify(&self) -> Result<()> {
        ensure!(
            *self == Self::new(&self.kind, self.value.clone())?,
            "object bytes/hash/index mismatch"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Version {
    pub schema_version: u32,
    pub ledger_id: String,
    pub resource_key: String,
    pub content_hash: String,
    pub parents: Vec<String>,
    pub actor: String,
    pub recorded_at: i64,
    pub provenance_assertions: Vec<String>,
    pub observed_execution_context: Option<ExecutionContext>,
    pub evidence_references: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExecutionContext {
    pub authority: String,
    pub evaluator_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub resource_key: String,
    pub before: Option<String>,
    pub after: String,
    pub before_revision: u64,
    pub after_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    pub schema_version: u32,
    pub ledger_id: String,
    pub sequence: u64,
    pub previous_row_hash: Option<String>,
    pub actor: String,
    pub operation: String,
    pub recorded_at: i64,
    pub request_id: String,
    pub request_digest: String,
    pub decision: String,
    pub reason_code: String,
    pub policy_hash: String,
    pub evaluator_version: String,
    pub changes: Vec<Change>,
    pub correlation_id: String,
    pub causation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DecisionBundle {
    pub decision: Decision,
    pub bytes: Vec<u8>,
    pub row_hash: String,
    pub objects: Vec<Object>,
}

impl DecisionBundle {
    pub fn new(decision: Decision, objects: Vec<Object>) -> Result<Self> {
        let bytes = canonical(&decision)?;
        Ok(Self {
            row_hash: digest("decision", &bytes),
            decision,
            bytes,
            objects,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MissionGovernancePolicy {
    schema_version: u32,
    evaluator_version: String,
    authority: String,
    coverage: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MissionTaskContent {
    task_id: String,
    contract_version: i64,
    contract_digest: String,
    verification_digest: String,
    allowed_tools: Value,
    write_scope: Value,
    budget_tokens: Value,
    budget_cost_microusd: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingBudgetContent {
    id: String,
    budget_tokens: i64,
    budget_cost_microusd: i64,
    replacement_contract_digest: Option<String>,
    replacement_verification_digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MissionGovernanceContent {
    schema_version: u32,
    ledger_id: String,
    corp_id: String,
    mission_id: String,
    room_id: String,
    requested_by: String,
    resource_key: String,
    description_digest: String,
    specification_version: i64,
    budget_tokens: i64,
    budget_cost_microusd: i64,
    tasks: Vec<MissionTaskContent>,
    pending_budget_proposals: Vec<PendingBudgetContent>,
}

fn validate_policy(value: Value, decision: &Decision) -> Result<()> {
    let policy: MissionGovernancePolicy = serde_json::from_value(value)?;
    ensure!(
        policy.schema_version == 1
            && policy.evaluator_version == decision.evaluator_version
            && policy.evaluator_version == "native-mission-governance-v1"
            && policy.authority == "native-mission-contract-and-budget-rules"
            && policy.coverage == "mission-governance-v1",
        "policy binding mismatch"
    );
    Ok(())
}

fn validate_content(value: Value, ledger_id: &str, resource_key: &str) -> Result<()> {
    let content: MissionGovernanceContent = serde_json::from_value(value)?;
    ensure!(
        content.schema_version == 1
            && content.ledger_id == ledger_id
            && content.resource_key == resource_key
            && content.resource_key == format!("mission/{}/governance", content.mission_id)
            && !content.corp_id.is_empty()
            && !content.room_id.is_empty()
            && !content.requested_by.is_empty()
            && valid_hash(&content.description_digest)
            && content.specification_version > 0
            && content.budget_tokens >= 0
            && content.budget_cost_microusd >= 0
            && content.tasks.len() <= 64
            && content.pending_budget_proposals.len() <= 64,
        "invalid mission governance content"
    );
    for task in &content.tasks {
        ensure!(
            !task.task_id.is_empty()
                && task.contract_version > 0
                && valid_hash(&task.contract_digest)
                && valid_hash(&task.verification_digest)
                && task.allowed_tools.is_array()
                && task.write_scope.is_array()
                && task.budget_tokens.as_i64().is_some_and(|value| value >= 0)
                && task
                    .budget_cost_microusd
                    .as_i64()
                    .is_some_and(|value| value >= 0),
            "invalid audited task content"
        );
    }
    for pending in &content.pending_budget_proposals {
        ensure!(
            !pending.id.is_empty()
                && pending.budget_tokens >= 0
                && pending.budget_cost_microusd >= 0
                && pending
                    .replacement_contract_digest
                    .as_deref()
                    .is_none_or(valid_hash)
                && pending
                    .replacement_verification_digest
                    .as_deref()
                    .is_none_or(valid_hash),
            "invalid pending budget content"
        );
    }
    Ok(())
}

/// Consumes one complete decision at a time. Object memory is released per row;
/// only resource heads remain (at most 10,000). No product state is reconstructed.
pub struct HistoryVerifier {
    ledger_id: String,
    sequence: u64,
    row_hash: Option<String>,
    refs: BTreeMap<String, (String, u64)>,
    previous_checkpoint: Option<String>,
    checkpoint_sequence: u64,
}

impl HistoryVerifier {
    pub fn new(ledger_id: &str) -> Self {
        Self {
            ledger_id: ledger_id.into(),
            sequence: 0,
            row_hash: None,
            refs: BTreeMap::new(),
            previous_checkpoint: None,
            checkpoint_sequence: 0,
        }
    }
    pub fn sequence(&self) -> u64 {
        self.sequence
    }
    pub fn row_hash(&self) -> Option<&str> {
        self.row_hash.as_deref()
    }
    pub fn refs(&self) -> &BTreeMap<String, (String, u64)> {
        &self.refs
    }
    pub fn push(&mut self, b: &DecisionBundle) -> Result<()> {
        let d = &b.decision;
        ensure!(
            b.bytes == canonical(d)? && b.row_hash == digest("decision", &b.bytes),
            "decision bytes/hash/index mismatch"
        );
        ensure!(
            d.schema_version == 1 && d.ledger_id == self.ledger_id,
            "foreign ledger or schema"
        );
        ensure!(
            d.sequence == self.sequence + 1 && d.previous_row_hash == self.row_hash,
            "missing or reordered ledger history"
        );
        ensure!(
            valid_hash(&d.request_digest) && !d.actor.is_empty() && !d.request_id.is_empty(),
            "invalid attribution"
        );
        ensure!(
            matches!(d.decision.as_str(), "accepted" | "refused" | "baseline"),
            "invalid decision"
        );
        ensure!(
            matches!(
                d.operation.as_str(),
                "baseline"
                    | "contract_revision"
                    | "budget_proposal"
                    | "budget_decision"
                    | "source_commit_upgrade"
            ),
            "unsupported covered operation"
        );
        ensure!(
            d.decision != "refused" || d.changes.is_empty(),
            "refusal mutated governed state"
        );
        ensure!(
            d.decision != "baseline"
                || (d.operation == "baseline" && d.reason_code == "coverage_started"),
            "unmarked baseline"
        );
        ensure!(
            matches!(
                (d.decision.as_str(), d.reason_code.as_str()),
                ("baseline", "coverage_started")
                    | ("accepted", "native_policy_accepted")
                    | ("refused", "native_policy_refused")
            ),
            "decision reason does not match outcome"
        );
        ensure!(
            d.changes.len() <= 64 && b.objects.len() <= 129,
            "decision exceeds resource bounds"
        );
        let mut objects = BTreeMap::new();
        for object in &b.objects {
            object.verify()?;
            ensure!(
                objects.insert(&object.hash, object).is_none(),
                "duplicate audit object"
            );
        }
        let policy = objects
            .get(&d.policy_hash)
            .context("missing policy object")?;
        ensure!(policy.kind == "policy", "incorrect policy object domain");
        validate_policy(policy.value.clone(), d)?;
        let mut used = BTreeSet::from([d.policy_hash.clone()]);
        let mut resources = BTreeSet::new();
        for c in &d.changes {
            ensure!(
                resources.insert(&c.resource_key),
                "duplicate resource change"
            );
            let current = self.refs.get(&c.resource_key);
            ensure!(
                c.before.as_ref() == current.map(|(h, _)| h)
                    && c.before_revision == current.map_or(0, |(_, r)| *r),
                "ref before state mismatch"
            );
            ensure!(
                c.after_revision
                    == c.before_revision
                        .checked_add(1)
                        .context("revision overflow")?,
                "nonmonotonic revision"
            );
            ensure!(
                (c.before.is_none()) == (d.decision == "baseline"),
                "initial adoption must be explicitly marked baseline"
            );
            let object = objects.get(&c.after).context("missing version object")?;
            ensure!(object.kind == "version", "incorrect version domain");
            let version: Version = serde_json::from_value(object.value.clone())?;
            ensure!(
                version.schema_version == 1
                    && version.ledger_id == self.ledger_id
                    && version.resource_key == c.resource_key,
                "foreign version"
            );
            ensure!(
                version.actor == d.actor && version.recorded_at == d.recorded_at,
                "version attribution mismatch"
            );
            ensure!(
                version.parents == c.before.iter().cloned().collect::<Vec<_>>(),
                "broken version ancestry"
            );
            let content = objects
                .get(&version.content_hash)
                .context("missing content object")?;
            ensure!(content.kind == "content", "incorrect content object domain");
            validate_content(content.value.clone(), &self.ledger_id, &c.resource_key)?;
            used.insert(c.after.clone());
            used.insert(version.content_hash);
        }
        ensure!(used.len() == objects.len(), "unreferenced audit objects");
        ensure!(
            self.refs.len() + d.changes.iter().filter(|c| c.before.is_none()).count() <= 10_000,
            "verification resource bound exceeded"
        );
        for c in &d.changes {
            self.refs
                .insert(c.resource_key.clone(), (c.after.clone(), c.after_revision));
        }
        self.sequence = d.sequence;
        self.row_hash = Some(b.row_hash.clone());
        Ok(())
    }
    /// Checkpoints must appear immediately after the committed prefix in the stream.
    pub fn checkpoint(&mut self, c: &SignedCheckpoint, key: &VerifyingKey) -> Result<()> {
        c.verify(key, None)?;
        ensure!(
            c.checkpoint.ledger_id == self.ledger_id
                && c.checkpoint.last_sequence == self.sequence
                && Some(&c.checkpoint.last_row_hash) == self.row_hash.as_ref(),
            "checkpoint does not cover supplied complete prefix"
        );
        ensure!(
            c.checkpoint.previous_checkpoint_digest == self.previous_checkpoint
                && c.checkpoint.last_sequence > self.checkpoint_sequence,
            "missing or reordered checkpoint history"
        );
        self.previous_checkpoint = Some(c.digest.clone());
        self.checkpoint_sequence = self.sequence;
        Ok(())
    }
    pub fn finish(&self, expected: Option<&str>) -> Result<()> {
        ensure!(
            self.sequence > 0
                && self.checkpoint_sequence == self.sequence
                && self.previous_checkpoint.is_some(),
            "export lacks final signed checkpoint"
        );
        ensure!(
            expected.is_none_or(|e| Some(e) == self.previous_checkpoint.as_deref()),
            "expected external checkpoint missing (restore divergence)"
        );
        Ok(())
    }
}
