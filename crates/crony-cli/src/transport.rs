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
}
