//! Host-authoritative, native-approved fixed-command verification ledger.
use crate::db::{now_ms, Database};
use anyhow::{bail, Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

const APPROVAL_NS: &str = "plugin.verification.approval.v1";
const COMMAND_NS: &str = "plugin.verification.command.v1";
const EXECUTION_NS: &str = "plugin.verification.execution.v1";
const MAX_OUTPUT: usize = 1_000_000;
const MAX_INPUT: u64 = 256 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptPin {
    pub path: String,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandDefinition {
    pub program: String,
    pub args: Vec<String>,
    pub script_pins: Vec<ScriptPin>,
    pub timeout_ms: u64,
    pub max_output_bytes: usize,
    pub expires_at: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedCheck {
    pub command_id: String,
    pub plugin_id: String,
    pub session_id: String,
    pub project_path: String,
    pub definition: CommandDefinition,
    pub program_sha256: String,
    pub digest: String,
    pub revoked: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalChallenge {
    /// Internal trusted-main only. Never expose through a plugin operation.
    pub token: String,
    pub check: ApprovedCheck,
    pub challenge_expires_at: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerificationIdentity {
    pub spec_id: String,
    pub spec_version: u64,
    pub artifact_id: String,
    pub artifact_revision: u64,
    pub content_hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodeSnapshot {
    pub base_commit: String,
    pub worktree_hash: String,
    pub environment_hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRequest {
    pub execution_id: String,
    pub command_id: String,
    pub session_id: String,
    pub project_path: String,
    pub identity: VerificationIdentity,
    pub before_snapshot: CodeSnapshot,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionReceipt {
    pub execution_id: String,
    pub request_digest: String,
    pub state: String,
    pub command: Vec<String>,
    pub before_snapshot: CodeSnapshot,
    pub after_snapshot: Option<CodeSnapshot>,
    pub exit_code: Option<i32>,
    pub output: Vec<u8>,
    pub output_sha256: Option<String>,
    pub completed_at: Option<String>,
    pub cancel_requested: bool,
    pub incomplete_reason: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct ExecutionRecord {
    request: RunRequest,
    plugin_id: String,
    claim_hash: String,
    receipt: ExecutionReceipt,
    environment: BTreeMap<String, String>,
}
/// Process configuration is internal, not a plugin response.
pub struct ExecutionAdmission {
    pub start: bool,
    pub claim_token: Option<String>,
    pub check: Option<ApprovedCheck>,
    pub environment: BTreeMap<String, String>,
    pub receipt: ExecutionReceipt,
    /// Keep these handles alive through process settlement (Windows denies write/delete).
    pub input_guards: Vec<fs::File>,
}
pub struct ProcessOutcome {
    pub exit_code: Option<i32>,
    pub output: Vec<u8>,
    /// completed, cancelled, timed_out, output_limited, or unknown.
    pub termination: String,
}

fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn digest<T: Serialize>(value: &T) -> Result<String> {
    Ok(hash(&serde_json::to_vec(value)?))
}
fn key(plugin: &str, id: &str) -> Result<String> {
    Ok(serde_json::to_string(&(plugin, id))?)
}
fn valid_id(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        bail!("invalid verification identifier");
    }
    Ok(())
}
fn valid_hash(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        bail!("invalid SHA-256");
    }
    Ok(())
}
fn read<T: for<'de> Deserialize<'de>>(db: &Database, ns: &str, key: &str) -> Result<Option<T>> {
    let raw: Option<String> = db
        .conn()
        .query_row(
            "SELECT value_json FROM kv WHERE ns=?1 AND key=?2",
            params![ns, key],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(Into::into))
        .transpose()
}
fn put(db: &Database, ns: &str, key: &str, value: &impl Serialize) -> Result<()> {
    db.conn().execute("INSERT INTO kv(ns,key,value_json,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(ns,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at", params![ns,key,serde_json::to_string(value)?,now_ms()])?;
    Ok(())
}
fn scope(db: &Database, plugin: &str, session: &str, project: &str) -> Result<PathBuf> {
    valid_id(plugin)?;
    valid_id(session)?;
    let stored: Option<String> = db.conn().query_row(
        "SELECT p.path FROM sessions s JOIN projects p ON p.id=s.project_id JOIN plugin_automation_sessions a ON a.session_id=s.id WHERE s.id=?1 AND a.plugin_id=?2 AND s.deleted_at IS NULL",
        params![session,plugin], |r|r.get(0)).optional()?;
    let supplied = Path::new(project);
    if !supplied.is_absolute() {
        bail!("project must be absolute");
    }
    let root = fs::canonicalize(supplied)?;
    if !root.is_dir()
        || root != fs::canonicalize(stored.context("plugin does not own live project session")?)?
    {
        bail!("verification project scope mismatch");
    }
    let data = fs::canonicalize(&db.data_dir)?;
    if root.starts_with(&data) || data.starts_with(&root) {
        bail!("profile data cannot be a verification workspace");
    }
    if let Some(home) = dirs::home_dir() {
        let production = home.join(".pi-desktop");
        if production.exists() {
            let production = fs::canonicalize(production)?;
            if root.starts_with(&production) || production.starts_with(&root) {
                bail!("production profile is forbidden");
            }
        }
    }
    Ok(root)
}
fn safe_file(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        bail!("pin/input path must be safe relative path");
    }
    let mut full = root.to_owned();
    for part in path.components() {
        full.push(part.as_os_str());
        if fs::symlink_metadata(&full)?.file_type().is_symlink() {
            bail!("symlink input is not allowed");
        }
    }
    let canonical = fs::canonicalize(&full)?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        bail!("input escaped workspace or is not a regular file");
    }
    Ok(canonical)
}
fn bounded_hash(path: &Path) -> Result<String> {
    if fs::metadata(path)?.len() > MAX_INPUT {
        bail!("verification input exceeds limit");
    }
    let bytes = fs::read(path)?;
    if bytes.len() as u64 > MAX_INPUT {
        bail!("verification input exceeds limit");
    }
    Ok(hash(&bytes))
}
fn validate_definition(root: &Path, definition: &CommandDefinition) -> Result<(String, String)> {
    if !Path::new(&definition.program).is_absolute()
        || definition.args.len() > 64
        || definition
            .args
            .iter()
            .any(|a| a.len() > 8192 || a.contains('\0'))
        || definition.args.iter().map(String::len).sum::<usize>() > 32768
        || definition.script_pins.len() > 64
        || definition.timeout_ms == 0
        || definition.timeout_ms > 600_000
        || definition.max_output_bytes == 0
        || definition.max_output_bytes > MAX_OUTPUT
        || definition.expires_at <= now_ms()
        || definition.expires_at > now_ms() + 30 * 24 * 60 * 60 * 1000
    {
        bail!("invalid fixed-command limits");
    }
    let program = fs::canonicalize(&definition.program)?;
    if !program.is_file() {
        bail!("program must be a regular file");
    }
    let program_string = program.to_string_lossy().into_owned();
    if program_string != definition.program {
        bail!("program must be canonical absolute path");
    }
    let mut seen = std::collections::BTreeSet::new();
    for pin in &definition.script_pins {
        valid_hash(&pin.sha256)?;
        if !seen.insert(&pin.path) || bounded_hash(&safe_file(root, &pin.path)?)? != pin.sha256 {
            bail!("script pin mismatch");
        }
    }
    Ok((program_string, bounded_hash(&program)?))
}
fn check(
    db: &Database,
    plugin: &str,
    session: &str,
    project: &str,
    id: &str,
) -> Result<ApprovedCheck> {
    valid_id(id)?;
    let approved: ApprovedCheck =
        read(db, COMMAND_NS, &key(plugin, id)?)?.context("approved command not found")?;
    let root = scope(db, plugin, session, project)?;
    if approved.revoked
        || approved.session_id != session
        || Path::new(&approved.project_path) != root
    {
        bail!("approved command scope revoked or mismatched");
    }
    if validate_definition(&root, &approved.definition)?.1 != approved.program_sha256 {
        bail!("approved executable changed");
    }
    Ok(approved)
}

/// Resolve only the session already frozen in this plugin's native grant.
pub fn resolve_check(
    db: &Database,
    plugin: &str,
    command_id: &str,
    project: &str,
) -> Result<ApprovedCheck> {
    valid_id(plugin)?;
    valid_id(command_id)?;
    let saved: ApprovedCheck =
        read(db, COMMAND_NS, &key(plugin, command_id)?)?.context("approved command not found")?;
    check(db, plugin, &saved.session_id, project, command_id)
}

/// Existing executions remain queryable/cancellable after grant revocation or input drift.
pub fn execution_session(
    db: &Database,
    plugin: &str,
    execution_id: &str,
    command_id: &str,
    project: &str,
) -> Result<Option<String>> {
    let saved = read::<ExecutionRecord>(db, EXECUTION_NS, &key(plugin, execution_id)?)?;
    saved
        .map(|record| {
            if record.plugin_id != plugin
                || record.request.command_id != command_id
                || record.request.project_path != project
            {
                bail!("execution scope mismatch");
            }
            scope(db, plugin, &record.request.session_id, project)?;
            Ok(record.request.session_id)
        })
        .transpose()
}

fn guard_inputs(check: &ApprovedCheck) -> Result<Vec<fs::File>> {
    use std::io::Read;
    let root = Path::new(&check.project_path);
    let mut paths = vec![(
        PathBuf::from(&check.definition.program),
        check.program_sha256.clone(),
    )];
    for pin in &check.definition.script_pins {
        paths.push((safe_file(root, &pin.path)?, pin.sha256.clone()));
    }
    let mut guards = vec![];
    for (path, expected) in paths {
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // FILE_SHARE_READ only: keep the approved bytes immutable while running.
            options.share_mode(1);
        }
        let file = options.open(path)?;
        let mut bytes = vec![];
        file.try_clone()?
            .take(MAX_INPUT + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_INPUT || hash(&bytes) != expected {
            bail!("guarded input changed before admission");
        }
        guards.push(file);
    }
    Ok(guards)
}

/// The same map must be passed with env_clear to the process runner.
pub fn approved_environment() -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for name in [
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "PATH",
        "PATHEXT",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TZ",
    ] {
        if let Ok(value) = std::env::var(name) {
            env.insert(name.to_owned(), value);
        }
    }
    env
}
pub fn begin_approval(
    db: &Database,
    plugin: &str,
    session: &str,
    project: &str,
    mut definition: CommandDefinition,
) -> Result<ApprovalChallenge> {
    let root = scope(db, plugin, session, project)?;
    if !Path::new(&definition.program).is_absolute() {
        bail!("program must be absolute");
    }
    definition.program = fs::canonicalize(&definition.program)?
        .to_string_lossy()
        .into_owned();
    let (_, program_sha256) = validate_definition(&root, &definition)?;
    let project_path = root.to_string_lossy().into_owned();
    let digest = digest(&(plugin, session, &project_path, &definition, &program_sha256))?;
    let check = ApprovedCheck {
        command_id: uuid::Uuid::new_v4().to_string(),
        plugin_id: plugin.into(),
        session_id: session.into(),
        project_path,
        definition,
        program_sha256,
        digest,
        revoked: false,
    };
    let challenge = ApprovalChallenge {
        token: uuid::Uuid::new_v4().to_string(),
        check,
        challenge_expires_at: now_ms() + 120_000,
    };
    let mut stored = challenge.clone();
    stored.token.clear();
    put(db, APPROVAL_NS, &hash(challenge.token.as_bytes()), &stored)?;
    Ok(challenge)
}
pub fn approve_check(db: &Database, token: &str) -> Result<ApprovedCheck> {
    valid_id(token)?;
    let tx = db.conn().unchecked_transaction()?;
    let proof = hash(token.as_bytes());
    let challenge: ApprovalChallenge =
        read(db, APPROVAL_NS, &proof)?.context("approval challenge unavailable")?;
    if challenge.challenge_expires_at < now_ms() {
        bail!("approval challenge expired");
    }
    let c = &challenge.check;
    let root = scope(db, &c.plugin_id, &c.session_id, &c.project_path)?;
    if validate_definition(&root, &c.definition)?.1 != c.program_sha256 {
        bail!("approval inputs changed");
    }
    if db.conn().execute(
        "DELETE FROM kv WHERE ns=?1 AND key=?2",
        params![APPROVAL_NS, proof],
    )? != 1
    {
        bail!("approval already consumed");
    }
    put(db, COMMAND_NS, &key(&c.plugin_id, &c.command_id)?, c)?;
    tx.commit()?;
    Ok(challenge.check)
}

fn git(root: &Path, args: &[&str], env: &BTreeMap<String, String>) -> Result<Vec<u8>> {
    let path = env
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| value)
        .context("Git PATH unavailable")?;
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    let executable = std::env::split_paths(path)
        .filter_map(|dir| {
            if !dir.is_absolute() {
                return None;
            }
            let candidate = fs::canonicalize(dir.join(name)).ok()?;
            if candidate.starts_with(root) || !candidate.is_file() {
                return None;
            }
            Some(candidate)
        })
        .next()
        .context("trusted Git executable unavailable")?;
    // ls-files must not run a workspace-configured fsmonitor hook.
    let result = Command::new(executable)
        .args([
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
        ])
        .args(args)
        .current_dir(root)
        .env_clear()
        .envs(env)
        .output()?;
    if !result.status.success() || result.stdout.len() > 8 * 1024 * 1024 {
        bail!("Git snapshot unavailable or exceeds limit");
    }
    Ok(result.stdout)
}
fn snapshot_with_environment(
    db: &Database,
    plugin: &str,
    session: &str,
    project: &str,
    command_id: Option<&str>,
    env: &BTreeMap<String, String>,
) -> Result<CodeSnapshot> {
    let root = scope(db, plugin, session, project)?;
    let approved = command_id
        .map(|id| check(db, plugin, session, project, id))
        .transpose()?;
    let top = String::from_utf8(git(&root, &["rev-parse", "--show-toplevel"], env)?)?;
    if fs::canonicalize(top.trim())? != root {
        bail!("approved workspace must be Git repository root");
    }
    let base_commit = String::from_utf8(git(&root, &["rev-parse", "--verify", "HEAD"], env)?)?
        .trim()
        .to_owned();
    let names = git(
        &root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
        env,
    )?;
    let mut inputs = BTreeMap::new();
    let mut total = 0u64;
    for name in names.split(|b| *b == 0).filter(|b| !b.is_empty()) {
        let relative = std::str::from_utf8(name)?;
        let path = root.join(relative);
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            if metadata.file_type().is_symlink() {
                bail!("symlink input is not allowed");
            }
        }
        if !path.exists() {
            inputs.insert(relative.to_owned(), "deleted".to_owned());
            continue;
        }
        let safe = safe_file(&root, relative)?;
        total = total
            .checked_add(fs::metadata(&safe)?.len())
            .context("snapshot overflow")?;
        if total > MAX_INPUT || inputs.len() >= 100_000 {
            bail!("workspace snapshot exceeds limit");
        }
        inputs.insert(relative.to_owned(), bounded_hash(&safe)?);
    }
    Ok(CodeSnapshot {
        base_commit,
        worktree_hash: digest(&inputs)?,
        environment_hash: digest(&(env, approved.map(|c| (c.definition, c.program_sha256))))?,
    })
}
pub fn snapshot(
    db: &Database,
    plugin: &str,
    session: &str,
    project: &str,
    command_id: Option<&str>,
) -> Result<CodeSnapshot> {
    snapshot_with_environment(
        db,
        plugin,
        session,
        project,
        command_id,
        &approved_environment(),
    )
}
pub fn prepare_execution(
    db: &Database,
    plugin: &str,
    request: RunRequest,
) -> Result<ExecutionAdmission> {
    valid_id(&request.execution_id)?;
    valid_id(&request.identity.spec_id)?;
    valid_id(&request.identity.artifact_id)?;
    valid_hash(&request.identity.content_hash)?;
    if request.identity.spec_version == 0 || request.identity.artifact_revision == 0 {
        bail!("invalid exact verification version");
    }
    let request_digest = digest(&request)?;
    let execution_key = key(plugin, &request.execution_id)?;
    let tx = db.conn().unchecked_transaction()?;
    if let Some(saved) = read::<ExecutionRecord>(db, EXECUTION_NS, &execution_key)? {
        if saved.receipt.request_digest != request_digest {
            bail!("execution identity conflicts with saved request");
        }
        scope(db, plugin, &request.session_id, &request.project_path)?;
        tx.commit()?;
        return Ok(ExecutionAdmission {
            start: false,
            claim_token: None,
            check: None,
            environment: BTreeMap::new(),
            receipt: saved.receipt,
            input_guards: vec![],
        });
    }
    let approved = check(
        db,
        plugin,
        &request.session_id,
        &request.project_path,
        &request.command_id,
    )?;
    let input_guards = guard_inputs(&approved)?;
    let environment = approved_environment();
    let measured = snapshot_with_environment(
        db,
        plugin,
        &request.session_id,
        &request.project_path,
        Some(&request.command_id),
        &environment,
    )?;
    if measured != request.before_snapshot {
        bail!("execution before snapshot changed");
    }
    let claim_token = uuid::Uuid::new_v4().to_string();
    let mut command = vec![approved.definition.program.clone()];
    command.extend(approved.definition.args.clone());
    let receipt = ExecutionReceipt {
        execution_id: request.execution_id.clone(),
        request_digest,
        state: "executing".into(),
        command,
        before_snapshot: measured,
        after_snapshot: None,
        exit_code: None,
        output: vec![],
        output_sha256: None,
        completed_at: None,
        cancel_requested: false,
        incomplete_reason: None,
    };
    let record = ExecutionRecord {
        request,
        plugin_id: plugin.into(),
        claim_hash: hash(claim_token.as_bytes()),
        receipt: receipt.clone(),
        environment: environment.clone(),
    };
    db.conn().execute(
        "INSERT INTO kv(ns,key,value_json,updated_at) VALUES(?1,?2,?3,?4)",
        params![
            EXECUTION_NS,
            execution_key,
            serde_json::to_string(&record)?,
            now_ms()
        ],
    )?;
    tx.commit()?;
    Ok(ExecutionAdmission {
        start: true,
        claim_token: Some(claim_token),
        check: Some(approved),
        environment,
        receipt,
        input_guards,
    })
}
pub fn lookup_execution(
    db: &Database,
    plugin: &str,
    request: &RunRequest,
) -> Result<Option<ExecutionReceipt>> {
    scope(db, plugin, &request.session_id, &request.project_path)?;
    let saved = read::<ExecutionRecord>(db, EXECUTION_NS, &key(plugin, &request.execution_id)?)?;
    saved
        .map(|r| {
            if r.receipt.request_digest != digest(request)? {
                bail!("execution lookup request conflict");
            }
            Ok(r.receipt)
        })
        .transpose()
}
pub fn request_cancel(
    db: &Database,
    plugin: &str,
    request: &RunRequest,
) -> Result<ExecutionReceipt> {
    let tx = db.conn().unchecked_transaction()?;
    lookup_execution(db, plugin, request)?.context("execution not found")?;
    let k = key(plugin, &request.execution_id)?;
    let mut saved: ExecutionRecord = read(db, EXECUTION_NS, &k)?.context("execution not found")?;
    saved.receipt.cancel_requested = true;
    put(db, EXECUTION_NS, &k, &saved)?;
    tx.commit()?;
    Ok(saved.receipt)
}
pub fn settle_execution(
    db: &Database,
    claim_token: &str,
    outcome: ProcessOutcome,
) -> Result<ExecutionReceipt> {
    valid_id(claim_token)?;
    let tx = db.conn().unchecked_transaction()?;
    let mut statement = db
        .conn()
        .prepare("SELECT key,value_json FROM kv WHERE ns=?1")?;
    let rows = statement.query_map(params![EXECUTION_NS], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let claim_hash = hash(claim_token.as_bytes());
    let mut found = None;
    for row in rows {
        let (k, v) = row?;
        let record: ExecutionRecord = serde_json::from_str(&v)?;
        if record.claim_hash == claim_hash {
            found = Some((k, record));
            break;
        }
    }
    drop(statement);
    let (k, mut record) = found.context("execution claim unavailable")?;
    if record.receipt.state != "executing" {
        bail!("execution already settled");
    }
    let approved = check(
        db,
        &record.plugin_id,
        &record.request.session_id,
        &record.request.project_path,
        &record.request.command_id,
    );
    let limit = approved
        .as_ref()
        .map(|c| c.definition.max_output_bytes)
        .unwrap_or(MAX_OUTPUT);
    let limited = outcome.output.len() > limit;
    let mut output = outcome.output;
    output.truncate(limit);
    record.receipt.output_sha256 = Some(hash(&output));
    record.receipt.output = output;
    record.receipt.exit_code = outcome.exit_code;
    let after = snapshot_with_environment(
        db,
        &record.plugin_id,
        &record.request.session_id,
        &record.request.project_path,
        Some(&record.request.command_id),
        &record.environment,
    );
    let completed = outcome.termination == "completed"
        && outcome.exit_code.is_some()
        && !limited
        && !record.receipt.cancel_requested
        && approved.is_ok()
        && after.is_ok();
    record.receipt.state = if completed {
        "completed"
    } else if outcome.termination == "unknown" {
        "unknown"
    } else {
        "incomplete"
    }
    .into();
    record.receipt.incomplete_reason = if completed {
        None
    } else {
        Some(if limited {
            "output_limited".into()
        } else if record.receipt.cancel_requested {
            "cancel_requested".into()
        } else if approved.is_err() || after.is_err() {
            "after_snapshot_unavailable".into()
        } else {
            outcome.termination
        })
    };
    record.receipt.after_snapshot = after.ok();
    record.receipt.completed_at = Some(crate::db::ms_to_ts(now_ms()));
    put(db, EXECUTION_NS, &k, &record)?;
    tx.commit()?;
    Ok(record.receipt)
}
pub fn revoke_check(db: &Database, plugin: &str, command_id: &str) -> Result<ApprovedCheck> {
    let tx = db.conn().unchecked_transaction()?;
    let k = key(plugin, command_id)?;
    let mut check: ApprovedCheck =
        read(db, COMMAND_NS, &k)?.context("approved command not found")?;
    check.revoked = true;
    put(db, COMMAND_NS, &k, &check)?;
    tx.commit()?;
    Ok(check)
}

/// Startup maintenance only: the previous Host no longer owns these processes.
/// Preserve saved facts and exact identities; never recreate a launch admission.
pub fn recover(db: &Database) -> Result<usize> {
    let tx = db.conn().unchecked_transaction()?;
    let mut statement = db
        .conn()
        .prepare("SELECT key,value_json FROM kv WHERE ns=?1")?;
    let rows = statement.query_map(params![EXECUTION_NS], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut pending = Vec::new();
    for row in rows {
        let (key, value) = row?;
        let mut record: ExecutionRecord = serde_json::from_str(&value)?;
        if record.receipt.state == "executing" {
            record.receipt.state = "unknown".into();
            record.receipt.incomplete_reason = Some("cold_restart".into());
            // A stale coordinator cannot settle a process after startup recovery.
            record.claim_hash = hash(uuid::Uuid::new_v4().as_bytes());
            pending.push((key, record));
        }
    }
    drop(statement);
    for (key, record) in &pending {
        put(db, EXECUTION_NS, key, record)?;
    }
    tx.commit()?;
    Ok(pending.len())
}

#[cfg(test)]
#[path = "plugin_verification/tests.rs"]
mod tests;
