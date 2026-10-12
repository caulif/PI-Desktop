use super::{AdmissionError, ToolBudget, ToolPermit, MAX_QUEUED_TOOLS};
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};
use std::time::Duration;

// A first poll is the synchronization point: the request has entered the
// admission queue, but no executor timing or wall-clock delay is involved.
fn poll_once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    future.poll(&mut Context::from_waker(Waker::noop()))
}

fn admitted<F>(future: Pin<&mut F>) -> ToolPermit
where
    F: Future<Output = Result<ToolPermit, AdmissionError>>,
{
    match poll_once(future) {
        Poll::Ready(Ok(permit)) => permit,
        Poll::Ready(Err(error)) => panic!("unexpected admission failure: {error:?}"),
        Poll::Pending => panic!("request with available capacity must be admitted"),
    }
}

#[tokio::test]
async fn limits_shell_concurrency_and_reports_active_work() {
    let budget = ToolBudget::new();
    let mut permits = Vec::new();
    for index in 0..4 {
        permits.push(
            budget
                .acquire(&format!("session-{index}"), "Bash")
                .await
                .unwrap(),
        );
    }
    let snapshot = budget.snapshot();
    assert_eq!(snapshot.active, 4);
    assert_eq!(snapshot.shell, 4);
    assert_eq!(snapshot.queued, 0);

    let mut waiter = Box::pin(budget.acquire("session-waiter", "Bash"));
    assert!(poll_once(waiter.as_mut()).is_pending());
    drop(permits);
    drop(admitted(waiter.as_mut()));
    assert_eq!(budget.snapshot().active, 0);
}

#[tokio::test]
async fn separates_session_capacity() {
    let budget = ToolBudget::new();
    let mut first = Vec::new();
    for _ in 0..4 {
        first.push(budget.acquire("session-a", "Read").await.unwrap());
    }
    let second = budget.acquire("session-b", "Read").await;
    assert!(second.is_ok());
    let mut waiter = Box::pin(budget.acquire("session-a", "Read"));
    assert!(poll_once(waiter.as_mut()).is_pending());
    drop(first);
    drop(admitted(waiter.as_mut()));
}

#[tokio::test]
async fn serializes_mutations_within_a_session() {
    let budget = ToolBudget::new();
    let first = budget.acquire("session-a", "Edit").await.unwrap();
    let mut waiter = Box::pin(budget.acquire("session-a", "Write"));
    assert!(poll_once(waiter.as_mut()).is_pending());
    assert_eq!(budget.snapshot().mutations, 1);

    drop(first);
    drop(admitted(waiter.as_mut()));
    assert_eq!(budget.snapshot().mutations, 0);
}

#[tokio::test]
async fn shell_backlog_does_not_reserve_global_capacity() {
    let budget = ToolBudget::new();
    let mut running = Vec::new();
    for index in 0..4 {
        running.push(
            budget
                .acquire(&format!("running-{index}"), "Bash")
                .await
                .unwrap(),
        );
    }
    let mut waiting = Vec::new();
    for _ in 0..12 {
        let mut request = Box::pin(budget.acquire("shell-backlog", "Bash"));
        assert!(poll_once(request.as_mut()).is_pending());
        waiting.push(request);
    }
    let snapshot = budget.snapshot();
    assert_eq!(snapshot.active, 4);
    assert_eq!(snapshot.shell, 4);
    assert_eq!(snapshot.queued, 12);

    let read = admitted(Box::pin(budget.acquire("interactive", "Read")).as_mut());
    let write = admitted(Box::pin(budget.acquire("interactive", "Write")).as_mut());
    assert_eq!(budget.snapshot().active, 6);
    assert_eq!(budget.snapshot().queued, 12);
    drop((read, write, waiting, running));
    assert_eq!(budget.snapshot().active, 0);
    assert_eq!(budget.snapshot().queued, 0);
}

#[tokio::test]
async fn session_backlog_does_not_reserve_read_capacity() {
    let budget = ToolBudget::new();
    let mut running = Vec::new();
    for _ in 0..4 {
        running.push(budget.acquire("busy", "Read").await.unwrap());
    }
    let mut waiting = Vec::new();
    for _ in 0..4 {
        let mut request = Box::pin(budget.acquire("busy", "Read"));
        assert!(poll_once(request.as_mut()).is_pending());
        waiting.push(request);
    }
    assert_eq!(budget.snapshot().reads, 4);
    assert_eq!(budget.snapshot().active, 4);
    assert_eq!(budget.snapshot().queued, 4);
    let read = admitted(Box::pin(budget.acquire("other", "Read")).as_mut());
    drop((read, waiting, running));
    assert_eq!(budget.snapshot().queued, 0);
}

