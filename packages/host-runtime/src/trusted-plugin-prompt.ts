

type PluginPromptAdmission = {
  pluginId: string;
  requestIntentId: string;
  claimId: string;
};

const admissions = new WeakMap<object, PluginPromptAdmission>();

export function trustedPluginPromptRequest<T extends object>(
  request: T,
  admission: PluginPromptAdmission,
): T {
  admissions.set(request, { ...admission });
  return request;
}

export function consumePluginPromptAdmission(request: object): PluginPromptAdmission | undefined {
  const admission = admissions.get(request);
  admissions.delete(request);
  return admission;
}
