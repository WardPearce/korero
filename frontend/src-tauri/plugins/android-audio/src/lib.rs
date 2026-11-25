use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

pub struct AndroidAudio<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> AndroidAudio<R> {
    pub async fn start(&self) -> Result<(), String> {
        self.run("start").await
    }

    pub async fn stop(&self) -> Result<(), String> {
        self.run("stop").await
    }

    async fn run(&self, command: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin_async::<serde_json::Value>(command, ())
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("korero-audio")
        .setup(|app, api| {
            let handle = api.register_android_plugin("app.korero.audio", "VoicePlugin")?;
            app.manage(AndroidAudio(handle));
            Ok(())
        })
        .build()
}
