use super::*;

fn user_input(session: &str, id: &str, queued: bool) -> Value {
    json!({"sessionId": session, "message": {
        "id": id, "role": "user", "content": "Next request",
        "createdAt": "2026-10-08T00:00:00Z", "status": "complete",
        "acceptedFromQueue": queued
    }})
}

fn queue_input(session: &str, id: &str) -> Value {
    json!({"sessionId": session, "id": id, "principal": "desktop",
        "idempotencyKey": id, "inputHash": id, "content": "Next request",
        "permissionMode": "default", "userMessageId": id})
}

#[tokio::test]
async fn accepted_user_input_retires_terminal_todos_without_replay_or_restart_resurrection() {
    let mut harness = Harness::new();
    let session = harness.session("agent").await;
    let turn = harness.begin_turn(&session).await;
    for status in ["completed", "cancelled"] {
        harness
            .call(
                "tools.execute",
                write_call(
                    &session,
                    &turn,
                    json!({"todos": [{"content": "Old work", "status": status}]}),
                ),
            )
            .await
            .unwrap();
        let before = harness.snapshot(&session).await;
        harness.events();
        let input = user_input(&session, status, false);
        harness
            .call("session.appendMessage", input.clone())
            .await
            .unwrap();
        let cleared = harness.snapshot(&session).await;
        assert_eq!(cleared["todos"], json!([]));
        assert_eq!(
            cleared["revision"].as_i64(),
            Some(before["revision"].as_i64().unwrap() + 1)
        );
        let emitted = harness.events();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0]["method"], "todos.changed");
        assert_eq!(emitted[0]["params"], cleared);
        harness
            .call(
                "tools.execute",
                write_call(
                    &session,
                    &turn,
                    json!({"todos": [{"content": "New work", "status": "completed"}]}),
                ),
            )
            .await
            .unwrap();
        let newer = harness.snapshot(&session).await;
        harness.events();
        harness.call("session.appendMessage", input).await.unwrap();
        assert_eq!(harness.snapshot(&session).await, newer);
        assert!(harness.events().is_empty());
    }
    harness
        .call("session.appendMessage", user_input(&session, "last", false))
        .await
        .unwrap();
    let cleared = harness.snapshot(&session).await;
    let reopened = AppState::open(harness._data_dir.path()).unwrap();
    assert!(todos::get(&reopened.db, &session)
        .unwrap()
        .unwrap()
        .todos
        .is_empty());
    assert_eq!(
        todos::get(&reopened.db, &session)
            .unwrap()
            .unwrap()
            .revision,
        cleared["revision"].as_i64().unwrap()
    );
    // Boot maintenance settles the old running turn; new work owns a new one.
    let next_turn = harness.begin_turn(&session).await;
    harness
        .call(
            "tools.execute",
            write_call(&session, &next_turn, items(&["New task"])),
        )
        .await
        .unwrap();
    assert_eq!(
        harness.snapshot(&session).await["todos"][0]["content"],
        "New task"
    );
}

