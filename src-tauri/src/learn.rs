//! Background learning pass: every few hours the not-yet-analyzed history
//! entries are compared (raw ASR vs. delivered text) by the configured
//! OpenRouter model, which proposes dictionary corrections. Proposals land in
//! `dict_suggestions` and wait for the user's accept/dismiss in the
//! dictionary pane — nothing is ever applied automatically.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::Emitter;

use crate::{db, openrouter, settings};

/// One analysis pass at a time — the scheduler and the manual "run now"
/// button must not overlap.
static RUNNING: AtomicBool = AtomicBool::new(false);

const META_LAST_ID: &str = "last_analyzed_history_id";
const META_LAST_RUN: &str = "last_run_at";
/// Entries per model call; a run drains the backlog batch by batch.
const BATCH_LIMIT: u32 = 40;
/// Hard cap of batches per run (= max 200 entries / ~10 model calls).
const MAX_BATCHES_PER_RUN: usize = 5;
/// Per-entry text cap so one long dictation can't blow up the prompt.
const TEXT_CAP: usize = 500;
const INITIAL_DELAY: Duration = Duration::from_secs(90);
const INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);

#[derive(Serialize, Default)]
pub struct LearnRunResult {
    pub analyzed: usize,
    pub new_suggestions: usize,
    pub skipped: Option<String>,
}

#[derive(Serialize)]
pub struct LearnStatus {
    pub last_run_at: Option<String>,
    pub pending: i64,
    pub unanalyzed: i64,
    pub running: bool,
}

#[derive(Deserialize)]
struct ModelSuggestion {
    term: String,
    replacement: String,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    evidence: Option<String>,
}

pub fn spawn_scheduler(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(INITIAL_DELAY).await;
        loop {
            let _ = run_analysis(&app).await;
            tokio::time::sleep(INTERVAL).await;
        }
    });
}

#[tauri::command]
pub async fn learn_run_now(app: tauri::AppHandle) -> Result<LearnRunResult, String> {
    run_analysis(&app).await
}

#[tauri::command]
pub fn learn_status(app: tauri::AppHandle) -> Result<LearnStatus, String> {
    let last_id = last_analyzed_id(&app);
    Ok(LearnStatus {
        last_run_at: db::meta_get(&app, META_LAST_RUN),
        pending: db::suggestions_pending_count(&app)?,
        unanalyzed: db::history_count_after(&app, last_id)?,
        running: RUNNING.load(Ordering::SeqCst),
    })
}

fn last_analyzed_id(app: &tauri::AppHandle) -> i64 {
    db::meta_get(app, META_LAST_ID)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

async fn run_analysis(app: &tauri::AppHandle) -> Result<LearnRunResult, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(LearnRunResult {
            skipped: Some("Analyse läuft bereits.".into()),
            ..Default::default()
        });
    }
    let result = run_analysis_inner(app).await;
    RUNNING.store(false, Ordering::SeqCst);
    result
}

async fn run_analysis_inner(app: &tauri::AppHandle) -> Result<LearnRunResult, String> {
    let settings = settings::load(app)?;
    if !settings.learning_enabled {
        return Ok(LearnRunResult {
            skipped: Some("Lernvorschläge sind deaktiviert.".into()),
            ..Default::default()
        });
    }
    if settings.openrouter_api_key.trim().is_empty() {
        return Ok(LearnRunResult {
            skipped: Some("Kein OpenRouter API-Schlüssel hinterlegt.".into()),
            ..Default::default()
        });
    }

    let mut result = LearnRunResult::default();
    // drain the backlog in one go, but keep a hard cap per run so a huge
    // history can't turn one tick into an endless (and costly) session
    for _ in 0..MAX_BATCHES_PER_RUN {
        let last_id = last_analyzed_id(app);
        let batch = db::history_after(app, last_id, BATCH_LIMIT)?;
        if batch.is_empty() {
            break;
        }
        let fresh = analyze_batch(app, &settings, &batch).await?;
        result.analyzed += batch.len();
        result.new_suggestions += fresh;
    }

    db::meta_set(app, META_LAST_RUN, &chrono::Utc::now().to_rfc3339())?;
    if result.new_suggestions > 0 {
        let _ = app.emit("learn://suggestions", result.new_suggestions);
    }
    Ok(result)
}

