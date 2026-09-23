#[test]
fn unconfigured_process_exits_disabled_without_external_access() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_crony-base-gateway"))
        .env_remove("ECORP_BASE_GATEWAY_CONFIG")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("gateway disabled")
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn invalid_configuration_fails_without_disclosing_path_or_secrets() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_crony-base-gateway"))
        .env(
            "ECORP_BASE_GATEWAY_CONFIG",
            "nonexistent-synthetic-secret-location.json",
        )
        .output()
        .unwrap();
    assert!(!output.status.success());
    let error = String::from_utf8(output.stderr).unwrap();
    assert!(error.contains("refused startup"));
    assert!(!error.contains("synthetic-secret"));
}
