#[path = "../identity.rs"]
mod identity;

use anyhow::{ensure, Context, Result};
use korero_native::{
    media::{self, AudioProfile},
    session::{Action, Controller, Presence, Session, View},
    signaling::{CertificateInfo, Credentials, Server, ServerContact},
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, Mutex},
    task::JoinSet,
};

const MAX_MEMBER_VOLUME: u16 = 400;

#[derive(Default)]
struct Client {
    server: Option<Server>,
    contact: Option<ServerContact>,
    session: Option<Session>,
    controller: Option<Controller>,
    generation: u64,
}

struct AppState {
    client: Mutex<Client>,
    audio: Mutex<Option<AudioProfile>>,
    outgoing: mpsc::UnboundedSender<Value>,
    #[cfg(target_os = "linux")]
    shortcut: Mutex<Option<Shortcut>>,
}

#[derive(Serialize)]
struct HttpReply {
    status: u16,
    body: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceStateResponse {
    #[serde(flatten)]
    view: View,
    server_origin: Option<String>,
}

type CommandResult<T> = std::result::Result<T, String>;

fn display(error: anyhow::Error) -> String {
    format!("{error:#}")
}

async fn inspect_server(address: String, state: &AppState) -> CommandResult<CertificateInfo> {
    let contact = ServerContact::discover(&address).await.map_err(display)?;
    let info = CertificateInfo {
        origin: contact.info.origin.clone(),
        fingerprint: contact.info.fingerprint.clone(),
        publicly_trusted: contact.info.publicly_trusted,
    };
    state.client.lock().await.contact = Some(contact);
    Ok(info)
}

async fn prepare_server(
    origin: String,
    fingerprint: Option<String>,
    state: &AppState,
) -> CommandResult<String> {
    let (previous, session) = {
        let mut client = state.client.lock().await;
        let contact = client.contact.take().ok_or("Check the server certificate first")?;
        if contact.info.origin != origin {
            return Err("The selected server changed".into());
        }
        let server = contact.approve(fingerprint.as_deref()).map_err(display)?;
        client.generation += 1;
        client.server = Some(server);
        emit(state, View::offline());
        (client.controller.take(), client.session.take())
    };
    if let Some(previous) = previous {
        let _ = previous.request(Action::Disconnect).await;
    }
    logout(session).await;
    Ok(origin)
}

async fn api_fetch(
    origin: String,
    method: String,
    path: String,
    body: Option<Value>,
    state: &AppState,
) -> CommandResult<HttpReply> {
    fetch(origin, method, path, body, state)
        .await
        .map_err(display)
}

async fn fetch(
    origin: String,
    method: String,
    path: String,
    body: Option<Value>,
    state: &AppState,
) -> Result<HttpReply> {
    let (server, session) = {
        let client = state.client.lock().await;
        let server = client.server.clone().context("Select a server first")?;
        ensure!(server.origin() == origin, "The selected server changed");
        (server, client.session.clone())
    };
    let is_public = matches!(
        (method.as_str(), path.as_str()),
        ("GET", "/api/v1/server/info" | "/api/v1/server/capabilities")
    );
    let is_account = matches!(
        (method.as_str(), path.as_str()),
        ("GET", "/api/v1/account" | "/api/v1/account/sessions") | ("PATCH", "/api/v1/account")
    );
    let endpoint = path.split('?').next().unwrap_or_default();
    let is_administration = matches!(
        (method.as_str(), endpoint),
        ("GET", "/api/v1/admin/accounts" | "/api/v1/admin/invitations" | "/api/v1/admin/audit"
            | "/api/v1/admin/password" | "/api/v1/admin/preferences")
            | ("PATCH", "/api/v1/admin/roles" | "/api/v1/admin/roles/definition" | "/api/v1/admin/banner"
                | "/api/v1/admin/password" | "/api/v1/admin/preferences" | "/api/v1/channels/order")
            | ("DELETE", "/api/v1/admin/roles/definition")
            | ("POST", "/api/v1/admin/invitations" | "/api/v1/admin/roles")
    ) || (matches!(method.as_str(), "PATCH" | "DELETE")
        && endpoint.strip_prefix("/api/v1/admin/invitations/").is_some_and(|id| {
            id.len() == 36 && id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        }));
    let is_attachment = (method == "POST" && endpoint == "/api/v1/chat/attachments")
        || (method == "GET" && endpoint.strip_prefix("/api/v1/chat/attachments/").is_some_and(|id| {
            id.len() == 36 && id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        }));
    let is_connection_info = method == "GET" && path.strip_prefix("/api/v1/connections/").is_some_and(|id| {
        id.len() == 36 && id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    });
    ensure!(is_public || is_account || is_administration || is_attachment || is_connection_info, "Unsupported client HTTP operation");
    let method = Method::from_bytes(method.as_bytes())?;
    let (status, body) = if is_public {
        server.http(method, &path, body, None).await?
    } else {
        session
            .context("You are not signed in")?
            .http(method, &path, body)
            .await?
    };
    Ok(HttpReply { status, body })
}

fn strip_credentials(body: &mut Value) {
    if let Some(profile) = body.as_object_mut() {
        for field in ["accessToken", "refreshToken", "accessExpiresAt", "refreshExpiresAt", "sessionId"] {
            profile.remove(field);
        }
    }
}

async fn start_session(
    member_volumes: Option<HashMap<String, u16>>,
    state: &Arc<AppState>,
) -> CommandResult<()> {
    let (mut updates, generation) = {
        let mut client = state.client.lock().await;
        if client
            .controller
            .as_ref()
            .is_some_and(|existing| existing.state.has_changed().is_ok())
        {
            return Ok(());
        }
        let session = client
            .session
            .clone()
            .ok_or("Sign in with an identity first")?;
        let mut member_volumes = member_volumes.unwrap_or_default();
        member_volumes.retain(|_, level| *level != 100 && *level <= MAX_MEMBER_VOLUME);
        let controller = Controller::start(session, member_volumes);
        let updates = controller.state.clone();
        client.generation += 1;
        client.controller = Some(controller);
        (updates, client.generation)
    };
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            let view = updates.borrow_and_update().clone();
            let current = state.client.lock().await;
            if current.generation != generation {
                break;
            }
            emit(&state, view);
            drop(current);
            if updates.changed().await.is_err() {
                break;
            }
        }
    });
    Ok(())
}

