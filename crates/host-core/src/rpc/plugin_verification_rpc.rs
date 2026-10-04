use super::{rpc_err, AppState, JsonRpcError, Value};
use crate::{plugin_verification as verification, tools};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::Mutex;

fn error(e: impl ToString) -> JsonRpcError {
    rpc_err(1002, e.to_string(), "VERIFICATION_REFUSED")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApprovalRequest {
    session_id: String,
    project_path: String,
    definition: verification::CommandDefinition,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotRequest {
    session_id: String,
    project_path: String,
    command_id: String,
}

/// This private NDJSON surface is callable by trusted Main, never directly by a plugin.
pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    mut params: Value,
) -> Result<Value, JsonRpcError> {
    if method == "plugin.verification.approveCheck" {
        let token = params
            .get("token")
            .and_then(Value::as_str)
            .ok_or_else(|| error("approval token required"))?;
        if params.as_object().is_none_or(|o| o.len() != 1) {
            return Err(error("only trusted approval token allowed"));
        }
        let st = state.lock().await;
        return serde_json::to_value(verification::approve_check(&st.db, token).map_err(error)?)
            .map_err(error);
    }
    let plugin = params
        .as_object_mut()
        .and_then(|p| p.remove("pluginId"))
        .and_then(|p| p.as_str().map(str::to_owned))
        .ok_or_else(|| error("authenticated pluginId required"))?;
    if matches!(
        method,
        "plugin.verification.snapshot"
            | "plugin.verification.lookupExecution"
            | "plugin.verification.cancelExecution"
            | "plugin.verification.runApprovedCheck"
    ) {
        let command = params
            .get("commandId")
            .and_then(Value::as_str)
            .ok_or_else(|| error("commandId required"))?;
        let project = params
            .get("projectPath")
            .and_then(Value::as_str)
            .ok_or_else(|| error("projectPath required"))?;
        let st = state.lock().await;
        let execution_session = if method != "plugin.verification.snapshot" {
            let execution = params
                .get("executionId")
                .and_then(Value::as_str)
                .ok_or_else(|| error("executionId required"))?;
            verification::execution_session(&st.db, &plugin, execution, command, project)
                .map_err(error)?
        } else {
            None
        };
        let session = match execution_session {
            Some(session) => session,
            None => {
                verification::resolve_check(&st.db, &plugin, command, project)
                    .map_err(error)?
                    .session_id
            }
        };
        if params
            .get("sessionId")
            .is_some_and(|s| s.as_str() != Some(session.as_str()))
        {
            return Err(error("approved session scope mismatch"));
        }
        params
            .as_object_mut()
            .ok_or_else(|| error("request object required"))?
            .insert("sessionId".into(), Value::String(session));
    }
    match method {
        "plugin.verification.beginApproval" => {
            let request: ApprovalRequest = serde_json::from_value(params).map_err(error)?;
            let st = state.lock().await;
            serde_json::to_value(
                verification::begin_approval(
                    &st.db,
                    &plugin,
                    &request.session_id,
                    &request.project_path,
                    request.definition,
                )
                .map_err(error)?,
            )
            .map_err(error)
        }
        "plugin.verification.snapshot" => {
            let request: SnapshotRequest = serde_json::from_value(params).map_err(error)?;
            let st = state.lock().await;
            serde_json::to_value(
                verification::snapshot(
                    &st.db,
                    &plugin,
                    &request.session_id,
                    &request.project_path,
                    Some(&request.command_id),
                )
                .map_err(error)?,
            )
            .map_err(error)
        }
        "plugin.verification.revokeCheck" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Revoke {
                command_id: String,
            }
            let request: Revoke = serde_json::from_value(params).map_err(error)?;
            let st = state.lock().await;
            serde_json::to_value(
                verification::revoke_check(&st.db, &plugin, &request.command_id).map_err(error)?,
            )
            .map_err(error)
        }
        "plugin.verification.lookupExecution"
        | "plugin.verification.cancelExecution"
        | "plugin.verification.runApprovedCheck" => {
            let request: verification::RunRequest =
                serde_json::from_value(params).map_err(error)?;
            let tool_id = format!("verification:{plugin}:{}", request.execution_id);
            let mut st = state.lock().await;
            if method == "plugin.verification.lookupExecution" {
                return serde_json::to_value(
                    verification::lookup_execution(&st.db, &plugin, &request).map_err(error)?,
                )
                .map_err(error);
            }
            if method == "plugin.verification.cancelExecution" {
                let receipt =
                    verification::request_cancel(&st.db, &plugin, &request).map_err(error)?;
                st.abort_or_queue_bash(&request.session_id, &tool_id);
                return serde_json::to_value(receipt).map_err(error);
            }
            if st.shutting_down {
                return Err(error("HOST_SHUTTING_DOWN"));
            }
            if let Some(receipt) =
                verification::lookup_execution(&st.db, &plugin, &request).map_err(error)?
            {
                return serde_json::to_value(receipt).map_err(error);
            }
            let cancellation = st
                .register_bash_cancellation(&request.session_id, &tool_id)
                .map_err(error)?;
            let admission = match verification::prepare_execution(&st.db, &plugin, request.clone())
            {
                Ok(value) => value,
                Err(e) => {
                    st.clear_bash_cancellation(&request.session_id, &tool_id);
                    return Err(error(e));
                }
            };
            if !admission.start {
                st.clear_bash_cancellation(&request.session_id, &tool_id);
                return serde_json::to_value(admission.receipt).map_err(error);
            }
            drop(st);
            // Durable admission already exists. A lost response is never permission to respawn.
            let outcome = tools::run_approved_process(&admission, cancellation).await;
            let mut st = state.lock().await;
            let result = verification::settle_execution(
                &st.db,
                admission
                    .claim_token
                    .as_deref()
                    .ok_or_else(|| error("internal claim missing"))?,
                outcome,
            );
            st.clear_bash_cancellation(&request.session_id, &tool_id);
            serde_json::to_value(result.map_err(error)?).map_err(error)
        }
        _ => Err(error("unknown verification operation")),
    }
}
