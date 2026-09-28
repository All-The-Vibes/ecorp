//! A bounded delivery adapter for saved human intent. All remote effects remain
//! in `execute_publication`; this module neither creates intent nor signs runs.
use super::*;
use std::collections::HashSet;

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
    let mut seen = HashSet::new();
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
                if !seen.insert(id) {
                    continue;
                }
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
    let publication = context
        .get("publication")
        .context("saved publication is missing")?;
    let intent = publication
        .pointer("/provenance/intent")
        .context("saved human intent is missing")?;
    let actor_id = value_uuid(publication, "/actor_id")?;
    let work_item_id = value_uuid(publication, "/factory_work_item_id")?;
    if value_uuid(publication, "/id")? != publication_id
        || value_uuid(publication, "/corp_id")? != watch.corp_id
        || !value_string(publication, "/target_repository")?.eq_ignore_ascii_case(&watch.repository)
        || intent.get("kind").and_then(Value::as_str) != Some("human_requested")
        || value_uuid(intent, "/corp_id")? != watch.corp_id
        || value_uuid(intent, "/actor_id")? != actor_id
        || value_uuid(intent, "/work_item_id")? != work_item_id
    {
        bail!("publisher context does not match the requested human publication");
    }
    Ok(FactoryPublishArgs {
        corp_id: watch.corp_id,
        actor_id,
        work_item_id,
        source_deliverable_id: Some(value_uuid(publication, "/source_deliverable_id")?),
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
}
