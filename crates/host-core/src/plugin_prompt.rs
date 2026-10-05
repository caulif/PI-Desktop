//! Durable admission ledger for plugin-initiated ordinary prompts.

use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::db::{now_ms, Database};

const NAMESPACE: &str = "plugin_prompt_intent";

fn key(plugin_id: &str, intent_id: &str) -> Result<String> {
    if plugin_id.is_empty()
        || plugin_id.len() > 256
        || intent_id.is_empty()
        || intent_id.len() > 256
    {
        bail!("pluginId and requestIntentId must be nonempty and at most 256 bytes");
    }
    Ok(json!([plugin_id, intent_id]).to_string())
}

pub fn lookup(db: &Database, plugin_id: &str, intent_id: &str) -> Result<Value> {
    let key = key(plugin_id, intent_id)?;
    let Some(record) = db.kv_get(NAMESPACE, &key)? else {
        return Ok(json!({ "status": "not_started", "turnId": null, "sessionId": null }));
    };
    let turn_status: Option<String> = match record["turnId"].as_str() {
        Some(turn_id) => db
            .conn()
            .query_row(
                "SELECT status FROM turns WHERE id=?1 AND session_id=?2",
                params![turn_id, record["sessionId"].as_str()],
                |row| row.get(0),
            )
            .optional()?,
        None => None,
    };
    Ok(
        json!({ "status": record["status"], "turnId": record["turnId"],
        "sessionId": record["sessionId"], "code": record["code"],
        "turnStatus": turn_status }),
    )
}

pub fn prepare(
    db: &Database,
    plugin_id: &str,
    intent_id: &str,
    session_id: &str,
    content_hash: &str,
    process_epoch: Option<&str>,
) -> Result<Value> {
    let tx = db.conn().unchecked_transaction()?;
    let result = prepare_inner(
        db,
        plugin_id,
        intent_id,
        session_id,
        content_hash,
        process_epoch,
    );
    if result.is_ok() {
        tx.commit()?;
    }
    result
}

fn prepare_inner(
    db: &Database,
    plugin_id: &str,
    intent_id: &str,
    session_id: &str,
    content_hash: &str,
    process_epoch: Option<&str>,
) -> Result<Value> {
    let key = key(plugin_id, intent_id)?;
    if session_id.is_empty()
        || session_id.len() > 256
        || content_hash.len() != 64
        || !content_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        bail!("invalid prompt session or content hash");
    }
    if process_epoch.is_some_and(|epoch| epoch.is_empty() || epoch.len() > 256) {
        bail!("invalid process epoch");
    }
    let live: bool = db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND deleted_at IS NULL)",
        [session_id],
        |r| r.get(0),
    )?;
    if !live {
        bail!("session not found");
    }
    let owner: Option<String> = db
        .conn()
        .query_row(
            "SELECT plugin_id FROM plugin_automation_sessions WHERE session_id=?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()?;
    if owner.as_deref().is_some_and(|owner| owner != plugin_id) {
        bail!("PERMISSION_DENIED: session belongs to another plugin");
    }
    if let Some(mut record) = db.kv_get(NAMESPACE, &key)? {
        if record["code"] == "STALE_REQUEST" {
            return Ok(
                json!({ "start": false, "status": "rejected", "turnId": null,
                "code": "STALE_REQUEST" }),
            );
        }
        if record["sessionId"] != session_id || record["contentHash"] != content_hash {
            bail!("IDEMPOTENCY_CONFLICT");
        }
        // Legacy unknown intents have no claim and may already have executed.
        // Only v2 claims can be revoked before a turn or reclaimed by a new process.
        if record["turnId"].is_null()
            && record["status"] == "unknown"
            && process_epoch.is_some()
            && record["claimId"].as_str().is_some_and(|id| !id.is_empty())
            && record["processEpoch"]
                .as_str()
                .is_some_and(|epoch| !epoch.is_empty())
            && (record["processEpoch"] != process_epoch.unwrap() || record["released"] == true)
        {
            let claim_id = Uuid::new_v4().to_string();
            record["processEpoch"] = json!(process_epoch);
            record["claimId"] = json!(claim_id);
            record["released"] = json!(false);
            db.kv_set(NAMESPACE, &key, &record)?;
            return Ok(json!({ "start": true, "status": "unknown", "turnId": null,
                "claimId": claim_id }));
        }
        let mut result = lookup(db, plugin_id, intent_id)?;
        result["start"] = json!(false);
        return Ok(result);
    }
    let exists: bool = db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND deleted_at IS NULL)",
        [session_id],
        |row| row.get(0),
    )?;
    if !exists {
        bail!("session not found");
    }
    let claim_id = Uuid::new_v4().to_string();
    db.kv_set(
        NAMESPACE,
        &key,
        &json!({ "sessionId": session_id,
        "contentHash": content_hash, "status": "unknown", "turnId": null,
        "code": null, "claimId": claim_id, "processEpoch": process_epoch,
        "released": false }),
    )?;
    Ok(json!({ "start": true, "status": "unknown", "turnId": null,
        "claimId": claim_id }))
}

