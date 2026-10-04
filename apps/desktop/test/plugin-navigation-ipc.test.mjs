import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IPC } from "@pi-desktop/shared";

const here = dirname(fileURLToPath(import.meta.url));
// Substitute only Electron's compositor module. Execute the real IPC handlers,
// manifest types, localization and untrusted-data validation.
const built = await build({ entryPoints: [join(here, "../electron/main/ipc/plugin-ui-ipc.ts")], bundle: true, platform: "node", format: "esm", write: false, plugins: [{ name: "compositor", setup(builder) { builder.onResolve({ filter: /plugin-view-host$/ }, () => ({ path: "view-host", namespace: "compositor" })); builder.onResolve({ filter: /browser-host$/ }, () => ({ path: "browser-host", namespace: "compositor" })); builder.onLoad({ filter: /.*/, namespace: "compositor" }, args => ({ contents: args.path === "view-host" ? 'export function pluginViewKey(pluginId,viewId){return `${pluginId}/${viewId}`}' : 'export const BROWSER_PLUGIN_ID="pi.browser";export const BROWSER_VIEW_ID="browser";' })); } }] });
const { registerPluginUiIpc } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const entry = mkdtempSync(join(tmpdir(), "pi-navigation-ipc-"));
writeFileSync(join(entry, "view.html"), "<!doctype html><title>Fixture</title>");

function rig({ allowed = true, items = [{ id: "one", title: "One" }] } = {}) {
  const handlers = new Map();
  let workspace = "/project/one";
  let active = true;
  let calls = 0;
  let opened;
  const loaded = { path: entry, permissions: new Set(allowed ? ["ui.view"] : []), manifest: { id: "demo.navigation", name: "Navigation", contributes: { views: [{ id: "main", title: "Main", entry: "view.html", placement: "main" }], sidebarSections: [{ id: "companions", title: "Companions", viewId: "main", itemsChannel: "navigation:items" }] } } };
  registerPluginUiIpc({ registrar: { handle: (id, fn) => handlers.set(id, fn) }, plugins: { listLoaded: () => [loaded], getLoaded: () => active ? loaded : undefined, invokePanelBridge: async () => { calls++; return typeof items === "function" ? items() : items; } }, pluginViews: { open: data => { opened = data; }, setVisible() {} }, pluginPanels: {}, browserHost: {}, pluginActiveInProject: () => active, currentWorkspacePath: () => workspace, getUpdaterLocale: () => "en", getPluginPanelTheme: () => "dark" });
  return { handlers, loaded, calls: () => calls, opened: () => opened, switchWorkspace: () => { workspace = "/project/two"; }, changeScope: () => { workspace = "/project/two"; active = false; } };
}
test("sidebar providers require ui.view and active scope before invoking plugin code", async () => {
  const denied = rig({ allowed: false });
  assert.deepEqual(await denied.handlers.get(IPC.invoke.pluginSidebarSections)(), []);
  assert.equal(denied.calls(), 0);
  const scoped = rig(); scoped.changeScope();
  assert.deepEqual(await scoped.handlers.get(IPC.invoke.pluginSidebarSections)(), []);
  assert.equal(scoped.calls(), 0);
});
test("provider results cannot escape an asynchronously revoked scope", async () => {
  let finish;
  const state = rig({ items: () => new Promise(resolve => { finish = resolve; }) });
  const pending = state.handlers.get(IPC.invoke.pluginSidebarSections)();
  state.changeScope(); finish([{ id: "one", title: "One" }]);
  assert.deepEqual(await pending, []);
});
test("main placement and containment are checked at the actual open boundary", async () => {
  const state = rig(); const open = state.handlers.get(IPC.invoke.pluginViewOpen);
  await assert.rejects(open({ pluginId: "demo.navigation", viewId: "main" }), /placement mismatch/);
  await open({ pluginId: "demo.navigation", viewId: "main", placement: "main", location: "opaque" });
  assert.equal(state.opened().placement, "main");
  state.loaded.manifest.contributes.views[0].entry = "../outside.html";
  await assert.rejects(open({ pluginId: "demo.navigation", viewId: "main", placement: "main" }), /inside the plugin/);
  state.changeScope();
  await assert.rejects(state.handlers.get(IPC.invoke.pluginViewSetVisible)({ pluginId: "demo.navigation", viewId: "main", visible: true }), /PERMISSION_DENIED/);
});
test("pending provider requests are not coalesced across workspace scopes", async () => {
  let count = 0;
  let finishOld;
  const state = rig({ items: () => ++count === 1 ? new Promise(resolve => { finishOld = resolve; }) : [{ id: "new", title: "New-scope roster" }] });
  const old = state.handlers.get(IPC.invoke.pluginSidebarSections)();
  state.switchWorkspace();
  const fresh = await state.handlers.get(IPC.invoke.pluginSidebarSections)();
  assert.equal(state.calls(), 2);
  assert.equal(fresh[0].items[0].id, "new");
  finishOld([{ id: "old", title: "Old-scope roster" }]);
  assert.deepEqual(await old, []);
});
test("a malformed provider stays diagnostically unavailable rather than rendering supplied HTML", async () => {
  const state = rig({ items: [{ id: "one", title: "" }] });
  const result = await state.handlers.get(IPC.invoke.pluginSidebarSections)();
  assert.equal(result[0].error, "Navigation unavailable");
  assert.deepEqual(result[0].items, []);
});