#[tokio::test]
async fn class_backlog_does_not_reserve_session_capacity() {
    let budget = ToolBudget::new();
    let mut running = Vec::new();
    for index in 0..4 {
        running.push(
            budget
                .acquire(&format!("shell-{index}"), "Bash")
                .await
                .unwrap(),
        );
    }
    let mut waiting = Vec::new();
    for _ in 0..4 {
        let mut request = Box::pin(budget.acquire("busy", "Bash"));
        assert!(poll_once(request.as_mut()).is_pending());
        waiting.push(request);
    }
    let read = admitted(Box::pin(budget.acquire("busy", "Read")).as_mut());
    assert_eq!(budget.snapshot().active, 5);
    assert_eq!(budget.snapshot().queued, 4);
    drop((read, waiting, running));
}

#[tokio::test]
async fn cancelling_waiter_removes_queue_entry_and_releases_capacity() {
    let budget = ToolBudget::new();
    let mut running = Vec::new();
    for index in 0..4 {
        running.push(
            budget
                .acquire(&format!("shell-{index}"), "Bash")
                .await
                .unwrap(),
        );
    }
    let mut waiter = Box::pin(budget.acquire("cancelled", "Bash"));
    assert!(poll_once(waiter.as_mut()).is_pending());
    assert_eq!(budget.snapshot().queued, 1);
    drop(waiter);
    assert_eq!(budget.snapshot().queued, 0);
    assert_eq!(budget.snapshot().active, 4);
    drop(running);
    assert_eq!(budget.snapshot().active, 0);
}

#[tokio::test]
async fn cancelling_notified_waiter_returns_reserved_capacity() {
    let budget = ToolBudget::new();
    let mut running = Vec::new();
    for index in 0..4 {
        running.push(
            budget
                .acquire(&format!("shell-{index}"), "Bash")
                .await
                .unwrap(),
        );
    }
    let mut waiter = Box::pin(budget.acquire("cancelled", "Bash"));
    assert!(poll_once(waiter.as_mut()).is_pending());
    drop(running);
    // Cancellation must also work after a release has notified the waiter,
    // before the executor polls it to return the admitted permit.
    drop(waiter);
    assert_eq!(budget.snapshot().active, 0);
    assert_eq!(budget.snapshot().queued, 0);
    assert_eq!(budget.snapshot().shell, 0);

    let mut recovered = Vec::new();
    for index in 0..4 {
        recovered.push(admitted(
            Box::pin(budget.acquire(&format!("recovered-{index}"), "Bash")).as_mut(),
        ));
    }
    assert_eq!(budget.snapshot().active, 4);
}

#[tokio::test]
async fn global_capacity_is_released_without_reserving_waiting_class() {
    let budget = ToolBudget::new();
    let mut running = Vec::new();
    for (session, tool, count) in [
        ("reads-a", "Read", 4),
        ("reads-b", "Glob", 4),
        ("shells", "Bash", 4),
        ("plugins", "custom_tool", 4),
    ] {
        for _ in 0..count {
            running.push(budget.acquire(session, tool).await.unwrap());
        }
    }
    assert_eq!(budget.snapshot().active, 16);
    let mut waiter = Box::pin(budget.acquire("mutator", "Write"));
    assert!(poll_once(waiter.as_mut()).is_pending());
    assert_eq!(budget.snapshot().active, 16);
    assert_eq!(budget.snapshot().mutations, 0);
    drop(running.pop());
    let admitted = admitted(waiter.as_mut());
    assert_eq!(budget.snapshot().active, 16);
    assert_eq!(budget.snapshot().mutations, 1);
    drop((admitted, running));
    assert_eq!(budget.snapshot().active, 0);
}

