use anyhow::{bail, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::{db::Database, plugin_scheduled};

use super::{timing::Schedule, ScheduledTask};

const PROFILE_ENV: &str = "PI_DESKTOP_DEV_CALENDAR_PREVIEW_DIR";

/// Validate the diagnostic profile before opening SQLite. Normal launches
/// without the opt-in keep their existing behavior.
pub(crate) fn validate_startup_profile(data_dir: &Path) -> Result<()> {
    if let Some(configured) = std::env::var_os(PROFILE_ENV) {
        validate_profile_paths(data_dir, Path::new(&configured))?;
    }
    Ok(())
}

pub(crate) fn require_development_profile(db: &Database) -> Result<()> {
    let configured = std::env::var_os(PROFILE_ENV)
        .context("calendar preview requires an explicitly isolated development profile")?;
    let isolated = validate_profile_paths(db.data_dir(), Path::new(&configured))?;
    let database_path: String = db.conn().query_row(
        "SELECT file FROM pragma_database_list WHERE name='main'",
        [],
        |row| row.get(0),
    )?;
    if std::fs::canonicalize(database_path)? != isolated.join("pi.sqlite") {
        bail!("calendar preview requires the actual isolated profile database");
    }
    Ok(())
}

fn validate_profile_paths(data_dir: &Path, configured: &Path) -> Result<PathBuf> {
    if !data_dir.is_absolute() || !configured.is_absolute() {
        bail!("calendar preview profile paths must be absolute");
    }
    let actual =
        std::fs::canonicalize(data_dir).context("calendar preview profile must already exist")?;
    let configured = std::fs::canonicalize(configured)?;
    let temp = std::fs::canonicalize(std::env::temp_dir())?;
    if actual != configured
        || actual.parent() != Some(temp.as_path())
        || !actual
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.starts_with("pi-bot-calendar-preview-")
                    && name.len() > "pi-bot-calendar-preview-".len()
            })
    {
        bail!("calendar preview requires an exact dedicated temporary profile");
    }
    if let Some(home) = dirs::home_dir() {
        let production = home.join(".pi-desktop");
        if production.exists() && actual.starts_with(std::fs::canonicalize(production)?) {
            bail!("calendar preview cannot use the production profile");
        }
    }
    // Reject a database symlink before opening it, as well as after opening.
    let database = actual.join("pi.sqlite");
    match std::fs::symlink_metadata(&database) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || std::fs::canonicalize(&database)? != database
            {
                bail!("calendar preview database cannot redirect outside its profile");
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(actual)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CalendarPreviewRequest {
    pub external_key: String,
    pub expected_definition_revision: i64,
    pub after: String,
    pub count: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CalendarPreviewPoint {
    pub scheduled_for: String,
    pub local_time: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CalendarPreview {
    pub plugin_id: String,
    pub external_key: String,
    pub scheduler_task_id: String,
    pub definition_revision: i64,
    pub cadence: String,
    pub timezone: String,
    pub schedule: Schedule,
    pub enabled: bool,
    pub after: String,
    pub points: Vec<CalendarPreviewPoint>,
}

/// Read-only calendar projection. The caller authenticates plugin identity and
/// restricts this diagnostic entry point to an isolated development profile.
pub(crate) fn calendar_preview(
    db: &Database,
    trusted_plugin_id: &str,
    request: &CalendarPreviewRequest,
) -> Result<CalendarPreview> {
    if trusted_plugin_id.is_empty()
        || request.external_key.trim().is_empty()
        || request.external_key.len() > 256
        || request.expected_definition_revision < 1
    {
        bail!("calendar preview requires an owned key and positive definition revision");
    }
    if !(1..=16).contains(&request.count) {
        bail!("calendar preview count must be between 1 and 16");
    }
    if request.after.len() > 128 {
        bail!("calendar preview after exceeds the timestamp size limit");
    }
    // Never use ts_to_ms: its malformed-input fallback reads the wall clock.
    let after = DateTime::parse_from_rfc3339(&request.after)
        .context("calendar preview after must be an explicit RFC3339 timestamp")?;
    let mut cursor = after.timestamp_millis();
    let normalized_after = utc_timestamp(cursor)?;
    let binding = plugin_scheduled::get(db, trusted_plugin_id, &request.external_key)?
        .context("calendar preview binding not found for this plugin")?;
    let revision = binding["definitionRevision"]
        .as_i64()
        .context("calendar preview binding has no definition revision")?;
    if revision != request.expected_definition_revision {
        bail!("calendar preview definition revision is stale");
    }
    let timezone = binding["timezone"]
        .as_str()
        .context("calendar preview binding has no timezone")?;
    let zone: Tz = timezone
        .parse()
        .context("calendar preview binding has an invalid IANA timezone")?;
    let task: ScheduledTask = serde_json::from_value(binding["task"].clone())
        .context("calendar preview binding has no valid task")?;
    let schedule = task
        .schedule
        .context("calendar preview task has no calendar schedule")?;
    schedule.validate()?;
    let mut points = Vec::with_capacity(usize::from(request.count));
    for _ in 0..request.count {
        let next = schedule
            .next_in(&task.cadence, cursor, &zone)
            .context("calendar preview has no representable next instant")?;
        if next <= cursor {
            bail!("calendar preview did not advance strictly after its cursor");
        }
        let utc = DateTime::<Utc>::from_timestamp_millis(next)
            .context("calendar preview instant is outside the supported timestamp range")?;
        points.push(CalendarPreviewPoint {
            scheduled_for: utc.to_rfc3339_opts(SecondsFormat::Millis, true),
            local_time: utc
                .with_timezone(&zone)
                .to_rfc3339_opts(SecondsFormat::Millis, false),
        });
        cursor = next;
    }
    Ok(CalendarPreview {
        plugin_id: trusted_plugin_id.to_owned(),
        external_key: request.external_key.clone(),
        scheduler_task_id: task.id,
        definition_revision: revision,
        cadence: task.cadence,
        timezone: timezone.to_owned(),
        schedule,
        enabled: task.enabled,
        after: normalized_after,
        points,
    })
}

fn utc_timestamp(timestamp: i64) -> Result<String> {
    Ok(DateTime::<Utc>::from_timestamp_millis(timestamp)
        .context("calendar preview after is outside the supported timestamp range")?
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store_disabled(db: &Database, hour: u32, minute: u32) {
        plugin_scheduled::upsert(
            db,
            "plugin-a",
            &json!({
                "externalKey": "digest", "definitionRevision": 7,
                "timezone": "America/New_York", "title": "Digest",
                "cadence": "daily", "enabled": false,
                "schedule": {"hour": hour, "minute": minute, "weekday": 0}
            }),
        )
        .unwrap();
    }

    fn request(after: &str) -> CalendarPreviewRequest {
        CalendarPreviewRequest {
            external_key: "digest".to_owned(),
            expected_definition_revision: 7,
            after: after.to_owned(),
            count: 2,
        }
    }

    fn total_changes(db: &Database) -> i64 {
        db.conn()
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn stored_calendar_preview_skips_dst_gap_without_writing_or_authorizing() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        store_disabled(&db, 2, 30);
        let before = plugin_scheduled::get(&db, "plugin-a", "digest").unwrap();
        let writes = total_changes(&db);
        let preview =
            calendar_preview(&db, "plugin-a", &request("2026-03-08T00:00:00-05:00")).unwrap();
        assert_eq!(preview.definition_revision, 7);
        assert!(!preview.enabled);
        assert_eq!(preview.after, "2026-03-08T05:00:00.000Z");
        assert_eq!(preview.points[0].scheduled_for, "2026-03-09T06:30:00.000Z");
        assert_eq!(
            preview.points[0].local_time,
            "2026-03-09T02:30:00.000-04:00"
        );
        assert_eq!(preview.points[1].scheduled_for, "2026-03-10T06:30:00.000Z");
        assert_eq!(total_changes(&db), writes);
        assert_eq!(
            plugin_scheduled::get(&db, "plugin-a", "digest").unwrap(),
            before
        );
    }

    #[test]
    fn stored_calendar_preview_reports_fold_once_and_offset_change() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        store_disabled(&db, 1, 30);
        let writes = total_changes(&db);
        let preview =
            calendar_preview(&db, "plugin-a", &request("2026-11-01T00:00:00-04:00")).unwrap();
        assert_eq!(preview.points[0].scheduled_for, "2026-11-01T05:30:00.000Z");
        assert_eq!(
            preview.points[0].local_time,
            "2026-11-01T01:30:00.000-04:00"
        );
        assert_eq!(preview.points[1].scheduled_for, "2026-11-02T06:30:00.000Z");
        assert_eq!(
            preview.points[1].local_time,
            "2026-11-02T01:30:00.000-05:00"
        );
        assert_eq!(total_changes(&db), writes);
    }

    #[test]
    fn preview_rejects_unowned_stale_and_malformed_requests_without_writes() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        store_disabled(&db, 9, 0);
        let writes = total_changes(&db);
        let mut input = request("2026-10-04T00:00:00Z");
        assert!(calendar_preview(&db, "plugin-b", &input).is_err());
        input.expected_definition_revision = 6;
        assert!(calendar_preview(&db, "plugin-a", &input).is_err());
        input.expected_definition_revision = 7;
        input.external_key = "missing".to_owned();
        assert!(calendar_preview(&db, "plugin-a", &input).is_err());
        input.external_key = "digest".to_owned();
        for after in ["", "not-a-date", "2026-10-04T09:00:00"] {
            input.after = after.to_owned();
            assert!(calendar_preview(&db, "plugin-a", &input).is_err());
        }
        input.after = "2026-10-04T00:00:00Z".to_owned();
        for count in [0, 17] {
            input.count = count;
            assert!(calendar_preview(&db, "plugin-a", &input).is_err());
        }
        assert!(serde_json::from_value::<CalendarPreviewRequest>(json!({
            "externalKey": "digest", "expectedDefinitionRevision": 7,
            "after": "2026-10-04T00:00:00Z", "count": 1,
            "timezone": "UTC"
        }))
        .is_err());
        assert_eq!(total_changes(&db), writes);
    }

    #[test]
    fn profile_guard_rejects_default_mismatch_and_nondedicated_paths() {
        let isolated = tempfile::Builder::new()
            .prefix("pi-bot-calendar-preview-")
            .tempdir()
            .unwrap();
        assert!(validate_profile_paths(isolated.path(), isolated.path()).is_ok());
        let other = tempfile::tempdir().unwrap();
        assert!(validate_profile_paths(other.path(), other.path()).is_err());
        assert!(validate_profile_paths(isolated.path(), other.path()).is_err());
        assert!(validate_profile_paths(Path::new(".pi-desktop"), isolated.path()).is_err());
        let nested = isolated.path().join("pi-bot-calendar-preview-nested");
        std::fs::create_dir(&nested).unwrap();
        assert!(validate_profile_paths(&nested, &nested).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn profile_guard_rejects_dangling_database_symlink_before_open() {
        let isolated = tempfile::Builder::new()
            .prefix("pi-bot-calendar-preview-")
            .tempdir()
            .unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("missing.sqlite"),
            isolated.path().join("pi.sqlite"),
        )
        .unwrap();
        assert!(validate_profile_paths(isolated.path(), isolated.path()).is_err());
        assert!(!outside.path().join("missing.sqlite").exists());
    }
}
