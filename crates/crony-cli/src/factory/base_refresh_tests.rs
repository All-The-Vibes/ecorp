//! HTTP fixtures assert exact operator requests, not real GitHub acceptance.
use super::*;
use crate::factory::tests::factory_http_fixture_with_status;
use crony_domain::FactoryWorkItemState;
use reqwest::StatusCode;

fn fixture() -> (BaseRefreshArgs, FactoryWorkItem, FactoryBaseRefresh) {
    let corp = Uuid::new_v4();
    let actor = Uuid::new_v4();
    let item = Uuid::new_v4();
    let source = Uuid::new_v4();
    let operation = Uuid::new_v4();
    let now = Utc::now();
    let refresh = FactoryBaseRefresh {
        id: Uuid::new_v4(),
        corp_id: corp,
        factory_work_item_id: item,
        source_mission_id: Uuid::new_v4(),
        source_task_id: Uuid::new_v4(),
        source_run_id: Uuid::new_v4(),
        source_deliverable_id: source,
        mission_id: Uuid::new_v4(),
        task_id: Uuid::new_v4(),
        run_id: Uuid::new_v4(),
        authorized_by: actor,
        idempotency_key: operation,
        original_base_commit: "a".repeat(40),
        refreshed_base_commit: "b".repeat(40),
        source_head_commit: "c".repeat(40),
        state: "pending".into(),
        result_deliverable_id: None,
        result_commit: None,
        review_decision_id: None,
        settled_by: None,
        settlement_key: None,
        created_at: now,
        updated_at: now,
    };
    let item = FactoryWorkItem {
        id: item,
        corp_id: corp,
        source_kind: "github_project_issue".into(),
        source_project_owner: "fixture".into(),
        source_project_number: 1,
        source_project_item_id: "PVTI_fixture".into(),
        source_repository_owner: "fixture".into(),
        source_repository_name: "repository".into(),
        source_issue_number: 84,
        source_issue_node_id: "I_fixture84".into(),
        source_issue_url: "https://github.com/fixture/repository/issues/84".into(),
        source_title: "Governed base refresh".into(),
        source_revision: "revision-1".into(),
        state: FactoryWorkItemState::Verified,
        version: 7,
        claim_owner_id: actor,
        lease_expires_at: now + chrono::Duration::minutes(5),
        policy: json!({"source_base_ref":"main","source_base_commit":"a".repeat(40),
            "publication":{"base_ref":"main"}}),
        mission_id: Some(refresh.source_mission_id),
        failure_detail: None,
        created_at: now,
        updated_at: now,
    };
    let args = BaseRefreshArgs {
        corp_id: corp,
        actor_id: actor,
        work_item_id: item.id,
        // Any accidental external preflight must fail, even on configured hosts.
        github_cli: PathBuf::from(format!("missing-issue84-gh-{}", Uuid::new_v4())),
        wait_seconds: 1,
        operation: Operation::Authorize {
            control: Control {
                claim_token: Uuid::new_v4(),
                expected_version: item.version,
                operation_key: operation,
                observed_source_revision: item.source_revision.clone(),
                reason: "Explicit fixture refresh; preserve $scope and newlines\nexactly.".into(),
            },
            source_deliverable_id: source,
            new_base_commit: refresh.refreshed_base_commit.clone(),
        },
    };
    (args, item, refresh)
}

fn client() -> Client {
    Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap()
}

#[test]
fn issue84_publication_preflight_uses_saved_target_without_replacing_source_ref() {
    let (_, mut item, _) = fixture();
    item.policy["source_base_ref"] = json!("refs/heads/release");
    item.policy["publication_base_ref"] = json!("unrelated-top-level-field");
    assert_eq!(base_refs(&item).unwrap(), ("refs/heads/release", "main"));
    item.policy["publication"]["base_ref"] = json!("HEAD");
    assert_eq!(base_refs(&item).unwrap(), ("refs/heads/release", "HEAD"));
    for invalid in [
        Value::Null,
        json!(""),
        json!("refs/tags/v1"),
        json!("main\nother"),
    ] {
        item.policy["publication"]["base_ref"] = invalid;
        assert!(
            base_refs(&item).is_err(),
            "must not fall back to the source ref"
        );
    }
}

fn expected_authorization(args: &BaseRefreshArgs) -> Value {
    let Operation::Authorize {
        control,
        source_deliverable_id,
        new_base_commit,
    } = &args.operation
    else {
        panic!("expected authorization fixture");
    };
    json!({"actor_id":args.actor_id,"claim_token":control.claim_token,
        "expected_version":control.expected_version,"idempotency_key":control.operation_key,
        "observed_source_revision":control.observed_source_revision,"reason":control.reason,
        "source_deliverable_id":source_deliverable_id,"new_base_commit":new_base_commit})
}

