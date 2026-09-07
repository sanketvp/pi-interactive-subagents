#!/usr/bin/env node
// Explicit code-only preservation. Never discovers/copies credentials or sessions.
// Restoration is cooperative/best-effort under concurrent writers, NOT transactional.
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,lstatSync,realpathSync,renameSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';

const sha=b=>createHash('sha256').update(b).digest('hex');
const allowed=p=>/^extensions\/(?:anthropic-pool\/[a-z0-9_-]+\.ts|pi-orchestration\/(?:index|policy)\.ts|(?:unbounded-scan-guard|pi-dispatch-mandate-guard|pi-orca-route)\.ts)$/.test(p);

/**
 * Find the deepest ancestor of `path` that currently exists on disk (the
 * path itself, or the first parent that does).
 */
function deepestExisting(path) {
 let cur=path;
 for(;;) {
  if(existsSync(cur)) return cur;
  const parent=dirname(cur);
  if(parent===cur) return cur;
  cur=parent;
 }
}

/**
 * Resolve `root` to its canonical (symlink-free) real path. `root` itself is
 * allowed to be a symlink (e.g. macOS's /tmp -> /private/tmp) -- we are not
 * rejecting platform roots, only requiring everything BENEATH the canonical
 * root to stay beneath it.
 */
function canonicalRoot(root) {
 return realpathSync(deepestExisting(root));
}

/**
 * Reject `relPath` containing `..` traversal segments, then verify the
 * resolved target -- including any symlink ancestor directory components
 * that already exist beneath `root` -- stays strictly within the canonical
 * root. Returns the safe absolute target path.
 */
function containedTarget(rootCanonical, root, relPath, label) {
 if(relPath.split('/').some(seg=>seg==='' || seg==='..')) {
  throw new Error(`${label}: rejecting traversal in path "${relPath}"`);
 }
 const target=join(root,relPath);
 const anchor=deepestExisting(target);
 const anchorCanonical=realpathSync(anchor);
 if(anchorCanonical!==rootCanonical && !anchorCanonical.startsWith(rootCanonical+'/')) {
  throw new Error(`${label}: path escapes root via symlink ancestor: ${relPath}`);
 }
 const remainder=target.slice(anchor.length);
 const resolved=resolve(anchorCanonical+remainder);
 if(resolved!==rootCanonical && !resolved.startsWith(rootCanonical+'/')) {
  throw new Error(`${label}: path escapes root: ${relPath}`);
 }
 return resolved;
}

/**
 * Run the host-customizations tool. `hooks.beforeRestoreLoop` is an
 * explicit, IN-PROCESS, test-only injection point used to deterministically
 * simulate a concurrent drift write between fingerprinting and the restore
 * loop's recheck. It is NEVER wired to any environment variable or CLI
 * argument in production usage (see `main()` below), so there is no
 * production-reachable arbitrary-write surface -- unlike the removed
 * `PI_HOST_TEST_DRIFT_PATH` hook, which honored an unvalidated env-supplied
 * path before allowlist/containment checks.
 */
