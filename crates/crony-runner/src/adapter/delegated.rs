//! Native receipt-only worker. Delegated identity never enters a provider session.
use std::{
    io::{Read, Seek, Write},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, bail, ensure};
use async_trait::async_trait;
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{ambient_authority, fs::Dir};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use url::Url;
use uuid::Uuid;

use super::{
    AdapterArtifact, AdapterCapabilities, AdapterControl, AdapterError, AdapterEvent,
    AdapterEventSink, AdapterExit, AdapterRunRequest, AgentAdapter, FeatureSupport,
};

const RECEIPT_FILE: &str = "delegated-result.json";
const MAX_RESPONSE_BYTES: usize = 8192;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const AUTH_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Serialize)]
pub struct TrustedAssignment {
    pub run_id: Uuid,
    pub task_id: Uuid,
    pub runner_id: String,
    pub connection_epoch: Uuid,
    pub assignment_token: Uuid,
    #[serde(skip)]
    pub server_http_url: Url,
}

impl std::fmt::Debug for TrustedAssignment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrustedAssignment")
            .field("run_id", &self.run_id)
            .field("task_id", &self.task_id)
            .field("runner_id", &self.runner_id)
            .field("connection_epoch", &self.connection_epoch)
            .finish_non_exhaustive()
    }
}

/// Preserve the configured authority; never infer a host from task content.
pub fn server_http_url(websocket: &str) -> anyhow::Result<Url> {
    let mut url = Url::parse(websocket).context("invalid configured runner server URL")?;
    let scheme = match url.scheme() {
        "ws" => "http",
        "wss" => "https",
        _ => bail!("runner server URL must use ws or wss"),
    };
    ensure!(
        url.host_str().is_some() && url.username().is_empty() && url.password().is_none(),
        "runner server URL must have a host and no embedded credentials"
    );
    url.set_scheme(scheme)
        .map_err(|()| anyhow::anyhow!("invalid runner server URL scheme"))?;
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    schema_version: u32,
    operation_id: Uuid,
    run_id: Uuid,
    task_id: Uuid,
    resource: String,
    sha256: String,
    subject_preserved: bool,
    verified: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadResponse {
    status: String,
    #[serde(default)]
    receipt: Option<Receipt>,
}

impl Receipt {
    fn validate(&self, scope: &TrustedAssignment) -> anyhow::Result<()> {
        ensure!(
            self.schema_version == 1
                && !self.operation_id.is_nil()
                && self.run_id == scope.run_id
                && self.task_id == scope.task_id
                && self.resource == "protected-flag"
                && self.sha256.len() == 64
                && self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                && self.subject_preserved
                && self.verified,
            "delegated response receipt failed scope or integrity validation"
        );
        Ok(())
    }
}

pub struct DelegatedResourceAdapter;

#[async_trait]
impl AgentAdapter for DelegatedResourceAdapter {
    fn id(&self) -> &'static str {
        "delegated-resource"
    }

    fn display_name(&self) -> &'static str {
        "Native delegated protected-resource read"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        let unsupported = FeatureSupport::Unsupported {
            reason: "native bounded receipt worker has no model or resumable provider".to_owned(),
        };
        AdapterCapabilities {
            spawn: FeatureSupport::Supported,
            stream: FeatureSupport::Supported,
            steer: unsupported.clone(),
            interrupt: FeatureSupport::Supported,
            stop: FeatureSupport::Supported,
            resume: unsupported.clone(),
            usage: unsupported,
            artifacts: FeatureSupport::Supported,
        }
    }

    async fn execute(
        &self,
        request: AdapterRunRequest,
        mut controls: mpsc::UnboundedReceiver<AdapterControl>,
        sink: Arc<dyn AdapterEventSink>,
    ) -> Result<AdapterExit, AdapterError> {
        let operation = read_receipt(&request, sink.as_ref(), POLL_INTERVAL);
        tokio::pin!(operation);
        let deadline = tokio::time::sleep(AUTH_TIMEOUT);
        tokio::pin!(deadline);
        // Dropping the in-flight HTTP future closes it. Controls are biased ahead
        // of readiness so a delivered cancellation cannot publish a late receipt.
        let receipt = loop {
            tokio::select! {
                biased;
                control = controls.recv() => {
                    match control {
                        Some(AdapterControl::Steer { .. } | AdapterControl::ApprovalDecision { .. }) => {}
                        _ => {
                            sink.emit(AdapterEvent::Cancelled {
                                reason: "Delegated read cancelled; fresh authorization requires a new assignment.".to_owned(),
                            });
                            return Ok(AdapterExit::Cancelled);
                        }
                    }
                }
                _ = &mut deadline => {
                    sink.emit(AdapterEvent::Failed { error: "Delegated authentication wait expired.".to_owned() });
                    return Ok(AdapterExit::Failed);
                }
                result = &mut operation => break result,
            }
        };
        if cancelled(&mut controls) {
            sink.emit(AdapterEvent::Cancelled {
                reason: "Delegated read cancelled.".to_owned(),
            });
            return Ok(AdapterExit::Cancelled);
        }
        let result = receipt.and_then(|receipt| persist_receipt(&request, &receipt));
        match result {
            Ok(artifact) => {
                if cancelled(&mut controls) {
                    sink.emit(AdapterEvent::Cancelled {
                        reason: "Delegated read cancelled.".to_owned(),
                    });
                    return Ok(AdapterExit::Cancelled);
                }
                sink.emit(AdapterEvent::Artifact(artifact));
                // RunnerEventSink buffers this until normal persisted verification.
                sink.emit(AdapterEvent::Completed {
                    summary: "Delegated read returned a subject-preserving verified receipt."
                        .to_owned(),
                });
                Ok(AdapterExit::Completed)
            }
            Err(_) => {
                // Never echo server response text, HTTP errors, or scope credentials.
                sink.emit(AdapterEvent::Failed {
                    error: "Delegated read failed closed (scope, provider, transport, receipt, or workspace).".to_owned(),
                });
                Ok(AdapterExit::Failed)
            }
        }
    }
}

