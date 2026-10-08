import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

register(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "helpers/ts-import-hooks.mjs")));
const { queuedInputRequest, consumeQueuedInputAdmission } =
  await import("../electron/main/queued-input-admission.ts");

test("only the Main-marked object can consume queue provenance, once", () => {
  const marked = queuedInputRequest({ sessionId: "s1" }, true);
  assert.equal(consumeQueuedInputAdmission({ ...marked, __acceptedFromQueue: true }), false);
  assert.equal(consumeQueuedInputAdmission(marked), true);
  assert.equal(consumeQueuedInputAdmission(marked), false);
  assert.equal(consumeQueuedInputAdmission(queuedInputRequest({}, false)), false);
});
