use anyhow::{anyhow, bail, ensure, Context, Result};
use futures_util::{SinkExt, StreamExt};
use reqwest::{Method, Url};
use rustls::{ClientConfig, RootCertStore};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio_tungstenite::{
    connect_async_tls_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
    Connector,
};

const TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone)]
pub struct Server {
    origin: Url,
    http: reqwest::Client,
    tls: Arc<ClientConfig>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub session_id: String,
    pub access_token: String,
    pub refresh_token: String,
    pub access_expires_at: u64,
    pub refresh_expires_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    websocket_path: String,
    heartbeat_seconds: u64,
    max_web_socket_bytes: usize,
    target_audio_bitrate: u32,
    #[serde(default)]
    ice_servers: Value,
}

impl Server {
    pub fn new(address: &str, extra_ca: Option<&[u8]>) -> Result<Self> {
        let address = address.trim();
        let address = if address.contains("://") {
            address.to_owned()
        } else {
            format!("https://{address}")
        };
        let origin = Url::parse(&address).context("Enter a valid HTTPS server address")?;
        ensure!(
            origin.scheme() == "https"
                && origin.has_host()
                && origin.username().is_empty()
                && origin.password().is_none()
                && origin.path() == "/"
                && origin.query().is_none()
                && origin.fragment().is_none(),
            "Enter an HTTPS server origin such as https://voice.example.net:8443"
        );
        let mut roots = RootCertStore::empty();
        for cert in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(cert);
        }
        if let Some(mut pem) = extra_ca {
            let certs: Vec<_> = rustls_pemfile::certs(&mut pem)
                .collect::<std::io::Result<_>>()
                .context("Invalid PEM certificate")?;
            ensure!(!certs.is_empty(), "The file contains no PEM certificate");
            for cert in certs {
                roots.add(cert).context("Invalid trusted certificate")?;
            }
        }
        let tls =
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()?
                .with_root_certificates(roots)
                .with_no_client_auth();
        let http = reqwest::Client::builder()
            .use_preconfigured_tls(tls.clone())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(TIMEOUT)
            .timeout(TIMEOUT)
            .build()?;
        Ok(Self {
            origin,
            http,
            tls: Arc::new(tls),
        })
    }

    pub fn origin(&self) -> &str {
        self.origin.as_str().trim_end_matches('/')
    }

    pub async fn http(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        access_token: Option<&str>,
    ) -> Result<(u16, Value)> {
        ensure!(path.starts_with("/api/v1/"), "Invalid API path");
        let url = self.origin.join(path)?;
        ensure!(url.origin() == self.origin.origin(), "Invalid API origin");
        let mut request = self.http.request(method, url);
        if let Some(token) = access_token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|error| {
            let mut message = error.to_string();
            let mut cause = std::error::Error::source(&error);
            while let Some(error) = cause {
                message.push_str(&format!(" - {error}"));
                cause = error.source();
            }
            anyhow!(message)
        })?;
        let status = response.status().as_u16();
        let bytes = response.bytes().await?;
        Ok((
            status,
            serde_json::from_slice(&bytes).context("Server returned an invalid JSON response")?,
        ))
    }

    pub async fn refresh(&self, credentials: &Credentials) -> Result<Credentials> {
        let (status, data) = self
            .http(
                Method::POST,
                "/api/v1/auth/refresh",
                Some(json!({ "refreshToken": credentials.refresh_token })),
                None,
            )
            .await?;
        let next: Credentials = serde_json::from_value(require_success(status, data)?)?;
        ensure!(
            next.session_id == credentials.session_id,
            "The refreshed device session changed"
        );
        Ok(next)
    }

    pub async fn ticket(&self, credentials: &Credentials) -> Result<String> {
        let (status, data) = self
            .http(
                Method::POST,
                "/api/v1/auth/connection-ticket",
                None,
                Some(&credentials.access_token),
            )
            .await?;
        require_success(status, data)?["ticket"]
            .as_str()
            .map(str::to_owned)
            .context("The server did not issue a connection ticket")
    }

    pub async fn authenticate(&self, credentials: &Credentials) -> Result<Connected> {
        let (status, data) = self
            .http(
                Method::GET,
                "/api/v1/server/capabilities",
                None,
                Some(&credentials.access_token),
            )
            .await?;
        let capabilities: Capabilities = serde_json::from_value(require_success(status, data)?)?;
        ensure!(
            capabilities.websocket_path == "/api/v1/ws",
            "Unsupported signaling path"
        );
        let ticket = self.ticket(credentials).await?;
        let mut address = self.origin.join(&capabilities.websocket_path)?;
        address
            .set_scheme("wss")
            .map_err(|()| anyhow!("Invalid signaling URL"))?;
        let ws_config = WebSocketConfig::default()
            .max_message_size(Some(256 * 1024))
            .max_frame_size(Some(256 * 1024));
        let (socket, _) = tokio::time::timeout(
            TIMEOUT,
            connect_async_tls_with_config(
                address.as_str(),
                Some(ws_config),
                true,
                Some(Connector::Rustls(self.tls.clone())),
            ),
        )
        .await
        .context("WebSocket connection timed out")?
        .context("WebSocket connection failed")?;
        let (sender, mut receiver) = mpsc::channel(32);
        let (events, _) = broadcast::channel(256);
        let (closed_sender, closed) = watch::channel(None);
        let wire = Wire {
            sender,
            events: events.clone(),
            closed,
        };
        let subscription = events.subscribe();
        let mut socket = socket;
        tokio::spawn(async move {
            let mut id = 0_u64;
            let mut pending = HashMap::<u64, oneshot::Sender<Result<Value>>>::new();
            let reason = loop {
                tokio::select! {
                    request = receiver.recv() => {
                        pending.retain(|_, reply| !reply.is_closed());
                        let Some(request) = request else { break "Connection closed".into() };
                        match request {
                            Command::Rpc { kind, payload, reply } => {
                                id += 1;
                                let raw = json!({ "version": 1, "id": id, "type": kind, "payload": payload }).to_string();
                                if raw.len() > capabilities.max_web_socket_bytes {
                                    let _ = reply.send(Err(anyhow!("Request exceeds the server's message limit")));
                                    continue;
                                }
                                pending.insert(id, reply);
                                match tokio::time::timeout(TIMEOUT, socket.send(Message::Text(raw.into()))).await {
                                    Ok(Ok(())) => {}
                                    Ok(Err(error)) => break error.to_string(),
                                    Err(_) => break "WebSocket write timed out".into(),
                                }
                            }
                            Command::Close => {
                                let _ = tokio::time::timeout(TIMEOUT, socket.close(None)).await;
                                break "Connection closed".into();
                            }
                        }
                    }
                    received = socket.next() => {
                        match received {
                            Some(Ok(Message::Text(raw))) => match serde_json::from_str::<Value>(&raw) {
                                Ok(frame) if frame["version"] == 1 => {
                                    if frame["type"] == "response" {
                                        if let Some(reply) = frame["id"].as_u64().and_then(|id| pending.remove(&id)) {
                                            let result = if frame["success"] == true { Ok(frame["payload"].clone()) } else { Err(remote_error(&frame["error"])) };
                                            let _ = reply.send(result);
                                        }
                                    } else {
                                        let _ = events.send(frame);
                                    }
                                }
                                _ => break "Server sent an invalid signaling message".into(),
                            },
                            Some(Ok(Message::Ping(_))) => {
                                if socket.flush().await.is_err() { break "WebSocket pong failed".into() }
                            }
                            Some(Ok(Message::Close(frame))) => {
                                break frame.map(|frame| format!("Server closed signaling ({}): {}", u16::from(frame.code), frame.reason))
                                    .unwrap_or_else(|| "Server closed signaling".into());
                            }
                            Some(Err(error)) => break error.to_string(),
                            None => break "WebSocket ended".into(),
                            _ => {}
                        }
                    }
                }
            };
            let _ = closed_sender.send(Some(reason.clone()));
            for (_, reply) in pending {
                let _ = reply.send(Err(anyhow!(reason.clone())));
            }
        });
        let snapshot = wire
            .rpc(
                "connection.authenticate",
                json!({ "ticket": ticket, "versions": [1] }),
            )
            .await?;
        Ok(Connected {
            wire,
            snapshot,
            events: subscription,
            heartbeat: Duration::from_secs(capabilities.heartbeat_seconds.clamp(5, 30)),
            ice_servers: capabilities.ice_servers,
            bitrate: capabilities.target_audio_bitrate,
        })
    }
}

