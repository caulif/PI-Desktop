import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "pi-cold-load-authority-"));
process.env.PI_DESKTOP_DATA_DIR = join(scratch, "data");
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

function fixture(t) {
  const id = "demo.cold-authority";
  const path = mkdtempSync(join(scratch, "plugin-"));
  writeFileSync(join(path, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id, name: "Cold authority fixture", version: "0.1.0",
    main: "main.js", permissions: [],
  }));
  writeFileSync(join(path, "main.js"), "module.exports = {};\n");
  const callbacks = [];
  // Represents authority already persisted before the process started. Only
  // explicit unload or replacement may revoke it, never cold-load preflight.
  const authority = new Set([id]);
  const runtime = new PluginRuntime({
    hostEntry: join(here, "../electron/main/plugin-host-process.mjs"),
    spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      return {
        postMessage: (message) => { if (child.connected) child.send(message); },
        onMessage: (handler) => child.on("message", handler),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
    onPluginUnload: (pluginId) => { callbacks.push(pluginId); authority.delete(pluginId); },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  return { id, path, runtime, callbacks, authority };
}

test("cold load preserves persisted authority and does not signal unload", async (t) => {
  const { id, path, runtime, callbacks, authority } = fixture(t);
  await runtime.loadFromPath(path);
  assert.equal(runtime.listLoaded().length, 1);
  assert.deepEqual(callbacks, []);
  assert.equal(authority.has(id), true);
});

test("replacing a live plugin still signals unload and revokes authority", async (t) => {
  const { id, path, runtime, callbacks, authority } = fixture(t);
  await runtime.loadFromPath(path);
  await runtime.loadFromPath(path);
  assert.deepEqual(callbacks, [id]);
  assert.equal(authority.has(id), false);
  assert.equal(runtime.listLoaded().length, 1);
  authority.add(id);
  await runtime.unload(id);
  assert.deepEqual(callbacks, [id, id]);
  assert.equal(authority.has(id), false);
  assert.equal(runtime.listLoaded().length, 0);
});

test("explicit unload without a live instance revokes persisted authority", async (t) => {
  const { id, runtime, callbacks, authority } = fixture(t);
  await runtime.unload(id);
  assert.deepEqual(callbacks, [id]);
  assert.equal(authority.has(id), false);
  // Repeated explicit stop remains an authority boundary after crashes or
  // external restoration; it does not create a plugin or duplicate resources.
  authority.add(id);
  await runtime.unload(id);
  assert.deepEqual(callbacks, [id, id]);
  assert.equal(authority.has(id), false);
  assert.equal(runtime.listLoaded().length, 0);
});