#[tokio::test]
async fn issue84_authorization_replay_posts_exact_input_without_external_preflight() {
    let (args, _, refresh) = fixture();
    let expected = expected_authorization(&args);
    let endpoint = format!(
        "POST /api/corps/{}/factory/work-items/{}/base-refreshes ",
        args.corp_id, args.work_item_id
    );
    let (server, requests) = factory_http_fixture_with_status(vec![
        (StatusCode::OK, json!([refresh])),
        (StatusCode::OK, json!({"replayed":true})),
    ])
    .await;
    assert_eq!(
        run(&client(), &server, args).await.unwrap()["replayed"],
        true
    );
    let requests = requests.await.unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].0.starts_with("GET "));
    assert!(requests[1].0.starts_with(&endpoint));
    assert_eq!(requests[1].1, expected);
}

#[tokio::test]
async fn issue84_replay_hint_never_rewrites_altered_arguments_or_swallows_server_denial() {
    let (mut args, _, refresh) = fixture();
    let Operation::Authorize {
        control,
        new_base_commit,
        source_deliverable_id,
    } = &mut args.operation
    else {
        unreachable!();
    };
    control.claim_token = Uuid::new_v4();
    control.reason = "Altered fixture request".into();
    *new_base_commit = "d".repeat(40);
    *source_deliverable_id = Uuid::new_v4();
    let expected = expected_authorization(&args);
    let (server, requests) = factory_http_fixture_with_status(vec![
        (StatusCode::OK, json!([refresh])),
        (
            StatusCode::CONFLICT,
            json!({"error":"idempotency key was reused with a different request"}),
        ),
    ])
    .await;
    assert!(run(&client(), &server, args).await.is_err());
    let requests = requests.await.unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].1, expected);
}

fn settle(args: &mut BaseRefreshArgs, refresh: &FactoryBaseRefresh, adopt: bool) -> Value {
    let control = Control {
        claim_token: Uuid::new_v4(),
        expected_version: 7,
        operation_key: Uuid::new_v4(),
        observed_source_revision: "revision-1".into(),
        reason: "Explicit fixture settlement".into(),
    };
    let expected = serde_json::to_value(control.settlement(args.actor_id)).unwrap();
    args.operation = if adopt {
        Operation::Adopt {
            refresh_id: refresh.id,
            control,
        }
    } else {
        Operation::Abandon {
            refresh_id: refresh.id,
            control,
        }
    };
    expected
}

#[tokio::test]
async fn issue84_terminal_settlement_replays_preserve_action_and_request_without_github() {
    for adopt in [true, false] {
        let (mut args, _, mut refresh) = fixture();
        let expected = settle(&mut args, &refresh, adopt);
        refresh.settled_by = Some(args.actor_id);
        refresh.settlement_key =
            serde_json::from_value(expected["idempotency_key"].clone()).unwrap();
        refresh.state = if adopt { "adopted" } else { "abandoned" }.into();
        let action = if adopt { "adopt" } else { "abandon" };
        let endpoint = format!("/base-refreshes/{}/{action} ", refresh.id);
        let (server, requests) = factory_http_fixture_with_status(vec![
            (StatusCode::OK, json!([refresh])),
            (StatusCode::OK, json!({"replayed":true})),
        ])
        .await;
        assert_eq!(
            run(&client(), &server, args).await.unwrap()["replayed"],
            true
        );
        let requests = requests.await.unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].0.starts_with("POST ") && requests[1].0.contains(&endpoint));
        assert_eq!(requests[1].1, expected);
    }
}

