// Real candidate Host processes, isolated data only. Approval is a trusted-main
// RPC fixture, NOT a native consent click and NOT human quality review.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, realpath, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const index=process.argv.indexOf("--host");
assert(index>=0 && process.argv[index+1],"--host requires the freshly built candidate executable");
const binary=await realpath(resolve(process.argv[index+1]));
const node=await realpath(process.execPath);
const base=await mkdtemp(join(tmpdir(),"pi-bot-verification-"));
const profile=join(base,"profile"); const project=join(base,"project");
await mkdir(profile); await mkdir(project);
const sha=value=>createHash("sha256").update(value).digest("hex");
const git=args=>execFileSync("git",args,{cwd:root,encoding:"utf8",windowsHide:true});
async function sourceIdentity() {
  const paths=git(["ls-files","-z","--cached","--others","--exclude-standard"]).split("\0").filter(Boolean)
    .filter(path=>/^(crates\/host-core\/src\/|apps\/desktop\/electron\/|packages\/shared\/src\/|Cargo\.(toml|lock)$)/.test(path))
    .sort();
  const files=[];
  for(const path of paths) {
    try { files.push({path,sha256:sha(await readFile(join(root,path)))}); }
    catch(error) { if(error.code==="ENOENT") files.push({path,deleted:true}); else throw error; }
  }
  return {head:git(["rev-parse","HEAD"]).trim(),diffSha256:sha(git(["diff","--binary","HEAD"])),sourceSha256:sha(JSON.stringify(files)),files};
}
const initialSource=await sourceIdentity();
const report={kind:"real_host_approved_check_execution",approvalEvidence:"trusted_main_rpc_fixture_approval",
  nativeConsentClicked:false,humanReview:false,modelCalls:0,modelCost:0,base,profile,project,binary,
  binarySha256:sha(await readFile(binary)),node,nodeSha256:sha(await readFile(node)),source:initialSource,
  harnessSha256:sha(await readFile(fileURLToPath(import.meta.url))),status:"running",cases:[]};

const script=`import fs from 'node:fs';
const [mode,marker]=process.argv.slice(2);
fs.appendFileSync(marker,'run:'+process.pid+'\\n');
if(mode==='normal') setTimeout(()=>process.stdout.write('verified\\n'),300);
else if(mode==='output') process.stdout.write('x'.repeat(10000));
else setTimeout(()=>process.stdout.write('late\\n'),10000);
`;
await writeFile(join(project,"check.mjs"),script);
execFileSync("git",["init","--quiet","--template="],{cwd:project,windowsHide:true});
const hooks=join(project,".git","empty-hooks"); await mkdir(hooks);
execFileSync("git",["-c","user.name=Verification Fixture","-c","user.email=verification@example.invalid",
  "-c","commit.gpgsign=false","-c",`core.hooksPath=${hooks}`,"commit","--quiet","--allow-empty","-m","Isolated acceptance baseline"],{cwd:project,windowsHide:true});

