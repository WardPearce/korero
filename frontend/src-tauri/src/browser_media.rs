use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    body::{Bytes, Incoming},
    header::{AUTHORIZATION, CONTENT_SECURITY_POLICY, HOST, ORIGIN},
    server::conn::http1,
    service::service_fn,
    Method, Request, Response, StatusCode,
};
use hyper_util::rt::TokioIo;
use korero_native::session::Controller;
use ring::rand::{SecureRandom, SystemRandom};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    convert::Infallible,
    process::{Command, Stdio},
    sync::{Arc, Mutex as SyncMutex},
    time::{Duration, Instant},
};
use tauri::AppHandle;
use tokio::{net::TcpListener, sync::{Mutex, Semaphore}};

const CSP: &str = "default-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const PAIRING_TIMEOUT: Duration = Duration::from_secs(60);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(25);
type Reply = Response<Full<Bytes>>;

#[derive(Default)]
struct Resources {
    transports: HashSet<String>,
    producers: HashSet<String>,
    consumers: HashSet<String>,
}

struct Bridge {
    app: AppHandle,
    controller: Controller,
    connection_id: String,
    channel_id: String,
    source: String,
    share: bool,
    authority: String,
    origin: String,
    authorization: String,
    expires: SyncMutex<Instant>,
    resources: Mutex<Resources>,
}

#[derive(Deserialize)]
struct Rpc {
    kind: String,
    payload: Value,
}

pub async fn open(
    app: AppHandle,
    controller: Controller,
    connection_id: String,
    channel_id: String,
    source: String,
    share: bool,
) -> Result<()> {
    ensure!(matches!(source.as_str(), "screen" | "camera"), "Invalid video source");
    ensure!(
        app.asset_resolver().get("media/index.html".into()).is_some(),
        "The VNX.chat browser media assets are missing"
    );
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let authority = listener.local_addr()?.to_string();
    let origin = format!("http://{authority}");
    let mut secret = [0; 32];
    SystemRandom::new().fill(&mut secret).map_err(|_| anyhow::anyhow!("Could not generate a video link"))?;
    let token = URL_SAFE_NO_PAD.encode(secret);
    let bridge = Arc::new(Bridge {
        app,
        controller,
        connection_id,
        channel_id,
        source,
        share,
        authority,
        origin,
        authorization: format!("Bearer {token}"),
        expires: SyncMutex::new(Instant::now() + PAIRING_TIMEOUT),
        resources: Mutex::default(),
    });
    bridge.snapshot().context("The active channel changed")?;
    let mut browser = Command::new("xdg-open")
        .arg(format!("{}/#{token}", bridge.origin))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("Could not open the default browser")?;
    tauri::async_runtime::spawn_blocking(move || { let _ = browser.wait(); });
    tauri::async_runtime::spawn(bridge.serve(listener));
    Ok(())
}

impl Bridge {
    fn snapshot(&self) -> Option<Value> {
        let current = self.controller.state.borrow();
        (current.phase == "online" && current.snapshot["connectionId"] == self.connection_id
            && current.snapshot["channelId"] == self.channel_id)
            .then(|| current.snapshot.clone())
    }

    fn live(&self) -> bool {
        Instant::now() < *self.expires.lock().unwrap() && self.snapshot().is_some()
    }

