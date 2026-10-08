// Object identity distinguishes the Main-owned queue adapter from renderer IPC.
const queuedInputs = new WeakSet<object>();

export function queuedInputRequest<T extends object>(request: T, queued: boolean): T {
  if (queued) queuedInputs.add(request);
  return request;
}

export function consumeQueuedInputAdmission(request: object): boolean {
  const queued = queuedInputs.has(request);
  queuedInputs.delete(request);
  return queued;
}