#[tokio::test]
async fn unfinished_todos_and_failed_acceptance_preserve_the_snapshot() {
    let mut harness = Harness::new();
    let session = harness.session("agent").await;
    let turn = harness.begin_turn(&session).await;
    for status in ["pending", "in_progress"] {
        harness
            .call(
                "tools.execute",
                write_call(
                    &session,
                    &turn,
                    json!({"todos": [{"content": "Keep", "status": status},
                {"content": "Done", "status": "completed"}]}),
                ),
            )
            .await
            .unwrap();
        let before = harness.snapshot(&session).await;
        harness.events();
        harness
            .call("session.appendMessage", user_input(&session, status, false))
            .await
            .unwrap();
        assert_eq!(harness.snapshot(&session).await, before);
        assert!(harness.events().is_empty());
    }
    harness
        .call(
            "tools.execute",
            write_call(
                &session,
                &turn,
                json!({"todos": [{"content": "Keep", "status": "completed"}]}),
            ),
        )
        .await
        .unwrap();
    let before = harness.snapshot(&session).await;
    harness.events();
    {
        let st = harness.state.lock().await;
        st.db
            .conn()
            .execute_batch(
                "CREATE TRIGGER reject_user BEFORE INSERT ON messages
            WHEN NEW.role = 'user' BEGIN SELECT RAISE(ABORT, 'injected append failure'); END;",
            )
            .unwrap();
    }
    assert!(harness
        .call(
            "session.appendMessage",
            user_input(&session, "failed", false)
        )
        .await
        .is_err());
    assert_eq!(harness.snapshot(&session).await, before);
    assert!(harness.events().is_empty());
    {
        let st = harness.state.lock().await;
        st.db
            .conn()
            .execute_batch(
                "DROP TRIGGER reject_user;
            CREATE TRIGGER reject_retirement BEFORE DELETE ON session_todo
            BEGIN SELECT RAISE(ABORT, 'injected retirement failure'); END;",
            )
            .unwrap();
    }
    assert!(harness
        .call(
            "session.appendMessage",
            user_input(&session, "rollback", false)
        )
        .await
        .is_err());
    assert!(harness
        .call("session.queuePush", queue_input(&session, "rollback-queue"))
        .await
        .is_err());
    assert_eq!(harness.snapshot(&session).await, before);
    let st = harness.state.lock().await;
    assert_eq!(
        st.db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE id = 'rollback'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert!(crate::turn_queue::list(&st.db, Some(&session))
        .unwrap()
        .is_empty());
    drop(st);
    assert!(harness.events().is_empty());
}

#[tokio::test]
async fn collaboration_input_does_not_cross_the_user_todo_boundary() {
    let mut harness = Harness::new();
    let session = harness.session("agent").await;
    let source = harness.session("agent").await;
    let turn = harness.begin_turn(&session).await;
    harness
        .call(
            "tools.execute",
            write_call(
                &session,
                &turn,
                json!({"todos": [{"content": "Human task", "status": "completed"}]}),
            ),
        )
        .await
        .unwrap();
    let before = harness.snapshot(&session).await;
    harness.events();
    let (message_id, collab_turn) = {
        let st = harness.state.lock().await;
        sessions::end_turn(&st.db, &turn, "completed", None, None, false).unwrap();
        let result = crate::session_collaboration::handle(
            &st.db,
            "session.collaboration.send",
            &json!({"sessionId": session, "sourceSessionId": source,
                "pluginId": "pi.session-orchestrator", "content": "Review the change",
                "idempotencyKey": "collab", "kind": "task"}),
        )
        .unwrap();
        let id = result["message"]["id"].as_str().unwrap().to_string();
        let turn =
            crate::session_collaboration::begin_turn(&st.db, &session, &id, None, None).unwrap();
        (id, turn)
    };
    let mut queued = queue_input(&session, "collab-queue");
    queued["sessionMessageId"] = json!(message_id);
    harness.call("session.queuePush", queued).await.unwrap();
    let mut input = user_input(&session, "collab-user", false);
    input["turnId"] = json!(collab_turn);
    input["message"]["content"] = json!("Review the change");
    harness.call("session.appendMessage", input).await.unwrap();
    assert_eq!(harness.snapshot(&session).await, before);
    assert!(harness.events().is_empty());
}

#[tokio::test]
async fn queue_acceptance_retires_once_and_delivery_cannot_retire_later_todos() {
    let mut harness = Harness::new();
    let session = harness.session("agent").await;
    let turn = harness.begin_turn(&session).await;
    harness
        .call(
            "tools.execute",
            write_call(
                &session,
                &turn,
                json!({"todos": [{"content": "Done", "status": "completed"}]}),
            ),
        )
        .await
        .unwrap();
    harness.events();
    let queued = queue_input(&session, "queued");
    harness
        .call("session.queuePush", queued.clone())
        .await
        .unwrap();
    assert_eq!(harness.snapshot(&session).await["todos"], json!([]));
    assert_eq!(harness.events().len(), 1);
    harness
        .call(
            "tools.execute",
            write_call(
                &session,
                &turn,
                json!({"todos": [{"content": "Later result", "status": "completed"}]}),
            ),
        )
        .await
        .unwrap();
    let later = harness.snapshot(&session).await;
    harness.events();
    harness
        .call("session.queuePush", queued.clone())
        .await
        .unwrap();
    let mut conflict = queued;
    conflict["inputHash"] = json!("different");
    assert!(harness.call("session.queuePush", conflict).await.is_err());
    harness
        .call("session.queueRemove", json!({"id": "queued"}))
        .await
        .unwrap();
    harness
        .call(
            "session.appendMessage",
            user_input(&session, "queued", true),
        )
        .await
        .unwrap();
    assert_eq!(harness.snapshot(&session).await, later);
    assert!(harness.events().is_empty());
    // Queueing while work is unfinished must not discard it at admission
    // or later dequeue, even if it has become terminal in the meantime.
    harness
        .call(
            "tools.execute",
            write_call(&session, &turn, items(&["Working"])),
        )
        .await
        .unwrap();
    let unfinished = harness.snapshot(&session).await;
    harness
        .call("session.queuePush", queue_input(&session, "waiting"))
        .await
        .unwrap();
    assert_eq!(harness.snapshot(&session).await, unfinished);
    harness
        .call(
            "tools.execute",
            write_call(
                &session,
                &turn,
                json!({"todos": [{"content": "Working", "status": "completed"}]}),
            ),
        )
        .await
        .unwrap();
    let finished = harness.snapshot(&session).await;
    harness
        .call(
            "session.appendMessage",
            user_input(&session, "waiting", true),
        )
        .await
        .unwrap();
    assert_eq!(harness.snapshot(&session).await, finished);
}
