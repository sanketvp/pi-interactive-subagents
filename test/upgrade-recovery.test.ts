import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,mkdirSync,symlinkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {runHostCustomizations} from '../scripts/host-customizations.mjs';

const script=fileURLToPath(new URL('../scripts/host-customizations.mjs',import.meta.url));

test('upgrade recovery restores missing code; drift requires exact approval and backs up prior code',()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-upgrade-test-'));
 const run=(...args:string[])=>spawnSync(process.execPath,[script,...args],{env:{...process.env,PI_CODING_AGENT_DIR:root},encoding:'utf8',timeout:10000});
 assert.equal(run('verify').status,1);
 assert.equal(run('restore-missing').status,0);
 assert.equal(run('verify').status,0);
 const target=join(root,'extensions','unbounded-scan-guard.ts');
 writeFileSync(target,'// newer local customization\n');
 assert.equal(run('restore-missing').status,1);
 assert.equal(readFileSync(target,'utf8'),'// newer local customization\n');
 const plan=JSON.parse(run('plan').stdout);
 assert.notEqual(run('restore','--approve-current','incorrect').status,0);
 const restored=run('restore','--approve-current',plan.currentFingerprint);
 assert.equal(restored.status,0,restored.stderr);
 const receipt=JSON.parse(restored.stdout);
 assert.equal(readFileSync(join(receipt.backup,'extensions','unbounded-scan-guard.ts'),'utf8'),'// newer local customization\n');
 assert.equal(run('verify').status,0);
 assert.equal(existsSync(join(root,'auth.json')),false);
 assert.equal(existsSync(join(root,'settings.json')),false);
});

test('capture includes digit filenames and restore recheck skips concurrent drift',()=>{
 const home=mkdtempSync(join(tmpdir(),'pi-upgrade-home-'));
 const snap=mkdtempSync(join(tmpdir(),'pi-upgrade-snap-'));
 const write=(rel:string,body:string)=>{const p=join(home,rel);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,body);};
 write('extensions/unbounded-scan-guard.ts','export const a=1;\n');
 write('extensions/pi-dispatch-mandate-guard.ts','export const b=1;\n');
 write('extensions/pi-orca-route.ts','export const c=1;\n');
 write('extensions/pi-orchestration/index.ts','export const d=1;\n');
 write('extensions/pi-orchestration/policy.ts','export const e=1;\n');
 write('extensions/anthropic-pool/pool2.ts','export const digit=1;\n');
 const env={...process.env,PI_CODING_AGENT_DIR:home,PI_HOST_SNAPSHOT_DIR:snap};
 const run=(extraEnv:Record<string,string>={},...args:string[])=>spawnSync(process.execPath,[script,...args],{env:{...env,...extraEnv},encoding:'utf8',timeout:10000});
 const captured=run({},'capture');
 assert.equal(captured.status,0,captured.stderr+captured.stdout);
 const manifest=JSON.parse(readFileSync(join(snap,'manifest.json'),'utf8'));
 assert.ok(manifest.files.some((f:any)=>f.path==='extensions/anthropic-pool/pool2.ts'),JSON.stringify(manifest.files));
 assert.equal(run({},'verify').status,0);
 writeFileSync(join(home,'extensions','unbounded-scan-guard.ts'),'// local drift\\n');
 const plan=JSON.parse(run({},'plan').stdout);

 // Simulate a concurrent writer touching an allowlisted file between
 // fingerprinting and the restore loop's recheck, via the explicit
 // IN-PROCESS test-only `beforeRestoreLoop` hook (not an env-supplied
 // arbitrary write path -- see host-customizations.mjs for why the old
 // PI_HOST_TEST_DRIFT_PATH production hook was removed).
 const drifted=runHostCustomizations('restore',['--approve-current',plan.currentFingerprint],env,{
  beforeRestoreLoop:({home:h,homeCanonical,containedTarget,writeFileSync:write2})=>{
   const target=containedTarget(homeCanonical,h,'extensions/pi-orca-route.ts','test-drift');
   write2(target,'// concurrent drift\n');
  },
 });
 assert.equal(drifted.exitError,true);
 const orca=drifted.results.find((r:any)=>r.path==='extensions/pi-orca-route.ts');
 assert.equal(orca.status,'changed-preserved');
 assert.equal(readFileSync(join(home,'extensions','pi-orca-route.ts'),'utf8'),'// concurrent drift\n');
});