#[tokio::test]
async fn all_tool_classes_enforce_shared_alias_limits() {
    for (tool, alias, limit) in [
        ("Read", "Grep", 8),
        ("Write", "Edit", 2),
        ("Bash", "Bash", 4),
        ("plugin_first", "plugin_second", 4),
    ] {
        let budget = ToolBudget::new();
        let mut running = Vec::new();
        for index in 0..limit {
            running.push(
                budget
                    .acquire(&format!("session-{index}"), tool)
                    .await
                    .unwrap(),
            );
        }
        let mut waiter = Box::pin(budget.acquire("waiting", alias));
        assert!(poll_once(waiter.as_mut()).is_pending());
        assert_eq!(budget.snapshot().active, limit);
        assert_eq!(budget.snapshot().queued, 1);
        drop(running.pop());
        let next = admitted(waiter.as_mut());
        assert_eq!(budget.snapshot().active, limit);
        assert_eq!(budget.snapshot().queued, 0);
        drop((next, running));
    }
}

#[tokio::test]
async fn session_capacity_applies_across_classes() {
    let budget = ToolBudget::new();
    let mut running = Vec::new();
    for _ in 0..4 {
        running.push(budget.acquire("busy", "Read").await.unwrap());
    }
    let mut waiter = Box::pin(budget.acquire("busy", "Bash"));
    assert!(poll_once(waiter.as_mut()).is_pending());
    assert_eq!(budget.snapshot().shell, 0);
    let other = admitted(Box::pin(budget.acquire("other", "Bash")).as_mut());
    drop(running.pop());
    let next = admitted(waiter.as_mut());
    assert_eq!(budget.snapshot().active, 5);
    drop((next, other, running));
}

#[tokio::test]
async fn mutation_backlog_does_not_reserve_other_sessions_mutation_capacity() {
    let budget = ToolBudget::new();
    let first = budget.acquire("busy", "Write").await.unwrap();
    let mut waiter = Box::pin(budget.acquire("busy", "Edit"));
    assert!(poll_once(waiter.as_mut()).is_pending());
    let other = admitted(Box::pin(budget.acquire("other", "Write")).as_mut());
    assert_eq!(budget.snapshot().mutations, 2);
    drop(first);
    let next = admitted(waiter.as_mut());
    assert_eq!(budget.snapshot().mutations, 2);
    drop((next, other));
}

#[tokio::test]
async fn bounded_queue_rejects_overflow_and_recovers_after_cancellation() {
    let budget = ToolBudget::new();
    let mut running = Vec::new();
    for index in 0..4 {
        running.push(
            budget
                .acquire(&format!("running-{index}"), "Bash")
                .await
                .unwrap(),
        );
    }
    let mut waiting = Vec::new();
    for _ in 0..MAX_QUEUED_TOOLS {
        let mut request = Box::pin(budget.acquire("waiting", "Bash"));
        assert!(poll_once(request.as_mut()).is_pending());
        waiting.push(request);
    }
    assert_eq!(budget.snapshot().queued, MAX_QUEUED_TOOLS);
    let mut overflow = Box::pin(budget.acquire("overflow", "Bash"));
    match poll_once(overflow.as_mut()) {
        Poll::Ready(Err(error @ AdmissionError::QueueFull { queue_depth })) => {
            assert_eq!(queue_depth, MAX_QUEUED_TOOLS + 1);
            assert_eq!(error.code(), "HOST_OVERLOADED");
        }
        _ => panic!("queue overflow must reject admission immediately"),
    }
    assert_eq!(budget.snapshot().queued, MAX_QUEUED_TOOLS);
    drop(waiting.pop());
    assert_eq!(budget.snapshot().queued, MAX_QUEUED_TOOLS - 1);
    let mut replacement = Box::pin(budget.acquire("replacement", "Bash"));
    assert!(poll_once(replacement.as_mut()).is_pending());
    assert_eq!(budget.snapshot().queued, MAX_QUEUED_TOOLS);
    drop((replacement, waiting, running));
    assert_eq!(budget.snapshot().queued, 0);
    assert_eq!(budget.snapshot().active, 0);
}

