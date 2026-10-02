//! Native control and workspace regressions; provider execution is synthetic.
use super::*;

fn timed_control(seconds: u64) -> (ActiveRunControl, mpsc::UnboundedReceiver<AdapterControl>) {
    let (control, receiver) = mpsc::unbounded_channel();
    let (artifact_ack, _) = mpsc::unbounded_channel();
    (
        ActiveRunControl {
            assignment_token: Uuid::new_v4(),
            control,
            artifact_ack,
            hard_boundary_checkpoint: Arc::new(HardBoundaryControl {
                deadline: Some(tokio::time::Instant::now() + Duration::from_secs(seconds)),
                ..HardBoundaryControl::default()
            }),
        },
        receiver,
    )
}

#[tokio::test(start_paused = true)]
async fn mission_deadline_timer_cannot_relabel_an_earlier_operator_stop() {
    let (active, mut controls) = timed_control(5);
    let _guard = active.schedule_deadline();
    active.apply_stop("operator stopped this run".into());
    assert!(matches!(
        controls.recv().await,
        Some(AdapterControl::Stop { .. })
    ));
    tokio::time::advance(Duration::from_secs(6)).await;
    tokio::task::yield_now().await;
    assert!(active.hard_boundary_checkpoint.requested());
    assert_eq!(
        active.hard_boundary_checkpoint.cancellation_cause(),
        "native_cancelled"
    );
    assert!(!active.hard_boundary_checkpoint.begin_finalization());
}

#[tokio::test(start_paused = true)]
async fn mission_deadline_observation_survives_a_later_operator_stop() {
    let (active, mut controls) = timed_control(5);
    let _guard = active.schedule_deadline();
    tokio::time::advance(Duration::from_secs(5)).await;
    assert!(matches!(
        controls.recv().await,
        Some(AdapterControl::Stop { .. })
    ));
    active.apply_stop("operator stop after timer".into());
    assert_eq!(
        active.hard_boundary_checkpoint.cancellation_cause(),
        "mission_deadline_elapsed"
    );
    assert!(!active.hard_boundary_checkpoint.begin_finalization());
}

#[tokio::test(start_paused = true)]
async fn mission_deadline_payload_does_not_invent_a_timer_observation() {
    let (active, _controls) = timed_control(5);
    // No timer or boundary request has been observed. Payload construction is
    // read-only even when a native cancellation acknowledgement is delayed.
    tokio::time::advance(Duration::from_secs(6)).await;
    assert_eq!(
        active.hard_boundary_checkpoint.cancellation_cause(),
        "native_cancelled"
    );
    assert_eq!(
        active
            .hard_boundary_checkpoint
            .phase
            .load(Ordering::Acquire),
        HardBoundaryControl::OPEN
    );
    assert!(!*active.hard_boundary_checkpoint.cancellation.borrow());
}

#[tokio::test(start_paused = true)]
async fn mission_deadline_uses_the_existing_native_stop_boundary() {
    let (active, mut controls) = timed_control(5);
    let _guard = active.schedule_deadline();
    tokio::time::advance(Duration::from_secs(4)).await;
    assert!(!active.hard_boundary_checkpoint.requested());
    assert!(controls.try_recv().is_err());
    tokio::time::advance(Duration::from_secs(1)).await;
    let stop = controls.recv().await.unwrap();
    assert!(matches!(stop, AdapterControl::Stop { reason } if reason.contains("deadline")));
    assert!(active.hard_boundary_checkpoint.requested());
    assert!(!active.hard_boundary_checkpoint.begin_finalization());
    assert!(
        controls.try_recv().is_err(),
        "one timer issues one native stop"
    );
}

#[tokio::test(start_paused = true)]
async fn mission_deadline_dropped_timer_cannot_stop_a_later_assignment() {
    let (old, mut old_controls) = timed_control(5);
    let guard = old.schedule_deadline();
    drop(guard);
    let (later, mut later_controls) = timed_control(10);
    let _later_guard = later.schedule_deadline();
    tokio::time::advance(Duration::from_secs(6)).await;
    tokio::task::yield_now().await;
    assert!(!*old.hard_boundary_checkpoint.cancellation.borrow());
    assert!(old_controls.try_recv().is_err());
    assert!(!later.hard_boundary_checkpoint.requested());
    assert!(later_controls.try_recv().is_err());
    tokio::time::advance(Duration::from_secs(4)).await;
    assert!(matches!(
        later_controls.recv().await,
        Some(AdapterControl::Stop { .. })
    ));
}

