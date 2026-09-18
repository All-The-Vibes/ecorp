use anyhow::{Context, Result, anyhow};
use crony_domain::{MAX_TASK_ATTEMPTS, factory_max_task_attempts};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

pub const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
pub const ACP_PROTOCOL_VERSION: u32 = 1;
pub const A2A_PROTOCOL_VERSION: &str = "1.0";
/// Read-only MCP caps each raw HTTP response at 16 MiB before JSON decoding,
/// including unsuccessful responses. The probe separately bounds stdio output.
pub const MCP_READ_ONLY_MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const READ_ONLY_RESPONSE_TOO_LARGE: &str = "read-only MCP response exceeded the 16 MiB body limit";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum McpAccess {
    #[default]
    ReadWrite,
    ReadOnly,
}

#[derive(Debug, Clone)]
pub struct GatewayClient {
    pub server: String,
    pub corp_id: Uuid,
    pub actor_id: Uuid,
    pub access_token: Option<String>,
    http: Client,
    response_byte_limit: Option<usize>,
}

impl GatewayClient {
    pub fn new(
        server: String,
        corp_id: Uuid,
        actor_id: Uuid,
        access_token: Option<String>,
    ) -> Self {
        Self {
            server: server.trim_end_matches('/').to_owned(),
            corp_id,
            actor_id,
            access_token,
            http: Client::new(),
            response_byte_limit: None,
        }
    }

    /// Inspection stays on the selected origin, including on redirect responses.
    /// Other integrations retain their existing transport behavior.
    pub fn with_mcp_access(mut self, access: McpAccess) -> Result<Self> {
        if access == McpAccess::ReadOnly {
            let server = reqwest::Url::parse(&self.server)
                .context("read-only MCP requires an explicit HTTP(S) API origin")?;
            if !matches!(server.scheme(), "http" | "https")
                || !server.username().is_empty()
                || server.password().is_some()
                || server.query().is_some()
                || server.fragment().is_some()
                || server.path() != "/"
            {
                return Err(anyhow!(
                    "read-only MCP requires an HTTP(S) origin without credentials or parameters"
                ));
            }
            if server.scheme() == "http"
                && !matches!(server.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
            {
                return Err(anyhow!(
                    "read-only MCP requires HTTPS outside explicitly configured loopback origins"
                ));
            }
            self.server = server.origin().ascii_serialization();
            self.http = Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .context("configure read-only MCP transport")?;
            self.response_byte_limit = Some(MCP_READ_ONLY_MAX_RESPONSE_BYTES);
        }
        Ok(self)
    }

    pub async fn request(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        let mut request = self
            .http
            .request(method, format!("{}{}", self.server, path))
            .header("content-type", "application/json");
        if let Some(token) = &self.access_token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.context("send ECorp API request")?;
        let status = response.status();
        let value = if let Some(limit) = self.response_byte_limit {
            bounded_response_json(response, limit).await?
        } else {
            response
                .json::<Value>()
                .await
                .context("decode ECorp API response")?
        };
        if !status.is_success() {
            return Err(anyhow!("ECorp API returned {status}: {value}"));
        }
        Ok(value)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

pub fn success(id: Option<Value>, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}

pub fn failure(id: Option<Value>, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message.into()}})
}

/// Add only an explicit planning choice. Absent/null input preserves the old body.
pub fn with_max_task_attempts(mut body: Value, params: &Value) -> Result<Value> {
    if params.get("max_attempts").is_some() {
        return Err(anyhow!(
            "use max_task_attempts only when creating a mission"
        ));
    }
    let max_task_attempts = factory_max_task_attempts(params).map_err(anyhow::Error::msg)?;
    if let Some(max_task_attempts) = max_task_attempts {
        body.as_object_mut()
            .context("mission request must be an object")?
            .insert("max_task_attempts".to_owned(), json!(max_task_attempts));
    }
    Ok(body)
}

/// Other actions must not silently discard an attempted planning-policy change.
pub fn reject_max_task_attempts(params: &Value) -> Result<()> {
    if params.get("max_task_attempts").is_some() || params.get("max_attempts").is_some() {
        return Err(anyhow!(
            "task attempts can only be chosen when creating a mission"
        ));
    }
    Ok(())
}

pub fn mcp_capabilities() -> Value {
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "serverInfo": {"name":"crony-mcp","version":env!("CARGO_PKG_VERSION")},
        "capabilities":{"tools":{"listChanged":false},"resources":{}}
    })
}

