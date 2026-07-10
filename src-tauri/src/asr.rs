//! Local speech-to-text: NVIDIA Parakeet TDT 0.6b v3 (int8 ONNX), run
//! in-process via transcribe-rs / ONNX Runtime. Fully self-contained — the
//! ONNX runtime is statically linked at build time, no Python or system
//! packages required. The ~670 MB model is downloaded once from Hugging Face
//! into the app data dir and loaded lazily on first use (~2 GB RAM while
//! resident; freed again via `asr_unload`).

use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use transcribe_rs::onnx::parakeet::ParakeetModel;
use transcribe_rs::onnx::Quantization;
use transcribe_rs::{SpeechModel, TranscribeOptions};

// Pinned to commit 8f23f0c0 so a future repo push can never silently swap the
// files we verify sizes against.
const HF_BASE: &str = "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce";
pub const MODEL_ID: &str = "parakeet-tdt-0.6b-v3-int8";
pub const ENGINE: &str = "parakeet-tdt-0.6b-v3 (onnx int8)";

/// (file name, size in bytes, sha256 at the pinned revision) — sizes give
/// the aggregate progress bar a total before every response arrived; size +
/// hash are verified before a download counts as installed, so a captive
/// portal's HTTP-200 error page (or a tampered file) can never land as a
/// "working" model.
const MODEL_FILES: &[(&str, u64, &str)] = &[
    (
        "encoder-model.int8.onnx",
        652_183_999,
        "6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09",
    ),
    (
        "decoder_joint-model.int8.onnx",
        18_202_004,
        "eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70",
    ),
    (
        "nemo128.onnx",
        139_764,
        "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f",
    ),
    (
        "vocab.txt",
        93_939,
        "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
    ),
];

fn total_size() -> u64 {
    MODEL_FILES.iter().map(|(_, s, _)| s).sum()
}

fn file_sha256(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// `~/Library/Application Support/de.agentz.voize/models/<model id>` — same
/// base dir Tauri uses for settings/db, so uninstall cleanup is one folder.
fn model_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or("no app data dir")?;
    Ok(base.join("de.agentz.voize").join("models").join(MODEL_ID))
}

/// Installed means present *and* exactly the pinned size — a truncated or
/// corrupted file self-detects and the UI offers a re-download.
fn is_installed(dir: &PathBuf) -> bool {
    MODEL_FILES.iter().all(|(name, size, _)| {
        dir.join(name)
            .metadata()
            .map(|m| m.len() == *size)
            .unwrap_or(false)
    })
}

pub(crate) fn local_model_installed() -> bool {
    model_dir().map(|dir| is_installed(&dir)).unwrap_or(false)
}

static MODEL: once_cell::sync::Lazy<parking_lot::Mutex<Option<ParakeetModel>>> =
    once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(None));
static DOWNLOADING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);
/// Mirrors `MODEL.is_some()` so `asr_status` never has to take the model lock
/// (which is held across multi-second load+inference in `transcribe`).
static LOADED: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
pub struct AsrStatus {
    pub installed: bool,
    pub downloading: bool,
    /// model resident in RAM right now (~2 GB while loaded)
    pub loaded: bool,
    pub total_bytes: u64,
    pub engine: String,
}

