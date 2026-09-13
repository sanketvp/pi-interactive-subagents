import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {writeCompletion,validateCompletion,writeStartupReceipt} from '../pi-extension/subagents/completion.mjs';
import {loadRegistry,writeRegistry,RegistryValidationError,effectiveInvocationLimit} from '../pi-extension/subagents/registry.ts';
import {persistOutcomePending,persistDeliveryAttempted,assertCanLaunch} from '../pi-extension/subagents/lifecycle.ts';
import {setLifecycleAdapter,createDefaultAdapter} from '../pi-extension/subagents/adapter.ts';

const cli=fileURLToPath(new URL('../pi-extension/subagents/completion.mjs',import.meta.url));

function identityEnv(root: string) {
  const env={
    PI_SUBAGENT_COMPLETION_FILE:join(root,'done.json'),
    PI_SUBAGENT_TOKEN:randomUUID(),
    PI_SUBAGENT_ID:randomUUID(),
    PI_SUBAGENT_SESSION:join(root,'worker.jsonl'),
  };
  return env;
}

test('authenticated completion accepts exact attempt, rejects stale and wrong identities',()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-completion-'));
 const env=identityEnv(root);
 const piSessionId=randomUUID();
 writeCompletion({type:'done',piSessionId},env);
 const data=JSON.parse(readFileSync(env.PI_SUBAGENT_COMPLETION_FILE,'utf8'));
 const identity={attemptId:env.PI_SUBAGENT_ID,token:env.PI_SUBAGENT_TOKEN,sessionFile:env.PI_SUBAGENT_SESSION,piSessionId};
 assert.doesNotThrow(()=>validateCompletion(data,identity));
 assert.throws(()=>validateCompletion({...data,token:'stale'},identity));
 assert.throws(()=>validateCompletion({...data,attemptId:'other'},identity));
 assert.throws(()=>validateCompletion({...data,type:'unknown'},identity));
 assert.throws(()=>validateCompletion({...data,piSessionId:'other'},identity));
 assert.equal(statSync(env.PI_SUBAGENT_COMPLETION_FILE).mode & 0o777,0o600);
});

test('shell exit 0 without a child outcome writes error; prior child error is preserved',()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-exit-'));
 const env=identityEnv(root);
 execFileSync(process.execPath,[cli,env.PI_SUBAGENT_COMPLETION_FILE,env.PI_SUBAGENT_ID,env.PI_SUBAGENT_TOKEN,env.PI_SUBAGENT_SESSION,'0']);
 const missing=JSON.parse(readFileSync(env.PI_SUBAGENT_COMPLETION_FILE,'utf8'));
 assert.equal(missing.type,'error');
 assert.match(missing.errorMessage,/pi exited 0 without a completion record/);
 assert.equal(JSON.parse(readFileSync(env.PI_SUBAGENT_COMPLETION_FILE+'.exit','utf8')).kind,'shell-exit');
 writeFileSync(join(root,'other.json'),'');
 // Fresh attempt/completion file (not the one the shell fallback above
 // already populated): the child authors its own authenticated error
 // FIRST, then the shell wrapper observes exit 0. The shell fallback's
 // own `existing` check must preserve the child's record untouched.
 const env2=identityEnv(mkdtempSync(join(tmpdir(),'pi-exit-2-')));
 writeCompletion({type:'error',errorMessage:'provider failure',piSessionId:null},env2);
 execFileSync(process.execPath,[cli,env2.PI_SUBAGENT_COMPLETION_FILE,env2.PI_SUBAGENT_ID,env2.PI_SUBAGENT_TOKEN,env2.PI_SUBAGENT_SESSION,'0']);
 assert.equal(JSON.parse(readFileSync(env2.PI_SUBAGENT_COMPLETION_FILE,'utf8')).type,'error');
 assert.equal(JSON.parse(readFileSync(env2.PI_SUBAGENT_COMPLETION_FILE,'utf8')).errorMessage,'provider failure');
});

test('writeAtomic/writeCompletion is first-writer-wins: a second terminal write cannot replace the first',()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-first-writer-'));
 const env=identityEnv(root);
 const first=writeCompletion({type:'done',piSessionId:randomUUID()},env);
 const secondPiSessionId=randomUUID();
 const second=writeCompletion({type:'error',errorMessage:'should never land',piSessionId:secondPiSessionId},env);
 // writeCompletion itself doesn't report success/failure to the caller
 // (it always returns the value it attempted to write), so assert against
 // what's actually durably on disk: the FIRST record, untouched.
 void second;
 const onDisk=JSON.parse(readFileSync(env.PI_SUBAGENT_COMPLETION_FILE,'utf8'));
 assert.equal(onDisk.type,'done');
 assert.equal(onDisk.piSessionId,first.piSessionId);
 assert.notEqual(onDisk.piSessionId,secondPiSessionId);
});

