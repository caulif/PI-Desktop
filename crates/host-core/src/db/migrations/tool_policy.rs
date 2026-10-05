use super::*;

pub(crate) fn migrate_v24_to_v25(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 24)?;
    let tx = conn.unchecked_transaction()?;
    // Development schemas 20-23 predate upstream voice/Todo migration numbering.
    // Apply their idempotent column/table migrations before stamping the combined schema.
    migrate_v19_to_v20_tx(&tx)?;
    migrate_v20_to_v21_tx(&tx)?;
    let has_policy: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name='tool_policy')",
        [],
        |row| row.get(0),
    )?;
    if !has_policy {
        tx.execute_batch(
            "ALTER TABLE sessions ADD COLUMN tool_policy TEXT NOT NULL DEFAULT 'unrestricted'
             CHECK (tool_policy IN ('unrestricted', 'plugin-bot-scoped'));",
        )?;
    }
    let invalid_policy: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE tool_policy IS NULL
         OR tool_policy NOT IN ('unrestricted', 'plugin-bot-scoped'))",
        [],
        |row| row.get(0),
    )?;
    if invalid_policy {
        return Err(anyhow!("invalid persisted session tool policy"));
    }
    tx.execute_batch(
        "UPDATE sessions SET tool_policy='plugin-bot-scoped' WHERE id IN
         (SELECT session_id FROM plugin_automation_sessions WHERE plugin_id='local.pi-bot');",
    )?;
    tx.pragma_update(None, "user_version", 25i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v22 to v23 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