#[derive(Serialize)]
pub struct TranscriptionResult {
    pub text: String,
    pub engine: String,
    pub duration_ms: Option<i64>,
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

#[tauri::command]
pub fn asr_status() -> AsrStatus {
    let installed = model_dir().map(|d| is_installed(&d)).unwrap_or(false);
    AsrStatus {
        installed,
        downloading: DOWNLOADING.load(Ordering::SeqCst),
        loaded: LOADED.load(Ordering::SeqCst),
        total_bytes: total_size(),
        engine: ENGINE.into(),
    }
}

/// Fetch all model files into the app data dir. Emits `asr://progress`
/// (aggregate bytes) while running and `asr://done` / `asr://error` at the
/// end. Files land as `.part` first so a torn download never looks installed;
/// finished files are skipped and partial `.part`s resume via a Range request
/// (cancel/crash keep the partial), with a size check before the rename to
/// the final name.
#[tauri::command]
pub async fn asr_download(app: AppHandle) -> Result<(), String> {
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err("Download läuft bereits.".into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    let result = download_inner(&app).await;
    DOWNLOADING.store(false, Ordering::SeqCst);
    match &result {
        Ok(()) => {
            let _ = app.emit("asr://done", ());
        }
        Err(e) => {
            let _ = app.emit("asr://error", e.clone());
        }
    }
    result
}

async fn download_inner(app: &AppHandle) -> Result<(), String> {
    use futures_util::StreamExt;
    let dir = model_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // connect/read timeouts make a silently stalled connection fail (and reset
    // the DOWNLOADING guard) instead of hanging forever; total transfer time
    // stays uncapped.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let total = total_size();
    let mut done_bytes: u64 = 0;
    let mut last_emit: u64 = 0;
    for (name, size, sha) in MODEL_FILES {
        let dest = dir.join(name);
        // a finished file from a previous (cancelled) run — keep it
        if dest.metadata().map(|m| m.len() == *size).unwrap_or(false) {
            done_bytes += size;
            continue;
        }
        let part = dir.join(format!("{name}.part"));
        let mut have = part.metadata().map(|m| m.len()).unwrap_or(0);
        if have > *size {
            // longer than the pinned size can't be valid — start over
            let _ = std::fs::remove_file(&part);
            have = 0;
        }
        if have < *size {
            let mut req = client.get(format!("{HF_BASE}/{name}"));
            if have > 0 {
                req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
            }
            let resp = req.send().await.map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("Download von {name} fehlgeschlagen: HTTP {}", resp.status()));
            }
            let mut file = if resp.status() == reqwest::StatusCode::PARTIAL_CONTENT {
                std::fs::OpenOptions::new()
                    .append(true)
                    .open(&part)
                    .map_err(|e| e.to_string())?
            } else {
                // 200: full body (server ignored the Range) — start over
                have = 0;
                std::fs::File::create(&part).map_err(|e| e.to_string())?
            };
            done_bytes += have; // resumed bytes count as progress
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                if CANCEL.load(Ordering::SeqCst) {
                    // keep the .part — the next run resumes it
                    return Err("Abgebrochen.".into());
                }
                let chunk = chunk.map_err(|e| e.to_string())?;
                std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
                done_bytes += chunk.len() as u64;
                // throttle progress events to every ~2 MB
                if done_bytes - last_emit > 2_000_000 {
                    last_emit = done_bytes;
                    let _ = app.emit(
                        "asr://progress",
                        DownloadProgress {
                            downloaded: done_bytes,
                            total,
                        },
                    );
                }
            }
        } else {
            // .part is already complete — just verify and rename below
            done_bytes += have;
        }
        let got = part.metadata().map(|m| m.len()).unwrap_or(0);
        if got != *size {
            let _ = std::fs::remove_file(&part);
            return Err(format!(
                "Download von {name} unvollständig: {got} von {size} Bytes."
            ));
        }
        // hashing the 652 MB encoder takes a second or two of pure CPU —
        // keep it off the async runtime's core threads
        let part_for_hash = part.clone();
        let hash = tauri::async_runtime::spawn_blocking(move || file_sha256(&part_for_hash))
            .await
            .map_err(|e| e.to_string())??;
        if hash != *sha {
            let _ = std::fs::remove_file(&part);
            return Err(format!("Prüfsumme von {name} ist ungültig — Download wird neu gestartet."));
        }
        std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn asr_cancel_download() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// Delete the model from disk (and RAM, if loaded).
#[tauri::command]
pub fn asr_remove_model() -> Result<(), String> {
    *MODEL.lock() = None;
    LOADED.store(false, Ordering::SeqCst);
    let dir = model_dir()?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Drop the resident model (frees ~2 GB; next transcription reloads it).
#[tauri::command]
pub fn asr_unload() {
    *MODEL.lock() = None;
    LOADED.store(false, Ordering::SeqCst);
}

fn load_locked(guard: &mut Option<ParakeetModel>) -> Result<(), String> {
    if guard.is_none() {
        let dir = model_dir()?;
        if !is_installed(&dir) {
            return Err("Das Sprachmodell ist noch nicht installiert.".into());
        }
        let model = ParakeetModel::load(&dir, &Quantization::Int8).map_err(|e| e.to_string())?;
        *guard = Some(model);
        LOADED.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// Warm the model into RAM so the first dictation doesn't pay the ~2-3 s
/// load. Called in the background right after the runtime starts.
#[tauri::command]
pub async fn asr_preload() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut guard = MODEL.lock();
        load_locked(&mut guard)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Transcribe one recording of 16 kHz mono 16-bit PCM (base64, no WAV
/// header — the webview already decoded/resampled the capture). Loads the
/// model on first use and keeps it resident for fast follow-up dictations.
pub(crate) async fn transcribe_local(pcm_b64: String) -> Result<TranscriptionResult, String> {
    tauri::async_runtime::spawn_blocking(move || transcribe(&pcm_b64))
        .await
        .map_err(|e| e.to_string())?
}

fn transcribe(pcm_b64: &str) -> Result<TranscriptionResult, String> {
    use base64::Engine;
    let started = std::time::Instant::now();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(pcm_b64)
        .map_err(|e| e.to_string())?;
    let samples: Vec<f32> = bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect();
    if samples.is_empty() {
        return Err("Keine Audiodaten empfangen.".into());
    }
    let mut guard = MODEL.lock();
    load_locked(&mut guard)?;
    let model = guard.as_mut().expect("model loaded above");
    let result = model
        .transcribe(&samples, &TranscribeOptions::default())
        .map_err(|e| e.to_string())?;
    Ok(TranscriptionResult {
        text: result.text.trim().to_string(),
        engine: ENGINE.into(),
        duration_ms: Some(started.elapsed().as_millis() as i64),
    })
}