#[tokio::test]
async fn older_eligible_waiter_is_admitted_before_new_requests() {
    let budget = ToolBudget::new();
    let mut running = Vec::new();
    for index in 0..4 {
        running.push(
            budget
                .acquire(&format!("running-{index}"), "Bash")
                .await
                .unwrap(),
        );
    }
    let mut older = Box::pin(budget.acquire("older", "Bash"));
    assert!(poll_once(older.as_mut()).is_pending());
    drop(running.pop());
    let mut newer = Box::pin(budget.acquire("newer", "Bash"));
    assert!(poll_once(newer.as_mut()).is_pending());
    let old_permit = admitted(older.as_mut());
    assert_eq!(budget.snapshot().queued, 1);
    drop(old_permit);
    let new_permit = admitted(newer.as_mut());
    assert_eq!(budget.snapshot().queued, 0);
    drop((new_permit, running));
}

#[tokio::test]
async fn timeout_removes_only_its_queue_entry_and_preserves_running_capacity() {
    let budget = ToolBudget::new();
    let mut running = Vec::new();
    for index in 0..4 {
        running.push(
            budget
                .acquire(&format!("running-{index}"), "Bash")
                .await
                .unwrap(),
        );
    }
    let mut older = Box::pin(budget.acquire("older", "Bash"));
    assert!(poll_once(older.as_mut()).is_pending());
    let result = budget
        .acquire_with_timeout("timed-out", "Bash", Duration::ZERO)
        .await;
    match result {
        Err(error @ AdmissionError::QueueWaitTimeout) => {
            assert_eq!(error.code(), "HOST_OVERLOADED");
        }
        _ => panic!("exhausted capacity must time out without admission"),
    }
    assert_eq!(budget.snapshot().queued, 1);
    assert_eq!(budget.snapshot().active, 4);
    assert_eq!(budget.snapshot().shell, 4);
    drop(running.pop());
    let permit = admitted(older.as_mut());
    assert_eq!(budget.snapshot().queued, 0);
    drop((permit, running));
    assert_eq!(budget.snapshot().active, 0);
}

#[tokio::test]
async fn dispatch_skips_a_blocked_class_for_the_oldest_runnable_request() {
    let budget = ToolBudget::new();
    let mut running = Vec::new();
    for (session, tool) in [
        ("reads-a", "Read"),
        ("reads-b", "Read"),
        ("shells", "Bash"),
        ("plugins", "plugin_tool"),
    ] {
        for _ in 0..4 {
            running.push(budget.acquire(session, tool).await.unwrap());
        }
    }
    let mut shell = Box::pin(budget.acquire("queued-shell", "Bash"));
    let mut write = Box::pin(budget.acquire("queued-write", "Write"));
    assert!(poll_once(shell.as_mut()).is_pending());
    assert!(poll_once(write.as_mut()).is_pending());
    drop(running.pop());
    let write_permit = admitted(write.as_mut());
    assert!(poll_once(shell.as_mut()).is_pending());
    assert_eq!(budget.snapshot().active, 16);
    assert_eq!(budget.snapshot().queued, 1);
    assert_eq!(budget.snapshot().mutations, 1);
    // Release a shell, rather than another plugin, to unblock the older call.
    drop(running.remove(8));
    let shell_permit = admitted(shell.as_mut());
    assert_eq!(budget.snapshot().active, 16);
    assert_eq!(budget.snapshot().queued, 0);
    drop((write_permit, shell_permit, running));
    assert_eq!(budget.snapshot().active, 0);
}

fn resource(key: &str, exclusive: bool) -> super::FileResource {
    super::FileResource {
        key: key.into(),
        exclusive,
    }
}

#[tokio::test]
async fn resource_readers_share_and_older_writer_prevents_reader_starvation() {
    let budget = ToolBudget::new();
    let a = budget
        .acquire_resources("a", "Read", vec![resource("file", false)])
        .await
        .unwrap();
    let b = budget
        .acquire_resources("b", "Read", vec![resource("file", false)])
        .await
        .unwrap();
    let mut writer = Box::pin(budget.acquire_resources("c", "Write", vec![resource("file", true)]));
    assert!(poll_once(writer.as_mut()).is_pending());
    let mut reader = Box::pin(budget.acquire_resources("d", "Read", vec![resource("file", false)]));
    assert!(poll_once(reader.as_mut()).is_pending());
    let other = budget
        .acquire_resources("e", "Write", vec![resource("other", true)])
        .await
        .unwrap();
    assert_eq!(budget.snapshot().active, 3);
    drop((a, b));
    let writing = admitted(writer.as_mut());
    assert!(poll_once(reader.as_mut()).is_pending());
    drop(writing);
    drop(admitted(reader.as_mut()));
    drop(other);
    assert_eq!(budget.snapshot().active, 0);
    assert_eq!(budget.snapshot().queued, 0);
    assert!(budget.lock().resources.is_empty());
}

