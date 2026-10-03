//! Cancellation-safe transport around Codex's native app-server protocol.
//! Native interruption is a request; only owned-process cleanup establishes termination.
use super::*;
use std::{future::Future, io, process::ExitStatus};
use tokio::process::{Child, ChildStdin};

const MAX_QUEUED_FRAMES: usize = 64;
const MAX_QUEUED_BYTES: usize = 8 * 1024 * 1024;
const MAX_PENDING_STEERS: usize = 32;

struct Frame {
    bytes: Vec<u8>,
    written: usize,
    id: Option<u64>,
    is_steer: bool,
}

struct BufferedNotification {
    value: Value,
    observed_at: String,
    after_adapter_control: bool,
    bytes: usize,
}

#[derive(Default)]
struct Outbox {
    frames: VecDeque<Frame>,
    bytes: usize,
}

impl Outbox {
    fn push(&mut self, value: Value) -> Result<(), AdapterError> {
        let mut bytes = serde_json::to_vec(&value).context("serialize Codex app-server request")?;
        bytes.push(b'\n');
        if self.frames.len() >= MAX_QUEUED_FRAMES
            || self.bytes.saturating_add(bytes.len()) > MAX_QUEUED_BYTES
        {
            return Err(anyhow!("Codex transport outbox exceeded its bounded capacity").into());
        }
        self.bytes += bytes.len();
        self.frames.push_back(Frame {
            bytes,
            written: 0,
            id: value.get("id").and_then(Value::as_u64),
            is_steer: value.get("method").and_then(Value::as_str) == Some("turn/steer"),
        });
        Ok(())
    }

    // AsyncWriteExt::write is cancellation-safe. Keep the cursor outside the
    // future; never await write_all from a control or stdout select handler.
    async fn write_once(&mut self, stdin: &mut ChildStdin) -> io::Result<Option<Frame>> {
        let frame = self.frames.front_mut().expect("nonempty outbox");
        let written = stdin.write(&frame.bytes[frame.written..]).await?;
        if written == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "Codex stdin closed",
            ));
        }
        frame.written += written;
        if frame.written == frame.bytes.len() {
            let frame = self.frames.pop_front().expect("written frame");
            self.bytes -= frame.bytes.len();
            Ok(Some(frame))
        } else {
            Ok(None)
        }
    }

    fn cancel_pending(&mut self) -> bool {
        let partial = self.frames.front().is_some_and(|frame| frame.written > 0);
        self.frames.clear();
        self.bytes = 0;
        partial
    }
}

struct Process {
    #[cfg(windows)]
    tree: super::super::process_tree::OwnedProcessTree,
    #[cfg(not(windows))]
    child: Child,
}

impl Process {
    fn spawn(command: &mut Command) -> io::Result<(Self, Option<io::Error>)> {
        #[cfg(windows)]
        {
            use super::super::process_tree::{OwnedProcessTree, OwnedProcessTreeSpawn};
            Ok(match OwnedProcessTree::spawn(command)? {
                OwnedProcessTreeSpawn::Ready(tree) => (Self { tree }, None),
                OwnedProcessTreeSpawn::CleanupRequired { tree, error } => {
                    (Self { tree }, Some(error))
                }
            })
        }
        #[cfg(not(windows))]
        {
            // Preserve existing Unix Codex support without claiming descendant
            // containment from a process group that descendants could escape.
            Ok((
                Self {
                    child: command.kill_on_drop(true).spawn()?,
                },
                None,
            ))
        }
    }

    fn child_mut(&mut self) -> &mut Child {
        #[cfg(windows)]
        {
            self.tree.child_mut()
        }
        #[cfg(not(windows))]
        {
            &mut self.child
        }
    }

