mod timing;
use timing::latest_due;

use anyhow::{bail, Result};
use chrono_tz::Tz;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::db::{ms_to_ts, now_ms, Database};
use crate::scheduled;

const MISSED_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
const WORK_SUFFIX: &str = ". Record the outcome and file artifacts against this Work.";

fn normalized_prompt_hash(content: &str) -> Result<String> {
    let (prefix, tail) = content
        .rsplit_once("\n\nWork ID: work_")
        .ok_or_else(|| anyhow::anyhow!("scheduled prompt has no Work ID suffix"))?;
    let (work_id, suffix) = tail
        .get(..64)
        .zip(tail.get(64..))
        .ok_or_else(|| anyhow::anyhow!("scheduled prompt has an invalid Work ID"))?;
    if work_id.len() != 64
        || !work_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || suffix != WORK_SUFFIX
    {
        bail!("scheduled prompt has an invalid Work ID suffix");
    }
    let template = format!(
        "{prefix}\n\nWork ID: work_{}{}",
        "0".repeat(64),
        WORK_SUFFIX
    );
    Ok(hex::encode(Sha256::digest(template.as_bytes())))
}

fn required<'a>(input: &'a Value, field: &str) -> Result<&'a str> {
    let value = input
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if value.is_empty() || value.len() > 256 {
        bail!("{field} must be a nonempty string of at most 256 bytes");
    }
    Ok(value)
}

