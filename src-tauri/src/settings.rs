use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

use crate::fs_util::write_private;

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    pub openrouter_api_key: String,
    pub postprocess_enabled: bool,
    pub postprocess_model: String,
    pub learning_enabled: bool,
    pub learning_model: String,
    pub learning_interval_hours: u32,
    pub hotkey: String,
    pub hands_free_hotkey: String,
    pub output_mode: String,
    pub restore_clipboard: bool,
    pub start_sound_enabled: bool,
    pub finish_sound_enabled: bool,
    pub auto_update_on_launch: bool,
    pub context_enabled: bool,
    pub smart_formatting: bool,
    pub asr_model_ready: bool,
    pub custom_instructions: String,
    pub last_learning_at: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            openrouter_api_key: String::new(),
            postprocess_enabled: true,
            postprocess_model: "google/gemini-3.1-flash-lite".into(),
            learning_enabled: true,
            learning_model: "google/gemini-3.1-flash-lite".into(),
            learning_interval_hours: 6,
            hotkey: "Fn".into(),
            hands_free_hotkey: "Fn+Space".into(),
            output_mode: "insert".into(),
            restore_clipboard: false,
            start_sound_enabled: true,
            finish_sound_enabled: true,
            auto_update_on_launch: true,
            context_enabled: true,
            smart_formatting: true,
            asr_model_ready: false,
            custom_instructions: String::new(),
            last_learning_at: None,
        }
    }
}

fn config_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn normalize(settings: &mut Settings) {
    if settings.postprocess_model.trim().is_empty() {
        settings.postprocess_model = "google/gemini-3.1-flash-lite".into();
    }
    if settings.learning_model.trim().is_empty() {
        settings.learning_model = settings.postprocess_model.clone();
    }
    if settings.learning_interval_hours == 0 {
        settings.learning_interval_hours = 6;
    }
    if settings.hotkey.trim().is_empty() {
        settings.hotkey = "Fn".into();
    }
    if settings.hands_free_hotkey.trim().is_empty() {
        settings.hands_free_hotkey = "Fn+Space".into();
    }
    if !matches!(settings.output_mode.as_str(), "insert" | "clipboard") {
        settings.output_mode = "insert".into();
    }
}

#[cfg(target_os = "macos")]
fn keychain_service(field: &str) -> String {
    format!("de.agentz.voize.{field}")
}

#[cfg(target_os = "macos")]
fn keychain_get(field: &str) -> Option<String> {
    let service = keychain_service(field);
    let out = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            "voize",
            "-s",
            &service,
            "-w",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&out.stdout).trim_end().to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(not(target_os = "macos"))]
fn keychain_get(_field: &str) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn keychain_set(field: &str, value: &str) -> Result<(), String> {
    let service = keychain_service(field);
    let status = std::process::Command::new("security")
        .args([
            "add-generic-password",
            "-a",
            "voize",
            "-s",
            &service,
            "-w",
            value,
            "-U",
        ])
        .status()
        .map_err(|e| format!("macOS-Keychain ist nicht verfügbar: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("OpenRouter-Schlüssel konnte nicht in der macOS-Keychain gespeichert werden.".into())
    }
}

#[cfg(not(target_os = "macos"))]
fn keychain_set(_field: &str, _value: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn keychain_delete(field: &str) {
    let service = keychain_service(field);
    let _ = std::process::Command::new("security")
        .args([
            "delete-generic-password",
            "-a",
            "voize",
            "-s",
            &service,
        ])
        .status();
}

#[cfg(not(target_os = "macos"))]
fn keychain_delete(_field: &str) {}

fn sanitize_for_disk(settings: &Settings) -> Settings {
    let mut disk = settings.clone();
    #[cfg(target_os = "macos")]
    disk.openrouter_api_key.clear();
    disk
}

pub fn load(app: &tauri::AppHandle) -> Result<Settings, String> {
    let path = config_file(app)?;
    let mut migrated_key = false;
    let mut settings = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str::<Settings>(&raw).unwrap_or_default()
    } else {
        Settings::default()
    };

    #[cfg(target_os = "macos")]
    {
        if settings.openrouter_api_key.trim().is_empty() {
            settings.openrouter_api_key = keychain_get("openrouter_api_key").unwrap_or_default();
        } else {
            keychain_set("openrouter_api_key", settings.openrouter_api_key.trim())?;
            migrated_key = true;
        }
    }

    normalize(&mut settings);
    if migrated_key {
        let raw = serde_json::to_string_pretty(&sanitize_for_disk(&settings))
            .map_err(|e| e.to_string())?;
        write_private(&path, raw)?;
    }
    Ok(settings)
}

pub fn store(app: &tauri::AppHandle, settings: &Settings) -> Result<(), String> {
    let path = config_file(app)?;
    if settings.openrouter_api_key.trim().is_empty() {
        keychain_delete("openrouter_api_key");
    } else {
        keychain_set("openrouter_api_key", settings.openrouter_api_key.trim())?;
    }
    let mut normalized = settings.clone();
    normalize(&mut normalized);
    let raw = serde_json::to_string_pretty(&sanitize_for_disk(&normalized))
        .map_err(|e| e.to_string())?;
    write_private(&path, raw)
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    load(&app)
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    store(&app, &settings)
}