async fn disconnect(state: &AppState) -> CommandResult<()> {
    let (controller, session) = {
        let mut client = state.client.lock().await;
        client.generation += 1;
        emit(state, View::offline());
        (client.controller.take(), client.session.take())
    };
    if let Some(controller) = controller {
        let _ = controller.request(Action::Disconnect).await;
    }
    logout(session).await;
    Ok(())
}

async fn logout(session: Option<Session>) {
    if let Some(session) = session {
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            session.http(Method::POST, "/api/v1/auth/logout", None),
        ).await;
    }
}

async fn voice_state(state: &AppState) -> CommandResult<VoiceStateResponse> {
    let client = state.client.lock().await;
    let view = client
        .controller
        .as_ref()
        .map(|controller| controller.state.borrow().clone())
        .unwrap_or_else(View::offline);
    let server_origin = client
        .session
        .as_ref()
        .filter(|_| client.controller.is_some())
        .map(|session| session.server.origin().to_owned());
    Ok(VoiceStateResponse { view, server_origin })
}

async fn dispatch(state: &AppState, action: Action) -> CommandResult<()> {
    let controller = state
        .client
        .lock()
        .await
        .controller
        .clone()
        .ok_or("Connect to a server first")?;
    controller.request(action).await.map_err(display)
}

async fn join_channel(
    channel_id: String,
    password: Option<String>,
    state: &AppState,
) -> CommandResult<()> {
    dispatch(state, Action::Join { id: channel_id, password }).await
}

async fn leave_channel(state: &AppState) -> CommandResult<()> {
    dispatch(state, Action::Leave).await
}

async fn set_presence(
    muted: Option<bool>,
    deafened: Option<bool>,
    afk: Option<bool>,
    afk_message: Option<String>,
    state: &AppState,
) -> CommandResult<()> {
    dispatch(state, Action::Presence(Presence { muted, deafened, afk, afk_message })).await
}

async fn send_message(text: String, html: Option<String>, channel_id: Option<String>, state: &AppState) -> CommandResult<()> {
    dispatch(state, Action::SendMessage { channel_id, text, html }).await
}

