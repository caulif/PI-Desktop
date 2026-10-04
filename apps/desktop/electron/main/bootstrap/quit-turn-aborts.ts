/** Snapshot and lock every exact quit target before any asynchronous flush.
 * Terminal events may arrive during flush or abort; they must retain the
 * existing finalizer's cancellation reason instead of claiming completion.
 */
export function lockQuitTurnAborts(
  activeTurns: ReadonlyMap<string, string>,
  lockAbortReason: (sessionId: string, turnId: string) => void,
): Array<{ sessionId: string; turnId: string }> {
  const targets = [...activeTurns].map(([sessionId, turnId]) => ({ sessionId, turnId }));
  for (const { sessionId, turnId } of targets) lockAbortReason(sessionId, turnId);
  return targets;
}