    async fn terminate_and_wait(&mut self) -> io::Result<ExitStatus> {
        #[cfg(windows)]
        {
            self.tree.terminate_and_wait().await
        }
        #[cfg(not(windows))]
        {
            if self.child.try_wait()?.is_none() {
                self.child.start_kill()?;
            }
            tokio::time::timeout(Duration::from_secs(5), self.child.wait())
                .await
                .map_err(|_| {
                    io::Error::new(io::ErrorKind::TimedOut, "Codex root termination unverified")
                })?
        }
    }

    fn scope() -> &'static str {
        if cfg!(windows) {
            "windows_job_object"
        } else {
            "root_only"
        }
    }
}

pub(super) fn observe(sink: &Arc<dyn AdapterEventSink>, phase: &'static str, detail: Value) {
    sink.emit(AdapterEvent::ControlObservation {
        phase,
        observed_at: chrono::Utc::now().to_rfc3339(),
        detail,
    });
}

fn record_termination(
    control: &AdapterControl,
    termination: &mut Option<TerminationRequest>,
    sink: &Arc<dyn AdapterEventSink>,
) -> bool {
    let (kind, reason, directive) = match control {
        AdapterControl::Stop { reason } => (TerminationKind::Stop, reason.clone(), "stop"),
        AdapterControl::Interrupt { reason } => {
            (TerminationKind::Interrupt, reason.clone(), "interrupt")
        }
        AdapterControl::CircuitBreaker { stage, reason }
            if matches!(stage.as_str(), "suspend" | "stop") =>
        {
            (
                if stage == "stop" {
                    TerminationKind::Stop
                } else {
                    TerminationKind::Interrupt
                },
                format!("Circuit breaker {stage} checkpoint: {reason}"),
                stage.as_str(),
            )
        }
        _ => return false,
    };
    let escalation = termination.as_ref().is_some_and(|current| {
        matches!(current.kind, TerminationKind::Interrupt) && matches!(kind, TerminationKind::Stop)
    });
    if let Some(current) = termination {
        if escalation {
            current.kind = kind;
            current.reason = reason;
        }
    } else {
        *termination = Some(TerminationRequest {
            kind,
            reason,
            received_at: Instant::now(),
        });
    }
    observe(
        sink,
        "adapter_received",
        json!({
            "directive": directive, "escalation": escalation,
            "interrupt_grace_ms": INTERRUPT_TIMEOUT.as_millis(),
            "deadline_extended": false,
        }),
    );
    true
}