pub fn mcp_tools() -> Value {
    mcp_tools_with_access(McpAccess::ReadWrite)
}

async fn bounded_response_json(mut response: reqwest::Response, limit: usize) -> Result<Value> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(anyhow!(READ_ONLY_RESPONSE_TOO_LARGE));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.context("read ECorp API response")? {
        if chunk.len() > limit - bytes.len() {
            return Err(anyhow!(READ_ONLY_RESPONSE_TOO_LARGE));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).context("decode ECorp API response")
}

pub fn mcp_tools_with_access(access: McpAccess) -> Value {
    let mut tools = json!({
        "tools":[
            {
                "name":"crony_snapshot",
                "description":"Read the authenticated actor's Corp-scoped operational snapshot.",
                "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true},
                "inputSchema":{"type":"object","properties":{},"additionalProperties":false}
            },
            {
                "name":"crony_create_mission",
                "description":"Create a bounded ECorp mission.",
                "inputSchema":{
                    "type":"object",
                    "required":["title"],
                    "properties":{
                        "title":{"type":"string"},
                        "adapter":{"type":"string"},
                        "strategy":{"type":"string"},
                        "max_task_attempts":{
                            "type":["integer","null"],
                            "minimum":1,
                            "maximum":MAX_TASK_ATTEMPTS,
                            "description":"Total attempts per task chosen before execution, not additional retries. Omission retains planner defaults."
                        }
                    },
                    "additionalProperties":false
                }
            },
            {
                "name":"crony_post_room_message",
                "description":"Post a durable message to a room in the configured Corp.",
                "inputSchema":{
                    "type":"object",
                    "required":["room_id","body"],
                    "properties":{
                        "room_id":{"type":"string","format":"uuid"},
                        "body":{"type":"string"}
                    },
                    "additionalProperties":false
                }
            }
        ]
    });
    if access == McpAccess::ReadOnly {
        tools["tools"]
            .as_array_mut()
            .expect("static MCP tool catalog is an array")
            .retain(|tool| tool["name"] == "crony_snapshot");
    }
    tools
}

pub async fn handle_mcp(client: &GatewayClient, request: JsonRpcRequest) -> Value {
    handle_mcp_with_access(client, request, McpAccess::ReadWrite).await
}

pub async fn handle_mcp_with_access(
    client: &GatewayClient,
    request: JsonRpcRequest,
    access: McpAccess,
) -> Value {
    let id = request.id.clone();
    if request.jsonrpc != "2.0" {
        return failure(id, -32600, "unsupported JSON-RPC version");
    }
    let result = match request.method.as_str() {
        "initialize" => Ok(mcp_capabilities()),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(mcp_tools_with_access(access)),
        "tools/call" => handle_mcp_tool_with_access(client, &request.params, access).await,
        "resources/list" => Ok(json!({"resources":[]})),
        _ => return failure(id, -32601, "method not found"),
    };
    match result {
        Ok(result) => success(id, result),
        Err(error) => failure(id, -32000, error.to_string()),
    }
}

async fn handle_mcp_tool_with_access(
    client: &GatewayClient,
    params: &Value,
    access: McpAccess,
) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .context("tool call omitted name")?;
    if access == McpAccess::ReadOnly && name != "crony_snapshot" {
        return Err(anyhow!("tool is unavailable in read-only MCP mode"));
    }
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if name != "crony_create_mission" {
        reject_max_task_attempts(&arguments)?;
    }
    let value = match name {
        "crony_snapshot" => {
            client
                .request(
                    Method::GET,
                    &format!(
                        "/api/corps/{}/snapshot?actor_id={}",
                        client.corp_id, client.actor_id
                    ),
                    None,
                )
                .await?
        }
        "crony_create_mission" => {
            client
                .request(
                    Method::POST,
                    &format!("/api/corps/{}/missions", client.corp_id),
                    Some(mcp_mission_request(client.actor_id, &arguments)?),
                )
                .await?
        }
        "crony_post_room_message" => {
            let room_id = arguments
                .get("room_id")
                .and_then(Value::as_str)
                .context("message tool omitted room_id")?;
            let body = arguments
                .get("body")
                .and_then(Value::as_str)
                .context("message tool omitted body")?;
            client
                .request(
                    Method::POST,
                    &format!("/api/corps/{}/rooms/{room_id}/messages", client.corp_id),
                    Some(json!({
                        "actor_id":client.actor_id,
                        "body":body,
                        "reply_to_id":null,
                        "mentions":[],
                        "link":null
                    })),
                )
                .await?
        }
        _ => return Err(anyhow!("unknown ECorp MCP tool {name}")),
    };
    Ok(json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value}))
}

