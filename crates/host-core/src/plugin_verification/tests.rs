use super::*;
fn fixture() -> (tempfile::TempDir, Database, String, CommandDefinition) {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let root = fs::canonicalize(workspace)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let db = Database::open_in_dir(&temp.path().join("profile")).unwrap();
    db.conn()
        .execute(
            "INSERT INTO projects(id,path,name,created_at,last_opened_at) VALUES(1,?1,'check',0,0)",
            params![root],
        )
        .unwrap();
    db.conn()
        .execute(
            "INSERT INTO sessions(id,project_id,created_at,updated_at) VALUES('session',1,0,0)",
            [],
        )
        .unwrap();
    db.conn().execute("INSERT INTO plugin_automation_sessions(session_id,plugin_id,created_at) VALUES('session','plugin',0)",[]).unwrap();
    fs::write(Path::new(&root).join("check.js"), b"original").unwrap();
    let definition = CommandDefinition {
        program: fs::canonicalize(std::env::current_exe().unwrap())
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        args: vec![],
        script_pins: vec![ScriptPin {
            path: "check.js".into(),
            sha256: hash(b"original"),
        }],
        timeout_ms: 1000,
        max_output_bytes: 1024,
        expires_at: now_ms() + 60_000,
    };
    (temp, db, root, definition)
}
#[test]
fn approval_is_single_use_scoped_and_revocable() {
    let (_temp, db, root, definition) = fixture();
    assert!(begin_approval(&db, "foreign", "session", &root, definition.clone()).is_err());
    let challenge = begin_approval(&db, "plugin", "session", &root, definition).unwrap();
    let persisted: ApprovalChallenge = read(&db, APPROVAL_NS, &hash(challenge.token.as_bytes()))
        .unwrap()
        .unwrap();
    assert!(persisted.token.is_empty());
    assert!(approve_check(&db, "invented-authorization").is_err());
    let approved = approve_check(&db, &challenge.token).unwrap();
    assert!(approve_check(&db, &challenge.token).is_err());
    assert!(check(&db, "plugin", "session", &root, &approved.command_id).is_ok());
    revoke_check(&db, "plugin", &approved.command_id).unwrap();
    assert!(check(&db, "plugin", "session", &root, &approved.command_id).is_err());
}
#[test]
fn changed_script_cannot_consume_approval_or_escape_root() {
    let (_temp, db, root, definition) = fixture();
    let challenge = begin_approval(&db, "plugin", "session", &root, definition).unwrap();
    fs::write(Path::new(&root).join("check.js"), b"changed").unwrap();
    assert!(approve_check(&db, &challenge.token).is_err());
    assert!(safe_file(Path::new(&root), "../profile/pi.sqlite").is_err());
    assert!(safe_file(Path::new(&root), ".").is_err());
}
#[test]
fn persisted_unknown_execution_is_never_relaunched_and_conflicts_fail() {
    let (temp, db, root, definition) = fixture();
    let request = admitted_request(&db, &root, definition);
    let admitted = prepare_execution(&db, "plugin", request.clone()).unwrap();
    assert!(admitted.start);
    assert_eq!(admitted.receipt.state, "executing");
    let old_claim = admitted.claim_token.clone().unwrap();
    drop(admitted);
    drop(db);
    let reopened = Database::open_in_dir(&temp.path().join("profile")).unwrap();
    assert_eq!(
        lookup_execution(&reopened, "plugin", &request)
            .unwrap()
            .unwrap()
            .state,
        "executing"
    );
    assert_eq!(recover(&reopened).unwrap(), 1);
    assert_eq!(recover(&reopened).unwrap(), 0);
    let replay = prepare_execution(&reopened, "plugin", request.clone()).unwrap();
    assert!(!replay.start);
    assert!(replay.claim_token.is_none());
    assert_eq!(replay.receipt.state, "unknown");
    assert_eq!(
        replay.receipt.incomplete_reason.as_deref(),
        Some("cold_restart")
    );
    assert_eq!(replay.receipt.before_snapshot, request.before_snapshot);
    assert!(settle_execution(
        &reopened,
        &old_claim,
        ProcessOutcome {
            exit_code: Some(0),
            output: vec![],
            termination: "completed".into()
        }
    )
    .is_err());
    let mut changed = request.clone();
    changed.identity.artifact_revision = 2;
    assert!(prepare_execution(&reopened, "plugin", changed).is_err());
    assert!(
        request_cancel(&reopened, "plugin", &request)
            .unwrap()
            .cancel_requested
    );
}

fn admitted_request(db: &Database, root: &str, definition: CommandDefinition) -> RunRequest {
    let env = approved_environment();
    git(Path::new(root), &["init", "--quiet", "--template="], &env).unwrap();
    let hooks = Path::new(root).join(".git").join("empty-hooks");
    fs::create_dir(&hooks).unwrap();
    git(
        Path::new(root),
        &[
            "-c",
            "user.name=Verification Test",
            "-c",
            "user.email=verification@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            &format!("core.hooksPath={}", hooks.display()),
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "Test baseline",
        ],
        &env,
    )
    .unwrap();
    let challenge = begin_approval(db, "plugin", "session", root, definition).unwrap();
    let approved = approve_check(db, &challenge.token).unwrap();
    let before = snapshot(db, "plugin", "session", root, Some(&approved.command_id)).unwrap();
    RunRequest {
        execution_id: "execution".into(),
        command_id: approved.command_id,
        session_id: "session".into(),
        project_path: root.into(),
        identity: VerificationIdentity {
            spec_id: "spec".into(),
            spec_version: 1,
            artifact_id: "artifact".into(),
            artifact_revision: 1,
            content_hash: "a".repeat(64),
        },
        before_snapshot: before,
    }
}

#[test]
fn existing_execution_lookup_and_cancel_survive_revocation_and_pin_drift() {
    let (_temp, db, root, definition) = fixture();
    let request = admitted_request(&db, &root, definition);
    let admitted = prepare_execution(&db, "plugin", request.clone()).unwrap();
    assert!(admitted.start);
    drop(admitted);
    revoke_check(&db, "plugin", &request.command_id).unwrap();
    fs::write(
        Path::new(&root).join("check.js"),
        b"changed-after-admission",
    )
    .unwrap();
    assert!(resolve_check(&db, "plugin", &request.command_id, &root).is_err());
    assert_eq!(
        execution_session(
            &db,
            "plugin",
            &request.execution_id,
            &request.command_id,
            &root
        )
        .unwrap(),
        Some("session".into())
    );
    assert_eq!(
        lookup_execution(&db, "plugin", &request)
            .unwrap()
            .unwrap()
            .state,
        "executing"
    );
    assert!(
        request_cancel(&db, "plugin", &request)
            .unwrap()
            .cancel_requested
    );
    assert!(
        execution_session(&db, "plugin", &request.execution_id, "other-command", &root).is_err()
    );
    assert!(execution_session(
        &db,
        "foreign",
        &request.execution_id,
        &request.command_id,
        &root
    )
    .unwrap()
    .is_none());
    let mut changed = request.clone();
    changed.identity.artifact_revision = 2;
    assert!(lookup_execution(&db, "plugin", &changed).is_err());
}