// Keep stop races observable during cleanup and local evidence collection. A
// pending cleanup future is pinned once; controls cannot restart its deadline.
pub(super) async fn finish<F: Future>(
    work: F,
    controls: &mut mpsc::UnboundedReceiver<AdapterControl>,
    controls_open: &mut bool,
    termination: &mut Option<TerminationRequest>,
    sink: &Arc<dyn AdapterEventSink>,
) -> F::Output {
    tokio::pin!(work);
    loop {
        tokio::select! {
            biased;
            result = &mut work => {
                // Give an already queued stop precedence over success without
                // allowing a flood of directions to starve process cleanup.
                for _ in 0..MAX_QUEUED_FRAMES {
                    match controls.try_recv() {
                        Ok(control) => { record_termination(&control, termination, sink); }
                        Err(_) => return result,
                    }
                }
                if !controls.is_empty() {
                    record_termination(&AdapterControl::Stop {
                        reason: "control backlog exceeded capacity during finalization".to_owned(),
                    }, termination, sink);
                }
                return result;
            }
            control = controls.recv(), if *controls_open => match control {
                Some(control) => { record_termination(&control, termination, sink); }
                None => *controls_open = false,
            },
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn execute(
    command: &mut Command,
    request: &AdapterRunRequest,
    mode: &CodexMode,
    controls: &mut mpsc::UnboundedReceiver<AdapterControl>,
    controls_open: &mut bool,
    sink: &Arc<dyn AdapterEventSink>,
    parsed: &mut ParsedRun,
    termination: &mut Option<TerminationRequest>,
) -> Result<TerminalOutcome, AdapterError> {
    let (mut process, setup_error) =
        Process::spawn(command).context("spawn owned Codex app-server")?;
    let mut stderr_task = None;
    let result: Result<TerminalOutcome, AdapterError> = async {
        if let Some(error) = setup_error {
            return Err(error.into());
        }
        let child = process.child_mut();
        let stdin = child
            .stdin
            .take()
            .context("Codex app-server stdin missing")?;
        let stdout = child
            .stdout
            .take()
            .context("Codex app-server stdout missing")?;
        let stderr = child
            .stderr
            .take()
            .context("Codex app-server stderr missing")?;
        let stderr_sink = sink.clone();
        stderr_task = Some(tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                stderr_sink.emit(AdapterEvent::Output {
                    stream: "stderr".to_owned(),
                    text: line,
                });
            }
        }));
        protocol(
            stdin,
            stdout,
            request,
            mode,
            controls,
            controls_open,
            sink,
            parsed,
            termination,
        )
        .await
    }
    .await;

    // No protocol return, error, closed pipe or timed-out interrupt may bypass
    // owned teardown. Retain supervision and the workspace if verification fails.
    let mut reported_uncertainty = false;
    loop {
        match finish(
            process.terminate_and_wait(),
            controls,
            controls_open,
            termination,
            sink,
        )
        .await
        {
            Ok(status) => {
                observe(
                    sink,
                    "process_terminated",
                    json!({
                        "scope": Process::scope(), "exit_status": status.to_string(),
                        "last_usage_observed_at": parsed.last_usage_observed_at,
                    "adapter_input_tokens": parsed.usage.report().input_tokens,
                    "adapter_output_tokens": parsed.usage.report().output_tokens,
                    }),
                );
                break;
            }
            Err(error) => {
                if !reported_uncertainty {
                    sink.emit(AdapterEvent::TeardownUncertain {
                        detail: format!(
                            "Codex {} cleanup remains unverified: {error}",
                            Process::scope()
                        ),
                    });
                    reported_uncertainty = true;
                }
                finish(
                    tokio::time::sleep(Duration::from_secs(1)),
                    controls,
                    controls_open,
                    termination,
                    sink,
                )
                .await;
            }
        }
    }
    if let Some(task) = stderr_task {
        task.abort();
        let _ = task.await;
    }
    Ok(if let Some(requested) = termination.as_ref() {
        TerminalOutcome::Cancelled(terminal_reason(requested))
    } else {
        result.unwrap_or_else(|error| TerminalOutcome::Failed(error.to_string()))
    })
}

fn notification_outcome(
    value: &Value,
    observed_at: &str,
    after_adapter_control: bool,
    parsed: &mut ParsedRun,
    termination: &Option<TerminationRequest>,
    sink: &Arc<dyn AdapterEventSink>,
) -> Option<TerminalOutcome> {
    let method = value.get("method").and_then(Value::as_str)?;
    if method == "thread/tokenUsage/updated" && active_notification(value, parsed) {
        let before = parsed.last_usage_total;
        handle_notification(value, parsed, sink.clone());
        parsed.last_usage_observed_at = Some(observed_at.to_owned());
        // Retain native counters and their actual receipt time, including frames
        // buffered before the correlated turn response. This is not generation time.
        let counters = |name: &str| {
            let raw = &value["params"]["tokenUsage"][name];
            json!({ "input_tokens": raw["inputTokens"].as_u64(), "output_tokens": raw["outputTokens"].as_u64(), "total_tokens": raw["totalTokens"].as_u64() })
        };
        sink.emit(AdapterEvent::ControlObservation {
            phase: "usage_observed",
            observed_at: observed_at.to_owned(),
            detail: json!({
                "thread_id": parsed.thread_id, "turn_id": parsed.turn_id,
                "native_total": counters("total"), "native_last": counters("last"),
                "monotonic_report": parsed.last_usage_total != before,
                "after_adapter_control": after_adapter_control,
                "generation_time_known": false,
            }),
        });
    } else if termination.is_none() {
        handle_notification(value, parsed, sink.clone());
    }
    if method != "turn/completed" || !active_notification(value, parsed) {
        return None;
    }
    let status = value
        .pointer("/params/turn/status")
        .and_then(Value::as_str)
        .unwrap_or("failed");
    sink.emit(AdapterEvent::ControlObservation {
        phase: "native_terminal",
        observed_at: observed_at.to_owned(),
        detail: json!({
            "status": status, "thread_id": parsed.thread_id, "turn_id": parsed.turn_id,
            "after_adapter_control": after_adapter_control,
        }),
    });
    Some(if let Some(requested) = termination.as_ref() {
        TerminalOutcome::Cancelled(terminal_reason(requested))
    } else {
        match status {
            "completed" => TerminalOutcome::Completed,
            "interrupted" => TerminalOutcome::Cancelled("Codex interrupted the turn".to_owned()),
            _ => TerminalOutcome::Failed(
                value
                    .pointer("/params/turn/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex turn failed")
                    .to_owned(),
            ),
        }
    })
}

