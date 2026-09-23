//! Opt-in native transport regression, not a live GitHub or database integration.
//! Run with --ignored --exact native_github_sha_identity and F01_PYTHON,
//! F01_OPENSSL (installed executables), F01_OUTPUT (a new owned directory).
//! TLS verifies api.github.com against a fixture-only certificate; native reqwest
//! DNS override routes every request to loopback, with proxies/redirects disabled.
use crony_audit::SignedCheckpoint;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};

// Compile the exact production source, including its real reqwest/decode path.
// This permits client injection without adding a production origin/credential API.
#[allow(dead_code)]
mod native {
    pub fn fixture(client: reqwest::Client, name: &str) -> GitHubTransport {
        GitHubTransport {
            client,
            repository: format!("audit/{name}"),
            branch: "audit".into(),
        }
    }

    include!("../src/publication.rs");
}
use native::PublicationTransport;

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        self.0.wait().expect("reap owned TLS fixture");
    }
}

const SERVER: &str = r#"
import http.server, json, pathlib, ssl, sys
root = pathlib.Path(sys.argv[1])
responses = json.loads((root / "responses.json").read_text())
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        with (root / "requests.jsonl").open("a") as log:
            log.write(json.dumps({"path": self.path, "host": self.headers["Host"]}) + "\n")
        name = self.path.split("/")[3]
        case = responses[name]
        body = case["body"].encode()
        self.send_response(case["http"])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(root / "fixture.crt", root / "fixture.key")
server.socket = context.wrap_socket(server.socket, server_side=True)
print(server.server_port, flush=True)
server.serve_forever()
"#;