async fn direct_request(connection_id: String, kind: String, payload: Value, state: &AppState) -> CommandResult<Value> {
    if !matches!(kind.as_str(), "direct.peer" | "direct.inbox" | "direct.history" | "direct.send") {
        return Err("Unsupported direct message operation".into());
    }
    let controller = state.client.lock().await.controller.clone().ok_or("Connect to a server first")?;
    controller.direct_request(connection_id, kind, payload).await.map_err(display)
}

async fn screen_request(connection_id: String, channel_id: String, kind: String, payload: Value, state: &AppState) -> CommandResult<Value> {
    if !matches!(kind.as_str(), "media.capabilities" | "media.transport.create" | "media.transport.connect"
        | "media.transport.close" | "media.producer.create" | "media.producer.close" | "media.consumer.create" | "media.consumer.resume") {
        return Err("Unsupported screen sharing operation".into());
    }
    let controller = state.client.lock().await.controller.clone().ok_or("Connect to a server first")?;
    controller.screen_request(connection_id, channel_id, kind, payload).await.map_err(display)
}

async fn save_channel(payload: Value, state: &AppState) -> CommandResult<()> {
    dispatch(state, Action::SaveChannel(payload)).await
}

async fn delete_channel(channel_id: String, state: &AppState) -> CommandResult<()> {
    dispatch(state, Action::DeleteChannel(channel_id)).await
}

async fn member_action(kind: String, payload: Value, state: &AppState) -> CommandResult<()> {
    let kind = match kind.as_str() {
        "moderation.mute" => "moderation.mute",
        "moderation.deafen" => "moderation.deafen",
        "moderation.kick" => "moderation.kick",
        "moderation.ban" => "moderation.ban",
        "role.set" => "role.set",
        _ => return Err("Unsupported member action".into()),
    };
    dispatch(state, Action::MemberAction { kind, payload }).await
}

async fn set_member_volume(account_id: String, level: u16, state: &AppState) -> CommandResult<()> {
    if level > MAX_MEMBER_VOLUME {
        return Err(format!("Volume needs to be between 0 and {MAX_MEMBER_VOLUME}").into());
    }
    dispatch(state, Action::MemberVolume { account_id, level }).await
}

async fn get_audio_devices() -> CommandResult<Value> {
    tokio::task::spawn_blocking(media::audio_devices).await
        .map_err(|error| error.to_string())?.map_err(display)
}

async fn configure_audio(profile: AudioProfile, state: &AppState) -> CommandResult<()> {
    let mut current = state.audio.lock().await;
    if current.as_ref() == Some(&profile) { return Ok(()); }
    media::set_audio_profile(&profile).map_err(display)?;
    let controller = state.client.lock().await.controller.clone();
    if let Some(controller) = controller {
        if controller.state.borrow().phase == "online" {
            if let Err(error) = controller.request(Action::ReloadAudio).await {
                if let Some(previous) = current.as_ref() {
                    let _ = media::set_audio_profile(previous);
                    let _ = controller.request(Action::ReloadAudio).await;
                }
                return Err(display(error));
            }
        }
    }
    *current = Some(profile);
    Ok(())
}

async fn push_to_talk(pressed: bool, connection_id: Option<String>, channel_id: Option<String>, state: &AppState) -> CommandResult<()> {
    if !pressed {
        media::set_push_to_talk(false);
        return Ok(());
    }
    let (Some(connection_id), Some(channel_id)) = (connection_id, channel_id) else {
        return Err("Join a voice channel first".into());
    };
    dispatch(state, Action::Talk { connection_id, channel_id }).await
}

fn whisper_to_talk(pressed: bool) {
    media::set_whisper_to_talk(pressed);
}

async fn set_whisper(
    connection_id: String,
    channel_id: String,
    target_id: Option<String>,
    password: Option<String>,
    state: &AppState,
) -> CommandResult<()> {
    dispatch(state, Action::Whisper { connection_id, channel_id, target_id, password }).await
}