function launch() {
  const env={...process.env,PI_DESKTOP_DATA_DIR:profile};
  delete env.PI_DESKTOP_DEV_CALENDAR_PREVIEW_DIR;
  const child=spawn(binary,[],{cwd:root,env,windowsHide:true,stdio:["pipe","pipe","pipe"]});
  let sequence=0, stderr="", ended=false; const pending=new Map();
  const exited=new Promise(resolveExit=>{
    child.on("error",error=>{ended=true;for(const wait of pending.values()){clearTimeout(wait.timer);wait.reject(error);}pending.clear();resolveExit({error:error.message});});
    child.on("exit",(code,signal)=>{ended=true;for(const wait of pending.values()){clearTimeout(wait.timer);wait.reject(Object.assign(Error("Host exited before reply"),{code:"HOST_EXIT"}));}pending.clear();resolveExit({code,signal});});
  });
  child.stderr.on("data",data=>{stderr=(stderr+data).slice(-6000);});
  child.stdin.on("error",()=>{});
  createInterface({input:child.stdout}).on("line",line=>{
    let frame; try{frame=JSON.parse(line);}catch{return;}
    const wait=pending.get(frame.id); if(!wait)return;
    pending.delete(frame.id);clearTimeout(wait.timer);
    if(frame.error)wait.reject(Object.assign(Error(frame.error.message),{rpc:frame.error}));else wait.resolve(frame.result);
  });
  const call=(method,params={})=>new Promise((resolveCall,reject)=>{
    if(ended)return reject(Error("Host already exited"));
    const id=++sequence;
    const timer=setTimeout(()=>{pending.delete(id);reject(Error(`RPC timeout: ${method}`));},20_000);
    pending.set(id,{resolve:resolveCall,reject,timer});
    child.stdin.write(`${JSON.stringify({jsonrpc:"2.0",id,method,params})}\n`);
  });
  const stop=async(abrupt=false)=>{
    if(!ended){if(abrupt)child.kill();else child.stdin.end();}
    const timer=setTimeout(()=>child.kill(),10_000);
    try{return await exited;}finally{clearTimeout(timer);}
  };
  return {call,stop,stderr:()=>stderr};
}
const pluginId="dev.approved-verification";
let host=launch();
let sessionId;
const receipts=[];
const count=async marker=>{try{return (await readFile(marker,"utf8")).split("\n").filter(Boolean).length;}catch(error){if(error.code==="ENOENT")return 0;throw error;}};
async function started(marker) {
  const deadline=Date.now()+8000;
  while(Date.now()<deadline){try{await access(marker);return;}catch{await new Promise(resolveWait=>setTimeout(resolveWait,25));}}
  throw Error("approved Node check did not start");
}
async function stopped(marker) {
  const pid=Number((await readFile(marker,"utf8")).trim().split(":")[1]);
  assert(Number.isSafeInteger(pid) && pid>0,"script must record its actual child PID");
  const deadline=Date.now()+3000;
  while(Date.now()<deadline) {
    try { process.kill(pid,0); }
    catch(error) { if(error.code==="ESRCH")return pid; throw error; }
    await new Promise(resolveWait=>setTimeout(resolveWait,25));
  }
  throw Error(`approved check process still exists after cleanup: ${pid}`);
}
async function approve(mode,id,{timeoutMs=4000,maxOutputBytes=4096}={}) {
  const marker=join(base,`${id}.marker`);
  const definition={program:node,args:["check.mjs",mode,marker],scriptPins:[{path:"check.mjs",sha256:sha(script)}],
    timeoutMs,maxOutputBytes,expiresAt:Date.now()+300_000};
  const challenge=await host.call("plugin.verification.beginApproval",{pluginId,sessionId,projectPath:project,definition});
  assert.equal(challenge.check.programSha256,report.nodeSha256);
  assert.match(challenge.token,/^[a-f0-9-]{36}$/);
  const grant=await host.call("plugin.verification.approveCheck",{token:challenge.token});
  await assert.rejects(host.call("plugin.verification.approveCheck",{token:challenge.token}));
  const beforeSnapshot=await host.call("plugin.verification.snapshot",{pluginId,commandId:grant.commandId,projectPath:project});
  const request={pluginId,executionId:`fixture-${id}`,commandId:grant.commandId,projectPath:project,
    identity:{specId:`spec-${id}`,specVersion:1,artifactId:`artifact-${id}`,artifactRevision:1,contentHash:sha(`artifact-${id}`)},beforeSnapshot};
  return {request,marker,grant};
}
function checkBytes(receipt) {
  assert(Array.isArray(receipt.output) && receipt.output.length<=1_000_000);
  assert.equal(receipt.outputSha256,sha(Buffer.from(receipt.output)));
}
function retain(name,receipt,extra={}) {
  // Evidence uses hashes and a small fixed-script excerpt, not megabytes of output.
  const {output,...summary}=receipt;
  receipts.push(summary);
  report.cases.push({name,passed:true,...extra,receipt:{...summary,outputBytes:output.length,outputPreview:Buffer.from(output).toString("utf8").slice(0,160)}});
}
try {
  report.handshake=await host.call("app.handshake",{protocolVersion:11});
  const session=await host.call("session.create",{title:"Approved check acceptance",projectPath:project});
  sessionId=session.session.id;
  await host.call("scheduled.pluginRegisterCreatedSession",{pluginId,sessionId});

  const normal=await approve("normal","normal");
  const pending=host.call("plugin.verification.runApprovedCheck",normal.request);
  await started(normal.marker);
  const duplicate=await host.call("plugin.verification.runApprovedCheck",normal.request).then(value=>({receipt:value}),error=>({error:error.rpc ?? {message:error.message}}));
  const completed=await pending;
  assert.equal(completed.state,"completed");assert.equal(completed.exitCode,0);checkBytes(completed);
  assert.deepEqual(completed.beforeSnapshot,normal.request.beforeSnapshot);assert.deepEqual(completed.afterSnapshot,normal.request.beforeSnapshot);
  assert.equal(Buffer.from(completed.output).toString("utf8"),"verified\n");
  assert.equal(await count(normal.marker),1);
  assert.deepEqual(await host.call("plugin.verification.lookupExecution",normal.request),completed);
  assert.deepEqual(await host.call("plugin.verification.runApprovedCheck",normal.request),completed);
  assert.equal(await count(normal.marker),1);
  retain("real_exit_hash_snapshot_and_idempotent_duplicate",completed,{markerCount:1,concurrentDuplicate:duplicate.receipt ? {state:duplicate.receipt.state} : duplicate});

  await host.call("plugin.verification.revokeCheck",{pluginId,commandId:normal.request.commandId});
  assert.deepEqual(await host.call("plugin.verification.lookupExecution",normal.request),completed);
  const cancelledSaved=await host.call("plugin.verification.cancelExecution",normal.request);
  assert.equal(cancelledSaved.cancelRequested,true);assert.equal(cancelledSaved.state,"completed");
  await assert.rejects(host.call("plugin.verification.snapshot",{pluginId,commandId:normal.request.commandId,projectPath:project}));
  await assert.rejects(host.call("plugin.verification.lookupExecution",{...normal.request,pluginId:"foreign"}));
  await assert.rejects(host.call("plugin.verification.lookupExecution",{...normal.request,identity:{...normal.request.identity,contentHash:"f".repeat(64)}}));
  report.cases.push({name:"revoked_saved_lookup_cancel_and_foreign_hash_refusal",passed:true});

  const cancellation=await approve("wait","cancel");
  const cancelling=host.call("plugin.verification.runApprovedCheck",cancellation.request);
  await started(cancellation.marker);
  await host.call("plugin.verification.revokeCheck",{pluginId,commandId:cancellation.request.commandId});
  const intent=await host.call("plugin.verification.cancelExecution",cancellation.request);assert.equal(intent.cancelRequested,true);
  const cancelled=await cancelling;assert.notEqual(cancelled.state,"completed");checkBytes(cancelled);
  assert.equal(cancelled.cancelRequested,true);assert.equal(await count(cancellation.marker),1);
  retain("actual_cancellation_after_revoke",cancelled,{stoppedPid:await stopped(cancellation.marker)});

  const timeout=await approve("wait","timeout",{timeoutMs:1000});
  const timedOut=await host.call("plugin.verification.runApprovedCheck",timeout.request);
  assert.notEqual(timedOut.state,"completed");assert.equal(timedOut.incompleteReason,"timed_out");checkBytes(timedOut);
  assert.equal(await count(timeout.marker),1);
  retain("actual_timeout",timedOut,{stoppedPid:await stopped(timeout.marker)});
  const limited=await approve("output","output",{maxOutputBytes:512});
  const outputLimited=await host.call("plugin.verification.runApprovedCheck",limited.request);
  assert.notEqual(outputLimited.state,"completed");assert.equal(outputLimited.incompleteReason,"output_limited");
  assert.equal(outputLimited.output.length,512);checkBytes(outputLimited);retain("actual_output_limit",outputLimited);

  const cold=await approve("wait","cold");
  const interrupted=host.call("plugin.verification.runApprovedCheck",cold.request).then(value=>({value}),error=>({error:error.message}));
  await started(cold.marker);
  assert.equal((await host.call("plugin.verification.lookupExecution",cold.request)).state,"executing");
  report.abruptExit=await host.stop(true);await interrupted;
  const coldStoppedPid=await stopped(cold.marker);
  host=launch();await host.call("app.handshake",{protocolVersion:11});
  const restored=await host.call("plugin.verification.lookupExecution",cold.request);
  assert.equal(restored.state,"unknown");assert.equal(restored.incompleteReason,"cold_restart");
  assert.deepEqual(restored.beforeSnapshot,cold.request.beforeSnapshot);
  assert.deepEqual(await host.call("plugin.verification.runApprovedCheck",cold.request),restored);
  await new Promise(resolveWait=>setTimeout(resolveWait,300));assert.equal(await count(cold.marker),1);
  report.cases.push({name:"abrupt_host_restart_unknown_lookup_no_relaunch",passed:true,receipt:restored,markerCount:1,stoppedPid:coldStoppedPid});

  const endingSource=await sourceIdentity();report.endingSource={head:endingSource.head,diffSha256:endingSource.diffSha256,sourceSha256:endingSource.sourceSha256};
  assert.equal(endingSource.sourceSha256,initialSource.sourceSha256,"source changed during acceptance; evidence must be rerun");
  assert.equal(endingSource.diffSha256,initialSource.diffSha256,"diff changed during acceptance; evidence must be rerun");
  assert.equal(sha(await readFile(binary)),report.binarySha256,"candidate binary changed during acceptance");
  report.normalExit=await host.stop();assert.equal(report.normalExit.code,0);
  report.status="passed";
} catch(error) {
  report.status="failed";report.error={message:error.message,rpc:error.rpc};process.exitCode=1;
} finally {
  await host.stop();
  report.stderrTail=host.stderr();
  const output=join(base,"approved-verification-report.json");
  await writeFile(output,`${JSON.stringify(report,null,2)}\n`);
  console.log(JSON.stringify({status:report.status,report:output,approvalEvidence:report.approvalEvidence,modelCalls:0}));
}
