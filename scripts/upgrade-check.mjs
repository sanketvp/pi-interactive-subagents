#!/usr/bin/env node
// Read-only compatibility/preservation gate. Never upgrades or restarts anything.
import {execFileSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const expected={pi:'0.85.1',orca:'1.4.197',tmux:'tmux 3.7c'};
const results=[];
for(const [command,args] of [['pi',['--version']],['orca',['--version']],['tmux',['-V']]]) {
 try {const actual=execFileSync(command,args,{encoding:'utf8',timeout:15000}).trim();results.push({command,expected:expected[command],actual,approvedVersion:actual===expected[command]});}
 catch {results.push({command,approvedVersion:false,error:'Version check failed'});}
}
try {execFileSync(process.execPath,[resolve(repo,'scripts/host-customizations.mjs'),'verify'],{cwd:repo,timeout:15000});results.push({customizations:'verified'});}
catch {results.push({customizations:'drift-or-missing'});}
console.log(JSON.stringify({scope:'Version and source preservation only; not provider/swarm acceptance',results},null,2));
if(results.some(r=>r.approvedVersion===false || r.customizations==='drift-or-missing'))process.exitCode=1;
