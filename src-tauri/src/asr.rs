use base64::Engine;
use chrono::Utc;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;

#[derive(Serialize)]
pub struct AsrStatus {
    pub python: bool,
    pub parakeet_mlx: bool,
    pub script: String,
    pub hint: String,
}

#[derive(Serialize)]
pub struct TranscriptionResult {
    pub text: String,
    pub engine: String,
    pub duration_ms: Option<i64>,
}

fn script_path(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(resource) = app.path().resource_dir() {
        let candidate = resource.join("scripts").join("parakeet_transcribe.py");
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("scripts")
        .join("parakeet_transcribe.py")
}

fn audio_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("audio");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub fn asr_status(app: tauri::AppHandle) -> AsrStatus {
    let python = Command::new("python3").arg("--version").output().is_ok();
    let parakeet_mlx = Command::new("python3")
        .args(["-m", "parakeet_mlx", "--help"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
        || Command::new("parakeet-mlx")
            .arg("--help")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    let script = script_path(&app).to_string_lossy().to_string();
    let hint = if parakeet_mlx {
        "parakeet-mlx is available.".into()
    } else {
        "Install local ASR with: pip install -U parakeet-mlx".into()
    };
    AsrStatus {
        python,
        parakeet_mlx,
        script,
        hint,
    }
}

#[tauri::command]
pub async fn transcribe_audio(
    app: tauri::AppHandle,
    wav_b64: String,
) -> Result<TranscriptionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(wav_b64)
            .map_err(|e| e.to_string())?;
        let dir = audio_dir(&app)?;
        let stamp = Utc::now().format("%Y%m%d-%H%M%S%.3f").to_string();
        let input = dir.join(format!("dictation-{stamp}.wav"));
        fs::write(&input, bytes).map_err(|e| e.to_string())?;

        let script = script_path(&app);
        if !script.exists() {
            return Err(format!("ASR script not found: {}", script.display()));
        }
        let out = Command::new("python3")
            .arg(&script)
            .arg(&input)
            .env("PYTHONUTF8", "1")
            .output()
            .map_err(|e| format!("Could not start local ASR: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(stderr.trim().to_string());
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        let value: serde_json::Value =
            serde_json::from_str(stdout.trim()).map_err(|e| e.to_string())?;
        let text = value["text"].as_str().unwrap_or("").trim().to_string();
        if text.is_empty() {
            return Err("Local ASR returned an empty transcript.".into());
        }
        Ok(TranscriptionResult {
            text,
            engine: value["engine"]
                .as_str()
                .unwrap_or("parakeet")
                .to_string(),
            duration_ms: Some(started.elapsed().as_millis() as i64),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
