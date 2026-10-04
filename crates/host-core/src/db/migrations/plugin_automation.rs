use super::*;

pub(crate) fn migrate_v21_to_v22(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 21)?;
    let tx = conn.unchecked_transaction()?;
    let columns = tx
        .prepare("PRAGMA table_info(plugin_schedule_bindings)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let authorization_columns = [
        "authorization_hash",
        "authorized_session_id",
        "goal_hash",
        "prompt_template_hash",
    ]
    .iter()
    .filter(|name| columns.iter().any(|column| column == **name))
    .count();
    if authorization_columns != 0 && authorization_columns != 4 {
        return Err(anyhow!("incomplete plugin schedule authorization schema"));
    }
    if authorization_columns == 0 {
        tx.execute_batch(
            "ALTER TABLE plugin_schedule_bindings ADD COLUMN authorization_hash TEXT;
             ALTER TABLE plugin_schedule_bindings ADD COLUMN authorized_session_id TEXT;
             ALTER TABLE plugin_schedule_bindings ADD COLUMN goal_hash TEXT;
             ALTER TABLE plugin_schedule_bindings ADD COLUMN prompt_template_hash TEXT;
             UPDATE scheduled_tasks SET enabled=0 WHERE id IN (SELECT task_id FROM plugin_schedule_bindings);",
        )?;
    }
    tx.pragma_update(None, "user_version", 22i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v21 to v22 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
