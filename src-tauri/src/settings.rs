use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

use crate::fs_util::write_private;

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    pub openrouter_api_key: String,
    pub transcription_backend: String,
    pub transcription_model: String,
    pub transcription_language: String,
    pub cloud_fallback_to_local: bool,
    pub postprocess_enabled: bool,
    pub postprocess_min_words: u32,
    pub postprocess_model: String,
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
    pub learning_enabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            openrouter_api_key: String::new(),
            transcription_backend: "local".into(),
            transcription_model: "openai/whisper-large-v3-turbo".into(),
            transcription_language: "auto".into(),
            cloud_fallback_to_local: true,
            postprocess_enabled: true,
            postprocess_min_words: 35,
            postprocess_model: "google/gemini-3.1-flash-lite".into(),
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
            learning_enabled: true,
        }
    }
}

fn config_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn normalize(settings: &mut Settings) {
    if !matches!(settings.transcription_backend.as_str(), "local" | "openrouter") {
        settings.transcription_backend = "local".into();
    }
    // Keep cloud transcription intentionally curated instead of exposing the
    // full model catalog. MAI is included as an explicitly labelled preview.
    if !matches!(
        settings.transcription_model.trim(),
        "openai/whisper-large-v3-turbo"
            | "openai/whisper-large-v3"
            | "microsoft/mai-transcribe-1.5"
    ) {
        settings.transcription_model = "openai/whisper-large-v3-turbo".into();
    }
    if !matches!(settings.transcription_language.as_str(), "auto" | "de" | "en") {
        settings.transcription_language = "auto".into();
    }
    if settings.postprocess_model.trim().is_empty() {
        settings.postprocess_model = "google/gemini-3.1-flash-lite".into();
    }
    settings.postprocess_min_words = settings.postprocess_min_words.min(200);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_settings_default_to_local_transcription() {
        let settings: Settings = serde_json::from_str("{}").expect("default settings");
        assert_eq!(settings.transcription_backend, "local");
        assert_eq!(settings.transcription_model, "openai/whisper-large-v3-turbo");
        assert_eq!(settings.transcription_language, "auto");
        assert!(settings.cloud_fallback_to_local);
    }

    #[test]
    fn normalize_rejects_unknown_cloud_values() {
        let mut settings = Settings::default();
        settings.transcription_backend = "surprise-cloud".into();
        settings.transcription_model = "arbitrary/model".into();
        settings.transcription_language = "xx".into();
        normalize(&mut settings);
        assert_eq!(settings.transcription_backend, "local");
        assert_eq!(settings.transcription_model, "openai/whisper-large-v3-turbo");
        assert_eq!(settings.transcription_language, "auto");
    }

    #[test]
    fn normalize_keeps_quality_whisper_and_german() {
        let mut settings = Settings::default();
        settings.transcription_backend = "openrouter".into();
        settings.transcription_model = "openai/whisper-large-v3".into();
        settings.transcription_language = "de".into();
        normalize(&mut settings);
        assert_eq!(settings.transcription_backend, "openrouter");
        assert_eq!(settings.transcription_model, "openai/whisper-large-v3");
        assert_eq!(settings.transcription_language, "de");
    }
}
