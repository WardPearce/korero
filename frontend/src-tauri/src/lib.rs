use anyhow::{ensure, Context, Result};
use korero_native::{
    session::{Action, Controller, Session, View},
    signaling::{Credentials, Server},
};
use reqwest::Method;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

#[derive(Default)]
struct Client {
    server: Option<Server>,
    certificate: Option<String>,
    session: Option<Session>,
    controller: Option<Controller>,
    generation: u64,
}

#[derive(Default)]
struct AppState(Mutex<Client>);

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
async fn prepare_server(
    address: String,
    certificate: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    let server =
        Server::new(&address, certificate.as_deref().map(str::as_bytes)).map_err(display)?;
    let origin = server.origin().to_owned();
    let previous = {
        let mut client = state.0.lock().await;
        let matching = client.server.as_ref().is_some_and(|previous| {
            previous.origin() == origin && client.certificate == certificate
        });
        if matching {
            return Ok(origin);
        }
        client.generation += 1;
        client.server = Some(server);
        client.certificate = certificate;
        client.session = None;
        let _ = app.emit("korero:state", View::offline());
        client.controller.take()
    };
    if let Some(previous) = previous {
        let _ = previous.request(Action::Disconnect).await;
        #[cfg(target_os = "android")]
        let _ = app.state::<AndroidAudio>().stop().await;
    }
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
    let (server, session, generation) = {
        let client = state.0.lock().await;
        let server = client.server.clone().context("Select a server first")?;
        ensure!(server.origin() == origin, "The selected server changed");
        (server, client.session.clone(), client.generation)
    };
    let register = matches!(
        (method.as_str(), path.as_str()),
        (
            "POST",
            "/api/v1/auth/register" | "/api/v1/auth/recover" | "/api/v1/admin/bootstrap"
        )
    );
    let is_public = register
        || matches!(
            (method.as_str(), path.as_str()),
            ("GET", "/api/v1/server/info" | "/api/v1/server/capabilities")
        );
    let is_account = matches!(
        (method.as_str(), path.as_str()),
        ("GET", "/api/v1/account" | "/api/v1/account/sessions") | ("PATCH", "/api/v1/account")
    );
    ensure!(is_public || is_account, "Unsupported client HTTP operation");
    let method = Method::from_bytes(method.as_bytes())?;
    let (status, mut body) = if is_public {
        server.http(method, &path, body, None).await?
    } else {
        session
            .context("You are not signed in")?
            .http(method, &path, body)
            .await?
    };
    if register && (200..300).contains(&status) {
        let credentials: Credentials = serde_json::from_value(body.clone())?;
        let mut client = state.0.lock().await;
        ensure!(
            client.generation == generation,
            "The selected session changed"
        );
        ensure!(
            client
                .controller
                .as_ref()
                .is_none_or(|controller| controller.state.has_changed().is_err()),
            "Disconnect before signing in again"
        );
        client.controller = None;
        client.generation += 1;
        client.session = Some(Session::new(server, credentials));
        if let Some(profile) = body.as_object_mut() {
            for field in [
                "accessToken",
                "refreshToken",
                "accessExpiresAt",
                "refreshExpiresAt",
                "sessionId",
            ] {
                profile.remove(field);
            }
        }
    }
    Ok(HttpReply { status, body })
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
            .ok_or("Register or recover an account first")?;
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
    let controller = {
        let mut client = state.0.lock().await;
        client.generation += 1;
        let _ = app.emit("korero:state", View::offline());
        client.controller.take()
    };
    if let Some(controller) = controller {
        let _ = controller.request(Action::Disconnect).await;
    }
    #[cfg(target_os = "android")]
    app.state::<AndroidAudio>().stop().await?;
    Ok(())
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
async fn create_channel(name: String, state: State<'_, AppState>) -> CommandResult<()> {
    dispatch(&state, Action::CreateChannel(name)).await
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
            prepare_server,
            api_fetch,
            start_session,
            disconnect,
            voice_state,
            join_channel,
            leave_channel,
            set_presence,
            send_message,
            create_channel,
        ])
        .run(tauri::generate_context!())
        .expect("Could not start the Kōrero desktop window");
}
