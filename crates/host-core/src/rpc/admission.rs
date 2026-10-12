use std::sync::Arc;

use tokio::sync::{OwnedSemaphorePermit, Semaphore, TryAcquireError};

/// Keep cancellation and approval resolution reachable when ordinary requests
/// are waiting for tools or user approval. Both lanes are bounded; control
/// requests cannot consume or increase the ordinary tool execution budget.
pub(super) struct RpcAdmission {
    requests: Arc<Semaphore>,
    controls: Arc<Semaphore>,
}

impl RpcAdmission {
    pub(super) fn new() -> Self {
        Self {
            requests: Arc::new(Semaphore::new(32)),
            controls: Arc::new(Semaphore::new(4)),
        }
    }

    pub(super) fn try_acquire(
        &self,
        method: &str,
    ) -> Result<OwnedSemaphorePermit, TryAcquireError> {
        let slots = match method {
            "tools.abort"
            | "permissions.resolve"
            | "plans.abort"
            | "tools.cancelPreparedFileCalls" => &self.controls,
            _ => &self.requests,
        };
        slots.clone().try_acquire_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::RpcAdmission;

    #[test]
    fn saturated_requests_leave_abort_and_approval_reachable() {
        let admission = RpcAdmission::new();
        let requests: Vec<_> = (0..32)
            .map(|_| admission.try_acquire("tools.execute").unwrap())
            .collect();
        assert!(admission.try_acquire("tools.execute").is_err());
        assert!(admission.try_acquire("session.get").is_err());
        for method in [
            "tools.abort",
            "permissions.resolve",
            "plans.abort",
            "tools.cancelPreparedFileCalls",
        ] {
            let control = admission.try_acquire(method).unwrap();
            assert!(admission.try_acquire("tools.execute").is_err());
            drop(control);
        }
        drop(requests);
        assert!(admission.try_acquire("tools.execute").is_ok());
    }

    #[test]
    fn control_flood_is_bounded_and_does_not_consume_request_capacity() {
        let admission = RpcAdmission::new();
        let mut controls: Vec<_> = (0..4)
            .map(|_| admission.try_acquire("tools.abort").unwrap())
            .collect();
        assert!(admission.try_acquire("permissions.resolve").is_err());
        let requests: Vec<_> = (0..32)
            .map(|_| admission.try_acquire("tools.execute").unwrap())
            .collect();
        assert!(admission.try_acquire("tools.execute").is_err());
        drop(controls.pop());
        assert!(admission.try_acquire("permissions.resolve").is_ok());
        drop(controls);
        drop(requests);
        assert!(admission.try_acquire("tools.abort").is_ok());
        assert!(admission.try_acquire("tools.execute").is_ok());
    }
}