test('startup receipt requires exact session/model fields',()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-start-'));
 const env=identityEnv(root);
 assert.throws(()=>writeStartupReceipt({piSessionId:null,observed:{provider:'x',model:'y',thinking:'high'}},env));
 const receipt=writeStartupReceipt({piSessionId:randomUUID(),observed:{provider:'xai',model:'grok-4.6',thinking:'high'}},env);
 assert.equal(receipt.kind,'startup');
 assert.equal(existsSync(env.PI_SUBAGENT_COMPLETION_FILE+'.start'),true);
});

test('strict registry validation fail-closed; extra keys preserved; invocation limit is per-session adjustable',()=>{
 setLifecycleAdapter(createDefaultAdapter());
 const root=mkdtempSync(join(tmpdir(),'pi-registry-'));
 const path=join(root,'workers.json');
 const loaded=loadRegistry(path);
 assert.equal(loaded.status,'missing');
 const worker={
  attemptId:randomUUID(),
  parentSessionId:randomUUID(),
  piSessionId:null,
  invocation:1,
  completionToken:randomUUID(),
  tmuxSocket:'/tmp/tmux-test/sock',
  windowId:'@0',
  surface:'%1',
  sessionFile:join(root,'session.jsonl'),
  launchScriptFile:join(root,'launch.sh'),
  completionFile:join(root,'done.json'),
  paneStartCommand:'bash '+join(root,'launch.sh'),
  requested:{provider:'xai',model:'grok-4.6',thinking:'high'},
  observed:null,
  resourceState:'running',
  outcome:null,
  outcomeBytes:null,
  outcomeDigest:null,
  deliveryState:null,
  createdAt:1,
  name:'reviewer',
  task:'review',
  legacyNote:'keep me',
 };
 writeRegistry(path,1,[worker]);
 const saved=loadRegistry(path);
 assert.equal(saved.status,'ok');
 assert.equal(saved.registry.invocations,1);
 assert.equal(saved.registry.workers[0].completionToken,worker.completionToken);
 assert.equal(saved.registry.workers[0].legacyNote,'keep me');
 writeFileSync(path,'not JSON');
 const invalid=loadRegistry(path);
 assert.equal(invalid.status,'invalid');
 assert.equal(readFileSync(path,'utf8'),'not JSON');
 // Default limit 12 is enforced at LAUNCH time, not storage time: a raised
 // limit must be storable, and invocationLimit is validated.
 writeRegistry(path,13,[worker],{invocationLimit:20});
 const raised=loadRegistry(path);
 assert.equal(raised.status,'ok');
 assert.equal(effectiveInvocationLimit(raised.registry),20);
 assert.doesNotThrow(()=>assertCanLaunch({...raised.registry,workers:[]}));
 assert.throws(()=>assertCanLaunch({version:1,invocations:12,workers:[]}),/Invocation budget reached \(12\/12/);
 assert.throws(()=>assertCanLaunch({version:1,invocations:20,workers:[],invocationLimit:20}),/Invocation budget reached/);
 assert.doesNotThrow(()=>assertCanLaunch({version:1,invocations:500,workers:[],invocationLimit:null}),'null removes the limit');
 assert.equal(effectiveInvocationLimit({invocationLimit:null}),null);
 assert.equal(effectiveInvocationLimit({}),12);
 assert.throws(()=>writeRegistry(path,1,[worker],{invocationLimit:0}),RegistryValidationError);
 assert.throws(()=>writeRegistry(path,1,[worker],{invocationLimit:'lots'}),RegistryValidationError);
 assert.throws(()=>writeRegistry(path,100_001,[worker],{invocationLimit:null}),RegistryValidationError);
});

test('outbox persists pending before attempted and never treats outcome as capacity release',()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-outbox-'));
 const path=join(root,'workers.json');
 const worker={
  attemptId:randomUUID(),
  parentSessionId:randomUUID(),
  piSessionId:randomUUID(),
  invocation:1,
  completionToken:randomUUID(),
  tmuxSocket:'/tmp/tmux-test/sock',
  windowId:'@0',
  surface:'%3',
  sessionFile:join(root,'session.jsonl'),
  launchScriptFile:join(root,'launch.sh'),
  completionFile:join(root,'done.json'),
  paneStartCommand:'bash '+join(root,'launch.sh'),
  requested:{provider:'xai',model:'grok-4.6',thinking:'high'},
  observed:{provider:'xai',model:'grok-4.6',thinking:'high'},
  resourceState:'running',
  outcome:null,
  outcomeBytes:null,
  outcomeDigest:null,
  deliveryState:null,
  createdAt:1,
  name:'reviewer',
  task:'review',
 };
 writeRegistry(path,1,[worker]);
 const registry={version:1 as const,invocations:1,workers:[worker]};
 const pending=persistOutcomePending(path,registry,worker,'done',JSON.stringify({type:'done'}));
 assert.equal(pending.record.deliveryState,'pending');
 assert.equal(pending.record.resourceState,'running');
 const attempted=persistDeliveryAttempted(path,pending.registry,pending.record);
 assert.equal(attempted.record.deliveryState,'attempted');
 assert.equal(attempted.record.resourceState,'running');
});
