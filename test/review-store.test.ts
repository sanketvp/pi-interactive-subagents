import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContentStore, contentIdOf } from "../pi-extension/subagents/review/store.ts";
import { resetLifecycleAdapter } from "../pi-extension/subagents/adapter.ts";

describe("store", () => {
  it("is content-addressed, durable, and canonicalises manifests", () => {
    resetLifecycleAdapter();
    const root = mkdtempSync(join(tmpdir(), "pi-store-"));
    const store = new ContentStore(join(root, "store"));
    const id = store.put(Buffer.from("hello"));
    assert.equal(id, contentIdOf("hello"));
    assert.equal(store.exists(id), true);
    assert.equal(store.get(id).toString("utf8"), "hello");
    const hex = id.slice(7);
    assert.equal(existsSync(join(root, "store", hex.slice(0, 2), hex)), true);
    assert.equal(readFileSync(join(root, "store", hex.slice(0, 2), hex), "utf8"), "hello");

    const m1 = store.putManifest({
      kind: "plan",
      requestId: "r1",
      assignedPath: "/a.md",
      files: [
        { path: "/b", sha256: "b".repeat(64), size: 1 },
        { path: "/a", sha256: "a".repeat(64), size: 1 },
      ],
      sourceRoots: ["/z", "/a"],
    });
    const m2 = store.putManifest({
      kind: "plan",
      requestId: "r1",
      assignedPath: "/a.md",
      files: [
        { path: "/a", sha256: "a".repeat(64), size: 1 },
        { path: "/b", sha256: "b".repeat(64), size: 1 },
      ],
      sourceRoots: ["/a", "/z"],
    });
    assert.equal(m1, m2);
    const loaded = store.getManifest(m1);
    assert.equal(loaded.files[0].path, "/a");
    assert.deepEqual(loaded.sourceRoots, ["/a", "/z"]);
  });
});
