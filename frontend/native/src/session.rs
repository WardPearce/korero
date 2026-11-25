use crate::{
    media::RoomVoice,
    signaling::{Connected, Credentials, Server},
};
use anyhow::{bail, Context, Result};
use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{broadcast, mpsc, oneshot, watch, Mutex};

#[derive(Clone)]
pub struct Session {
    credentials: Arc<Mutex<Credentials>>,
    pub server: Server,
}

impl Session {
    pub fn new(server: Server, credentials: Credentials) -> Self {
        Self {
            server,
            credentials: Arc::new(Mutex::new(credentials)),
        }
    }

    async fn credentials(&self) -> Result<Credentials> {
        let mut state = self.credentials.lock().await;
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
        if state.refresh_expires_at <= now {
            bail!("AUTH_FAILED: Device session expired. Recover your account to reconnect.");
        }
        if state.access_expires_at <= now + 15_000 {
            *state = self.server.refresh(&state).await?;
        }
        Ok(state.clone())
    }

    pub async fn http(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value)> {
        let state = self.credentials().await?;
        self.server
            .http(method, path, body, Some(&state.access_token))
            .await
    }

    async fn connect(&self) -> Result<(Connected, u64)> {
        let credentials = self.credentials().await?;
        Ok((
            self.server.authenticate(&credentials).await?,
            credentials.access_expires_at,
        ))
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub phase: &'static str,
    pub snapshot: Value,
    pub messages: Vec<Value>,
    pub speaking: Vec<String>,
    pub voice: &'static str,
    pub voice_error: Option<String>,
    pub error: Option<String>,
}

impl View {
    pub fn offline() -> Self {
        Self {
            phase: "offline",
            voice: "idle",
            ..Self::default()
        }
    }
}

#[derive(Clone)]
struct Join {
    id: String,
    password: Option<String>,
}

pub enum Action {
    Join {
        id: String,
        password: Option<String>,
    },
    Leave,
    Presence {
        muted: Option<bool>,
        deafened: Option<bool>,
    },
    SendMessage(String),
    CreateChannel(String),
    Disconnect,
}

struct Request {
    action: Action,
    reply: oneshot::Sender<Result<()>>,
}

#[derive(Clone)]
pub struct Controller {
    sender: mpsc::Sender<Request>,
    pub state: watch::Receiver<View>,
}

impl Controller {
    pub fn start(session: Session) -> Self {
        let (sender, receiver) = mpsc::channel(24);
        let (updates, state) = watch::channel(View::offline());
        tokio::spawn(run(session, receiver, updates));
        Self { sender, state }
    }

    pub async fn request(&self, action: Action) -> Result<()> {
        let disconnecting = matches!(action, Action::Disconnect);
        let (reply, result) = oneshot::channel();
        self.sender
            .send(Request { action, reply })
            .await
            .context("The session has ended")?;
        result.await.context("The session has ended")??;
        if disconnecting {
            let mut state = self.state.clone();
            // The sender is owned by the session task. Its drop follows native teardown.
            while state.changed().await.is_ok() {}
        }
        Ok(())
    }
}

async fn run(session: Session, mut input: mpsc::Receiver<Request>, output: watch::Sender<View>) {
    let mut desired = None;
    let mut attempt: u32 = 0;
    let mut muted = None;
    let mut deafened = None;
    loop {
        let phase = if attempt == 0 {
            "connecting"
        } else {
            "reconnecting"
        };
        output.send_replace(View {
            phase,
            ..View::offline()
        });
        let connection = tokio::select! {
            result = session.connect() => result,
            stopped = wait_or_disconnect(&mut input) => {
                debug_assert!(stopped);
                return;
            }
        };
        let problem = match connection {
            Ok((connection, token_expiry)) => {
                let mut active = Active::new(connection);
                if muted.is_some() || deafened.is_some() {
                    let _ = active.presence(muted, deafened).await;
                }
                if let Some(join) = &desired {
                    if let Err(error) = active.join(join).await {
                        active.view.error = Some(error.to_string());
                        desired = None;
                    }
                }
                attempt = 0;
                let result = active
                    .process(
                        &session,
                        token_expiry,
                        &mut input,
                        &output,
                        &mut desired,
                        &mut muted,
                        &mut deafened,
                    )
                    .await;
                if let Some(voice) = active.voice.take() {
                    voice.stop().await;
                }
                active.connection.wire.close().await;
                match result {
                    Some(problem) => problem,
                    None => {
                        output.send_replace(View::offline());
                        return;
                    }
                }
            }
            Err(error) => format!("{error:#}"),
        };

        if problem.starts_with("AUTH_FAILED:") || problem.contains("(4403)") {
            output.send_replace(View {
                phase: "error",
                error: Some(problem),
                ..View::offline()
            });
            return;
        }
        attempt = attempt.saturating_add(1);
        output.send_replace(View {
            phase: "reconnecting",
            error: Some(problem),
            ..View::offline()
        });
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(2_u64.pow(attempt.min(5) - 1))) => {}
            _ = wait_or_disconnect(&mut input) => {
                output.send_replace(View::offline());
                return;
            }
        }
    }
}

