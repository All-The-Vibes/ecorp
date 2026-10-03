//! Thin native usage mappings. Keep optional quantities and native billing units;
//! the authoritative store computes coverage and admission, not the provider.
use crony_domain::{
    InvalidUsageReason, UsageProvenance, UsageReport, UsageScope, valid_usage_identifier,
};
use serde_json::Value;

pub(super) fn count(
    value: &Value,
    aliases: &[&str],
    field: &str,
    provenance: &mut UsageProvenance,
) -> Option<u64> {
    let mut selected = None;
    for alias in aliases {
        let Some(value) = value.get(*alias) else {
            continue;
        };
        let parsed = if value.is_null() {
            None
        } else if let Some(count) = value.as_u64() {
            if count <= i64::MAX as u64 {
                Some(count)
            } else {
                provenance.invalidate(field, InvalidUsageReason::OutOfRange);
                None
            }
        } else {
            provenance.invalidate(field, InvalidUsageReason::InvalidNumber);
            None
        };
        if selected.is_some_and(|previous| previous != parsed) {
            provenance.invalidate(field, InvalidUsageReason::ConflictingAliases);
        }
        selected = Some(parsed);
    }
    selected.flatten()
}

fn native_amount(
    value: Option<&Value>,
    field: &str,
    provenance: &mut UsageProvenance,
) -> Option<f64> {
    let value = value.filter(|value| !value.is_null())?;
    match value.as_f64() {
        Some(number) if number.is_finite() && number >= 0.0 => Some(number),
        _ => {
            provenance.invalidate(field, InvalidUsageReason::InvalidNumber);
            None
        }
    }
}

fn identifier(
    value: Option<&Value>,
    field: &str,
    provenance: &mut UsageProvenance,
) -> Option<String> {
    let value = value.filter(|value| !value.is_null())?;
    match value.as_str() {
        Some(value) if valid_usage_identifier(value) => Some(value.to_owned()),
        _ => {
            provenance.invalidate(field, InvalidUsageReason::InvalidIdentifier);
            None
        }
    }
}

pub(super) fn copilot(value: &Value, event_id: &str, session_id: &str) -> UsageReport {
    // Verified public fields in github-copilot-sdk 1.0.11, paired with CLI 1.0.79.
    // Do not scrape tokenDetails/quota internals or convert the multiplier/AI units.
    let mut provenance = UsageProvenance::new("copilot_sdk_1_0_11_usage_v1", UsageScope::PerCall);
    if !value.is_object() {
        provenance.invalidate("usage", InvalidUsageReason::InvalidNumber);
    }
    provenance.sdk_version = Some("1.0.11".to_owned());
    provenance.cli_version = Some("1.0.79".to_owned());
    provenance.source_event = Some("assistant.usage".to_owned());
    provenance.native_event_id = identifier(
        Some(&Value::String(event_id.to_owned())),
        "native_event_id",
        &mut provenance,
    );
    provenance.provider_session_id = identifier(
        Some(&Value::String(session_id.to_owned())),
        "provider_session_id",
        &mut provenance,
    );
    provenance.model = identifier(value.get("model"), "model", &mut provenance);
    provenance.api_call_id = identifier(value.get("apiCallId"), "api_call_id", &mut provenance);
    provenance.provider_call_id = identifier(
        value.get("providerCallId"),
        "provider_call_id",
        &mut provenance,
    );
    provenance.cached_input_tokens = count(
        value,
        &["cacheReadTokens"],
        "cached_input_tokens",
        &mut provenance,
    );
    provenance.cache_write_input_tokens = count(
        value,
        &["cacheWriteTokens"],
        "cache_write_input_tokens",
        &mut provenance,
    );
    provenance.reasoning_output_tokens = count(
        value,
        &["reasoningTokens"],
        "reasoning_output_tokens",
        &mut provenance,
    );
    // The pinned SDK explicitly defines reasoning tokens as output tokens. Its
    // cache field docs do not establish inclusion/disjointness for every model.
    provenance.reasoning_tokens_are_output_subsets = true;
    provenance.model_multiplier =
        native_amount(value.get("cost"), "model_multiplier", &mut provenance);
    provenance.nano_aiu = match value.get("copilotUsage") {
        None | Some(Value::Null) => None,
        Some(Value::Object(native))
            if native
                .get("totalNanoAiu")
                .is_some_and(|value| !value.is_null()) =>
        {
            native_amount(native.get("totalNanoAiu"), "nano_aiu", &mut provenance)
        }
        Some(_) => {
            // In the pinned public object this amount is required. A malformed
            // present object must not look like an absent optional observation.
            provenance.invalidate("nano_aiu", InvalidUsageReason::InvalidNumber);
            None
        }
    };
    let input_tokens = count(value, &["inputTokens"], "input_tokens", &mut provenance);
    let output_tokens = count(value, &["outputTokens"], "output_tokens", &mut provenance);
    UsageReport {
        input_tokens,
        output_tokens,
        cost_microusd: None,
        usage_provenance: Some(provenance),
    }
}