    async fn serve(self: Arc<Self>, listener: TcpListener) {
        let slots = Arc::new(Semaphore::new(16));
        let mut check = tokio::time::interval(Duration::from_secs(2));
        loop {
            tokio::select! {
                _ = check.tick() => {
                    if !self.live() { break; }
                }
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { break };
                    let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
                    let bridge = self.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        let connection = http1::Builder::new().keep_alive(false).serve_connection(
                            TokioIo::new(stream),
                            service_fn(move |request| {
                                let bridge = bridge.clone();
                                async move { Ok::<_, Infallible>(bridge.handle(request).await) }
                            }),
                        );
                        let _ = tokio::time::timeout(Duration::from_secs(15), connection).await;
                    });
                }
            }
        }
        *self.expires.lock().unwrap() = Instant::now();
        let transports = std::mem::take(&mut self.resources.lock().await.transports);
        for transport_id in transports {
            let _ = self.request("media.transport.close", json!({ "transportId": transport_id })).await;
        }
    }

    async fn handle(&self, request: Request<Incoming>) -> Reply {
        let header = |name| request.headers().get(name).and_then(|value| value.to_str().ok());
        if header(HOST) != Some(self.authority.as_str()) {
            return failure(StatusCode::FORBIDDEN, "Invalid local address.");
        }
        let path = request.uri().path();
        if request.method() == Method::GET {
            let asset_path = if path == "/" { "/media/index.html" } else { path };
            if (asset_path == "/media/index.html" || asset_path.starts_with("/media/assets/"))
                && asset_path.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"/-._".contains(&byte))
                && !asset_path.split('/').any(|segment| matches!(segment, "." | ".."))
            {
                if let Some(asset) = self.app.asset_resolver().get(asset_path.into()) {
                    return reply(StatusCode::OK, &asset.mime_type, asset.bytes);
                }
            }
            return failure(StatusCode::NOT_FOUND, "Page unavailable.");
        }
        if request.method() != Method::POST || path != "/rpc" {
            return failure(StatusCode::NOT_FOUND, "Page unavailable.");
        }
        if header(ORIGIN) != Some(self.origin.as_str()) || header(AUTHORIZATION) != Some(self.authorization.as_str()) {
            return failure(StatusCode::FORBIDDEN, "Open a new video link from VNX.chat.");
        }
        if !self.live() {
            return failure(StatusCode::GONE, "The video session ended. Open a new link from VNX.chat.");
        }
        let Ok(bytes) = Limited::new(request.into_body(), 65536).collect().await else {
            return failure(StatusCode::BAD_REQUEST, "Invalid video request.");
        };
        let Ok(rpc) = serde_json::from_slice::<Rpc>(&bytes.to_bytes()) else {
            return failure(StatusCode::BAD_REQUEST, "Invalid video request.");
        };
        match self.rpc(rpc).await {
            Ok(result) => reply(StatusCode::OK, "application/json", result.to_string().into_bytes()),
            Err(error) => failure(StatusCode::BAD_REQUEST, &error.to_string()),
        }
    }

    async fn rpc(&self, Rpc { kind, payload }: Rpc) -> Result<Value> {
        let mut resources = self.resources.lock().await;
        ensure!(self.live(), "The video session ended. Open a new link from VNX.chat.");
        match kind.as_str() {
            "state" => {
                *self.expires.lock().unwrap() = Instant::now() + HEARTBEAT_TIMEOUT;
                let snapshot = self.snapshot().context("The active channel changed")?;
                return Ok(json!({ "snapshot": snapshot, "source": self.source, "share": self.share }));
            }
            "close" => {
                *self.expires.lock().unwrap() = Instant::now();
                return Ok(json!({}));
            }
            "media.capabilities" => ensure!(payload["kind"] == "video", "Expected video capabilities"),
            "media.transport.create" => {
                let source = payload["videoSource"].as_str().unwrap_or("screen");
                ensure!(payload["kind"] == "video" && source == self.source, "Expected a video transport");
            }
            "media.transport.connect" | "media.transport.close" | "media.producer.create" | "media.consumer.create" =>
                authorize(&resources.transports, &payload["transportId"])?,
            "media.producer.close" => authorize(&resources.producers, &payload["producerId"])?,
            "media.consumer.resume" => authorize(&resources.consumers, &payload["consumerId"])?,
            _ => anyhow::bail!("Unsupported video operation"),
        }
        let transport_id = payload["transportId"].as_str().map(str::to_owned);
        let result = self.request(&kind, payload).await?;
        if let Some(id) = result["id"].as_str() {
            match kind.as_str() {
                "media.transport.create" => { resources.transports.insert(id.into()); }
                "media.producer.create" => { resources.producers.insert(id.into()); }
                "media.consumer.create" => { resources.consumers.insert(id.into()); }
                _ => {}
            }
        }
        if kind == "media.transport.close" {
            if let Some(id) = transport_id { resources.transports.remove(&id); }
        }
        Ok(result)
    }

    async fn request(&self, kind: &str, payload: Value) -> Result<Value> {
        self.controller.screen_request(
            self.connection_id.clone(), self.channel_id.clone(), kind.into(), payload,
        ).await
    }
}

fn authorize(ids: &HashSet<String>, id: &Value) -> Result<()> {
    ensure!(id.as_str().is_some_and(|id| ids.contains(id)), "Video resource is unavailable");
    Ok(())
}

fn reply(status: StatusCode, mime: &str, bytes: Vec<u8>) -> Reply {
    Response::builder().status(status)
        .header("content-type", mime)
        .header(CONTENT_SECURITY_POLICY, CSP)
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .header("x-content-type-options", "nosniff")
        .body(Full::new(Bytes::from(bytes)))
        .expect("Valid fixed video response headers")
}

fn failure(status: StatusCode, message: &str) -> Reply {
    reply(status, "application/json", json!({ "error": message }).to_string().into_bytes())
}
