//! Durable admission ledger for plugin-initiated ordinary prompts.

use anyhow::{bail, Result};
use serde_json::{json, Value};

use crate::db::Database;

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
    Ok(
        json!({ "status": record["status"], "turnId": record["turnId"],
        "sessionId": record["sessionId"], "code": record["code"] }),
    )
}

pub fn prepare(
    db: &Database,
    plugin_id: &str,
    intent_id: &str,
    session_id: &str,
    content_hash: &str,
) -> Result<Value> {
    let key = key(plugin_id, intent_id)?;
    if session_id.is_empty()
        || session_id.len() > 256
        || content_hash.len() != 64
        || !content_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        bail!("invalid prompt session or content hash");
    }
    if let Some(record) = db.kv_get(NAMESPACE, &key)? {
        if record["sessionId"] != session_id || record["contentHash"] != content_hash {
            bail!("IDEMPOTENCY_CONFLICT");
        }
        return Ok(json!({ "start": false, "status": record["status"],
            "turnId": record["turnId"], "sessionId": record["sessionId"],
            "code": record["code"] }));
    }
    let exists: bool = db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND deleted_at IS NULL)",
        [session_id],
        |row| row.get(0),
    )?;
    if !exists {
        bail!("session not found");
    }
    db.kv_set(
        NAMESPACE,
        &key,
        &json!({ "sessionId": session_id,
        "contentHash": content_hash, "status": "unknown", "turnId": null,
        "code": null }),
    )?;
    Ok(json!({ "start": true, "status": "unknown", "turnId": null }))
}

pub fn settle(
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
    if prior != "unknown" && (prior != status || record["turnId"].as_str() != turn_id) {
        bail!("prompt intent already settled");
    }
    if prior == "unknown" {
        record["status"] = json!(status);
        record["turnId"] = json!(turn_id);
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
    fn prompt_intent_survives_reopen_and_rejects_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        let session =
            sessions::create_session(&db, Some("test".into()), None, None, None, None).unwrap();
        let hash = "a".repeat(64);
        assert_eq!(
            prepare(&db, "plugin", "intent", &session.id, &hash).unwrap()["start"],
            true
        );
        assert_eq!(
            prepare(&db, "plugin", "intent", &session.id, &hash).unwrap()["start"],
            false
        );
        assert_eq!(
            prepare(&db, "plugin", "lost-reply", &session.id, &hash).unwrap()["start"],
            true
        );
        assert!(prepare(&db, "plugin", "intent", &session.id, &"b".repeat(64)).is_err());
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
            prepare(&reopened, "plugin", "intent", &session.id, &hash).unwrap()["start"],
            false
        );
        assert_eq!(
            lookup(&reopened, "plugin", "lost-reply").unwrap()["status"],
            "unknown"
        );
        assert_eq!(
            prepare(&reopened, "plugin", "lost-reply", &session.id, &hash).unwrap()["start"],
            false
        );
    }
}
