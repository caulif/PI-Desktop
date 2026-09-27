import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginScheduleDisableOutbox } = await import("../electron/main/plugin-schedule-disable-outbox.ts");

test("unload while host is absent survives restart and disables before scheduling resumes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-schedule-disable-outbox-"));
  const first = new PluginScheduleDisableOutbox(dir);
  await first.enqueue("pi-bot", () => null);
  await first.enqueue("pi-bot", () => null);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "plugin-schedule-disable-outbox.json"), "utf8")), ["pi-bot"]);

  const calls = [];
  const restarted = new PluginScheduleDisableOutbox(dir);
  const host = { call: async (method, params) => { calls.push([method, params]); return { disabledCount: 1 }; } };
  await restarted.flush(host);
  assert.deepEqual(calls, [["scheduled.pluginDisableAll", { pluginId: "pi-bot" }]]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "plugin-schedule-disable-outbox.json"), "utf8")), []);
});

test("failed host disable remains queued for the next successful handshake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-schedule-disable-outbox-"));
  const outbox = new PluginScheduleDisableOutbox(dir);
  const unavailable = { isAvailable: () => true, call: async () => { throw new Error("host lost"); } };
  await assert.rejects(outbox.enqueue("pi-bot", () => unavailable), /host lost/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "plugin-schedule-disable-outbox.json"), "utf8")), ["pi-bot"]);
  let disabled = 0;
  await outbox.flush({ call: async () => { disabled++; return { disabledCount: 1 }; } });
  assert.equal(disabled, 1);
});
