// Real isolated Host due persistence, using an existing stored authorization marker.
// Does not create grants, enable tasks, dispatch plugin events, or call a model.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { Host } from "./e2e/host.mjs";
import { DatabaseSync } from "node:sqlite";
import { openSync, writeSync, fsyncSync, closeSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); assert(i >= 0 && args[i + 1], `${name} is required`); return args[i + 1]; };
const binary = await realpath(resolve(option("--host")));
const profile = await realpath(resolve(option("--profile")));
const planPath = await realpath(resolve(option("--plan")));
const plan = JSON.parse(await readFile(planPath, "utf8"));
assert.equal(plan.kind, "isolated-real-host-controlled-due-plan");
assert(plan.pluginId && plan.externalKey && plan.expectedDefinitionRevision > 0);
assert.equal(plan.expectedTimezone, "America/New_York");
assert(["gap", "fold", "missed"].includes(plan.case));
assert(Array.isArray(plan.steps) && plan.steps.length >= 2 && plan.steps.length <= 8);
assert(plan.steps[0].seedAfter && plan.steps.slice(1).every(step => !step.seedAfter));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.PI_DESKTOP_DEV_CALENDAR_PREVIEW_DIR = profile;
process.env.PI_DESKTOP_DEV_SCHEDULE_DUE_DIR = profile;
const host = new Host(binary, profile);
const journalPath = join(profile, "controlled-due-requests.jsonl");
const lookupOnly = args.includes("--lookup-only");
assert(lookupOnly || !existsSync(journalPath), "Existing due journal is lookup only; never replay the plan");
let journalFd;
if (!lookupOnly) journalFd = openSync(journalPath,"wx");
const append = record => { assert(journalFd !== undefined); writeSync(journalFd,`${JSON.stringify(record)}\n`); fsyncSync(journalFd); };
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const db = new DatabaseSync(join(profile,"pi.sqlite"),{readOnly:true});
let storedAuthorization;
try { storedAuthorization = db.prepare("SELECT task_id,definition_revision,authorization_hash,authorized_session_id,goal_hash,prompt_template_hash FROM plugin_schedule_bindings WHERE plugin_id=? AND external_key=?").get(plan.pluginId,plan.externalKey); }
finally { db.close(); }
async function stopNormally() {
  if (!host.child) return;
  const child = host.child;
  const exited = once(child, "exit");
  child.stdin.end();
  let timer;
  try {
    const [code, signal] = await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("Host EOF shutdown timed out")), 15000);
    })]);
    assert.equal(code, 0); assert.equal(signal, null);
  } finally { clearTimeout(timer); await host.stop(); }
}
const report = { kind: "real_host_controlled_due_stored_authorization_marker_no_model",
  sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  binary, binarySha256: createHash("sha256").update(await readFile(binary)).digest("hex"),
  profile, planPath, planSha256: createHash("sha256").update(await readFile(planPath)).digest("hex"),
  modelCalls: 0, createsAuthorization: false, pluginRunAttemptAcceptance: false,
  journalPath, storedAuthorization, nativeProvenanceVerified:false, steps: [], status: "running" };
const request = step => ({ pluginId: plan.pluginId, externalKey: plan.externalKey,
  expectedDefinitionRevision: plan.expectedDefinitionRevision, expectedTimezone: plan.expectedTimezone,
  now: step.now, ...(step.seedAfter ? { seedAfter: step.seedAfter } : {}) });
