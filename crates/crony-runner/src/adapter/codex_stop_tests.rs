use super::*;
use std::sync::Mutex;

#[derive(Default)]
struct StopSink(Mutex<Vec<AdapterEvent>>);

impl AdapterEventSink for StopSink {
    fn emit(&self, event: AdapterEvent) {
        self.0.lock().unwrap().push(event);
    }
}

async fn wait_marker(sink: &StopSink, marker: &str) {
    loop {
        if sink
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, AdapterEvent::Output { text, .. } if text == marker))
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

struct StopFixture {
    workspace: PathBuf,
    tx: mpsc::UnboundedSender<AdapterControl>,
    sink: Arc<StopSink>,
    task: tokio::task::JoinHandle<Result<AdapterExit, AdapterError>>,
}

impl StopFixture {
    fn start(scenario: &str) -> Self {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../scripts/fake-codex-stop-app-server.mjs");
        let adapter = CodexAdapter::new_with_prefix(
            PathBuf::from("node"),
            vec![
                script.into_os_string(),
                format!("--scenario={scenario}").into(),
            ],
        );
        let run_id = Uuid::new_v4();
        let workspace = std::env::temp_dir()
            .join("ecorp-issue87-tests")
            .join(run_id.to_string());
        let request = AdapterRunRequest {
            trusted_assignment: None,
            run_id,
            mission_id: Uuid::new_v4(),
            task_id: Uuid::new_v4(),
            agent_id: Uuid::new_v4(),
            mission_title: "deterministic stop transport regression".to_owned(),
            model: None,
            reasoning_effort: None,
            workspace: workspace.clone(),
            write_scope: vec!["**".to_owned()],
            environment: Default::default(),
        };
        let (tx, rx) = mpsc::unbounded_channel();
        let sink = Arc::new(StopSink::default());
        let task_sink = sink.clone();
        let task = tokio::spawn(async move { adapter.execute(request, rx, task_sink).await });
        Self {
            workspace,
            tx,
            sink,
            task,
        }
    }

    async fn marker(&self, marker: &str) {
        tokio::time::timeout(Duration::from_secs(12), wait_marker(&self.sink, marker))
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "fixture synchronization timed out; retained at {}",
                    self.workspace.display()
                )
            });
    }

    async fn phase(&self, phase: &str) {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if self.sink.0.lock().unwrap().iter().any(|event| {
                    matches!(event, AdapterEvent::ControlObservation { phase: actual, .. } if *actual == phase)
                }) { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("adapter observation");
    }

    async fn finish(&mut self) -> AdapterExit {
        tokio::time::timeout(Duration::from_secs(9), &mut self.task)
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "termination exceeded 9 seconds; retained at {}",
                    self.workspace.display()
                )
            })
            .expect("adapter join")
            .expect("adapter result")
    }
}

impl Drop for StopFixture {
    fn drop(&mut self) {
        // A failed assertion or setup timeout must not detach the adapter task
        // and its native children. The owned process scope also terminates on drop.
        self.task.abort();
    }
}

fn observation(sink: &StopSink, phase: &str) -> (chrono::DateTime<chrono::FixedOffset>, Value) {
    sink.0
        .lock()
        .unwrap()
        .iter()
        .find_map(|event| {
            if let AdapterEvent::ControlObservation {
                phase: actual,
                observed_at,
                detail,
            } = event
                && *actual == phase
            {
                Some((
                    chrono::DateTime::parse_from_rfc3339(observed_at).unwrap(),
                    detail.clone(),
                ))
            } else {
                None
            }
        })
        .unwrap_or_else(|| panic!("missing {phase} observation"))
}