pub(super) fn codex(params: &Value) -> UsageReport {
    let mut provenance = UsageProvenance::new("codex_app_server_last_v1", UsageScope::LastCall);
    provenance.source_event = Some("thread/tokenUsage/updated".to_owned());
    // The adapter does not currently verify an exact Codex binary version.
    provenance.provider_session_id = identifier(
        params.get("threadId"),
        "provider_session_id",
        &mut provenance,
    );
    provenance.turn_id = identifier(params.get("turnId"), "turn_id", &mut provenance);
    provenance.cumulative_total_tokens = count(
        params.pointer("/tokenUsage/total").unwrap_or(&Value::Null),
        &["totalTokens"],
        "cumulative_total_tokens",
        &mut provenance,
    );
    if provenance.cumulative_total_tokens.is_none() {
        provenance.invalidate("cumulative_total_tokens", InvalidUsageReason::InvalidNumber);
    }
    let last = params.pointer("/tokenUsage/last").unwrap_or(&Value::Null);
    if !last.is_object() {
        provenance.invalidate("last", InvalidUsageReason::InvalidNumber);
    }
    provenance.last_total_tokens =
        count(last, &["totalTokens"], "last_total_tokens", &mut provenance);
    // Codex 0.159.2 requires this field and adds it to the cumulative total.
    // Legacy partial observations may omit it; a present null is malformed.
    if last.get("totalTokens").is_some_and(Value::is_null) {
        provenance.invalidate("last_total_tokens", InvalidUsageReason::InvalidNumber);
    }
    provenance.cached_input_tokens = count(
        last,
        &["cachedInputTokens"],
        "cached_input_tokens",
        &mut provenance,
    );
    provenance.cache_write_input_tokens = count(
        last,
        &["cacheWriteInputTokens"],
        "cache_write_input_tokens",
        &mut provenance,
    );
    provenance.reasoning_output_tokens = count(
        last,
        &["reasoningOutputTokens"],
        "reasoning_output_tokens",
        &mut provenance,
    );
    provenance.cache_tokens_are_input_subsets = true;
    provenance.reasoning_tokens_are_output_subsets = true;
    let input_tokens = count(last, &["inputTokens"], "input_tokens", &mut provenance);
    let output_tokens = count(last, &["outputTokens"], "output_tokens", &mut provenance);
    UsageReport {
        input_tokens,
        output_tokens,
        cost_microusd: None,
        usage_provenance: Some(provenance),
    }
}

