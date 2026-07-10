use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;

use crate::settings;

pub const CLOUD_TRANSCRIPTION_TURBO: &str = "openai/whisper-large-v3-turbo";
pub const CLOUD_TRANSCRIPTION_QUALITY: &str = "openai/whisper-large-v3";
pub const CLOUD_TRANSCRIPTION_MAI_PREVIEW: &str = "microsoft/mai-transcribe-1.5";
const MAX_CLOUD_PCM_BYTES: usize = 19_200_000; // 10 min at 16 kHz mono PCM16

#[derive(Deserialize, Serialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Result of a chat completion. `content` is the assistant text; the remaining
/// fields mirror OpenRouter's `usage` object and are all optional because a
/// provider may omit any of them (and the whole object is absent on error).
#[derive(Serialize, Default)]
pub struct ChatResult {
    pub content: String,
    pub model: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub reasoning_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub cost: Option<f64>,
}

#[derive(Default)]
pub struct CloudTranscriptionResult {
    pub text: String,
    pub provider: Option<String>,
    pub duration_ms: i64,
    pub audio_seconds: Option<f64>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub cost: Option<f64>,
    pub generation_id: Option<String>,
}

fn headers(api_key: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if !api_key.trim().is_empty() {
        let value = format!("Bearer {}", api_key.trim());
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&value).map_err(|e| e.to_string())?,
        );
    }
    headers.insert(
        "HTTP-Referer",
        HeaderValue::from_static("https://github.com/AgentZ-Media/VoiZe"),
    );
    headers.insert("X-OpenRouter-Title", HeaderValue::from_static("VoiZe"));
    Ok(headers)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

fn pcm16_to_wav(pcm: &[u8]) -> Result<Vec<u8>, String> {
    if pcm.is_empty() {
        return Err("Keine Audiodaten empfangen.".into());
    }
    if pcm.len() % 2 != 0 {
        return Err("Die Audiodaten sind unvollständig.".into());
    }
    if pcm.len() > MAX_CLOUD_PCM_BYTES {
        return Err("CLOUD_AUDIO_TOO_LARGE: Cloud-Diktate sind auf 10 Minuten begrenzt.".into());
    }
    let data_len = u32::try_from(pcm.len()).map_err(|_| "Die Aufnahme ist zu groß.")?;
    let riff_len = data_len
        .checked_add(36)
        .ok_or("Die Aufnahme ist zu groß.")?;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&riff_len.to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&16_000u32.to_le_bytes());
    wav.extend_from_slice(&32_000u32.to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm);
    Ok(wav)
}

fn api_error(status: reqwest::StatusCode, value: &serde_json::Value) -> String {
    let message = value["error"]["message"]
        .as_str()
        .or_else(|| value["message"].as_str())
        .unwrap_or("OpenRouter hat die Transkription abgelehnt.");
    let code = match status.as_u16() {
        401 | 403 => "OPENROUTER_AUTH",
        402 => "OPENROUTER_CREDITS",
        413 => "CLOUD_AUDIO_TOO_LARGE",
        429 => "OPENROUTER_RATE_LIMIT",
        500..=599 => "OPENROUTER_UNAVAILABLE",
        _ => "OPENROUTER_TRANSCRIPTION",
    };
    format!("{code}: {message}")
}

fn transcription_body(model: &str, wav_b64: String, language: &str) -> serde_json::Value {
    let mut body = json!({
        "model": model,
        "input_audio": {
            "data": wav_b64,
            "format": "wav"
        },
        "temperature": 0,
        // All curated cloud models currently have ZDR-capable endpoints. Fail
        // closed if privacy-preserving routing disappears.
        "provider": {
            "zdr": true,
            "data_collection": "deny"
        }
    });
    if language != "auto" {
        body["language"] = json!(language);
    }
    body
}

