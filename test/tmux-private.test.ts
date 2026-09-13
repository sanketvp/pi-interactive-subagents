import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,chmodSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDefaultAdapter,setLifecycleAdapter} from '../pi-extension/subagents/adapter.ts';
import {applyRecovery,freezePaneStartCommand} from '../pi-extension/subagents/lifecycle.ts';
import {closeSurface} from '../pi-extension/subagents/cmux.ts';

test('real private tmux: creation identity before tags, no focus change, exact-token close', {timeout:20000}, async()=>{
 const socketName='pi-test-'+randomUUID();
 const root=mkdtempSync(join(tmpdir(),'pi-tmux-life-'));
 const tmux=(...args:string[])=>execFileSync('tmux',['-L',socketName,'-f','/dev/null',...args],{encoding:'utf8',timeout:3000}).trim();
 try {
  tmux('new-session','-d','-x','120','-y','40','-s','life','/bin/sh');
  const parent=tmux('display-message','-p','-t','life','#{pane_id}');
  const window=tmux('display-message','-p','-t',parent,'#{window_id}');
  const socketPath=tmux('display-message','-p','-t',parent,'#{socket_path}');
  const focus=tmux('display-message','-p','-t','life','#{pane_id}');
  const waitFile=join(root,'go-tag');
  const script=join(root,`attempt-${randomUUID()}.sh`);
  const attemptId=randomUUID();
  const token=randomUUID();
  writeFileSync(script,`#!/bin/bash
set -eu
while [ ! -f '${waitFile.replace(/'/g, `'\\''`)}' ]; do sleep 0.05; done
tmux -S '${socketPath.replace(/'/g, `'\\''`)}' set-option -p -t "$TMUX_PANE" @pi-attempt '${attemptId}' && tmux -S '${socketPath.replace(/'/g, `'\\''`)}' set-option -p -t "$TMUX_PANE" @pi-worker-token '${token}' || exit 66
exec /bin/sh
`);
  chmodSync(script,0o600);
  const pane=tmux('split-window','-d','-P','-F','#{pane_id}','-t',window,'--','bash',script);
  assert.match(pane,/^%\d+$/);
  const startCmd=tmux('display-message','-p','-t',pane,'#{pane_start_command}');
  assert.equal(startCmd,freezePaneStartCommand(script));
  assert.equal(tmux('display-message','-p','-t','life','#{pane_id}'),focus);
  let tagBefore='';
  try { tagBefore=tmux('show-options','-p','-v','-t',pane,'@pi-attempt'); } catch { tagBefore=''; }
  assert.equal(tagBefore,'');
  const adapter=createDefaultAdapter();
  setLifecycleAdapter(adapter);
  const record:any={
   attemptId, completionToken:token, tmuxSocket:socketPath, windowId:window,
   surface:null, paneStartCommand:startCmd, resourceState:'split_requested',
   parentSessionId:randomUUID(), piSessionId:null, invocation:1,
   sessionFile:join(root,'s.jsonl'), launchScriptFile:script, completionFile:join(root,'done.json'),
   requested:{provider:'xai',model:'grok-4.6',thinking:'high'}, observed:null,
   outcome:null, outcomeBytes:null, outcomeDigest:null, deliveryState:null,
   createdAt:Date.now(), name:'paused', task:'pause',
  };
  const recovered=applyRecovery(join(root,'workers.json'), {version:1,invocations:1,workers:[record]}, record, socketPath, adapter);
  assert.equal(recovered.record.surface,pane);
  writeFileSync(waitFile,'go\n');
  const deadline=Date.now()+5000;
  let tagged='';
  while(Date.now()<deadline){
   try { tagged=tmux('show-options','-p','-v','-t',pane,'@pi-attempt'); } catch { tagged=''; }
   if(tagged===attemptId) break;
   await new Promise(r=>setTimeout(r,50));
  }
  assert.equal(tagged,attemptId);
  assert.equal(tmux('display-message','-p','-t','life','#{pane_id}'),focus);
  process.env.PI_SUBAGENT_MUX='tmux';
  process.env.TMUX=`${socketPath},1,0`;
  assert.throws(()=>closeSurface(pane,'wrong-owner'),/ownership changed/);
  closeSurface(pane,token);
  assert.equal(tmux('list-panes','-t','life','-F','#{pane_id}'),parent);
  assert.equal(existsSync(script),true);
 } finally {
  try{execFileSync('tmux',['-L',socketName,'kill-server'],{encoding:'utf8',timeout:3000});}catch{}
  setLifecycleAdapter(null);
 }
});
