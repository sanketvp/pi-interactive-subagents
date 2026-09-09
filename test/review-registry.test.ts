import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  validateRegistry,
  validateRegistryV2,
  migrateV1toV2,
  ReviewRegistryStore,
  writeRegistry,
  freshRegistryV2,
  REGISTRY_VERSION_V2,
  RegistryValidationError,
} from "../pi-extension/subagents/registry.ts";
import { createDefaultAdapter, setLifecycleAdapter } from "../pi-extension/subagents/adapter.ts";
import { DEFAULT_GATING } from "../pi-extension/subagents/review/types.ts";

function worker(overrides: Record<string, unknown> = {}) {
  const root = "/tmp/pi-reg-test";
  return {
    attemptId: randomUUID(),
    parentSessionId: randomUUID(),
    piSessionId: null,
    invocation: 1,
    completionToken: randomUUID(),
    tmuxSocket: "/tmp/tmux-test/sock",
    windowId: "@0",
    surface: "%1",
    sessionFile: join(root, "session.jsonl"),
    launchScriptFile: join(root, "launch.sh"),
    completionFile: join(root, "done.json"),
    paneStartCommand: "bash " + join(root, "launch.sh"),
    requested: { provider: "xai", model: "grok-4.6", thinking: "high" },
    observed: null,
    resourceState: "running",
    outcome: null,
    outcomeBytes: null,
    outcomeDigest: null,
    deliveryState: null,
    createdAt: 1,
    name: "reviewer",
    task: "review",
    ...overrides,
  };
}

