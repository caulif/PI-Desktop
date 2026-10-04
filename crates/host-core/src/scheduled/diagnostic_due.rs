//! Explicitly isolated scheduler integration diagnostics. No grants or model execution.
use anyhow::{bail, Context, Result};
use chrono::DateTime;
use chrono_tz::Tz;
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

use crate::{db::Database, plugin_scheduled};

const PROFILE_ENV: &str = "PI_DESKTOP_DEV_SCHEDULE_DUE_DIR";

pub(crate) fn validate_startup_profile(data_dir: &Path) -> Result<()> {
    if let Some(configured) = std::env::var_os(PROFILE_ENV) {
        let preview = std::env::var_os("PI_DESKTOP_DEV_CALENDAR_PREVIEW_DIR")
            .context("scheduler diagnostic also requires the isolated calendar profile gate")?;
        if std::fs::canonicalize(data_dir)? != std::fs::canonicalize(configured)?
            || std::fs::canonicalize(data_dir)? != std::fs::canonicalize(preview)?
        {
            bail!("scheduler diagnostic profile must match the exact isolated data directory");
        }
        super::preview::validate_startup_profile(data_dir)?;
    }
    Ok(())
}

pub(crate) fn require_profile(db: &Database) -> Result<()> {
    std::env::var_os(PROFILE_ENV).context("scheduler diagnostic is disabled")?;
    validate_startup_profile(db.data_dir())?;
    super::preview::require_development_profile(db)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DueAtRequest {
    pub plugin_id: String,
    pub external_key: String,
    pub expected_definition_revision: i64,
    pub expected_timezone: String,
    pub now: String,
    pub seed_after: Option<String>,
}

fn timestamp(value: &str) -> Result<i64> {
    if value.len() > 128 {
        bail!("diagnostic timestamp is too long");
    }
    let at = DateTime::parse_from_rfc3339(value)
        .context("diagnostic timestamp must be explicit RFC3339")?
        .timestamp_millis();
    if !(1_577_836_800_000..4_102_444_800_000).contains(&at) {
        bail!("diagnostic timestamp must be between 2020 and 2100");
    }
    Ok(at)
}

pub(crate) fn due_at(db: &Database, request: &DueAtRequest) -> Result<Value> {
    require_profile(db)?;
    due_owned_binding_at(db, request)
}

fn due_owned_binding_at(db: &Database, request: &DueAtRequest) -> Result<Value> {
    if request.plugin_id.is_empty()
        || request.plugin_id.len() > 256
        || request.external_key.trim().is_empty()
        || request.external_key.len() > 256
        || request.expected_definition_revision < 1
    {
        bail!("diagnostic requires an exact owned binding and positive revision");
    }
    let now = timestamp(&request.now)?;
    let binding = plugin_scheduled::get(db, &request.plugin_id, &request.external_key)?
        .context("diagnostic binding not found for this plugin")?;
    if binding["definitionRevision"] != request.expected_definition_revision
        || binding["timezone"] != request.expected_timezone
    {
        bail!("diagnostic binding revision or timezone is stale");
    }
    // The production due function polls all bindings. Keep its complete write scope
    // limited to this one isolated case rather than silently modifying other tasks.
    let count: i64 =
        db.conn()
            .query_row("SELECT COUNT(*) FROM plugin_schedule_bindings", [], |row| {
                row.get(0)
            })?;
    if count != 1 {
        bail!("scheduler diagnostic requires exactly one binding in its profile");
    }
    let task_id = binding["schedulerTaskId"]
        .as_str()
        .context("binding lacks task id")?;
    let authorized: bool = db.conn().query_row(
        "SELECT t.enabled=1 AND b.authorization_hash IS NOT NULL AND length(b.authorization_hash)=64
         AND b.authorized_session_id IS NOT NULL AND b.goal_hash IS NOT NULL AND b.prompt_template_hash IS NOT NULL
         FROM plugin_schedule_bindings b JOIN scheduled_tasks t ON t.id=b.task_id
         WHERE b.task_id=?1 AND b.plugin_id=?2", params![task_id, request.plugin_id], |row| row.get(0))?;
    if !authorized {
        bail!("scheduler diagnostic requires an existing enabled native-authorized binding");
    }
    let raw: String = db.conn().query_row(
        "SELECT config_json FROM scheduled_tasks WHERE id=?1",
        [task_id],
        |row| row.get(0),
    )?;
    let mut config: Value = serde_json::from_str(&raw)?;
    if !config.is_object() {
        bail!("diagnostic task config must be an object");
    }
    if config
        .get("diagnosticNowAt")
        .and_then(Value::as_i64)
        .is_some_and(|prior| now < prior)
    {
        bail!("diagnostic clock cannot move backwards");
    }
    if let Some(seed) = &request.seed_after {
        if config.get("diagnosticSeedAfter").is_some()
            || !binding["occurrences"]
                .as_array()
                .context("binding lacks history")?
                .is_empty()
        {
            bail!("diagnostic initialization is allowed exactly once before any occurrence");
        }
        let seed = timestamp(seed)?;
        if seed > now || now - seed > 7 * 24 * 60 * 60 * 1000 {
            bail!("diagnostic seed must precede now by at most seven days");
        }
        let task: super::ScheduledTask = serde_json::from_value(binding["task"].clone())?;
        let zone: Tz = request.expected_timezone.parse()?;
        let schedule = task.schedule.context("diagnostic task lacks a schedule")?;
        let next = schedule
            .next_in(&task.cadence, seed, &zone)
            .context("diagnostic schedule has no next instant")?;
        config["nextRunAt"] = json!(next);
        config["diagnosticSeedAfter"] = json!(seed);
    } else if config.get("diagnosticSeedAfter").is_none() {
        bail!("diagnostic requires an explicit one-time initialization");
    }
    config["diagnosticNowAt"] = json!(now);
    // The clock cursor and every production due write form one operation.
    // A failed due must leave the seed retryable and the complete prior state intact.
    let transaction = db.conn().unchecked_transaction()?;
    let updated = db.conn().execute(
        "UPDATE scheduled_tasks SET config_json=?1 WHERE id=?2 AND config_json=?3",
        params![config.to_string(), task_id, raw],
    )?;
    if updated != 1 {
        bail!("diagnostic schedule changed during initialization");
    }
    let occurrences = plugin_scheduled::due(db, now)?;
    let binding = plugin_scheduled::get(db, &request.plugin_id, &request.external_key)?;
    transaction.commit()?;
    Ok(
        json!({"kind":"isolated_real_host_controlled_due", "now": request.now,
        "occurrences":occurrences,"binding":binding,
        "createsAuthorization":false,"startsModel":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_timestamps_are_explicit_bounded_and_do_not_fall_back() {
        assert_eq!(
            timestamp("2026-11-01T01:30:00-04:00").unwrap(),
            timestamp("2026-11-01T05:30:00Z").unwrap()
        );
        assert!(
            timestamp("2026-11-01T01:30:00-05:00").unwrap()
                > timestamp("2026-11-01T01:30:00-04:00").unwrap()
        );
        for invalid in [
            "bad",
            "2026-11-01T01:30:00",
            "2019-12-31T23:59:59Z",
            "2100-01-01T00:00:00Z",
        ] {
            assert!(timestamp(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn diagnostic_request_rejects_extra_permission_or_clock_fields() {
        let base = json!({"pluginId":"owned","externalKey":"daily","expectedDefinitionRevision":1,
            "expectedTimezone":"America/New_York","now":"2026-11-01T05:30:00Z"});
        assert!(serde_json::from_value::<DueAtRequest>(base.clone()).is_ok());
        for field in ["nativeAuthorized", "enabled", "clockOverride"] {
            let mut request = base.clone();
            request[field] = json!(true);
            assert!(serde_json::from_value::<DueAtRequest>(request).is_err());
        }
    }

    fn fixture(db: &Database, hour: u32, minute: u32) {
        let session = crate::sessions::create_session(db, None, None, None, None, None).unwrap();
        plugin_scheduled::register_created_session(db, "owned", &session.id).unwrap();
        plugin_scheduled::upsert(
            db,
            "owned",
            &json!({"externalKey":"daily", "definitionRevision":1,
            "timezone":"America/New_York", "title":"DST fixture", "cadence":"daily",
            "schedule":{"hour":hour,"minute":minute,"weekday":0},"enabled":true,
            "sessionId":session.id,"goalHash":"a".repeat(64),"promptTemplateHash":"b".repeat(64),
            "nativeAuthorized":true}),
        )
        .unwrap();
    }

    fn request(now: &str, seed: Option<&str>) -> DueAtRequest {
        DueAtRequest {
            plugin_id: "owned".into(),
            external_key: "daily".into(),
            expected_definition_revision: 1,
            expected_timezone: "America/New_York".into(),
            now: now.into(),
            seed_after: seed.map(str::to_owned),
        }
    }

    #[test]
    fn production_due_gap_fold_persistence_and_one_time_seed() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        fixture(&db, 2, 30);
        let initial = request("2026-03-08T08:00:00Z", Some("2026-03-08T05:00:00Z"));
        assert!(due_owned_binding_at(&db, &initial).unwrap()["occurrences"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(due_owned_binding_at(&db, &initial).is_err());
        let actual = due_owned_binding_at(&db, &request("2026-03-09T06:30:00Z", None)).unwrap();
        assert_eq!(
            actual["occurrences"][0]["scheduledFor"],
            "2026-03-09T06:30:00.000Z"
        );
        let before = plugin_scheduled::get(&db, "owned", "daily").unwrap();
        drop(db);
        let db = Database::open_in_dir(dir.path()).unwrap();
        assert_eq!(
            plugin_scheduled::get(&db, "owned", "daily").unwrap(),
            before
        );
        assert_eq!(
            due_owned_binding_at(&db, &request("2026-03-09T06:30:00Z", None)).unwrap()["binding"]
                ["occurrences"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        fixture(&db, 1, 30);
        let first = due_owned_binding_at(
            &db,
            &request("2026-11-01T05:30:00Z", Some("2026-11-01T04:00:00Z")),
        )
        .unwrap();
        assert_eq!(
            first["occurrences"][0]["scheduledFor"],
            "2026-11-01T05:30:00.000Z"
        );
        let second = due_owned_binding_at(&db, &request("2026-11-01T06:30:00Z", None)).unwrap();
        assert!(second["occurrences"].as_array().unwrap().is_empty());
        assert_eq!(
            second["binding"]["occurrences"].as_array().unwrap().len(),
            1
        );
        assert_eq!(
            second["binding"]["occurrences"][0]["skipReason"],
            "deadline"
        );
        assert!(due_owned_binding_at(&db, &request("2026-11-01T05:29:00Z", None)).is_err());
        plugin_scheduled::disable(&db, "owned", "daily").unwrap();
        assert!(due_owned_binding_at(&db, &request("2026-11-02T06:30:00Z", None)).is_err());
    }

    #[test]
    fn failing_due_writes_roll_back_clock_seed_occurrence_and_allow_exact_retry() {
        for trigger in [
            "CREATE TRIGGER fail_due BEFORE INSERT ON plugin_schedule_occurrences BEGIN SELECT RAISE(ABORT,'injected insert'); END;",
            "CREATE TRIGGER fail_due BEFORE UPDATE ON scheduled_tasks WHEN EXISTS(SELECT 1 FROM plugin_schedule_occurrences) BEGIN SELECT RAISE(ABORT,'injected next-run update'); END;",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let db = Database::open_in_dir(dir.path()).unwrap();
            fixture(&db,1,30);
            let before = plugin_scheduled::get(&db,"owned","daily").unwrap();
            let raw: String = db.conn().query_row("SELECT config_json FROM scheduled_tasks",[],|row|row.get(0)).unwrap();
            db.conn().execute_batch(trigger).unwrap();
            let initial = request("2026-11-01T05:46:00Z",Some("2026-11-01T04:00:00Z"));
            assert!(due_owned_binding_at(&db,&initial).is_err());
            assert!(db.conn().is_autocommit());
            assert_eq!(plugin_scheduled::get(&db,"owned","daily").unwrap(),before);
            assert_eq!(db.conn().query_row("SELECT config_json FROM scheduled_tasks",[],|row|row.get::<_,String>(0)).unwrap(),raw);
            db.conn().execute_batch("DROP TRIGGER fail_due").unwrap();
            let retried = due_owned_binding_at(&db,&initial).unwrap();
            assert_eq!(retried["binding"]["occurrences"].as_array().unwrap().len(),1);
        }
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        fixture(&db, 1, 30);
        due_owned_binding_at(
            &db,
            &request("2026-11-01T05:30:00Z", Some("2026-11-01T04:00:00Z")),
        )
        .unwrap();
        let before = plugin_scheduled::get(&db, "owned", "daily").unwrap();
        let raw: String = db
            .conn()
            .query_row("SELECT config_json FROM scheduled_tasks", [], |row| {
                row.get(0)
            })
            .unwrap();
        db.conn().execute_batch("CREATE TRIGGER fail_due BEFORE UPDATE ON plugin_schedule_occurrences BEGIN SELECT RAISE(ABORT,'injected deadline update'); END;").unwrap();
        let later = request("2026-11-01T05:46:00Z", None);
        assert!(due_owned_binding_at(&db, &later).is_err());
        assert!(db.conn().is_autocommit());
        assert_eq!(
            plugin_scheduled::get(&db, "owned", "daily").unwrap(),
            before
        );
        assert_eq!(
            db.conn()
                .query_row("SELECT config_json FROM scheduled_tasks", [], |row| row
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
            raw
        );
        db.conn().execute_batch("DROP TRIGGER fail_due").unwrap();
        assert_eq!(
            due_owned_binding_at(&db, &later).unwrap()["binding"]["occurrences"][0]["skipReason"],
            "deadline"
        );
    }
}