fn mcp_mission_request(actor_id: Uuid, arguments: &Value) -> Result<Value> {
    let title = arguments
        .get("title")
        .and_then(Value::as_str)
        .context("mission tool omitted title")?;
    with_max_task_attempts(
        json!({
            "requested_by":actor_id,
            "title":title,
            "preferred_adapter":arguments.get("adapter"),
            "strategy":arguments.get("strategy")
        }),
        arguments,
    )
}

pub fn negotiate_version(requested: &str, supported: &[&str]) -> Result<String> {
    if supported.contains(&requested) {
        Ok(requested.to_owned())
    } else {
        Err(anyhow!(
            "unsupported protocol version {requested}; supported: {}",
            supported.join(", ")
        ))
    }
}

pub fn a2a_agent_card(base_url: &str) -> Value {
    json!({
        "name":"ECorp gateway",
        "description":"Corp-scoped missions, messages, task status, and streaming events.",
        "url":format!("{}/a2a",base_url.trim_end_matches('/')),
        "protocolVersion":A2A_PROTOCOL_VERSION,
        "capabilities":{"streaming":true,"pushNotifications":false},
        "defaultInputModes":["text/plain","application/json"],
        "defaultOutputModes":["application/json"],
        "skills":[
            {"id":"mission","name":"Mission execution","description":"Create and inspect ECorp missions"},
            {"id":"room-message","name":"Room messaging","description":"Post durable Corp room messages"}
        ]
    })
}