#[tokio::test(start_paused = true)]
async fn mission_deadline_late_receipt_cannot_win_finalization_even_before_timer_poll() {
    let (active, _controls) = timed_control(5);
    let boundary = &active.hard_boundary_checkpoint;
    let event = Uuid::new_v4();
    boundary.expect_completion(event);
    let mut cancellation = boundary.cancellation.subscribe();
    // Deliberately do not schedule the timer: finalization must check elapsed time itself.
    tokio::time::advance(Duration::from_secs(5)).await;
    assert!(boundary.accept_completion(event));
    assert_eq!(
        wait_for_completion_receipt(boundary, &mut cancellation, Duration::from_secs(1)).await,
        CompletionStatus::Cancelled
    );
    assert!(boundary.requested());
}

#[tokio::test(start_paused = true)]
async fn mission_deadline_timely_persisted_receipt_fences_later_stop() {
    let (active, mut controls) = timed_control(5);
    let _guard = active.schedule_deadline();
    let boundary = &active.hard_boundary_checkpoint;
    let event = Uuid::new_v4();
    boundary.expect_completion(event);
    assert!(boundary.accept_completion(event));
    let mut cancellation = boundary.cancellation.subscribe();
    assert_eq!(
        wait_for_completion_receipt(boundary, &mut cancellation, Duration::from_secs(1)).await,
        CompletionStatus::Accepted
    );
    tokio::time::advance(Duration::from_secs(6)).await;
    tokio::task::yield_now().await;
    assert!(controls.try_recv().is_err());
    assert!(!*boundary.cancellation.borrow());
}

#[tokio::test]
async fn mission_deadline_expired_or_invalid_wire_allowance_fails_closed() {
    let now = Utc::now();
    let elapsed = crony_domain::RunDeadline {
        mission_deadline_at: now - chrono::TimeDelta::seconds(1),
        task_deadline_at: now - chrono::TimeDelta::seconds(1),
        dispatched_at: now - chrono::TimeDelta::seconds(2),
        remaining_ms: 1000,
    };
    assert!(HardBoundaryControl::with_deadline(Some(elapsed)).requested());
    let malformed = crony_domain::RunDeadline {
        mission_deadline_at: now + chrono::TimeDelta::seconds(60),
        task_deadline_at: now + chrono::TimeDelta::seconds(60),
        dispatched_at: now,
        remaining_ms: 120_000,
    };
    assert!(HardBoundaryControl::with_deadline(Some(malformed)).requested());
    assert!(!HardBoundaryControl::with_deadline(None).requested());
}

fn drain_events(received: &mut mpsc::UnboundedReceiver<RunnerToServer>) -> Vec<(String, Value)> {
    let mut events = Vec::new();
    while let Ok(message) = received.try_recv() {
        if let RunnerToServer::RunEvent {
            event_type,
            payload,
            ..
        } = message
        {
            events.push((event_type, payload));
        }
    }
    events
}

fn remove_fixture(root: PathBuf) {
    let resolved = std::fs::canonicalize(&root).unwrap();
    let temporary = std::fs::canonicalize(std::env::temp_dir()).unwrap();
    assert!(resolved.starts_with(&temporary) && resolved != temporary);
    std::fs::remove_dir_all(root).expect("remove only owned deadline test fixture");
}

