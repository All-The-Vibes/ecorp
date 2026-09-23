use chrono::{TimeZone, Utc};
use crony_base::{
    U256,
    config::BaseDestinationConfig,
    fees::{AdmissionContext, FeeQuote, SpendingPolicy, admit},
    schedule::Schedule,
};

#[test]
fn omitted_destination_is_disabled_and_not_enrolled() {
    let config: BaseDestinationConfig = serde_json::from_str("{}").unwrap();
    assert!(!config.enabled);
    assert!(config.validate().is_err());
}

#[test]
fn monthly_is_calendar_and_missed_runs_catch_up_once() {
    let schedule = Schedule::Monthly {
        day: 31,
        hour: 0,
        minute: 0,
    };
    let now = Utc.with_ymd_and_hms(2026, 2, 1, 0, 0, 0).unwrap();
    assert_eq!(
        schedule.next_after(now).unwrap(),
        Utc.with_ymd_and_hms(2026, 2, 28, 0, 0, 0).unwrap()
    );
    let now = Utc.with_ymd_and_hms(2026, 5, 18, 1, 0, 0).unwrap();
    assert_eq!(
        schedule.next_after(now).unwrap(),
        Utc.with_ymd_and_hms(2026, 5, 31, 0, 0, 0).unwrap()
    );
    assert!(Schedule::Duration { seconds: 0 }.next_after(now).is_err());
}

#[test]
fn admission_reserves_max_execution_and_uncapped_fees_without_float() {
    let policy = SpendingPolicy {
        max_gas: 100_000,
        max_fee_per_gas: 10,
        max_priority_fee_per_gas: 2,
        max_attempt_fee: U256::from(2_000_000),
        monthly_budget: U256::from(3_000_000),
        safety_margin_bps: 2000,
        max_replacements: 2,
        quote_max_age_seconds: 60,
        max_deferral_seconds: 3600,
        low_balance_threshold: U256::from(100),
    };
    let quote = FeeQuote {
        gas_limit: 100_000,
        max_fee_per_gas: 10,
        max_priority_fee_per_gas: 1,
        l1_data_fee: U256::from(100_000),
        observed_at: Utc::now(),
        fee_model_qualified: true,
    };
    let ctx = AdmissionContext {
        now: quote.observed_at,
        balance: U256::from(5_000_000),
        settled_this_month: U256::from(500_000),
        other_unresolved: U256::from(1_000_000),
        same_nonce_exposure: U256::from(1_500_000),
        replacement_count: 1,
    };
    let result = admit(&policy, &quote, &ctx).unwrap();
    assert_eq!(result.reservation, U256::from(1_500_000));
    let mut bad = quote.clone();
    bad.fee_model_qualified = false;
    assert!(admit(&policy, &bad, &ctx).is_err());
    let mut over = ctx.clone();
    over.other_unresolved = U256::from(1_000_001);
    assert!(admit(&policy, &quote, &over).is_err());
}
