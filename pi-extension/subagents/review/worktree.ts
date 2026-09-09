/**
 * Blob materialisation — no checkout, no `.git` (plan v1.3 §8.3).
 *
 * `verifyBase = realpath($TMPDIR)/pi-rv-<uid>/<sessionShort>/`
 * `dir       = <verifyBase>/<attemptId>/tree`
 *
 * Enumeration: `git ls-tree -r -z <tree>`
 * Bytes:       `git cat-file --batch` (raw object bytes; no filters/attributes/encoding/hooks)
 * gitlinks → UnsupportedTree.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { hardenedGitBuffer, hardenedGitUtf8 } from "./hardened-git.ts";
import { UnsupportedTree } from "./artifact.ts";

export interface ManifestEntry {
  path: string;
  kind: "file" | "symlink";
  mode: "100644" | "100755" | "120000";
  sha256: string;
  size: number;
}

export interface TreeManifest {
  contentId: string;
  entries: ManifestEntry[];
}

export interface ManifestIntegrity {
  ok: boolean;
  modified: string[];
  deleted: string[];
  newFiles: string[];
}

export function sessionShortOf(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9]/g, "");
  return (cleaned.slice(0, 8) || "session").toLowerCase();
}

/**
 * Canonical verification base: `realpath($TMPDIR)/pi-rv-<uid>/<sessionShort>/`
 * (dir 0700, outside ~/.pi and the session directory).
 */
export function resolveVerifyBase(sessionShort: string, tmp = process.env.TMPDIR || tmpdir()): string {
  const realTmp = realpathSync(tmp);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(realTmp, `pi-rv-${uid}`, sessionShort);
}

export function materializeTreeDir(verifyBase: string, attemptId: string): string {
  return join(verifyBase, attemptId, "tree");
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function splitNul(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      if (i > start) out.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) out.push(buf.subarray(start));
  return out;
}

interface LsTreeEntry {
  mode: string;
  type: string;
  sha: string;
  path: string;
}

function parseLsTree(buf: Buffer): LsTreeEntry[] {
  const entries: LsTreeEntry[] = [];
  for (const rec of splitNul(buf)) {
    if (rec.length === 0) continue;
    const tab = rec.indexOf(0x09);
    if (tab < 0) continue;
    const meta = rec.subarray(0, tab).toString("utf8");
    const path = rec.subarray(tab + 1).toString("utf8");
    const parts = meta.split(" ");
    if (parts.length < 3) continue;
    entries.push({ mode: parts[0], type: parts[1], sha: parts[2], path });
  }
  return entries;
}

function parseCatFileBatch(buf: Buffer, wanted: string[]): Map<string, Buffer> {
  const map = new Map<string, Buffer>();
  let offset = 0;
  let remaining = new Set(wanted);
  while (offset < buf.length && remaining.size > 0) {
    const nl = buf.indexOf(0x0a, offset);
    if (nl < 0) break;
    const header = buf.subarray(offset, nl).toString("utf8");
    offset = nl + 1;
    if (header.endsWith(" missing")) {
      const sha = header.slice(0, header.indexOf(" "));
      remaining.delete(sha);
      continue;
    }
    const parts = header.split(" ");
    if (parts.length < 3) continue;
    const sha = parts[0];
    const size = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(size) || size < 0) throw new Error(`bad cat-file header: ${header}`);
    const content = buf.subarray(offset, offset + size);
    offset += size;
    if (offset < buf.length && buf[offset] === 0x0a) offset += 1;
    map.set(sha, Buffer.from(content));
    remaining.delete(sha);
  }
  return map;
}

function assertSafeRelPath(rel: string): void {
  if (!rel || rel.startsWith("/") || rel.split(/[/\\]/).includes("..")) {
    throw new UnsupportedTree(`unsafe path in tree: ${JSON.stringify(rel)}`);
  }
}

