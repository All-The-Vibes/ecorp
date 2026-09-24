use crony_base_gateway::{GatewayConfig, validate_database_pair};

fn configuration() -> serde_json::Value {
    serde_json::json!({
        "listen":"127.0.0.1:8089",
        "tls_ingress_confirmed":true,
        "allowed_corps":["11111111-1111-4111-8111-111111111111"],
        "manifest_chain_file":"manifest-chain.json",
        "trust_pin_file":"trust-pin.json",
        "accepted_manifest_version":1,
        "accepted_manifest_digest":format!("0x{}", "11".repeat(32)),
        "spending_policy":{
            "max_gas":100000,"max_fee_per_gas":"1000000000","max_priority_fee_per_gas":"1000000",
            "max_attempt_fee":"0x100000000000000","monthly_budget":"0x1000000000000000",
            "safety_margin_bps":2500,"max_replacements":3,"quote_max_age_seconds":60,
            "max_deferral_seconds":86400,"low_balance_threshold":"0x10000000000000"
        },
        "app_database_secret_file":"app-database.secret",
        "journal_database_secret_file":"journal-database.secret",
        "workload_token_file":"workload-token.secret",
        "aws_region":"us-east-1",
        "kms_key_arn":"arn:aws:kms:us-east-1:111111111111:key/11111111-1111-4111-8111-111111111111",
        "publisher":format!("0x{}", "22".repeat(20))
    })
}

#[test]
fn valid_config_requires_private_tls_ingress_and_independent_trust() {
    let config: GatewayConfig = serde_json::from_value(configuration()).unwrap();
    config.validate().unwrap();
    for (field, bad) in [
        ("listen", serde_json::json!("0.0.0.0:8089")),
        ("tls_ingress_confirmed", serde_json::json!(false)),
        ("accepted_manifest_version", serde_json::json!(0)),
        ("allowed_corps", serde_json::json!([])),
        (
            "kms_key_arn",
            serde_json::json!("arn:aws:kms:us-east-1:111111111111:alias/test"),
        ),
        (
            "aws_region",
            serde_json::json!("us-east-1.attacker.invalid"),
        ),
    ] {
        let mut value = configuration();
        value[field] = bad;
        assert!(
            serde_json::from_value::<GatewayConfig>(value)
                .unwrap()
                .validate()
                .is_err()
        );
    }
    let mut value = configuration();
    value["private_key"] = serde_json::json!("never-accepted");
    assert!(serde_json::from_value::<GatewayConfig>(value).is_err());
}

#[test]
fn external_journal_requires_distinct_hosts_roles_and_verified_tls() {
    let app = "postgres://intent_reader:synthetic@intent.customer.invalid/app?sslmode=verify-full";
    let journal =
        "postgres://journal_writer:synthetic@journal.customer.invalid/journal?sslmode=verify-full";
    validate_database_pair(app, journal).unwrap();
    for invalid in [
        "postgres://journal_writer:synthetic@intent.customer.invalid/other?sslmode=verify-full",
        "postgres://intent_reader:synthetic@journal.customer.invalid/journal?sslmode=verify-full",
        "postgres://journal_writer:synthetic@journal.customer.invalid/journal?sslmode=disable",
        "postgres://journal_writer:synthetic@localhost/journal?sslmode=verify-full",
    ] {
        let error = validate_database_pair(app, invalid).unwrap_err();
        assert!(!error.to_string().contains("synthetic"));
        assert!(!format!("{error:?}").contains("synthetic"));
    }
}
