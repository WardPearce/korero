mod identity;
#[cfg(target_os = "linux")]
mod browser_media;

use anyhow::{ensure, Context, Result};
use korero_native::{
    media::{self, AudioProfile},
    session::{Action, Controller, Presence, Session, View},
    signaling::{CertificateInfo, Credentials, Server, ServerContact},
};
use reqwest::Method;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

#[derive(Default)]
struct Client {
    server: Option<Server>,
    contact: Option<ServerContact>,
    session: Option<Session>,
    controller: Option<Controller>,
    generation: u64,
}

#[derive(Default)]
struct AppState(Mutex<Client>, Mutex<Option<AudioProfile>>);

#[cfg(desktop)]
#[derive(Default)]
struct TalkShortcut(Mutex<Option<tauri_plugin_global_shortcut::Shortcut>>);

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

#[tauri::command]
async fn inspect_server(address: String, state: State<'_, AppState>) -> CommandResult<CertificateInfo> {
    let contact = ServerContact::discover(&address).await.map_err(display)?;
    let info = CertificateInfo {
        origin: contact.info.origin.clone(),
        fingerprint: contact.info.fingerprint.clone(),
        publicly_trusted: contact.info.publicly_trusted,
    };
    state.0.lock().await.contact = Some(contact);
    Ok(info)
}

#[tauri::command]
async fn prepare_server(
    origin: String,
    fingerprint: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    let (previous, session) = {
        let mut client = state.0.lock().await;
        let contact = client.contact.take().ok_or("Check the server certificate first")?;
        if contact.info.origin != origin {
            return Err("The selected server changed".into());
        }
        let server = contact.approve(fingerprint.as_deref()).map_err(display)?;
        client.generation += 1;
        client.server = Some(server);
        let _ = app.emit("korero:state", View::offline());
        (client.controller.take(), client.session.take())
    };
    if let Some(previous) = previous {
        let _ = previous.request(Action::Disconnect).await;
        #[cfg(target_os = "android")]
        let _ = app.state::<AndroidAudio>().stop().await;
    }
    logout(session).await;
    Ok(origin)
}