#[tokio::test]
async fn issue84_other_actor_key_item_or_refresh_cannot_be_used_as_a_replay_hint() {
    for case in 0..6 {
        let (mut args, mut item, mut refresh) = fixture();
        match case {
            0 => refresh.authorized_by = Uuid::new_v4(),
            1 => refresh.idempotency_key = Uuid::new_v4(),
            2 => refresh.factory_work_item_id = Uuid::new_v4(),
            3 => refresh.corp_id = Uuid::new_v4(),
            _ => {
                let expected = settle(&mut args, &refresh, true);
                refresh.settled_by = Some(args.actor_id);
                refresh.settlement_key =
                    serde_json::from_value(expected["idempotency_key"].clone()).unwrap();
                if case == 4 {
                    refresh.id = Uuid::new_v4();
                } else {
                    refresh.settled_by = Some(Uuid::new_v4());
                }
            }
        }
        // A fresh call must recheck this changed version before any POST.
        item.version += 1;
        let mut responses = vec![(StatusCode::OK, json!([refresh]))];
        if case != 2 && case != 3 {
            responses.push((StatusCode::OK, json!({"work_item":item})));
        }
        let count = responses.len();
        let (server, requests) = factory_http_fixture_with_status(responses).await;
        let error = run(&client(), &server, args).await.unwrap_err().to_string();
        assert!(
            error.contains("scope mismatch") || error.contains("claim or version"),
            "case {case}: {error}"
        );
        let requests = requests.await.unwrap();
        assert_eq!(requests.len(), count);
        assert!(requests.iter().all(|(line, _)| line.starts_with("GET ")));
    }
}

#[tokio::test]
async fn issue84_abandon_uses_current_claim_without_requiring_external_issue_access() {
    let (mut args, item, refresh) = fixture();
    let expected = settle(&mut args, &refresh, false);
    let (server, requests) = factory_http_fixture_with_status(vec![
        (StatusCode::OK, json!([refresh])),
        (StatusCode::OK, json!({"work_item":item})),
        (StatusCode::OK, json!({"refresh":{"state":"abandoned"}})),
    ])
    .await;
    assert_eq!(
        run(&client(), &server, args).await.unwrap()["refresh"]["state"],
        "abandoned"
    );
    let requests = requests.await.unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests[2].0.contains("/abandon "));
    assert_eq!(requests[2].1, expected);
}

#[tokio::test]
async fn issue84_fresh_controls_reject_foreign_context_or_a_changed_claim() {
    for case in 0..4 {
        let (mut args, mut item, refresh) = fixture();
        settle(&mut args, &refresh, false);
        match case {
            0 => item.corp_id = Uuid::new_v4(),
            1 => item.id = Uuid::new_v4(),
            2 => item.claim_owner_id = Uuid::new_v4(),
            _ => item.version += 1,
        }
        let (server, requests) = factory_http_fixture_with_status(vec![
            (StatusCode::OK, json!([refresh])),
            (StatusCode::OK, json!({"work_item":item})),
        ])
        .await;
        assert!(
            run(&client(), &server, args)
                .await
                .unwrap_err()
                .to_string()
                .contains("claim or version")
        );
        assert!(
            requests
                .await
                .unwrap()
                .iter()
                .all(|(line, _)| line.starts_with("GET "))
        );
    }
}

#[test]
fn issue84_issue_identity_state_and_explicit_revision_must_all_match() {
    let (_, item, _) = fixture();
    let issue = IssueView {
        id: item.source_issue_node_id.clone(),
        number: 84,
        title: item.source_title.clone(),
        body: "Fixture acceptance criteria".into(),
        url: item.source_issue_url.clone(),
        state: "OPEN".into(),
        created_at: "revision-0".into(),
        updated_at: "revision-1".into(),
        labels: vec![],
    };
    assert!(validate_issue(&item, "fixture/repository", "revision-1", &issue).is_ok());
    for case in 0..6 {
        let mut changed = issue.clone();
        match case {
            0 => changed.id.push_str("changed"),
            1 => changed.number += 1,
            2 => changed.state = "CLOSED".into(),
            3 => changed.updated_at = "revision-2".into(),
            4 => changed.url = "https://github.com/another/repository/issues/84".into(),
            _ => changed.url = "https://example.invalid/fixture/repository/issues/84".into(),
        }
        assert!(
            validate_issue(&item, "fixture/repository", "revision-1", &changed).is_err(),
            "case {case}"
        );
    }
    let mut changed = item;
    changed.source_issue_url = "https://github.com/fixture/other/issues/84".into();
    assert!(validate_issue(&changed, "fixture/repository", "revision-1", &issue).is_err());
}

fn connection_report(args: &BaseRefreshArgs, connection: Uuid) -> Value {
    json!({"id":Uuid::new_v4(),"corp_id":args.corp_id,"room_id":Uuid::new_v4(),
        "actor_id":args.actor_id,"runner_id":"fixture-native-runner","connection_id":connection,
        "kind":"test","status":"succeeded","created_at":Utc::now(),"updated_at":Utc::now(),
        "expires_at":Utc::now()+chrono::Duration::minutes(1),
        "report":{"status":"succeeded","detail":"Synthetic connection check","connection_status":"ready",
            "source":{"repository":"fixture/repository","base_ref":"main","base_commit":"b".repeat(40)},
            "models":[],"account_login":null,"sign_in":null,"repositories":[]}})
}

