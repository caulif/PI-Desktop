#!/usr/bin/env node
// Process-level fault injection for durable plugin schedule admissions.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-plugin-schedule-host-"));
const host = new Host(resolveHostBinary(), root);
const pluginId = "host-fault-fixture";
const template = `Do work\n\nWork ID: work_${"0".repeat(64)}. Record the outcome and file artifacts against this Work.`;
const content = template.replace("0".repeat(64), "a".repeat(64));
const hash = createHash("sha256").update(template).digest("hex");
const sqlite = (sql, ...params) => {
  const db = new DatabaseSync(join(root, "pi.sqlite"));
  try { return db.prepare(sql).run(...params); }
  finally { db.close(); }
};
const sqliteExec = (sql) => {
  const db = new DatabaseSync(join(root, "pi.sqlite"));
  try { db.exec(sql); }
  finally { db.close(); }
};
const forceDue = (taskId, at) => sqlite(
  "UPDATE scheduled_tasks SET config_json=json_set(config_json,'$.nextRunAt',CAST(? AS INTEGER)) WHERE id=?",
  at, taskId,
);
const poll = async () => (await host.call("scheduled.pluginDue")).occurrences;
const get = async (key) => (await host.call("scheduled.pluginGet", { pluginId, externalKey: key })).binding;
const startRequest = (event, requestIntentId, sessionId) => ({
  pluginId, requestIntentId, sessionId, content, routineId: event.externalKey,
  trigger: { kind: "schedule", schedulerTaskId: event.schedulerTaskId,
    occurrenceId: event.occurrenceId, scheduledFor: event.scheduledFor },
});
const restart = async () => { await host.stop(); await host.start(); };