pub fn acp_initialize(requested_version: u32) -> Value {
    if requested_version == ACP_PROTOCOL_VERSION {
        json!({
            "protocolVersion":ACP_PROTOCOL_VERSION,
            "agentCapabilities":{
                "loadSession":true,
                "promptCapabilities":{"image":false,"audio":false,"embeddedContext":true},
                "mcpCapabilities":{"http":true,"sse":true}
            }
        })
    } else {
        json!({
            "error":{
                "code":-32602,
                "message":format!("unsupported ACP version {requested_version}")
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readonly_mcp_transport_requires_an_origin_and_https_outside_loopback() {
        let client = |server: &str| {
            GatewayClient::new(
                server.to_owned(),
                Uuid::from_u128(1),
                Uuid::from_u128(2),
                None,
            )
        };
        for server in [
            "http://127.0.0.1:8791",
            "http://LOCALHOST:8791",
            "http://[::1]:8791",
            "https://ecorp.example.test",
        ] {
            assert!(client(server).with_mcp_access(McpAccess::ReadOnly).is_ok());
        }
        for server in [
            "",
            "http://ecorp.example.test",
            "http://127.0.0.2:8791",
            "http://localhost.example.test",
            "https://ecorp.example.test/private",
            "https://user:secret@ecorp.example.test",
        ] {
            assert!(client(server).with_mcp_access(McpAccess::ReadOnly).is_err());
            assert!(client(server).with_mcp_access(McpAccess::ReadWrite).is_ok());
        }
    }

    #[test]
    fn protocol_versions_fail_closed() {
        assert_eq!(
            negotiate_version(MCP_PROTOCOL_VERSION, &[MCP_PROTOCOL_VERSION]).expect("version"),
            MCP_PROTOCOL_VERSION
        );
        assert!(negotiate_version("1900-01-01", &[MCP_PROTOCOL_VERSION]).is_err());
        assert!(acp_initialize(ACP_PROTOCOL_VERSION).get("error").is_none());
        assert!(acp_initialize(99).get("error").is_some());
    }

    #[test]
    fn gateways_do_not_expose_internal_database_shapes() {
        let tools = mcp_tools().to_string();
        assert!(!tools.contains("assignment_token"));
        assert!(!tools.contains("control_leases"));
        let card = a2a_agent_card("https://example.test").to_string();
        assert!(!card.contains("verification_requests"));
        assert!(card.contains("\"streaming\":true"));
    }

    #[test]
    fn readonly_mcp_catalog_exposes_only_snapshot_without_changing_default() {
        assert_eq!(mcp_tools()["tools"].as_array().unwrap().len(), 3);
        let catalog = mcp_tools_with_access(McpAccess::ReadOnly);
        let tools = catalog["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "crony_snapshot");
        assert_eq!(tools[0]["annotations"]["readOnlyHint"], true);
    }

    #[tokio::test]
    async fn readonly_mcp_rejects_mutations_before_any_api_request() {
        let client = GatewayClient::new(
            "invalid-unused-server".to_owned(),
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            None,
        );
        for name in ["crony_create_mission", "crony_post_room_message", "unknown"] {
            let response = handle_mcp_with_access(
                &client,
                JsonRpcRequest {
                    jsonrpc: "2.0".to_owned(),
                    id: Some(json!(1)),
                    method: "tools/call".to_owned(),
                    params: json!({"name": name, "arguments": {}}),
                },
                McpAccess::ReadOnly,
            )
            .await;
            assert_eq!(response["error"]["code"], -32000);
            assert_eq!(
                response["error"]["message"],
                "tool is unavailable in read-only MCP mode"
            );
        }
    }

    #[tokio::test]
    async fn invalid_mcp_rpc_version_cannot_reach_the_api() {
        let client = GatewayClient::new(
            "invalid-unused-server".to_owned(),
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            None,
        );
        let response = handle_mcp(
            &client,
            JsonRpcRequest {
                jsonrpc: "1.0".to_owned(),
                id: Some(json!(1)),
                method: "tools/call".to_owned(),
                params: json!({"name": "crony_create_mission", "arguments": {"title": "Denied"}}),
            },
        )
        .await;
        assert_eq!(response["error"]["code"], -32600);
    }

    #[test]
    fn issue224_mcp_schema_exposes_optional_native_attempt_bounds() {
        let tools = mcp_tools();
        let tool = tools["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "crony_create_mission")
            .unwrap();
        let field = &tool["inputSchema"]["properties"]["max_task_attempts"];
        assert_eq!(field["type"], json!(["integer", "null"]));
        assert_eq!(field["minimum"], 1);
        assert_eq!(field["maximum"], MAX_TASK_ATTEMPTS);
        assert!(field.get("default").is_none());
        assert!(
            !tool["inputSchema"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!("max_task_attempts"))
        );
    }

    #[test]
    fn issue224_mcp_creation_preserves_omission_and_forwards_explicit_attempts() {
        let actor = Uuid::from_u128(1);
        let mut arguments = json!({
            "title": "Bounded planning", "adapter": "fake-process",
            "strategy": "parallel-specialists",
        });
        let legacy = mcp_mission_request(actor, &arguments).unwrap();
        assert!(legacy.get("max_task_attempts").is_none());
        arguments["max_task_attempts"] = Value::Null;
        assert_eq!(mcp_mission_request(actor, &arguments).unwrap(), legacy);
        for value in 1..=MAX_TASK_ATTEMPTS {
            arguments["max_task_attempts"] = json!(value);
            let mut body = mcp_mission_request(actor, &arguments).unwrap();
            assert_eq!(body["max_task_attempts"], value);
            assert_eq!(body["requested_by"], json!(actor));
            body.as_object_mut().unwrap().remove("max_task_attempts");
            assert_eq!(body, legacy);
        }
    }

    #[test]
    fn issue224_gateway_planning_rejects_malformed_attempts_without_defaulting() {
        for value in [
            json!(0),
            json!(-1),
            json!(MAX_TASK_ATTEMPTS + 1),
            json!(i64::MAX),
            json!("3"),
            json!(3.0),
            json!(false),
            json!([]),
            json!({}),
        ] {
            assert!(
                mcp_mission_request(
                    Uuid::from_u128(1),
                    &json!({"title": "Bounded planning", "max_task_attempts": value}),
                )
                .is_err()
            );
        }
        assert!(
            mcp_mission_request(
                Uuid::from_u128(1),
                &json!({"title": "Bounded planning", "max_attempts": MAX_TASK_ATTEMPTS}),
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn issue224_nonplanning_mcp_actions_reject_attempt_fields_before_api_calls() {
        let client = GatewayClient::new(
            "invalid-unused-server".to_owned(),
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            None,
        );
        for name in ["crony_snapshot", "crony_post_room_message"] {
            for value in [Value::Null, json!(MAX_TASK_ATTEMPTS)] {
                let error = handle_mcp_tool_with_access(
                    &client,
                    &json!({"name": name, "arguments": {"max_task_attempts": value}}),
                    McpAccess::ReadWrite,
                )
                .await
                .unwrap_err();
                assert!(
                    error
                        .to_string()
                        .contains("only be chosen when creating a mission")
                );
            }
        }
    }
}