pub async fn transcribe_cloud(
    app: &tauri::AppHandle,
    pcm_b64: &str,
    model: &str,
    language: &str,
) -> Result<CloudTranscriptionResult, String> {
    use base64::Engine;
    let settings = settings::load(app)?;
    if settings.openrouter_api_key.trim().is_empty() {
        return Err("OPENROUTER_API_KEY_MISSING: In den KI-Einstellungen fehlt der OpenRouter API-Schlüssel.".into());
    }
    if !matches!(
        model,
        CLOUD_TRANSCRIPTION_TURBO | CLOUD_TRANSCRIPTION_QUALITY | CLOUD_TRANSCRIPTION_MAI_PREVIEW
    ) {
        return Err(
            "OPENROUTER_MODEL: Dieses Cloud-Transkriptionsmodell wird nicht unterstützt.".into(),
        );
    }
    if !matches!(language, "auto" | "de" | "en") {
        return Err(
            "OPENROUTER_LANGUAGE: Diese Transkriptionssprache wird nicht unterstützt.".into(),
        );
    }
    let pcm = base64::engine::general_purpose::STANDARD
        .decode(pcm_b64)
        .map_err(|_| "Die Audiodaten konnten nicht gelesen werden.".to_string())?;
    let wav = pcm16_to_wav(&pcm)?;
    let wav_b64 = base64::engine::general_purpose::STANDARD.encode(wav);
    let body = transcription_body(model, wav_b64, language);
    let started = std::time::Instant::now();
    let response = client()?
        .post("https://openrouter.ai/api/v1/audio/transcriptions")
        .headers(headers(&settings.openrouter_api_key)?)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "OPENROUTER_TIMEOUT: Die Cloud-Transkription hat zu lange gedauert.".to_string()
            } else {
                format!("OPENROUTER_OFFLINE: OpenRouter ist nicht erreichbar: {e}")
            }
        })?;
    let status = response.status();
    let generation_id = response
        .headers()
        .get("X-Generation-Id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let value = response.json::<serde_json::Value>().await.map_err(|_| {
        "OPENROUTER_RESPONSE: OpenRouter hat keine gültige Antwort gesendet.".to_string()
    })?;
    if !status.is_success() {
        return Err(api_error(status, &value));
    }
    let text = value["text"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string();
    if text.is_empty() {
        return Err("OPENROUTER_EMPTY: OpenRouter hat keinen Text erkannt.".into());
    }
    let usage = &value["usage"];
    Ok(CloudTranscriptionResult {
        text,
        provider: value["provider"].as_str().map(str::to_string),
        duration_ms: started.elapsed().as_millis() as i64,
        audio_seconds: usage["seconds"].as_f64(),
        input_tokens: usage["input_tokens"].as_i64(),
        output_tokens: usage["output_tokens"].as_i64(),
        total_tokens: usage["total_tokens"].as_i64(),
        cost: usage["cost"].as_f64(),
        generation_id,
    })
}

#[tauri::command]
pub async fn openrouter_models(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let settings = settings::load(&app)?;
    let res = client()?
        .get("https://openrouter.ai/api/v1/models?sort=throughput-high-to-low")
        .headers(headers(&settings.openrouter_api_key)?)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let value = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(value.to_string());
    }
    Ok(value)
}

#[tauri::command]
pub async fn openrouter_chat(
    app: tauri::AppHandle,
    model: String,
    messages: Vec<ChatMessage>,
    temperature: Option<f32>,
) -> Result<ChatResult, String> {
    let settings = settings::load(&app)?;
    if settings.openrouter_api_key.trim().is_empty() {
        return Err("OpenRouter API key is missing.".into());
    }
    let body = json!({
        "model": model,
        "messages": messages,
        "temperature": temperature.unwrap_or(0.2),
        // ask OpenRouter to attach the settled cost + token accounting
        "usage": { "include": true },
    });
    let res = client()?
        .post("https://openrouter.ai/api/v1/chat/completions")
        .headers(headers(&settings.openrouter_api_key)?)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let value = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(value.to_string());
    }
    let content_value = &value["choices"][0]["message"]["content"];
    let content = content_value
        .as_str()
        .map(|s| s.to_string())
        .unwrap_or_else(|| content_value.to_string());
    let usage = &value["usage"];
    Ok(ChatResult {
        content,
        model: value["model"].as_str().map(|s| s.to_string()),
        prompt_tokens: usage["prompt_tokens"].as_i64(),
        completion_tokens: usage["completion_tokens"].as_i64(),
        reasoning_tokens: usage["completion_tokens_details"]["reasoning_tokens"].as_i64(),
        total_tokens: usage["total_tokens"].as_i64(),
        cost: usage["cost"].as_f64(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_wraps_pcm16_mono_16khz() {
        let pcm = [0x01, 0x02, 0x03, 0x04];
        let wav = pcm16_to_wav(&pcm).expect("valid wav");
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 4);
        assert_eq!(&wav[44..], &pcm);
    }

    #[test]
    fn wav_rejects_empty_and_incomplete_pcm() {
        assert!(pcm16_to_wav(&[]).is_err());
        assert!(pcm16_to_wav(&[0x01]).is_err());
    }

    #[test]
    fn maps_actionable_http_errors() {
        let value = json!({"error": {"message": "no credits"}});
        assert!(api_error(reqwest::StatusCode::PAYMENT_REQUIRED, &value)
            .starts_with("OPENROUTER_CREDITS:"));
        assert!(api_error(reqwest::StatusCode::TOO_MANY_REQUESTS, &value)
            .starts_with("OPENROUTER_RATE_LIMIT:"));
    }

    #[test]
    fn auto_language_is_omitted_and_forced_language_is_sent() {
        let auto = transcription_body(CLOUD_TRANSCRIPTION_TURBO, "audio".into(), "auto");
        assert!(auto.get("language").is_none());
        assert_eq!(auto["provider"]["zdr"], true);
        let german = transcription_body(CLOUD_TRANSCRIPTION_MAI_PREVIEW, "audio".into(), "de");
        assert_eq!(german["language"], "de");
        assert_eq!(german["model"], CLOUD_TRANSCRIPTION_MAI_PREVIEW);
    }
}
