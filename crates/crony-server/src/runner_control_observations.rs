//! Observe successful native socket sends without delaying urgent control delivery.
use super::*;
use crony_store::RunnerCommandSocketSend;
use tokio::sync::watch;

type SocketIdentity = Option<(String, Uuid, Uuid)>;

pub(super) fn spawn_writer(
    mut sender: futures_util::stream::SplitSink<WebSocket, Message>,
    mut commands: mpsc::UnboundedReceiver<ServerToRunner>,
    state: AppState,
) -> (watch::Sender<SocketIdentity>, tokio::task::JoinHandle<()>) {
    let (identity_tx, identity_rx) = watch::channel::<SocketIdentity>(None);
    let (observations_tx, mut observations_rx) = mpsc::channel::<RunnerCommandSocketSend>(64);
    // A bounded observer drains after the writer exits. Database latency cannot
    // hold up an interrupt. Missing observations are explicit, never send claims.
    tokio::spawn(async move {
        while let Some(observation) = observations_rx.recv().await {
            let command_id = observation.command_id;
            match tokio::time::timeout(
                StdDuration::from_secs(5),
                state.store.record_runner_command_socket_send(observation),
            )
            .await
            {
                Ok(Ok(Some(event))) => publish(&state, event),
                Ok(Ok(None)) => {}
                Ok(Err(error)) => {
                    warn!(%error, %command_id, "socket-send observation was not persisted")
                }
                Err(_) => warn!(%command_id, "socket-send observation persistence timed out"),
            }
        }
    });
    let writer = tokio::spawn(async move {
        while let Some(command) = commands.recv().await {
            let identity = identity_rx.borrow().clone();
            if send_json(&mut sender, &command).await.is_err() {
                break;
            }
            let sent_at = Utc::now();
            if let ServerToRunner::CircuitBreaker {
                command_id, run_id, ..
            } = command
            {
                let Some((runner_id, corp_id, connection_epoch)) = identity else {
                    warn!(%command_id, "sent control lacks authenticated socket observation");
                    continue;
                };
                let observation = RunnerCommandSocketSend {
                    corp_id,
                    runner_id,
                    connection_epoch,
                    command_id,
                    run_id,
                    sent_at,
                };
                if observations_tx.try_send(observation).is_err() {
                    warn!(%command_id, "socket-send observer unavailable or full; observation missing");
                }
            }
        }
    });
    (identity_tx, writer)
}