#[tokio::test]
async fn issue84_native_source_check_does_not_require_provider_readiness() {
    let (args, _, _) = fixture();
    let connection = Uuid::new_v4();
    // Native setup retains the checked source even when its separate agent
    // inspection cannot offer provider execution. The refresh uses no model.
    for (status, readiness) in [
        ("succeeded", "ready"),
        ("succeeded", "needs_sign_in"),
        ("failed", "not_installed"),
        ("failed", "incompatible"),
        ("failed", "offline"),
        ("failed", "failed"),
    ] {
        let mut report = connection_report(&args, connection);
        report["status"] = json!(status);
        report["report"]["status"] = json!(status);
        report["report"]["connection_status"] = json!(readiness);
        let (server, requests) =
            factory_http_fixture_with_status(vec![(StatusCode::OK, json!({"operation":report}))])
                .await;
        check_connection(
            &client(),
            &server,
            &args,
            connection,
            "fixture/repository",
            "main",
            &"b".repeat(40),
        )
        .await
        .unwrap_or_else(|error| panic!("{status}/{readiness}: {error}"));
        assert_eq!(requests.await.unwrap().len(), 1);
    }
}

#[tokio::test]
async fn issue84_native_check_rejects_changed_scope_kind_source_and_incomplete_checks() {
    let (args, _, _) = fixture();
    let connection = Uuid::new_v4();
    let valid = connection_report(&args, connection);
    for (path, value) in [
        ("/corp_id", json!(Uuid::new_v4())),
        ("/actor_id", json!(Uuid::new_v4())),
        ("/connection_id", json!(Uuid::new_v4())),
        ("/kind", json!("connect")),
        ("/status", json!("failed")),
        ("/status", json!("cancelled")),
        ("/status", json!("needs_sign_in")),
        ("/report/status", json!("failed")),
        ("/report/source", Value::Null),
        ("/report/source/repository", json!("fixture/another")),
        ("/report/source/base_ref", json!("release")),
        ("/report/source/base_commit", json!("d".repeat(40))),
    ] {
        let mut report = valid.clone();
        *report.pointer_mut(path).unwrap() = value;
        let (server, requests) =
            factory_http_fixture_with_status(vec![(StatusCode::OK, json!({"operation":report}))])
                .await;
        assert!(
            check_connection(
                &client(),
                &server,
                &args,
                connection,
                "fixture/repository",
                "main",
                &"b".repeat(40)
            )
            .await
            .is_err(),
            "{path}"
        );
        assert_eq!(requests.await.unwrap().len(), 1);
    }
}

#[tokio::test]
async fn issue84_native_check_polls_only_the_original_operation_and_bounds_waiting() {
    for changed_id in [false, true] {
        let (args, _, _) = fixture();
        let connection = Uuid::new_v4();
        let mut completed = connection_report(&args, connection);
        let mut queued = completed.clone();
        queued["status"] = json!("queued");
        queued["report"] = Value::Null;
        if changed_id {
            completed["id"] = json!(Uuid::new_v4());
        }
        let (server, requests) = factory_http_fixture_with_status(vec![
            (StatusCode::OK, json!({"operation":queued})),
            (StatusCode::OK, completed),
        ])
        .await;
        let result = check_connection(
            &client(),
            &server,
            &args,
            connection,
            "fixture/repository",
            "main",
            &"b".repeat(40),
        )
        .await;
        assert_eq!(result.is_ok(), !changed_id);
        let requests = requests.await.unwrap();
        assert_eq!(requests.len(), 2);
        assert!(
            requests[0]
                .0
                .contains(&format!("/connections/{connection}/check "))
        );
        assert!(requests[1].0.contains(&format!(
            "/setup-operations/{}?actor_id={}",
            queued["id"].as_str().unwrap(),
            args.actor_id
        )));
    }
    let (args, _, _) = fixture();
    let connection = Uuid::new_v4();
    let mut expired = connection_report(&args, connection);
    expired["status"] = json!("running");
    expired["expires_at"] = json!(Utc::now() - chrono::Duration::seconds(1));
    let (server, requests) =
        factory_http_fixture_with_status(vec![(StatusCode::OK, json!({"operation":expired}))])
            .await;
    assert!(
        check_connection(
            &client(),
            &server,
            &args,
            connection,
            "fixture/repository",
            "main",
            &"b".repeat(40)
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("pending or expired")
    );
    assert_eq!(requests.await.unwrap().len(), 1);
}