async fn wait_or_disconnect(input: &mut mpsc::Receiver<Request>) -> bool {
    while let Some(request) = input.recv().await {
        if matches!(request.action, Action::Disconnect) {
            let _ = request.reply.send(Ok(()));
            return true;
        }
        let _ = request
            .reply
            .send(Err(anyhow::anyhow!("Still connecting to the server")));
    }
    true
}

struct Active {
    connection: Connected,
    view: View,
    voice: Option<RoomVoice>,
    producers: HashMap<String, String>,
    speaking: HashMap<String, bool>,
    own_muted: bool,
    own_deafened: bool,
}

impl Active {
    fn new(connection: Connected) -> Self {
        let view = View {
            phase: "online",
            snapshot: connection.snapshot.clone(),
            ..View::offline()
        };
        Self {
            connection,
            view,
            voice: None,
            producers: HashMap::new(),
            speaking: HashMap::new(),
            own_muted: false,
            own_deafened: false,
        }
    }

    async fn process(
        &mut self,
        session: &Session,
        mut token_expiry: u64,
        input: &mut mpsc::Receiver<Request>,
        output: &watch::Sender<View>,
        desired: &mut Option<Join>,
        muted: &mut Option<bool>,
        deafened: &mut Option<bool>,
    ) -> Option<String> {
        let wire = self.connection.wire.clone();
        let mut heartbeat = tokio::time::interval(self.connection.heartbeat);
        let mut refresh = tokio::time::interval(Duration::from_secs(10));
        output.send_replace(self.view.clone());
        loop {
            tokio::select! {
                reason = wire.closed() => return Some(reason),
                _ = heartbeat.tick() => {
                    if let Err(error) = wire.rpc("heartbeat", json!({})).await {
                        return Some(error.to_string());
                    }
                }
                _ = refresh.tick() => {
                    let outcome = async {
                        let credentials = session.credentials().await?;
                        if credentials.access_expires_at != token_expiry {
                            let ticket = session.server.ticket(&credentials).await?;
                            wire.rpc("connection.renew", json!({ "ticket": ticket })).await?;
                            token_expiry = credentials.access_expires_at;
                        }
                        Ok::<_, anyhow::Error>(())
                    }.await;
                    if let Err(error) = outcome { return Some(error.to_string()) }
                }
                next = input.recv() => {
                    let request = next?;
                    if matches!(request.action, Action::Disconnect) {
                        let _ = request.reply.send(Ok(()));
                        return None;
                    }
                    let result = self.action(request.action, desired).await;
                    *muted = Some(self.own_muted);
                    *deafened = Some(self.own_deafened);
                    output.send_replace(self.view.clone());
                    let _ = request.reply.send(result);
                }
                next = self.connection.events.recv() => {
                    let result = match next {
                        Ok(event) => self.event(event, desired).await,
                        Err(broadcast::error::RecvError::Lagged(_)) => self.resync().await,
                        Err(broadcast::error::RecvError::Closed) => return Some("Signaling events ended".into()),
                    };
                    if let Err(error) = result { self.view.error = Some(error.to_string()); }
                    output.send_replace(self.view.clone());
                }
            }
        }
    }