test('restore/capture reject path traversal and symlinked ancestors escaping the root',()=>{
 const home=mkdtempSync(join(tmpdir(),'pi-upgrade-home2-'));
 const snap=mkdtempSync(join(tmpdir(),'pi-upgrade-snap2-'));
 const outside=mkdtempSync(join(tmpdir(),'pi-upgrade-outside-'));
 const write=(rel:string,body:string)=>{const p=join(home,rel);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,body);};
 write('extensions/unbounded-scan-guard.ts','export const a=1;\n');
 write('extensions/pi-dispatch-mandate-guard.ts','export const b=1;\n');
 write('extensions/pi-orca-route.ts','export const c=1;\n');
 write('extensions/pi-orchestration/index.ts','export const d=1;\n');
 write('extensions/pi-orchestration/policy.ts','export const e=1;\n');
 const env={...process.env,PI_CODING_AGENT_DIR:home,PI_HOST_SNAPSHOT_DIR:snap};
 assert.doesNotThrow(()=>runHostCustomizations('capture',[],env));

 // Replace `extensions` with a symlink pointing outside the home root, then
 // confirm verify/restore-missing refuse to follow it rather than reading
 // or writing outside `home`.
 const home2=mkdtempSync(join(tmpdir(),'pi-upgrade-home3-'));
 symlinkSync(outside,join(home2,'extensions'));
 const env2={...process.env,PI_CODING_AGENT_DIR:home2,PI_HOST_SNAPSHOT_DIR:snap};
 assert.throws(()=>runHostCustomizations('restore-missing',[],env2),/symlink ancestor|escapes root/);
 assert.equal(readdirSync(outside).length,0);
});

test('restore refuses when the backup directory ancestor is a symlink escaping the root', ()=>{
 // Close-to-scope gap: containment previously covered capture source,
 // snapshot source, and target paths, but NOT the backup directory itself
 // (`home/repair-backups/upgrade-<uuid>`) that `restore` writes prior
 // originals into. If `repair-backups` is a pre-existing symlink pointing
 // outside `home`, backups (and their manifest.json) must not be written
 // into that outside location.
 const home=mkdtempSync(join(tmpdir(),'pi-upgrade-home4-'));
 const snap=mkdtempSync(join(tmpdir(),'pi-upgrade-snap4-'));
 const outsideBackup=mkdtempSync(join(tmpdir(),'pi-upgrade-outside-backup-'));
 const write=(rel:string,body:string)=>{const p=join(home,rel);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,body);};
 write('extensions/unbounded-scan-guard.ts','export const a=1;\n');
 write('extensions/pi-dispatch-mandate-guard.ts','export const b=1;\n');
 write('extensions/pi-orca-route.ts','export const c=1;\n');
 write('extensions/pi-orchestration/index.ts','export const d=1;\n');
 write('extensions/pi-orchestration/policy.ts','export const e=1;\n');
 const env={...process.env,PI_CODING_AGENT_DIR:home,PI_HOST_SNAPSHOT_DIR:snap};
 assert.doesNotThrow(()=>runHostCustomizations('capture',[],env));

 // Make the local copy drift so `restore` has something to back up, then
 // point `repair-backups` at an outside directory before restoring.
 writeFileSync(join(home,'extensions','unbounded-scan-guard.ts'),'// local drift before symlinked backup dir\n');
 symlinkSync(outsideBackup,join(home,'repair-backups'));
 const plan=JSON.parse(spawnSync(process.execPath,[script,'plan'],{env,encoding:'utf8',timeout:10000}).stdout);
 assert.throws(
  ()=>runHostCustomizations('restore',['--approve-current',plan.currentFingerprint],env),
  /backup: path escapes root|symlink ancestor|escapes root/,
 );
 assert.equal(readdirSync(outsideBackup).length,0,'no backup content may land outside the contained root');
});

