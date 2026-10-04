import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const built = await build({
  entryPoints: [fileURLToPath(new URL("../src/stores/slices/interaction-slice.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false,
});
const { createInteractionSlice } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

function rig() {
  let state = { page: "chat", activeSessionId: null, pluginTarget: null, pluginActivationRevision: 0, navStack: [], navIndex: -1 };
  const actions = createInteractionSlice({
    get: () => ({ ...state, ...actions }),
    set: update => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; },
    runtime: { beginNavigationIntent: () => 1 }, interactionRuntime: {},
  });
  return { ...actions, state: () => state };
}
const target = itemId => ({ pluginId: "demo", sectionId: "bots", itemId, viewId: "main", title: itemId });

test("reactivating the current Bot after back truncates forward history and keeps the cursor aligned", () => {
  const r = rig();
  r.openPluginTarget(target("one")); r.openPluginTarget(target("two")); r.navBack();
  r.openPluginTarget(target("one"));
  assert.equal(r.state().navIndex, 0);
  assert.deepEqual(r.state().navStack.map(entry => entry.pluginTarget.itemId), ["one"]);
  assert.equal(r.state().pluginTarget.itemId, "one");
  assert.equal(r.canNavForward(), false);
  assert.equal(r.state().pluginActivationRevision, 4);
});

test("a non-recording activation preserves the history cursor and forward entries", () => {
  const r = rig();
  r.openPluginTarget(target("one")); r.openPluginTarget(target("two")); r.navBack();
  r.openPluginTarget(target("one"), { record: false });
  assert.equal(r.state().navIndex, 0);
  assert.equal(r.state().navStack.length, 2);
  assert.equal(r.canNavForward(), true);
  r.navForward();
  assert.equal(r.state().pluginTarget.itemId, "two");
});