pub fn release_claim(
    db: &Database,
    plugin_id: &str,
    intent_id: &str,
    claim_id: &str,
) -> Result<Value> {
    let key = key(plugin_id, intent_id)?;
    let tx = db.conn().unchecked_transaction()?;
    let raw: Option<String> = tx
        .query_row(
            "SELECT value_json FROM kv WHERE ns=?1 AND key=?2",
            params![NAMESPACE, key],
            |row| row.get(0),
        )
        .optional()?;
    let Some(raw) = raw else {
        bail!("prompt intent not found")
    };
    let mut record: Value = serde_json::from_str(&raw)?;
    if record["claimId"] != claim_id || record["status"] != "unknown" {
        bail!("STALE_PROMPT_CLAIM");
    }
    if !record["turnId"].is_null() {
        return Ok(json!({ "released": false, "turnId": record["turnId"] }));
    }
    record["claimId"] = json!(Uuid::new_v4().to_string());
    record["released"] = json!(true);
    tx.execute(
        "UPDATE kv SET value_json=?1, updated_at=?2 WHERE ns=?3 AND key=?4",
        params![record.to_string(), now_ms(), NAMESPACE, key],
    )?;
    tx.commit()?;
    Ok(json!({ "released": true, "turnId": null }))
}

pub fn invalidate(db: &Database, plugin_id: &str, intent_id: &str) -> Result<Value> {
    let key = key(plugin_id, intent_id)?;
    let tx = db.conn().unchecked_transaction()?;
    let raw: Option<String> = tx
        .query_row(
            "SELECT value_json FROM kv WHERE ns=?1 AND key=?2",
            params![NAMESPACE, key],
            |row| row.get(0),
        )
        .optional()?;
    let Some(raw) = raw else {
        tx.execute(
            "INSERT INTO kv (ns, key, value_json, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                NAMESPACE,
                key,
                json!({ "sessionId": null, "contentHash": null,
                "status": "rejected", "turnId": null, "code": "STALE_REQUEST",
                "claimId": null, "released": false })
                .to_string(),
                now_ms()
            ],
        )?;
        tx.commit()?;
        return Ok(json!({ "invalidated": true, "turnId": null }));
    };
    let mut record: Value = serde_json::from_str(&raw)?;
    if let Some(turn_id) = record["turnId"].as_str() {
        return Ok(json!({ "invalidated": false, "turnId": turn_id }));
    }
    record["status"] = json!("rejected");
    record["code"] = json!("STALE_REQUEST");
    record["claimId"] = json!(Uuid::new_v4().to_string());
    record["released"] = json!(false);
    tx.execute(
        "UPDATE kv SET value_json=?1, updated_at=?2 WHERE ns=?3 AND key=?4",
        params![record.to_string(), now_ms(), NAMESPACE, key],
    )?;
    tx.commit()?;
    Ok(json!({ "invalidated": true, "turnId": null }))
}

