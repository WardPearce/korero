#[cfg_attr(desktop, tauri_runtime_cef::cef_entry_point)]
fn main() {
    korero_app::run();
}