/// Analyze one batch and persist its suggestions; returns how many new
/// pending suggestions were created. Advances the analyzed-marker only on
/// success, so a failed run is retried on the next tick.
async fn analyze_batch(
    app: &tauri::AppHandle,
    settings: &settings::Settings,
    batch: &[db::HistoryPair],
) -> Result<usize, String> {
    let dictionary = db::dictionary_list(app.clone())?;
    let known_pairs = db::suggestion_known_pairs(app)?;
    let messages = build_messages(batch, &dictionary, &known_pairs);

    let chat = openrouter::openrouter_chat(
        app.clone(),
        settings.postprocess_model.clone(),
        messages,
        Some(0.1),
    )
    .await?;

    let proposals = parse_suggestions(&chat.content)?;
    let mut candidates: Vec<ModelSuggestion> = Vec::new();
    for proposal in proposals {
        let term = proposal.term.trim().to_string();
        let replacement = proposal.replacement.trim().to_string();
        if term.is_empty() || replacement.is_empty() || term == replacement {
            continue;
        }
        // guard against hallucinated pairs: the misheard form must actually
        // occur in one of the analyzed raw transcripts
        let term_lower = term.to_lowercase();
        if !batch
            .iter()
            .any(|entry| entry.raw_text.to_lowercase().contains(&term_lower))
        {
            continue;
        }
        // never shadow an existing dictionary entry
        if dictionary
            .iter()
            .any(|entry| entry.term.to_lowercase() == term_lower)
        {
            continue;
        }
        candidates.push(ModelSuggestion {
            term,
            replacement,
            reason: proposal.reason,
            evidence: proposal.evidence,
        });
    }

    // Second, adversarial pass: the replacement is later applied blindly to
    // every dictation, so ask the model whether each misheard form could
    // also be ordinary language. Unsafe pairs are kept, but with an explicit
    // warning in the reason — the user makes the final call in the UI.
    let verdicts = verify_candidates(app, &settings.postprocess_model, &candidates).await;

    let mut new_suggestions = 0usize;
    for candidate in &candidates {
        let mut reason = candidate.reason.clone().unwrap_or_default();
        if let Some(why) = verdicts
            .iter()
            .find(|v| !v.safe && v.term.to_lowercase() == candidate.term.to_lowercase())
            .map(|v| v.why.clone())
        {
            let warning = format!(
                "Vorsicht: {} Die Ersetzung wirkt automatisch auf jedes Diktat.",
                if why.is_empty() {
                    format!("„{}\" kann auch in normaler Sprache vorkommen.", candidate.term)
                } else {
                    why
                }
            );
            reason = if reason.is_empty() {
                warning
            } else {
                format!("{reason} — {warning}")
            };
        }
        if db::suggestion_insert(
            app,
            &candidate.term,
            &candidate.replacement,
            (!reason.is_empty()).then_some(reason.as_str()),
            candidate.evidence.as_deref(),
        )? {
            new_suggestions += 1;
        }
    }

    if let Some(max_id) = batch.iter().map(|entry| entry.id).max() {
        db::meta_set(app, META_LAST_ID, &max_id.to_string())?;
    }
    Ok(new_suggestions)
}

#[derive(Deserialize)]
struct SafetyVerdict {
    term: String,
    safe: bool,
    #[serde(default)]
    why: String,
}

/// Ask the model, pair by pair, whether blind auto-replacement of the
/// misheard form could damage ordinary language. Failures degrade
/// gracefully: no verdicts simply means no warnings.
async fn verify_candidates(
    app: &tauri::AppHandle,
    model: &str,
    candidates: &[ModelSuggestion],
) -> Vec<SafetyVerdict> {
    if candidates.is_empty() {
        return Vec::new();
    }
    let system = [
        "Du prüfst Ersetzungsregeln für ein Diktier-Wörterbuch. Jede Regel \"term -> replacement\" wird später automatisch und wortgrenzen-basiert auf JEDES Diktat angewendet, ohne Kontextprüfung.",
        "Eine Regel ist nur dann sicher, wenn \"term\" praktisch ausschließlich als Fehlerkennung vorkommen kann — also KEIN gebräuchliches deutsches oder englisches Wort und KEINE Wortfolge ist, die in normaler Sprache vorkommt.",
        "Beispiele: \"Getab\" ist sicher (kein echtes Wort). \"Attack\" ist unsicher (normales englisches Wort). \"Weg A\" ist unsicher (normale deutsche Wortfolge).",
        "Antworte ausschließlich mit einem JSON-Array, ohne Markdown:",
        r#"[{"term": "...", "safe": true/false, "why": "kurze Begründung"}]"#,
    ]
    .join("\n");
    let user = candidates
        .iter()
        .map(|c| format!("{} -> {}", c.term, c.replacement))
        .collect::<Vec<_>>()
        .join("\n");
    let messages = vec![
        openrouter::ChatMessage {
            role: "system".into(),
            content: system,
        },
        openrouter::ChatMessage {
            role: "user".into(),
            content: user,
        },
    ];
    let Ok(chat) = openrouter::openrouter_chat(app.clone(), model.into(), messages, Some(0.0)).await
    else {
        return Vec::new();
    };
    let trimmed = chat.content.trim().to_string();
    let inner = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .and_then(|rest| rest.strip_suffix("```"))
        .unwrap_or(&trimmed)
        .trim();
    serde_json::from_str::<Vec<SafetyVerdict>>(inner).unwrap_or_default()
}

