import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROFILE_ROLE_MAP,
  roleFor,
  UnknownProfileError,
  profileDigest,
  toolsWithinBounds,
} from "../pi-extension/subagents/review/roles.ts";

describe("roles", () => {
  it("maps every known profile name to a role and tool bounds", () => {
    assert.equal(roleFor("planner").role, "planner");
    assert.deepEqual([...roleFor("planner").tools], ["read", "grep", "find", "ls", "write", "edit"]);
    assert.equal(roleFor("researcher").role, "researcher");
    assert.equal(roleFor("implementer").role, "author");
    assert.equal(roleFor("implementer-gpt").authorClass, "second");
    assert.equal(roleFor("implementer-k3").authorClass, "longctx");
    assert.equal(roleFor("implementer-glm").authorClass, "fanout");
    assert.equal(roleFor("worker").authorClass, "surgical");
    assert.equal(roleFor("bulk").authorClass, "bulk");
    assert.deepEqual([...roleFor("reviewer").tools], ["read", "git_ro"]);
    assert.deepEqual([...roleFor("pr-reviewer").tools], ["read", "git_ro"]);
    assert.ok(roleFor("verifier").tools.includes("verify_exec"));
    assert.ok(!roleFor("verifier").tools.includes("bash"));
    assert.ok(!roleFor("planner").tools.includes("bash"));
    assert.ok(Object.keys(PROFILE_ROLE_MAP).length >= 11);
  });

  it("unknown profile is refused", () => {
    assert.throws(() => roleFor("scout"), UnknownProfileError);
    assert.throws(() => roleFor("implementer-foo"), /unknown profile/);
    assert.throws(() => roleFor(""), /unknown profile/);
  });

  it("prototype-pollution names are refused, not Object.prototype members", () => {
    for (const name of ["constructor", "toString", "__proto__", "valueOf"]) {
      assert.throws(() => roleFor(name), UnknownProfileError);
      assert.equal(Object.hasOwn(PROFILE_ROLE_MAP, name), false);
    }
  });

  it("profileDigest is sha256 of exact body bytes", () => {
    const a = profileDigest("hello");
    const b = profileDigest(Buffer.from("hello"));
    const c = profileDigest("hello\n");
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, c);
  });

  it("tool bounds reject tools outside the role set", () => {
    assert.equal(toolsWithinBounds("reviewer", ["read", "git_ro"]), true);
    assert.equal(toolsWithinBounds("reviewer", ["read", "bash"]), false);
    assert.equal(toolsWithinBounds("implementer", ["read", "write", "edit", "bash-guard"]), true);
  });
});
