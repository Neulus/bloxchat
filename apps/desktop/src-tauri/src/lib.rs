mod commands;
mod input;
mod media;
mod roblox;
mod updater;

use commands::*;
use std::path::PathBuf;
use std::sync::{mpsc, Mutex};
use tauri::{Emitter, Manager};
#[cfg(desktop)]
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    let initial_logs_path = roblox::default_roblox_logs_path();
    let (watcher_control_tx, watcher_control_rx) = mpsc::channel::<PathBuf>();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let _ = app.emit("single-instance", argv);
        }));
    }

    builder
        .manage(roblox::LogSettingsState {
            logs_path: Mutex::new(initial_logs_path.clone()),
            watcher_control: Mutex::new(Some(watcher_control_tx)),
        })
        .manage(input::InputCaptureState::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_app_exit::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            tauri::async_runtime::spawn(updater::check_for_startup_update(app.handle().clone()));
            roblox::start_log_watcher(initial_logs_path.clone(), watcher_control_rx);
            let input_state = app.state::<input::InputCaptureState>().inner().clone();
            input::start_key_listener(app.handle().clone(), input_state);
            #[cfg(desktop)]
            app.deep_link().register("bloxchat")?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            should_steal_focus,
            focus_roblox,
            start_chat_capture,
            stop_chat_capture,
            read_clipboard_text,
            write_clipboard_text,
            is_image,
            get_default_roblox_logs_path,
            get_roblox_logs_path,
            set_roblox_logs_path,
            get_job_id
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