async fn microphone_test(state: &AppState) -> CommandResult<Value> {
    let _profile = state.audio.lock().await;
    if voice_state(state).await?.view.snapshot["channelId"].is_string() {
        return Err("Leave the voice channel before testing the microphone".into());
    }
    tokio::task::spawn_blocking(|| {
        use base64::{engine::general_purpose::STANDARD, Engine};

        let sample = media::test_microphone()?;
        let data_len = (sample.pcm.len() * 2) as u32;
        let mut wav = Vec::with_capacity(44 + data_len as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&1u16.to_le_bytes()); // Mono
        wav.extend_from_slice(&sample.sample_rate.to_le_bytes());
        wav.extend_from_slice(&(sample.sample_rate * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        wav.extend(sample.pcm.into_iter().flat_map(i16::to_le_bytes));
        Ok::<_, anyhow::Error>(serde_json::json!({
            "gatePeak": sample.gate_peak,
            "recording": STANDARD.encode(wav),
        }))
    }).await
        .map_err(|error| error.to_string())?.map_err(display)
}

async fn local_identity<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T> + Send + 'static,
) -> CommandResult<T> {
    tokio::task::spawn_blocking(operation).await
        .map_err(|error| error.to_string())?.map_err(display)
}

async fn generate_identity() -> CommandResult<identity::StoredIdentity> {
    local_identity(identity::generate).await
}

async fn export_identity(private_key: String, passphrase: String) -> CommandResult<String> {
    let private_key = zeroize::Zeroizing::new(private_key);
    let passphrase = zeroize::Zeroizing::new(passphrase);
    local_identity(move || identity::export(&private_key, &passphrase)).await
}

async fn import_identity(blob: String, passphrase: String) -> CommandResult<identity::StoredIdentity> {
    let passphrase = zeroize::Zeroizing::new(passphrase);
    local_identity(move || identity::import(&blob, &passphrase)).await
}

#[derive(serde::Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum IdentityAction {
    Login { password: Option<String> },
    Register { display_name: String, invitation: Option<String>, password: Option<String> },
    Bootstrap { display_name: String, token: String, password: Option<String> },
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityChallenge {
    id: String,
    server_id: String,
    origin: String,
    operation: String,
    public_key: String,
    binding: String,
    device_name: String,
    expires_at: u64,
}

async fn authenticate_identity(
    origin: String,
    server_id: String,
    device_name: String,
    private_key: String,
    action: IdentityAction,
    state: &AppState,
) -> CommandResult<HttpReply> {
    let private_key = zeroize::Zeroizing::new(private_key);
    prove_identity(origin, server_id, device_name, &private_key, action, state)
        .await
        .map_err(display)
}

async fn prove_identity(
    origin: String,
    server_id: String,
    device_name: String,
    private_key: &str,
    action: IdentityAction,
    state: &AppState,
) -> Result<HttpReply> {
    use korero_native::signaling::require_success;
    use serde_json::json;

    let (server, generation) = {
        let client = state.client.lock().await;
        let server = client.server.clone().context("Select a server first")?;
        ensure!(server.origin() == origin, "The selected server changed");
        ensure!(client.controller.is_none(), "Disconnect before signing in again");
        (server, client.generation)
    };
    let key = identity::load(private_key)?;
    let public_key = identity::public_key(&key);
    let operation = match &action {
        IdentityAction::Login { .. } => "login",
        IdentityAction::Register { .. } => "register",
        IdentityAction::Bootstrap { .. } => "bootstrap",
    };
    let request = Some(json!({
        "operation": operation, "publicKey": public_key, "deviceName": device_name, "origin": origin
    }));
    let path = "/api/v1/auth/identity/challenge";
    let (status, body) = server.http(Method::POST, path, request, None).await?;
    let challenge: IdentityChallenge = serde_json::from_value(require_success(status, body)?)?;
    ensure!(challenge.server_id == server_id && challenge.origin == origin && challenge.operation == operation &&
        challenge.public_key == public_key && challenge.device_name == device_name && challenge.binding.is_empty(),
        "The identity challenge does not match this server address or request.");
    let transcript = serde_json::to_vec(&json!(["korero-identity-v1", server_id, origin, operation,
        challenge.id, public_key, challenge.binding, device_name, challenge.expires_at]))?;
    let mut proof = json!({ "id": challenge.id, "signature": identity::sign(&key, &transcript) });
    let (path, request) = match action {
        IdentityAction::Login { password } => {
            if let Some(password) = password { proof["password"] = json!(password); }
            ("/api/v1/auth/identity/login", None)
        }
        IdentityAction::Register { display_name, invitation, password } => {
            let mut request = json!({ "displayName": display_name });
            if let Some(code) = invitation { request["invitation"] = json!(code); }
            if let Some(password) = password { request["password"] = json!(password); }
            ("/api/v1/auth/register", Some(request))
        }
        IdentityAction::Bootstrap { display_name, token, password } => {
            let mut request = json!({ "displayName": display_name, "token": token });
            if let Some(password) = password { request["password"] = json!(password); }
            ("/api/v1/admin/bootstrap", Some(request))
        }
    };
    let request = match request {
        Some(mut enrollment) => {
            enrollment["deviceName"] = json!(device_name);
            enrollment["identity"] = proof;
            enrollment
        }
        None => proof,
    };
    let (status, mut body) = server.http(Method::POST, path, Some(request), None).await?;
    if (200..300).contains(&status) {
        let credentials: Credentials = serde_json::from_value(body.clone())?;
        let mut client = state.client.lock().await;
        ensure!(client.generation == generation && client.controller.is_none(), "The selected session changed");
        client.generation += 1;
        client.session = Some(Session::new(server, credentials));
        strip_credentials(&mut body);
    }
    Ok(HttpReply { status, body })
}

#[cfg(target_os = "linux")]
struct Shortcut {
    manager: global_hotkey::GlobalHotKeyManager,
    hotkey: Option<global_hotkey::hotkey::HotKey>,
    active: Arc<std::sync::Mutex<Option<(u32, String)>>>,
}

async fn configure_talk_shortcut(shortcut: Option<String>, state: &AppState) -> CommandResult<()> {
    #[cfg(target_os = "linux")]
    {
        use global_hotkey::{hotkey::HotKey, GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};

        let mut registration = state.shortcut.lock().await;
        let key = shortcut.as_deref().map(str::parse::<HotKey>).transpose().map_err(|error| error.to_string())?;
        if key.is_some() && registration.is_none() {
            if std::env::var_os("DISPLAY").is_none() || std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland") {
                return Err("System-wide shortcuts require an X11 session. The shortcut works while Korero.chat is focused.".into());
            }
            let manager = GlobalHotKeyManager::new().map_err(|error| error.to_string())?;
            let outgoing = state.outgoing.clone();
            let active = Arc::new(std::sync::Mutex::new(None::<(u32, String)>));
            let current = active.clone();
            GlobalHotKeyEvent::set_event_handler(Some(move |event: GlobalHotKeyEvent| {
                if let Ok(active) = current.lock() {
                    if let Some((_, label)) = active.as_ref().filter(|(id, _)| *id == event.id) {
                        let _ = outgoing.send(serde_json::json!({
                            "event": "korero:talk-shortcut",
                            "payload": { "shortcut": label, "pressed": event.state == HotKeyState::Pressed },
                        }));
                    }
                }
            }));
            *registration = Some(Shortcut { manager, hotkey: None, active });
        }
        if let Some(current) = registration.as_mut() {
            if current.hotkey == key {
                return Ok(());
            }
            if let Some(previous) = current.hotkey {
                current.manager.unregister(previous).map_err(|error| error.to_string())?;
                current.hotkey = None;
            }
            *current.active.lock().map_err(|error| error.to_string())? = None;
            if let Some((key, label)) = key.zip(shortcut) {
                current.manager.register(key).map_err(|error| error.to_string())?;
                *current.active.lock().map_err(|error| error.to_string())? = Some((key.id, label));
                current.hotkey = Some(key);
            }
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = state;
        if shortcut.is_some() {
            return Err("System-wide shortcuts are unavailable. The shortcut works while Korero.chat is focused.".into());
        }
        Ok(())
    }
}

fn emit(state: &AppState, view: View) {
    let _ = state.outgoing.send(serde_json::json!({ "event": "korero:state", "payload": view }));
}

#[derive(Deserialize)]
struct Request {
    id: u64,
    command: String,
    args: Value,
}

async fn handle(state: &Arc<AppState>, command: &str, args: Value) -> CommandResult<Value> {
    macro_rules! run {
        ($function:ident($($key:ident: $kind:ty),*) $(, $extra:expr)?) => {{
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args { $($key: $kind),* }
            let args: Args = serde_json::from_value(args).map_err(|error| error.to_string())?;
            let Args { $($key),* } = args;
            let result = $function($($key,)* $($extra)?).await?;
            serde_json::to_value(result).map_err(|error| error.to_string())
        }};
    }

    match command {
        "inspect_server" => run!(inspect_server(address: String), state),
        "prepare_server" => run!(prepare_server(origin: String, fingerprint: Option<String>), state),
        "api_fetch" => run!(api_fetch(origin: String, method: String, path: String, body: Option<Value>), state),
        "start_session" => run!(start_session(member_volumes: Option<HashMap<String, u16>>), state),
        "disconnect" => run!(disconnect(), state),
        "voice_state" => run!(voice_state(), state),
        "join_channel" => run!(join_channel(channel_id: String, password: Option<String>), state),
        "leave_channel" => run!(leave_channel(), state),
        "set_presence" => run!(set_presence(muted: Option<bool>, deafened: Option<bool>, afk: Option<bool>, afk_message: Option<String>), state),
        "send_message" => run!(send_message(text: String, html: Option<String>, channel_id: Option<String>), state),
        "direct_request" => run!(direct_request(connection_id: String, kind: String, payload: Value), state),
        "screen_request" => run!(screen_request(connection_id: String, channel_id: String, kind: String, payload: Value), state),
        "save_channel" => run!(save_channel(payload: Value), state),
        "delete_channel" => run!(delete_channel(channel_id: String), state),
        "member_action" => run!(member_action(kind: String, payload: Value), state),
        "set_member_volume" => run!(set_member_volume(account_id: String, level: u16), state),
        "get_audio_devices" => run!(get_audio_devices()),
        "configure_audio" => run!(configure_audio(profile: AudioProfile), state),
        "push_to_talk" => run!(push_to_talk(pressed: bool, connection_id: Option<String>, channel_id: Option<String>), state),
        "whisper_to_talk" => {
            #[derive(Deserialize)]
            struct Talk { pressed: bool }
            let args: Talk = serde_json::from_value(args).map_err(|error| error.to_string())?;
            whisper_to_talk(args.pressed);
            Ok(Value::Null)
        }
        "set_whisper" => run!(set_whisper(connection_id: String, channel_id: String, target_id: Option<String>, password: Option<String>), state),
        "configure_talk_shortcut" => run!(configure_talk_shortcut(shortcut: Option<String>), state),
        "microphone_test" => run!(microphone_test(), state),
        "generate_identity" => run!(generate_identity()),
        "export_identity" => run!(export_identity(private_key: String, passphrase: String)),
        "import_identity" => run!(import_identity(blob: String, passphrase: String)),
        "authenticate_identity" => run!(authenticate_identity(origin: String, server_id: String, device_name: String, private_key: String, action: IdentityAction), state),
        _ => Err("Unsupported desktop operation".into()),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let (sender, mut messages) = mpsc::unbounded_channel();
    let state = Arc::new(AppState {
        client: Mutex::default(),
        audio: Mutex::default(),
        outgoing: sender,
        #[cfg(target_os = "linux")]
        shortcut: Mutex::default(),
    });
    let output = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(message) = messages.recv().await {
            let mut line = serde_json::to_vec(&message)?;
            line.push(b'\n');
            stdout.write_all(&line).await?;
            stdout.flush().await?;
        }
        Ok::<_, anyhow::Error>(())
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut commands = JoinSet::new();
    loop {
        tokio::select! {
            Some(result) = commands.join_next(), if !commands.is_empty() => { result?; }
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                let Request { id, command, args } = serde_json::from_str(&line)?;
                let state = state.clone();
                commands.spawn(async move {
                    let response = match handle(&state, &command, args).await {
                        Ok(result) => serde_json::json!({ "id": id, "result": result }),
                        Err(error) => serde_json::json!({ "id": id, "error": error }),
                    };
                    let _ = state.outgoing.send(response);
                });
            }
        }
    }
    commands.shutdown().await;
    let _ = disconnect(&state).await;
    output.abort();
    Ok(())
}