pub fn require_success(status: u16, body: Value) -> Result<Value> {
    if (200..300).contains(&status) {
        return Ok(body);
    }
    if body.get("error").is_some() {
        return Err(remote_error(&body["error"]));
    }
    bail!("Request failed with HTTP {status}")
}

fn remote_error(error: &Value) -> anyhow::Error {
    let code = error["code"].as_str().unwrap_or("SIGNALING_ERROR");
    let message = error["message"]
        .as_str()
        .unwrap_or("Server rejected the request");
    anyhow!("{code}: {message}")
}

pub struct Connected {
    pub wire: Wire,
    pub snapshot: Value,
    pub events: broadcast::Receiver<Value>,
    pub heartbeat: Duration,
    pub ice_servers: Value,
    pub bitrate: u32,
}

enum Command {
    Rpc {
        kind: String,
        payload: Value,
        reply: oneshot::Sender<Result<Value>>,
    },
    Close,
}

#[derive(Clone)]
pub struct Wire {
    sender: mpsc::Sender<Command>,
    events: broadcast::Sender<Value>,
    closed: watch::Receiver<Option<String>>,
}

impl Wire {
    pub async fn rpc(&self, kind: &str, payload: Value) -> Result<Value> {
        let (reply, response) = oneshot::channel();
        tokio::time::timeout(TIMEOUT, async {
            self.sender
                .send(Command::Rpc {
                    kind: kind.into(),
                    payload,
                    reply,
                })
                .await
                .context("Signaling connection is closed")?;
            response.await.context("Signaling connection is closed")?
        })
        .await
        .with_context(|| format!("Timed out waiting for {kind}"))?
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    pub async fn closed(&self) -> String {
        let mut signal = self.closed.clone();
        let result = signal.wait_for(Option::is_some).await;
        match result {
            Ok(reason) => reason.clone().unwrap_or_else(|| "Connection closed".into()),
            Err(_) => "Connection closed".into(),
        }
    }

    pub async fn close(&self) {
        let _ = self.sender.send(Command::Close).await;
    }
}
