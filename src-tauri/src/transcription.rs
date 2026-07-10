use serde::Serialize;

use crate::{asr, openrouter};

#[derive(Serialize)]
pub struct TranscriptionResult {
    pub text: String,
    pub engine: String,
    pub backend: String,
    pub model: String,
    pub provider: Option<String>,
    pub duration_ms: Option<i64>,
    pub fallback_used: bool,
    pub audio_seconds: Option<f64>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub cost: Option<f64>,
    pub generation_id: Option<String>,
}

fn local_result(result: asr::TranscriptionResult, fallback_used: bool) -> TranscriptionResult {
    TranscriptionResult {
        text: result.text,
        engine: result.engine,
        backend: "local".into(),
        model: asr::MODEL_ID.into(),
        provider: None,
        duration_ms: result.duration_ms,
        fallback_used,
        audio_seconds: None,
        input_tokens: None,
        output_tokens: None,
        total_tokens: None,
        cost: None,
        generation_id: None,
    }
}

async fn transcribe_local(
    pcm_b64: String,
    fallback_used: bool,
) -> Result<TranscriptionResult, String> {
    asr::transcribe_local(pcm_b64)
        .await
        .map(|result| local_result(result, fallback_used))
}

#[tauri::command]
pub async fn transcribe_audio(
    app: tauri::AppHandle,
    pcm_b64: String,
    backend: String,
    model: String,
    language: String,
    fallback_to_local: bool,
) -> Result<TranscriptionResult, String> {
    if backend != "openrouter" {
        return transcribe_local(pcm_b64, false).await;
    }

    match openrouter::transcribe_cloud(
        &app,
        &pcm_b64,
        &model,
        &language,
    )
    .await
    {
        Ok(result) => Ok(TranscriptionResult {
            text: result.text,
            engine: format!("{} via OpenRouter", model),
            backend: "openrouter".into(),
            model,
            provider: result.provider,
            duration_ms: Some(result.duration_ms),
            fallback_used: false,
            audio_seconds: result.audio_seconds,
            input_tokens: result.input_tokens,
            output_tokens: result.output_tokens,
            total_tokens: result.total_tokens,
            cost: result.cost,
            generation_id: result.generation_id,
        }),
        Err(cloud_error) if fallback_to_local && asr::local_model_installed() => {
            transcribe_local(pcm_b64, true).await.map_err(|local_error| {
                format!(
                    "Cloud-Transkription fehlgeschlagen ({cloud_error}); lokaler Fallback ebenfalls fehlgeschlagen: {local_error}"
                )
            })
        }
        Err(error) => Err(error),
    }
}