#[tauri::command]
async fn api_fetch(
    origin: String,
    method: String,
    path: String,
    body: Option<Value>,
    state: State<'_, AppState>,
) -> CommandResult<HttpReply> {
    fetch(origin, method, path, body, &state)
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
        let client = state.0.lock().await;
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

#[tauri::command]
async fn start_session(
    member_volumes: Option<HashMap<String, u8>>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let (mut updates, generation) = {
        let mut client = state.0.lock().await;
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
        member_volumes.retain(|_, level| *level < 100);
        let controller = Controller::start(session, member_volumes);
        let updates = controller.state.clone();
        client.generation += 1;
        client.controller = Some(controller);
        (updates, client.generation)
    };
    tauri::async_runtime::spawn(async move {
        #[cfg(target_os = "android")]
        let mut was_joined = false;
        loop {
            let view = updates.borrow_and_update().clone();
            let state = app.state::<AppState>();
            let current = state.0.lock().await;
            if current.generation != generation {
                break;
            }
            let _ = app.emit("korero:state", &view);
            drop(current);
            #[cfg(target_os = "android")]
            {
                let joined = view.snapshot["channelId"].is_string();
                if view.phase == "error" || (was_joined && view.phase == "online" && !joined) {
                    let _ = app.state::<AndroidAudio>().stop().await;
                }
                if view.phase == "online" {
                    was_joined = joined;
                }
            }
            if updates.changed().await.is_err() {
                break;
            }
        }
    });
    Ok(())
}

#[tauri::command]
async fn disconnect(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    let (controller, session) = {
        let mut client = state.0.lock().await;
        client.generation += 1;
        let _ = app.emit("korero:state", View::offline());
        (client.controller.take(), client.session.take())
    };
    if let Some(controller) = controller {
        let _ = controller.request(Action::Disconnect).await;
    }
    logout(session).await;
    #[cfg(target_os = "android")]
    app.state::<AndroidAudio>().stop().await?;
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

#[tauri::command]
async fn voice_state(state: State<'_, AppState>) -> CommandResult<VoiceStateResponse> {
    let client = state.0.lock().await;
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
        .0
        .lock()
        .await
        .controller
        .clone()
        .ok_or("Connect to a server first")?;
    controller.request(action).await.map_err(display)
}

#[tauri::command]
async fn join_channel(
    channel_id: String,
    password: Option<String>,
    _app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let _audio = state.1.lock().await;
    #[cfg(target_os = "android")]
    let starting = !voice_state(state.clone()).await?.view.snapshot["channelId"].is_string();
    #[cfg(target_os = "android")]
    if starting {
        _app.state::<AndroidAudio>().start().await?;
    }

    let result = dispatch(
        &state,
        Action::Join {
            id: channel_id,
            password,
        },
    )
    .await;
    #[cfg(target_os = "android")]
    if starting && result.is_err() {
        let _ = _app.state::<AndroidAudio>().stop().await;
    }
    result
}

#[tauri::command]
async fn leave_channel(_app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    dispatch(&state, Action::Leave).await?;
    #[cfg(target_os = "android")]
    _app.state::<AndroidAudio>().stop().await?;
    Ok(())
}

#[tauri::command]
async fn set_presence(
    muted: Option<bool>,
    deafened: Option<bool>,
    afk: Option<bool>,
    afk_message: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    dispatch(&state, Action::Presence(Presence { muted, deafened, afk, afk_message })).await
}

#[tauri::command]
async fn send_message(text: String, html: Option<String>, channel_id: Option<String>, state: State<'_, AppState>) -> CommandResult<()> {
    dispatch(&state, Action::SendMessage { channel_id, text, html }).await
}

#[tauri::command]
async fn direct_request(connection_id: String, kind: String, payload: Value, state: State<'_, AppState>) -> CommandResult<Value> {
    if !matches!(kind.as_str(), "direct.peer" | "direct.inbox" | "direct.history" | "direct.send") {
        return Err("Unsupported direct message operation".into());
    }
    let controller = state.0.lock().await.controller.clone().ok_or("Connect to a server first")?;
    controller.direct_request(connection_id, kind, payload).await.map_err(display)
}

#[tauri::command]
async fn screen_request(connection_id: String, channel_id: String, kind: String, payload: Value, state: State<'_, AppState>) -> CommandResult<Value> {
    if !matches!(kind.as_str(), "media.capabilities" | "media.transport.create" | "media.transport.connect"
        | "media.transport.close" | "media.producer.create" | "media.producer.close" | "media.consumer.create" | "media.consumer.resume") {
        return Err("Unsupported screen sharing operation".into());
    }
    let controller = state.0.lock().await.controller.clone().ok_or("Connect to a server first")?;
    controller.screen_request(connection_id, channel_id, kind, payload).await.map_err(display)
}

#[cfg(target_os = "linux")]
#[tauri::command]
async fn open_browser_media(
    connection_id: String,
    channel_id: String,
    source: String,
    share: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let controller = state.0.lock().await.controller.clone().ok_or("Connect to a server first")?;
    browser_media::open(app, controller, connection_id, channel_id, source, share).await.map_err(display)
}

#[tauri::command]
async fn save_channel(payload: Value, state: State<'_, AppState>) -> CommandResult<()> {
    dispatch(&state, Action::SaveChannel(payload)).await
}

#[tauri::command]
async fn member_action(kind: String, payload: Value, state: State<'_, AppState>) -> CommandResult<()> {
    let kind = match kind.as_str() {
        "moderation.mute" => "moderation.mute",
        "moderation.deafen" => "moderation.deafen",
        "moderation.kick" => "moderation.kick",
        "moderation.ban" => "moderation.ban",
        "role.set" => "role.set",
        _ => return Err("Unsupported member action".into()),
    };
    dispatch(&state, Action::MemberAction { kind, payload }).await
}

#[tauri::command]
async fn set_member_volume(account_id: String, level: u8, state: State<'_, AppState>) -> CommandResult<()> {
    if level > 100 {
        return Err("Volume needs to be between 0 and 100".into());
    }
    dispatch(&state, Action::MemberVolume { account_id, level }).await
}

#[tauri::command]
async fn get_audio_devices() -> CommandResult<Value> {
    tauri::async_runtime::spawn_blocking(media::audio_devices).await
        .map_err(|error| error.to_string())?.map_err(display)
}

#[tauri::command]
async fn configure_audio(profile: AudioProfile, state: State<'_, AppState>) -> CommandResult<()> {
    let mut current = state.1.lock().await;
    if current.as_ref() == Some(&profile) { return Ok(()); }
    media::set_audio_profile(&profile).map_err(display)?;
    let controller = state.0.lock().await.controller.clone();
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

#[tauri::command]
async fn push_to_talk(pressed: bool, connection_id: Option<String>, channel_id: Option<String>, state: State<'_, AppState>) -> CommandResult<()> {
    if !pressed {
        media::set_push_to_talk(false);
        return Ok(());
    }
    let (Some(connection_id), Some(channel_id)) = (connection_id, channel_id) else {
        return Err("Join a voice channel first".into());
    };
    dispatch(&state, Action::Talk { connection_id, channel_id }).await
}

#[tauri::command]
fn whisper_to_talk(pressed: bool) {
    media::set_whisper_to_talk(pressed);
}

#[tauri::command]
async fn set_whisper(
    connection_id: String,
    channel_id: String,
    target_id: Option<String>,
    password: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    dispatch(&state, Action::Whisper { connection_id, channel_id, target_id, password }).await
}

#[tauri::command]
async fn configure_talk_shortcut(shortcut: Option<String>, app: AppHandle) -> CommandResult<()> {
    #[cfg(desktop)]
    if let Some(manager) = app.try_state::<tauri_plugin_global_shortcut::GlobalShortcut<tauri::Wry>>() {
        use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};
        let state = app.state::<TalkShortcut>();
        let mut current = state.0.lock().await;
        let next = shortcut.as_ref().map(|value| value.parse::<Shortcut>()).transpose()
            .map_err(|error| error.to_string())?;
        if *current == next { return Ok(()); }
        if let Some(previous) = *current {
            manager.unregister(previous).map_err(|error| error.to_string())?;
            *current = None;
        }
        if let Some((key, label)) = next.zip(shortcut) {
            manager.on_shortcut(key, move |app, _, event| {
                let _ = app.emit("korero:talk-shortcut", serde_json::json!({
                    "shortcut": label,
                    "pressed": event.state() == ShortcutState::Pressed,
                }));
            }).map_err(|error| format!("Could not register the system-wide shortcut: {error}"))?;
            *current = Some(key);
        }
        return Ok(());
    }
    let _ = app;
    if shortcut.is_some() {
        return Err("System-wide shortcuts are unavailable in this desktop session. The shortcut works while VNX.chat is focused.".into());
    }
    Ok(())
}

#[tauri::command]
async fn microphone_test(state: State<'_, AppState>) -> CommandResult<Value> {
    let _profile = state.1.lock().await;
    if voice_state(state.clone()).await?.view.snapshot["channelId"].is_string() {
        return Err("Leave the voice channel before testing the microphone".into());
    }
    tauri::async_runtime::spawn_blocking(|| {
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

#[cfg(target_os = "android")]
type AndroidAudio = tauri_plugin_korero_audio::AndroidAudio<tauri::Wry>;

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_app_korero_audio_VoicePlugin_initializeRtc(
    env: *mut core::ffi::c_void,
    _plugin: *mut core::ffi::c_void,
    context: *mut core::ffi::c_void,
) -> u8 {
    korero_native::media::initialize_android(env as usize, context as usize) as u8
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = {
        let builder = builder.manage(TalkShortcut::default());
        let supported = !cfg!(target_os = "linux") || (std::env::var_os("DISPLAY").is_some() &&
            !std::env::var("XDG_SESSION_TYPE").is_ok_and(|session| session.eq_ignore_ascii_case("wayland")) &&
            std::env::var_os("WAYLAND_DISPLAY").is_none());
        if supported { builder.plugin(tauri_plugin_global_shortcut::Builder::new().build()) } else { builder }
    };
    #[cfg(target_os = "linux")]
    let builder = builder
        .setup(|app| {
            use webkit2gtk::{SettingsExt, WebViewExt};
            if let Some(window) = app.get_webview_window("main") {
                window.with_webview(|webview| {
                    if let Some(settings) = WebViewExt::settings(&webview.inner()) {
                        settings.set_enable_media_stream(true);
                        settings.set_enable_webrtc(true);
                    }
                })?;
            }
            Ok(())
        })
        .on_permission_request(|webview, kind| {
            use tauri::webview::{PermissionKind, PermissionResponse};
            if !matches!(kind, PermissionKind::DisplayCapture | PermissionKind::Camera) {
                return PermissionResponse::Default;
            }
            let local = webview.label() == "main" && webview.url().is_ok_and(|url| {
                (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                    || (cfg!(debug_assertions) && webview.app_handle().config().build.dev_url
                        .as_ref().is_some_and(|dev| url.origin() == dev.origin()))
            });
            // Local capture follows an explicit preview or source-picker action.
            if local { PermissionResponse::Allow } else { PermissionResponse::Deny }
        });
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_korero_audio::init());
    builder
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            inspect_server,
            prepare_server,
            api_fetch,
            start_session,
            disconnect,
            voice_state,
            join_channel,
            leave_channel,
            set_presence,
            send_message,
            direct_request,
            screen_request,
            #[cfg(target_os = "linux")]
            open_browser_media,
            save_channel,
            member_action,
            set_member_volume,
            get_audio_devices,
            configure_audio,
            configure_talk_shortcut,
            push_to_talk,
            whisper_to_talk,
            set_whisper,
            microphone_test,
            generate_identity,
            legacy_identity,
            export_identity,
            import_identity,
            authenticate_identity,
        ])
        .run(tauri::generate_context!())
        .expect("Could not start the VNX.chat desktop window");
}

async fn local_identity<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T> + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(operation).await
        .map_err(|error| error.to_string())?.map_err(display)
}

#[tauri::command]
async fn generate_identity() -> CommandResult<identity::StoredIdentity> {
    local_identity(identity::generate).await
}

#[tauri::command]
async fn legacy_identity() -> CommandResult<Option<identity::StoredIdentity>> {
    local_identity(identity::load_legacy).await
}

#[tauri::command]
async fn export_identity(private_key: String, passphrase: String) -> CommandResult<String> {
    let private_key = zeroize::Zeroizing::new(private_key);
    let passphrase = zeroize::Zeroizing::new(passphrase);
    local_identity(move || identity::export(&private_key, &passphrase)).await
}

#[tauri::command]
async fn import_identity(blob: String, passphrase: String) -> CommandResult<identity::StoredIdentity> {
    let passphrase = zeroize::Zeroizing::new(passphrase);
    local_identity(move || identity::import(&blob, &passphrase)).await
}

#[derive(serde::Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum IdentityAction {
    Login { password: Option<String> },
    Register { display_name: String, invitation: Option<String>, password: Option<String> },
    Bootstrap { display_name: String, token: String },
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

#[tauri::command]
async fn authenticate_identity(
    origin: String,
    server_id: String,
    device_name: String,
    private_key: String,
    action: IdentityAction,
    state: State<'_, AppState>,
) -> CommandResult<HttpReply> {
    let private_key = zeroize::Zeroizing::new(private_key);
    prove_identity(origin, server_id, device_name, &private_key, action, &state)
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
        let client = state.0.lock().await;
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
        IdentityAction::Bootstrap { display_name, token } =>
            ("/api/v1/admin/bootstrap", Some(json!({ "displayName": display_name, "token": token }))),
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
        let mut client = state.0.lock().await;
        ensure!(client.generation == generation && client.controller.is_none(), "The selected session changed");
        client.generation += 1;
        client.session = Some(Session::new(server, credentials));
        strip_credentials(&mut body);
    }
    Ok(HttpReply { status, body })
}