fn cap(text: &str) -> &str {
    match text.char_indices().nth(TEXT_CAP) {
        Some((idx, _)) => &text[..idx],
        None => text,
    }
}

fn build_messages(
    batch: &[db::HistoryPair],
    dictionary: &[db::DictionaryEntry],
    known_pairs: &[(String, String)],
) -> Vec<openrouter::ChatMessage> {
    let system = [
        "Du analysierst Diktate einer Spracherkennungs-App, um wiederkehrende Erkennungsfehler zu finden.",
        "Du bekommst Paare aus Roh-Transkript (lokale Spracherkennung, \"raw\") und finalem Text (nach Korrektur, \"final\"; kann identisch sein).",
        "Finde Begriffe — Eigennamen, Produkte, Marken, Fachwörter, feste Schreibweisen — die die Spracherkennung wiederholt oder eindeutig falsch schreibt und die sich als feste Ersetzungsregel \"falsche Form -> richtige Form\" eignen.",
        "Regeln:",
        "- Nur konkrete, wiederverwendbare Begriffe aus 1 bis 4 Wörtern. Keine Grammatik-, Stil- oder Interpunktionskorrekturen, keine ganzen Sätze.",
        "- Die falsche Form muss exakt so in einem der Roh-Transkripte vorkommen.",
        "- Die Ersetzung wird später automatisch auf jedes Diktat angewendet. Schlage eine falsche Form deshalb NUR vor, wenn sie kein gebräuchliches deutsches oder englisches Wort ist. Beispiel: \"Attack -> ein Tag\" wäre falsch, weil \"Attack\" auch als normales Wort vorkommen kann und dann fälschlich ersetzt würde. \"Getab -> GitHub\" wäre richtig, weil \"Getab\" kein echtes Wort ist.",
        "- Schlage nichts vor, was bereits im Wörterbuch steht oder in der Liste bekannter Vorschläge enthalten ist.",
        "- Im Zweifel weglassen: lieber keine Vorschläge als unsichere.",
        "Antworte ausschließlich mit einem JSON-Array, ohne Markdown und ohne Erklärung:",
        r#"[{"term": "falsche Form", "replacement": "richtige Form", "reason": "kurze deutsche Begründung, worauf der Vorschlag basiert", "evidence": "kurzes wörtliches Zitat aus einem Roh-Transkript"}]"#,
        "Wenn es nichts Sinnvolles gibt, antworte mit []",
    ]
    .join("\n");

    let dictionary_text = if dictionary.is_empty() {
        "(leer)".to_string()
    } else {
        dictionary
            .iter()
            .map(|entry| match entry.replacement.as_deref() {
                Some(replacement) if !replacement.trim().is_empty() => {
                    format!("{} -> {}", entry.term, replacement)
                }
                _ => entry.term.clone(),
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let known_text = if known_pairs.is_empty() {
        "(keine)".to_string()
    } else {
        known_pairs
            .iter()
            .map(|(term, replacement)| format!("{term} -> {replacement}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let entries_text = batch
        .iter()
        .map(|entry| {
            serde_json::json!({
                "raw": cap(&entry.raw_text),
                "final": cap(&entry.final_text),
            })
            .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n");

    vec![
        openrouter::ChatMessage {
            role: "system".into(),
            content: system,
        },
        openrouter::ChatMessage {
            role: "user".into(),
            content: format!(
                "Bestehendes Wörterbuch:\n{dictionary_text}\n\nBekannte Vorschläge (nicht erneut vorschlagen):\n{known_text}\n\nDiktate (ein JSON-Objekt pro Zeile):\n{entries_text}"
            ),
        },
    ]
}

/// The model is told to answer with bare JSON, but be lenient about a
/// ```json fence around it.
fn parse_suggestions(content: &str) -> Result<Vec<ModelSuggestion>, String> {
    let trimmed = content.trim();
    let inner = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .and_then(|rest| rest.strip_suffix("```"))
        .unwrap_or(trimmed)
        .trim();
    serde_json::from_str::<Vec<ModelSuggestion>>(inner)
        .map_err(|e| format!("Antwort der Analyse ist kein gültiges JSON: {e}"))
}