fn binding(db: &Database, plugin_id: &str, external_key: &str) -> Result<Option<(String, i64)>> {
    Ok(db.conn().query_row(
        "SELECT task_id, definition_revision FROM plugin_schedule_bindings WHERE plugin_id = ?1 AND external_key = ?2",
        params![plugin_id, external_key], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?)
}

fn set_enabled(db: &Database, task_id: &str, enabled: bool) -> Result<()> {
    db.conn().execute(
        "UPDATE scheduled_tasks SET enabled=?1,updated_at=?2 WHERE id=?3",
        params![enabled, now_ms(), task_id],
    )?;
    Ok(())
}

pub fn upsert(db: &Database, plugin_id: &str, input: &Value) -> Result<Value> {
    let external_key = required(input, "externalKey")?;
    let timezone = required(input, "timezone")?;
    let _: Tz = timezone
        .parse()
        .map_err(|_| anyhow::anyhow!("timezone must be a valid IANA zone"))?;
    let revision = input
        .get("definitionRevision")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if revision < 1 {
        bail!("definitionRevision must be positive");
    }
    let schedule = input
        .get("schedule")
        .filter(|value| !value.is_null())
        .ok_or_else(|| anyhow::anyhow!("schedule required"))?;
    let parsed: scheduled::timing::Schedule = serde_json::from_value(schedule.clone())?;
    parsed.validate()?;
    let cadence = required(input, "cadence")?;
    if !matches!(
        cadence,
        "hourly" | "hourly_at" | "daily" | "weekly" | "interval"
    ) {
        bail!("unsupported cadence");
    }
    if cadence == "interval" && parsed.interval_minutes.is_none() {
        bail!("interval cadence requires intervalMinutes");
    }
    let enabled = input
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let title = required(input, "title")?;
    let session_id = input.get("sessionId").and_then(Value::as_str).unwrap_or("");
    let goal_hash = input.get("goalHash").and_then(Value::as_str).unwrap_or("");
    let prompt_template_hash = input
        .get("promptTemplateHash")
        .and_then(Value::as_str)
        .unwrap_or("");
    if enabled {
        if session_id.is_empty()
            || session_id.len() > 256
            || goal_hash.len() != 64
            || !goal_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            || prompt_template_hash.len() != 64
            || !prompt_template_hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            bail!("enabled Routine requires sessionId, goalHash and promptTemplateHash");
        }
        let owner: Option<String> = db
            .conn()
            .query_row(
                "SELECT plugin_id FROM plugin_automation_sessions WHERE session_id=?1",
                [session_id],
                |row| row.get(0),
            )
            .optional()?;
        if owner.as_deref() != Some(plugin_id) {
            bail!("Routine session is not owned by plugin");
        }
    }
    let authorization_hash = hex::encode(Sha256::digest(serde_json::to_vec(&json!({
        "pluginId": plugin_id, "externalKey": external_key, "definitionRevision": revision,
        "title": title, "cadence": cadence, "schedule": schedule,
        "timezone": timezone, "sessionId": session_id, "goalHash": goal_hash,
        "promptTemplateHash": prompt_template_hash,
    }))?));
    let existing = binding(db, plugin_id, external_key)?;
    let prior_authorization: Option<(Option<String>, Option<String>, Option<String>)> = db.conn().query_row(
        "SELECT authorization_hash,authorized_session_id,goal_hash FROM plugin_schedule_bindings
         WHERE plugin_id=?1 AND external_key=?2",
        params![plugin_id, external_key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional()?;
    if let Some((task_id, old_revision)) = &existing {
        if revision < *old_revision {
            bail!("definitionRevision cannot decrease");
        }
        let current = scheduled::get_task(db, task_id)?
            .ok_or_else(|| anyhow::anyhow!("binding has no task"))?;
        if revision == *old_revision {
            let current_binding = get(db, plugin_id, external_key)?
                .ok_or_else(|| anyhow::anyhow!("binding vanished"))?;
            if current.cadence != cadence
                || current.title != title
                || serde_json::to_value(&current.schedule)? != *schedule
                || current_binding["timezone"] != timezone
            {
                bail!("same definitionRevision has different task settings");
            }
            if prior_authorization.as_ref().is_some_and(|row| {
                row.1.as_deref().is_some_and(|prior| prior != session_id)
                    || row.2.as_deref().is_some_and(|prior| prior != goal_hash)
            }) {
                bail!("same definitionRevision changed Routine target or goal");
            }
            if enabled
                && !input
                    .get("nativeAuthorized")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                && (prior_authorization
                    .as_ref()
                    .and_then(|row| row.0.as_deref())
                    != Some(authorization_hash.as_str())
                    || !current.enabled)
            {
                return Ok(json!({ "consentRequired": true }));
            }
            if current.enabled != enabled {
                set_enabled(db, task_id, enabled)?;
            }
            if enabled {
                db.conn().execute(
                    "UPDATE plugin_schedule_bindings SET authorization_hash=?1,
                    authorized_session_id=?2,goal_hash=?3,prompt_template_hash=?4 WHERE task_id=?5",
                    params![
                        authorization_hash,
                        session_id,
                        goal_hash,
                        prompt_template_hash,
                        task_id
                    ],
                )?;
            } else {
                db.conn().execute(
                    "UPDATE plugin_schedule_bindings SET authorization_hash=NULL,
                    authorized_session_id=NULL,goal_hash=NULL,prompt_template_hash=NULL WHERE task_id=?1",
                    [task_id],
                )?;
            }
            return get(db, plugin_id, external_key)?
                .ok_or_else(|| anyhow::anyhow!("binding vanished"));
        }
    }
    if enabled
        && !input
            .get("nativeAuthorized")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return Ok(json!({ "consentRequired": true }));
    }
    let tx = db.conn().unchecked_transaction()?;
    let task = if let Some((task_id, _)) = existing {
        scheduled::update_task(
            db,
            &json!({
                "id": task_id, "title": title, "cadence": cadence,
                "schedule": schedule, "enabled": enabled,
            }),
        )?
        .ok_or_else(|| anyhow::anyhow!("binding has no task"))?
    } else {
        scheduled::create_task(
            db,
            &json!({
                "title": title, "prompt": format!("Plugin schedule {external_key}"),
                "cadence": cadence, "schedule": schedule, "enabled": enabled,
            }),
        )?
    };
    let now = now_ms();
    tx.execute(
        "INSERT INTO plugin_schedule_bindings (task_id,plugin_id,external_key,definition_revision,timezone,authorization_hash,authorized_session_id,goal_hash,prompt_template_hash,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)
         ON CONFLICT(task_id) DO UPDATE SET definition_revision=excluded.definition_revision,
           timezone=excluded.timezone, authorization_hash=excluded.authorization_hash,
           authorized_session_id=excluded.authorized_session_id,goal_hash=excluded.goal_hash,
           prompt_template_hash=excluded.prompt_template_hash,updated_at=excluded.updated_at",
        params![task.id, plugin_id, external_key, revision, timezone,
            if enabled { Some(authorization_hash) } else { None },
            if enabled { Some(session_id) } else { None },
            if enabled { Some(goal_hash) } else { None },
            if enabled { Some(prompt_template_hash) } else { None }, now],
    )?;
    scheduled::automation::reschedule(db, &task.id, now)?;
    tx.commit()?;
    get(db, plugin_id, external_key)?.ok_or_else(|| anyhow::anyhow!("binding vanished"))
}

pub fn get(db: &Database, plugin_id: &str, external_key: &str) -> Result<Option<Value>> {
    let row: Option<(String, i64, String)> = db.conn().query_row(
        "SELECT task_id, definition_revision, timezone FROM plugin_schedule_bindings WHERE plugin_id=?1 AND external_key=?2",
        params![plugin_id, external_key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional()?;
    let Some((task_id, revision, timezone)) = row else {
        return Ok(None);
    };
    let task = scheduled::get_task(db, &task_id)?;
    let mut stmt = db.conn().prepare(
        "SELECT occurrence_id, scheduled_for, definition_revision, state, skip_reason, retry_count, retry_at
         FROM plugin_schedule_occurrences WHERE task_id=?1 ORDER BY scheduled_for DESC LIMIT 100",
    )?;
    let runs = stmt
        .query_map([&task_id], |row| {
            let scheduled_for: i64 = row.get(1)?;
            Ok(json!({
                "occurrenceId": row.get::<_, String>(0)?, "scheduledFor": ms_to_ts(scheduled_for),
                "definitionRevision": row.get::<_, i64>(2)?, "state": row.get::<_, String>(3)?,
                "skipReason": row.get::<_, Option<String>>(4)?,
                "retryCount": row.get::<_, i64>(5)?,
                "retryAt": row.get::<_, Option<i64>>(6)?.map(ms_to_ts),
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(json!({
        "schedulerTaskId": task_id, "externalKey": external_key,
        "definitionRevision": revision, "timezone": timezone, "task": task, "occurrences": runs,
    })))
}

pub fn disable(db: &Database, plugin_id: &str, external_key: &str) -> Result<Value> {
    let Some((task_id, _)) = binding(db, plugin_id, external_key)? else {
        return Ok(json!({ "disabled": false }));
    };
    set_enabled(db, &task_id, false)?;
    db.conn().execute(
        "UPDATE plugin_schedule_bindings SET authorization_hash=NULL,
        authorized_session_id=NULL,goal_hash=NULL,prompt_template_hash=NULL WHERE task_id=?1",
        [&task_id],
    )?;
    Ok(json!({ "disabled": true, "schedulerTaskId": task_id }))
}

pub fn disable_all(db: &Database, plugin_id: &str) -> Result<usize> {
    let task_ids = db
        .conn()
        .prepare("SELECT task_id FROM plugin_schedule_bindings WHERE plugin_id=?1")?
        .query_map([plugin_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut count = 0;
    for task_id in task_ids {
        set_enabled(db, &task_id, false)?;
        db.conn().execute(
            "UPDATE plugin_schedule_bindings SET authorization_hash=NULL,
            authorized_session_id=NULL,goal_hash=NULL,prompt_template_hash=NULL WHERE task_id=?1",
            [&task_id],
        )?;
        count += 1;
    }
    Ok(count)
}

pub fn accept_occurrence(db: &Database, plugin_id: &str, input: &Value) -> Result<Value> {
    let occurrence_id = required(input, "occurrenceId")?;
    let task_id = required(input, "schedulerTaskId")?;
    let revision = input
        .get("definitionRevision")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow::anyhow!("definitionRevision required"))?;
    let scheduled_for = required(input, "scheduledFor")?;
    let scheduled_for_ms = chrono::DateTime::parse_from_rfc3339(scheduled_for)?.timestamp_millis();
    let changed = db.conn().execute(
        "UPDATE plugin_schedule_occurrences SET state='accepted',updated_at=?1
         WHERE occurrence_id=?2 AND task_id=?3 AND definition_revision=?4
           AND scheduled_for=?5 AND state='pending'
           AND EXISTS (SELECT 1 FROM plugin_schedule_bindings b
                       JOIN scheduled_tasks t ON t.id=b.task_id
                       WHERE b.task_id=?3 AND b.plugin_id=?6 AND t.enabled=1
                         AND b.authorization_hash IS NOT NULL)",
        params![
            now_ms(),
            occurrence_id,
            task_id,
            revision,
            scheduled_for_ms,
            plugin_id
        ],
    )?;
    let state: Option<String> = db
        .conn()
        .query_row(
            "SELECT o.state FROM plugin_schedule_occurrences o
         JOIN plugin_schedule_bindings b ON b.task_id=o.task_id
         WHERE o.occurrence_id=?1 AND o.task_id=?2 AND o.definition_revision=?3
           AND o.scheduled_for=?4 AND b.plugin_id=?5",
            params![
                occurrence_id,
                task_id,
                revision,
                scheduled_for_ms,
                plugin_id
            ],
            |row| row.get(0),
        )
        .optional()?;
    if state.is_none() {
        bail!("occurrence is not owned by plugin or trigger changed");
    }
    Ok(json!({ "accepted": changed == 1, "state": state.unwrap() }))
}

pub fn register_created_session(db: &Database, plugin_id: &str, session_id: &str) -> Result<()> {
    if session_id.trim().is_empty() {
        bail!("sessionId required");
    }
    let exists: bool = db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND deleted_at IS NULL)",
        [session_id],
        |row| row.get(0),
    )?;
    if !exists {
        bail!("created session missing");
    }
    let tx = db.conn().unchecked_transaction()?;
    tx.execute(
        "INSERT OR IGNORE INTO plugin_automation_sessions(session_id,plugin_id,created_at) VALUES(?1,?2,?3)",
        params![session_id, plugin_id, now_ms()],
    )?;
    let owner: String = tx.query_row(
        "SELECT plugin_id FROM plugin_automation_sessions WHERE session_id=?1",
        [session_id],
        |row| row.get(0),
    )?;
    if owner != plugin_id {
        bail!("session belongs to another plugin");
    }
    if plugin_id == "local.pi-bot" {
        tx.execute(
            "UPDATE sessions SET tool_policy='plugin-bot-scoped' WHERE id=?1 AND tool_policy!='plugin-bot-scoped'",
            [session_id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn session_ownership(db: &Database, plugin_id: &str, session_id: &str) -> Result<Value> {
    if session_id.trim().is_empty() || session_id.len() > 256 {
        bail!("sessionId required");
    }
    let exists: bool = db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND deleted_at IS NULL)",
        [session_id],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(json!({ "state": "missing" }));
    }
    let owner: Option<String> = db
        .conn()
        .query_row(
            "SELECT plugin_id FROM plugin_automation_sessions WHERE session_id=?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(json!({ "state": match owner {
        Some(owner) if owner == plugin_id => "own",
        Some(_) => "other",
        None => "unowned",
    }}))
}

pub fn skip_occurrence(db: &Database, plugin_id: &str, input: &Value) -> Result<Value> {
    let occurrence_id = required(input, "occurrenceId")?;
    let task_id = required(input, "schedulerTaskId")?;
    let scheduled_for = required(input, "scheduledFor")?;
    let scheduled_for_ms = chrono::DateTime::parse_from_rfc3339(scheduled_for)?.timestamp_millis();
    let revision = input
        .get("definitionRevision")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow::anyhow!("definitionRevision required"))?;
    let reason = required(input, "reason")?;
    if !matches!(
        reason,
        "overlap" | "no_data" | "stale_definition" | "owner_unavailable"
    ) {
        bail!("unsupported skip reason");
    }
    let row: Option<String> = db
        .conn()
        .query_row(
            "SELECT o.state FROM plugin_schedule_occurrences o
         JOIN plugin_schedule_bindings b ON b.task_id=o.task_id
         WHERE o.occurrence_id=?1 AND o.task_id=?2 AND o.scheduled_for=?3
           AND o.definition_revision=?4 AND b.plugin_id=?5",
            params![
                occurrence_id,
                task_id,
                scheduled_for_ms,
                revision,
                plugin_id
            ],
            |row| row.get(0),
        )
        .optional()?;
    let Some(state) = row else {
        bail!("occurrence missing or not owned by plugin");
    };
    if state == "accepted" {
        bail!("accepted occurrence cannot be skipped");
    }
    if state == "pending" {
        db.conn().execute(
            "UPDATE plugin_schedule_occurrences SET state='skipped',skip_reason=?1,updated_at=?2 WHERE occurrence_id=?3 AND state='pending'",
            params![reason, now_ms(), occurrence_id],
        )?;
    }
    Ok(json!({ "skipped": true, "reason": reason, "occurrenceId": occurrence_id }))
}

const RUN_DEADLINE_MS: i64 = 15 * 60 * 1000;

pub fn retry_occurrence(db: &Database, plugin_id: &str, input: &Value, now: i64) -> Result<Value> {
    let occurrence_id = required(input, "occurrenceId")?;
    let task_id = required(input, "schedulerTaskId")?;
    let intent_id = required(input, "requestIntentId")?;
    let scheduled_for =
        chrono::DateTime::parse_from_rfc3339(required(input, "scheduledFor")?)?.timestamp_millis();
    let revision = input
        .get("definitionRevision")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow::anyhow!("definitionRevision required"))?;
    let reason = required(input, "reason")?;
    if !matches!(reason, "owner_busy" | "transient_rejection") {
        bail!("unsupported retry reason");
    }
    let tx = db.conn().unchecked_transaction()?;
    let prior: Option<(String, String, String, String, String, i64, i64)> = tx.query_row(
        "SELECT r.occurrence_id,r.reason,r.response_json,b.plugin_id,o.task_id,o.scheduled_for,o.definition_revision
         FROM plugin_schedule_retries r
         JOIN plugin_schedule_occurrences o ON o.occurrence_id=r.occurrence_id
         JOIN plugin_schedule_bindings b ON b.task_id=o.task_id
         WHERE r.request_intent_id=?1",
        [intent_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?,
            row.get(4)?, row.get(5)?, row.get(6)?)),
    ).optional()?;
    if let Some((
        prior_occurrence,
        prior_reason,
        response,
        owner,
        prior_task,
        prior_for,
        prior_revision,
    )) = prior
    {
        if owner != plugin_id
            || prior_task != task_id
            || prior_for != scheduled_for
            || prior_revision != revision
            || prior_occurrence != occurrence_id
            || prior_reason != reason
        {
            bail!("retry intent conflicts with its prior request");
        }
        return Ok(serde_json::from_str(&response)?);
    }
    let row: Option<(String, i64, i64)> = tx
        .query_row(
            "SELECT o.state,o.created_at,o.retry_count FROM plugin_schedule_occurrences o
         JOIN plugin_schedule_bindings b ON b.task_id=o.task_id
         JOIN scheduled_tasks t ON t.id=o.task_id
         WHERE o.occurrence_id=?1 AND o.task_id=?2 AND o.scheduled_for=?3
           AND o.definition_revision=?4 AND b.plugin_id=?5 AND t.enabled=1",
            params![occurrence_id, task_id, scheduled_for, revision, plugin_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((state, created_at, retry_count)) = row else {
        bail!("occurrence missing, changed, disabled, or not owned by plugin");
    };
    if state != "pending" {
        bail!("only pending occurrences can be retried");
    }
    let live_intents: i64 = tx.query_row(
        "SELECT COUNT(*) FROM plugin_automation_intents
         WHERE occurrence_id=?1 AND state IN ('requested','accepted','unknown')",
        [occurrence_id],
        |row| row.get(0),
    )?;
    if live_intents != 0 {
        bail!("occurrence has an unresolved start intent");
    }
    if reason == "owner_busy" {
        let last_rejection: Option<Option<String>> = tx
            .query_row(
                "SELECT rejection_code FROM plugin_automation_intents
             WHERE occurrence_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT 1",
                [occurrence_id],
                |row| row.get(0),
            )
            .optional()?;
        if last_rejection.is_some() && last_rejection.flatten().as_deref() != Some("AGENT_BUSY") {
            bail!("busy defer requires a confirmed busy rejection or no start attempt");
        }
    }
    if reason == "transient_rejection" {
        let rejected: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT state,rejection_code FROM plugin_automation_intents
             WHERE request_intent_id=?1 AND occurrence_id=?2 AND plugin_id=?3",
                params![intent_id, occurrence_id, plugin_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if rejected
            .as_ref()
            .map(|(state, code)| (state.as_str(), code.as_deref()))
            != Some(("rejected", Some("TRANSIENT")))
        {
            bail!("transient retry requires a confirmed transient rejection");
        }
    }
    let deadline = created_at + RUN_DEADLINE_MS;
    let next_count = retry_count + i64::from(reason == "transient_rejection" && retry_count < 2);
    let delay = if reason == "owner_busy" || retry_count == 0 {
        30_000
    } else {
        120_000
    };
    let skip_reason = if now >= deadline || now + delay >= deadline {
        Some("deadline")
    } else if reason == "transient_rejection" && retry_count >= 2 {
        Some("retry_exhausted")
    } else {
        None
    };
    let response = if let Some(skip_reason) = skip_reason {
        tx.execute(
            "UPDATE plugin_schedule_occurrences SET state='skipped',skip_reason=?1,updated_at=?2
             WHERE occurrence_id=?3 AND state='pending'",
            params![skip_reason, now, occurrence_id],
        )?;
        json!({ "state": "skipped", "reason": skip_reason, "retryAt": null,
            "retryCount": retry_count, "deadlineAt": ms_to_ts(deadline) })
    } else {
        let retry_at = now + delay;
        tx.execute(
            "UPDATE plugin_schedule_occurrences SET retry_count=?1,retry_at=?2,updated_at=?3
             WHERE occurrence_id=?4 AND state='pending'",
            params![next_count, retry_at, now, occurrence_id],
        )?;
        json!({ "state": "deferred", "retryAt": ms_to_ts(retry_at),
            "retryCount": next_count, "deadlineAt": ms_to_ts(deadline) })
    };
    tx.execute(
        "INSERT INTO plugin_schedule_retries(request_intent_id,occurrence_id,reason,response_json,created_at)
         VALUES(?1,?2,?3,?4,?5)",
        params![intent_id, occurrence_id, reason, response.to_string(), now],
    )?;
    tx.commit()?;
    Ok(response)
}

pub fn prepare_start(db: &Database, plugin_id: &str, input: &Value) -> Result<Value> {
    let intent_id = required(input, "requestIntentId")?;
    let session_id = required(input, "sessionId")?;
    let content = input.get("content").and_then(Value::as_str).unwrap_or("");
    if content.trim().is_empty() || content.len() > 1_000_000 {
        bail!("content is empty or too large");
    }
    let trigger = input
        .get("trigger")
        .ok_or_else(|| anyhow::anyhow!("trigger required"))?;
    let owner: Option<String> = db.conn().query_row(
        "SELECT a.plugin_id FROM plugin_automation_sessions a JOIN sessions s ON s.id=a.session_id
         WHERE a.session_id=?1 AND s.deleted_at IS NULL",
        [session_id], |row| row.get(0),
    ).optional()?;
    if owner.as_deref() != Some(plugin_id) {
        bail!("plugin does not own the session");
    }
    let (occurrence_id, trigger_key, trigger_state) =
        match trigger.get("kind").and_then(Value::as_str) {
            Some("schedule") => {
                let occurrence_id = required(trigger, "occurrenceId")?;
                let task_id = required(trigger, "schedulerTaskId")?;
                let scheduled_for = required(trigger, "scheduledFor")?;
                let scheduled_for_ms =
                    chrono::DateTime::parse_from_rfc3339(scheduled_for)?.timestamp_millis();
                let occurrence: Option<(String, i64)> = db
                    .conn()
                    .query_row(
                        "SELECT o.state,o.definition_revision FROM plugin_schedule_occurrences o
                 JOIN plugin_schedule_bindings b ON b.task_id=o.task_id
                 JOIN scheduled_tasks t ON t.id=o.task_id
                 WHERE o.occurrence_id=?1 AND o.task_id=?2 AND o.scheduled_for=?3
                   AND b.plugin_id=?4 AND t.enabled=1 AND b.authorization_hash IS NOT NULL
                   AND b.authorized_session_id=?5 AND b.external_key=?6",
                        params![
                            occurrence_id,
                            task_id,
                            scheduled_for_ms,
                            plugin_id,
                            session_id,
                            required(input, "routineId")?
                        ],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                let Some((state, revision)) = occurrence else {
                    bail!("occurrence missing or not owned by plugin");
                };
                let binding_revision: i64 = db.conn().query_row(
                    "SELECT definition_revision FROM plugin_schedule_bindings WHERE task_id=?1",
                    [task_id],
                    |row| row.get(0),
                )?;
                if revision != binding_revision {
                    bail!("occurrence definition is stale");
                }
                if state != "pending" && state != "accepted" {
                    bail!("occurrence cannot start");
                }
                let template_hash: Option<String> = db.conn().query_row(
                    "SELECT prompt_template_hash FROM plugin_schedule_bindings WHERE task_id=?1",
                    [task_id],
                    |row| row.get(0),
                )?;
                if template_hash.as_deref() != Some(normalized_prompt_hash(content)?.as_str()) {
                    bail!("scheduled prompt differs from authorized template");
                }
                (
                    Some(occurrence_id.to_owned()),
                    format!("schedule:{occurrence_id}"),
                    state,
                )
            }
            Some("manual") => {
                if input.get("manualAuthorized").and_then(Value::as_bool) != Some(true) {
                    bail!("manual start requires native user authorization");
                }
                let routine_id = required(input, "routineId")?;
                let request_id = required(trigger, "requestIntentId")?;
                (
                    None,
                    format!("manual:{plugin_id}:{routine_id}:{request_id}"),
                    "pending".to_owned(),
                )
            }
            _ => bail!("unsupported Routine trigger"),
        };
    let hash = hex::encode(Sha256::digest(content.as_bytes()));
    let prior: Option<(
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
    )> = db
        .conn()
        .query_row(
            "SELECT plugin_id,session_id,trigger_key,content_hash,state,turn_id,rejection_code
         FROM plugin_automation_intents WHERE request_intent_id=?1",
            [intent_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    if let Some((
        prior_owner,
        prior_session,
        prior_trigger,
        prior_hash,
        state,
        turn_id,
        rejection_code,
    )) = prior
    {
        if prior_owner != plugin_id
            || prior_session != session_id
            || prior_trigger != trigger_key
            || prior_hash != hash
        {
            bail!("request intent conflicts with existing launch");
        }
        return Ok(json!({ "start": false,
            "kind": if state == "accepted" { "accepted" } else if state == "rejected" { "rejected" } else { "unknown" },
            "turnId": turn_id, "code": rejection_code }));
    }
    if trigger_state != "pending" {
        bail!("occurrence already accepted by another request");
    }
    if occurrence_id.is_none() {
        let manual_duplicate: bool = db.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM plugin_automation_intents WHERE trigger_key=?1)",
            [&trigger_key],
            |row| row.get(0),
        )?;
        if manual_duplicate {
            bail!("manual trigger already started under another intent");
        }
    }
    if let Some(occurrence_id) = occurrence_id.as_deref() {
        let (retry_at, retry_count): (Option<i64>, i64) = db.conn().query_row(
            "SELECT retry_at,retry_count FROM plugin_schedule_occurrences WHERE occurrence_id=?1",
            [occurrence_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if retry_at.is_some_and(|at| at > now_ms()) {
            bail!("occurrence is deferred until its retry time");
        }
        let (live, rejected): (i64, i64) = db.conn().query_row(
            "SELECT COUNT(*) FILTER (WHERE state IN ('requested','accepted','unknown')),
                    COUNT(*) FILTER (WHERE state='rejected')
             FROM plugin_automation_intents WHERE occurrence_id=?1",
            [occurrence_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if live != 0 {
            bail!("occurrence has an unresolved start intent");
        }
        if rejected != 0 && retry_count == 0 {
            bail!("rejected occurrence has no scheduled retry");
        }
    }
    let now = now_ms();
    db.conn().execute(
        "INSERT INTO plugin_automation_intents
         (request_intent_id,plugin_id,session_id,occurrence_id,trigger_key,content_hash,state,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,'requested',?7,?7)",
        params![intent_id, plugin_id, session_id, occurrence_id, trigger_key, hash, now],
    )?;
    Ok(json!({ "start": true, "kind": "requested" }))
}

pub fn record_start(
    db: &Database,
    plugin_id: &str,
    intent_id: &str,
    turn_id: Option<&str>,
) -> Result<Value> {
    let tx = db.conn().unchecked_transaction()?;
    let occurrence_id: Option<String> = tx.query_row(
        "SELECT occurrence_id FROM plugin_automation_intents WHERE request_intent_id=?1 AND plugin_id=?2",
        params![intent_id, plugin_id], |row| row.get(0),
    )?;
    let state = if turn_id.is_some() {
        "accepted"
    } else {
        "unknown"
    };
    tx.execute(
        "UPDATE plugin_automation_intents SET state=?1,turn_id=?2,updated_at=?3
         WHERE request_intent_id=?4 AND plugin_id=?5 AND state='requested'",
        params![state, turn_id, now_ms(), intent_id, plugin_id],
    )?;
    if turn_id.is_some() && occurrence_id.is_some() {
        tx.execute(
            "UPDATE plugin_schedule_occurrences SET state='accepted',updated_at=?1 WHERE occurrence_id=?2 AND state='pending'",
            params![now_ms(), occurrence_id],
        )?;
    }
    tx.commit()?;
    lookup_start(db, plugin_id, intent_id)
}

pub fn record_rejection(
    db: &Database,
    plugin_id: &str,
    intent_id: &str,
    code: &str,
) -> Result<Value> {
    if !matches!(code, "AGENT_BUSY" | "AGENT_REJECTED" | "TRANSIENT") {
        bail!("unsupported admission rejection code");
    }
    let changed = db.conn().execute(
        "UPDATE plugin_automation_intents SET state='rejected',rejection_code=?1,updated_at=?2
         WHERE request_intent_id=?3 AND plugin_id=?4 AND state='requested'",
        params![code, now_ms(), intent_id, plugin_id],
    )?;
    if changed == 0 {
        let prior = lookup_start(db, plugin_id, intent_id)?;
        if prior["kind"] != "rejected" || prior["code"] != code {
            bail!("start intent cannot be recorded as rejected");
        }
    }
    lookup_start(db, plugin_id, intent_id)
}

pub fn lookup_start(db: &Database, plugin_id: &str, intent_id: &str) -> Result<Value> {
    let row: Option<(String, Option<String>, Option<String>)> = db.conn().query_row(
        "SELECT state,turn_id,rejection_code FROM plugin_automation_intents WHERE plugin_id=?1 AND request_intent_id=?2",
        params![plugin_id, intent_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional()?;
    Ok(match row {
        None => json!({ "kind": "not_started" }),
        Some((state, Some(turn_id), _)) if state == "accepted" => {
            json!({ "kind": "accepted", "turnId": turn_id })
        }
        Some((state, _, code)) if state == "rejected" => {
            json!({ "kind": "rejected", "code": code })
        }
        _ => json!({ "kind": "unknown" }),
    })
}

pub fn is_plugin_task(db: &Database, task_id: &str) -> Result<bool> {
    Ok(db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM plugin_schedule_bindings WHERE task_id=?1)",
        [task_id],
        |row| row.get(0),
    )?)
}

pub fn timezone_for_task(db: &Database, task_id: &str) -> Result<Option<Tz>> {
    let name: Option<String> = db
        .conn()
        .query_row(
            "SELECT timezone FROM plugin_schedule_bindings WHERE task_id=?1",
            [task_id],
            |row| row.get(0),
        )
        .optional()?;
    name.map(|value| {
        value
            .parse()
            .map_err(|_| anyhow::anyhow!("stored plugin timezone is invalid"))
    })
    .transpose()
}

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
        let tx = db.conn().unchecked_transaction()?;
        tx.execute(
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
        tx.commit()?;
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

#[cfg(test)]
#[path = "plugin_scheduled/tests.rs"]
mod tests;