try {
  if (plan.nativeReceiptPath && plan.nativeReceiptSha256) {
    const bytes = await readFile(resolve(plan.nativeReceiptPath));
    assert.equal(createHash("sha256").update(bytes).digest("hex"),plan.nativeReceiptSha256,"frozen native receipt changed");
    const receipt = JSON.parse(bytes.toString("utf8"));
    assert.equal(receipt.kind,"observed-native-schedule-authorization");
    assert.equal(receipt.outcome,"granted");
    assert.equal(receipt.source,"native_ui_observation");
    assert.equal(receipt.profile,profile);
    assert.equal(receipt.requestHash,digest(receipt.request));
    assert(typeof receipt.request.requestId === "string" && receipt.request.requestId.length > 0,"native request identity required");
    assert.equal(receipt.request.pluginId,plan.pluginId);
    assert.equal(receipt.request.externalKey,plan.externalKey);
    assert.equal(receipt.request.taskId,storedAuthorization.task_id);
    assert.equal(receipt.request.definitionRevision,storedAuthorization.definition_revision);
    assert.equal(receipt.request.sessionId,storedAuthorization.authorized_session_id);
    assert.equal(receipt.request.goalHash,storedAuthorization.goal_hash);
    assert.equal(receipt.request.promptTemplateHash,storedAuthorization.prompt_template_hash);
    assert.equal(receipt.request.authorizationHash,storedAuthorization.authorization_hash);
    assert.equal(receipt.request.timezone,plan.expectedTimezone);
    assert.deepEqual(receipt.request.schedule,plan.expectedSchedule);
    assert(Array.isArray(receipt.evidenceRefs) && receipt.evidenceRefs.length > 0,"native observation needs evidence references");
    for (const evidence of receipt.evidenceRefs) {
      assert(typeof evidence.path === "string" && /^[a-f0-9]{64}$/.test(evidence.sha256),"frozen native evidence file/hash required");
      assert.equal(createHash("sha256").update(await readFile(resolve(evidence.path))).digest("hex"),evidence.sha256);
    }
    report.nativeProvenanceVerified = true;
    report.nativeReceipt = { path:plan.nativeReceiptPath,sha256:plan.nativeReceiptSha256,requestHash:receipt.requestHash };
  }
  await host.start();
  const before = await host.call("scheduled.pluginGet", { pluginId: plan.pluginId, externalKey: plan.externalKey });
  assert(before.binding?.task.enabled, "requires an already enabled approved binding");
  assert.deepEqual(before.binding.task.schedule, plan.expectedSchedule, "plan must match native-approved calendar");
  report.before = before;
  if (lookupOnly) {
    report.kind = "real_host_controlled_due_unknown_lookup_only";
    report.status = "incomplete";
    report.reason = "Read-only lookup of existing journal; no due request or assertion replayed";
    report.existingJournal = await readFile(journalPath,"utf8");
  } else {
  for (const step of plan.steps) {
    if (step.restart) { await stopNormally(); await host.start(); }
    const rpcRequest = request(step), requestHash = digest(rpcRequest);
    append({ state:"requested",requestHash,request:rpcRequest,at:new Date().toISOString() });
    let result;
    try { result = await host.call("scheduled.devPluginDueAt",rpcRequest);
      append({ state:"returned",requestHash,result,at:new Date().toISOString() }); }
    catch (error) {
      const definiteRejection = error.rpc?.code === 1002 || error.rpc?.code === 1003;
      append({ state:definiteRejection ? "rejected" : "unknown_lookup_only",requestHash,
        error:error.message,rpc:error.rpc ?? null,at:new Date().toISOString() });
      report.status = "incomplete";
      report.reason = definiteRejection ? "Due rejected; preserve request and do not replay plan" : "Due outcome unknown; lookup only, no resend";
      report.lookup = await host.call("scheduled.pluginGet",{pluginId:plan.pluginId,externalKey:plan.externalKey}).catch(lookupError => ({error:lookupError.message}));
      await stopNormally(); await host.start();
      report.coldLookup = await host.call("scheduled.pluginGet",{pluginId:plan.pluginId,externalKey:plan.externalKey});
      break;
    }
    if (!result) break;
    assert.deepEqual(result.occurrences.map(event => event.scheduledFor), step.expectedPending);
    assert.deepEqual(result.binding.occurrences.map(row => ({ scheduledFor: row.scheduledFor,
      state: row.state, skipReason: row.skipReason })).sort((a,b) => a.scheduledFor.localeCompare(b.scheduledFor)),
      [...step.expectedHistory].sort((a,b) => a.scheduledFor.localeCompare(b.scheduledFor)));
    report.steps.push({ step, result });
  }
  if (report.status !== "incomplete") {
  const latest = request(plan.steps.at(-1));
  const unchanged = await host.call("scheduled.pluginGet", { pluginId: plan.pluginId, externalKey: plan.externalKey });
  for (const invalid of [{ ...latest, expectedDefinitionRevision: plan.expectedDefinitionRevision + 1 },
    { ...latest, expectedTimezone: "UTC" }, { ...latest, now: "invalid" },
    { ...latest, extra: true }, { ...latest, pluginId: "not-owner" },
    { ...latest, seedAfter: plan.steps[0].seedAfter }, { ...latest, now: plan.steps[0].seedAfter }]) {
    const requestHash = digest(invalid);
    append({state:"requested_invalid",requestHash,request:invalid,at:new Date().toISOString()});
    try { await host.call("scheduled.devPluginDueAt",invalid); assert.fail("Invalid due request unexpectedly succeeded"); }
    catch (error) {
      const definiteRejection = error.rpc?.code === 1002 || error.rpc?.code === 1003;
      append({state:definiteRejection ? "rejected_invalid" : "unknown_lookup_only",requestHash,error:error.message,rpc:error.rpc ?? null});
      if (!definiteRejection && error.rpc === undefined) {
        report.status = "incomplete"; report.reason = "Invalid due request outcome unknown; lookup only, no resend";
        report.lookup = await host.call("scheduled.pluginGet",{pluginId:plan.pluginId,externalKey:plan.externalKey}).catch(lookupError => ({error:lookupError.message}));
        await stopNormally(); await host.start();
        report.coldLookup = await host.call("scheduled.pluginGet",{pluginId:plan.pluginId,externalKey:plan.externalKey});
      }
      assert(definiteRejection,"Invalid-input acceptance requires a definite INVALID_PARAMS/PERMISSION_DENIED RPC response, not a timeout");
    }
  }
  assert.deepEqual(await host.call("scheduled.pluginGet", { pluginId: plan.pluginId, externalKey: plan.externalKey }), unchanged);
  report.invalidInputsLeaveBindingUnchanged = true;
  await stopNormally(); await host.start();
  assert.deepEqual(await host.call("scheduled.pluginGet", { pluginId: plan.pluginId, externalKey: plan.externalKey }), unchanged);
  report.coldRecoveryExact = true;
  report.controlledSchedulerPassed = true;
  report.status = report.nativeProvenanceVerified ? "passed" : "incomplete";
  if (!report.nativeProvenanceVerified) report.reason = "Stored authorization marker verified; frozen native receipt/provenance absent";
  }
  }
} catch (error) { if (report.status !== "incomplete") report.status = "failed"; report.error = error.message; process.exitCode = 1; }
finally { try { await stopNormally(); report.normalEofShutdown = true; }
  catch (error) { if (report.status !== "incomplete") report.status = "failed"; report.shutdownError = error.message; process.exitCode = 1; }
  const output = join(profile, "controlled-due-report.json");
  if (journalFd !== undefined) closeSync(journalFd);
  if (report.status === "incomplete" && !process.exitCode) process.exitCode = 2;
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify({ status: report.status, report: output })); }
