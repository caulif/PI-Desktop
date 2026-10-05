// Durable occurrence polling shared by wall-clock scheduling and isolated diagnostics.
use super::*;

/** Durable pending occurrences are returned on every poll until accepted. */
pub fn due(db: &Database, now: i64) -> Result<Vec<Value>> {
    let mut stmt = db.conn().prepare(
        "SELECT b.task_id,b.plugin_id,b.external_key,b.definition_revision,t.config_json,t.cadence,b.timezone
         FROM plugin_schedule_bindings b JOIN scheduled_tasks t ON t.id=b.task_id
         WHERE t.enabled=1",
    )?;
    let tasks = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for (task_id, _, _, revision, raw, cadence, timezone) in tasks {
        let mut config: Value = serde_json::from_str(&raw)?;
        let Some(scheduled_for) = config.get("nextRunAt").and_then(Value::as_i64) else {
            continue;
        };
        if scheduled_for > now {
            continue;
        }
        let schedule: scheduled::timing::Schedule =
            serde_json::from_value(config["schedule"].clone())?;
        let zone: Tz = timezone.parse()?;
        let (scheduled_for, next) = latest_due(&schedule, &cadence, &zone, scheduled_for, now)?;
        let state = if now - scheduled_for > MISSED_WINDOW_MS {
            "skipped"
        } else {
            "pending"
        };
        let occurrence_id = format!("{task_id}:{scheduled_for}");
        // Savepoints preserve per-occurrence atomicity both standalone and when
        // the isolated diagnostic wraps the complete due operation in a transaction.
        db.conn().execute_batch("SAVEPOINT plugin_due_occurrence")?;
        let saved = (|| -> Result<()> {
            db.conn().execute(
            "INSERT OR IGNORE INTO plugin_schedule_occurrences
             (occurrence_id,task_id,definition_revision,scheduled_for,state,skip_reason,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
            params![occurrence_id, task_id, revision, scheduled_for, state,
                if state == "skipped" { Some("missed") } else { None }, now],
        )?;
            config["nextRunAt"] = json!(next);
            db.conn().execute(
                "UPDATE scheduled_tasks SET config_json=?1 WHERE id=?2",
                params![config.to_string(), task_id],
            )?;
            Ok(())
        })();
        if let Err(error) = saved {
            if let Err(rollback) = db
                .conn()
                .execute_batch("ROLLBACK TO plugin_due_occurrence; RELEASE plugin_due_occurrence")
            {
                bail!("due write failed: {error}; savepoint rollback failed: {rollback}");
            }
            return Err(error);
        }
        if let Err(error) = db.conn().execute_batch("RELEASE plugin_due_occurrence") {
            if let Err(rollback) = db
                .conn()
                .execute_batch("ROLLBACK TO plugin_due_occurrence; RELEASE plugin_due_occurrence")
            {
                bail!("due commit failed: {error}; savepoint rollback failed: {rollback}");
            }
            return Err(error.into());
        }
    }
    db.conn().execute(
        "UPDATE plugin_schedule_occurrences SET state='skipped',skip_reason='deadline',updated_at=?1
         WHERE state='pending' AND created_at <= ?2",
        params![now, now - RUN_DEADLINE_MS],
    )?;
    db.conn().execute(
        "UPDATE plugin_schedule_occurrences AS old SET state='skipped',skip_reason=CASE
           WHEN old.scheduled_for < ?2 THEN 'missed' ELSE 'superseded' END,updated_at=?1
         WHERE old.state='pending' AND (old.scheduled_for < ?2 OR EXISTS (
           SELECT 1 FROM plugin_schedule_occurrences newer
           WHERE newer.task_id=old.task_id AND newer.state='pending'
             AND newer.scheduled_for>old.scheduled_for))",
        params![now, now - MISSED_WINDOW_MS],
    )?;
    let mut stmt = db.conn().prepare(
        "SELECT o.occurrence_id,b.task_id,b.plugin_id,b.external_key,o.definition_revision,o.scheduled_for
         FROM plugin_schedule_occurrences o
         JOIN plugin_schedule_bindings b ON b.task_id=o.task_id
         JOIN scheduled_tasks t ON t.id=o.task_id
         WHERE o.state='pending' AND t.enabled=1 AND b.authorization_hash IS NOT NULL
           AND (o.retry_at IS NULL OR o.retry_at<=?1)
         ORDER BY o.scheduled_for LIMIT 100",
    )?;
    let rows = stmt.query_map([now], |row| {
        Ok(json!({
            "occurrenceId": row.get::<_, String>(0)?, "schedulerTaskId": row.get::<_, String>(1)?,
            "pluginId": row.get::<_, String>(2)?, "externalKey": row.get::<_, String>(3)?,
            "definitionRevision": row.get::<_, i64>(4)?,
            "scheduledFor": ms_to_ts(row.get::<_, i64>(5)?),
        }))
    })?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