export function runHostCustomizations(mode, args, env, hooks={}) {
 const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 const home=resolve(env.PI_CODING_AGENT_DIR || join(homedir(),'.pi','agent'));
 const snapshot=resolve(env.PI_HOST_SNAPSHOT_DIR || join(repo,'host-integration'));
 const manifestPath=join(snapshot,'manifest.json');

 if(mode==='capture') {
  const homeCanonical=canonicalRoot(home);
  // Snapshot outputs are contained exactly like restore targets: the snapshot
  // root is created and canonicalized first, every file destination and the
  // manifest are resolved through containedTarget() (rejecting symlinked
  // ancestors beneath the root), and non-regular existing destinations are
  // refused so capture can never write through a symlink out of the snapshot.
  mkdirSync(snapshot,{recursive:true});
  const snapshotCanonical=canonicalRoot(snapshot);
  const snapshotDest=(rel,label)=>{
   const dest=containedTarget(snapshotCanonical,snapshot,rel,label);
   if(existsSync(dest) && !lstatSync(dest).isFile()) throw new Error(label+': refusing non-regular destination: '+rel);
   return dest;
  };
  const poolDir=join(home,'extensions','anthropic-pool');
  const poolFiles=existsSync(poolDir)?readdirSync(poolDir).filter(p=>p.endsWith('.ts')).map(p=>'extensions/anthropic-pool/'+p):[];
  const files=['extensions/unbounded-scan-guard.ts','extensions/pi-dispatch-mandate-guard.ts','extensions/pi-orca-route.ts','extensions/pi-orchestration/index.ts','extensions/pi-orchestration/policy.ts',...poolFiles];
  const records=[];
  for(const path of files) {
   if(!allowed(path)) throw new Error('Not an allowed source file: '+path);
   const source=containedTarget(homeCanonical,home,path,'capture source');
   if(!lstatSync(source).isFile()) throw new Error('Not an allowed source file: '+path);
   const bytes=readFileSync(source);
   const target=snapshotDest('files/'+path,'capture destination');
   mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes);
   records.push({path,sha256:sha(bytes)});
  }
  const manifestDest=snapshotDest('manifest.json','capture manifest');
  writeFileSync(manifestDest,JSON.stringify({version:1,scope:'code only; excludes auth, account data, settings, sessions, and user-owned Orca extensions',files:records},null,2)+'\n');
  return {captured:records.length,manifest:manifestDest};
 }

 if(!['verify','plan','restore','restore-missing'].includes(mode)) {
  throw new Error('Usage: host-customizations.mjs capture|verify|plan|restore-missing|restore --approve-current <fingerprint>');
 }

 const homeCanonical=canonicalRoot(home);
 const snapshotCanonical=canonicalRoot(snapshot);
 const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
 if(manifest.version!==1 || !Array.isArray(manifest.files)) throw new Error('Invalid manifest');
 const staged=[];
 for(const record of manifest.files) {
  if(!allowed(record.path)) throw new Error('Unsafe manifest path');
  const snapshotSource=containedTarget(snapshotCanonical,snapshot,'files/'+record.path,'snapshot source');
  const snapshotBytes=readFileSync(snapshotSource);
  if(sha(snapshotBytes)!==record.sha256) throw new Error('Snapshot integrity failure: '+record.path);
  staged.push({path:record.path,sha256:record.sha256,bytes:snapshotBytes});
 }
 const current=staged.map(record=>{
  const target=containedTarget(homeCanonical,home,record.path,'target');
  if(existsSync(target) && !lstatSync(target).isFile()) throw new Error('Refusing non-regular target: '+record.path);
  return {path:record.path,sha256:existsSync(target)?sha(readFileSync(target)):null};
 });
 const fingerprint=sha(JSON.stringify(current));
 const approved=Object.fromEntries(current.map(record=>[record.path,record.sha256]));
 if(mode==='plan') {return {currentFingerprint:fingerprint,current,honesty:'cooperative/best-effort; not transactional'};}

 let backup;
 const results=[];
 if(mode==='restore') {
  if(args[0]!=='--approve-current' || args[1]!==fingerprint) throw new Error('Review plan first, then pass --approve-current <currentFingerprint>; drift refuses restoration');
  // Explicit, in-process, test-only seam: never driven by env/CLI input in
  // production. Lets tests deterministically simulate another writer
  // touching an allowlisted file between fingerprinting and the recheck
  // below, WITHOUT any production-reachable write primitive.
  if(typeof hooks.beforeRestoreLoop==='function') {
   hooks.beforeRestoreLoop({home,homeCanonical,containedTarget,writeFileSync});
  }
  // The backup directory itself is an ancestor path that must be contained,
  // not just the final restored files: if `home/repair-backups` (or any
  // ancestor beneath `home`) is a pre-existing symlink to somewhere else,
  // backups (and their manifest) must not be written outside `home`.
  backup=containedTarget(homeCanonical,home,join('repair-backups','upgrade-'+randomUUID()),'backup');
  mkdirSync(backup,{recursive:true,mode:0o700});
  writeFileSync(join(backup,'manifest.json'),JSON.stringify({current,snapshot:manifest,honesty:'cooperative/best-effort; not transactional'},null,2),{flag:'wx',mode:0o600});
 }
 for(const record of staged) {
  const target=containedTarget(homeCanonical,home,record.path,'target');
  if(mode==='restore') {
   const liveHash=existsSync(target)?sha(readFileSync(target)):null;
   if(liveHash!==approved[record.path]) {
    results.push({path:record.path,status:'changed-preserved'});
    continue;
   }
   if(liveHash) {
    const replaced=readFileSync(target);
    const backupTarget=join(backup,record.path);
    mkdirSync(dirname(backupTarget),{recursive:true});
    writeFileSync(backupTarget,replaced,{flag:'wx',mode:0o600});
   }
   mkdirSync(dirname(target),{recursive:true});
   const temp=target+'.restore-'+randomUUID();
   writeFileSync(temp,record.bytes,{flag:'wx',mode:0o600});
   renameSync(temp,target);
   results.push({path:record.path,status:'restored'});
  } else if(!existsSync(target)) {
   if(mode==='restore-missing') {mkdirSync(dirname(target),{recursive:true});writeFileSync(target,record.bytes,{flag:'wx',mode:0o600});results.push({path:record.path,status:'restored'});}
   else results.push({path:record.path,status:'missing'});
  } else if(!lstatSync(target).isFile() || sha(readFileSync(target))!==record.sha256) {
   results.push({path:record.path,status:'changed-preserved'});
  } else results.push({path:record.path,status:'verified'});
 }
 const exitError=results.some(r=>['missing','changed-preserved'].includes(r.status));
 return {backup,results,honesty:'cooperative/best-effort; not transactional',exitError};
}

function main() {
 const mode=process.argv[2] || 'verify';
 const args=process.argv.slice(3);
 try {
  const result=runHostCustomizations(mode,args,process.env);
  console.log(JSON.stringify(result,null,2));
  if(result && result.exitError) process.exitCode=1;
 } catch(error) {
  console.error(error && error.message ? error.message : String(error));
  process.exitCode=1;
 }
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
 main();
}