fn cancelled(controls: &mut mpsc::UnboundedReceiver<AdapterControl>) -> bool {
    loop {
        match controls.try_recv() {
            Ok(AdapterControl::Steer { .. } | AdapterControl::ApprovalDecision { .. }) => {}
            Err(mpsc::error::TryRecvError::Empty) => return false,
            _ => return true,
        }
    }
}

async fn read_receipt(
    request: &AdapterRunRequest,
    sink: &dyn AdapterEventSink,
    poll_interval: Duration,
) -> anyhow::Result<Receipt> {
    let scope = request
        .trusted_assignment
        .as_ref()
        .context("missing trusted assignment")?;
    ensure!(
        scope.run_id == request.run_id
            && scope.task_id == request.task_id
            && !scope.run_id.is_nil()
            && !scope.task_id.is_nil()
            && !scope.connection_epoch.is_nil()
            && !scope.assignment_token.is_nil()
            && !scope.runner_id.trim().is_empty()
            && request.environment.is_empty()
            && request.write_scope == [RECEIPT_FILE],
        "invalid delegated assignment boundary"
    );
    let mut endpoint = scope.server_http_url.clone();
    ensure!(
        matches!(endpoint.scheme(), "http" | "https")
            && endpoint.host_str().is_some()
            && endpoint.username().is_empty()
            && endpoint.password().is_none()
            && endpoint.query().is_none()
            && endpoint.fragment().is_none()
            && endpoint.path() == "/",
        "invalid trusted server origin"
    );
    endpoint.set_path("/api/delegated/runner/read");
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(REQUEST_TIMEOUT)
        .build()
        .context("create delegated HTTP client")?;
    sink.emit(AdapterEvent::Started {
        workspace: request.workspace.clone(),
    });
    let mut announced_wait = false;
    loop {
        let mut response = client
            .post(endpoint.as_str())
            .header("content-type", "application/json")
            .body(serde_json::to_vec(scope)?)
            .send()
            .await?;
        let status = response.status().as_u16();
        ensure!(matches!(status, 200 | 202), "delegated read denied");
        ensure!(
            response
                .content_length()
                .is_none_or(|length| length <= MAX_RESPONSE_BYTES as u64),
            "oversized delegated response"
        );
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                body.len() + chunk.len() <= MAX_RESPONSE_BYTES,
                "oversized delegated response"
            );
            body.extend_from_slice(&chunk);
        }
        let response: ReadResponse = serde_json::from_slice(&body)?;
        match (status, response.status.as_str(), response.receipt) {
            (200, "ready", Some(receipt)) => {
                receipt.validate(scope)?;
                return Ok(receipt);
            }
            (202, "authentication_required" | "waiting_for_authentication", None) => {
                if !announced_wait {
                    sink.emit(AdapterEvent::Status {
                        status: "waiting_for_input".to_owned(),
                        station: "desk".to_owned(),
                        message: "Waiting for delegated resource authentication.".to_owned(),
                    });
                    announced_wait = true;
                }
                tokio::time::sleep(poll_interval).await;
            }
            _ => bail!("invalid delegated response"),
        }
    }
}

fn persist_receipt(
    request: &AdapterRunRequest,
    receipt: &Receipt,
) -> anyhow::Result<AdapterArtifact> {
    let bytes = serde_json::to_vec_pretty(receipt)?;
    let dir = Dir::open_ambient_dir(&request.workspace, ambient_authority())?;
    // Exact root-relative create-new avoids links, aliases, and overwriting an
    // existing source file. No resource bytes or credentials are written.
    let mut options = cap_std::fs::OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let mut file = dir.open_with(RECEIPT_FILE, &options)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    file.rewind()?;
    let mut persisted = Vec::new();
    file.take(MAX_RESPONSE_BYTES as u64 + 1)
        .read_to_end(&mut persisted)?;
    ensure!(persisted == bytes, "receipt changed during persistence");
    Ok(AdapterArtifact {
        path: request.workspace.join(RECEIPT_FILE),
        sha256: hex::encode(Sha256::digest(&persisted)),
        bytes: persisted.len(),
        media_type: "application/json".to_owned(),
    })
}

#[cfg(test)]
mod tests;
