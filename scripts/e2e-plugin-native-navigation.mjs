#!/usr/bin/env node
/** Actual Desktop + isolated plugin WebContentsView acceptance, no model calls. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { appDir, electronBinary } = resolveElectronBinary(root);
const hostBinary = process.env.PI_DESKTOP_HOST_BIN || join(root, "target/debug/pi-desktop-host-core.exe");
assert(existsSync(hostBinary), "Provide the existing host-core via PI_DESKTOP_HOST_BIN");
const port = Number(process.env.PI_DESKTOP_NATIVE_CDP_PORT || 9359);
const scratch = mkdtempSync(join(tmpdir(), "pi-native-navigation-"));
const plugin = join(scratch, "fixture"); mkdirSync(plugin);
const artifacts = process.env.PI_DESKTOP_NATIVE_ARTIFACT_DIR || join(appDir, "out/native-navigation"); mkdirSync(artifacts, { recursive: true });
const manifest = { schemaVersion: 1, id: "demo.native-navigation", name: "Native navigation acceptance", version: "1.0.0", main: "main.js", permissions: ["ui.view"], contributes: { views: [{ id: "conversation", title: "Conversation", entry: "view.html", placement: "main" }, { id: "workbench", title: "Workbench", entry: "view.html" }], sidebarSections: [{ id: "companions", title: "Bot", viewId: "conversation", itemsChannel: "navigation:items" }] } };
writeFileSync(join(plugin, "manifest.json"), JSON.stringify(manifest));
writeFileSync(join(plugin, "main.js"), `module.exports={onLoad(){},onPanelInvoke(channel){if(channel!=="navigation:items")throw Error("Unknown channel");return {ok:true,data:[{id:"bot:one",title:"Research companion",description:"Project association",location:{botId:"one"}},{id:"bot:two",title:"<b>Plain text</b>",location:{botId:"two"}}]}}};`);
writeFileSync(join(plugin, "view.html"), `<!doctype html><meta charset="utf-8"><meta name="pi-plugin-chrome" content="v2"><title>Isolated companion fixture</title><style>body{margin:0;padding:24px;background:#181818;color:#fff;font:14px system-ui}input{padding:12px;width:80%}</style><h1>Companion conversation</h1><pre id="context"></pre><input aria-label="Draft" placeholder="Preserved draft"><script>window.openEvents=0;window.context=pluginBridge.getViewContext();const render=()=>document.querySelector('#context').textContent=JSON.stringify(window.context);render();pluginBridge.on('view:open',()=>{window.openEvents++;window.context=pluginBridge.getViewContext();render()});pluginBridge.on('view:context',value=>{window.context={...pluginBridge.getViewContext(),...value};render()});pluginBridge.on('appearance:changed',()=>{window.context=pluginBridge.getViewContext();render()});</script>`);

class Client {
  constructor(ws) { this.ws = ws; this.sequence = 0; this.pending = new Map(); ws.onmessage = event => { const value = JSON.parse(event.data); const item = this.pending.get(value.id); if (!item) return; this.pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(Error(JSON.stringify(value.error))) : item.resolve(value.result); }; }
  static async connect(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); ws.onopen = () => resolve(new Client(ws)); ws.onerror = reject; }); }
  send(method, params = {}) { const id = ++this.sequence; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 15000); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { let value; try { value = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); } catch (error) { throw Error(`${error.message}; expression: ${expression.slice(0, 240)}`); } if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || JSON.stringify(value.exceptionDetails)); return value.result.value; }
  close() { this.ws.close(); }
}
async function targets() { const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }); return response.json(); }
async function waitFor(predicate, label) { const deadline = Date.now() + 60000; let last; while (Date.now() < deadline) { try { const value = await predicate(); if (value) return value; } catch (error) { last = error; } await delay(100); } throw Error(`Timed out: ${label}${last ? ` (${last.message})` : ""}`); }
const env = { ...process.env, PI_DESKTOP_PLUGIN_NAVIGATION_PROBE: "1", PI_DESKTOP_DATA_DIR: join(scratch, "data"), PI_DESKTOP_HOST_BIN: hostBinary, PI_DESKTOP_START_MAXIMIZED: "0", ELECTRON_RENDERER_URL: "" }; delete env.ELECTRON_RUN_AS_NODE;
let output = "";
const launch = () => { const process = spawn(electronBinary, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(scratch, "profile")}`, "."], { cwd: appDir, env, windowsHide: true }); process.stdout?.on("data", data => { output += data; }); process.stderr?.on("data", data => { output += data; }); return process; };
let child = launch();
const clients = [];
let mainClient;
try {
  const app = await waitFor(async () => (await targets()).find(target => target.type === "page" && target.url.includes("out/renderer/index.html") && !target.url.includes("surface=plugin-launcher")), "Desktop page");
  let host = await Client.connect(app.webSocketDebuggerUrl); clients.push(host); mainClient = host;
  await waitFor(() => host.eval("Boolean(window.piDesktop && window.__PI_DESKTOP__ && document.querySelector('.sidebar') && !document.querySelector('.app-shell.is-booting'))"), "host shell");
  const invoke = (name, ...args) => host.eval(`piDesktop.invoke(piDesktop.channels.invoke[${JSON.stringify(name)}],...${JSON.stringify(args)}).then(value=>{if(value?.ok===false)throw Error(JSON.stringify(value.error));return value?.data??value?.result??value})`);
  await invoke("pluginLoadDevConfirm", { path: plugin, grantedPermissions: ["ui.view"] });
  await waitFor(() => host.eval("Boolean(document.querySelector('[data-plugin-sidebar-section=\"demo.native-navigation/companions\"] .plugin-sidebar-item'))"), "peer section");
  const created = await invoke("sessionCreate", { title: "Original host session" });
  await host.eval(`__PI_DESKTOP__.selectSession(${JSON.stringify(created.session.id)})`);
  const before = await invoke("sessionList");
  await host.eval("document.querySelector('.plugin-sidebar-item').click()");
  const pluginTarget = await waitFor(async () => (await targets()).find(target => target.type === "page" && target.url.includes("fixture/view.html")), "isolated plugin page");
  let view = await Client.connect(pluginTarget.webSocketDebuggerUrl); clients.push(view);
  await waitFor(() => view.eval("window.context?.active && window.context.location?.botId === 'one'"), "main activation");
  assert.equal(await view.eval("pluginBridge.getViewContext().placement"), "main");
  assert.deepEqual(await view.eval("[typeof require,typeof process,typeof window.piDesktop]"), ["undefined", "undefined", "undefined"]);
  assert(await host.eval("Boolean(document.querySelector('[data-plugin-main-surface]'))"));
  const labels = await host.eval("[...document.querySelectorAll('.plugin-sidebar-item-title')].map(node=>node.textContent)"); assert.equal(labels[1], "<b>Plain text</b>");
  await view.eval("document.querySelector('input').value='draft survives'");
  await host.eval("document.querySelectorAll('.plugin-sidebar-item')[1].click()");
  await waitFor(() => view.eval("pluginBridge.getViewContext().location?.botId === 'two'"), "same view new subject");
  assert.equal(await view.eval("document.querySelector('input').value"), "draft survives");
  const openedBefore = await view.eval("window.openEvents");
  await host.eval("document.querySelectorAll('.plugin-sidebar-item')[1].click()");
  await waitFor(() => view.eval(`window.openEvents>${openedBefore}`), "explicit same-item activation");
  await host.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'[',code:'BracketLeft',ctrlKey:true,bubbles:true}))");
  await waitFor(() => view.eval("pluginBridge.getViewContext().location?.botId==='one'"), "native navigation back");
  await host.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:']',code:'BracketRight',ctrlKey:true,bubbles:true}))");
  await waitFor(() => view.eval("pluginBridge.getViewContext().location?.botId==='two'"), "native navigation forward");
  const rect = await host.eval("(()=>{const r=document.querySelector('.work-plugin-view-surface').getBoundingClientRect();return {width:r.width,height:r.height}})()"); assert(rect.width > 300 && rect.height > 200, JSON.stringify(rect));
  const shot = await host.send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(artifacts, "main.png"), Buffer.from(shot.data, "base64"));
  const guestShot = await view.send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(artifacts, "isolated-main-content.png"), Buffer.from(guestShot.data, "base64"));
  await host.eval("document.querySelector('[data-sidebar-section=projects]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:250,clientY:150}))");
  await waitFor(() => view.eval("pluginBridge.getViewContext().active===false"), "real sidebar menu occlusion");
  await host.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await waitFor(() => view.eval("pluginBridge.getViewContext().active===true"), "menu dismissal restores view");
  await host.eval("__PI_DESKTOP__.setPage('settings')");
  await waitFor(() => view.eval("pluginBridge.getViewContext().active===false"), "deactivation");
  await host.eval("__PI_DESKTOP__.setPage('chat')");
  await host.eval("document.querySelector('.plugin-sidebar-item').click()");
  await waitFor(() => view.eval("window.context?.active===true"), "reactivation");
  await invoke("settingsSet", { theme: "light" });
  await waitFor(() => view.eval("pluginBridge.getViewContext().appearance==='light'"), "live theme");
  // A real process restart reuses only the isolated test profile/data. Restore
  // must load a current provider subject, with no session/send side effects.
  writeFileSync(join(artifacts, "before-restart.json"), JSON.stringify(await host.eval("({saved:localStorage.getItem('pi-desktop.plugin-navigation.v1'),main:document.querySelector('[data-plugin-main-surface]')?.getAttribute('data-plugin-main-surface')})"), null, 2));
  const exited = new Promise(resolve => child.once("exit", resolve));
  await invoke("appQuit").catch(() => {});
  host.close(); view.close();
  await Promise.race([exited, delay(30000).then(() => { throw Error("Graceful isolated Desktop exit timed out"); })]);
  child = launch();
  const restarted = await waitFor(async () => (await targets()).find(target => target.type === "page" && target.url.includes("out/renderer/index.html") && !target.url.includes("surface=")), "restarted Desktop");
  host = await Client.connect(restarted.webSocketDebuggerUrl); clients.push(host); mainClient = host;
  await waitFor(() => host.eval("Boolean(document.querySelector('[data-plugin-main-surface]') && !document.querySelector('.app-shell.is-booting'))"), "durable main route restored");
  const restoredView = await waitFor(async () => (await targets()).find(target => target.type === "page" && target.url.includes("fixture/view.html")), "restored plugin surface");
  view = await Client.connect(restoredView.webSocketDebuggerUrl); clients.push(view);
  await waitFor(() => view.eval("pluginBridge.getViewContext().location?.botId==='one' && pluginBridge.getViewContext().placement==='main'"), "fresh restored subject");
  await host.eval(`__PI_DESKTOP__.selectSession(${JSON.stringify(created.session.id)})`);
  await waitFor(() => view.eval("pluginBridge.getViewContext().active===false"), "return to Host Session");
  assert.equal(await host.eval("Boolean(document.querySelector('[data-plugin-main-surface]'))"), false);
  const after = await invoke("sessionList"); assert.deepEqual(after.sessions.map(session => session.id), before.sessions.map(session => session.id));
  await invoke("pluginDisable", "demo.native-navigation");
  await waitFor(() => host.eval("!document.querySelector('[data-plugin-sidebar-section=\"demo.native-navigation/companions\"]')"), "disabled plugin cleanup");
  let actualPlugin = null;
  if (process.env.PI_DESKTOP_NATIVE_PLUGIN_PATH) {
    const actualPath = process.env.PI_DESKTOP_NATIVE_PLUGIN_PATH;
    const declaration = JSON.parse(readFileSync(join(actualPath, "manifest.json"), "utf8"));
    // Explicit UI-only persisted fixtures, seeded before the plugin loads. They
    // prove actual rendering/navigation, not Bot provisioning or model execution.
    const botId = "bot_native_ui_fixture";
    const conversationId = "conv_native_ui_fixture";
    const at = new Date().toISOString();
    const collectionDir = join(scratch, "data/plugins/data", declaration.id, "collections");
    mkdirSync(collectionDir, { recursive: true });
    const seed = (name, id, value) => writeFileSync(join(collectionDir, `${name}.json`), JSON.stringify({ schemaVersion: 1, records: { [id]: { revision: 1, value } } }));
    seed("bots", botId, { botId, name: "原生验收同伴", description: "Explicit UI fixture; no model configured or called", roleRevision: 1, modelRef: null, skillRefs: [], defaultHostRef: null, lifecycle: "setup_failed", display: { hidden: false, pinned: false }, createdByRef: { kind: "user" }, createdAt: at, updatedAt: at });
    seed("groups", conversationId, { conversationId, kind: "direct", title: "原生验收对话", memberVersion: 1, members: [{ botId, joinedAt: at, sharedRefs: [] }], visibilityRefs: [], createdAt: at, updatedAt: at });
    await invoke("pluginLoadDevConfirm", { path: actualPath, grantedPermissions: declaration.permissions });
    const selector = `[data-plugin-sidebar-section="${declaration.id}/bots"]`;
    await waitFor(() => host.eval(`Boolean(document.querySelector(${JSON.stringify(selector)}+' .plugin-sidebar-item'))`), "actual plugin Bot section");
    await host.eval(`[...document.querySelectorAll(${JSON.stringify(selector)}+' .plugin-sidebar-item')].find(button=>button.textContent.includes('管理同伴')).click()`);
    const actualPage = await waitFor(async () => (await targets()).find(target => target.type === "page" && decodeURIComponent(target.url).replaceAll("\\", "/").includes(actualPath.replaceAll("\\", "/") + "/renderer/index.html")), "actual isolated plugin page");
    const actual = await Client.connect(actualPage.webSocketDebuggerUrl); clients.push(actual);
    await waitFor(() => actual.eval("Boolean(document.querySelector('.workbench-native-main'))"), "actual embedded-main shell");
    await waitFor(() => host.eval(`[...document.querySelectorAll(${JSON.stringify(selector)}+' .plugin-sidebar-item')].some(button=>button.textContent.includes('原生验收同伴'))`), "actual persisted Bot row");
    await host.eval(`[...document.querySelectorAll(${JSON.stringify(selector)}+' .plugin-sidebar-item')].find(button=>button.textContent.includes('原生验收同伴')).click()`);
    try { await waitFor(() => actual.eval(`pluginBridge.getViewContext().location?.botId===${JSON.stringify(botId)} && Boolean(document.querySelector('.workbench-conv-head'))`), "actual Bot conversation"); } catch (error) { writeFileSync(join(artifacts, "actual-failure-state.json"), JSON.stringify(await actual.eval("({text:document.body.innerText,context:pluginBridge.getViewContext()})"), null, 2)); throw error; }
    assert.equal(await actual.eval("document.querySelector('.workbench-roster')?.getBoundingClientRect().width || 0"), 0);
    for (const theme of ["dark", "light"]) {
      await invoke("settingsSet", { theme });
      await waitFor(() => actual.eval(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`), `actual ${theme} theme`);
      const screenshot = await actual.send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(artifacts, `actual-plugin-${theme}.png`), Buffer.from(screenshot.data, "base64"));
    }
    await actual.eval("[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='详情').click()");
    await waitFor(() => actual.eval("document.body.innerText.includes('文件')"), "actual Bot file details");
    const fileScreenshot = await actual.send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(artifacts, "actual-plugin-files.png"), Buffer.from(fileScreenshot.data, "base64"));
    await host.eval(`__PI_DESKTOP__.selectSession(${JSON.stringify(created.session.id)})`);
    assert.equal(await host.eval("Boolean(document.querySelector('[data-plugin-main-surface]'))"), false);
    await host.eval(`[...document.querySelectorAll(${JSON.stringify(selector)}+' .plugin-sidebar-item')].find(button=>button.textContent.includes('原生验收同伴')).click()`);
    await waitFor(() => actual.eval(`pluginBridge.getViewContext().location?.botId===${JSON.stringify(botId)}`), "actual Bot reopened");
    const chromeShot = await host.send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(artifacts, "actual-host-chrome.png"), Buffer.from(chromeShot.data, "base64"));
    actualPlugin = { path: actualPath, mainHash: createHash("sha256").update(readFileSync(join(actualPath, "main.js"))).digest("hex"), rendererHash: createHash("sha256").update(readFileSync(join(actualPath, "renderer/index.html"))).digest("hex"), botId, conversationId, fixtureOnly: true, modelCalls: 0, checks: ["actual sidebar", "actual native shell", "persisted UI-only Bot/direct fixtures", "roster hidden", "dark/light", "file details", "return/reopen"] };
  }
  writeFileSync(join(artifacts, "result.json"), JSON.stringify({ passed: true, rect, scratch, hostSessionId: created.session.id, actualPlugin, checks: ["peer section", "isolated main placement", "literal labels", "subject cache", "draft retained", "same-item activation", "back/forward", "real restart route", "bounds", "menu occlusion", "deactivation", "live theme", "session preservation", "disable cleanup"] }, null, 2));
  console.log(`PASS native plugin navigation; artifacts: ${artifacts}; isolated scratch: ${scratch}`);
} catch (error) {
  writeFileSync(join(artifacts, "failure.log"), output);
  if (mainClient) {
    try { writeFileSync(join(artifacts, "failure-state.json"), JSON.stringify(await mainClient.eval("({text:document.body.innerText,bridge:typeof piDesktop,rig:typeof window.__PI_DESKTOP__,saved:localStorage.getItem('pi-desktop.plugin-navigation.v1'),html:document.body.innerHTML.slice(0,10000)})"), null, 2)); const shot = await mainClient.send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(artifacts, "failure.png"), Buffer.from(shot.data, "base64")); } catch {}
  }
  console.error(error); throw error;
}
finally { for (const client of clients) client.close(); child.kill(); }