/** Reject trees where one entry is a prefix of another (D/F + symlink-escape). */
function assertNoPathConflicts(listed: LsTreeEntry[]): void {
  const paths = new Set(listed.map((e) => e.path));
  for (const p of paths) {
    const parts = p.split("/");
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      if (paths.has(prefix)) {
        throw new UnsupportedTree(`directory/file conflict at ${JSON.stringify(prefix)}`);
      }
    }
  }
}

function mkdirNoFollow(root: string, relDir: string): void {
  if (!relDir || relDir === ".") return;
  const parts = relDir.split(/[/\\]/).filter(Boolean);
  let cur = root;
  for (const part of parts) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      mkdirSync(cur, { mode: 0o700 });
      continue;
    }
    if (st.isSymbolicLink()) throw new UnsupportedTree(`symlink in path: ${relDir}`);
    if (!st.isDirectory()) throw new UnsupportedTree(`directory/file conflict at ${relDir}`);
  }
}

function assertNoSymlinkComponent(root: string, rel: string): void {
  const parts = rel.split(/[/\\]/).filter(Boolean);
  let cur = root;
  for (const part of parts) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) throw new UnsupportedTree(`symlink in path: ${rel}`);
  }
}

/** TODO(PR-3): replace with protected.safeOpenForWrite (openat walk, O_NOFOLLOW). This is an interim guard. */
function writeFileNoFollow(abs: string, bytes: Buffer, mode: number): void {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    st = null;
  }
  if (st?.isSymbolicLink()) throw new UnsupportedTree(`symlink in path: ${abs}`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  const nofollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(abs, flags | nofollow, mode);
  } catch (error: any) {
    if (error?.code === "EEXIST") throw new UnsupportedTree(`case-collision or existing path: ${abs}`);
    throw error;
  }
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

function walkFiles(dir: string, acc: Array<{ rel: string; abs: string }> = [], prefix = ""): Array<{ rel: string; abs: string }> {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of names) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(abs, acc, rel);
    else acc.push({ rel, abs });
  }
  return acc;
}