#[tokio::test]
#[ignore = "requires installed Python/OpenSSL and a fresh owned F01_OUTPUT directory"]
async fn native_github_sha_identity() {
    let output = std::env::var("F01_OUTPUT").expect("explicit owned output");
    let output = Path::new(&output);
    fs::create_dir(output).expect("new fixture directory; never overwrite evidence");
    let openssl = std::env::var("F01_OPENSSL").expect("installed OpenSSL");
    let certificate = Command::new(openssl)
        .args([
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-noenc",
            "-days",
            "1",
            "-subj",
            "/CN=api.github.com",
            "-addext",
            "subjectAltName=DNS:api.github.com",
            "-addext",
            "basicConstraints=critical,CA:FALSE",
            "-keyout",
            "fixture.key",
            "-out",
            "fixture.crt",
        ])
        .current_dir(output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("generate owned TLS fixture certificate");
    fs::write(
        output.join("openssl.log"),
        format!("certificate_generation_exit={certificate}\n"),
    )
    .unwrap();
    assert!(
        certificate.success(),
        "certificate generation: {certificate}"
    );

    let lower = "abcdef0123456789abcdef0123456789abcdef01";
    let upper = lower.to_ascii_uppercase();
    let mixed = "AbCdEf0123456789aBcDeF0123456789ABCdef01";
    let next = "1234567890abcdef1234567890abcdef12345678";
    for valid in [lower, &upper, mixed, next] {
        native::validate_github_commit(valid).expect("exact 40-hex positive fixture");
    }
    // name, old, new, HTTP status, response body, expected Result<bool>.
    let response = |status, sha| json!({"status": status, "merge_base_commit": {"sha": sha}});
    let mut cases = vec![
        (
            "same-lower",
            lower.to_owned(),
            lower.to_owned(),
            503,
            json!({}),
            Some(true),
        ),
        (
            "same-upper",
            upper.clone(),
            lower.to_owned(),
            503,
            json!({}),
            Some(true),
        ),
        (
            "same-mixed",
            mixed.to_owned(),
            upper.clone(),
            503,
            json!({}),
            Some(true),
        ),
        (
            "ahead-lower",
            lower.to_owned(),
            next.to_owned(),
            200,
            response("ahead", lower),
            Some(true),
        ),
        (
            "ahead-upper-old",
            upper.clone(),
            next.to_owned(),
            200,
            response("ahead", lower),
            Some(true),
        ),
        (
            "ahead-upper-base",
            lower.to_owned(),
            next.to_owned(),
            200,
            response("ahead", &upper),
            Some(true),
        ),
        (
            "ahead-mixed",
            mixed.to_owned(),
            next.to_owned(),
            200,
            response("ahead", &upper),
            Some(true),
        ),
        (
            "identical-mixed",
            upper.clone(),
            next.to_owned(),
            200,
            response("identical", mixed),
            Some(true),
        ),
        (
            "diverged",
            upper.clone(),
            next.to_owned(),
            200,
            response("diverged", lower),
            Some(false),
        ),
        (
            "behind",
            upper.clone(),
            next.to_owned(),
            200,
            response("behind", lower),
            Some(false),
        ),
        (
            "wrong-base",
            upper.clone(),
            next.to_owned(),
            200,
            response("ahead", next),
            Some(false),
        ),
        (
            "unknown-status",
            lower.to_owned(),
            next.to_owned(),
            200,
            response("AHEAD", lower),
            Some(false),
        ),
        (
            "missing-status",
            lower.to_owned(),
            next.to_owned(),
            200,
            json!({"merge_base_commit":{"sha":lower}}),
            Some(false),
        ),
        (
            "missing-base",
            lower.to_owned(),
            next.to_owned(),
            200,
            json!({"status":"ahead"}),
            Some(false),
        ),
        (
            "numeric-base",
            lower.to_owned(),
            next.to_owned(),
            200,
            json!({"status":"ahead","merge_base_commit":{"sha":42}}),
            Some(false),
        ),
        (
            "null-base",
            lower.to_owned(),
            next.to_owned(),
            200,
            json!({"status":"ahead","merge_base_commit":{"sha":null}}),
            Some(false),
        ),
        (
            "object-base",
            lower.to_owned(),
            next.to_owned(),
            200,
            json!({"status":"ahead","merge_base_commit":{"sha":{}}}),
            Some(false),
        ),
        (
            "short-base",
            lower.to_owned(),
            next.to_owned(),
            200,
            response("ahead", &lower[..39]),
            Some(false),
        ),
        (
            "long-base",
            lower.to_owned(),
            next.to_owned(),
            200,
            response("ahead", &format!("{lower}a")),
            Some(false),
        ),
        (
            "http-error",
            lower.to_owned(),
            next.to_owned(),
            503,
            response("ahead", lower),
            None,
        ),
        (
            "http-redirect",
            lower.to_owned(),
            next.to_owned(),
            302,
            response("ahead", lower),
            None,
        ),
    ];
    for (name, invalid) in [
        ("short", "a".repeat(39)),
        ("long", "a".repeat(41)),
        ("sha256", "a".repeat(64)),
        ("nonhex", "g".repeat(40)),
        ("whitespace", format!("{lower} ")),
        ("unicode", "é".repeat(20)),
        ("empty", String::new()),
    ] {
        assert!(native::validate_github_commit(&invalid).is_err(), "{name}");
        cases.push((
            name,
            invalid.clone(),
            lower.to_owned(),
            503,
            json!({}),
            None,
        ));
        cases.push((
            name,
            lower.to_owned(),
            invalid.clone(),
            503,
            json!({}),
            None,
        ));
        cases.push((name, invalid.clone(), invalid, 503, json!({}), None));
    }
    let mut responses = serde_json::Map::new();
    for (name, _, _, http, body, _) in &cases {
        responses.insert((*name).into(), json!({"http":http,"body":body.to_string()}));
    }
    responses.insert("malformed-json".into(), json!({"http":200,"body":"{"}));
    fs::write(
        output.join("responses.json"),
        serde_json::to_vec(&responses).unwrap(),
    )
    .unwrap();
    let child = Command::new(std::env::var("F01_PYTHON").expect("installed real Python"))
        .args(["-u", "-c", SERVER])
        .arg(output)
        .stdout(Stdio::piped())
        .stderr(fs::File::create(output.join("server.log")).unwrap())
        .spawn()
        .expect("start owned loopback TLS server");
    let mut server = Server(child);
    let mut port = String::new();
    BufReader::new(server.0.stdout.take().unwrap())
        .read_line(&mut port)
        .unwrap();
    let address = SocketAddr::new(
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        port.trim().parse().unwrap(),
    );
    let builder = || {
        reqwest::Client::builder()
            .no_proxy()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .tls_built_in_root_certs(false)
            .resolve("api.github.com", address)
    };
    // Negative control: the fixture must not work without its explicit trust root.
    let untrusted = native::fixture(builder().build().unwrap(), "ahead-lower")
        .descends_from(lower, next)
        .await
        .unwrap_err();
    assert!(
        format!("{untrusted:#}").contains("certificate"),
        "{untrusted:#}"
    );
    let client = builder()
        .add_root_certificate(
            reqwest::Certificate::from_pem(&fs::read(output.join("fixture.crt")).unwrap()).unwrap(),
        )
        .build()
        .unwrap();
    let mut failures = Vec::new();
    let mut outcomes = Vec::new();
    let mut expected_paths = Vec::new();
    for (name, old, new, _, _, expected) in &cases {
        let result = native::fixture(client.clone(), name)
            .descends_from(old, new)
            .await;
        let actual = result.as_ref().ok().copied();
        outcomes.push(json!({"case":name,"old":old,"new":new,"expected":expected,
            "actual":actual,"error":result.as_ref().err().map(|e|format!("{e:#}"))}));
        if actual != *expected {
            failures.push(format!("{name}: expected {expected:?}, got {result:?}"));
        }
        if native::validate_github_commit(old).is_ok()
            && native::validate_github_commit(new).is_ok()
            && !old.eq_ignore_ascii_case(new)
        {
            expected_paths.push(format!(
                "/repos/audit/{name}/compare/{old}...{new}?per_page=1"
            ));
        }
    }
    assert!(
        native::fixture(client, "malformed-json")
            .descends_from(lower, next)
            .await
            .is_err()
    );
    expected_paths.push(format!(
        "/repos/audit/malformed-json/compare/{lower}...{next}?per_page=1"
    ));
    fs::write(
        output.join("outcomes.json"),
        serde_json::to_vec_pretty(&outcomes).unwrap(),
    )
    .unwrap();
    let requests: Vec<Value> = fs::read_to_string(output.join("requests.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let actual_paths: Vec<_> = requests
        .iter()
        .map(|r| {
            assert_eq!(r["host"], "api.github.com");
            r["path"].as_str().unwrap().to_owned()
        })
        .collect();
    if actual_paths != expected_paths {
        failures.push(format!(
            "unexpected requests: {actual_paths:?}; expected {expected_paths:?}"
        ));
    }
    drop(server);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
