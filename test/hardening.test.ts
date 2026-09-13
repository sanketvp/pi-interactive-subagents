import {test} from 'node:test';
import assert from 'node:assert/strict';
import {safeScriptPreamble, validateLaunch, shouldCloseAfterWatchError} from '../pi-extension/subagents/hardening.ts';
import {shouldAutoExitOnAgentEnd} from '../pi-extension/subagents/subagent-done.ts';
import {__pollForExitTest__} from '../pi-extension/subagents/cmux.ts';

test('every line of generated metadata remains a shell comment',()=>{
 assert.equal(safeScriptPreamble('# worker\nprintf bad\rmore'), '# # worker\n# printf bad\n# more');
});
test('reject name controls, traversal, standalone CLIs and nested workers before launch',()=>{
 for(const name of ['bad\nname','bad\rname','bad\0name','bad\u001bname']) assert.throws(()=>validateLaunch({name},null));
 for(const agent of ['../escape','/tmp/agent','a/b']) assert.throws(()=>validateLaunch({name:'safe',agent},null));
 for(const cli of ['claude','codex','k3']) assert.throws(()=>validateLaunch({name:'safe'},{cli}));
 assert.throws(()=>validateLaunch({name:'safe'},null,true));
 assert.doesNotThrow(()=>validateLaunch({name:'safe',agent:'reviewer'},{cli:'pi'}));
});
test('watcher cancellation/error never authorizes closing a live pane',()=>{
 assert.equal(shouldCloseAfterWatchError(),false);
});
test('user takeover permanently disables automatic exit',()=>{
 assert.equal(shouldAutoExitOnAgentEnd(true,[{role:'assistant',stopReason:'stop'}]),false);
});
test('unknown completion payload fails closed',()=>{
 for(const value of [{},null,{type:'surprise'}]) assert.throws(()=>__pollForExitTest__.interpretExitSidecar(value));
});
