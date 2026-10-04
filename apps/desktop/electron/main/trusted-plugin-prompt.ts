import type { AgentPromptRequest } from "@pi-desktop/shared";

type PluginPromptAdmission = {
  pluginId: string;
  requestIntentId: string;
  claimId: string;
};

const admissions = new WeakMap<object, PluginPromptAdmission>();

export function trustedPluginPromptRequest(
  request: AgentPromptRequest,
  admission: PluginPromptAdmission,
): AgentPromptRequest {
  admissions.set(request, { ...admission });
  return request;
}

export function consumePluginPromptAdmission(request: AgentPromptRequest): PluginPromptAdmission | undefined {
  const admission = admissions.get(request);
  admissions.delete(request);
  return admission;
}
