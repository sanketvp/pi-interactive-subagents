import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPolicy, materializeProfileCopies, DEFAULT_LAUNCH_ARGV } from "../pi-extension/subagents/review/policy.ts";
import { familyOf, resetAdditiveFamilies } from "../pi-extension/subagents/review/family.ts";
import { DEFAULT_GATING } from "../pi-extension/subagents/review/types.ts";

function temp() {
  return mkdtempSync(join(tmpdir(), "pi-pol-"));
}

describe("policy", () => {
  it("defaults gating to shadow, launchArgv pin, empty coverageRoots", () => {
    const dir = temp();
    const policy = loadPolicy({ configDir: dir, agentsDir: join(dir, "agents") });
    assert.equal(policy.defaultGating, DEFAULT_GATING);
    assert.equal(policy.defaultGating, "shadow");
    assert.deepEqual(policy.launchArgv, DEFAULT_LAUNCH_ARGV);
    assert.ok(policy.launchArgv.includes("--no-approve"));
    assert.ok(!policy.launchArgv.includes("-a"));
    assert.deepEqual(policy.coverageRoots, []);
    assert.equal(typeof policy.sandbox.verifyTimeoutMs, "number");
    assert.equal(policy.sandbox.selfTest.dnsName, "example.com");
    assert.equal(Object.keys(policy.verifyCommands).length, 0);
    assert.match(policy.policyDigest, /^[0-9a-f]{64}$/);
    assert.match(policy.launchArgvDigest, /^[0-9a-f]{64}$/);
  });

  it("loads coverageRoots, sandbox.*, verifyCommands, launchArgv from review-config.json", () => {
    const dir = temp();
    writeFileSync(
      join(dir, "review-config.json"),
      JSON.stringify({
        coverageRoots: ["/tmp/repo"],
        verifyCommands: { "/tmp/repo": ["npm test"] },
        launchArgv: ["pi", "--no-approve", "--session", "<path>"],
        sandbox: { allowLoopback: true, cacheDirs: ["/tmp/cache"], verifyTimeoutMs: 1000, selfTest: { dnsName: "example.org" } },
        defaultGating: "shadow",
      }),
    );
    const policy = loadPolicy({ configDir: dir, agentsDir: join(dir, "agents") });
    assert.deepEqual(policy.coverageRoots, ["/tmp/repo"]);
    assert.deepEqual(policy.verifyCommands["/tmp/repo"], ["npm test"]);
    assert.equal(policy.sandbox.allowLoopback, true);
    assert.deepEqual(policy.sandbox.cacheDirs, ["/tmp/cache"]);
    assert.equal(policy.sandbox.selfTest.dnsName, "example.org");
    assert.ok(policy.launchArgv.includes("--no-approve"));
  });

  it("per-file invalid: bad config is rejected, families.json still loads", () => {
    const dir = temp();
    writeFileSync(join(dir, "review-config.json"), "{not json");
    writeFileSync(join(dir, "families.json"), JSON.stringify({ "custom-mod": "xai" }));
    const policy = loadPolicy({ configDir: dir, agentsDir: join(dir, "agents") });
    assert.ok(policy.invalidFiles.includes("review-config.json"));
    assert.equal(policy.rejectedDigests.length >= 1, true);
    assert.deepEqual(policy.coverageRoots, []);
    assert.equal(policy.familiesAdditive["custom-mod"], "xai");
    assert.equal(familyOf("custom-mod"), "xai");
    resetAdditiveFamilies();
  });

  it("ignores defaultGating on from config (PR-1 stays shadow)", () => {
    const dir = temp();
    writeFileSync(join(dir, "review-config.json"), JSON.stringify({ defaultGating: "on" }));
    const policy = loadPolicy({ configDir: dir, agentsDir: join(dir, "agents") });
    assert.equal(policy.defaultGating, "shadow");
    assert.equal(policy.invalidFiles.includes("review-config.json"), false);
  });

  it("rejects launchArgv that contains -a or omits --no-approve (whole config file invalid)", () => {
    const dir = temp();
    writeFileSync(join(dir, "review-config.json"), JSON.stringify({ launchArgv: ["pi", "-a"] }));
    const policy = loadPolicy({ configDir: dir, agentsDir: join(dir, "agents") });
    assert.ok(policy.invalidFiles.includes("review-config.json"));
    assert.deepEqual(policy.launchArgv, DEFAULT_LAUNCH_ARGV);
  });

  it("materialises accepted profile bodies under sessionDir/profiles/<digest>/<name>.md", () => {
    const dir = temp();
    const agents = join(dir, "agents");
    mkdirSync(agents);
    writeFileSync(join(agents, "planner.md"), "---\nname: planner\n---\n# planner body\n");
    writeFileSync(join(agents, "reviewer.md"), "---\nname: reviewer\n---\n# reviewer body\n");
    writeFileSync(join(agents, "scout.md"), "ignored unknown profile\n");
    const policy = loadPolicy({ configDir: dir, agentsDir: agents });
    assert.ok(policy.profiles.planner);
    assert.ok(policy.profiles.reviewer);
    assert.equal(policy.profiles.scout, undefined);
    const sessionDir = join(dir, "session");
    const copies = materializeProfileCopies(sessionDir, policy);
    assert.ok(existsSync(copies.planner.path));
    assert.ok(copies.planner.path.includes(join("profiles", policy.policyDigest)));
    assert.equal(readFileSync(copies.planner.path, "utf8"), policy.profiles.planner.body);
    assert.equal(copies.planner.digest, policy.profiles.planner.digest);
  });
});