// P1-2 regression (run 16): capture must never write through a symlink beneath
// the snapshot root -- neither a symlinked files/ subtree nor a symlinked manifest.
test('capture refuses symlinked snapshot destinations (files subtree and manifest) and writes nothing outside the snapshot root',()=>{
 const home=mkdtempSync(join(tmpdir(),'pi-capture-home-'));
 const outside=mkdtempSync(join(tmpdir(),'pi-capture-outside-'));
 const write=(rel:string,body:string)=>{const p=join(home,rel);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,body);};
 for(const f of ['unbounded-scan-guard','pi-dispatch-mandate-guard','pi-orca-route']) write(`extensions/${f}.ts`,'export const x=1;\n');
 write('extensions/pi-orchestration/index.ts','export const d=1;\n');
 write('extensions/pi-orchestration/policy.ts','export const e=1;\n');

 // Case 1: snapshot/files/extensions is a symlink pointing outside the snapshot.
 const snapA=mkdtempSync(join(tmpdir(),'pi-capture-snapA-'));
 mkdirSync(join(snapA,'files'),{recursive:true});
 symlinkSync(outside,join(snapA,'files','extensions'));
 assert.throws(()=>runHostCustomizations('capture',[],{PI_CODING_AGENT_DIR:home,PI_HOST_SNAPSHOT_DIR:snapA}),/capture destination.*escapes root via symlink ancestor/);
 assert.deepEqual(readdirSync(outside),[],'nothing may be written through the symlinked files subtree');
 assert.equal(existsSync(join(snapA,'manifest.json')),false,'manifest must not be written when a file destination is refused');

 // Case 2: snapshot/manifest.json is itself a symlink to a file outside the snapshot.
 const snapB=mkdtempSync(join(tmpdir(),'pi-capture-snapB-'));
 const victim=join(outside,'victim-manifest.json');
 writeFileSync(victim,'ORIGINAL');
 symlinkSync(victim,join(snapB,'manifest.json'));
 assert.throws(()=>runHostCustomizations('capture',[],{PI_CODING_AGENT_DIR:home,PI_HOST_SNAPSHOT_DIR:snapB}),/capture manifest.*escapes root/);
 assert.equal(readFileSync(victim,'utf8'),'ORIGINAL','the symlink target outside the snapshot root must be untouched');

 // Case 3: a symlink INSIDE the root to a directory that is itself inside the root is still refused
 // as a non-regular destination when it sits exactly where a file should go.
 const snapC=mkdtempSync(join(tmpdir(),'pi-capture-snapC-'));
 mkdirSync(join(snapC,'files','extensions'),{recursive:true});
 mkdirSync(join(snapC,'decoy'),{recursive:true});
 symlinkSync(join(snapC,'decoy'),join(snapC,'files','extensions','unbounded-scan-guard.ts'));
 assert.throws(()=>runHostCustomizations('capture',[],{PI_CODING_AGENT_DIR:home,PI_HOST_SNAPSHOT_DIR:snapC}),/refusing non-regular destination/);

 // Sanity: a clean snapshot root still captures normally.
 const snapD=mkdtempSync(join(tmpdir(),'pi-capture-snapD-'));
 const ok=runHostCustomizations('capture',[],{PI_CODING_AGENT_DIR:home,PI_HOST_SNAPSHOT_DIR:snapD});
 assert.equal(ok.captured,5);
 assert.equal(existsSync(join(snapD,'manifest.json')),true);
});