describe("registry v2", () => {
  it("v2 is unreadable by v1 validators", () => {
    const v2 = freshRegistryV2();
    assert.equal(v2.version, REGISTRY_VERSION_V2);
    assert.throws(() => validateRegistry(v2), /Unsupported registry version: 2/);
  });

  it("fresh v2 defaults gating to shadow, not on", () => {
    const v2 = freshRegistryV2();
    assert.equal(v2.review.gating, DEFAULT_GATING);
    assert.equal(v2.review.gating, "shadow");
    assert.equal(v2.review.sandbox.available, false);
    assert.equal(v2.review.sandbox.addonLoaded, false);
    assert.deepEqual(v2.review.coordinatorEvents, []);
    assert.deepEqual(v2.review.profileCopies, {});
  });

  it("migration is validator-clean; .v1.bak written once; legacy intents abandoned", () => {
    setLifecycleAdapter(createDefaultAdapter());
    const dir = mkdtempSync(join(tmpdir(), "pi-regv2-"));
    const path = join(dir, "workers.json");
    const w = worker();
    writeRegistry(path, 1, [w], {
      review: {
        intents: [{ id: "legacy-1", status: "queued", assignment: { model: "xai/grok-4.6" } }],
      },
    });
    const v1raw = readFileSync(path, "utf8");
    const v1 = JSON.parse(v1raw);
    assert.equal(v1.version, 1);
    const migrated = migrateV1toV2(v1);
    assert.doesNotThrow(() => validateRegistryV2(migrated));
    assert.equal(migrated.version, 2);
    assert.equal(migrated.revision, 0);
    assert.equal(migrated.invocations, 1);
    assert.equal(migrated.workers[0].attemptId, w.attemptId);
    assert.equal(migrated.review.intents[0].status, "abandoned");
    assert.equal(migrated.review.intents[0].assignment.queueClass, "author");
    assert.equal(migrated.review.sandbox.available, false);
    assert.deepEqual(migrated.review.coordinatorEvents, []);
    assert.deepEqual(migrated.review.profileCopies, {});

    const store = new ReviewRegistryStore(path);
    const load1 = store.load();
    assert.equal(load1.status, "migrated");
    const bak = path + ".v1.bak";
    assert.equal(existsSync(bak), true);
    assert.equal(readFileSync(bak, "utf8"), v1raw);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(onDisk.version, 2);
    assert.doesNotThrow(() => validateRegistryV2(onDisk));

    // bak written once: mutate bak, load v2 (already migrated) must not rewrite bak
    writeFileSync(bak, "do-not-clobber");
    const store2 = new ReviewRegistryStore(path);
    const load2 = store2.load();
    assert.equal(load2.status, "ok");
    assert.equal(readFileSync(bak, "utf8"), "do-not-clobber");
  });

  it("file-digest tamper detection: mismatch refuses the write and sets tamper hold", () => {
    setLifecycleAdapter(createDefaultAdapter());
    const dir = mkdtempSync(join(tmpdir(), "pi-tamper-"));
    const path = join(dir, "workers.json");
    const store = new ReviewRegistryStore(path);
    const missing = store.load();
    assert.equal(missing.status, "missing");
    const first = store.write(missing.registry);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    writeFileSync(path, JSON.stringify({ ...first.registry, revision: 99 }));
    const second = store.write(first.registry);
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.tamper, true);
    assert.equal(store.sessionHold, "tamper");
    assert.equal(store.lastAudit?.kind, "registry-tamper");
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(onDisk.revision, 99);
  });

  it("latched tamper hold refuses further writes until P13 overwrite", () => {
    setLifecycleAdapter(createDefaultAdapter());
    const dir = mkdtempSync(join(tmpdir(), "pi-hold-"));
    const path = join(dir, "workers.json");
    const store = new ReviewRegistryStore(path);
    const missing = store.load();
    const first = store.write(missing.registry);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const goodBytes = readFileSync(path);
    writeFileSync(path, JSON.stringify({ ...first.registry, revision: 99 }));
    const blocked = store.write(first.registry);
    assert.equal(blocked.ok, false);
    assert.equal(store.sessionHold, "tamper");
    writeFileSync(path, goodBytes);
    const stillBlocked = store.write(first.registry);
    assert.equal(stillBlocked.ok, false);
    if (!stillBlocked.ok) assert.equal(stillBlocked.found, "hold");
    store.overwriteHold();
    assert.equal(store.sessionHold, null);
    const after = store.write(first.registry);
    assert.equal(after.ok, true);
  });

  it("migration drops malformed v1 review.requests/artifacts (validator-clean)", () => {
    setLifecycleAdapter(createDefaultAdapter());
    const dir = mkdtempSync(join(tmpdir(), "pi-malform-"));
    const path = join(dir, "workers.json");
    const w = worker();
    const goodRequest = {
      id: "req-1",
      status: "open",
      artifactKeys: ["code:root"],
      coordinatorShellTaint: [],
      shellAuthorities: [],
      sourceRoots: ["/tmp/repo"],
      triggerAggregate: { lines: 0, perRoot: {}, threshold: 0, computedAt: "" },
    };
    const goodArtifact = {
      key: "code:root",
      kind: "code",
      requestId: "req-1",
      state: "DRAFT",
      current: {
        contentId: "tree:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        bindingId: "bind:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        baseCommit: null,
        contributors: ["xai"],
        epoch: 0,
        persisted: true,
      },
      minQuorum: 1,
      egressRoots: ["/tmp/repo"],
      required: true,
      round: 0,
      roundBudget: 3,
      authorClasses: [],
      certifiedPaths: [],
      persisted: true,
    };
    writeRegistry(path, 1, [w], {
      review: {
        requests: ["nope", goodRequest, { id: "x" }],
        artifacts: { bad: 1, [goodArtifact.key]: goodArtifact },
      },
    });
    const v1 = JSON.parse(readFileSync(path, "utf8"));
    const migrated = migrateV1toV2(v1);
    assert.doesNotThrow(() => validateRegistryV2(migrated));
    assert.equal(migrated.review.requests.length, 0);
    assert.equal(Object.keys(migrated.review.artifacts).length, 0);
  });

  it("hostile v1 APPROVED/WAIVED/cleared/certifiedPaths do not survive migration", () => {
    setLifecycleAdapter(createDefaultAdapter());
    const dir = mkdtempSync(join(tmpdir(), "pi-hostile-"));
    const path = join(dir, "workers.json");
    const w = worker();
    writeRegistry(path, 1, [w], {
      review: {
        requests: [
          {
            id: "req-1",
            status: "cleared",
            artifactKeys: ["code:root"],
            coordinatorShellTaint: [],
            shellAuthorities: [],
            sourceRoots: ["/tmp/repo"],
            triggerAggregate: { lines: 0, perRoot: {}, threshold: 0, computedAt: "" },
          },
        ],
        artifacts: {
          "code:root": {
            key: "code:root",
            kind: "code",
            requestId: "req-1",
            state: "APPROVED",
            current: {
              contentId: "tree:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              bindingId: "bind:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              baseCommit: null,
              contributors: ["xai"],
              epoch: 0,
              persisted: true,
            },
            minQuorum: 1,
            egressRoots: ["/tmp/repo"],
            required: true,
            round: 1,
            roundBudget: 3,
            authorClasses: [],
            certifiedPaths: ["**"],
            persisted: true,
            hold: "repair",
            quorum: { round: 1, bindingId: "bind:x", seats: [], outcome: "APPROVED" },
            verifications: [{ id: "v1", contentId: "tree:a", baseCommit: null, result: "PASS", at: "t" }],
          },
          plan: {
            key: "plan:req-1",
            kind: "plan",
            requestId: "req-1",
            state: "WAIVED",
            current: {
              contentId: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
              bindingId: "bind:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
              baseCommit: null,
              contributors: ["anthropic"],
              epoch: 0,
              persisted: true,
            },
            minQuorum: 2,
            egressRoots: [],
            required: true,
            round: 0,
            roundBudget: 3,
            authorClasses: [],
            certifiedPaths: [],
            persisted: true,
          },
        },
      },
    });
    const migrated = migrateV1toV2(JSON.parse(readFileSync(path, "utf8")));
    assert.equal(migrated.review.requests.length, 0);
    assert.equal(Object.keys(migrated.review.artifacts).length, 0);
    assert.equal(migrated.review.gating, "shadow");
  });

  it("migration ignores planted v1 gating and resets to shadow", () => {
    setLifecycleAdapter(createDefaultAdapter());
    const dir = mkdtempSync(join(tmpdir(), "pi-gating-"));
    const path = join(dir, "workers.json");
    const w = worker();
    writeRegistry(path, 1, [w], { review: { gating: "off" } });
    const v1 = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(v1.review.gating, "off");
    const migrated = migrateV1toV2(v1);
    assert.equal(migrated.review.gating, DEFAULT_GATING);
    assert.equal(migrated.review.gating, "shadow");
  });

  it("sanitizeArtifacts does not prototype-pollute on __proto__/constructor keys", () => {
    setLifecycleAdapter(createDefaultAdapter());
    const dir = mkdtempSync(join(tmpdir(), "pi-proto-"));
    const path = join(dir, "workers.json");
    const w = worker();
    const protoArtifact = {
      key: "__proto__",
      kind: "code",
      requestId: "req-1",
      state: "DRAFT",
      current: {
        contentId: "tree:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        bindingId: "bind:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        baseCommit: null,
        contributors: ["xai"],
        epoch: 0,
        persisted: true,
      },
      minQuorum: 1,
      egressRoots: ["/tmp/repo"],
      required: true,
      round: 0,
      roundBudget: 3,
      authorClasses: [],
      certifiedPaths: [],
      persisted: true,
      polluted: true,
    };
    writeRegistry(path, 1, [w], {
      review: {
        artifacts: { "__proto__": protoArtifact, constructor: protoArtifact },
      },
    });
    const v1 = JSON.parse(readFileSync(path, "utf8"));
    const migrated = migrateV1toV2(v1);
    assert.equal(Object.hasOwn(Object.prototype as object, "kind"), false);
    assert.equal(Object.hasOwn(Object.prototype as object, "polluted"), false);
    assert.equal(({} as { kind?: unknown }).kind, undefined);
    assert.equal(Object.hasOwn(migrated.review.artifacts, "__proto__"), false);
    assert.equal(Object.hasOwn(migrated.review.artifacts, "constructor"), false);
    assert.equal(Object.keys(migrated.review.artifacts).length, 0);
  });

  it("rejects unvalidated hold/quorum/verifications/shellAuthorities", () => {
    const base = freshRegistryV2();
    const good = {
      key: "code:root",
      kind: "code" as const,
      requestId: "req-1",
      state: "DRAFT" as const,
      current: {
        contentId: "tree:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        bindingId: "bind:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        baseCommit: null,
        contributors: ["xai" as const],
        epoch: 0,
        persisted: true,
      },
      minQuorum: 1 as const,
      egressRoots: ["/tmp/repo"],
      required: true,
      round: 0,
      roundBudget: 3,
      authorClasses: [],
      certifiedPaths: [],
      persisted: true,
    };
    base.review.artifacts = { "code:root": { ...good, hold: "repair" } };
    assert.doesNotThrow(() => validateRegistryV2(base));
    const badHold = freshRegistryV2();
    badHold.review.artifacts = { "code:root": { ...good, hold: "nope" as any } };
    assert.throws(() => validateRegistryV2(badHold), RegistryValidationError);
    const badQuorum = freshRegistryV2();
    badQuorum.review.artifacts = { "code:root": { ...good, quorum: { round: 1, bindingId: "x", seats: [], outcome: "YES" } as any } };
    assert.throws(() => validateRegistryV2(badQuorum), RegistryValidationError);
    const badVer = freshRegistryV2();
    badVer.review.artifacts = {
      "code:root": { ...good, verifications: [{ id: "v", contentId: "c", baseCommit: null, result: "OK", at: "t" }] as any },
    };
    assert.throws(() => validateRegistryV2(badVer), RegistryValidationError);
    const badAuth = freshRegistryV2();
    badAuth.review.requests = [
      {
        id: "req-1",
        status: "open",
        artifactKeys: [],
        coordinatorShellTaint: [],
        shellAuthorities: [{ id: "s", owner: "nobody", families: [], root: "/", writeRoots: [], openedAt: "1" } as any],
        sourceRoots: [],
        triggerAggregate: { lines: 0, perRoot: {}, threshold: 0, computedAt: "" },
      },
    ];
    assert.throws(() => validateRegistryV2(badAuth), RegistryValidationError);
  });

  it("validates panePid / workerProc extras", () => {
    const ok = freshRegistryV2();
    ok.workers = [
      worker({
        panePid: { pid: 12, startSec: 1, startUsec: 2 },
        workerProc: { pid: 13, startSec: 1, startUsec: 3, registeredAt: "now" },
      }),
    ];
    assert.doesNotThrow(() => validateRegistryV2(ok));
    const bad = freshRegistryV2();
    bad.workers = [worker({ panePid: { pid: -1, startSec: 0, startUsec: 0 } })];
    assert.throws(() => validateRegistryV2(bad), RegistryValidationError);
  });
});
