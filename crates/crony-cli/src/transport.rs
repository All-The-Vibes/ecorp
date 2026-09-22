use anyhow::{Context, Result, anyhow, bail};
use reqwest::{
    Client, Url,
    header::{AUTHORIZATION, HeaderMap, HeaderValue},
};

pub(crate) fn api_client(server: &str, token: Option<&str>) -> Result<(String, Client)> {
    let origin = Url::parse(server).map_err(|_| anyhow!("ECorp API requires an HTTP(S) origin"))?;
    if !matches!(origin.scheme(), "http" | "https")
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.path() != "/"
    {
        bail!("ECorp API requires an HTTP(S) origin without credentials or parameters");
    }
    let loopback = matches!(origin.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if origin.scheme() != "https" && !loopback {
        bail!("ECorp API requires HTTPS outside explicit loopback development origins");
    }
    let mut headers = HeaderMap::new();
    if let Some(token) = token {
        let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))
            .context("access token cannot be encoded as an HTTP header")?;
        authorization.set_sensitive(true);
        headers.insert(AUTHORIZATION, authorization);
    }
    let mut builder = Client::builder()
        .default_headers(headers)
        .https_only(origin.scheme() == "https")
        .redirect(reqwest::redirect::Policy::none());
    if loopback {
        builder = builder.no_proxy();
    }
    Ok((origin.origin().ascii_serialization(), builder.build()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        time::{Duration, timeout},
    };

    #[test]
    fn rejects_unsafe_origins_without_echoing_credentials() {
        for server in [
            "http://ecorp.example.test",
            "http://localhost.example.test",
            "https://user:DO_NOT_DISCLOSE@ecorp.example.test",
            "https://ecorp.example.test/path",
            "https://ecorp.example.test?token=DO_NOT_DISCLOSE",
            "https://ecorp.example.test#DO_NOT_DISCLOSE",
            "file:///tmp/ecorp",
        ] {
            let error = api_client(server, Some("DO_NOT_DISCLOSE")).unwrap_err();
            assert!(!format!("{error:#}").contains("DO_NOT_DISCLOSE"));
        }
        for server in [
            "https://ecorp.example.test",
            "http://127.0.0.1:8791",
            "http://LOCALHOST:8791",
            "http://[::1]:8791",
        ] {
            assert!(api_client(server, None).is_ok());
        }
    }

    #[tokio::test]
    async fn redirects_cannot_forward_publisher_credentials_or_bodies() {
        let destination = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let redirect = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", redirect.local_addr().unwrap());
        let location = format!("http://{}/leak", destination.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = redirect.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(stream.read(&mut request).await.unwrap() > 0);
            stream.write_all(format!(
                "HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            ).as_bytes()).await.unwrap();
        });
        let (_, client) = api_client(&origin, Some("fixture-bearer")).unwrap();
        let response = timeout(
            Duration::from_secs(5),
            client
                .post(&origin)
                .header(
                    "x-crony-publication-publisher-credential",
                    "fixture-publisher",
                )
                .body("fixture-fencing-token")
                .send(),
        )
        .await
        .expect("redirect rejection must finish without waiting on the destination")
        .unwrap();
        assert_eq!(response.status(), 307);
        server.await.unwrap();
        assert!(
            timeout(Duration::from_millis(100), destination.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn loopback_client_bypasses_environment_proxies() {
        const CHILD_ORIGIN: &str = "ECORP_CLI_PROXY_FIXTURE_ORIGIN";
        if let Ok(origin) = std::env::var(CHILD_ORIGIN) {
            for origin in [origin.clone(), origin.replace("127.0.0.1", "localhost")] {
                let (_, client) = api_client(&origin, Some("fixture-loopback-bearer")).unwrap();
                let response = timeout(
                    Duration::from_secs(3),
                    client.get(format!("{origin}/api/fixture")).send(),
                )
                .await
                .expect("loopback request must finish without contacting the proxy")
                .unwrap();
                assert_eq!(response.status(), 200);
            }
            return;
        }

        // Proxy variables belong to a fresh native test process. Mutating this
        // process's environment would race the parallel Rust test suite.
        for proxy_names in [["HTTP_PROXY", "http_proxy"], ["ALL_PROXY", "all_proxy"]] {
            let origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut child = tokio::process::Command::new(std::env::current_exe().unwrap());
            child
                .args([
                    "--exact",
                    "transport::tests::loopback_client_bypasses_environment_proxies",
                    "--nocapture",
                ])
                .stdin(std::process::Stdio::null())
                .kill_on_drop(true)
                .env(
                    CHILD_ORIGIN,
                    format!("http://{}", origin.local_addr().unwrap()),
                );
            for name in [
                "HTTP_PROXY",
                "http_proxy",
                "HTTPS_PROXY",
                "https_proxy",
                "ALL_PROXY",
                "all_proxy",
                "NO_PROXY",
                "no_proxy",
                "REQUEST_METHOD",
            ] {
                child.env_remove(name);
            }
            for name in proxy_names {
                child.env(name, format!("http://{}", proxy.local_addr().unwrap()));
            }
            let serve_origin = async {
                for _ in 0..2 {
                    let (mut stream, _) = origin.accept().await.unwrap();
                    let mut request = Vec::new();
                    while !request.ends_with(b"\r\n\r\n") {
                        assert!(stream.read_buf(&mut request).await.unwrap() > 0);
                        assert!(request.len() <= 8192);
                    }
                    let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
                    assert!(request.starts_with("get /api/fixture http/1.1\r\n"));
                    assert!(
                        request.contains("\r\nauthorization: bearer fixture-loopback-bearer\r\n")
                    );
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                        )
                        .await
                        .unwrap();
                }
            };
            let (output, served) = tokio::join!(
                timeout(Duration::from_secs(12), child.output()),
                timeout(Duration::from_secs(10), serve_origin),
            );
            assert!(
                timeout(Duration::from_millis(100), proxy.accept())
                    .await
                    .is_err(),
                "loopback bearer request connected to the environment proxy"
            );
            let output = output.expect("native proxy fixture must exit").unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            served.expect("both authorized requests must reach the configured origin");
        }
    }
}
