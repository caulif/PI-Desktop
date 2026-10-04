import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { pluginSidebarItems } = await import("../electron/main/plugin-sidebar-items.ts");
const { validateManifest } = await import("../../../packages/plugin-sdk/dist/index.js");

const manifest = {
  schemaVersion: 1, id: "demo.navigation", name: "Navigation", version: "1.0.0", main: "main.js",
  permissions: ["ui.view"],
  contributes: {
    views: [{ id: "main", title: "Conversation", entry: "view.html", placement: "main" }],
    sidebarSections: [{ id: "companions", title: "Companions", viewId: "main", itemsChannel: "navigation:items" }],
  },
};
test("main placement is additive and legacy workpanel manifests remain valid", () => {
  assert.equal(validateManifest(manifest).ok, true);
  assert.equal(validateManifest({ ...manifest, contributes: { views: [{ id: "legacy", title: "Legacy", entry: "view.html" }] } }).ok, true);
});
test("navigation refuses undeclared/non-main targets and privileged host channels", () => {
  for (const change of [{ viewId: "missing" }, { itemsChannel: "session.send" }, { title: "" }]) {
    const input = structuredClone(manifest);
    Object.assign(input.contributes.sidebarSections[0], change);
    assert.equal(validateManifest(input).ok, false);
  }
  const input = structuredClone(manifest);
  input.contributes.views[0].placement = "workpanel";
  assert.equal(validateManifest(input).ok, false);
});
test("provider envelopes yield pure summaries without retaining executable properties", () => {
  const value = pluginSidebarItems({ ok: true, data: [{ id: "bot:one", title: "<img src=x onerror=alert(1)>", location: { botId: "one" }, html: "ignored" }] });
  assert.equal(value[0].title, "<img src=x onerror=alert(1)>");
  assert.deepEqual(value[0].location, { botId: "one" });
  assert.equal("html" in value[0], false);
});
test("malformed, duplicate, oversized and failed-provider data fails closed", () => {
  for (const value of [null, { ok: false }, [{ id: "a", title: "" }], [{ id: "a\n", title: "Title" }], [{ id: "a", title: "Title" }, { id: "a", title: "Other" }], Array.from({ length: 101 }, (_, n) => ({ id: `${n}`, title: "Title" })), [{ id: "a", title: "Title", location: "x".repeat(65536) }]]) assert.throws(() => pluginSidebarItems(value), /INVALID_SIDEBAR_ITEMS/);
});