pub fn begin_turn(
    db: &Database,
    plugin_id: &str,
    intent_id: &str,
    claim_id: &str,
    session_id: &str,
    provider_id: Option<&str>,
    model_id: Option<&str>,
) -> Result<Value> {
    let key = key(plugin_id, intent_id)?;
    let tx = db.conn().unchecked_transaction()?;
    let owner: Option<String> = tx
        .query_row(
            "SELECT plugin_id FROM plugin_automation_sessions WHERE session_id=?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()?;
    if owner.as_deref().is_some_and(|owner| owner != plugin_id) {
        bail!("PERMISSION_DENIED: session belongs to another plugin");
    }
    let raw: Option<String> = tx
        .query_row(
            "SELECT value_json FROM kv WHERE ns=?1 AND key=?2",
            params![NAMESPACE, key],
            |row| row.get(0),
        )
        .optional()?;
    let Some(raw) = raw else {
        bail!("prompt intent not found")
    };
    let mut record: Value = serde_json::from_str(&raw)?;
    if record["sessionId"] != session_id {
        bail!("IDEMPOTENCY_CONFLICT")
    }
    if record["claimId"] != claim_id {
        bail!("STALE_PROMPT_CLAIM");
    }
    if let Some(turn_id) = record["turnId"].as_str() {
        return Ok(json!({ "turnId": turn_id, "start": false }));
    }
    if record["status"] != "unknown" {
        bail!("STALE_PROMPT_CLAIM");
    }
    let turn_id = Uuid::new_v4().to_string();
    let inserted = tx
        .execute(
            "INSERT INTO turns (id, session_id, provider_id, model_id, started_at)
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE EXISTS (SELECT 1 FROM sessions WHERE id=?2 AND deleted_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM turns WHERE session_id=?2 AND status='running')",
            params![turn_id, session_id, provider_id, model_id, now_ms()],
        )
        .map_err(|error| {
            let message = error.to_string();
            if message.contains("turns.session_id")
                || message.contains("idx_turns_one_running_session")
            {
                anyhow::anyhow!("AGENT_BUSY")
            } else {
                error.into()
            }
        })?;
    if inserted == 0 {
        bail!("AGENT_BUSY")
    }
    record["turnId"] = json!(turn_id);
    tx.execute(
        "UPDATE kv SET value_json=?1, updated_at=?2 WHERE ns=?3 AND key=?4",
        params![record.to_string(), now_ms(), NAMESPACE, key],
    )?;
    tx.commit()?;
    Ok(json!({ "turnId": turn_id, "start": true }))
}

pub fn settle(
    db: &Database,
    plugin_id: &str,
    intent_id: &str,
    status: &str,
    turn_id: Option<&str>,
    code: Option<&str>,
) -> Result<Value> {
    let tx = db.conn().unchecked_transaction()?;
    let result = settle_inner(db, plugin_id, intent_id, status, turn_id, code);
    if result.is_ok() {
        tx.commit()?;
    }
    result
}

fn settle_inner(
    db: &Database,
    plugin_id: &str,
    intent_id: &str,
    status: &str,
    turn_id: Option<&str>,
    code: Option<&str>,
) -> Result<Value> {
    if !matches!(status, "accepted" | "rejected" | "unknown") {
        bail!("invalid prompt status");
    }
    if status == "accepted" && turn_id.is_none_or(str::is_empty) {
        bail!("accepted prompt requires turnId");
    }
    let key = key(plugin_id, intent_id)?;
    let Some(mut record) = db.kv_get(NAMESPACE, &key)? else {
        bail!("prompt intent not found");
    };
    let prior = record["status"].as_str().unwrap_or("unknown");
    if let Some(bound_turn_id) = record["turnId"].as_str() {
        if status == "accepted" && turn_id != Some(bound_turn_id) {
            bail!("prompt intent turn binding cannot be changed");
        }
        if status == "rejected" {
            let turn_status: Option<String> = db
                .conn()
                .query_row(
                    "SELECT status FROM turns WHERE id=?1 AND session_id=?2",
                    params![bound_turn_id, record["sessionId"].as_str()],
                    |row| row.get(0),
                )
                .optional()?;
            if !matches!(turn_status.as_deref(), Some("error" | "aborted")) {
                bail!("running prompt intent cannot be rejected");
            }
        }
    }
    if prior != "unknown" && (prior != status || record["turnId"].as_str() != turn_id) {
        bail!("prompt intent already settled");
    }
    if prior == "unknown" {
        record["status"] = json!(status);
        if record["turnId"].is_null() {
            record["turnId"] = json!(turn_id);
        }
        record["code"] = json!(code);
        db.kv_set(NAMESPACE, &key, &record)?;
    }
    lookup(db, plugin_id, intent_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions;

    #[test]
    fn invalidated_prompt_cannot_begin_even_if_prepare_was_already_returned() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let hash = "a".repeat(64);
        let prepared = prepare(&db, "plugin", "held", &session.id, &hash, Some("epoch")).unwrap();
        let claim = prepared["claimId"].as_str().unwrap();
        assert_eq!(
            invalidate(&db, "plugin", "held").unwrap()["invalidated"],
            true
        );
        assert!(begin_turn(&db, "plugin", "held", claim, &session.id, None, None).is_err());
        assert_eq!(
            prepare(&db, "plugin", "held", &session.id, &hash, Some("next")).unwrap()["status"],
            "rejected"
        );

        assert_eq!(
            invalidate(&db, "plugin", "before-prepare").unwrap()["invalidated"],
            true
        );
        assert_eq!(
            prepare(
                &db,
                "plugin",
                "before-prepare",
                &session.id,
                &hash,
                Some("epoch")
            )
            .unwrap()["status"],
            "rejected"
        );

        let started = prepare(&db, "plugin", "started", &session.id, &hash, Some("epoch")).unwrap();
        let turn = begin_turn(
            &db,
            "plugin",
            "started",
            started["claimId"].as_str().unwrap(),
            &session.id,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            invalidate(&db, "plugin", "started").unwrap()["turnId"],
            turn["turnId"]
        );
    }

    #[test]
    fn prompt_intent_survives_reopen_and_rejects_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        let session =
            sessions::create_session(&db, Some("test".into()), None, None, None, None).unwrap();
        let hash = "a".repeat(64);
        assert_eq!(
            prepare(&db, "plugin", "intent", &session.id, &hash, Some("epoch-a")).unwrap()["start"],
            true
        );
        assert_eq!(
            prepare(&db, "plugin", "intent", &session.id, &hash, Some("epoch-a")).unwrap()["start"],
            false
        );
        assert_eq!(
            prepare(
                &db,
                "plugin",
                "lost-reply",
                &session.id,
                &hash,
                Some("epoch-a")
            )
            .unwrap()["start"],
            true
        );
        assert!(prepare(
            &db,
            "plugin",
            "intent",
            &session.id,
            &"b".repeat(64),
            Some("epoch-a")
        )
        .is_err());
        settle(&db, "plugin", "intent", "accepted", Some("turn-1"), None).unwrap();
        drop(db);
        let reopened = Database::open(&path).unwrap();
        assert_eq!(
            lookup(&reopened, "plugin", "intent").unwrap()["turnId"],
            "turn-1"
        );
        assert_eq!(
            lookup(&reopened, "plugin", "intent").unwrap()["sessionId"],
            session.id
        );
        assert_eq!(
            lookup(&reopened, "other", "intent").unwrap()["status"],
            "not_started"
        );
        assert_eq!(
            prepare(
                &reopened,
                "plugin",
                "intent",
                &session.id,
                &hash,
                Some("epoch-b")
            )
            .unwrap()["start"],
            false
        );
        assert_eq!(
            lookup(&reopened, "plugin", "lost-reply").unwrap()["status"],
            "unknown"
        );
        assert_eq!(
            prepare(
                &reopened,
                "plugin",
                "lost-reply",
                &session.id,
                &hash,
                Some("epoch-b")
            )
            .unwrap()["start"],
            true
        );
    }

    #[test]
    fn turn_binding_is_atomic_durable_and_claim_scoped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let other = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let hash = "a".repeat(64);
        let first = prepare(&db, "plugin", "intent", &session.id, &hash, Some("epoch-a")).unwrap();
        let claim = first["claimId"].as_str().unwrap();
        assert!(begin_turn(&db, "plugin", "intent", "wrong", &session.id, None, None).is_err());
        assert_eq!(
            lookup(&db, "plugin", "intent").unwrap()["turnId"],
            Value::Null
        );
        assert!(begin_turn(&db, "plugin", "intent", claim, &other.id, None, None).is_err());
        let turn = begin_turn(&db, "plugin", "intent", claim, &session.id, None, None).unwrap();
        let turn_id = turn["turnId"].as_str().unwrap().to_string();
        assert_eq!(turn["start"], true);
        assert_eq!(
            begin_turn(&db, "plugin", "intent", claim, &session.id, None, None).unwrap()["start"],
            false
        );
        assert_eq!(
            lookup(&db, "plugin", "intent").unwrap()["status"],
            "unknown"
        );
        assert_eq!(
            lookup(&db, "plugin", "intent").unwrap()["turnStatus"],
            "running"
        );
        assert!(settle(&db, "plugin", "intent", "rejected", None, None).is_err());
        drop(db);
        let reopened = Database::open(&path).unwrap();
        assert_eq!(
            lookup(&reopened, "plugin", "intent").unwrap()["turnId"],
            turn_id
        );
        assert_eq!(
            prepare(
                &reopened,
                "plugin",
                "intent",
                &session.id,
                &hash,
                Some("epoch-b")
            )
            .unwrap()["start"],
            false
        );
        let looked_up = lookup(&reopened, "plugin", "intent").unwrap();
        assert_eq!(looked_up["status"], "unknown");
        assert_eq!(looked_up["turnStatus"], "aborted");
    }

    #[test]
    fn restart_reclaims_only_intents_without_a_turn() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let hash = "b".repeat(64);
        let first = prepare(&db, "plugin", "intent", &session.id, &hash, Some("epoch-a")).unwrap();
        db.conn().execute(
            "INSERT INTO plugin_automation_sessions (session_id, plugin_id, created_at) VALUES (?1, 'other', ?2)",
            params![session.id, now_ms()],
        ).unwrap();
        assert!(prepare(&db, "plugin", "intent", &session.id, &hash, Some("epoch-a")).is_err());
        assert!(begin_turn(
            &db,
            "plugin",
            "intent",
            first["claimId"].as_str().unwrap(),
            &session.id,
            None,
            None
        )
        .is_err());
        db.conn()
            .execute(
                "DELETE FROM plugin_automation_sessions WHERE session_id=?1",
                [&session.id],
            )
            .unwrap();
        assert_eq!(
            prepare(&db, "plugin", "intent", &session.id, &hash, Some("epoch-a")).unwrap()["start"],
            false
        );
        let retry = prepare(&db, "plugin", "intent", &session.id, &hash, Some("epoch-b")).unwrap();
        assert_eq!(retry["start"], true);
        assert_ne!(first["claimId"], retry["claimId"]);
        assert!(begin_turn(
            &db,
            "plugin",
            "intent",
            first["claimId"].as_str().unwrap(),
            &session.id,
            None,
            None
        )
        .is_err());
        assert_eq!(
            begin_turn(
                &db,
                "plugin",
                "intent",
                retry["claimId"].as_str().unwrap(),
                &session.id,
                None,
                None
            )
            .unwrap()["start"],
            true
        );
    }

    #[test]
    fn legacy_unknown_without_claim_is_never_replayed_after_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let hash = "c".repeat(64);
        db.kv_set(
            NAMESPACE,
            &key("plugin", "legacy").unwrap(),
            &json!({
                "sessionId": session.id, "contentHash": hash,
                "status": "unknown", "turnId": null, "code": null
            }),
        )
        .unwrap();
        for epoch in ["new-process", "another-process"] {
            let replay = prepare(&db, "plugin", "legacy", &session.id, &hash, Some(epoch)).unwrap();
            assert_eq!(replay["start"], false);
            assert_eq!(replay["status"], "unknown");
            assert_eq!(replay["turnId"], Value::Null);
        }
        assert!(begin_turn(&db, "plugin", "legacy", "", &session.id, None, None).is_err());
    }

    #[test]
    fn same_process_release_revokes_old_claim_before_retry() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let hash = "d".repeat(64);
        let first = prepare(&db, "plugin", "retry", &session.id, &hash, Some("epoch")).unwrap();
        let old_claim = first["claimId"].as_str().unwrap();
        assert_eq!(
            prepare(&db, "plugin", "retry", &session.id, &hash, Some("epoch")).unwrap()["start"],
            false
        );
        assert_eq!(
            release_claim(&db, "plugin", "retry", old_claim).unwrap()["released"],
            true
        );
        assert!(begin_turn(&db, "plugin", "retry", old_claim, &session.id, None, None).is_err());
        let retry = prepare(&db, "plugin", "retry", &session.id, &hash, Some("epoch")).unwrap();
        assert_eq!(retry["start"], true);
        let new_claim = retry["claimId"].as_str().unwrap();
        assert_ne!(new_claim, old_claim);
        let turn = begin_turn(&db, "plugin", "retry", new_claim, &session.id, None, None).unwrap();
        assert_eq!(turn["start"], true);
        assert!(begin_turn(&db, "plugin", "retry", old_claim, &session.id, None, None).is_err());
        assert_eq!(
            release_claim(&db, "plugin", "retry", new_claim).unwrap()["released"],
            false
        );
        assert_eq!(
            lookup(&db, "plugin", "retry").unwrap()["turnId"],
            turn["turnId"]
        );
    }
}
