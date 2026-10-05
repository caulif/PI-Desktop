use super::*;

pub(crate) fn migrate_v21_to_v22(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 21)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS plugin_schedule_bindings (
           task_id TEXT PRIMARY KEY REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
           plugin_id TEXT NOT NULL,
           external_key TEXT NOT NULL,
           definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
           timezone TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           UNIQUE(plugin_id, external_key)
         );
         CREATE TABLE IF NOT EXISTS plugin_schedule_occurrences (
           occurrence_id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
           definition_revision INTEGER NOT NULL,
           scheduled_for INTEGER NOT NULL,
           state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'skipped')),
           skip_reason TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           UNIQUE(task_id, scheduled_for)
         );
         CREATE INDEX IF NOT EXISTS idx_plugin_schedule_pending ON plugin_schedule_occurrences(state, scheduled_for);
         CREATE TABLE IF NOT EXISTS plugin_automation_sessions (
           session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
           plugin_id TEXT NOT NULL,
           created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS plugin_automation_intents (
           request_intent_id TEXT PRIMARY KEY,
           plugin_id TEXT NOT NULL,
           session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
           occurrence_id TEXT REFERENCES plugin_schedule_occurrences(occurrence_id),
           trigger_key TEXT NOT NULL UNIQUE,
           content_hash TEXT NOT NULL,
           state TEXT NOT NULL CHECK (state IN ('requested', 'accepted', 'unknown')),
           turn_id TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           UNIQUE(occurrence_id)
         );",
    )?;
    tx.pragma_update(None, "user_version", 22i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v21 to v22 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

pub(crate) fn migrate_v22_to_v23(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 22)?;
    let tx = conn.unchecked_transaction()?;
    let column_exists = |table: &str, name: &str| -> Result<bool> {
        let mut stmt = tx.prepare(&format!("PRAGMA table_info({table})"))?;
        let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
        Ok(columns
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|column| column == name))
    };
    let retry_count = column_exists("plugin_schedule_occurrences", "retry_count")?;
    let retry_at = column_exists("plugin_schedule_occurrences", "retry_at")?;
    let rejection_code = column_exists("plugin_automation_intents", "rejection_code")?;
    let retries_table: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'plugin_schedule_retries')",
        [], |row| row.get(0),
    )?;
    if retry_count || retry_at || rejection_code || retries_table {
        if !(retry_count && retry_at && rejection_code && retries_table) {
            return Err(anyhow!("incomplete plugin schedule retry schema"));
        }
    } else {
        tx.execute_batch(
        "ALTER TABLE plugin_schedule_occurrences ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE plugin_schedule_occurrences ADD COLUMN retry_at INTEGER;
         CREATE TABLE plugin_schedule_retries (
           request_intent_id TEXT PRIMARY KEY,
           occurrence_id TEXT NOT NULL REFERENCES plugin_schedule_occurrences(occurrence_id) ON DELETE CASCADE,
           reason TEXT NOT NULL,
           response_json TEXT NOT NULL,
           created_at INTEGER NOT NULL
         );
         CREATE TABLE plugin_automation_intents_v21 (
           request_intent_id TEXT PRIMARY KEY,
           plugin_id TEXT NOT NULL,
           session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
           occurrence_id TEXT REFERENCES plugin_schedule_occurrences(occurrence_id),
           trigger_key TEXT NOT NULL,
           content_hash TEXT NOT NULL,
           state TEXT NOT NULL CHECK (state IN ('requested', 'accepted', 'rejected', 'unknown')),
           rejection_code TEXT,
           turn_id TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         INSERT INTO plugin_automation_intents_v21
           (request_intent_id,plugin_id,session_id,occurrence_id,trigger_key,content_hash,state,turn_id,created_at,updated_at)
           SELECT request_intent_id,plugin_id,session_id,occurrence_id,trigger_key,content_hash,state,turn_id,created_at,updated_at
           FROM plugin_automation_intents;
         DROP TABLE plugin_automation_intents;
         ALTER TABLE plugin_automation_intents_v21 RENAME TO plugin_automation_intents;",
        )?;
    }
    tx.pragma_update(None, "user_version", 23i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v22 to v23 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