try {
  await host.start();
  const session = await host.call("session.create", { title: "Scheduled fixture", mode: "agent" });
  const sessionId = session.session.id;
  await host.call("scheduled.pluginRegisterCreatedSession", { pluginId, sessionId });
  const definition = (externalKey, timezone = "UTC") => ({
    pluginId, externalKey, definitionRevision: 1, title: externalKey,
    cadence: "interval", schedule: { hour: 0, minute: 0, weekday: 0, intervalMinutes: 15 }, timezone,
    enabled: true, sessionId, goalHash: "b".repeat(64),
    promptTemplateHash: hash, nativeAuthorized: true,
  });
  const primary = await host.call("scheduled.pluginUpsert", definition("replay"));
  const taskId = primary.schedulerTaskId;
  forceDue(taskId, Date.now() - 60_000);
  const [event] = await poll();
  assert.ok(event);
  assert.equal((await poll())[0].occurrenceId, event.occurrenceId);
  await restart();
  assert.equal((await poll())[0].occurrenceId, event.occurrenceId);
  const request = startRequest(event, "lost-receipt-1", sessionId);
  assert.equal((await host.call("scheduled.pluginPrepareStart", request)).start, true);
  await host.call("scheduled.pluginRecordStart", { pluginId, requestIntentId: request.requestIntentId, turnId: "turn-recovered" });
  await restart();
  assert.equal((await host.call("scheduled.pluginLookupStart", { pluginId, requestIntentId: request.requestIntentId })).turnId, "turn-recovered");
  assert.equal((await host.call("scheduled.pluginPrepareStart", request)).start, false);
  assert.equal((await get("replay")).occurrences.filter((item) => item.occurrenceId === event.occurrenceId).length, 1);
  const uncertain = await host.call("scheduled.pluginUpsert", definition("unknown"));
  forceDue(uncertain.schedulerTaskId, Date.now() - 60_000);
  const uncertainEvent = (await poll()).find((item) => item.externalKey === "unknown");
  const uncertainRequest = startRequest(uncertainEvent, "unknown-receipt-1", sessionId);
  assert.equal((await host.call("scheduled.pluginPrepareStart", uncertainRequest)).start, true);
  await host.call("scheduled.pluginRecordStart", { pluginId, requestIntentId: uncertainRequest.requestIntentId });
  await restart();
  assert.equal((await host.call("scheduled.pluginLookupStart", { pluginId, requestIntentId: uncertainRequest.requestIntentId })).kind, "unknown");
  assert.equal((await host.call("scheduled.pluginPrepareStart", uncertainRequest)).start, false);
  console.log("PASS V04 same occurrence, lost receipt and restart deduplicate acceptance");

  const busy = await host.call("scheduled.pluginUpsert", definition("busy"));
  forceDue(busy.schedulerTaskId, Date.now() - 60_000);
  const busyEvent = (await poll()).find((item) => item.externalKey === "busy");
  assert.ok(busyEvent);
  const retry = { ...busyEvent, pluginId, requestIntentId: "busy-retry-1", reason: "owner_busy" };
  const deferred = await host.call("scheduled.pluginRetry", retry);
  assert.equal(deferred.state, "deferred");
  assert.deepEqual(await host.call("scheduled.pluginRetry", retry), deferred);
  assert.equal((await poll()).some((item) => item.occurrenceId === busyEvent.occurrenceId), false);
  await restart();
  assert.equal((await poll()).some((item) => item.occurrenceId === busyEvent.occurrenceId), false);
  sqlite("UPDATE plugin_schedule_occurrences SET retry_at=? WHERE occurrence_id=?", Date.now() - 1, busyEvent.occurrenceId);
  assert.equal((await poll()).some((item) => item.occurrenceId === busyEvent.occurrenceId), true);
  const skipped = await host.call("scheduled.pluginSkip", { ...busyEvent, pluginId, reason: "overlap" });
  assert.equal(skipped.skipped, true);
  assert.equal((await poll()).some((item) => item.occurrenceId === busyEvent.occurrenceId), false);
  console.log("PASS V06 busy retry survives restart; overlap is terminal");

  const missed = await host.call("scheduled.pluginUpsert", definition("missed", "Asia/Shanghai"));
  const old = Date.now() - 3 * 24 * 60 * 60_000 - 4 * 60_000;
  forceDue(missed.schedulerTaskId, old);
  await restart();
  const recent = (await poll()).filter((item) => item.externalKey === "missed");
  assert.equal(recent.length, 1);
  assert.ok(Date.parse(recent[0].scheduledFor) > Date.now() - 24 * 60 * 60_000);
  assert.equal((await get("missed")).timezone, "Asia/Shanghai");
  assert.equal((await poll()).filter((item) => item.externalKey === "missed").length, 1);
  console.log("PASS V05 missed intervals resume at one recent occurrence; timezone persists");

  await host.call("scheduled.pluginDisable", { pluginId, externalKey: "missed" });
  assert.equal((await poll()).some((item) => item.externalKey === "missed"), false);
  await host.call("scheduled.pluginDisableAll", { pluginId });
  await restart();
  assert.equal((await poll()).length, 0);
  assert.equal((await get("replay")).occurrences.find((item) => item.occurrenceId === event.occurrenceId).state, "accepted");
  assert.equal((await get("missed")).task.enabled, false);
  console.log("PASS V08 pause, disable-all and restart retain history without new due");

  await host.stop();
  sqlite("UPDATE scheduled_tasks SET enabled=1 WHERE id=?", taskId);
  sqliteExec(`ALTER TABLE plugin_schedule_bindings DROP COLUMN authorization_hash;
    ALTER TABLE plugin_schedule_bindings DROP COLUMN authorized_session_id;
    ALTER TABLE plugin_schedule_bindings DROP COLUMN goal_hash;
    ALTER TABLE plugin_schedule_bindings DROP COLUMN prompt_template_hash;
    PRAGMA user_version=21;`);
  await host.start();
  const migrated = await get("replay");
  assert.equal(migrated.task.enabled, false);
  assert.equal(migrated.occurrences.find((item) => item.occurrenceId === event.occurrenceId).state, "accepted");
  assert.deepEqual(await poll(), []);
  assert.ok(existsSync(join(root, "pi.sqlite.v21.bak")));
  console.log("PASS V11 v21 profile upgrade disables unapproved schedule and preserves accepted history");
} finally {
  await host.stop();
  if (!process.env.PI_BOT_KEEP_PROFILE) rmSync(root, { recursive: true, force: true });
  else console.log("Profile:", root);
}