#[allow(clippy::too_many_arguments)]
async fn protocol(
    mut stdin: ChildStdin,
    stdout: tokio::process::ChildStdout,
    request: &AdapterRunRequest,
    mode: &CodexMode,
    controls: &mut mpsc::UnboundedReceiver<AdapterControl>,
    controls_open: &mut bool,
    sink: &Arc<dyn AdapterEventSink>,
    parsed: &mut ParsedRun,
    termination: &mut Option<TerminationRequest>,
) -> Result<TerminalOutcome, AdapterError> {
    let mut outbox = Outbox::default();
    outbox.push(json!({
        "method": "initialize", "id": INITIALIZE_REQUEST_ID,
        "params": { "clientInfo": { "name": "ecorp-operations", "title": "ECorp Runner", "version": env!("CARGO_PKG_VERSION") }, "capabilities": { "experimentalApi": true } }
    }))?;
    let mut lines = BufReader::new(stdout).lines();
    let mut pending_steers = VecDeque::<(Uuid, String)>::new();
    let mut pending_bytes = 0_usize;
    let mut next_request_id = 10_u64;
    let mut initialize_written = false;
    let mut initialized = false;
    let mut thread_written = false;
    let mut thread_received = false;
    let mut turn_written = false;
    let mut turn_received = false;
    let mut termination_handled = false;
    let mut interrupt_id = None;
    let mut interrupt_responded = false;
    let mut early_notifications = VecDeque::<BufferedNotification>::new();
    let mut early_bytes = 0_usize;
    let startup_deadline = Instant::now() + STARTUP_TIMEOUT;

    loop {
        if let Some(requested) = termination.as_ref() {
            if !termination_handled {
                termination_handled = true;
                pending_steers.clear();
                pending_bytes = 0;
                let partial = outbox.cancel_pending();
                if partial || !turn_written {
                    observe(
                        sink,
                        "transport_closed",
                        json!({ "partial_frame": partial, "turn_start_written": turn_written }),
                    );
                    return Ok(TerminalOutcome::Cancelled(terminal_reason(requested)));
                }
            }
            if interrupt_id.is_none()
                && let (Some(thread_id), Some(turn_id)) =
                    (parsed.thread_id.as_deref(), parsed.turn_id.as_deref())
            {
                let id = next_request_id;
                next_request_id += 1;
                outbox.push(json!({ "id": id, "method": "turn/interrupt", "params": { "threadId": thread_id, "turnId": turn_id } }))?;
                interrupt_id = Some(id);
                observe(
                    sink,
                    "interrupt_queued",
                    json!({ "request_id": id, "thread_id": thread_id, "turn_id": turn_id }),
                );
            }
        } else if let (Some(thread_id), Some(turn_id)) =
            (parsed.thread_id.as_deref(), parsed.turn_id.as_deref())
        {
            while let Some((actor_id, text)) = pending_steers.pop_front() {
                pending_bytes -= text.len();
                outbox.push(steer_request(
                    &mut next_request_id,
                    thread_id,
                    turn_id,
                    actor_id,
                    &text,
                ))?;
            }
        }
        let interrupt_deadline = termination
            .as_ref()
            .map(|requested| requested.received_at + INTERRUPT_TIMEOUT);
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(interrupt_deadline.unwrap_or(startup_deadline)), if interrupt_deadline.is_some() => {
                observe(sink, "interrupt_deadline", json!({ "interrupt_request_id": interrupt_id }));
                return Ok(TerminalOutcome::Cancelled(termination.as_ref().map(terminal_reason).unwrap_or_default()));
            }
            _ = tokio::time::sleep_until(startup_deadline), if parsed.turn_id.is_none() && termination.is_none() => {
                return Ok(TerminalOutcome::Failed(format!("Codex app-server did not start a turn within {} seconds", STARTUP_TIMEOUT.as_secs())));
            }
            control = controls.recv(), if *controls_open => {
                let Some(control) = control else { *controls_open = false; continue; };
                if record_termination(&control, termination, sink) || termination.is_some() { continue; }
                let steer = match control {
                    AdapterControl::Steer { actor_id, text } => Some((actor_id, text)),
                    AdapterControl::ApprovalDecision { approval_id, approved, note } => Some((Uuid::nil(),
                        if approved { format!("Approval {approval_id} was granted. Continue the suspended action. Decision note: {note}") }
                        else { format!("Approval {approval_id} was rejected. Do not perform the action. Decision note: {note}") })),
                    AdapterControl::CircuitBreaker { stage, reason } => {
                        observe(sink, "adapter_received", json!({ "directive": stage }));
                        Some((Uuid::nil(), format!("Circuit breaker stage {stage}: {reason}")))
                    }
                    _ => None,
                };
                if let Some((actor_id, text)) = steer {
                    if pending_steers.len() >= MAX_PENDING_STEERS || pending_bytes.saturating_add(text.len()) > MAX_QUEUED_BYTES {
                        return Err(anyhow!("Codex pending directions exceeded their bounded capacity").into());
                    }
                    pending_bytes += text.len();
                    pending_steers.push_back((actor_id, text));
                }
            }
            written = outbox.write_once(&mut stdin), if !outbox.frames.is_empty() => {
                let Some(frame) = written? else { continue; };
                if frame.is_steer {
                    sink.emit(AdapterEvent::Output {
                        stream: "control".to_owned(),
                        text: "Forwarded live direction to Codex.".to_owned(),
                    });
                }
                match frame.id {
                    Some(INITIALIZE_REQUEST_ID) => initialize_written = true,
                    Some(THREAD_REQUEST_ID) => thread_written = true,
                    Some(TURN_REQUEST_ID) => turn_written = true,
                    Some(id) if Some(id) == interrupt_id => observe(sink, "interrupt_written", json!({ "request_id": id })),
                    _ => {}
                }
            }
            notification = async { early_notifications.pop_front().expect("buffered notification") }, if turn_received && !early_notifications.is_empty() => {
                early_bytes -= notification.bytes;
                if let Some(outcome) = notification_outcome(&notification.value, &notification.observed_at, notification.after_adapter_control, parsed, termination, sink) {
                    return Ok(outcome);
                }
            }
            line = lines.next_line() => {
                let Some(line) = line? else {
                    return Ok(TerminalOutcome::Failed("Codex app-server closed stdout before a terminal turn event".to_owned()));
                };
                let observed_at = chrono::Utc::now().to_rfc3339();
                let after_adapter_control = termination.is_some();
                let value: Value = match serde_json::from_str(&line) {
                    Ok(value) => value,
                    Err(_) => {
                        sink.emit(AdapterEvent::Output { stream: "stdout".to_owned(), text: line });
                        continue;
                    }
                };
                if value.get("method").is_some() && value.get("id").is_some() {
                    if termination.is_none() { outbox.push(server_response(&value, sink.clone())?)?; }
                    continue;
                }
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    if Some(id) == interrupt_id {
                        if !interrupt_responded {
                            interrupt_responded = true;
                            observe(sink, "interrupt_responded", json!({ "request_id": id, "succeeded": value.get("error").is_none() }));
                        }
                        continue;
                    }
                    let pending_startup = match id {
                        INITIALIZE_REQUEST_ID => initialize_written && !initialized,
                        THREAD_REQUEST_ID => thread_written && !thread_received,
                        TURN_REQUEST_ID => turn_written && !turn_received,
                        _ => false,
                    };
                    // Duplicate or unsolicited startup responses cannot alter
                    // the active operation, including delayed error responses.
                    if id <= TURN_REQUEST_ID && !pending_startup { continue; }
                    if let Some(error) = rpc_error(&value) {
                        if id <= TURN_REQUEST_ID { return Ok(TerminalOutcome::Failed(error)); }
                        sink.emit(AdapterEvent::Output { stream: "stderr".to_owned(), text: error });
                        continue;
                    }
                    match id {
                        INITIALIZE_REQUEST_ID if initialize_written && !initialized && termination.is_none() => {
                            initialized = true;
                            outbox.push(json!({ "method": "initialized", "params": {} }))?;
                            let mut params = json!({ "cwd": request.workspace, "approvalPolicy": "never", "sandbox": "workspace-write" });
                            let method = match mode {
                                CodexMode::Start => {
                                    params["ephemeral"] = Value::Bool(false);
                                    params["threadSource"] = Value::String("ecorp-operations".into());
                                    "thread/start"
                                }
                                CodexMode::Resume { session_id } => { params["threadId"] = Value::String(session_id.clone()); "thread/resume" }
                            };
                            outbox.push(json!({ "method": method, "id": THREAD_REQUEST_ID, "params": params }))?;
                        }
                        THREAD_REQUEST_ID if thread_written && !thread_received && termination.is_none() => {
                            let id = value.pointer("/result/thread/id").and_then(Value::as_str).context("Codex thread response omitted result.thread.id")?;
                            if parsed.thread_id.as_deref().is_some_and(|expected| expected != id) { return Err(anyhow!("Codex resumed a different thread").into()); }
                            thread_received = true;
                            parsed.thread_id = Some(id.to_owned());
                            sink.emit(AdapterEvent::Session { session_id: id.to_owned() });
                            outbox.push(turn_start_request(request, id))?;
                        }
                        TURN_REQUEST_ID if turn_written && !turn_received => {
                            let id = value.pointer("/result/turn/id").and_then(Value::as_str).context("Codex turn response omitted result.turn.id")?;
                            if parsed.turn_id.as_deref().is_some_and(|expected| expected != id) { return Err(anyhow!("Codex returned a different active turn").into()); }
                            turn_received = true;
                            parsed.turn_id = Some(id.to_owned());
                        }
                        _ => {}
                    }
                } else if let Some(method) = value.get("method").and_then(Value::as_str) {
                    if turn_written && !turn_received
                        && value.pointer("/params/threadId").and_then(Value::as_str) == parsed.thread_id.as_deref()
                        && (method.starts_with("turn/") || method.starts_with("item/") || method == "thread/tokenUsage/updated")
                    {
                        // Only the response to our turn/start identifies the turn.
                        // Preserve early native events without trusting their order
                        // or allowing a foreign turn to establish that identity.
                        if early_notifications.len() >= MAX_QUEUED_FRAMES || early_bytes.saturating_add(line.len()) > MAX_QUEUED_BYTES {
                            return Err(anyhow!("Codex early notifications exceeded their bounded capacity").into());
                        }
                        early_bytes += line.len();
                        early_notifications.push_back(BufferedNotification {
                            value, observed_at, after_adapter_control, bytes: line.len(),
                        });
                        continue;
                    }
                    if let Some(outcome) = notification_outcome(&value, &observed_at, after_adapter_control, parsed, termination, sink) {
                        return Ok(outcome);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Sink(Mutex<Vec<AdapterEvent>>);

    impl AdapterEventSink for Sink {
        fn emit(&self, event: AdapterEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    #[test]
    fn issue87_buffered_observations_keep_receipt_time_and_control_state() {
        let retained = Arc::new(Sink::default());
        let sink: Arc<dyn AdapterEventSink> = retained.clone();
        let mut parsed = ParsedRun {
            thread_id: Some("thread".into()),
            turn_id: Some("turn".into()),
            ..Default::default()
        };
        let termination = Some(TerminationRequest {
            kind: TerminationKind::Stop,
            reason: "stop after receipt".into(),
            received_at: Instant::now(),
        });
        let received_at = "2026-10-01T00:00:00Z";
        let usage = json!({
            "method": "thread/tokenUsage/updated",
            "params": { "threadId": "thread", "turnId": "turn", "tokenUsage": {
                "total": { "totalTokens": 12 },
                "last": { "inputTokens": 10, "outputTokens": 2 }
            } }
        });
        assert!(
            notification_outcome(&usage, received_at, false, &mut parsed, &termination, &sink,)
                .is_none()
        );
        let terminal = json!({
            "method": "turn/completed",
            "params": { "threadId": "thread", "turn": { "id": "turn", "status": "completed" } }
        });
        assert!(matches!(
            notification_outcome(
                &terminal,
                received_at,
                false,
                &mut parsed,
                &termination,
                &sink,
            ),
            Some(TerminalOutcome::Cancelled(_))
        ));
        let events = retained.0.lock().unwrap();
        let observations: Vec<_> = events
            .iter()
            .filter_map(|event| {
                if let AdapterEvent::ControlObservation {
                    observed_at,
                    detail,
                    ..
                } = event
                {
                    Some((observed_at, detail))
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(observations.len(), 2);
        for (observed_at, detail) in observations {
            assert_eq!(observed_at, received_at);
            assert_eq!(detail["after_adapter_control"], false);
        }
    }

    #[tokio::test]
    async fn issue87_queued_stop_wins_when_finalization_is_already_ready() {
        let (tx, mut controls) = mpsc::unbounded_channel();
        tx.send(AdapterControl::Stop {
            reason: "queued during cleanup".into(),
        })
        .unwrap();
        let sink: Arc<dyn AdapterEventSink> = Arc::new(Sink::default());
        let mut termination = None;
        let result = finish(
            std::future::ready(42),
            &mut controls,
            &mut true,
            &mut termination,
            &sink,
        )
        .await;
        assert_eq!(result, 42);
        assert!(matches!(
            termination,
            Some(TerminationRequest {
                kind: TerminationKind::Stop,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn issue87_control_backlog_cannot_starve_ready_cleanup_or_admit_completion() {
        let (tx, mut controls) = mpsc::unbounded_channel();
        for _ in 0..100 {
            tx.send(AdapterControl::Steer {
                actor_id: Uuid::nil(),
                text: "pending".into(),
            })
            .unwrap();
        }
        let sink: Arc<dyn AdapterEventSink> = Arc::new(Sink::default());
        let mut termination = None;
        let result = finish(
            std::future::ready(42),
            &mut controls,
            &mut true,
            &mut termination,
            &sink,
        )
        .await;
        assert_eq!(result, 42, "already completed cleanup must be polled first");
        assert_eq!(controls.len(), 100 - MAX_QUEUED_FRAMES);
        assert!(matches!(
            termination,
            Some(TerminationRequest {
                kind: TerminationKind::Stop,
                ..
            })
        ));
    }
}
