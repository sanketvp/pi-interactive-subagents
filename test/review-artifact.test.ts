import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  snapshotWorkingTree,
  changeKind,
  computeBindingId,
  diffTrees,
  addedLines,
  packetDiff,
  hasSubmodules,
  UnsupportedTree,
  makeSnapshotRecord,
  snapshotPlanResearch,
} from "../pi-extension/subagents/review/artifact.ts";
import { ContentStore } from "../pi-extension/subagents/review/store.ts";
import { resetLifecycleAdapter } from "../pi-extension/subagents/adapter.ts";

function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "pipe" });
}

function commitAll(dir: string, message = "c") {
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", message, "--allow-empty"], { cwd: dir, stdio: "pipe" });
}

describe("artifact", () => {
  it("changeKind is none/content/base/provenance", () => {
    const a = makeSnapshotRecord({ contentId: "tree:aaa", baseCommit: "b1", persisted: true }, ["anthropic"], 0);
    assert.equal(changeKind(a, a), "none");
    const content = makeSnapshotRecord({ contentId: "tree:bbb", baseCommit: "b1", persisted: true }, ["anthropic"], 0);
    assert.equal(changeKind(a, content), "content");
    const base = makeSnapshotRecord({ contentId: "tree:aaa", baseCommit: "b2", persisted: true }, ["anthropic"], 0);
    assert.equal(changeKind(a, base), "base");
    const prov = makeSnapshotRecord({ contentId: "tree:aaa", baseCommit: "b1", persisted: true }, ["anthropic", "xai"], 0);
    assert.equal(changeKind(a, prov), "provenance");
    const epoch = makeSnapshotRecord({ contentId: "tree:aaa", baseCommit: "b1", persisted: true }, ["anthropic"], 1);
    assert.equal(changeKind(a, epoch), "provenance");
  });

  it("binding id covers content, base, contributors, epoch", () => {
    const x = computeBindingId("tree:a", "b", ["xai", "anthropic"], 0);
    const y = computeBindingId("tree:a", "b", ["anthropic", "xai"], 0);
    assert.equal(x, y);
    assert.match(x, /^bind:[0-9a-f]{64}$/);
    assert.notEqual(x, computeBindingId("tree:a", null, ["anthropic", "xai"], 0));
  });

  it("snapshots working tree including deletion, symlink, and filename-with-newline; pins ref", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-art-"));
    const repo = join(root, "repo");
    initRepo(repo);
    writeFileSync(join(repo, "keep.txt"), "keep\n");
    writeFileSync(join(repo, "gone.txt"), "gone\n");
    symlinkSync("keep.txt", join(repo, "link"));
    const nl = "foo\nbar.txt";
    writeFileSync(join(repo, nl), "newline-name\n");
    commitAll(repo, "base");
    const privateTmp = join(root, "tmp");
    mkdirSync(privateTmp);
    const first = snapshotWorkingTree(repo, { sessionId: "sess1", n: 1, privateTmp });
    assert.match(first.contentId, /^tree:[0-9a-f]{40}$/);
    assert.equal(first.persisted, true);
    assert.ok(first.ref?.startsWith("refs/pi-subagents/"));
    assert.ok(first.entries.some((e) => e.path === "link" && e.mode === "120000"));
    assert.ok(first.entries.some((e) => e.path === nl));

    unlinkSync(join(repo, "gone.txt"));
    const second = snapshotWorkingTree(repo, { sessionId: "sess1", n: 2, privateTmp });
    assert.notEqual(first.tree, second.tree);
    const stats = diffTrees(repo, first.tree, second.tree, privateTmp);
    assert.ok(stats.some((s) => s.path === "gone.txt"));
    assert.ok(addedLines(stats) >= 1);
    const diff = packetDiff(repo, first.tree, second.tree, privateTmp);
    assert.match(diff, /gone/);
  });

  it("diffTrees -z returns exact unquoted paths for newline and non-ASCII names", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-art-z-"));
    const repo = join(root, "repo");
    initRepo(repo);
    const nl = "foo\nbar.txt";
    const cafe = "caf\u00e9.ts";
    writeFileSync(join(repo, nl), "one\n");
    writeFileSync(join(repo, cafe), "uno\n");
    writeFileSync(join(repo, "plain.txt"), "p\n");
    commitAll(repo, "base");
    const privateTmp = join(root, "tmp");
    mkdirSync(privateTmp);
    const first = snapshotWorkingTree(repo, { sessionId: "z", n: 1, privateTmp });
    writeFileSync(join(repo, nl), "two\n");
    writeFileSync(join(repo, cafe), "dos\n");
    const second = snapshotWorkingTree(repo, { sessionId: "z", n: 2, privateTmp });
    const stats = diffTrees(repo, first.tree, second.tree, privateTmp);
    const paths = stats.map((s) => s.path);
    assert.ok(paths.includes(nl), `expected exact newline path, got ${JSON.stringify(paths)}`);
    assert.ok(paths.includes(cafe), `expected exact non-ASCII path, got ${JSON.stringify(paths)}`);
    assert.ok(!paths.some((p) => p.startsWith('"') && p.endsWith('"')), "paths must not be C-quoted");
    assert.ok(!paths.some((p) => p.includes("\\n") || p.includes("\\303")), "paths must not be git-quoted");
  });

  it("refuses submodule gitlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sub-"));
    const repo = join(root, "repo");
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    commitAll(repo);
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${sha},vendor`], { cwd: repo, stdio: "pipe" });
    assert.equal(hasSubmodules(repo, join(root, "tmp")), true);
    mkdirSync(join(root, "tmp"));
    assert.throws(
      () => snapshotWorkingTree(repo, { sessionId: "s", n: 1, privateTmp: join(root, "tmp") }),
      UnsupportedTree,
    );
  });

  it("plan/research snapshot stores bytes before returning content id", () => {
    resetLifecycleAdapter();
    const root = mkdtempSync(join(tmpdir(), "pi-plan-"));
    const assigned = join(root, "plan.md");
    writeFileSync(assigned, "# plan\n");
    const store = new ContentStore(join(root, "store"));
    const { contentId, manifest } = snapshotPlanResearch({
      kind: "plan",
      requestId: "r1",
      assignedPath: assigned,
      sourceRoots: [root],
      store,
    });
    assert.match(contentId, /^sha256:[0-9a-f]{64}$/);
    assert.equal(store.exists(contentId), true);
    assert.equal(manifest.files[0].path, assigned);
    assert.equal(store.getManifest(contentId).kind, "plan");
  });
});
