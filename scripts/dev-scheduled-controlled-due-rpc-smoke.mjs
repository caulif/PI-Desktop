// Actual Host RPC + controlled scheduler time. Consent is SYNTHETIC fixture data.
// No Electron/native click, plugin Run/Attempt, or model acceptance is claimed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, mkdir, realpath, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Host } from "./e2e/host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); assert(i >= 0 && args[i+1],`${name} required`); return args[i+1]; };
const binary = await realpath(resolve(option("--host")));
const outputDir = resolve(option("--output-dir"));
await mkdir(outputDir,{recursive:false});
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const examplePath = join(root,"scripts/dev-scheduled-controlled-due-plan.examples.json");
const examples = JSON.parse(await readFile(examplePath,"utf8"));
const dirtyDiff = execFileSync("git",["diff","HEAD","--binary"],{cwd:root});
await writeFile(join(outputDir,"source-dirty.diff"),dirtyDiff);
const sourceFiles = {};
for (const path of ["crates/host-core/src/main.rs","crates/host-core/src/scheduled.rs",
  "crates/host-core/src/plugin_scheduled.rs","crates/host-core/src/scheduled/diagnostic_due.rs",
  "crates/host-core/src/rpc/scheduled_rpc.rs","scripts/dev-scheduled-controlled-due-rpc-smoke.mjs"]) {
  sourceFiles[path] = hash(await readFile(join(root,path)));
}
const report = { classification:"realHostControlledTimeSyntheticConsentZeroModel",
  sourceHead:execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim(),
  dirtyDiffSha256:hash(dirtyDiff),sourceFiles,binary,binarySha256:hash(await readFile(binary)),
  examplePlanSha256:hash(await readFile(examplePath)),modelCalls:0,syntheticConsent:true,
  nativeConsentAcceptance:false,pluginRunAttemptAcceptance:false,status:"running",cases:[],profiles:[],ownedHostPids:[] };
const originalPreview = process.env.PI_DESKTOP_DEV_CALENDAR_PREVIEW_DIR;
const originalDue = process.env.PI_DESKTOP_DEV_SCHEDULE_DUE_DIR;
const active = new Set();
function envProfile(profile,optIn=true) {
  process.env.PI_DESKTOP_DEV_CALENDAR_PREVIEW_DIR=profile;
  if (optIn) process.env.PI_DESKTOP_DEV_SCHEDULE_DUE_DIR=profile;
  else delete process.env.PI_DESKTOP_DEV_SCHEDULE_DUE_DIR;
}
async function start(profile,optIn=true) {
  envProfile(profile,optIn);
  const host = new Host(binary,profile); active.add(host);
  await host.start(); report.ownedHostPids.push(host.child.pid); return host;
}
async function stopNormally(host) {
  if (!host?.child) return;
  const child=host.child; const exited=once(child,"exit"); let timer;
  child.stdin.end();
  try { const [code,signal]=await Promise.race([exited,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Error("Host normal EOF shutdown timed out")),15000);
  })]); assert.equal(code,0); assert.equal(signal,null); }
  finally { clearTimeout(timer); await host.stop(); active.delete(host); }
}
async function fixture(host,caseName,schedule) {
  const session=(await host.call("session.create",{title:`Controlled due ${caseName} fixture`,mode:"agent"})).session;
  const pluginId="dev.synthetic-due", externalKey=`fixture-${caseName}`;
  await host.call("scheduled.pluginRegisterCreatedSession",{pluginId,sessionId:session.id});
  const definition={pluginId,externalKey,definitionRevision:1,title:`Synthetic consent ${caseName}`,
    cadence:"daily",schedule,timezone:"America/New_York",enabled:true,sessionId:session.id,
    goalHash:"a".repeat(64),promptTemplateHash:"b".repeat(64),nativeAuthorized:true};
  const binding=await host.call("scheduled.pluginUpsert",definition);
  assert(binding.schedulerTaskId && binding.task.enabled);
  return {pluginId,externalKey,definition,binding};
}
const request=(identity,step)=>({pluginId:identity.pluginId,externalKey:identity.externalKey,
  expectedDefinitionRevision:1,expectedTimezone:"America/New_York",now:step.now,
  ...(step.seedAfter?{seedAfter:step.seedAfter}:{})});
