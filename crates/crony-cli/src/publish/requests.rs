//! A bounded delivery adapter for saved human intent. All remote effects remain
//! in `execute_publication`; this module neither creates intent nor signs runs.
use super::*;

use crony_protocol::publication_requests::PublisherQueueResponse;

#[derive(Debug, Args)]
pub struct FactoryPublisherWatchArgs {
    pub corp_id: Uuid,
    #[arg(long)]
    pub repository: String,
    #[arg(long, env = "ECORP_PUBLICATION_PUBLISHER_CREDENTIAL_FILE")]
    pub publisher_credential_file: PathBuf,
    #[arg(long, env = "ECORP_GITHUB_CLI", default_value = "gh")]
    pub github_cli: PathBuf,
    #[arg(long, default_value_t = 300)]
    pub lease_seconds: i64,
    #[arg(long, default_value_t = 15)]
    pub poll_interval_seconds: u64,
    #[arg(long, default_value_t = 240)]
    pub polls: u32,
    #[arg(long, default_value_t = 25)]
    pub page_size: usize,
    #[arg(long, default_value_t = 40)]
    pub max_pages: u32,
    #[arg(long, default_value_t = 25)]
    pub max_attempts: usize,
}

impl FactoryPublisherWatchArgs {
    fn validate(&mut self) -> Result<()> {
        self.repository = normalize_publication_repository(&self.repository)?;
        if !(5..=3_600).contains(&self.lease_seconds)
            || !(1..=3_600).contains(&self.poll_interval_seconds)
            || !(1..=240).contains(&self.polls)
            || !(1..=100).contains(&self.page_size)
            || !(1..=100).contains(&self.max_pages)
            || !(1..=100).contains(&self.max_attempts)
        {
            bail!("publisher watch limits are outside the supported bounds");
        }
        if !self.publisher_credential_file.is_file() {
            bail!("trusted publication publisher credential file does not exist");
        }
        Ok(())
    }
}

pub async fn watch(
    client: &Client,
    server: &str,
    mut args: FactoryPublisherWatchArgs,
) -> Result<Value> {
    args.validate()?;
    let mut results = Vec::new();
    let mut pages = 0_u32;
    let mut polls = 0_u32;
    'polls: for poll in 0..args.polls {
        polls += 1;
        let mut after = None;
        for _ in 0..args.max_pages {
            let mut url = repository_url(server, args.corp_id, "queue", &args.repository)?;
            url.query_pairs_mut()
                .append_pair("limit", &args.page_size.to_string());
            if let Some(id) = after {
                url.query_pairs_mut().append_pair("after", &format!("{id}"));
            }
            let value = publisher_json(
                client,
                Method::GET,
                url.as_str(),
                None,
                &args.publisher_credential_file,
            )
            .await?;
            let page: PublisherQueueResponse =
                serde_json::from_value(value).context("decode requested publication queue")?;
            validate_page(&page.publication_ids, after, args.page_size)?;
            pages += 1;
            let count = page.publication_ids.len();
            for id in page.publication_ids {
                after = Some(id);
                // The authoritative queue excludes published/failed requests
                // and active leases. Reconsider a later eligible request after
                // losing a lease race or encountering a transient read error.
                let result = publish_requested(client, server, &args, id).await;
                results.push(match result {
                    Ok(value) => json!({
                        "publication_id": id, "status": value.get("mode"),
                        "pull_request_url": value.pointer("/publication/pull_request_url"),
                    }),
                    Err(error) => json!({
                        "publication_id": id, "status": "failed",
                        "detail": sanitize_failure_detail(&format!("{error:#}")),
                    }),
                });
                if results.len() == args.max_attempts {
                    break 'polls;
                }
            }
            if count < args.page_size {
                break;
            }
        }
        if poll + 1 < args.polls {
            tokio::time::sleep(Duration::from_secs(args.poll_interval_seconds)).await;
        }
    }
    Ok(json!({
        "corp_id": args.corp_id, "repository": args.repository,
        "polls": polls, "pages": pages, "attempted": results.len(), "results": results,
    }))
}

fn validate_page(ids: &[Uuid], after: Option<Uuid>, limit: usize) -> Result<()> {
    if ids.len() > limit
        || ids.windows(2).any(|pair| pair[0] >= pair[1])
        || ids
            .first()
            .is_some_and(|first| after.is_some_and(|after| *first <= after))
    {
        bail!("publisher queue returned an invalid or unbounded page");
    }
    Ok(())
}