#[tokio::test]
async fn mission_deadline_expired_verifier_cannot_start_or_remove_retained_source() {
    let (root, workspaces, workspace, mut assignment) =
        tests::prepared_verification_fixture().await;
    let fingerprint = workspaces.fingerprint(&workspace).await.unwrap();
    let (active, controls) = timed_control(0);
    assignment.hard_boundary_checkpoint = active.hard_boundary_checkpoint;
    let (_ack, artifact_acks) = mpsc::unbounded_channel();
    let (connection, mut received) = mpsc::unbounded_channel();
    let outbound = OutboundBus::default();
    outbound.attach(connection, assignment.connection_epoch);
    execute_verification_assignment(
        workspaces.clone(),
        "deadline-fixture".into(),
        assignment.clone(),
        outbound,
        AssignmentChannels {
            controls,
            artifact_acks,
        },
    )
    .await
    .unwrap();
    let events = drain_events(&mut received);
    assert_eq!(
        events
            .iter()
            .map(|(kind, _)| kind.as_str())
            .collect::<Vec<_>>(),
        ["run.cancelled"]
    );
    assert_eq!(
        workspaces.fingerprint(&workspace).await.unwrap(),
        fingerprint
    );
    assert!(workspace.path.is_dir());
    tests::assert_no_verification_snapshots(assignment.run_id);
    remove_fixture(root);
}

#[tokio::test]
async fn mission_deadline_during_verifier_upload_rejects_late_ack_and_preserves_exact_source() {
    let (root, workspaces, workspace, mut assignment) =
        tests::prepared_verification_fixture().await;
    let fingerprint = workspaces.fingerprint(&workspace).await.unwrap();
    let (active, controls) = timed_control(3600);
    assignment.hard_boundary_checkpoint = active.hard_boundary_checkpoint.clone();
    assignment.provider_artifact = Some(tests::verification_artifact_reference(
        "provider-outside-worktree.json",
        br#"{"evidence":"synthetic evidence before deadline"}"#,
    ));
    assignment.deliverable = Some(DeliverableSpec {
        form: crony_domain::DeliverableForm::ReviewOnlyReport,
        commit_after_verification: false,
        paths: vec![],
    });
    assignment.write_scope = vec!["sentinel.txt".into()];
    let guard = active.schedule_deadline();
    let (ack, artifact_acks) = mpsc::unbounded_channel();
    let (connection, mut received) = mpsc::unbounded_channel();
    let outbound = OutboundBus::default();
    outbound.attach(connection, assignment.connection_epoch);
    let running_assignment = assignment.clone();
    let running_workspaces = workspaces.clone();
    let job = tokio::spawn(async move {
        let _guard = guard;
        execute_verification_assignment(
            running_workspaces,
            "deadline-fixture".into(),
            running_assignment,
            outbound,
            AssignmentChannels {
                controls,
                artifact_acks,
            },
        )
        .await
    });
    let mut events = Vec::new();
    let sha = tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(message) = received.recv().await {
            if let RunnerToServer::RunEvent {
                event_type,
                payload,
                ..
            } = message
            {
                assert_ne!(event_type, "run.failed", "{payload}");
                let uploaded = event_type == "run.deliverable_upload";
                events.push((event_type, payload.clone()));
                if uploaded {
                    return payload["sha256"].as_str().unwrap().to_owned();
                }
            }
        }
        panic!("verifier ended before uploading evidence");
    })
    .await
    .expect("verifier upload checkpoint");
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(3600)).await;
    active
        .hard_boundary_checkpoint
        .cancellation
        .subscribe()
        .wait_for(|value| *value)
        .await
        .unwrap();
    tokio::time::resume();
    // A delayed successful upload acknowledgment cannot erase the deadline stop.
    let _ = ack.send(ArtifactAck {
        run_id: assignment.run_id,
        artifact_id: Uuid::new_v4(),
        artifact_role: "source_deliverable".into(),
        sha256: sha,
    });
    tokio::time::timeout(Duration::from_secs(15), job)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    events.extend(drain_events(&mut received));
    assert!(events.iter().any(|(kind, _)| kind == "run.cancelled"));
    assert!(!events.iter().any(|(kind, _)| matches!(
        kind.as_str(),
        "run.verification_passed" | "run.verification_waiting" | "run.completed"
    )));
    let retained = &events
        .iter()
        .find(|(kind, _)| kind == "run.workspace_preserved")
        .unwrap()
        .1;
    assert_eq!(retained["workspace_fingerprint"], fingerprint);
    assert_eq!(retained["workspace_quarantined"], false);
    assert_eq!(
        workspaces.fingerprint(&workspace).await.unwrap(),
        fingerprint
    );
    tests::assert_no_verification_snapshots(assignment.run_id);
    remove_fixture(root);
}
