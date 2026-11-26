#[cfg(target_os = "linux")]
#[path = "../browser_media.rs"]
mod browser_media;

#[cfg(target_os = "linux")]
use anyhow::{Context, Result};
#[cfg(target_os = "linux")]
use korero_native::{session::{Action, Controller, Presence, Session}, signaling::{Credentials, ServerContact}};
#[cfg(target_os = "linux")]
use std::{collections::HashMap, time::Duration};

#[cfg(target_os = "linux")]
async fn test(app: tauri::AppHandle) -> Result<()> {
    let address = std::env::var("KORERO_TEST_ORIGIN")?;
    let fingerprint = std::env::var("KORERO_TEST_FINGERPRINT")?;
    let credentials_path = std::env::var("KORERO_TEST_CREDENTIALS")?;
    let credentials: Credentials = serde_json::from_slice(&std::fs::read(credentials_path)?)?;
    let server = ServerContact::discover(&address).await?.approve(Some(&fingerprint))?;
    let controller = Controller::start(Session::new(server, credentials), HashMap::new());
    let mut state = controller.state.clone();
    tokio::time::timeout(Duration::from_secs(10), state.wait_for(|view| view.phase == "online")).await??;
    controller.request(Action::Presence(Presence { muted: Some(true), ..Default::default() })).await?;
    let channel = "00000000-0000-4000-8000-000000000001".to_owned();
    controller.request(Action::Join { id: channel.clone(), password: None }).await?;
    let connection = state.borrow().snapshot["connectionId"].as_str().map(str::to_owned);
    let connection = connection.context("No connection ID")?;
    browser_media::open(app, controller, connection, channel, "screen".into(), true).await
}

#[cfg(target_os = "linux")]
#[tauri_runtime_cef::cef_entry_point]
fn main() {
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows[0].visible = false;
    tauri::Builder::default().runtime(tauri_runtime_cef::Cef::default()).setup(|app| {
        let app = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = test(app).await {
                eprintln!("{error:#}");
                std::process::exit(1);
            }
        });
        Ok(())
    }).run(context).unwrap();
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("The browser media probe requires Linux.");
    std::process::exit(1);
}