fn repository_url(server: &str, corp_id: Uuid, path: &str, repository: &str) -> Result<url::Url> {
    let mut url = url::Url::parse(&format!(
        "{server}/api/corps/{corp_id}/factory/publisher/{path}"
    ))?;
    url.query_pairs_mut().append_pair("repository", repository);
    Ok(url)
}

pub(super) async fn read_context(
    client: &Client,
    server: &str,
    corp_id: Uuid,
    repository: &str,
    publication_id: Uuid,
    credential_file: &Path,
) -> Result<Value> {
    let url = repository_url(
        server,
        corp_id,
        &format!("publications/{publication_id}"),
        repository,
    )?;
    publisher_json(client, Method::GET, url.as_str(), None, credential_file).await
}

async fn publish_requested(
    client: &Client,
    server: &str,
    watch: &FactoryPublisherWatchArgs,
    publication_id: Uuid,
) -> Result<Value> {
    let context = read_context(
        client,
        server,
        watch.corp_id,
        &watch.repository,
        publication_id,
        &watch.publisher_credential_file,
    )
    .await?;
    let args = requested_args(watch, publication_id, &context)?;
    run_context(client, server, args, context).await
}

fn requested_args(
    watch: &FactoryPublisherWatchArgs,
    publication_id: Uuid,
    context: &Value,
) -> Result<FactoryPublishArgs> {
    // Use the native publication model for routing identifiers. Lease credentials
    // are separate response fields and never become publication metadata or URLs.
    let publication: PullRequestPublication = serde_json::from_value(
        context
            .get("publication")
            .context("saved publication is missing")?
            .clone(),
    )
    .context("decode saved publication metadata")?;
    let intent = publication
        .provenance
        .get("intent")
        .context("saved human intent is missing")?;
    if publication.id != publication_id
        || publication.corp_id != watch.corp_id
        || !publication
            .target_repository
            .eq_ignore_ascii_case(&watch.repository)
        || intent.get("kind").and_then(Value::as_str) != Some("human_requested")
        || value_uuid(intent, "/corp_id")? != watch.corp_id
        || value_uuid(intent, "/actor_id")? != publication.actor_id
        || value_uuid(intent, "/work_item_id")? != publication.factory_work_item_id
    {
        bail!("publisher context does not match the requested human publication");
    }
    Ok(FactoryPublishArgs {
        corp_id: watch.corp_id,
        actor_id: publication.actor_id,
        work_item_id: publication.factory_work_item_id,
        source_deliverable_id: Some(publication.source_deliverable_id),
        repository: Some(watch.repository.clone()),
        base_ref: None,
        branch: None,
        title: None,
        body_file: None,
        authorization_id: None,
        authorization_reason: value_string(intent, "/authorization_reason")?,
        effect_key: None,
        idempotency_key: None,
        publisher_id: Some(value_string(context, "/publisher_id")?),
        publisher_credential_file: Some(watch.publisher_credential_file.clone()),
        github_cli: watch.github_cli.clone(),
        lease_seconds: watch.lease_seconds,
        wait_seconds: 0,
        dry_run: false,
        requested_publication_id: Some(publication_id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn watcher_has_no_human_or_plan_override_options() {
        let common = [
            "crony",
            "factory-publisher-watch",
            "00000000-0000-0000-0000-000000000001",
            "--repository",
            "owner/repo",
            "--publisher-credential-file",
            "private-credential",
        ];
        assert!(crate::Args::try_parse_from(common).is_ok());
        for flag in [
            "--actor-id",
            "--authorization-id",
            "--branch",
            "--source-deliverable-id",
            "--effect-key",
            "--publisher-id",
            "--requested-publication-id",
        ] {
            let mut args = common.to_vec();
            args.extend([flag, "00000000-0000-0000-0000-000000000002"]);
            assert!(
                crate::Args::try_parse_from(args).is_err(),
                "accepted {flag}"
            );
        }
    }

    #[test]
    fn publisher_pagination_rejects_duplicate_backward_and_excessive_pages() {
        let a = Uuid::from_u128(1);
        let b = Uuid::from_u128(2);
        let c = Uuid::from_u128(3);
        assert!(validate_page(&[b, c], Some(a), 2).is_ok());
        assert!(validate_page(&[b, b], Some(a), 2).is_err());
        assert!(validate_page(&[c, b], Some(a), 2).is_err());
        assert!(validate_page(&[a, b], Some(a), 2).is_err());
        assert!(validate_page(&[b, c], Some(a), 1).is_err());
    }

    #[derive(Clone, Copy)]
    enum QueueScenario {
        BusyThenPublished,
        UnavailableContextThenPublished,
        AlwaysBusy,
    }

    // The server controls later eligibility. These loopback tests model its
    // responses; native acceptance separately exercises real lease expiry.
    async fn watch_repeated_request(scenario: QueueScenario) -> (Value, usize, usize) {
        let workspace = TemporaryPublisherWorkspace::create().unwrap();
        let credential_file = workspace.root.join("fixture-credential");
        fs::write(&credential_file, "synthetic-watcher-test-credential").unwrap();
        let id = Uuid::from_u128(1);
        let corp = Uuid::from_u128(2);
        let actor = Uuid::from_u128(3);
        let work_item = Uuid::from_u128(4);
        let source = Uuid::from_u128(5);
        let mission = Uuid::from_u128(6);
        let artifact = Uuid::from_u128(7);
        let publication = json!({
            "id": id, "corp_id": corp, "actor_id": actor,
            "factory_work_item_id": work_item, "source_deliverable_id": source,
            "mission_id": mission, "artifact_id": artifact,
            "task_id": Uuid::from_u128(8), "run_id": Uuid::from_u128(9),
            "source_issue_number": 1, "source_issue_url": "https://github.com/owner/repo/issues/1",
            "target_repository": "owner/repo", "base_ref": "main", "branch": "ecorp/issue-1",
            "commit_sha": "a".repeat(40), "title": "Verified result", "body": "Review this result.",
            "authorization_id": Uuid::from_u128(10), "authorization_snapshot": {},
            "effect_key": "fixture-effect", "idempotency_key": "fixture-request",
            "state": "publishing", "version": 2, "attempt_count": 1,
            "publisher_id": "fixture-winner", "publisher_lease_expires_at": "2099-01-01T00:00:00Z",
            "project_owner": "owner", "project_number": 1, "project_item_id": "fixture-item",
            "project_status_before": "In Progress",
            "auto_merge_enabled": false, "merge_authorized": false, "deployment_authorized": false,
            "provenance": { "intent": { "kind": "human_requested", "corp_id": corp,
                "actor_id": actor, "work_item_id": work_item, "authorization_reason": "Review the result." } },
            "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"
        });
        let context = json!({
            "publication": publication, "publisher_id": "fixture-survivor",
            "work_item": { "id": work_item, "mission_id": mission,
                "source_repository_owner": "owner", "source_repository_name": "repo",
                "source_issue_number": 1, "source_issue_url": "https://github.com/owner/repo/issues/1",
                "source_project_owner": "owner", "source_project_number": 1,
                "source_project_item_id": "fixture-item",
                "policy": { "publication": { "base_ref": "main", "status_before": "In Progress", "review_status": "In Review" } } },
            "source_deliverables": [{ "id": source, "artifact_id": artifact, "form": "commit_branch",
                "integration_state": "ready_for_review", "head_commit": "a".repeat(40), "base_commit": "b".repeat(40) }]
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let prefix = format!("/api/corps/{corp}/factory/publisher");
            let mut claims = 0;
            let mut contexts = 0;
            let mut published = false;
            let mut claim_key = None;
            loop {
                let (mut stream, _) = tokio::select! {
                    _ = &mut stopped => break,
                    accepted = listener.accept() => accepted.unwrap(),
                };
                let mut request = Vec::new();
                let body_start = loop {
                    let mut buffer = [0; 1024];
                    let count = stream.read(&mut buffer).await.unwrap();
                    assert!(count > 0 && request.len() < 16_384);
                    request.extend_from_slice(&buffer[..count]);
                    if let Some(index) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                        break index + 4;
                    }
                };
                let headers = std::str::from_utf8(&request[..body_start])
                    .unwrap()
                    .to_owned();
                assert!(headers.to_ascii_lowercase().contains(
                    "\r\nx-crony-publication-publisher-credential: synthetic-watcher-test-credential\r\n"
                ));
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                assert!(length <= 16_384);
                while request.len() < body_start + length {
                    let mut buffer = [0; 1024];
                    let count = stream.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                let mut status = "200 OK";
                let body = if headers.starts_with(&format!("GET {prefix}/queue?")) {
                    json!({ "publication_ids": if published { vec![] } else { vec![id] } })
                } else if headers.starts_with(&format!("GET {prefix}/publications/{id}?")) {
                    contexts += 1;
                    if matches!(scenario, QueueScenario::UnavailableContextThenPublished) && contexts == 1 {
                        status = "503 Service Unavailable";
                        json!({})
                    } else {
                        context.clone()
                    }
                } else {
                    assert!(headers.starts_with(&format!("POST {prefix}/publications/{id}/claim HTTP/1.1")));
                    let body: Value = serde_json::from_slice(&request[body_start..body_start + length]).unwrap();
                    assert_eq!(body["repository"], "owner/repo");
                    assert_eq!(body["lease_seconds"], 5);
                    let key = body["idempotency_key"].as_str().unwrap().to_owned();
                    if let Some(previous) = &claim_key { assert_eq!(&key, previous); }
                    claim_key = Some(key);
                    claims += 1;
                    let busy = matches!(scenario, QueueScenario::AlwaysBusy)
                        || (matches!(scenario, QueueScenario::BusyThenPublished) && claims == 1);
                    let mut response = publication.clone();
                    if !busy {
                        response["state"] = json!("published");
                        response["pull_request_url"] = json!("https://github.com/owner/repo/pull/2");
                        published = true;
                    }
                    json!({ "publication": response, "publisher_token": null, "replayed": true, "busy": busy })
                }.to_string();
                stream.write_all(format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()
                ).as_bytes()).await.unwrap();
            }
            (claims, contexts)
        });
        let (origin, client) = crate::transport::api_client(&origin, None).unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            watch(
                &client,
                &origin,
                FactoryPublisherWatchArgs {
                    corp_id: corp,
                    repository: "owner/repo".to_owned(),
                    publisher_credential_file: credential_file,
                    github_cli: workspace.root.join("must-not-execute"),
                    lease_seconds: 5,
                    poll_interval_seconds: 1,
                    polls: 3,
                    page_size: 2,
                    max_pages: 2,
                    max_attempts: if matches!(scenario, QueueScenario::AlwaysBusy) {
                        2
                    } else {
                        3
                    },
                },
            ),
        )
        .await;
        stop.send(()).unwrap();
        let (claims, contexts) = server.await.unwrap();
        (
            result.expect("watcher must remain bounded").unwrap(),
            claims,
            contexts,
        )
    }

    #[tokio::test]
    async fn same_watcher_reconsiders_busy_request_on_later_eligible_poll() {
        let (result, claims, contexts) =
            watch_repeated_request(QueueScenario::BusyThenPublished).await;
        assert_eq!((claims, contexts), (2, 2));
        assert_eq!(result["attempted"], 2);
        assert_eq!(result["results"][0]["status"], "failed");
        assert!(
            result["results"][0]["detail"]
                .as_str()
                .unwrap()
                .contains("remains leased")
        );
        assert_eq!(result["results"][1]["status"], "recovered");
        assert_eq!(
            result["results"][1]["pull_request_url"],
            "https://github.com/owner/repo/pull/2"
        );
        assert_eq!(result["polls"], 3);
    }

    #[tokio::test]
    async fn same_watcher_reconsiders_transient_context_failure() {
        let (result, claims, contexts) =
            watch_repeated_request(QueueScenario::UnavailableContextThenPublished).await;
        assert_eq!((claims, contexts), (1, 2));
        assert_eq!(result["attempted"], 2);
        assert!(
            result["results"][0]["detail"]
                .as_str()
                .unwrap()
                .contains("503")
        );
        assert_eq!(result["results"][1]["status"], "recovered");
    }

    #[tokio::test]
    async fn repeated_eligibility_still_stops_at_attempt_limit() {
        let (result, claims, contexts) = watch_repeated_request(QueueScenario::AlwaysBusy).await;
        assert_eq!((claims, contexts), (2, 2));
        assert_eq!(result["attempted"], 2);
        assert_eq!(result["polls"], 2);
        assert_eq!(result["pages"], 2);
        assert!(
            result["results"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["detail"].as_str().unwrap().contains("remains leased"))
        );
    }
}