export function manifestOf(dir: string, contentId = ""): TreeManifest {
  const entries: ManifestEntry[] = [];
  for (const { rel, abs } of walkFiles(dir)) {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(abs);
      const buf = Buffer.from(target, "utf8");
      entries.push({ path: rel, kind: "symlink", mode: "120000", sha256: sha256(buf), size: buf.length });
    } else if (st.isFile()) {
      const buf = readFileSync(abs);
      const mode = (st.mode & 0o111) !== 0 ? "100755" : "100644";
      entries.push({ path: rel, kind: "file", mode, sha256: sha256(buf), size: buf.length });
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { contentId, entries };
}

export function manifestIntegrity(dir: string, manifest: TreeManifest): ManifestIntegrity {
  const current = manifestOf(dir, manifest.contentId);
  const currentByPath = new Map(current.entries.map((e) => [e.path, e]));
  const expectedByPath = new Map(manifest.entries.map((e) => [e.path, e]));
  const modified: string[] = [];
  const deleted: string[] = [];
  const newFiles: string[] = [];
  for (const [path, expected] of expectedByPath) {
    const actual = currentByPath.get(path);
    if (!actual) {
      deleted.push(path);
      continue;
    }
    if (actual.kind !== expected.kind || actual.mode !== expected.mode || actual.sha256 !== expected.sha256) {
      modified.push(path);
    }
  }
  for (const path of currentByPath.keys()) {
    if (!expectedByPath.has(path)) newFiles.push(path);
  }
  return { ok: modified.length === 0 && deleted.length === 0, modified, deleted, newFiles };
}

function assertNotSymlinkAncestors(abs: string, hops = 3): void {
  let cur = abs;
  for (let i = 0; i < hops; i++) {
    try {
      if (lstatSync(cur).isSymbolicLink()) {
        throw new UnsupportedTree(`refusing to remove through symlink: ${cur}`);
      }
    } catch (error) {
      if (error instanceof UnsupportedTree) throw error;
      break;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}

export function remove(dir: string): void {
  assertNotSymlinkAncestors(dir);
  rmSync(dir, { recursive: true, force: true });
}

export function materialize(
  contentId: string,
  attemptId: string,
  opts: { repoDir: string; sessionShort: string; tmpdir?: string; privateTmp?: string },
): { dir: string; manifest: TreeManifest } {
  if (!contentId.startsWith("tree:") || contentId.length < 6) {
    throw new UnsupportedTree(`not a tree content id: ${contentId}`);
  }
  const tree = contentId.slice(5);
  const privateTmp = opts.privateTmp ?? join(tmpdir(), "pi-git-home");
  mkdirSync(privateTmp, { recursive: true, mode: 0o700 });

  const ls = hardenedGitBuffer(["ls-tree", "-r", "-z", tree], { cwd: opts.repoDir, privateTmp });
  const listed = parseLsTree(ls);
  if (listed.some((e) => e.mode === "160000" || e.type === "commit")) {
    throw new UnsupportedTree("gitlink in tree");
  }

  const verifyBase = resolveVerifyBase(opts.sessionShort, opts.tmpdir ?? process.env.TMPDIR ?? tmpdir());
  mkdirSync(verifyBase, { recursive: true, mode: 0o700 });
  const dir = materializeTreeDir(verifyBase, attemptId);
  remove(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const shas = [...new Set(listed.filter((e) => e.type === "blob").map((e) => e.sha))];
  const blobs = new Map<string, Buffer>();
  if (shas.length > 0) {
    const input = Buffer.from(shas.join("\n") + "\n");
    const batch = hardenedGitBuffer(["cat-file", "--batch"], {
      cwd: opts.repoDir,
      privateTmp,
      input,
    });
    const parsed = parseCatFileBatch(batch, shas);
    for (const sha of shas) {
      const bytes = parsed.get(sha);
      if (!bytes) throw new UnsupportedTree(`missing blob ${sha}`);
      blobs.set(sha, bytes);
    }
  }

  assertNoPathConflicts(listed);

  const entries: ManifestEntry[] = [];
  for (const item of listed) {
    assertSafeRelPath(item.path);
    const abs = join(dir, item.path);
    if (abs !== dir && !resolve(abs).startsWith(resolve(dir) + sep) && resolve(abs) !== resolve(dir)) {
      throw new UnsupportedTree(`path escapes tree: ${item.path}`);
    }
    mkdirNoFollow(dir, dirname(item.path));
    assertNoSymlinkComponent(dir, item.path);
    const bytes = blobs.get(item.sha) ?? Buffer.alloc(0);
    if (item.mode === "120000") {
      try {
        symlinkSync(bytes.toString("utf8"), abs);
      } catch (error: any) {
        if (error?.code === "EEXIST") throw new UnsupportedTree(`case-collision or existing path: ${abs}`);
        throw error;
      }
      entries.push({
        path: item.path,
        kind: "symlink",
        mode: "120000",
        sha256: sha256(bytes),
        size: bytes.length,
      });
    } else {
      const mode = item.mode === "100755" ? 0o755 : 0o644;
      writeFileNoFollow(abs, bytes, mode);
      if (item.mode === "100755") chmodSync(abs, 0o755);
      entries.push({
        path: item.path,
        kind: "file",
        mode: item.mode === "100755" ? "100755" : "100644",
        sha256: sha256(bytes),
        size: bytes.length,
      });
    }
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest: TreeManifest = { contentId, entries };
  const check = manifestOf(dir, contentId);
  if (check.entries.length !== manifest.entries.length) {
    throw new UnsupportedTree("materialisation-mismatch");
  }
  for (let i = 0; i < manifest.entries.length; i++) {
    const a = manifest.entries[i];
    const b = check.entries[i];
    if (a.path !== b.path || a.kind !== b.kind || a.sha256 !== b.sha256) {
      throw new UnsupportedTree("materialisation-mismatch");
    }
  }
  return { dir, manifest };
}