    async fn action(&mut self, action: Action, desired: &mut Option<Join>) -> Result<()> {
        self.view.error = None;
        match action {
            Action::Join { id, password } => {
                let channel = Join { id, password };
                self.join(&channel).await?;
                *desired = Some(channel);
            }
            Action::Leave => {
                self.view.snapshot = self.connection.wire.rpc("channel.leave", json!({})).await?;
                *desired = None;
                self.reset_room().await;
            }
            Action::Presence { muted, deafened } => self.presence(muted, deafened).await?,
            Action::SendMessage(text) => {
                let channel = self.view.snapshot["channelId"]
                    .as_str()
                    .context("Join a channel to send a message")?;
                self.connection
                    .wire
                    .rpc(
                        "message.send",
                        json!({ "channelId": channel, "text": text }),
                    )
                    .await?;
            }
            Action::CreateChannel(name) => {
                let reply = self
                    .connection
                    .wire
                    .rpc("channel.create", json!({ "name": name }))
                    .await?;
                self.view.snapshot = reply["state"].clone();
            }
            Action::Disconnect => unreachable!(),
        }
        Ok(())
    }

    async fn presence(&mut self, muted: Option<bool>, deafened: Option<bool>) -> Result<()> {
        if let Some(voice) = self.voice.as_mut() {
            if muted == Some(true) || deafened == Some(true) {
                voice.set_sending(false).await?;
            }
            if deafened == Some(true) {
                voice.set_receiving(false).await?;
            }
        }
        let mut payload = json!({});
        if let Some(muted) = muted {
            payload["muted"] = json!(muted);
        }
        if let Some(deafened) = deafened {
            payload["deafened"] = json!(deafened);
        }
        let reply = self.connection.wire.rpc("presence.set", payload).await?;
        self.own_muted = reply["muted"] == true;
        self.own_deafened = reply["deafened"] == true;
        if self.view.snapshot["channelId"].is_string() {
            self.update_member(reply);
        }
        self.reconcile_voice().await;
        Ok(())
    }

    async fn join(&mut self, join: &Join) -> Result<()> {
        let previous = self.view.snapshot["channelId"].clone();
        let mut payload = json!({ "channelId": join.id });
        if let Some(password) = &join.password {
            payload["password"] = json!(password);
        }
        self.view.snapshot = self.connection.wire.rpc("channel.join", payload).await?;
        if previous != self.view.snapshot["channelId"] {
            self.reset_room().await;
        }
        self.history().await;
        self.reconcile_voice().await;
        Ok(())
    }

    async fn reset_room(&mut self) {
        if let Some(voice) = self.voice.take() {
            voice.stop().await;
        }
        self.producers.clear();
        self.speaking.clear();
        self.view.speaking.clear();
        self.view.messages.clear();
        self.view.voice = "idle";
        self.view.voice_error = None;
    }

    async fn resync(&mut self) -> Result<()> {
        let previous = self.view.snapshot["channelId"].clone();
        self.view.snapshot = self.connection.wire.rpc("state.get", json!({})).await?;
        if previous != self.view.snapshot["channelId"] {
            self.reset_room().await;
            self.history().await;
        }
        self.reconcile_voice().await;
        Ok(())
    }

    async fn history(&mut self) {
        let Some(channel) = self.view.snapshot["channelId"].as_str() else {
            return;
        };
        if let Ok(history) = self
            .connection
            .wire
            .rpc("message.history", json!({ "channelId": channel }))
            .await
        {
            if let Some(messages) = history.as_array() {
                self.view.messages = messages.iter().rev().cloned().collect();
            }
        }
    }