#[tokio::test]
async fn inactive_order_reservation_holds_no_capacity_and_cancel_unblocks_conflicts() {
    let budget = ToolBudget::new();
    let registered = budget
        .register("a", "Write", vec![resource("file", true)])
        .unwrap();
    assert_eq!(budget.snapshot().active, 0);
    let mut later = Box::pin(budget.acquire_resources("b", "Read", vec![resource("file", false)]));
    assert!(poll_once(later.as_mut()).is_pending());
    let other = budget
        .acquire_resources("c", "Read", vec![resource("other", false)])
        .await
        .unwrap();
    drop(registered);
    drop(admitted(later.as_mut()));
    drop(other);
    assert!(budget.lock().resources.is_empty());
    assert_eq!(budget.snapshot().queued, 0);
}

#[tokio::test]
async fn multiresource_waiter_holds_nothing_and_cross_moves_cannot_deadlock() {
    let budget = ToolBudget::new();
    let held = budget
        .acquire_resources("a", "Write", vec![resource("b", true)])
        .await
        .unwrap();
    let mut mv_ab = Box::pin(budget.acquire_resources(
        "b",
        "Edit",
        vec![resource("a", true), resource("b", true)],
    ));
    assert!(poll_once(mv_ab.as_mut()).is_pending());
    assert!(!budget.lock().resources.contains_key("a"));
    let mut mv_ba = Box::pin(budget.acquire_resources(
        "c",
        "Edit",
        vec![resource("b", true), resource("a", true)],
    ));
    assert!(poll_once(mv_ba.as_mut()).is_pending());
    drop(held);
    let first = admitted(mv_ab.as_mut());
    assert!(poll_once(mv_ba.as_mut()).is_pending());
    drop(first);
    drop(admitted(mv_ba.as_mut()));
    assert!(budget.lock().resources.is_empty());
}

#[tokio::test]
async fn cancellation_after_resource_grant_releases_all_resources() {
    let budget = ToolBudget::new();
    let held = budget
        .acquire_resources("a", "Write", vec![resource("file", true)])
        .await
        .unwrap();
    let mut waiter = Box::pin(budget.acquire_resources("b", "Write", vec![resource("file", true)]));
    assert!(poll_once(waiter.as_mut()).is_pending());
    drop(held);
    assert_eq!(budget.snapshot().active, 1);
    drop(waiter);
    assert_eq!(budget.snapshot().active, 0);
    assert!(budget.lock().resources.is_empty());
}

#[tokio::test]
async fn identity_refresh_keeps_paths_locked_and_rejects_active_alias_conflict() {
    let budget = ToolBudget::new();
    let mut permit = budget
        .acquire_resources("a", "Read", vec![resource("path:a", false)])
        .await
        .unwrap();
    assert!(permit.try_refresh_resources(vec![
        resource("path:a", false),
        resource("inode:new", false)
    ]));
    let other = budget
        .acquire_resources("b", "Write", vec![resource("inode:alias", true)])
        .await
        .unwrap();
    assert!(!permit.try_refresh_resources(vec![
        resource("path:a", false),
        resource("inode:alias", false)
    ]));
    assert!(budget.lock().resources.contains_key("inode:new"));
    assert_eq!(budget.snapshot().active, 2);
    drop((permit, other));
    assert!(budget.lock().resources.is_empty());
}

#[tokio::test]
async fn refreshed_inactive_registration_preserves_order_without_capacity() {
    let budget = ToolBudget::new();
    let mut first = budget
        .register("a", "Write", vec![resource("path", true)])
        .unwrap();
    first.update_resources(vec![resource("path", true), resource("inode", true)]);
    let mut second = Box::pin(budget.acquire_resources("b", "Read", vec![resource("path", false)]));
    assert!(poll_once(second.as_mut()).is_pending());
    let writing = first.activate().await.unwrap();
    assert!(poll_once(second.as_mut()).is_pending());
    drop(writing);
    drop(admitted(second.as_mut()));
    assert!(budget.lock().resources.is_empty());
}
