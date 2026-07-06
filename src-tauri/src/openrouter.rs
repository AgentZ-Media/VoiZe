use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::settings;

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

#[tauri::command]
pub async fn openrouter_models(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let settings = settings::load(&app)?;
    let client = reqwest::Client::new();
    let res = client
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
    let client = reqwest::Client::new();
    let body = json!({
        "model": model,
        "messages": messages,
        "temperature": temperature.unwrap_or(0.2),
        // ask OpenRouter to attach the settled cost + token accounting
        "usage": { "include": true },
    });
    let res = client
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
