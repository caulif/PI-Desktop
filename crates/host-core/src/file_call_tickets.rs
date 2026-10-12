//! Single-use ordering tickets. Registration does not grant permission or capacity.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::tool_budget::AdmissionRegistration;
use crate::tools::ToolsExecuteParams;

// Only unclaimed preparation expires. An execution owns its registration while
// waiting for an explicit permission decision, without an approval deadline.
const PREPARATION_LIFETIME: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileCallIdentity {
    pub session_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub args: Value,
    #[serde(default)]
    pub permission_scope: Option<String>,
}

struct PreparedFileCall {
    session_id: String,
    tool_call_id: String,
    tool_name: String,
    args_digest: Vec<u8>,
    permission_scope: Option<String>,
    registration: AdmissionRegistration,
    created: Instant,
}

/// Keep the identity reserved across every early return and cancellation point
/// in tools.execute. A concurrent legacy retry must not bypass the claimed
/// registration while the original call is entering its permission lifecycle.
pub struct FileCallClaim {
    claimed: Arc<Mutex<HashSet<(String, String)>>>,
    identity: (String, String),
}

impl Drop for FileCallClaim {
    fn drop(&mut self) {
        self.claimed
            .lock()
            .expect("claim lock is not poisoned")
            .remove(&self.identity);
    }
}

#[derive(Default)]
pub struct FileCallTickets {
    pending: HashMap<String, PreparedFileCall>,
    preparing: HashMap<String, (String, String, Instant)>,
    cancelled: HashMap<(String, String), Instant>,
    claimed: Arc<Mutex<HashSet<(String, String)>>>,
}

impl FileCallTickets {
    pub fn prune(&mut self) {
        self.pending
            .retain(|_, call| call.created.elapsed() < PREPARATION_LIFETIME);
        self.preparing
            .retain(|_, (_, _, created)| created.elapsed() < PREPARATION_LIFETIME);
        self.cancelled
            .retain(|_, at| at.elapsed() < PREPARATION_LIFETIME);
    }

