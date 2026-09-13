import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  readlinkSync,
  lstatSync,
  existsSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { snapshotWorkingTree, UnsupportedTree } from "../pi-extension/subagents/review/artifact.ts";
import {
  materialize,
  manifestOf,
  manifestIntegrity,
  remove,
  resolveVerifyBase,
  sessionShortOf,
} from "../pi-extension/subagents/review/worktree.ts";

function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "pipe" });
}

function commitAll(dir: string, message = "c") {
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["-c", "core.hooksPath=/var/empty", "commit", "-m", message, "--allow-empty"], {
    cwd: dir,
    stdio: "pipe",
  });
}

describe("worktree materialisation", () => {
  it("materialises under verifyBase with manifest equality; integrity distinguishes new vs modified", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-wt-"));
    const repo = join(root, "repo");
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "alpha\n");
    writeFileSync(join(repo, "b.txt"), "beta\n");
    commitAll(repo);
    const snap = snapshotWorkingTree(repo, { sessionId: "abcdef12-sess", n: 1, privateTmp: tmp });
    const sessionShort = sessionShortOf("abcdef12-sess");
    const { dir, manifest } = materialize(snap.contentId, "attempt-1", {
      repoDir: repo,
      sessionShort,
      tmpdir: tmp,
      privateTmp: tmp,
    });
    const expectedBase = resolveVerifyBase(sessionShort, tmp);
    assert.equal(dir.startsWith(expectedBase), true);
    assert.equal(existsSync(join(dir, ".git")), false);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "alpha\n");
    const onDisk = manifestOf(dir, snap.contentId);
    assert.deepEqual(
      onDisk.entries.map((e) => e.path),
      manifest.entries.map((e) => e.path),
    );
    for (const e of manifest.entries) {
      const got = onDisk.entries.find((x) => x.path === e.path);
      assert.equal(got?.sha256, e.sha256);
    }
    writeFileSync(join(dir, "new.txt"), "new\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const integrity = manifestIntegrity(dir, manifest);
    assert.equal(integrity.ok, false);
    assert.ok(integrity.newFiles.includes("new.txt"));
    assert.ok(integrity.modified.includes("a.txt"));
    assert.ok(!integrity.modified.includes("new.txt"));
    assert.ok(!integrity.newFiles.includes("a.txt"));
    remove(dir);
    assert.equal(existsSync(dir), false);
  });

  it("deletion: materialising an earlier tree restores the deleted file as raw bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-del-"));
    const repo = join(root, "repo");
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    initRepo(repo);
    writeFileSync(join(repo, "keep.txt"), "keep\n");
    writeFileSync(join(repo, "gone.txt"), "raw-deleted\n");
    commitAll(repo);
    const snap = snapshotWorkingTree(repo, { sessionId: "del", n: 1, privateTmp: tmp });
    unlinkSync(join(repo, "gone.txt"));
    commitAll(repo, "deleted");
    const { dir } = materialize(snap.contentId, "att-del", {
      repoDir: repo,
      sessionShort: "del",
      tmpdir: tmp,
      privateTmp: tmp,
    });
    assert.equal(readFileSync(join(dir, "gone.txt"), "utf8"), "raw-deleted\n");
    assert.equal(readFileSync(join(dir, "keep.txt"), "utf8"), "keep\n");
  });

  it("symlink: materialises as a symlink whose target is the blob bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-lnk-"));
    const repo = join(root, "repo");
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    initRepo(repo);
    writeFileSync(join(repo, "target.txt"), "t\n");
    symlinkSync("target.txt", join(repo, "the-link"));
    commitAll(repo);
    const snap = snapshotWorkingTree(repo, { sessionId: "lnk", n: 1, privateTmp: tmp });
    const { dir } = materialize(snap.contentId, "att-lnk", {
      repoDir: repo,
      sessionShort: "lnk",
      tmpdir: tmp,
      privateTmp: tmp,
    });
    assert.equal(lstatSync(join(dir, "the-link")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(dir, "the-link")), "target.txt");
  });

  it("filename-with-newline is preserved", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-nl-"));
    const repo = join(root, "repo");
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    initRepo(repo);
    const name = "foo\nbar.txt";
    writeFileSync(join(repo, name), "nl-bytes\n");
    commitAll(repo);
    const snap = snapshotWorkingTree(repo, { sessionId: "nl", n: 1, privateTmp: tmp });
    const { dir } = materialize(snap.contentId, "att-nl", {
      repoDir: repo,
      sessionShort: "nl",
      tmpdir: tmp,
      privateTmp: tmp,
    });
    assert.equal(readFileSync(join(dir, name), "utf8"), "nl-bytes\n");
  });

  it("submodule gitlink → UnsupportedTree (no checkout)", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sm-"));
    const repo = join(root, "repo");
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    initRepo(repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    commitAll(repo);
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const idxDir = join(tmp, "idx");
    mkdirSync(idxDir);
    const index = join(idxDir, "index");
    execFileSync("git", ["read-tree", "HEAD"], { cwd: repo, env: { ...process.env, GIT_INDEX_FILE: index }, stdio: "pipe" });
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${sha},vendor`], {
      cwd: repo,
      env: { ...process.env, GIT_INDEX_FILE: index },
      stdio: "pipe",
    });
    const tree = execFileSync("git", ["write-tree"], {
      cwd: repo,
      env: { ...process.env, GIT_INDEX_FILE: index },
      encoding: "utf8",
    }).trim();
    assert.throws(
      () =>
        materialize(`tree:${tree}`, "att-sm", {
          repoDir: repo,
          sessionShort: "sm",
          tmpdir: tmp,
          privateTmp: tmp,
        }),
      UnsupportedTree,
    );
  });

  it("filter.*.process and working-tree-encoding: blob materialisation produces raw bytes and executes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flt-"));
    const repo = join(root, "repo");
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    initRepo(repo);
    const canary = join(root, "FILTER_RAN");
    const helper = join(root, "filter.sh");
    writeFileSync(helper, `#!/bin/sh\necho ran >> "${canary}"\ncat\n`);
    chmodSync(helper, 0o755);
    const payload = Buffer.from("hello-raw-bytes\n", "utf8");
    writeFileSync(join(repo, "encoded.txt"), payload);
    writeFileSync(join(repo, ".gitattributes"), "*.txt filter=evil working-tree-encoding=UTF-16\n");
    // Commit with plumbing BEFORE installing the process filter so fixture setup executes nothing.
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: payload,
      encoding: "utf8",
    }).trim();
    const attrBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: readFileSync(join(repo, ".gitattributes")),
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},encoded.txt`], {
      cwd: repo,
      stdio: "pipe",
    });
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${attrBlob},.gitattributes`], {
      cwd: repo,
      stdio: "pipe",
    });
    execFileSync("git", ["commit", "-m", "encoded"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["config", "filter.evil.process", helper], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["config", "filter.evil.smudge", helper], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["config", "filter.evil.clean", helper], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["config", "core.autocrlf", "true"], { cwd: repo, stdio: "pipe" });
    if (existsSync(canary)) unlinkSync(canary);

    const snap = snapshotWorkingTree(repo, { sessionId: "flt", n: 1, privateTmp: tmp });
    const { dir } = materialize(snap.contentId, "att-flt", {
      repoDir: repo,
      sessionShort: "flt",
      tmpdir: tmp,
      privateTmp: tmp,
    });
    const got = readFileSync(join(dir, "encoded.txt"));
    assert.deepEqual(got, payload);
    assert.equal(got.toString("utf8"), "hello-raw-bytes\n");
    assert.notEqual(got.slice(0, 2).toString("hex"), "fffe");
    assert.notEqual(got.slice(0, 2).toString("hex"), "feff");
    assert.equal(existsSync(canary), false, "filter process/smudge/clean must not execute");
  });

  it("D/F+symlink tree from git mktree is refused before any outside write", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-df-"));
    const repo = join(root, "repo");
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    initRepo(repo);
    const escapeDir = join(root, "escapedir");
    mkdirSync(escapeDir);
    const outside = join(escapeDir, "x");
    const linkSha = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: escapeDir,
      encoding: "utf8",
    }).trim();
    const fileSha = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: "pwned\n",
      encoding: "utf8",
    }).trim();
    // git update-index refuses this D/F; mktree does not (duplicate name `foo`).
    const inner = execFileSync("git", ["mktree"], {
      cwd: repo,
      input: `100644 blob ${fileSha}\tx\n`,
      encoding: "utf8",
    }).trim();
    const tree = execFileSync("git", ["mktree"], {
      cwd: repo,
      input: `120000 blob ${linkSha}\tfoo\n040000 tree ${inner}\tfoo\n`,
      encoding: "utf8",
    }).trim();
    assert.match(tree, /^[0-9a-f]{40}$/);
    assert.equal(existsSync(outside), false);
    assert.throws(
      () =>
        materialize(`tree:${tree}`, "att-df", {
          repoDir: repo,
          sessionShort: "df",
          tmpdir: tmp,
          privateTmp: tmp,
        }),
      UnsupportedTree,
    );
    assert.equal(existsSync(outside), false, "escape write must not land outside the tree");
  });

  it("remove refuses to delete through a symlinked attempt directory", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-rm-"));
    const victim = join(root, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "keep.txt"), "keep\n");
    const link = join(root, "linkdir");
    symlinkSync(victim, link);
    assert.throws(() => remove(link), UnsupportedTree);
    assert.equal(existsSync(join(victim, "keep.txt")), true);
  });

  it("case-collision trees throw UnsupportedTree rather than raw EEXIST", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-case-"));
    const repo = join(root, "repo");
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    initRepo(repo);
    const shaA = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: "A\n",
      encoding: "utf8",
    }).trim();
    const shaB = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: "b\n",
      encoding: "utf8",
    }).trim();
    const tree = execFileSync("git", ["mktree"], {
      cwd: repo,
      input: `100644 blob ${shaA}\tA.txt\n100644 blob ${shaB}\ta.txt\n`,
      encoding: "utf8",
    }).trim();
    try {
      materialize(`tree:${tree}`, "att-case", {
        repoDir: repo,
        sessionShort: "case",
        tmpdir: tmp,
        privateTmp: tmp,
      });
    } catch (error: any) {
      assert.equal(error?.name, "UnsupportedTree");
      assert.notEqual(error?.code, "EEXIST");
      return;
    }
    // Case-sensitive FS: both names can exist; that is not a failure.
  });
});
