mod identity;

use anyhow::{ensure, Context, Result};
use korero_native::{
    media::{self, AudioProfile},
    session::{Action, Controller, Session, View},
    signaling::{CertificateInfo, Credentials, Server, ServerContact},
};
use reqwest::Method;
use serde::Serialize;
use serde_json::Value;
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

#[derive(Serialize)]
struct HttpReply {
    status: u16,
    body: Value,
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
        ("GET", "/api/v1/admin/accounts" | "/api/v1/admin/configuration")
            | ("PATCH", "/api/v1/admin/roles" | "/api/v1/admin/configuration" | "/api/v1/admin/password")
            | ("POST", "/api/v1/admin/invitations")
    );
    ensure!(is_public || is_account || is_administration, "Unsupported client HTTP operation");
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
async fn start_session(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
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
        let controller = Controller::start(session);
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
async fn voice_state(state: State<'_, AppState>) -> CommandResult<View> {
    let client = state.0.lock().await;
    Ok(client
        .controller
        .as_ref()
        .map(|controller| controller.state.borrow().clone())
        .unwrap_or_else(View::offline))
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
    let starting = !voice_state(state.clone()).await?.snapshot["channelId"].is_string();
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
    state: State<'_, AppState>,
) -> CommandResult<()> {
    dispatch(&state, Action::Presence { muted, deafened }).await
}

#[tauri::command]
async fn send_message(text: String, state: State<'_, AppState>) -> CommandResult<()> {
    dispatch(&state, Action::SendMessage(text)).await
}

#[tauri::command]
async fn save_channel(payload: Value, state: State<'_, AppState>) -> CommandResult<()> {
    dispatch(&state, Action::SaveChannel(payload)).await
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
fn push_to_talk(pressed: bool) {
    media::set_push_to_talk(pressed);
}

#[tauri::command]
async fn microphone_test(state: State<'_, AppState>) -> CommandResult<f64> {
    let _profile = state.1.lock().await;
    if voice_state(state.clone()).await?.snapshot["channelId"].is_string() {
        return Err("Leave the voice channel before testing the microphone".into());
    }
    tauri::async_runtime::spawn_blocking(media::test_microphone).await
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
            save_channel,
            get_audio_devices,
            configure_audio,
            push_to_talk,
            microphone_test,
            generate_identity,
            legacy_identity,
            export_identity,
            import_identity,
            authenticate_identity,
        ])
        .run(tauri::generate_context!())
        .expect("Could not start the Kōrero desktop window");
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
