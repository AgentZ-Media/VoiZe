use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("voize.sqlite"))
}

fn conn(app: &tauri::AppHandle) -> Result<Connection, String> {
    Connection::open(db_path(app)?).map_err(|e| e.to_string())
}

pub fn init(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let db = Connection::open(db_path(app)?)?;
    db.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          focused_app TEXT,
          bundle_id TEXT,
          window_title TEXT,
          raw_text TEXT NOT NULL,
          final_text TEXT NOT NULL,
          delivery_mode TEXT NOT NULL,
          model TEXT,
          post_processed INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER,
          dictionary_snapshot TEXT NOT NULL DEFAULT '[]',
          transcription_backend TEXT NOT NULL DEFAULT 'local',
          transcription_model TEXT,
          transcription_latency_ms INTEGER,
          transcription_cost REAL,
          transcription_fallback_used INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at DESC);
        CREATE TABLE IF NOT EXISTS dictionary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          term TEXT NOT NULL UNIQUE,
          replacement TEXT,
          notes TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS dict_suggestions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          term TEXT NOT NULL,
          replacement TEXT NOT NULL,
          reason TEXT,
          evidence TEXT,
          occurrences INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'pending',
          UNIQUE(term, replacement)
        );
        CREATE TABLE IF NOT EXISTS learn_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ai_usage_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          kind TEXT NOT NULL,
          model TEXT,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          reasoning_tokens INTEGER,
          total_tokens INTEGER,
          cost REAL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_usage_events_created_at
          ON ai_usage_events(created_at DESC);
        "#,
    )?;
    ensure_history_columns(&db)?;
    Ok(())
}