    async fn reconcile_voice(&mut self) {
        let Some(channel) = self.view.snapshot["channelId"].as_str().map(str::to_owned) else {
            return;
        };
        let restricted = self.view.snapshot["members"]
            .as_array()
            .is_some_and(|members| {
                members.iter().any(|member| {
                    member["connectionId"] == self.view.snapshot["connectionId"]
                        && member["adminMuted"] == true
                })
            });
        let outcome = async {
            if self.voice.is_none() {
                self.voice = Some(
                    RoomVoice::start(
                        self.connection.wire.clone(),
                        channel,
                        self.connection.ice_servers.clone(),
                        self.connection.bitrate,
                        false,
                    )
                    .await?,
                );
            }
            let voice = self.voice.as_mut().context("Audio failed to initialize")?;
            voice.set_receiving(!self.own_deafened).await?;
            voice
                .set_sending(!self.own_deafened && !self.own_muted && !restricted)
                .await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;

        match outcome {
            Ok(()) => {
                self.view.voice = if self.own_deafened {
                    "deafened"
                } else if self.own_muted || restricted {
                    "muted"
                } else {
                    "active"
                };
                self.view.voice_error = None;
            }
            Err(error) => {
                self.view.voice = "error";
                self.view.voice_error = Some(error.to_string());
            }
        }
    }

    fn update_member(&mut self, member: Value) {
        if let Some(members) = self.view.snapshot["members"].as_array_mut() {
            members.retain(|entry| entry["connectionId"] != member["connectionId"]);
            members.push(member);
        }
    }

    async fn event(&mut self, event: Value, desired: &mut Option<Join>) -> Result<()> {
        let payload = &event["payload"];
        let same_room = payload.get("channelId").is_none()
            || payload["channelId"] == self.view.snapshot["channelId"];
        match event["type"].as_str().unwrap_or_default() {
            "state.invalidated" | "presence.changed" | "presence.offline" => self.resync().await?,
            "channel.changed" => {
                self.resync().await?;
                *desired = self.view.snapshot["channelId"].as_str().map(|id| Join {
                    id: id.into(),
                    password: None,
                });
            }
            "channel.userJoined" | "channel.userChanged" if same_room => {
                if payload["connectionId"] == self.view.snapshot["connectionId"] {
                    self.own_muted = payload["muted"] == true;
                    self.own_deafened = payload["deafened"] == true;
                    self.update_member(payload.clone());
                    self.reconcile_voice().await;
                } else {
                    self.update_member(payload.clone());
                }
            }
            "channel.userLeft" if same_room => {
                if let Some(members) = self.view.snapshot["members"].as_array_mut() {
                    members.retain(|entry| entry["connectionId"] != payload["connectionId"]);
                }
            }
            "message.created" if same_room && !payload["channelId"].is_null() => {
                if !self
                    .view
                    .messages
                    .iter()
                    .any(|message| message["id"] == payload["id"])
                {
                    self.view.messages.push(payload.clone());
                    if self.view.messages.len() > 200 {
                        self.view.messages.remove(0);
                    }
                }
            }
            "message.deleted" => self
                .view
                .messages
                .retain(|message| message["id"] != payload["messageId"]),
            "media.producerAvailable"
                if same_room && payload["connectionId"] != self.view.snapshot["connectionId"] =>
            {
                if let (Some(producer), Some(connection)) = (
                    payload["producerId"].as_str(),
                    payload["connectionId"].as_str(),
                ) {
                    self.producers.insert(producer.into(), connection.into());
                    if let Some(voice) = &mut self.voice {
                        voice.add_producer(producer).await?;
                    }
                }
            }
            "media.producerClosed" | "media.consumerClosed" if same_room => {
                if let Some(producer) = payload["producerId"].as_str() {
                    self.producers.remove(producer);
                    self.speaking.remove(producer);
                    self.update_speaking();
                    if let Some(voice) = &mut self.voice {
                        voice.remove_producer(producer).await?;
                    }
                }
            }
            "media.speaking" => {
                if let Some(producer) = payload["producerId"].as_str() {
                    if !self.producers.contains_key(producer) {
                        let list = self
                            .connection
                            .wire
                            .rpc("media.producers", json!({}))
                            .await?;
                        if let Some(list) = list.as_array() {
                            for entry in list {
                                if let (Some(id), Some(connection)) =
                                    (entry["producerId"].as_str(), entry["connectionId"].as_str())
                                {
                                    self.producers.insert(id.into(), connection.into());
                                }
                            }
                        }
                    }
                    if self.producers.contains_key(producer) {
                        self.speaking
                            .insert(producer.into(), payload["speaking"] == true);
                        self.update_speaking();
                    }
                }
            }
            "media.reset" | "media.transportFailed" if same_room => {
                if let Some(voice) = self.voice.take() {
                    voice.stop().await;
                }
                self.reconcile_voice().await;
            }
            _ => {}
        }
        Ok(())
    }

    fn update_speaking(&mut self) {
        self.view.speaking = self
            .speaking
            .iter()
            .filter(|(_, &speaking)| speaking)
            .filter_map(|(producer, _)| self.producers.get(producer).cloned())
            .collect();
    }
}
