//! Internal preparation entry points; the original tools.execute permission gate
//! remains the only authorization for file work.
use super::*;
use crate::file_access::FileAccessPlan;
use crate::file_call_tickets::FileCallIdentity;

pub(super) async fn prepare(
    state: Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let identity: FileCallIdentity = serde_json::from_value(params)
        .map_err(|_| rpc_err(1002, "invalid file call preparation", "INVALID_PARAMS"))?;
    if !matches!(identity.tool_name.as_str(), "Read" | "Write" | "Edit")
        || identity.tool_call_id.trim().is_empty()
        || identity.tool_call_id.len() > 512
    {
        return Err(rpc_err(
            1002,
            "unsupported file call preparation",
            "INVALID_PARAMS",
        ));
    }
    let (workspace_path, scratch_path, budget, preparation) = {
        let mut st = state.lock().await;
        if st.shutting_down {
            return Err(rpc_err(1001, "host is shutting down", "HOST_SHUTTING_DOWN"));
        }
        let mode = sessions::session_mode(&st.db, &identity.session_id)
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
            .ok_or_else(|| rpc_err(1007, "session not found", "SESSION_NOT_FOUND"))?;
        if sessions::is_contract_mode(&mode)
            && !PermissionManager::plan_mode_allows(&identity.tool_name)
        {
            return Err(rpc_err(
                1004,
                "tool is unavailable in this mode",
                "TOOL_DENIED",
            ));
        }
        let workspace = resolve_tool_workspace_for_call(&st, &identity.session_id, &identity.args)?
            .map(PathBuf::from);
        let preparation = st
            .file_call_tickets
            .begin(&identity)
            .map_err(|code| rpc_err(1002, "file preparation is unavailable", code))?;
        (
            workspace,
            scratch::session_dir(&st.data_dir, &identity.session_id),
            st.tool_budget.clone(),
            preparation,
        )
    };
    // Resolve identities without reading file contents. This is not an external
    // path grant: execution always evaluates permission again from the session.
    let plan_identity = identity.clone();
    let plan_result = tokio::task::spawn_blocking(move || {
        FileAccessPlan::for_tool(
            workspace_path.as_deref(),
            scratch_path.as_deref(),
            &plan_identity.session_id,
            &plan_identity.tool_name,
            &plan_identity.args,
            true,
        )
    })
    .await;
    let mut st = state.lock().await;
    st.file_call_tickets
        .finish_preparing(&preparation)
        .map_err(|code| rpc_err(1002, "file preparation was cancelled", code))?;
    if st.shutting_down {
        return Err(rpc_err(1001, "host is shutting down", "HOST_SHUTTING_DOWN"));
    }
    let plan = plan_result
        .map_err(|_| rpc_err(1000, "file preparation task failed", "INTERNAL"))?
        .map_err(|_| {
            rpc_err(
                1002,
                "file access plan could not be prepared",
                "INVALID_ARGUMENT",
            )
        })?;
    let registration = budget
        .register(&identity.session_id, &identity.tool_name, plan.resources)
        .map_err(|error| rpc_err(-32029, error.message(), error.code()))?;
    let ticket = st
        .file_call_tickets
        .insert(identity, registration)
        .map_err(|code| rpc_err(1002, "file call is already prepared", code))?;
    Ok(json!({ "ticket": ticket }))
}

pub(super) async fn cancel(
    state: Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Cancel {
        session_id: String,
        tool_call_ids: Vec<String>,
    }
    let p: Cancel = serde_json::from_value(params)
        .map_err(|_| rpc_err(1002, "invalid prepared call cancellation", "INVALID_PARAMS"))?;
    if p.tool_call_ids.len() > crate::tool_budget::MAX_QUEUED_TOOLS
        || p.session_id.len() > 512
        || p.tool_call_ids
            .iter()
            .any(|id| id.len() > 512 || id.trim().is_empty())
    {
        return Err(rpc_err(1002, "too many prepared calls", "INVALID_PARAMS"));
    }
    let cancelled = state
        .lock()
        .await
        .file_call_tickets
        .cancel(&p.session_id, &p.tool_call_ids);
    Ok(json!({ "cancelled": cancelled }))
}
