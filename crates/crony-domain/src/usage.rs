//! Reported usage is a known subtotal, not proof of a complete provider bill.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UsageReport {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_microusd: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_provenance: Option<UsageProvenance>,
}

/// In-memory collect-only state, separate from the serialized evidence report.
/// Unknown quantities cannot distinguish an empty accumulator from an accepted
/// observation with missing quantities or an overflowed subtotal.
#[derive(Debug, Clone, Default)]
pub struct UsageAccumulator {
    report: UsageReport,
    has_valid_observation: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UsageProvenance {
    pub schema_version: u32,
    pub mapping: String,
    pub scope: UsageScope,
    pub model: Option<String>,
    pub sdk_version: Option<String>,
    pub cli_version: Option<String>,
    pub source_event: Option<String>,
    pub native_event_id: Option<String>,
    pub api_call_id: Option<String>,
    pub provider_call_id: Option<String>,
    pub provider_session_id: Option<String>,
    pub turn_id: Option<String>,
    pub cumulative_total_tokens: Option<u64>,
    /// Native latest-call total: consistency evidence, not a charge or a
    /// replacement for unknown input/output quantities in legacy observations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_total_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub cache_write_input_tokens: Option<u64>,
    pub reasoning_output_tokens: Option<u64>,
    /// Native Copilot units. Neither field is denominated in USD.
    pub model_multiplier: Option<f64>,
    pub nano_aiu: Option<f64>,
    #[serde(default)]
    pub cache_tokens_are_input_subsets: bool,
    #[serde(default)]
    pub reasoning_tokens_are_output_subsets: bool,
    /// Only field names and fixed reasons survive malformed native input.
    #[serde(default)]
    pub invalid_fields: Vec<InvalidUsageField>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageScope {
    PerCall,
    LastCall,
    #[default]
    UnspecifiedDelta,
    RetainedAggregate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InvalidUsageField {
    pub field: String,
    pub reason: InvalidUsageReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvalidUsageReason {
    InvalidNumber,
    OutOfRange,
    ConflictingAliases,
    ConflictingObservation,
    InvalidIdentifier,
    ContradictorySubset,
    Overflow,
}

impl UsageProvenance {
    pub fn new(mapping: &str, scope: UsageScope) -> Self {
        Self {
            schema_version: 1,
            mapping: mapping.to_owned(),
            scope,
            ..Self::default()
        }
    }

    pub fn invalidate(&mut self, field: &str, reason: InvalidUsageReason) {
        let invalid = InvalidUsageField {
            field: field.to_owned(),
            reason,
        };
        if !self.invalid_fields.contains(&invalid) {
            self.invalid_fields.push(invalid);
        }
    }

    /// Retain every available alias so adding an optional API ID to a replay
    /// cannot hide its original event ID. The store also fences the exact run.
    /// Equal quantities, missing IDs and parent aggregates never identify a call.
    pub fn native_identity_keys(&self) -> Vec<String> {
        match self.scope {
            UsageScope::PerCall => [
                ("api_call", &self.api_call_id),
                ("provider_call", &self.provider_call_id),
                ("event", &self.native_event_id),
            ]
            .into_iter()
            .filter_map(|(kind, id)| {
                id.as_ref().map(|id| {
                    serde_json::json!([self.mapping, self.provider_session_id, kind, id])
                        .to_string()
                })
            })
            .collect(),
            UsageScope::LastCall => match (
                &self.provider_session_id,
                &self.turn_id,
                self.cumulative_total_tokens,
            ) {
                (Some(session), Some(turn), Some(total)) => vec![
                    serde_json::json!([self.mapping, session, "cumulative_report", turn, total])
                        .to_string(),
                ],
                _ => Vec::new(),
            },
            UsageScope::UnspecifiedDelta | UsageScope::RetainedAggregate => Vec::new(),
        }
    }
}

impl UsageReport {
    /// Validate without repairing, clamping or inventing any quantity.
    pub fn validate(&self) -> Result<(), &'static str> {
        for quantity in [self.input_tokens, self.output_tokens, self.cost_microusd]
            .into_iter()
            .flatten()
        {
            if quantity > i64::MAX as u64 {
                return Err("usage quantity exceeds the accounting range");
            }
        }
        if let (Some(input), Some(output)) = (self.input_tokens, self.output_tokens)
            && input
                .checked_add(output)
                .is_none_or(|sum| sum > i64::MAX as u64)
        {
            return Err("input and output usage exceed the accounting range");
        }
        let Some(provenance) = &self.usage_provenance else {
            return Ok(());
        };
        if provenance.schema_version != 1 {
            return Err("unsupported usage provenance schema");
        }
        if !valid_usage_identifier(&provenance.mapping)
            || [
                &provenance.model,
                &provenance.sdk_version,
                &provenance.cli_version,
                &provenance.source_event,
                &provenance.native_event_id,
                &provenance.api_call_id,
                &provenance.provider_call_id,
                &provenance.provider_session_id,
                &provenance.turn_id,
            ]
            .into_iter()
            .flatten()
            .any(|identifier| !valid_usage_identifier(identifier))
        {
            return Err("invalid usage provenance identifier");
        }
        if !provenance.invalid_fields.is_empty() {
            return Err("native usage contains invalid fields");
        }
        for quantity in [
            provenance.cumulative_total_tokens,
            provenance.last_total_tokens,
            provenance.cached_input_tokens,
            provenance.cache_write_input_tokens,
            provenance.reasoning_output_tokens,
        ]
        .into_iter()
        .flatten()
        {
            if quantity > i64::MAX as u64 {
                return Err("native usage quantity exceeds the accounting range");
            }
        }
        if [provenance.model_multiplier, provenance.nano_aiu]
            .into_iter()
            .flatten()
            .any(|quantity| !quantity.is_finite() || quantity < 0.0)
        {
            return Err("invalid native billing quantity");
        }
        if provenance.cache_tokens_are_input_subsets
            && let Some(input) = self.input_tokens
            && [
                provenance.cached_input_tokens,
                provenance.cache_write_input_tokens,
            ]
            .into_iter()
            .flatten()
            .any(|cache| cache > input)
        {
            return Err("cache subsets contradict input usage");
        }
        if provenance.reasoning_tokens_are_output_subsets
            && let (Some(reasoning), Some(output)) =
                (provenance.reasoning_output_tokens, self.output_tokens)
            && reasoning > output
        {
            return Err("reasoning subset contradicts output usage");
        }
        Ok(())
    }

    pub fn coverage(&self) -> Value {
        let valid = self.validate().is_ok();
        serde_json::json!({
            "tokens": if !valid { "invalid" }
                else if self.input_tokens.is_some() && self.output_tokens.is_some() { "reported" }
                else if self.input_tokens.is_some() || self.output_tokens.is_some() { "partial" }
                else { "unavailable" },
            "usd": if !valid { "invalid" }
                else if self.cost_microusd.is_none() { "unavailable" }
                else if self.usage_provenance.is_none() { "legacy_unverified" }
                else { "reported" },
            "complete_provider_bill": false,
            "token_denominator": "input_plus_output",
            "native_billing_is_usd": false,
            "call_identity": if self.usage_provenance.as_ref()
                .is_some_and(|provenance| !provenance.native_identity_keys().is_empty()) {
                "reported"
            } else { "unavailable" }
        })
    }

    /// Identity aliases may be enriched on replay; quantities, units and source
    /// semantics may not be silently corrected after accounting.
    pub fn same_observation(&self, other: &Self) -> bool {
        let without_aliases = |report: &Self| {
            let mut report = report.clone();
            if let Some(provenance) = &mut report.usage_provenance {
                provenance.native_event_id = None;
                provenance.api_call_id = None;
                provenance.provider_call_id = None;
            }
            report
        };
        without_aliases(self) == without_aliases(other)
    }
}

impl UsageAccumulator {
    pub fn report(&self) -> &UsageReport {
        &self.report
    }

    /// Invalid native observations mark coverage without charging their values.
    /// An unknown component of a valid observation keeps that component unknown;
    /// individual known subtotals remain in the authoritative events.
    pub fn observe(&mut self, observation: &UsageReport) {
        self.append(observation, observation.validate().is_ok());
    }

    /// Merge trusted in-memory state. An invalid-marked run can still contain
    /// accepted subtotals; treating its report as another native observation
    /// would discard them. Empty runs are not all-unknown observations.
    pub fn merge(&mut self, addition: &Self) {
        if !addition.has_valid_observation && addition.report.usage_provenance.is_none() {
            return;
        }
        self.append(&addition.report, addition.has_valid_observation);
    }

    fn append(&mut self, addition: &UsageReport, include_quantities: bool) {
        let mut aggregate =
            UsageProvenance::new("retained_usage_aggregate_v1", UsageScope::RetainedAggregate);
        for report in [&self.report, addition] {
            if let Some(provenance) = &report.usage_provenance {
                for invalid in &provenance.invalid_fields {
                    aggregate.invalidate(&invalid.field, invalid.reason);
                }
            }
            if report.validate().is_err() {
                aggregate.invalidate("observation", InvalidUsageReason::InvalidNumber);
            }
        }
        if include_quantities {
            if !self.has_valid_observation {
                self.report.input_tokens = addition.input_tokens;
                self.report.output_tokens = addition.output_tokens;
                self.report.cost_microusd = addition.cost_microusd;
            } else {
                let mut add = |field, left: Option<u64>, right: Option<u64>| {
                    left.zip(right).and_then(|(left, right)| {
                        let total = left
                            .checked_add(right)
                            .filter(|total| *total <= i64::MAX as u64);
                        if total.is_none() {
                            aggregate.invalidate(field, InvalidUsageReason::Overflow);
                        }
                        total
                    })
                };
                self.report.input_tokens = add(
                    "input_tokens",
                    self.report.input_tokens,
                    addition.input_tokens,
                );
                self.report.output_tokens = add(
                    "output_tokens",
                    self.report.output_tokens,
                    addition.output_tokens,
                );
                self.report.cost_microusd = add(
                    "cost_microusd",
                    self.report.cost_microusd,
                    addition.cost_microusd,
                );
            }
            self.has_valid_observation = true;
        }
        self.report.usage_provenance = Some(aggregate);
        // Individually in-range components can still exceed the combined token
        // denominator. Preserve that invalidity across subsequent observations.
        if self.report.validate().is_err() {
            self.report
                .usage_provenance
                .as_mut()
                .expect("aggregate provenance")
                .invalidate("observation", InvalidUsageReason::InvalidNumber);
        }
    }
}

pub fn valid_usage_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(input: Option<u64>, output: Option<u64>) -> UsageReport {
        UsageReport {
            input_tokens: input,
            output_tokens: output,
            usage_provenance: Some(UsageProvenance::new("fixture_v1", UsageScope::PerCall)),
            ..UsageReport::default()
        }
    }

    #[test]
    fn absent_input_and_explicit_zero_output_are_partial() {
        let usage = report(None, Some(0));
        assert_eq!(usage.validate(), Ok(()));
        assert_eq!(usage.coverage()["tokens"], "partial");
        assert_eq!(
            serde_json::to_value(&usage).unwrap()["input_tokens"],
            Value::Null
        );
        assert_eq!(usage.coverage()["usd"], "unavailable");
    }

    #[test]
    fn explicit_zero_cost_needs_provenance_and_native_units_are_not_dollars() {
        let mut usage = report(Some(100), Some(20));
        let provenance = usage.usage_provenance.as_mut().unwrap();
        provenance.model_multiplier = Some(0.5);
        provenance.nano_aiu = Some(1.25);
        assert_eq!(usage.validate(), Ok(()));
        assert_eq!(usage.coverage()["usd"], "unavailable");
        usage.cost_microusd = Some(0);
        assert_eq!(usage.coverage()["usd"], "reported");
        usage.usage_provenance = None;
        assert_eq!(usage.coverage()["usd"], "legacy_unverified");
    }

    #[test]
    fn subsets_never_add_to_the_enforcement_denominator() {
        let mut usage = report(Some(100), Some(20));
        let provenance = usage.usage_provenance.as_mut().unwrap();
        provenance.cached_input_tokens = Some(40);
        provenance.cache_write_input_tokens = Some(10);
        provenance.reasoning_output_tokens = Some(5);
        provenance.cache_tokens_are_input_subsets = true;
        provenance.reasoning_tokens_are_output_subsets = true;
        assert_eq!(usage.validate(), Ok(()));
        assert_eq!(
            usage.input_tokens.unwrap() + usage.output_tokens.unwrap(),
            120
        );
        usage.usage_provenance.as_mut().unwrap().cached_input_tokens = Some(101);
        assert!(usage.validate().is_err());
    }

    #[test]
    fn reject_out_of_range_totals_subsets_and_native_units() {
        assert!(report(Some(i64::MAX as u64), Some(1)).validate().is_err());
        assert!(report(Some(u64::MAX), None).validate().is_err());
        let mut usage = report(Some(100), Some(20));
        usage.usage_provenance.as_mut().unwrap().nano_aiu = Some(-0.5);
        assert!(usage.validate().is_err());
        usage.usage_provenance.as_mut().unwrap().nano_aiu = Some(f64::INFINITY);
        assert!(usage.validate().is_err());
    }

    #[test]
    fn last_total_is_bounded_replay_evidence_without_inventing_quantities() {
        let legacy = report(None, Some(0));
        let legacy_json = serde_json::to_value(&legacy).unwrap();
        assert!(
            legacy_json["usage_provenance"]
                .get("last_total_tokens")
                .is_none()
        );
        let restored: UsageReport = serde_json::from_value(legacy_json).unwrap();
        assert!(legacy.same_observation(&restored));

        let mut with_total = restored.clone();
        with_total
            .usage_provenance
            .as_mut()
            .unwrap()
            .last_total_tokens = Some(i64::MAX as u64);
        assert!(with_total.validate().is_ok());
        assert_eq!(with_total.input_tokens, None);
        assert_eq!(with_total.output_tokens, Some(0));
        assert_eq!(with_total.coverage()["tokens"], "partial");
        assert!(!with_total.same_observation(&restored));
        let round_trip: UsageReport =
            serde_json::from_value(serde_json::to_value(&with_total).unwrap()).unwrap();
        assert!(with_total.same_observation(&round_trip));
        with_total
            .usage_provenance
            .as_mut()
            .unwrap()
            .last_total_tokens = Some(u64::MAX);
        assert!(with_total.validate().is_err());
    }

    #[test]
    fn native_identity_never_uses_equal_quantities() {
        let mut first = report(Some(100), Some(20));
        let mut second = first.clone();
        assert!(
            first
                .usage_provenance
                .as_ref()
                .unwrap()
                .native_identity_keys()
                .is_empty()
        );
        first.usage_provenance.as_mut().unwrap().api_call_id = Some("call-1".to_owned());
        second.usage_provenance.as_mut().unwrap().api_call_id = Some("call-2".to_owned());
        assert_ne!(
            first.usage_provenance.unwrap().native_identity_keys(),
            second.usage_provenance.unwrap().native_identity_keys()
        );
    }

    #[test]
    fn unknown_components_remain_unknown_in_collect_only_aggregates() {
        let mut total = UsageAccumulator::default();
        total.observe(&report(Some(10), Some(2)));
        total.observe(&report(Some(6), Some(2)));
        assert_eq!(total.report().input_tokens, Some(16));
        assert_eq!(total.report().output_tokens, Some(4));
        assert_eq!(total.report().cost_microusd, None);
        total.observe(&report(None, Some(0)));
        total.observe(&report(Some(1), Some(1)));
        assert_eq!(total.report().input_tokens, None);
        assert_eq!(total.report().output_tokens, Some(5));
    }

    #[test]
    fn aggregate_retains_invalidity_and_never_repairs_overflow() {
        let mut total = UsageAccumulator::default();
        total.observe(&report(Some(i64::MAX as u64), Some(0)));
        total.observe(&report(Some(1), Some(0)));
        assert_eq!(total.report().input_tokens, None);
        assert!(total.report().validate().is_err());
        total.observe(&report(Some(2), Some(0)));
        assert_eq!(total.report().input_tokens, None);
        assert!(total.report().validate().is_err());
    }

    #[test]
    fn enriching_identity_retains_original_alias_and_does_not_change_quantities() {
        let mut first = report(Some(100), Some(20));
        first.usage_provenance.as_mut().unwrap().native_event_id = Some("event-1".to_owned());
        let keys = first
            .usage_provenance
            .as_ref()
            .unwrap()
            .native_identity_keys();
        let mut replay = first.clone();
        replay.usage_provenance.as_mut().unwrap().api_call_id = Some("call-1".to_owned());
        assert!(
            replay
                .usage_provenance
                .as_ref()
                .unwrap()
                .native_identity_keys()
                .contains(&keys[0])
        );
        assert!(first.same_observation(&replay));
        replay.input_tokens = Some(101);
        assert!(!first.same_observation(&replay));
    }

    #[test]
    fn invalid_observations_do_not_increase_collect_only_subtotals() {
        let mut total = UsageAccumulator::default();
        total.observe(&report(Some(10), Some(2)));
        let mut invalid = report(Some(100), Some(20));
        invalid.usage_provenance.as_mut().unwrap().invalidate(
            "cumulative_total_tokens",
            InvalidUsageReason::ConflictingObservation,
        );
        total.observe(&invalid);
        assert_eq!(total.report().input_tokens, Some(10));
        assert_eq!(total.report().output_tokens, Some(2));
        assert_eq!(total.report().coverage()["tokens"], "invalid");
        total.observe(&report(Some(6), Some(2)));
        assert_eq!(total.report().input_tokens, Some(16));
        assert_eq!(total.report().output_tokens, Some(4));
        assert_eq!(total.report().coverage()["tokens"], "invalid");
    }

    fn invalid_report() -> UsageReport {
        let mut invalid = report(Some(100), Some(20));
        invalid.cost_microusd = Some(500);
        invalid.usage_provenance.as_mut().unwrap().invalidate(
            "cumulative_total_tokens",
            InvalidUsageReason::ConflictingObservation,
        );
        invalid
    }

    #[test]
    fn invalid_first_observations_preserve_later_valid_subtotals() {
        let mut total = UsageAccumulator::default();
        total.observe(&invalid_report());
        total.observe(&invalid_report());
        assert_eq!(total.report().input_tokens, None);
        assert_eq!(total.report().output_tokens, None);
        assert_eq!(total.report().cost_microusd, None);
        let mut accepted = report(Some(10), Some(2));
        accepted.cost_microusd = Some(7);
        total.observe(&accepted);
        assert_eq!(total.report().input_tokens, Some(10));
        assert_eq!(total.report().output_tokens, Some(2));
        assert_eq!(total.report().cost_microusd, Some(7));
        accepted.input_tokens = Some(6);
        accepted.cost_microusd = Some(11);
        total.observe(&accepted);
        assert_eq!(total.report().input_tokens, Some(16));
        assert_eq!(total.report().output_tokens, Some(4));
        assert_eq!(total.report().cost_microusd, Some(18));
        assert_eq!(total.report().coverage()["tokens"], "invalid");
        assert_eq!(total.report().coverage()["usd"], "invalid");
    }

    #[test]
    fn invalid_before_explicit_zero_keeps_zero_as_an_observation() {
        let mut total = UsageAccumulator::default();
        total.observe(&invalid_report());
        let mut zero = report(Some(0), Some(0));
        zero.cost_microusd = Some(0);
        total.observe(&zero);
        assert_eq!(total.report().input_tokens, Some(0));
        assert_eq!(total.report().output_tokens, Some(0));
        assert_eq!(total.report().cost_microusd, Some(0));
        total.observe(&report(Some(10), Some(2)));
        assert_eq!(total.report().input_tokens, Some(10));
        assert_eq!(total.report().output_tokens, Some(2));
        assert_eq!(total.report().cost_microusd, None);
        assert_eq!(total.report().coverage()["tokens"], "invalid");
    }

    #[test]
    fn valid_all_unknown_observation_is_not_empty_accumulator_state() {
        let mut total = UsageAccumulator::default();
        total.observe(&UsageReport::default());
        total.observe(&report(Some(10), Some(2)));
        assert_eq!(total.report().input_tokens, None);
        assert_eq!(total.report().output_tokens, None);
        assert_eq!(total.report().cost_microusd, None);
        assert_eq!(total.report().coverage()["tokens"], "unavailable");
    }

    #[test]
    fn retained_session_merge_keeps_valid_subtotals_from_invalid_run() {
        let mut run = UsageAccumulator::default();
        run.observe(&report(Some(6), Some(2)));
        run.observe(&invalid_report());
        for initial in [None, Some(10)] {
            let mut session = UsageAccumulator::default();
            if let Some(initial) = initial {
                session.observe(&report(Some(initial), Some(2)));
            }
            session.merge(&run);
            assert_eq!(
                session.report().input_tokens,
                Some(initial.unwrap_or(0) + 6)
            );
            assert_eq!(
                session.report().output_tokens,
                Some(if initial.is_some() { 4 } else { 2 })
            );
            assert_eq!(session.report().coverage()["tokens"], "invalid");
        }
    }

    #[test]
    fn invalid_only_run_does_not_erase_later_session_totals() {
        let mut session = UsageAccumulator::default();
        session.observe(&invalid_report());
        let mut next_run = UsageAccumulator::default();
        next_run.observe(&report(Some(6), Some(2)));
        session.merge(&next_run);
        assert_eq!(session.report().input_tokens, Some(6));
        assert_eq!(session.report().output_tokens, Some(2));
        assert_eq!(session.report().coverage()["tokens"], "invalid");
    }

    #[test]
    fn empty_and_invalid_only_runs_do_not_erase_existing_session_subtotals() {
        let empty = UsageAccumulator::default();
        let mut session = UsageAccumulator::default();
        session.merge(&empty);
        assert_eq!(session.report(), &UsageReport::default());
        let mut accepted = report(Some(10), Some(2));
        accepted.cost_microusd = Some(7);
        session.observe(&accepted);
        session.merge(&empty);
        assert_eq!(session.report().coverage()["tokens"], "reported");

        let mut invalid_only = UsageAccumulator::default();
        invalid_only.observe(&invalid_report());
        session.merge(&invalid_only);
        session.merge(&empty);
        assert_eq!(session.report().input_tokens, Some(10));
        assert_eq!(session.report().output_tokens, Some(2));
        assert_eq!(session.report().cost_microusd, Some(7));
        assert_eq!(session.report().coverage()["tokens"], "invalid");
    }

    #[test]
    fn valid_all_unknown_run_stays_unknown_across_session_merges() {
        let mut unknown_run = UsageAccumulator::default();
        unknown_run.observe(&UsageReport::default());
        unknown_run.merge(&UsageAccumulator::default());
        for known_first in [false, true] {
            let mut known = UsageAccumulator::default();
            let mut accepted = report(Some(10), Some(2));
            accepted.cost_microusd = Some(7);
            known.observe(&accepted);
            let mut session = UsageAccumulator::default();
            if known_first {
                session.merge(&known);
                session.merge(&unknown_run);
            } else {
                session.merge(&unknown_run);
                session.merge(&known);
            }
            assert_eq!(session.report().input_tokens, None);
            assert_eq!(session.report().output_tokens, None);
            assert_eq!(session.report().cost_microusd, None);
            assert_eq!(session.report().coverage()["tokens"], "unavailable");
        }
    }

    #[test]
    fn retained_merges_cannot_repair_overflowed_tokens_or_cost() {
        let mut run = UsageAccumulator::default();
        let mut boundary = report(Some(i64::MAX as u64), Some(0));
        boundary.cost_microusd = Some(i64::MAX as u64);
        run.observe(&boundary);
        let mut increment = report(Some(1), Some(0));
        increment.cost_microusd = Some(1);
        run.observe(&increment);
        let mut session = UsageAccumulator::default();
        session.observe(&increment);
        session.merge(&run);
        session.merge(&UsageAccumulator::default());
        session.observe(&increment);
        assert_eq!(session.report().input_tokens, None);
        assert_eq!(session.report().output_tokens, Some(0));
        assert_eq!(session.report().cost_microusd, None);
        assert_eq!(session.report().coverage()["tokens"], "invalid");
        assert_eq!(session.report().coverage()["usd"], "invalid");
        for field in ["input_tokens", "cost_microusd"] {
            assert!(
                session
                    .report()
                    .usage_provenance
                    .as_ref()
                    .unwrap()
                    .invalid_fields
                    .contains(&InvalidUsageField {
                        field: field.to_owned(),
                        reason: InvalidUsageReason::Overflow
                    })
            );
        }
    }

    #[test]
    fn merged_components_cannot_exceed_the_combined_accounting_range() {
        let mut session = UsageAccumulator::default();
        session.observe(&report(Some(i64::MAX as u64), Some(0)));
        let mut run = UsageAccumulator::default();
        run.observe(&report(Some(0), Some(1)));
        session.merge(&run);
        assert_eq!(session.report().input_tokens, Some(i64::MAX as u64));
        assert_eq!(session.report().output_tokens, Some(1));
        assert_eq!(session.report().coverage()["tokens"], "invalid");
        session.observe(&report(None, Some(0)));
        assert_eq!(session.report().input_tokens, None);
        assert_eq!(session.report().coverage()["tokens"], "invalid");
    }
}
