/**
 * Exact-bytes tree snapshots, plan/research manifests, pin/unpin, diffs,
 * submodule check, changeKind (plan v1.3 §4.1, §4.2, A3).
 *
 * Every git invocation goes through hardenedGit. Temp index is used only for
 * update-index / write-tree. Blobs are hashed with `hash-object -w --no-filters`
 * in argv chunks. Pin via `refs/pi-subagents/<session>/<n>`.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readlinkSync, existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hardenedGitBuffer, hardenedGitUtf8 } from "./hardened-git.ts";
import { ContentStore, contentSha256, type PlanResearchManifest } from "./store.ts";
import type { ChangeKind, Contributor, SnapshotRecord } from "./types.ts";

const HASH_OBJECT_CHUNK_BYTES = 16 * 1024;
const HASH_OBJECT_CHUNK_FILES = 64;
const BINARY_LINE_WEIGHT = 50;

export class UnsupportedTree extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedTree";
  }
}

export interface TreeEntry {
  mode: "100644" | "100755" | "120000";
  sha: string;
  path: string;
}

export interface CodeSnapshot {
  contentId: string;
  tree: string;
  baseCommit: string | null;
  ref: string | null;
  persisted: boolean;
  entries: TreeEntry[];
}

export interface DiffStat {
  path: string;
  oldPath?: string;
  added: number;
  removed: number;
  binary: boolean;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function gitOpts(repoDir: string, privateTmp: string, extraEnv?: Record<string, string>) {
  return { cwd: repoDir, privateTmp, extraEnv };
}

function splitNul(buf: Buffer): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      if (i > start) out.push(buf.subarray(start, i).toString("utf8"));
      start = i + 1;
    }
  }
  if (start < buf.length) out.push(buf.subarray(start).toString("utf8"));
  return out;
}

function sanitizeRefSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  return cleaned || "session";
}

function isExecutable(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

function listGitlinks(repoDir: string, privateTmp: string): string[] {
  let out: string;
  try {
    out = hardenedGitUtf8(["ls-files", "-z", "--stage"], gitOpts(repoDir, privateTmp));
  } catch {
    return [];
  }
  const links: string[] = [];
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    // mode SP sha SP stage TAB path
    if (rec.startsWith("160000 ")) {
      const tab = rec.indexOf("\t");
      links.push(tab >= 0 ? rec.slice(tab + 1) : rec);
    }
  }
  return links;
}

function listWorkingTreePaths(repoDir: string, privateTmp: string): string[] {
  const buf = hardenedGitBuffer(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], gitOpts(repoDir, privateTmp));
  return splitNul(buf).filter((p) => p.length > 0);
}

function chunkPaths(paths: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const p of paths) {
    const size = Buffer.byteLength(p) + 1;
    if (current.length >= HASH_OBJECT_CHUNK_FILES || (current.length > 0 && bytes + size > HASH_OBJECT_CHUNK_BYTES)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(p);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function hashBlobStdin(repoDir: string, privateTmp: string, bytes: Buffer): string {
  const out = hardenedGitUtf8(["hash-object", "-w", "--no-filters", "--stdin"], {
    ...gitOpts(repoDir, privateTmp),
    input: bytes,
  });
  return out.trim();
}

function currentHead(repoDir: string, privateTmp: string): string | null {
  try {
    const out = hardenedGitUtf8(["rev-parse", "--verify", "HEAD"], gitOpts(repoDir, privateTmp)).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

export function computeBindingId(
  contentId: string,
  baseCommit: string | null,
  contributors: readonly Contributor[],
  epoch: number,
): string {
  const payload = `${contentId}\0${baseCommit ?? "null"}\0${[...contributors].sort().join(",")}\0${epoch}`;
  return `bind:${sha256(payload)}`;
}

export function changeKind(prev: SnapshotRecord | null | undefined, next: SnapshotRecord): ChangeKind {
  if (!prev) return "content";
  if (prev.contentId !== next.contentId) return "content";
  if ((prev.baseCommit ?? "null") !== (next.baseCommit ?? "null")) return "base";
  const prevC = [...prev.contributors].sort().join(",");
  const nextC = [...next.contributors].sort().join(",");
  if (prevC !== nextC || prev.epoch !== next.epoch) return "provenance";
  return "none";
}

export function snapshotWorkingTree(
  repoDir: string,
  opts: { sessionId: string; n: number; privateTmp?: string },
): CodeSnapshot {
  const privateTmp = opts.privateTmp ?? join(tmpdir(), "pi-git-home");
  mkdirSync(privateTmp, { recursive: true, mode: 0o700 });

  const gitlinks = listGitlinks(repoDir, privateTmp);
  if (gitlinks.length > 0) {
    throw new UnsupportedTree(`gitlink/submodule: ${gitlinks.join(", ")}`);
  }

  const paths = listWorkingTreePaths(repoDir, privateTmp);
  const entries: TreeEntry[] = [];
  const regular: string[] = [];

  for (const rel of paths) {
    const abs = join(repoDir, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue; // deleted from working tree
    }
    if (st.isSymbolicLink()) {
      const target = readlinkSync(abs);
      const sha = hashBlobStdin(repoDir, privateTmp, Buffer.from(target, "utf8"));
      entries.push({ mode: "120000", sha, path: rel });
      continue;
    }
    if (st.isDirectory()) {
      if (existsSync(join(abs, ".git"))) {
        throw new UnsupportedTree(`nested git repository at ${rel}`);
      }
      continue;
    }
    if (!st.isFile()) continue;
    regular.push(rel);
  }

  for (const chunk of chunkPaths(regular)) {
    const out = hardenedGitUtf8(["hash-object", "-w", "--no-filters", "--", ...chunk], gitOpts(repoDir, privateTmp));
    const shas = out.trim().split("\n").filter(Boolean);
    if (shas.length !== chunk.length) {
      throw new Error(`hash-object returned ${shas.length} shas for ${chunk.length} paths`);
    }
    for (let i = 0; i < chunk.length; i++) {
      const st = lstatSync(join(repoDir, chunk[i]));
      const mode = isExecutable(st.mode) ? "100755" : "100644";
      entries.push({ mode, sha: shas[i], path: chunk[i] });
    }
  }

  const idxDir = join(privateTmp, `idx-${randomUUID()}`);
  mkdirSync(idxDir, { recursive: true, mode: 0o700 });
  const indexFile = join(idxDir, "index");
  const extraEnv = { GIT_INDEX_FILE: indexFile };
  try {
    hardenedGitUtf8(["read-tree", "--empty"], gitOpts(repoDir, privateTmp, extraEnv));
    if (entries.length > 0) {
      const info = Buffer.concat(
        entries.flatMap((e) => [Buffer.from(`${e.mode} ${e.sha}\t${e.path}`, "utf8"), Buffer.from([0])]),
      );
      hardenedGitBuffer(["update-index", "-z", "--index-info"], {
        ...gitOpts(repoDir, privateTmp, extraEnv),
        input: info,
      });
    }
    const tree = hardenedGitUtf8(["write-tree"], gitOpts(repoDir, privateTmp, extraEnv)).trim();
    const ref = `refs/pi-subagents/${sanitizeRefSegment(opts.sessionId)}/${opts.n}`;
    let persisted = false;
    try {
      hardenedGitUtf8(["update-ref", ref, tree], gitOpts(repoDir, privateTmp));
      persisted = true;
    } catch {
      persisted = false;
    }
    return {
      contentId: `tree:${tree}`,
      tree,
      baseCommit: currentHead(repoDir, privateTmp),
      ref: persisted ? ref : null,
      persisted,
      entries,
    };
  } finally {
    rmSync(idxDir, { recursive: true, force: true });
  }
}

export function unpinSnapshot(repoDir: string, ref: string, privateTmp?: string): void {
  const tmp = privateTmp ?? join(tmpdir(), "pi-git-home");
  hardenedGitUtf8(["update-ref", "-d", ref], gitOpts(repoDir, tmp));
}

function parseNumstatZ(buf: Buffer): DiffStat[] {
  const stats: DiffStat[] = [];
  let i = 0;
  while (i < buf.length) {
    const tab1 = buf.indexOf(0x09, i);
    if (tab1 < 0) break;
    const tab2 = buf.indexOf(0x09, tab1 + 1);
    if (tab2 < 0) break;
    const addedRaw = buf.subarray(i, tab1).toString("utf8");
    const removedRaw = buf.subarray(tab1 + 1, tab2).toString("utf8");
    let pos = tab2 + 1;
    let path: string;
    let oldPath: string | undefined;
    if (pos < buf.length && buf[pos] === 0) {
      // rename: add\tdel\t\0oldpath\0newpath\0
      pos += 1;
      const oldEnd = buf.indexOf(0, pos);
      if (oldEnd < 0) break;
      oldPath = buf.subarray(pos, oldEnd).toString("utf8");
      pos = oldEnd + 1;
      const newEnd = buf.indexOf(0, pos);
      if (newEnd < 0) break;
      path = buf.subarray(pos, newEnd).toString("utf8");
      i = newEnd + 1;
    } else {
      const end = buf.indexOf(0, pos);
      if (end < 0) {
        path = buf.subarray(pos).toString("utf8");
        i = buf.length;
      } else {
        path = buf.subarray(pos, end).toString("utf8");
        i = end + 1;
      }
    }
    const binary = addedRaw === "-" && removedRaw === "-";
    const added = binary ? BINARY_LINE_WEIGHT : Number.parseInt(addedRaw, 10) || 0;
    const removed = binary ? 0 : Number.parseInt(removedRaw, 10) || 0;
    stats.push({ path, oldPath, added, removed, binary });
    if (oldPath && oldPath !== path) {
      stats.push({ path: oldPath, added, removed, binary });
    }
  }
  return stats;
}

export function diffTrees(repoDir: string, prevTree: string, nextTree: string, privateTmp?: string): DiffStat[] {
  const tmp = privateTmp ?? join(tmpdir(), "pi-git-home");
  let out: Buffer;
  try {
    out = hardenedGitBuffer(["diff-tree", "-r", "--numstat", "-z", prevTree, nextTree], gitOpts(repoDir, tmp));
  } catch (error: any) {
    const stdout = error?.stdout;
    out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(typeof stdout === "string" ? stdout : "");
  }
  return parseNumstatZ(out);
}

export function addedLines(stats: DiffStat[]): number {
  return stats.reduce((n, s) => n + s.added + s.removed, 0);
}

export function packetDiff(repoDir: string, prevTree: string, nextTree: string, privateTmp?: string): string {
  const tmp = privateTmp ?? join(tmpdir(), "pi-git-home");
  try {
    return hardenedGitUtf8(["diff", "--find-renames=0", prevTree, nextTree], gitOpts(repoDir, tmp));
  } catch (error: any) {
    const stdout = error?.stdout;
    if (typeof stdout === "string") return stdout;
    if (Buffer.isBuffer(stdout)) return stdout.toString("utf8");
    throw error;
  }
}

export function hasSubmodules(repoDir: string, privateTmp?: string): boolean {
  const tmp = privateTmp ?? join(tmpdir(), "pi-git-home");
  return listGitlinks(repoDir, tmp).length > 0;
}

export function snapshotPlanResearch(input: {
  kind: "plan" | "research";
  requestId: string;
  assignedPath: string;
  extraPaths?: string[];
  sourceRoots: string[];
  store: ContentStore;
}): { contentId: string; manifest: PlanResearchManifest } {
  const files: PlanResearchManifest["files"] = [];
  const paths = [input.assignedPath, ...(input.extraPaths ?? [])];
  for (const path of paths) {
    const raw = readFileSync(path);
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    input.store.put(buf);
    files.push({ path, sha256: contentSha256(buf), size: buf.length });
  }
  const manifest: PlanResearchManifest = {
    kind: input.kind,
    requestId: input.requestId,
    assignedPath: input.assignedPath,
    files,
    sourceRoots: input.sourceRoots,
  };
  const contentId = input.store.putManifest(manifest);
  return { contentId, manifest };
}

export function makeSnapshotRecord(
  snap: Pick<CodeSnapshot, "contentId" | "baseCommit" | "persisted">,
  contributors: Contributor[],
  epoch: number,
): SnapshotRecord {
  return {
    contentId: snap.contentId,
    bindingId: computeBindingId(snap.contentId, snap.baseCommit, contributors, epoch),
    baseCommit: snap.baseCommit,
    contributors: [...contributors].sort(),
    epoch,
    persisted: snap.persisted,
  };
}
