// Native Host calendar diagnostics only: no timer delivery, prompt, or model.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, realpath, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binaryArg = process.argv.indexOf("--host");
assert(binaryArg >= 0 && process.argv[binaryArg + 1], "--host requires the candidate Host executable");
const binary = await realpath(resolve(process.argv[binaryArg + 1]));
const profile = await mkdtemp(join(tmpdir(), "pi-bot-calendar-preview-"));
const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const report = {
  kind: "real_host_stored_calendar_preview_no_execution",
  sourceHead,
  binary,
  binarySha256: createHash("sha256").update(await readFile(binary)).digest("hex"),
  profile,
  modelCalls: 0,
  status: "running",
  cases: [],
};

function launch(dir, optIn = dir) {
  const env = { ...process.env, PI_DESKTOP_DATA_DIR: dir };
  delete env.PI_DESKTOP_DEV_CALENDAR_PREVIEW_DIR;
  if (optIn !== null) env.PI_DESKTOP_DEV_CALENDAR_PREVIEW_DIR = optIn;
  const child = spawn(binary, [], { cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let sequence = 0;
  let stderr = "";
  let fatal;
  const pending = new Map();
  const exited = new Promise((resolveExit) => {
    child.on("error", error => { fatal = error; resolveExit({ error: error.message }); });
    child.on("exit", (code, signal) => resolveExit({ code, signal }));
  });
  child.stderr.on("data", data => { stderr = (stderr + data).slice(-10000); });
  child.stdin.on("error", error => { fatal = error; });
  createInterface({ input: child.stdout }).on("line", line => {
    try {
      const frame = JSON.parse(line);
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      pending.delete(frame.id);
      clearTimeout(waiter.timer);
      if (frame.error) waiter.reject(Object.assign(Error(frame.error.message), { rpc: frame.error }));
      else waiter.resolve(frame.result);
    } catch (error) { fatal = error; }
  });
  const call = (method, params = {}) => new Promise((resolveCall, reject) => {
    if (fatal) return reject(fatal);
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`RPC timeout: ${method}; stderr=${stderr.slice(-1200)}`)); }, method === "app.handshake" ? 45000 : 15000);
    pending.set(id, { resolve: resolveCall, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const stop = async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 10000);
    try { return await exited; }
    finally { clearTimeout(timer); }
  };
  const expectExit = async () => {
    const timer = setTimeout(() => child.kill(), 10000);
    try { return await exited; }
    finally { clearTimeout(timer); }
  };
  return { call, stop, expectExit, stderr: () => stderr };
}

const host = launch(profile);
try {
  await host.call("app.handshake", { protocolVersion: 11 });
  const pluginId = "dev.calendar-preview";
  const definition = (externalKey, hour, minute) => ({
    pluginId, externalKey, definitionRevision: 1, title: "Calendar preview fixture",
    enabled: false, cadence: "daily", timezone: "America/New_York",
    schedule: { hour, minute, weekday: 0 },
  });
  for (const test of [
    { key: "gap", hour: 2, minute: 30, after: "2026-03-08T00:00:00-05:00", expected: ["2026-03-09T06:30:00.000Z", "2026-03-10T06:30:00.000Z"], local: ["2026-03-09T02:30:00.000-04:00", "2026-03-10T02:30:00.000-04:00"] },
    { key: "fold", hour: 1, minute: 30, after: "2026-11-01T00:00:00-04:00", expected: ["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"], local: ["2026-11-01T01:30:00.000-04:00", "2026-11-02T01:30:00.000-05:00"] },
  ]) {
    await host.call("scheduled.pluginUpsert", definition(test.key, test.hour, test.minute));
    const before = await host.call("scheduled.pluginGet", { pluginId, externalKey: test.key });
    const preview = await host.call("scheduled.devCalendarPreview", { pluginId, externalKey: test.key, expectedDefinitionRevision: 1, after: test.after, count: 2 });
    assert.equal(preview.enabled, false);
    assert.equal(preview.schedulerTaskId, before.binding.schedulerTaskId);
    assert.deepEqual(preview.points.map(point => point.scheduledFor), test.expected);
    assert.deepEqual(preview.points.map(point => point.localTime), test.local);
    assert.deepEqual(await host.call("scheduled.pluginGet", { pluginId, externalKey: test.key }), before);
    report.cases.push({ name: test.key, preview, bindingUnchanged: true });
  }
  const valid = { pluginId, externalKey: "gap", expectedDefinitionRevision: 1, after: "2026-03-08T00:00:00Z", count: 2 };
  for (const overrides of [{ pluginId: "other" }, { expectedDefinitionRevision: 2 }, { after: "not-a-date" }, { count: 0 }, { count: 17 }, { timezone: "UTC" }]) {
    await assert.rejects(host.call("scheduled.devCalendarPreview", { ...valid, ...overrides }), error => error.rpc?.data?.kind === "INVALID_PARAMS" || error.rpc?.code === 1002);
  }
  report.cases.push({ name: "invalid_inputs_fail_closed", passed: true });
  assert.equal((await host.stop()).code, 0);
  // Cold restart restores the binding; preview still cannot enable it.
  const restarted = launch(profile);
  try {
    await restarted.call("app.handshake", { protocolVersion: 11 });
    const restored = await restarted.call("scheduled.devCalendarPreview", valid);
    assert.equal(restored.enabled, false);
    assert.deepEqual(restored.points, report.cases[0].preview.points);
    report.cases.push({ name: "cold_restart_same_calendar", passed: true });
  } finally { assert.equal((await restarted.stop()).code, 0); }
  const deniedProfile = await mkdtemp(join(tmpdir(), "pi-bot-preview-denied-"));
  const denied = launch(deniedProfile);
  const deniedExit = await denied.expectExit();
  assert.equal(deniedExit.signal, null);
  assert.equal(deniedExit.code, 1);
  assert.match(denied.stderr(), /calendar preview requires an exact dedicated temporary profile/);
  await assert.rejects(access(join(deniedProfile, "pi.sqlite")));
  report.cases.push({ name: "nondedicated_profile_rejected_before_database_open", passed: true });
  const noOptInProfile = await mkdtemp(join(tmpdir(), "pi-bot-preview-no-optin-"));
  const noOptIn = launch(noOptInProfile, null);
  try {
    await noOptIn.call("app.handshake", { protocolVersion: 11 });
    await assert.rejects(noOptIn.call("scheduled.devCalendarPreview", valid), error => error.rpc?.code === 1003);
    report.cases.push({ name: "no_optin_rpc_denied", passed: true });
  } finally { assert.equal((await noOptIn.stop()).code, 0); }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await host.stop();
  const output = join(profile, "calendar-preview-report.json");
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, report: output }));
}
