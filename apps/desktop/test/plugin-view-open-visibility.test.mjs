import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Execute the actual component's effects with deterministic deferred IPC. The
// small hook rig substitutes scheduling and native layout only, not its logic.
const built = await build({
  entryPoints: [join(dirname(fileURLToPath(import.meta.url)), "../src/components/workpanel/PluginViewTab.tsx")],
  bundle: true, platform: "node", format: "esm", write: false,
  tsconfigRaw: { compilerOptions: { jsx: "react" } }, jsx: "transform", jsxFactory: "__element", banner: { js: "const __element=(type,props)=>{if(props?.ref)props.ref.current=globalThis.__viewRig.surface;return {type,props}};" },
  plugins: [{ name: "view-effect-rig", setup(builder) {
    builder.onResolve({ filter: /^(react|react-i18next)$|\/lib\/api$|plugin-view-icons$|\/icons$|WorkTabEmpty$/ }, args => ({ path: args.path, namespace: "rig" }));
    builder.onLoad({ filter: /.*/, namespace: "rig" }, args => ({ contents:
      args.path === "react" ? "export const useState=(...a)=>globalThis.__viewRig.useState(...a);export const useRef=(...a)=>globalThis.__viewRig.useRef(...a);export const useEffect=(...a)=>globalThis.__viewRig.useEffect(...a);" :
      args.path === "react-i18next" ? "export const useTranslation=()=>({t:s=>s});" :
      args.path.endsWith("/lib/api") ? "export const api={pluginViewOpen:(...a)=>globalThis.__viewRig.api.pluginViewOpen(...a),pluginViewSetVisible:(...a)=>globalThis.__viewRig.api.pluginViewSetVisible(...a),pluginViewSetBounds:(...a)=>globalThis.__viewRig.api.pluginViewSetBounds(...a),onPluginChanged:fn=>globalThis.__viewRig.api.onPluginChanged(fn)};" :
      "export const pluginViewIcon=()=>null;export const IconPlug=()=>null;export const WorkTabEmpty=()=>null;"
    }));
  } }],
});
const { PluginViewTab } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

function rig(t) {
  const slots = [], changes = [], pending = [], visibility = [], bounds = [];
  let cursor = 0, dirty = false, props = { pluginId: "demo", viewId: "main", title: "Main", placement: "main" }, changed;
  let exists = false, visible = false;
  const state = {
    surface: { getBoundingClientRect: () => ({ x: 20, y: 0, width: 800, height: 600 }) },
    useState(initial) {
      const i = cursor++;
      slots[i] ??= { value: initial };
      return [slots[i].value, value => { const next = typeof value === "function" ? value(slots[i].value) : value; if (!Object.is(next, slots[i].value)) { slots[i].value = next; dirty = true; } }];
    },
    useRef(initial) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
    useEffect(effect, deps) {
      const i = cursor++, prior = slots[i];
      if (!prior || deps.some((value, index) => !Object.is(value, prior.deps[index]))) changes.push(() => { prior?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; });
    },
    api: {
      pluginViewOpen: () => new Promise(resolve => pending.push(() => { exists = true; resolve(); })),
      pluginViewSetVisible: async (_plugin, _view, value) => { visibility.push({ exists, value }); if (exists) visible = value; },
      pluginViewSetBounds: async value => bounds.push(value),
      onPluginChanged: fn => { changed = fn; return () => {}; },
    },
    render(next = props) { props = next; cursor = 0; dirty = false; PluginViewTab(props); changes.splice(0).forEach(fn => fn()); },
    async settleOpen() { pending.shift()(); await Promise.resolve(); await Promise.resolve(); if (dirty) state.render(); },
    block(value) { state.render({ ...props, blocked: value }); },
    reload() { exists = false; visible = false; changed({ pluginId: "demo" }); },
    visible: () => visible, visibility, bounds,
  };
  const previous = Object.fromEntries(["__viewRig", "window", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame"].map(key => [key, globalThis[key]]));
  globalThis.__viewRig = state;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = fn => { fn(); return 1; };
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => { for (const [key, value] of Object.entries(previous)) globalThis[key] = value; });
  return state;
}

test("a slow main-view open reapplies visibility and bounds after entry creation", async t => {
  const state = rig(t); state.render();
  assert.equal(state.visible(), false);
  assert.deepEqual(state.visibility[0], { exists: false, value: true });
  await state.settleOpen();
  assert.equal(state.visible(), true);
  assert.deepEqual(state.bounds.at(-1), { x: 20, y: 0, width: 800, height: 600 });
});

test("open completion respects current overlay state and restores a reloaded surface", async t => {
  const state = rig(t); state.render(); state.block(true);
  await state.settleOpen();
  assert.equal(state.visible(), false, "completion must not reveal a surface under an overlay");
  state.block(false); assert.equal(state.visible(), true);
  state.reload(); await state.settleOpen();
  assert.equal(state.visible(), true, "mounted view must attach its new entry after reload");
});