pub(super) fn external(value: &Value, mapping: &str) -> UsageReport {
    // Legacy generic external JSON is not evidence of a provider-wide call ID,
    // cumulative convention, price table or complete provider bill.
    let mut provenance = UsageProvenance::new(mapping, UsageScope::UnspecifiedDelta);
    provenance.source_event = Some("usage".to_owned());
    if !value.is_object() {
        provenance.invalidate("usage", InvalidUsageReason::InvalidNumber);
    }
    let input_tokens = count(
        value,
        &["input_tokens", "inputTokens"],
        "input_tokens",
        &mut provenance,
    );
    let output_tokens = count(
        value,
        &["output_tokens", "outputTokens"],
        "output_tokens",
        &mut provenance,
    );
    let cost_microusd = count(
        value,
        &["cost_microusd", "costMicrousd"],
        "cost_microusd",
        &mut provenance,
    );
    UsageReport {
        input_tokens,
        output_tokens,
        cost_microusd,
        usage_provenance: Some(provenance),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn copilot_preserves_unknown_usd_and_fractional_native_units() {
        let report = copilot(
            &json!({"inputTokens":100,"outputTokens":20,"cacheReadTokens":40,"cacheWriteTokens":10,"reasoningTokens":5,"cost":0.5,"copilotUsage":{"totalNanoAiu":1.25},"model":"model-1","apiCallId":"call-1"}),
            "event-1",
            "session-1",
        );
        assert_eq!(report.validate(), Ok(()));
        assert_eq!(report.input_tokens, Some(100));
        assert_eq!(report.output_tokens, Some(20));
        assert_eq!(report.cost_microusd, None);
        let provenance = report.usage_provenance.as_ref().unwrap();
        assert_eq!(provenance.nano_aiu, Some(1.25));
        assert_eq!(provenance.model_multiplier, Some(0.5));
        assert!(!provenance.cache_tokens_are_input_subsets);
        assert_eq!(report.coverage()["usd"], "unavailable");
    }

    #[test]
    fn absence_zero_negative_fractional_and_overflow_remain_distinct() {
        let partial = copilot(&json!({"outputTokens":0}), "event-1", "session-1");
        assert_eq!(partial.input_tokens, None);
        assert_eq!(partial.output_tokens, Some(0));
        assert_eq!(partial.coverage()["tokens"], "partial");
        for invalid in [json!(-1), json!(1.5), json!(u64::MAX), json!("123")] {
            let report = copilot(
                &json!({"inputTokens":invalid,"outputTokens":0}),
                "event-1",
                "session-1",
            );
            assert!(report.validate().is_err());
            assert_eq!(report.input_tokens, None);
        }
        let missing = external(&json!({}), "fixture_v1");
        let zero = external(&json!({"cost_microusd":0}), "fixture_v1");
        assert_eq!(missing.coverage()["usd"], "unavailable");
        assert_eq!(zero.coverage()["usd"], "reported");
    }

    #[test]
    fn no_private_billing_or_prompt_content_survives_normalization() {
        let report = copilot(
            &json!({"inputTokens":10,"outputTokens":2,"prompt":"SENSITIVE_SENTINEL","tokenDetails":{"secret":"SENSITIVE_SENTINEL"},"quotaSnapshots":{"token":"SENSITIVE_SENTINEL"},"model":"bad\nSENSITIVE_SENTINEL"}),
            "event-1",
            "session-1",
        );
        assert!(report.validate().is_err());
        assert!(
            !serde_json::to_string(&report)
                .unwrap()
                .contains("SENSITIVE_SENTINEL")
        );
    }

    #[test]
    fn conflicting_external_aliases_are_not_silently_selected() {
        let report = external(
            &json!({"input_tokens":10,"inputTokens":11,"cost_microusd":0}),
            "external_usage_v1",
        );
        assert!(report.validate().is_err());
        assert_eq!(
            report.usage_provenance.unwrap().invalid_fields[0].reason,
            InvalidUsageReason::ConflictingAliases
        );
    }

    #[test]
    fn malformed_present_native_billing_objects_remain_invalid() {
        for native in [
            json!({}),
            json!({"totalNanoAiu":null}),
            json!([]),
            json!(1),
            json!("SENSITIVE_SENTINEL"),
        ] {
            let report = copilot(
                &json!({"inputTokens":10,"outputTokens":2,"copilotUsage":native}),
                "event-1",
                "session-1",
            );
            assert!(report.validate().is_err());
            assert_eq!(report.cost_microusd, None);
            assert!(
                !serde_json::to_string(&report)
                    .unwrap()
                    .contains("SENSITIVE_SENTINEL")
            );
        }
        let absent = copilot(
            &json!({"inputTokens":10,"outputTokens":2,"copilotUsage":null}),
            "event-1",
            "session-1",
        );
        assert_eq!(absent.validate(), Ok(()));
        assert_eq!(absent.coverage()["usd"], "unavailable");
    }

    #[test]
    fn codex_mapping_uses_last_and_keeps_cumulative_only_as_cursor() {
        let report = codex(
            &json!({"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":1000},"last":{"inputTokens":100,"outputTokens":20,"cachedInputTokens":40,"cacheWriteInputTokens":10,"reasoningOutputTokens":5}}}),
        );
        assert_eq!(report.validate(), Ok(()));
        assert_eq!(
            report.input_tokens.unwrap() + report.output_tokens.unwrap(),
            120
        );
        assert_eq!(
            report
                .usage_provenance
                .as_ref()
                .unwrap()
                .cumulative_total_tokens,
            Some(1000)
        );
        assert_eq!(report.usage_provenance.as_ref().unwrap().cli_version, None);
        assert_eq!(report.cost_microusd, None);
    }

    #[test]
    fn malformed_codex_last_is_not_an_absent_quantity() {
        for last in [
            json!(null),
            json!([]),
            json!(1),
            json!("SENSITIVE_SENTINEL"),
        ] {
            let report = codex(
                &json!({"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":12},"last":last}}),
            );
            assert!(report.validate().is_err());
            assert!(
                !serde_json::to_string(&report)
                    .unwrap()
                    .contains("SENSITIVE_SENTINEL")
            );
        }
        let partial = codex(
            &json!({"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":0},"last":{"outputTokens":0}}}),
        );
        assert_eq!(partial.validate(), Ok(()));
        assert_eq!(partial.coverage()["tokens"], "partial");
    }
}
