use std::io::Write;

use anyhow::{Result, anyhow};
use clap::{CommandFactory, FromArgMatches, Parser, parser::ValueSource};
use crony_gateways::{GatewayClient, JsonRpcRequest, McpAccess, handle_mcp_with_access};
use tokio::io::{AsyncBufReadExt, BufReader};
use uuid::Uuid;

#[derive(Debug, Parser)]
struct Args {
    #[arg(
        long,
        env = "CRONY_SERVER_HTTP",
        help = "ECorp API origin; required in read-only mode, otherwise defaults to http://127.0.0.1:8791"
    )]
    server: Option<String>,
    #[arg(long, env = "CRONY_CORP_ID")]
    corp_id: Uuid,
    #[arg(long, env = "CRONY_ACTOR_ID")]
    actor_id: Uuid,
    #[arg(long, env = "CRONY_ACCESS_TOKEN", hide_env_values = true)]
    access_token: Option<String>,
    /// Expose only snapshot reads; reject every other tool before making API calls.
    #[arg(long, env = "CRONY_MCP_READ_ONLY", default_value_t = false)]
    read_only: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let matches = Args::command().get_matches();
    let args = Args::from_arg_matches(&matches)?;
    if args.read_only && matches.value_source("access_token") == Some(ValueSource::CommandLine) {
        return Err(anyhow!(
            "read-only MCP requires access tokens through CRONY_ACCESS_TOKEN; --access-token is unavailable"
        ));
    }
    let access = if args.read_only {
        McpAccess::ReadOnly
    } else {
        McpAccess::ReadWrite
    };
    let server = match args.server {
        Some(server) => server,
        None if args.read_only => {
            return Err(anyhow!(
                "read-only MCP requires explicit --server or CRONY_SERVER_HTTP"
            ));
        }
        None => "http://127.0.0.1:8791".to_owned(),
    };
    let client = GatewayClient::new(server, args.corp_id, args.actor_id, args.access_token)
        .with_mcp_access(access)?;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let response = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(value) => {
                // This gateway keeps omitted-ID objects silent and effect-free,
                // including malformed notifications. Explicit null remains a request.
                if value.is_object() && value.get("id").is_none() {
                    continue;
                }
                match serde_json::from_value::<JsonRpcRequest>(value) {
                    Ok(request) => handle_mcp_with_access(&client, request, access).await,
                    Err(_) => crony_gateways::failure(None, -32600, "invalid JSON-RPC request"),
                }
            }
            Err(error) => crony_gateways::failure(None, -32700, error.to_string()),
        };
        println!("{}", serde_json::to_string(&response)?);
        std::io::stdout().flush()?;
    }
    Ok(())
}
