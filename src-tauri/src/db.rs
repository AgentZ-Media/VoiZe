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
          dictionary_snapshot TEXT NOT NULL DEFAULT '[]'
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
          reasoning_tokens, total_tokens, cost
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
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
            entry.cost
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
               reasoning_tokens, total_tokens, cost
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
                       dictionary_snapshot
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
                       dictionary_snapshot
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
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub reasoning_tokens: i64,
    pub total_tokens: i64,
    pub cost: f64,
}

/// Aggregate token usage and cost over an optional time window. `from`/`to` are
/// RFC3339 timestamps (created_at is stored as RFC3339 UTC, so a lexical
/// comparison is also chronological). A `None` bound is open-ended, so passing
/// both as `None` yields the all-time total. `to` is exclusive.
#[tauri::command]
pub fn usage_summary(
    app: tauri::AppHandle,
    from: Option<String>,
    to: Option<String>,
) -> Result<UsageSummary, String> {
    let db = conn(&app)?;
    db.query_row(
        r#"
        SELECT
          COUNT(*),
          COALESCE(SUM(post_processed), 0),
          COALESCE(SUM(prompt_tokens), 0),
          COALESCE(SUM(completion_tokens), 0),
          COALESCE(SUM(reasoning_tokens), 0),
          COALESCE(SUM(total_tokens), 0),
          COALESCE(SUM(cost), 0)
        FROM history
        WHERE (?1 IS NULL OR created_at >= ?1)
          AND (?2 IS NULL OR created_at < ?2)
        "#,
        params![from, to],
        |row| {
            Ok(UsageSummary {
                count: row.get(0)?,
                post_processed_count: row.get(1)?,
                prompt_tokens: row.get(2)?,
                completion_tokens: row.get(3)?,
                reasoning_tokens: row.get(4)?,
                total_tokens: row.get(5)?,
                cost: row.get(6)?,
            })
        },
    )
    .map_err(|e| e.to_string())
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
        let id = db.query_row("SELECT id FROM dictionary WHERE term = ?1", [term], |r| {
            r.get::<_, i64>(0)
        }).map_err(|e| e.to_string())?;
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