    pub fn begin(&mut self, identity: &FileCallIdentity) -> Result<String, &'static str> {
        self.prune();
        if self
            .cancelled
            .contains_key(&(identity.session_id.clone(), identity.tool_call_id.clone()))
        {
            return Err("TOOL_ABORTED");
        }
        if self.contains_call(&identity.session_id, &identity.tool_call_id) {
            return Err("FILE_CALL_ALREADY_PREPARED");
        }
        if self.pending.len() + self.preparing.len() >= crate::tool_budget::MAX_QUEUED_TOOLS {
            return Err("HOST_OVERLOADED");
        }
        let token = uuid::Uuid::new_v4().to_string();
        self.preparing.insert(
            token.clone(),
            (
                identity.session_id.clone(),
                identity.tool_call_id.clone(),
                Instant::now(),
            ),
        );
        Ok(token)
    }

    pub fn finish_preparing(&mut self, token: &str) -> Result<(), &'static str> {
        if self.preparing.remove(token).is_some() {
            Ok(())
        } else {
            Err("TOOL_ABORTED")
        }
    }

    pub fn contains_call(&self, session: &str, call: &str) -> bool {
        self.pending
            .values()
            .any(|entry| entry.session_id == session && entry.tool_call_id == call)
            || self
                .preparing
                .values()
                .any(|(s, id, _)| s == session && id == call)
            || self
                .claimed
                .lock()
                .expect("claim lock is not poisoned")
                .contains(&(session.to_owned(), call.to_owned()))
    }

    pub fn insert(
        &mut self,
        identity: FileCallIdentity,
        registration: AdmissionRegistration,
    ) -> Result<String, &'static str> {
        self.prune();
        if self.contains_call(&identity.session_id, &identity.tool_call_id) {
            return Err("FILE_CALL_ALREADY_PREPARED");
        }
        let ticket = uuid::Uuid::new_v4().to_string();
        self.pending.insert(
            ticket.clone(),
            PreparedFileCall {
                args_digest: Sha256::digest(identity.args.to_string().as_bytes()).to_vec(),
                session_id: identity.session_id,
                tool_call_id: identity.tool_call_id,
                tool_name: identity.tool_name,
                permission_scope: identity.permission_scope,
                registration,
                created: Instant::now(),
            },
        );
        Ok(ticket)
    }

    pub fn claim(
        &mut self,
        ticket: &str,
        call: &ToolsExecuteParams,
    ) -> Result<(AdmissionRegistration, FileCallClaim), &'static str> {
        self.prune();
        let entry = self.pending.get(ticket).ok_or("FILE_CALL_TICKET_INVALID")?;
        if entry.session_id != call.session_id
            || entry.tool_call_id != call.tool_call_id
            || entry.tool_name != call.tool_name
            || entry.permission_scope != call.permission_scope
            || entry.args_digest != Sha256::digest(call.args.to_string().as_bytes()).to_vec()
        {
            return Err("FILE_CALL_TICKET_MISMATCH");
        }
        let identity = (call.session_id.clone(), call.tool_call_id.clone());
        self.claimed
            .lock()
            .expect("claim lock is not poisoned")
            .insert(identity.clone());
        let claim = FileCallClaim {
            claimed: self.claimed.clone(),
            identity,
        };
        Ok((
            self.pending
                .remove(ticket)
                .expect("validated ticket exists")
                .registration,
            claim,
        ))
    }

    pub fn cancel(&mut self, session: &str, calls: &[String]) -> usize {
        for call in calls {
            self.cancelled
                .insert((session.to_string(), call.clone()), Instant::now());
        }
        while self.cancelled.len() > 1024 {
            let oldest = self
                .cancelled
                .iter()
                .min_by_key(|(_, at)| **at)
                .map(|(key, _)| key.clone())
                .unwrap();
            self.cancelled.remove(&oldest);
        }
        self.preparing
            .retain(|_, (s, call, _)| s != session || !calls.contains(call));
        let before = self.pending.len();
        self.pending
            .retain(|_, entry| entry.session_id != session || !calls.contains(&entry.tool_call_id));
        before - self.pending.len()
    }

    pub fn clear(&mut self) {
        self.pending.clear();
        self.preparing.clear();
        self.cancelled.clear();
        self.claimed
            .lock()
            .expect("claim lock is not poisoned")
            .clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool_budget::{FileResource, ToolBudget};
    use serde_json::json;

    fn identity(session: &str, call: &str) -> FileCallIdentity {
        FileCallIdentity {
            session_id: session.into(),
            tool_call_id: call.into(),
            tool_name: "Write".into(),
            args: json!({ "path": "a.txt", "content": "value" }),
            permission_scope: None,
        }
    }

    fn execute(identity: &FileCallIdentity) -> ToolsExecuteParams {
        serde_json::from_value(json!({
            "sessionId": identity.session_id, "toolCallId": identity.tool_call_id,
            "toolName": identity.tool_name, "args": identity.args, "mode": "agent",
            "permissionScope": identity.permission_scope,
        }))
        .unwrap()
    }

    fn register(budget: &ToolBudget) -> AdmissionRegistration {
        budget
            .register(
                "s",
                "Write",
                vec![FileResource {
                    key: "file:a".into(),
                    exclusive: true,
                }],
            )
            .unwrap()
    }

    #[test]
    fn tickets_bind_arguments_scope_and_call_and_cannot_be_replayed() {
        let budget = ToolBudget::new();
        let mut tickets = FileCallTickets::default();
        let id = identity("s", "one");
        let ticket = tickets.insert(id.clone(), register(&budget)).unwrap();
        for changed in [
            json!({ "path": "b.txt", "content": "value" }),
            json!({ "path": "a.txt", "content": "other" }),
        ] {
            let mut call = execute(&id);
            call.args = changed;
            assert!(matches!(
                tickets.claim(&ticket, &call),
                Err("FILE_CALL_TICKET_MISMATCH")
            ));
        }
        let mut scoped = execute(&id);
        scoped.permission_scope = Some("auto".into());
        assert!(tickets.claim(&ticket, &scoped).is_err());
        let mut other = execute(&id);
        other.session_id = "other".into();
        assert!(tickets.claim(&ticket, &other).is_err());
        drop(tickets.claim(&ticket, &execute(&id)).unwrap());
        assert!(tickets.claim(&ticket, &execute(&id)).is_err());
        assert_eq!(budget.snapshot().queued, 0);
    }

    #[test]
    fn cancel_and_expiry_release_pending_ordering_without_capacity() {
        let budget = ToolBudget::new();
        let mut tickets = FileCallTickets::default();
        let id = identity("s", "one");
        let ticket = tickets.insert(id.clone(), register(&budget)).unwrap();
        assert_eq!(budget.snapshot().active, 0);
        assert_eq!(tickets.cancel("wrong-session", &["one".into()]), 0);
        tickets.pending.get_mut(&ticket).unwrap().created = Instant::now() - PREPARATION_LIFETIME;
        assert!(tickets.claim(&ticket, &execute(&id)).is_err());
        assert_eq!(budget.snapshot().queued, 0);
        let ticket = tickets
            .insert(identity("s", "two"), register(&budget))
            .unwrap();
        assert!(!ticket.is_empty());
        assert_eq!(tickets.cancel("s", &["two".into()]), 1);
        assert_eq!(budget.snapshot().queued, 0);
    }

    #[tokio::test]
    async fn claiming_in_reverse_does_not_reverse_conflicting_admission() {
        let budget = ToolBudget::new();
        let mut tickets = FileCallTickets::default();
        let first = identity("s", "first");
        let second = identity("s", "second");
        let t1 = tickets.insert(first.clone(), register(&budget)).unwrap();
        let t2 = tickets.insert(second.clone(), register(&budget)).unwrap();
        let (later, _later_claim) = tickets.claim(&t2, &execute(&second)).unwrap();
        let task = tokio::spawn(async move { later.activate().await.unwrap() });
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        let (earlier, _earlier_claim) = tickets.claim(&t1, &execute(&first)).unwrap();
        let earlier = earlier.activate().await.unwrap();
        assert!(!task.is_finished());
        drop(earlier);
        drop(task.await.unwrap());
        assert_eq!(budget.snapshot().active, 0);
        assert_eq!(budget.snapshot().queued, 0);
    }

    #[test]
    fn cancellation_before_or_during_async_preflight_prevents_registration() {
        let mut tickets = FileCallTickets::default();
        let id = identity("s", "one");
        let preparing = tickets.begin(&id).unwrap();
        assert!(tickets.contains_call("s", "one"));
        tickets.cancel("s", &["one".into()]);
        assert!(!tickets.contains_call("s", "one"));
        assert!(tickets.finish_preparing(&preparing).is_err());
        assert!(tickets.begin(&id).is_err());
        tickets.cancel("s", &["future".into()]);
        assert!(tickets.begin(&identity("s", "future")).is_err());
    }

    #[test]
    fn claimed_identity_blocks_legacy_retry_and_preparation_until_handler_settles() {
        let budget = ToolBudget::new();
        let mut tickets = FileCallTickets::default();
        let id = identity("s", "claimed");
        let ticket = tickets.insert(id.clone(), register(&budget)).unwrap();
        let (registration, claim) = tickets.claim(&ticket, &execute(&id)).unwrap();
        assert!(tickets.contains_call("s", "claimed"));
        assert!(matches!(
            tickets.begin(&id),
            Err("FILE_CALL_ALREADY_PREPARED")
        ));
        assert!(tickets.claim(&ticket, &execute(&id)).is_err());
        // Expiry and cancellation remove only unclaimed registrations. The
        // handler's RAII identity remains until its entire lifecycle settles.
        tickets.prune();
        tickets.cancel("s", &["claimed".into()]);
        assert!(tickets.contains_call("s", "claimed"));
        drop(registration);
        assert!(tickets.contains_call("s", "claimed"));
        drop(claim);
        assert!(!tickets.contains_call("s", "claimed"));
        assert_eq!(budget.snapshot().queued, 0);
    }
}
