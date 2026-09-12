import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  applyAttemptSuffix,
  pathCarriesAttemptId,
  prepareArtifactWrite,
  readArtifactClaim,
  resolveArtifactWrite,
} from "../pi-extension/subagents/artifact-identity.ts";

const MODULE_URL = pathToFileURL(
  fileURLToPath(new URL("../pi-extension/subagents/artifact-identity.ts", import.meta.url)),
).href;

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-artifact-identity-"));
}

describe("artifact identity", () => {
  it("detects D23 attempt-id in the filename and does not double-suffix", () => {
    const attemptId = "11111111-1111-4111-8111-111111111111";
    const d23 = `/tmp/notes.implementer.${attemptId}.md`;
    assert.equal(pathCarriesAttemptId(d23, attemptId), true);
    assert.equal(applyAttemptSuffix(d23, attemptId), d23);
    assert.equal(pathCarriesAttemptId("/tmp/notes.md", attemptId), false);
    assert.equal(
      applyAttemptSuffix("/tmp/notes.md", attemptId),
      `/tmp/notes.${attemptId}.md`,
    );
  });

  it("same attempt may rewrite the same path (idempotent, not a conflict)", () => {
    const root = tmpRoot();
    const ledgerDir = join(root, "ledger");
    const target = join(root, "out", "notes.md");
    const attemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    const first = resolveArtifactWrite({ path: target, attemptId, ledgerDir });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.scoped, false);
    assert.equal(first.path, resolve(target));
    mkdirSync(dirname(first.path), { recursive: true });
    writeFileSync(first.path, "draft-1", "utf8");

    const second = resolveArtifactWrite({ path: target, attemptId, ledgerDir });
    assert.deepEqual(second, first);
    writeFileSync(first.path, "draft-2", "utf8");
    assert.equal(readFileSync(first.path, "utf8"), "draft-2");
    const claim = readArtifactClaim(ledgerDir, target);
    assert.equal(claim?.attemptId, attemptId);
  });

  it("D23 path already carrying this attemptId resolves unchanged", () => {
    const root = tmpRoot();
    const ledgerDir = join(root, "ledger");
    const attemptId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const target = join(root, `notes.planner.${attemptId}.md`);
    const resolved = resolveArtifactWrite({ path: target, attemptId, ledgerDir });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.scoped, false);
    assert.equal(resolved.path, resolve(target));
    assert.equal(resolved.path.includes(`.${attemptId}.md`), true);
    assert.equal(resolved.path.includes(`.${attemptId}.${attemptId}.`), false);
  });

  it("foreign owner of a D23 path is refused (no double-suffix, first content intact)", () => {
    const root = tmpRoot();
    const ledgerDir = join(root, "ledger");
    const ownerId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const otherId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    // Claim a path that already carries otherId, as a different attempt.
    const d23 = join(root, `report.worker.${otherId}.md`);
    const interloper = resolveArtifactWrite({ path: d23, attemptId: ownerId, ledgerDir });
    assert.equal(interloper.ok, true);
    if (!interloper.ok) return;
    writeFileSync(prepareArtifactWrite({ path: d23, attemptId: ownerId, ledgerDir }), "owner-bytes", "utf8");

    const refused = resolveArtifactWrite({ path: d23, attemptId: otherId, ledgerDir });
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.reason, "owned");
    assert.equal(refused.owner, ownerId);
    assert.match(refused.message, /owned by attempt/);
    assert.equal(existsSync(join(root, `report.worker.${otherId}.${otherId}.md`)), false);
    assert.equal(readFileSync(interloper.path, "utf8"), "owner-bytes");
  });

  it("second attempt on an unscoped path is redirected; both outputs preserved", () => {
    const root = tmpRoot();
    const ledgerDir = join(root, "ledger");
    const target = join(root, "shared.md");
    const a = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const b = "ffffffff-ffff-4fff-8fff-ffffffffffff";

    const first = resolveArtifactWrite({ path: target, attemptId: a, ledgerDir });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    mkdirSync(dirname(first.path), { recursive: true });
    writeFileSync(first.path, "first-writer", "utf8");

    const second = resolveArtifactWrite({ path: target, attemptId: b, ledgerDir });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.scoped, true);
    assert.equal(second.path, applyAttemptSuffix(resolve(target), b));
    mkdirSync(dirname(second.path), { recursive: true });
    writeFileSync(second.path, "second-writer", "utf8");

    assert.equal(readFileSync(first.path, "utf8"), "first-writer");
    assert.equal(readFileSync(second.path, "utf8"), "second-writer");
    assert.equal(readArtifactClaim(ledgerDir, target)?.attemptId, a);
    assert.equal(readArtifactClaim(ledgerDir, second.path)?.attemptId, b);

    const retry = resolveArtifactWrite({ path: target, attemptId: b, ledgerDir });
    assert.deepEqual(retry, second);
  });

  it("rejects empty path and empty attemptId", () => {
    const root = tmpRoot();
    const ledgerDir = join(root, "ledger");
    const noAttempt = resolveArtifactWrite({ path: join(root, "x.md"), attemptId: "", ledgerDir });
    assert.equal(noAttempt.ok, false);
    if (!noAttempt.ok) assert.equal(noAttempt.reason, "invalid-attempt");
    const slashAttempt = resolveArtifactWrite({
      path: join(root, "x.md"),
      attemptId: "a/b",
      ledgerDir,
    });
    assert.equal(slashAttempt.ok, false);
    const noPath = resolveArtifactWrite({ path: "  ", attemptId: "ok", ledgerDir });
    assert.equal(noPath.ok, false);
    if (!noPath.ok) assert.equal(noPath.reason, "invalid-path");
  });

  it("two child processes racing the same path: exactly one owner, no truncation", async () => {
    const root = tmpRoot();
    const ledgerDir = join(root, "ledger");
    const target = join(root, "race", "shared.md");
    mkdirSync(dirname(target), { recursive: true });
    mkdirSync(join(ledgerDir, "claims"), { recursive: true });

    const attemptA = "11111111-1111-4111-8111-aaaaaaaaaaaa";
    const attemptB = "22222222-2222-4222-8222-bbbbbbbbbbbb";
    const payloadA = `A:${attemptA}\n${"A".repeat(8192)}`;
    const payloadB = `B:${attemptB}\n${"B".repeat(8192)}`;
    writeFileSync(join(root, "payload-a"), payloadA);
    writeFileSync(join(root, "payload-b"), payloadB);

    const childFile = join(root, "racer.mjs");
    writeFileSync(
      childFile,
      `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

writeFileSync(process.env.READY_FILE, "ready");
while (!existsSync(process.env.GO_FILE)) {}

const { resolveArtifactWrite } = await import(process.env.MODULE_URL);
const result = resolveArtifactWrite({
  path: process.env.TARGET,
  attemptId: process.env.ATTEMPT,
  ledgerDir: process.env.LEDGER,
});
if (result.ok) {
  mkdirSync(dirname(result.path), { recursive: true });
  writeFileSync(result.path, readFileSync(process.env.PAYLOAD_FILE, "utf8"), "utf8");
}
process.stdout.write(JSON.stringify({ attemptId: process.env.ATTEMPT, ...result }));
`,
    );

    const goFile = join(root, "go");
    const spawnRacer = (attemptId: string, payloadFile: string, readyFile: string) =>
      new Promise<{ stdout: string; stderr: string; status: number | null }>((resolvePromise, reject) => {
        const child = spawn(process.execPath, [childFile], {
          env: {
            ...process.env,
            MODULE_URL,
            TARGET: target,
            ATTEMPT: attemptId,
            LEDGER: ledgerDir,
            PAYLOAD_FILE: payloadFile,
            READY_FILE: readyFile,
            GO_FILE: goFile,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (status) => resolvePromise({ stdout, stderr, status }));
      });

    const readyA = join(root, "ready-a");
    const readyB = join(root, "ready-b");
    const runningA = spawnRacer(attemptA, join(root, "payload-a"), readyA);
    const runningB = spawnRacer(attemptB, join(root, "payload-b"), readyB);

    const waitReady = async (file: string) => {
      const deadline = Date.now() + 5000;
      while (!existsSync(file)) {
        if (Date.now() > deadline) throw new Error(`racer never became ready: ${file}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    await Promise.all([waitReady(readyA), waitReady(readyB)]);
    writeFileSync(goFile, "go");

    const [outA, outB] = await Promise.all([runningA, runningB]);
    assert.equal(outA.status, 0, outA.stderr);
    assert.equal(outB.status, 0, outB.stderr);

    const resultA = JSON.parse(outA.stdout);
    const resultB = JSON.parse(outB.stdout);
    assert.equal(resultA.ok, true, outA.stdout + outA.stderr);
    assert.equal(resultB.ok, true, outB.stdout + outB.stderr);

    const unscope = [resultA, resultB].filter((r) => r.scoped === false);
    const scoped = [resultA, resultB].filter((r) => r.scoped === true);
    assert.equal(unscope.length, 1, JSON.stringify([resultA, resultB]));
    assert.equal(scoped.length, 1, JSON.stringify([resultA, resultB]));
    assert.equal(unscope[0].path, resolve(target));

    const winnerPayload = unscope[0].attemptId === attemptA ? payloadA : payloadB;
    const loserPayload = scoped[0].attemptId === attemptA ? payloadA : payloadB;
    assert.equal(readFileSync(unscope[0].path, "utf8"), winnerPayload);
    assert.equal(readFileSync(scoped[0].path, "utf8"), loserPayload);
    assert.notEqual(readFileSync(unscope[0].path, "utf8"), loserPayload);

    const claim = readArtifactClaim(ledgerDir, target);
    assert.equal(claim?.attemptId, unscope[0].attemptId);
    assert.equal(claim?.path, resolve(target));
  });
});