async fn stop_case(
    scenario: &str,
    marker: &str,
    block_stdin: bool,
    stop: bool,
) -> (AdapterExit, PathBuf, Arc<StopSink>) {
    let mut fixture = StopFixture::start(scenario);
    if !marker.is_empty() {
        fixture.marker(marker).await;
    }
    if block_stdin {
        fixture
            .tx
            .send(AdapterControl::Steer {
                actor_id: Uuid::new_v4(),
                text: "x".repeat(1024 * 1024),
            })
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if stop {
        fixture
            .tx
            .send(AdapterControl::Stop {
                reason: "issue87 deterministic stop".to_owned(),
            })
            .ok();
    }
    (
        fixture.finish().await,
        fixture.workspace.clone(),
        fixture.sink.clone(),
    )
}

#[tokio::test]
async fn issue87_stop_during_thread_start_never_starts_a_turn() {
    let (exit, workspace, _) =
        stop_case("delayed-thread", "stop-fixture:thread-pending", false, true).await;
    assert_eq!(exit, AdapterExit::Cancelled);
    assert!(!workspace.join("unexpected-start.txt").exists());
}

#[tokio::test]
async fn issue87_stop_is_received_while_stdin_is_blocked() {
    let (exit, _, _) = stop_case("blocked-stdin", "stop-fixture:stdin-paused", true, true).await;
    assert_eq!(exit, AdapterExit::Cancelled);
}

#[tokio::test]
async fn issue87_completion_racing_stop_remains_cancelled() {
    let (exit, _, _) = stop_case(
        "completed-after-interrupt",
        "stop-fixture:turn-running",
        false,
        true,
    )
    .await;
    assert_eq!(exit, AdapterExit::Cancelled);
}

#[tokio::test]
async fn issue87_eof_does_not_wait_forever_for_a_live_child() {
    // Node's Windows stdout wrappers retain pipe handles after end/close. Use a
    // native child whose actual stdout handle closes while its root stays alive.
    let mut command = Command::new(std::env::current_exe().unwrap());
    // Serial libtest's default formatter prefixes the first protocol frame
    // with the test name. Terse output keeps that frame on its own line.
    command
        .args([
            "--exact",
            "adapter::codex::stop_tests::issue87_native_eof_fixture",
            "--nocapture",
            "--format=terse",
        ])
        .env("RUST_TEST_THREADS", "1")
        .env("ECORP_ISSUE87_EOF_FIXTURE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let workspace = std::env::temp_dir()
        .join("ecorp-issue87-tests")
        .join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&workspace).unwrap();
    let request = AdapterRunRequest {
        trusted_assignment: None,
        run_id: Uuid::new_v4(),
        mission_id: Uuid::new_v4(),
        task_id: Uuid::new_v4(),
        agent_id: Uuid::new_v4(),
        mission_title: "native EOF regression".into(),
        model: None,
        reasoning_effort: None,
        workspace,
        write_scope: vec!["**".into()],
        environment: Default::default(),
    };
    let (_tx, mut controls) = mpsc::unbounded_channel();
    let sink: Arc<dyn AdapterEventSink> = Arc::new(StopSink::default());
    let mut parsed = ParsedRun::default();
    let mut termination = None;
    let outcome = tokio::time::timeout(
        Duration::from_secs(9),
        runtime::execute(
            &mut command,
            &request,
            &CodexMode::Start,
            &mut controls,
            &mut true,
            &sink,
            &mut parsed,
            &mut termination,
        ),
    )
    .await
    .expect("live root must be cleaned up after native EOF")
    .unwrap();
    assert!(
        matches!(outcome, TerminalOutcome::Failed(ref reason) if reason.contains("closed stdout"))
    );
}

#[test]
fn issue87_native_eof_fixture() {
    if std::env::var("ECORP_ISSUE87_EOF_FIXTURE").as_deref() != Ok("1") {
        return;
    }
    // This branch runs only in the explicitly spawned child; it is harmless in
    // full Rust discovery. It exercises the real protocol and owned cleanup.
    use std::io::{BufRead, Write};
    for line in std::io::stdin().lock().lines() {
        let value: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let result = match value["method"].as_str() {
            Some("initialize") => json!({}),
            Some("thread/start") => json!({"thread":{"id":"eof-thread"}}),
            Some("turn/start") => {
                #[cfg(windows)]
                {
                    use std::os::windows::io::AsRawHandle;
                    unsafe {
                        windows_sys::Win32::Foundation::CloseHandle(
                            std::io::stdout().as_raw_handle() as _,
                        )
                    };
                }
                #[cfg(unix)]
                unsafe {
                    libc::close(libc::STDOUT_FILENO);
                }
                std::thread::sleep(Duration::from_secs(30));
                panic!("owned cleanup failed to terminate the live EOF fixture");
            }
            _ => continue,
        };
        writeln!(
            std::io::stdout(),
            "{}",
            json!({"id":value["id"], "result":result})
        )
        .unwrap();
        std::io::stdout().flush().unwrap();
    }
}

#[tokio::test]
async fn issue87_foreign_terminal_cannot_complete_the_active_turn() {
    let (exit, _, _) = stop_case(
        "foreign-terminal",
        "stop-fixture:foreign-terminal",
        false,
        true,
    )
    .await;
    assert_eq!(exit, AdapterExit::Cancelled);
}

#[tokio::test]
async fn issue87_same_thread_notification_cannot_replace_the_requested_turn() {
    let (exit, _, _) = stop_case("foreign-turn-before-response", "", false, false).await;
    assert_eq!(
        exit,
        AdapterExit::Cancelled,
        "only the correlated turn was interrupted"
    );
}

#[tokio::test]
async fn issue87_early_completion_waits_for_the_correlated_turn_response() {
    let (exit, workspace, sink) = stop_case("completed-before-response", "", false, false).await;
    assert_eq!(exit, AdapterExit::Completed);
    assert!(workspace.join("turn-response-written.txt").is_file());
    let response: Value = serde_json::from_slice(
        &std::fs::read(workspace.join("turn-response-written.txt")).unwrap(),
    )
    .unwrap();
    let response_at =
        chrono::DateTime::parse_from_rfc3339(response["observed_at"].as_str().unwrap()).unwrap();
    let (usage_at, usage) = observation(&sink, "usage_observed");
    let (terminal_at, terminal) = observation(&sink, "native_terminal");
    assert!(
        usage_at < response_at,
        "buffered usage must retain its receipt time"
    );
    assert!(
        terminal_at < response_at,
        "buffered completion must retain its receipt time"
    );
    assert_eq!(usage["after_adapter_control"], false);
    assert_eq!(terminal["after_adapter_control"], false);
    assert_eq!(usage["generation_time_known"], false);
    assert_eq!(usage["native_last"]["input_tokens"], 10);
    let (_, terminated) = observation(&sink, "process_terminated");
    assert_eq!(terminated["adapter_input_tokens"], 10);
    assert_eq!(terminated["adapter_output_tokens"], 2);
    let last_usage_at = chrono::DateTime::parse_from_rfc3339(
        terminated["last_usage_observed_at"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(last_usage_at, usage_at);
}

#[tokio::test]
async fn issue87_buffered_usage_cannot_extend_the_interrupt_deadline() {
    let (exit, _, _) = stop_case("delayed-output", "stop-fixture:turn-running", false, true).await;
    assert_eq!(exit, AdapterExit::Cancelled);
}

#[tokio::test]
async fn issue87_duplicate_and_unsolicited_startup_responses_are_ignored() {
    let (exit, _, sink) = stop_case("duplicate-startup", "", false, false).await;
    assert_eq!(
        exit,
        AdapterExit::Cancelled,
        "the correlated turn was interrupted"
    );
    let (_, terminal) = observation(&sink, "native_terminal");
    assert_eq!(terminal["turn_id"], "stop-fixture-turn");
}

#[tokio::test]
async fn issue87_early_notification_overflow_fails_with_owned_cleanup() {
    let (exit, _, sink) = stop_case("early-overflow", "", false, false).await;
    assert_eq!(exit, AdapterExit::Failed);
    assert!(sink.0.lock().unwrap().iter().any(|event| {
        matches!(event, AdapterEvent::Failed { error } if error.contains("early notifications exceeded"))
    }));
    observation(&sink, "process_terminated");
}

#[tokio::test]
async fn issue87_suspend_to_stop_cannot_extend_the_interrupt_deadline() {
    let mut fixture = StopFixture::start("delayed-output");
    fixture.marker("stop-fixture:turn-running").await;
    fixture
        .tx
        .send(AdapterControl::CircuitBreaker {
            stage: "suspend".into(),
            reason: "initial boundary".into(),
        })
        .unwrap();
    fixture.phase("adapter_received").await;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    fixture
        .tx
        .send(AdapterControl::Stop {
            reason: "escalated boundary".into(),
        })
        .unwrap();
    assert_eq!(fixture.finish().await, AdapterExit::Cancelled);
    let (received_at, _) = observation(&fixture.sink, "adapter_received");
    let (deadline_at, _) = observation(&fixture.sink, "interrupt_deadline");
    let elapsed = deadline_at
        .signed_duration_since(received_at)
        .num_milliseconds();
    assert!(
        (1900..2750).contains(&elapsed),
        "deadline after {elapsed} ms must remain anchored to suspend"
    );
    assert!(fixture.sink.0.lock().unwrap().iter().any(|event| {
        matches!(event, AdapterEvent::ControlObservation { phase: "adapter_received", detail, .. } if detail["escalation"] == true)
    }));
}

#[cfg(windows)]
#[tokio::test]
async fn issue87_codex_stop_terminates_the_owned_descendants() {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };
    let mut fixture = StopFixture::start("owned-tree");
    fixture.marker("stop-fixture:tree-running").await;
    let root: Value = serde_json::from_slice(
        &std::fs::read(fixture.workspace.join("stop-fixture-process.json")).unwrap(),
    )
    .unwrap();
    let children: Value = serde_json::from_slice(
        &std::fs::read(fixture.workspace.join("stop-fixture-tree.json")).unwrap(),
    )
    .unwrap();
    let handles: Vec<OwnedHandle> = [
        root["pid"].as_u64(),
        children["parent"].as_u64(),
        children["grandchild"].as_u64(),
    ]
    .into_iter()
    .map(|pid| {
        let raw =
            unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, u32::try_from(pid.unwrap()).unwrap()) };
        assert!(!raw.is_null(), "retain a native handle before termination");
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        assert_eq!(
            unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) },
            WAIT_TIMEOUT
        );
        handle
    })
    .collect();
    fixture
        .tx
        .send(AdapterControl::Stop {
            reason: "owned descendant regression".into(),
        })
        .unwrap();
    assert_eq!(fixture.finish().await, AdapterExit::Cancelled);
    // The handles identify the original processes even if their PIDs are reused.
    for handle in &handles {
        assert_eq!(
            unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) },
            WAIT_OBJECT_0
        );
    }
    let (_, terminated) = observation(&fixture.sink, "process_terminated");
    assert_eq!(terminated["scope"], "windows_job_object");
}

fn usage_frame(thread: &str, total: u64) -> Value {
    json!({ "threadId": thread, "turnId": "turn-1", "tokenUsage": {
        "total": { "totalTokens": total }, "last": { "inputTokens": 10, "outputTokens": 2 }
    } })
}

#[test]
fn issue87_cumulative_regressions_cannot_charge_again() {
    let mut parsed = ParsedRun {
        thread_id: Some("thread-1".into()),
        turn_id: Some("turn-1".into()),
        ..Default::default()
    };
    assert!(record_usage(&usage_frame("thread-1", 12), &mut parsed).is_some());
    assert!(record_usage(&usage_frame("thread-1", 10), &mut parsed).is_none());
    assert!(record_usage(&usage_frame("thread-1", 12), &mut parsed).is_none());
    assert_eq!(parsed.usage.input_tokens, 10);
}

#[test]
fn issue87_foreign_thread_usage_cannot_consume_the_current_budget() {
    let mut parsed = ParsedRun {
        thread_id: Some("thread-1".into()),
        turn_id: Some("turn-1".into()),
        ..Default::default()
    };
    assert!(record_usage(&usage_frame("other-thread", 12), &mut parsed).is_none());
    assert_eq!(parsed.last_usage_total, None);
}