/// Idempotent migration: add the OpenRouter usage/cost columns to older
/// databases. All are nullable — a dictation without AI post-processing (or a
/// provider that omits a field) simply stores NULL.
fn ensure_history_columns(db: &Connection) -> rusqlite::Result<()> {
    let existing: std::collections::HashSet<String> = {
        let mut stmt = db.prepare("PRAGMA table_info(history)")?;
        let cols = stmt.query_map([], |row| row.get::<_, String>(1))?;
        cols.filter_map(|c| c.ok()).collect()
    };
    for (name, ty) in [
        ("prompt_tokens", "INTEGER"),
        ("completion_tokens", "INTEGER"),
        ("reasoning_tokens", "INTEGER"),
        ("total_tokens", "INTEGER"),
        ("cost", "REAL"),
        ("transcription_backend", "TEXT NOT NULL DEFAULT 'local'"),
        ("transcription_model", "TEXT"),
        ("transcription_latency_ms", "INTEGER"),
        ("transcription_cost", "REAL"),
        ("transcription_fallback_used", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !existing.contains(name) {
            db.execute(&format!("ALTER TABLE history ADD COLUMN {name} {ty}"), [])?;
        }
    }
    Ok(())
}

#[derive(Serialize)]
pub struct HistoryEntry {
    pub id: i64,
    pub created_at: String,
    pub focused_app: Option<String>,
    pub bundle_id: Option<String>,
    pub window_title: Option<String>,
    pub raw_text: String,
    pub final_text: String,
    pub delivery_mode: String,
    pub model: Option<String>,
    pub post_processed: bool,
    pub duration_ms: Option<i64>,
    pub dictionary_snapshot: String,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub reasoning_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub cost: Option<f64>,
    pub transcription_backend: String,
    pub transcription_model: Option<String>,
    pub transcription_latency_ms: Option<i64>,
    pub transcription_cost: Option<f64>,
    pub transcription_fallback_used: bool,
}

#[derive(Serialize)]
pub struct HistoryApp {
    pub app_name: String,
    pub bundle_id: String,
    pub last_used_at: String,
    pub dictation_count: i64,
}

#[derive(Deserialize)]
pub struct NewHistoryEntry {
    pub focused_app: Option<String>,
    pub bundle_id: Option<String>,
    pub window_title: Option<String>,
    pub raw_text: String,
    pub final_text: String,
    pub delivery_mode: String,
    pub model: Option<String>,
    pub post_processed: bool,
    pub duration_ms: Option<i64>,
    pub dictionary_snapshot: Option<String>,
    #[serde(default)]
    pub prompt_tokens: Option<i64>,
    #[serde(default)]
    pub completion_tokens: Option<i64>,
    #[serde(default)]
    pub reasoning_tokens: Option<i64>,
    #[serde(default)]
    pub total_tokens: Option<i64>,
    #[serde(default)]
    pub cost: Option<f64>,
    pub transcription_backend: String,
    pub transcription_model: Option<String>,
    pub transcription_latency_ms: Option<i64>,
    pub transcription_cost: Option<f64>,
    pub transcription_fallback_used: bool,
}

#[tauri::command]
pub fn history_insert(
    app: tauri::AppHandle,
    entry: NewHistoryEntry,
) -> Result<HistoryEntry, String> {
    let db = conn(&app)?;
    let created_at = Utc::now().to_rfc3339();
    db.execute(
        r#"
        INSERT INTO history (
          created_at, focused_app, bundle_id, window_title, raw_text,
          final_text, delivery_mode, model, post_processed, duration_ms,
          dictionary_snapshot, prompt_tokens, completion_tokens,
          reasoning_tokens, total_tokens, cost, transcription_backend,
          transcription_model, transcription_latency_ms, transcription_cost,
          transcription_fallback_used
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
        "#,
        params![
            created_at,
            entry.focused_app,
            entry.bundle_id,
            entry.window_title,
            entry.raw_text,
            entry.final_text,
            entry.delivery_mode,
            entry.model,
            if entry.post_processed { 1 } else { 0 },
            entry.duration_ms,
            entry.dictionary_snapshot.unwrap_or_else(|| "[]".into()),
            entry.prompt_tokens,
            entry.completion_tokens,
            entry.reasoning_tokens,
            entry.total_tokens,
            entry.cost,
            entry.transcription_backend,
            entry.transcription_model,
            entry.transcription_latency_ms,
            entry.transcription_cost,
            if entry.transcription_fallback_used { 1 } else { 0 }
        ],
    )
    .map_err(|e| e.to_string())?;
    let id = db.last_insert_rowid();
    history_get(&db, id)
}

fn history_get(db: &Connection, id: i64) -> Result<HistoryEntry, String> {
    db.query_row(
        r#"
        SELECT id, created_at, focused_app, bundle_id, window_title, raw_text,
               final_text, delivery_mode, model, post_processed, duration_ms,
               dictionary_snapshot, prompt_tokens, completion_tokens,
               reasoning_tokens, total_tokens, cost, transcription_backend,
               transcription_model, transcription_latency_ms, transcription_cost,
               transcription_fallback_used
        FROM history WHERE id = ?1
        "#,
        [id],
        |row| {
            Ok(HistoryEntry {
                id: row.get(0)?,
                created_at: row.get(1)?,
                focused_app: row.get(2)?,
                bundle_id: row.get(3)?,
                window_title: row.get(4)?,
                raw_text: row.get(5)?,
                final_text: row.get(6)?,
                delivery_mode: row.get(7)?,
                model: row.get(8)?,
                post_processed: row.get::<_, i64>(9)? != 0,
                duration_ms: row.get(10)?,
                dictionary_snapshot: row.get(11)?,
                prompt_tokens: row.get(12)?,
                completion_tokens: row.get(13)?,
                reasoning_tokens: row.get(14)?,
                total_tokens: row.get(15)?,
                cost: row.get(16)?,
                transcription_backend: row.get(17)?,
                transcription_model: row.get(18)?,
                transcription_latency_ms: row.get(19)?,
                transcription_cost: row.get(20)?,
                transcription_fallback_used: row.get::<_, i64>(21)? != 0,
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_list(
    app: tauri::AppHandle,
    query: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<HistoryEntry>, String> {
    let db = conn(&app)?;
    let lim = limit.unwrap_or(80).min(300);
    let mut entries = Vec::new();
    if let Some(q) = query.filter(|q| !q.trim().is_empty()) {
        let like = format!("%{}%", q.trim());
        let mut stmt = db
            .prepare(
                r#"
                SELECT id, created_at, focused_app, bundle_id, window_title, raw_text,
                       final_text, delivery_mode, model, post_processed, duration_ms,
                       dictionary_snapshot, prompt_tokens, completion_tokens,
                       reasoning_tokens, total_tokens, cost, transcription_backend,
                       transcription_model, transcription_latency_ms, transcription_cost,
                       transcription_fallback_used
                FROM history
                WHERE raw_text LIKE ?1 OR final_text LIKE ?1 OR focused_app LIKE ?1
                ORDER BY created_at DESC
                LIMIT ?2
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![like, lim], row_to_history)
            .map_err(|e| e.to_string())?;
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
    } else {
        let mut stmt = db
            .prepare(
                r#"
                SELECT id, created_at, focused_app, bundle_id, window_title, raw_text,
                       final_text, delivery_mode, model, post_processed, duration_ms,
                       dictionary_snapshot, prompt_tokens, completion_tokens,
                       reasoning_tokens, total_tokens, cost, transcription_backend,
                       transcription_model, transcription_latency_ms, transcription_cost,
                       transcription_fallback_used
                FROM history
                ORDER BY created_at DESC
                LIMIT ?1
                "#,
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([lim], row_to_history)
            .map_err(|e| e.to_string())?;
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(entries)
}

#[tauri::command]
pub fn history_apps(app: tauri::AppHandle, limit: Option<u32>) -> Result<Vec<HistoryApp>, String> {
    let db = conn(&app)?;
    let lim = limit.unwrap_or(20).min(100);
    let mut stmt = db
        .prepare(
            r#"
            SELECT COALESCE(MAX(NULLIF(TRIM(focused_app), '')), bundle_id) AS app_name,
                   bundle_id,
                   MAX(created_at) AS last_used_at,
                   COUNT(*) AS dictation_count
            FROM history
            WHERE bundle_id IS NOT NULL AND TRIM(bundle_id) <> ''
            GROUP BY bundle_id
            ORDER BY last_used_at DESC
            LIMIT ?1
            "#,
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([lim], |row| {
            Ok(HistoryApp {
                app_name: row.get(0)?,
                bundle_id: row.get(1)?,
                last_used_at: row.get(2)?,
                dictation_count: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn row_to_history(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryEntry> {
    Ok(HistoryEntry {
        id: row.get(0)?,
        created_at: row.get(1)?,
        focused_app: row.get(2)?,
        bundle_id: row.get(3)?,
        window_title: row.get(4)?,
        raw_text: row.get(5)?,
        final_text: row.get(6)?,
        delivery_mode: row.get(7)?,
        model: row.get(8)?,
        post_processed: row.get::<_, i64>(9)? != 0,
        duration_ms: row.get(10)?,
        dictionary_snapshot: row.get(11)?,
        prompt_tokens: row.get(12)?,
        completion_tokens: row.get(13)?,
        reasoning_tokens: row.get(14)?,
        total_tokens: row.get(15)?,
        cost: row.get(16)?,
        transcription_backend: row.get(17)?,
        transcription_model: row.get(18)?,
        transcription_latency_ms: row.get(19)?,
        transcription_cost: row.get(20)?,
        transcription_fallback_used: row.get::<_, i64>(21)? != 0,
    })
}

#[tauri::command]
pub fn history_delete(app: tauri::AppHandle, id: i64) -> Result<bool, String> {
    let db = conn(&app)?;
    let n = db
        .execute("DELETE FROM history WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

#[derive(Serialize, Default)]
pub struct UsageSummary {
    pub count: i64,
    pub post_processed_count: i64,
    pub cloud_transcribed_count: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub reasoning_tokens: i64,
    pub total_tokens: i64,
    pub transcription_cost: f64,
    pub postprocess_cost: f64,
    pub background_cost: f64,
    pub cost: f64,
}

/// Aggregate token usage and cost over an optional time window. History rows
/// cover per-dictation post-processing, while `ai_usage_events` covers
/// background AI work such as dictionary learning. `from`/`to` are RFC3339
/// timestamps (created_at is stored as RFC3339 UTC, so a lexical comparison is
/// also chronological). A `None` bound is open-ended, so passing both as `None`
/// yields the all-time total. `to` is exclusive.
#[tauri::command]
pub fn usage_summary(
    app: tauri::AppHandle,
    from: Option<String>,
    to: Option<String>,
) -> Result<UsageSummary, String> {
    let db = conn(&app)?;
    let mut summary = db
        .query_row(
            r#"
        SELECT
          COUNT(*),
          COALESCE(SUM(post_processed), 0),
          COALESCE(SUM(CASE WHEN transcription_backend = 'openrouter' THEN 1 ELSE 0 END), 0),
          COALESCE(SUM(prompt_tokens), 0),
          COALESCE(SUM(completion_tokens), 0),
          COALESCE(SUM(reasoning_tokens), 0),
          COALESCE(SUM(total_tokens), 0),
          COALESCE(SUM(cost), 0),
          COALESCE(SUM(transcription_cost), 0)
        FROM history
        WHERE (?1 IS NULL OR created_at >= ?1)
          AND (?2 IS NULL OR created_at < ?2)
        "#,
            params![from.as_deref(), to.as_deref()],
            |row| {
                Ok(UsageSummary {
                    count: row.get(0)?,
                    post_processed_count: row.get(1)?,
                    cloud_transcribed_count: row.get(2)?,
                    prompt_tokens: row.get(3)?,
                    completion_tokens: row.get(4)?,
                    reasoning_tokens: row.get(5)?,
                    total_tokens: row.get(6)?,
                    postprocess_cost: row.get(7)?,
                    transcription_cost: row.get(8)?,
                    background_cost: 0.0,
                    cost: row.get::<_, f64>(7)? + row.get::<_, f64>(8)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    let event_usage: (i64, i64, i64, i64, f64) = db
        .query_row(
            r#"
            SELECT
              COALESCE(SUM(prompt_tokens), 0),
              COALESCE(SUM(completion_tokens), 0),
              COALESCE(SUM(reasoning_tokens), 0),
              COALESCE(SUM(total_tokens), 0),
              COALESCE(SUM(cost), 0)
            FROM ai_usage_events
            WHERE (?1 IS NULL OR created_at >= ?1)
              AND (?2 IS NULL OR created_at < ?2)
            "#,
            params![from.as_deref(), to.as_deref()],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;

    summary.prompt_tokens += event_usage.0;
    summary.completion_tokens += event_usage.1;
    summary.reasoning_tokens += event_usage.2;
    summary.total_tokens += event_usage.3;
    summary.background_cost = event_usage.4;
    summary.cost += event_usage.4;
    Ok(summary)
}

pub fn usage_event_insert(
    app: &tauri::AppHandle,
    kind: &str,
    model: Option<&str>,
    prompt_tokens: Option<i64>,
    completion_tokens: Option<i64>,
    reasoning_tokens: Option<i64>,
    total_tokens: Option<i64>,
    cost: Option<f64>,
) -> Result<(), String> {
    let has_usage = prompt_tokens.is_some()
        || completion_tokens.is_some()
        || reasoning_tokens.is_some()
        || total_tokens.is_some()
        || cost.is_some();
    if !has_usage {
        return Ok(());
    }
    let db = conn(app)?;
    db.execute(
        r#"
        INSERT INTO ai_usage_events (
          created_at, kind, model, prompt_tokens, completion_tokens,
          reasoning_tokens, total_tokens, cost
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        "#,
        params![
            Utc::now().to_rfc3339(),
            kind,
            model,
            prompt_tokens,
            completion_tokens,
            reasoning_tokens,
            total_tokens,
            cost
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize, Deserialize, Clone)]
pub struct DictionaryEntry {
    pub id: i64,
    pub term: String,
    pub replacement: Option<String>,
    pub notes: Option<String>,
    pub priority: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
pub struct DictionaryInput {
    pub id: Option<i64>,
    pub term: String,
    pub replacement: Option<String>,
    pub notes: Option<String>,
    pub priority: bool,
}

#[tauri::command]
pub fn dictionary_list(app: tauri::AppHandle) -> Result<Vec<DictionaryEntry>, String> {
    let db = conn(&app)?;
    let mut stmt = db
        .prepare(
            r#"
            SELECT id, term, replacement, notes, priority, created_at, updated_at
            FROM dictionary
            ORDER BY priority DESC, lower(term) ASC
            "#,
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(DictionaryEntry {
                id: row.get(0)?,
                term: row.get(1)?,
                replacement: row.get(2)?,
                notes: row.get(3)?,
                priority: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn dictionary_upsert(
    app: tauri::AppHandle,
    entry: DictionaryInput,
) -> Result<DictionaryEntry, String> {
    let term = entry.term.trim();
    if term.is_empty() {
        return Err("Dictionary term cannot be empty.".into());
    }
    let db = conn(&app)?;
    let now = Utc::now().to_rfc3339();
    if let Some(id) = entry.id {
        db.execute(
            r#"
            UPDATE dictionary
            SET term = ?1, replacement = ?2, notes = ?3, priority = ?4,
                updated_at = ?5
            WHERE id = ?6
            "#,
            params![
                term,
                entry.replacement,
                entry.notes,
                if entry.priority { 1 } else { 0 },
                now,
                id
            ],
        )
        .map_err(|e| e.to_string())?;
        dictionary_get(&db, id)
    } else {
        db.execute(
            r#"
            INSERT INTO dictionary (term, replacement, notes, priority, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?5)
            ON CONFLICT(term) DO UPDATE SET
              replacement = excluded.replacement,
              notes = excluded.notes,
              priority = excluded.priority,
              updated_at = excluded.updated_at
            "#,
            params![
                term,
                entry.replacement,
                entry.notes,
                if entry.priority { 1 } else { 0 },
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        let id = db
            .query_row("SELECT id FROM dictionary WHERE term = ?1", [term], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(|e| e.to_string())?;
        dictionary_get(&db, id)
    }
}

fn dictionary_get(db: &Connection, id: i64) -> Result<DictionaryEntry, String> {
    db.query_row(
        r#"
        SELECT id, term, replacement, notes, priority, created_at, updated_at
        FROM dictionary WHERE id = ?1
        "#,
        [id],
        |row| {
            Ok(DictionaryEntry {
                id: row.get(0)?,
                term: row.get(1)?,
                replacement: row.get(2)?,
                notes: row.get(3)?,
                priority: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn dictionary_delete(app: tauri::AppHandle, id: i64) -> Result<bool, String> {
    let db = conn(&app)?;
    let n = db
        .execute("DELETE FROM dictionary WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

#[derive(Serialize)]
pub struct AppInsight {
    pub app: String,
    pub count: i64,
    pub words: i64,
}

#[derive(Serialize, Default)]
pub struct InsightsSummary {
    pub count: i64,
    pub words: i64,
    pub duration_ms: i64,
    pub top_apps: Vec<AppInsight>,
}

/// Dictation statistics over an optional time window (same RFC3339 bounds
/// semantics as `usage_summary`). Word counts come from the delivered text,
/// so they reflect what actually landed in the target app.
#[tauri::command]
pub fn insights_summary(
    app: tauri::AppHandle,
    from: Option<String>,
    to: Option<String>,
) -> Result<InsightsSummary, String> {
    let db = conn(&app)?;
    let mut stmt = db
        .prepare(
            r#"
            SELECT final_text, duration_ms, focused_app
            FROM history
            WHERE (?1 IS NULL OR created_at >= ?1)
              AND (?2 IS NULL OR created_at < ?2)
            "#,
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![from, to], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut summary = InsightsSummary::default();
    let mut apps: std::collections::HashMap<String, (i64, i64)> = Default::default();
    for row in rows {
        let (final_text, duration_ms, focused_app) = row.map_err(|e| e.to_string())?;
        let words = final_text.split_whitespace().count() as i64;
        summary.count += 1;
        summary.words += words;
        summary.duration_ms += duration_ms.unwrap_or(0);
        let key = focused_app
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Unbekannte App".into());
        let entry = apps.entry(key).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += words;
    }
    let mut top: Vec<AppInsight> = apps
        .into_iter()
        .map(|(app, (count, words))| AppInsight { app, count, words })
        .collect();
    top.sort_by(|a, b| b.words.cmp(&a.words));
    top.truncate(6);
    summary.top_apps = top;
    Ok(summary)
}

#[derive(Serialize, Clone)]
pub struct DictSuggestion {
    pub id: i64,
    pub created_at: String,
    pub term: String,
    pub replacement: String,
    pub reason: Option<String>,
    pub evidence: Option<String>,
    pub occurrences: i64,
    pub status: String,
}

fn row_to_suggestion(row: &rusqlite::Row<'_>) -> rusqlite::Result<DictSuggestion> {
    Ok(DictSuggestion {
        id: row.get(0)?,
        created_at: row.get(1)?,
        term: row.get(2)?,
        replacement: row.get(3)?,
        reason: row.get(4)?,
        evidence: row.get(5)?,
        occurrences: row.get(6)?,
        status: row.get(7)?,
    })
}

#[tauri::command]
pub fn suggestions_list(app: tauri::AppHandle) -> Result<Vec<DictSuggestion>, String> {
    let db = conn(&app)?;
    let mut stmt = db
        .prepare(
            r#"
            SELECT id, created_at, term, replacement, reason, evidence, occurrences, status
            FROM dict_suggestions
            WHERE status = 'pending'
            ORDER BY occurrences DESC, created_at DESC
            "#,
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_suggestion)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Accept a suggestion: it becomes a regular dictionary entry (the reason is
/// kept as the entry's note so the origin stays visible) and is marked
/// accepted so the analyzer never proposes the same pair again.
#[tauri::command]
pub fn suggestion_accept(app: tauri::AppHandle, id: i64) -> Result<DictionaryEntry, String> {
    let suggestion = {
        let db = conn(&app)?;
        db.query_row(
            r#"
            SELECT id, created_at, term, replacement, reason, evidence, occurrences, status
            FROM dict_suggestions WHERE id = ?1
            "#,
            [id],
            row_to_suggestion,
        )
        .map_err(|e| e.to_string())?
    };
    let entry = dictionary_upsert(
        app.clone(),
        DictionaryInput {
            id: None,
            term: suggestion.term,
            replacement: Some(suggestion.replacement),
            notes: suggestion.reason,
            priority: false,
        },
    )?;
    let db = conn(&app)?;
    db.execute(
        "UPDATE dict_suggestions SET status = 'accepted' WHERE id = ?1",
        [id],
    )
    .map_err(|e| e.to_string())?;
    Ok(entry)
}

#[tauri::command]
pub fn suggestion_dismiss(app: tauri::AppHandle, id: i64) -> Result<bool, String> {
    let db = conn(&app)?;
    let n = db
        .execute(
            "UPDATE dict_suggestions SET status = 'dismissed' WHERE id = ?1",
            [id],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

// ---- helpers for the background learning pass (see learn.rs) ----

pub fn meta_get(app: &tauri::AppHandle, key: &str) -> Option<String> {
    let db = conn(app).ok()?;
    db.query_row(
        "SELECT value FROM learn_meta WHERE key = ?1",
        [key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

pub fn meta_set(app: &tauri::AppHandle, key: &str, value: &str) -> Result<(), String> {
    let db = conn(app)?;
    db.execute(
        r#"
        INSERT INTO learn_meta (key, value) VALUES (?1, ?2)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        "#,
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub struct HistoryPair {
    pub id: i64,
    pub raw_text: String,
    pub final_text: String,
}

/// Oldest-first batch of history entries the analyzer has not seen yet.
pub fn history_after(
    app: &tauri::AppHandle,
    after_id: i64,
    limit: u32,
) -> Result<Vec<HistoryPair>, String> {
    let db = conn(app)?;
    let mut stmt = db
        .prepare(
            r#"
            SELECT id, raw_text, final_text FROM history
            WHERE id > ?1 ORDER BY id ASC LIMIT ?2
            "#,
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![after_id, limit], |row| {
            Ok(HistoryPair {
                id: row.get(0)?,
                raw_text: row.get(1)?,
                final_text: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn history_count_after(app: &tauri::AppHandle, after_id: i64) -> Result<i64, String> {
    let db = conn(app)?;
    db.query_row(
        "SELECT COUNT(*) FROM history WHERE id > ?1",
        [after_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

pub fn suggestions_pending_count(app: &tauri::AppHandle) -> Result<i64, String> {
    let db = conn(app)?;
    db.query_row(
        "SELECT COUNT(*) FROM dict_suggestions WHERE status = 'pending'",
        [],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// All (term, replacement) pairs ever suggested, regardless of status — the
/// analyzer passes them to the model so dismissed pairs stay dismissed.
pub fn suggestion_known_pairs(app: &tauri::AppHandle) -> Result<Vec<(String, String)>, String> {
    let db = conn(app)?;
    let mut stmt = db
        .prepare("SELECT term, replacement FROM dict_suggestions")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Insert a fresh suggestion or bump the counter of a matching pending one.
/// Accepted/dismissed pairs are left untouched. Returns true when a new
/// pending suggestion was created.
pub fn suggestion_insert(
    app: &tauri::AppHandle,
    term: &str,
    replacement: &str,
    reason: Option<&str>,
    evidence: Option<&str>,
) -> Result<bool, String> {
    let db = conn(app)?;
    let existing: Option<(i64, String)> = db
        .query_row(
            "SELECT id, status FROM dict_suggestions WHERE term = ?1 AND replacement = ?2",
            params![term, replacement],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    match existing {
        Some((id, status)) => {
            if status == "pending" {
                db.execute(
                    "UPDATE dict_suggestions SET occurrences = occurrences + 1 WHERE id = ?1",
                    [id],
                )
                .map_err(|e| e.to_string())?;
            }
            Ok(false)
        }
        None => {
            db.execute(
                r#"
                INSERT INTO dict_suggestions (created_at, term, replacement, reason, evidence)
                VALUES (?1, ?2, ?3, ?4, ?5)
                "#,
                params![Utc::now().to_rfc3339(), term, replacement, reason, evidence],
            )
            .map_err(|e| e.to_string())?;
            Ok(true)
        }
    }
}

#[tauri::command]
pub fn dictionary_replace_all(
    app: tauri::AppHandle,
    entries: Vec<DictionaryInput>,
) -> Result<Vec<DictionaryEntry>, String> {
    let mut db = conn(&app)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM dictionary", [])
        .map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    for entry in entries {
        let term = entry.term.trim();
        if term.is_empty() {
            continue;
        }
        tx.execute(
            r#"
            INSERT OR IGNORE INTO dictionary
              (term, replacement, notes, priority, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?5)
            "#,
            params![
                term,
                entry.replacement,
                entry.notes,
                if entry.priority { 1 } else { 0 },
                now
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    dictionary_list(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_history_schema_gets_cloud_transcription_columns() {
        let db = Connection::open_in_memory().expect("in-memory db");
        db.execute_batch(
            r#"
            CREATE TABLE history (
              id INTEGER PRIMARY KEY,
              raw_text TEXT NOT NULL,
              final_text TEXT NOT NULL
            );
            "#,
        )
        .expect("legacy schema");
        ensure_history_columns(&db).expect("migration");
        let columns: std::collections::HashSet<String> = {
            let mut stmt = db.prepare("PRAGMA table_info(history)").unwrap();
            stmt.query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .map(|row| row.unwrap())
                .collect()
        };
        for expected in [
            "transcription_backend",
            "transcription_model",
            "transcription_latency_ms",
            "transcription_cost",
            "transcription_fallback_used",
        ] {
            assert!(columns.contains(expected), "missing {expected}");
        }
    }
}