function coldSnapshot(profile) {
  const db=new DatabaseSync(join(profile,"pi.sqlite"),{readOnly:true});
  try { return {bindings:db.prepare("SELECT * FROM plugin_schedule_bindings ORDER BY task_id").all(),
    occurrences:db.prepare("SELECT * FROM plugin_schedule_occurrences ORDER BY scheduled_for").all(),
    tasks:db.prepare("SELECT * FROM scheduled_tasks ORDER BY id").all(),
    intents:db.prepare("SELECT * FROM plugin_automation_intents").all(),
    turnCount:db.prepare("SELECT COUNT(*) n FROM turns").get().n}; }
  finally { db.close(); }
}
try {
  for (const plan of examples.plans) {
    const profile=await mkdtemp(join(tmpdir(),"pi-bot-calendar-preview-")); report.profiles.push(profile);
    let host=await start(profile); const identity=await fixture(host,plan.case,plan.expectedSchedule);
    const caseReport={name:plan.case,profile,identity,steps:[]};
    for (const step of plan.steps) {
      if (step.restart) { await stopNormally(host); host=await start(profile); }
      const result=await host.call("scheduled.devPluginDueAt",request(identity,step));
      assert.deepEqual(result.occurrences.map(row=>row.scheduledFor),step.expectedPending);
      const history=result.binding.occurrences.map(row=>({scheduledFor:row.scheduledFor,state:row.state,skipReason:row.skipReason}));
      assert.deepEqual(history.sort((a,b)=>a.scheduledFor.localeCompare(b.scheduledFor)),
        [...step.expectedHistory].sort((a,b)=>a.scheduledFor.localeCompare(b.scheduledFor)));
      caseReport.steps.push({request:request(identity,step),result});
    }
    await stopNormally(host); const before=coldSnapshot(profile);
    assert.equal(before.intents.length,0); assert.equal(before.turnCount,0);
    host=await start(profile);
    const restored=await host.call("scheduled.pluginGet",{pluginId:identity.pluginId,externalKey:identity.externalKey});
    assert.deepEqual(restored.binding,caseReport.steps.at(-1).result.binding);
    await stopNormally(host); assert.deepEqual(coldSnapshot(profile),before);
    caseReport.coldRestartExact=true; caseReport.coldSnapshot=before;
    host=await start(profile);
    await host.call("scheduled.pluginDisable",{pluginId:identity.pluginId,externalKey:identity.externalKey});
    const disabled=await host.call("scheduled.pluginGet",{pluginId:identity.pluginId,externalKey:identity.externalKey});
    await assert.rejects(host.call("scheduled.devPluginDueAt",request(identity,plan.steps.at(-1))),
      error=>error.rpc?.code===1002 && error.rpc?.data?.errorCode==="INVALID_PARAMS");
    assert.deepEqual(await host.call("scheduled.pluginGet",{pluginId:identity.pluginId,externalKey:identity.externalKey}),disabled);
    await stopNormally(host); caseReport.disabledRejectedUnchanged=true; report.cases.push(caseReport);
  }
  const profile=await mkdtemp(join(tmpdir(),"pi-bot-calendar-preview-")); report.profiles.push(profile);
  const host=await start(profile,false); const identity=await fixture(host,"env-off",{hour:1,minute:30,weekday:0});
  const before=await host.call("scheduled.pluginGet",{pluginId:identity.pluginId,externalKey:identity.externalKey});
  await assert.rejects(host.call("scheduled.devPluginDueAt",request(identity,examples.plans[1].steps[0])),
    error=>error.rpc?.code===1003 && error.rpc?.data?.errorCode==="PERMISSION_DENIED");
  assert.deepEqual(await host.call("scheduled.pluginGet",{pluginId:identity.pluginId,externalKey:identity.externalKey}),before);
  await stopNormally(host); report.cases.push({name:"env_off_rejected_unchanged",profile,passed:true});
  const denied=await mkdtemp(join(tmpdir(),"pi-bot-controlled-due-denied-")); report.profiles.push(denied);
  const env={...process.env,PI_DESKTOP_DATA_DIR:denied,PI_DESKTOP_DEV_CALENDAR_PREVIEW_DIR:denied,PI_DESKTOP_DEV_SCHEDULE_DUE_DIR:denied};
  const child=spawn(binary,[],{env,stdio:["pipe","pipe","pipe"],windowsHide:true});
  report.ownedHostPids.push(child.pid); let stderr=""; child.stderr.on("data",bytes=>{stderr+=bytes;});
  let deniedTimer;
  let code,signal;
  try { [code,signal]=await Promise.race([once(child,"exit"),new Promise((_,reject)=>{
    deniedTimer=setTimeout(()=>{child.kill();reject(Error("Denied profile did not exit before database open"));},15000);
  })]); } finally {clearTimeout(deniedTimer);}
  assert.equal(code,1); assert.equal(signal,null);
  assert.match(stderr,/exact dedicated temporary profile/);
  await assert.rejects(access(join(denied,"pi.sqlite")),error=>error.code==="ENOENT");
  report.cases.push({name:"profile_gate_rejected_before_database_open",profile:denied,passed:true});
  report.status="passed";
} catch(error) { report.status="failed";report.error=error.message;process.exitCode=1; }
finally {
  for (const host of active) { try { await stopNormally(host); } catch(error) { report.status="failed"; report.shutdownError=error.message; process.exitCode=1; } }
  for (const [name,value] of [["PI_DESKTOP_DEV_CALENDAR_PREVIEW_DIR",originalPreview],["PI_DESKTOP_DEV_SCHEDULE_DUE_DIR",originalDue]]) {
    if(value===undefined) delete process.env[name]; else process.env[name]=value;
  }
  const remaining=report.ownedHostPids.filter(pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code!=="ESRCH") throw error;return false;}});
  report.ownedHostPidsStillAlive=remaining; report.noOwnedHostWriter=remaining.length===0;
  if(remaining.length) {report.status="failed";process.exitCode=1;}
  const output=join(outputDir,"report.json"); await writeFile(output,`${JSON.stringify(report,null,2)}\n`);
  console.log(JSON.stringify({status:report.status,report:output,classification:report.classification}));
}
