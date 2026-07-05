mod asr;
mod context;
mod db;
mod fs_util;
mod native;
mod openrouter;
mod settings;
mod tray;

use tauri::Manager;

#[tauri::command]
fn app_exit(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            db::init(app.handle())?;
            tray::setup(app.handle())?;

            #[cfg(target_os = "macos")]
            if let Some(win) = app.get_webview_window("settings") {
                let _ = window_vibrancy::apply_vibrancy(
                    &win,
                    window_vibrancy::NSVisualEffectMaterial::Sidebar,
                    None,
                    None,
                );
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "settings" {
                    api.prevent_close();
                    let _ = window.hide();
                    #[cfg(target_os = "macos")]
                    let _ = window
                        .app_handle()
                        .set_activation_policy(tauri::ActivationPolicy::Accessory);
                    #[cfg(target_os = "macos")]
                    let _ = window.app_handle().set_dock_visibility(false);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_exit,
            asr::asr_status,
            asr::asr_download,
            asr::asr_cancel_download,
            asr::asr_remove_model,
            asr::asr_preload,
            asr::asr_unload,
            asr::transcribe_audio,
            context::screen_context,
            db::history_insert,
            db::history_list,
            db::history_delete,
            db::dictionary_list,
            db::dictionary_upsert,
            db::dictionary_delete,
            db::dictionary_replace_all,
            db::learning_candidates,
            native::activation_start,
            native::activation_stop,
            native::accessibility_status,
            native::request_accessibility,
            native::deliver_text,
            native::play_status_sound,
            native::position_hud,
            native::show_settings,
            openrouter::openrouter_chat,
            openrouter::openrouter_models,
            settings::get_settings,
            settings::save_settings
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
