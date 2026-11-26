use crate::{
    media::{self, RoomVoice},
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
    pub direct_messages: Vec<Value>,
    pub speaking: Vec<String>,
    pub voice: &'static str,
    pub whisper_channel_id: Option<String>,
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

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deafened: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub afk: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub afk_message: Option<String>,
}

impl Presence {
    fn has_changes(&self) -> bool {
        self.muted.is_some() || self.deafened.is_some() || self.afk.is_some() || self.afk_message.is_some()
    }
}

pub enum Action {
    Join {
        id: String,
        password: Option<String>,
    },
    Leave,
    Presence(Presence),
    ReloadAudio,
    Talk { connection_id: String, channel_id: String },
    Whisper { connection_id: String, channel_id: String, target_id: Option<String>, password: Option<String> },
    SendMessage { channel_id: Option<String>, text: String, html: Option<String> },
    DirectRequest {
        connection_id: String,
        kind: String,
        payload: Value,
        reply: oneshot::Sender<Result<Value>>,
    },
    ScreenRequest {
        connection_id: String,
        channel_id: String,
        kind: String,
        payload: Value,
        reply: oneshot::Sender<Result<Value>>,
    },
    SaveChannel(Value),
    DeleteChannel(String),
    MemberAction { kind: &'static str, payload: Value },
    MemberVolume { account_id: String, level: u16 },
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
    pub fn start(session: Session, member_volumes: HashMap<String, u16>) -> Self {
        let (sender, receiver) = mpsc::channel(24);
        let (updates, state) = watch::channel(View::offline());
        tokio::spawn(run(session, receiver, updates, member_volumes));
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

    pub async fn screen_request(&self, connection_id: String, channel_id: String, kind: String, payload: Value) -> Result<Value> {
        let (reply, result) = oneshot::channel();
        self.request(Action::ScreenRequest { connection_id, channel_id, kind, payload, reply }).await?;
        result.await.context("The session has ended")?
    }

    pub async fn direct_request(&self, connection_id: String, kind: String, payload: Value) -> Result<Value> {
        let (reply, result) = oneshot::channel();
        self.request(Action::DirectRequest { connection_id, kind, payload, reply }).await?;
        result.await.context("The session has ended")?
    }
}

async fn run(
    session: Session,
    mut input: mpsc::Receiver<Request>,
    output: watch::Sender<View>,
    mut member_volumes: HashMap<String, u16>,
) {
    let mut desired = None;
    let mut attempt: u32 = 0;
    let mut presence = Presence::default();
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
                let mut active = Active::new(connection, std::mem::take(&mut member_volumes));
                if presence.has_changes() {
                    let was_afk = presence.afk == Some(true);
                    if let Err(error) = active.set_presence(std::mem::take(&mut presence)).await {
                        if was_afk {
                            active.view.error = Some(format!("Could not restore AFK status: {error}"));
                            desired = None;
                        }
                    }
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
                    )
                    .await;
                presence = active.own_presence;
                member_volumes = active.member_volumes;
                if let Some(voice) = active.voice.take() {
                    media::set_push_to_talk(false);
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
    own_presence: Presence,
    member_volumes: HashMap<String, u16>,
}

impl Active {
    fn new(connection: Connected, member_volumes: HashMap<String, u16>) -> Self {
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
            own_presence: Presence::default(),
            member_volumes,
        }
    }

    async fn process(
        &mut self,
        session: &Session,
        mut token_expiry: u64,
        input: &mut mpsc::Receiver<Request>,
        output: &watch::Sender<View>,
        desired: &mut Option<Join>,
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
                    if let Action::Talk { connection_id, channel_id } = &request.action {
                        let result = if self.view.snapshot["connectionId"] == *connection_id &&
                            self.view.snapshot["channelId"] == *channel_id && self.view.voice == "active" &&
                            self.view.whisper_channel_id.is_none() {
                            media::set_push_to_talk(true);
                            Ok(())
                        } else {
                            Err(anyhow::anyhow!("The microphone is unavailable in this channel"))
                        };
                        let _ = request.reply.send(result);
                        continue;
                    }
                    let result = self.action(request.action, desired).await;
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
            Action::Presence(presence) => self.set_presence(presence).await?,
            Action::ReloadAudio => {
                media::set_push_to_talk(false);
                self.view.whisper_channel_id = None;
                if let Some(voice) = self.voice.take() {
                    voice.stop().await;
                }
                self.reconcile_voice().await;
                if let Some(error) = &self.view.voice_error {
                    bail!("{error}");
                }
            }
            Action::Whisper { connection_id, channel_id, target_id, password } => {
                anyhow::ensure!(self.view.snapshot["connectionId"] == connection_id &&
                    self.view.snapshot["channelId"] == channel_id, "The active channel changed");
                if let Some(target_id) = target_id {
                    media::set_push_to_talk(false);
                    anyhow::ensure!(self.view.voice == "active", "The microphone is unavailable");
                    let voice = self.voice.as_mut().context("Join a voice channel before whispering")?;
                    voice.set_whisper(Some((target_id.clone(), password))).await?;
                    self.view.whisper_channel_id = Some(target_id);
                } else if let Some(voice) = &mut self.voice {
                    voice.end_whisper().await?;
                    self.view.whisper_channel_id = None;
                    self.reconcile_voice().await;
                }
            }
            Action::SendMessage { channel_id, text, html } => {
                let channel = self.view.snapshot["channelId"]
                    .as_str()
                    .context("Join a channel to send a message")?;
                anyhow::ensure!(channel_id.as_deref().is_none_or(|id| id == channel), "The active channel changed");
                let mut payload = json!({ "channelId": channel, "text": text });
                if let Some(html) = html { payload["html"] = json!(html); }
                self.connection.wire.rpc("message.send", payload).await?;
            }
            Action::DirectRequest { connection_id, kind, payload, reply } => {
                let result = if self.view.snapshot["connectionId"] == connection_id {
                    self.connection.wire.rpc(&kind, payload).await
                } else {
                    Err(anyhow::anyhow!("The server connection changed"))
                };
                let _ = reply.send(result);
            }
            Action::ScreenRequest { connection_id, channel_id, kind, payload, reply } => {
                let result = if self.view.snapshot["connectionId"] != connection_id || self.view.snapshot["channelId"] != channel_id {
                    Err(anyhow::anyhow!("The active channel changed"))
                } else {
                    self.connection.wire.rpc(&kind, payload).await
                };
                let _ = reply.send(result);
            }
            Action::SaveChannel(payload) => {
                let operation = if payload["channelId"].is_string() {
                    "channel.edit"
                } else {
                    "channel.create"
                };
                let reply = self.connection.wire.rpc(operation, payload).await?;
                self.view.snapshot = reply["state"].clone();
                self.reconcile_voice().await;
            }
            Action::DeleteChannel(id) => {
                self.connection.wire.rpc("channel.delete", json!({ "channelId": id })).await?;
            }
            Action::MemberAction { kind, payload } => {
                self.connection.wire.rpc(kind, payload).await?;
            }
            Action::MemberVolume { account_id, level } => {
                if let Some(voice) = &mut self.voice {
                    voice.set_member_volume(&account_id, level).await?;
                }
                if level == 100 {
                    self.member_volumes.remove(&account_id);
                } else {
                    self.member_volumes.insert(account_id, level);
                }
            }
            Action::Disconnect | Action::Talk { .. } => unreachable!(),
        }
        Ok(())
    }

    async fn set_presence(&mut self, presence: Presence) -> Result<()> {
        if let Some(voice) = self.voice.as_mut() {
            if presence.muted == Some(true) || presence.deafened == Some(true) {
                voice.set_sending(false).await?;
            }
            if presence.deafened == Some(true) {
                voice.set_receiving(false).await?;
            }
        }
        let reply = self.connection.wire.rpc("presence.set", serde_json::to_value(&presence)?).await;
        let reply = match reply {
            Ok(reply) => reply,
            Err(error) => {
                self.reconcile_voice().await;
                return Err(error);
            }
        };
        self.own_presence.muted = presence.muted.or(self.own_presence.muted);
        self.own_presence.deafened = presence.deafened.or(self.own_presence.deafened);
        self.own_presence.afk = presence.afk.or(self.own_presence.afk);
        if let Some(message) = presence.afk_message {
            self.own_presence.afk_message = Some(message);
        }
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
        media::set_push_to_talk(false);
        self.view.whisper_channel_id = None;
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
        let own_member = self.view.snapshot["members"]
            .as_array()
            .and_then(|members| {
                members.iter().find(|member| member["connectionId"] == self.view.snapshot["connectionId"])
            });
        let muted = self.own_presence.muted == Some(true) || own_member.is_some_and(|member| member["adminMuted"] == true);
        let deafened = self.own_presence.afk == Some(true) || self.own_presence.deafened == Some(true)
            || own_member.is_some_and(|member| member["adminDeafened"] == true);
        let bitrate = self.view.snapshot["channels"].as_array()
            .and_then(|channels| channels.iter().find(|entry| entry["id"] == channel))
            .and_then(|entry| entry["audioBitrate"].as_u64())
            .or_else(|| self.view.snapshot["targetAudioBitrate"].as_u64())
            .and_then(|bitrate| u32::try_from(bitrate).ok())
            .unwrap_or(self.connection.bitrate);
        let outcome = async {
            if self.voice.is_none() {
                self.voice = Some(
                    RoomVoice::start(
                        self.connection.wire.clone(),
                        channel,
                        self.connection.ice_servers.clone(),
                        bitrate,
                        false,
                        self.member_volumes.clone(),
                    )
                    .await?,
                );
            }
            let voice = self.voice.as_mut().context("Audio failed to initialize")?;
            if muted || deafened {
                voice.end_whisper().await?;
                self.view.whisper_channel_id = None;
            }
            voice.set_bitrate(bitrate).await?;
            voice.set_receiving(!deafened).await?;
            voice.set_sending(!deafened && !muted).await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;

        match outcome {
            Ok(()) => {
                self.view.voice = if deafened {
                    "deafened"
                } else if muted {
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
            "channel.member" | "channel.voiceActivity" => {
                if let Some(channel) = payload["channelId"].as_str() {
                    let visible = self.view.snapshot["channels"].as_array().is_some_and(|channels|
                        channels.iter().any(|entry| entry["id"] == channel));
                    if visible {
                        if let Some(tree) = self.view.snapshot["channelMembers"].as_object_mut() {
                            let members = tree.entry(channel).or_insert_with(|| json!([]));
                            if let Some(members) = members.as_array_mut() {
                                let id = &payload["connectionId"];
                                if event["type"] == "channel.voiceActivity" {
                                    if let Some(member) = members.iter_mut().find(|member| member["connectionId"] == *id) {
                                        member["speaking"] = payload["speaking"].clone();
                                    }
                                } else {
                                    members.retain(|member| member["connectionId"] != *id);
                                    if payload["left"] != true {
                                        members.push(payload.clone());
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "channel.changed" => {
                self.resync().await?;
                *desired = self.view.snapshot["channelId"].as_str().map(|id| Join {
                    id: id.into(),
                    password: None,
                });
            }
            "channel.userJoined" | "channel.userChanged" if same_room => {
                if payload["connectionId"] == self.view.snapshot["connectionId"] {
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
            "direct.created" if payload["senderId"] == self.view.snapshot["account"]["id"] ||
                payload["recipientId"] == self.view.snapshot["account"]["id"] =>
            {
                if !self.view.direct_messages.iter().any(|message| message["id"] == payload["id"]) {
                    self.view.direct_messages.push(payload.clone());
                    if self.view.direct_messages.len() > 50 {
                        self.view.direct_messages.remove(0);
                    }
                }
            }
            "message.deleted" => self
                .view
                .messages
                .retain(|message| message["id"] != payload["messageId"]),
            "media.screenAvailable" | "media.screenClosed" | "media.cameraAvailable" | "media.cameraClosed" if same_room => {
                let event_type = event["type"].as_str().unwrap_or_default();
                let source = if event_type.starts_with("media.camera") { "cameras" } else { "screens" };
                if let Some(shares) = self.view.snapshot[source].as_array_mut() {
                    shares.retain(|share| share["producerId"] != payload["producerId"]);
                    if event_type.ends_with("Available") {
                        shares.push(payload.clone());
                    }
                }
            }
            "media.producerAvailable"
                if same_room && payload["connectionId"] != self.view.snapshot["connectionId"] =>
            {
                if let (Some(producer), Some(connection)) = (
                    payload["producerId"].as_str(),
                    payload["connectionId"].as_str(),
                ) {
                    if let (Some(from), Some(whispers)) = (payload["whisperFrom"].as_str(), self.view.snapshot["whispers"].as_array_mut()) {
                        whispers.retain(|entry| entry["producerId"] != producer);
                        whispers.push(json!({ "producerId": producer, "from": from }));
                    }
                    self.producers.insert(producer.into(), connection.into());
                    if let Some(voice) = &mut self.voice {
                        voice.add_producer(producer).await?;
                    }
                }
            }
            "media.producerClosed" | "media.consumerClosed" if same_room => {
                if let Some(producer) = payload["producerId"].as_str() {
                    if let Some(whispers) = self.view.snapshot["whispers"].as_array_mut() {
                        whispers.retain(|entry| entry["producerId"] != producer);
                    }
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
            "media.whisperEnded" if same_room => {
                if let (Some(id), Some(voice)) = (payload["transportId"].as_str(), &mut self.voice) {
                    if voice.whisper_transport(id) {
                        voice.end_whisper().await?;
                        self.view.whisper_channel_id = None;
                        self.reconcile_voice().await;
                    }
                }
            }
            "media.reset" | "media.transportFailed" if same_room => {
                self.view.whisper_channel_id = None;
                if event["type"] == "media.reset" {
                    self.view.snapshot["whispers"] = json!([]);
                    self.view.snapshot["screens"] = json!([]);
                    if self.view.snapshot["cameras"].is_array() {
                        self.view.snapshot["cameras"] = json!([]);
                    }
                }
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
