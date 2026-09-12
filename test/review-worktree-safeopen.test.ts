import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  lstatSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UnsupportedTree } from "../pi-extension/subagents/review/artifact.ts";
import { safeOpenForWrite } from "../pi-extension/subagents/review/worktree.ts";

function throwsUnsupported(fn: () => void): void {
  assert.throws(fn, UnsupportedTree);
}

describe("safeOpenForWrite", () => {
  it("symlink-escape: leaf symlink pointing outside the root is rejected and the target is untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-so-leaf-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "pi-so-out-"));
    const outsideFile = join(outsideDir, "secret.txt");
    writeFileSync(outsideFile, "untouched\n");
    symlinkSync(outsideFile, join(root, "link.txt"));
    throwsUnsupported(() => safeOpenForWrite(root, "link.txt", Buffer.from("pwned\n"), 0o644));
    assert.equal(readFileSync(outsideFile, "utf8"), "untouched\n");
    assert.equal(lstatSync(join(root, "link.txt")).isSymbolicLink(), true);
  });

  it("symlinked intermediate dir: writing through root/link -> outside-dir is rejected", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-so-mid-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "pi-so-outd-"));
    symlinkSync(outsideDir, join(root, "link"));
    throwsUnsupported(() => safeOpenForWrite(root, "link/file.txt", Buffer.from("pwned\n"), 0o644));
    assert.equal(existsSync(join(outsideDir, "file.txt")), false);
  });

  it(".. traversal is rejected and nothing is written outside the root", () => {
    const parent = mkdtempSync(join(tmpdir(), "pi-so-dot-"));
    const root = join(parent, "tree");
    mkdirSync(root);
    mkdirSync(join(root, "sub"));

    assert.throws(
      () => safeOpenForWrite(root, "../escape.txt", Buffer.from("pwned\n"), 0o644),
      (err: unknown) => err instanceof UnsupportedTree && /path escapes tree/.test((err as Error).message),
    );
    assert.equal(existsSync(join(parent, "escape.txt")), false);

    assert.throws(
      () => safeOpenForWrite(root, "sub/../../escape.txt", Buffer.from("pwned\n"), 0o644),
      (err: unknown) => err instanceof UnsupportedTree && /path escapes tree/.test((err as Error).message),
    );
    assert.equal(existsSync(join(parent, "escape.txt")), false);
    assert.equal(existsSync(join(root, "escape.txt")), false);
  });

  it("normal write: nested path succeeds with matching contents and mode", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-so-ok-"));
    const rel = "a/b/c.txt";
    const payload = Buffer.from("hello-safe\n");
    safeOpenForWrite(root, rel, payload, 0o644);
    const abs = join(root, rel);
    assert.equal(readFileSync(abs, "utf8"), "hello-safe\n");
    const st = lstatSync(abs);
    assert.equal(st.isFile(), true);
    assert.equal(st.isSymbolicLink(), false);
    assert.equal(st.mode & 0o777, 0o644);
  });
});
