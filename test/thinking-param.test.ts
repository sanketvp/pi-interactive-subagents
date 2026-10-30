import { test } from "node:test";
import assert from "node:assert/strict";
import subagentsExtension, { __test__ } from "../pi-extension/subagents/index.ts";
import { validateLaunch } from "../pi-extension/subagents/hardening.ts";

test("subagent thinking parameter is exposed and overrides the agent default", () => {
  const tools: any[] = [];
  subagentsExtension({
    on() {},
    registerTool(tool: any) { tools.push(tool); },
    registerCommand() {},
    registerMessageRenderer() {},
  } as any);

  const subagent = tools.find((tool) => tool.name === "subagent");
  assert.ok(subagent, "expected subagent tool to be registered");
  assert.equal(subagent.parameters.properties.thinking.type, "string");

  const requested = __test__.requestedIdentity(
    { model: "xai/grok-4.6", thinking: "high" },
    { model: "xai/grok-4.6", thinking: "medium" },
    { model: { provider: "xai", id: "grok-4.6" }, thinkingLevel: "low" },
  );
  const args = __test__.buildDispatcherArgs({
    ...requested,
    sessionFile: "/tmp/child.jsonl",
    extensionPath: "/tmp/subagent-done.ts",
    repo: "/tmp/project",
    promptArgs: ["task"],
  });

  assert.deepEqual(args.slice(0, 8), [
    "--interactive", "--provider", "xai", "--model", "grok-4.6", "--effort", "high", "--session",
  ]);
});

test("requested thinking retains agent and parent defaults when absent", () => {
  const ctx = { model: { provider: "xai", id: "grok-4.6" }, thinkingLevel: "high" };

  assert.equal(
    __test__.requestedIdentity({}, { thinking: "medium" }, ctx).thinking,
    "medium",
  );
  assert.equal(__test__.requestedIdentity({}, null, ctx).thinking, "high");
});

test("invalid per-call thinking is rejected before launch", () => {
  assert.throws(
    () => validateLaunch({ name: "Worker", thinking: "banana" }, null),
    /Thinking level must be one of: off, minimal, low, medium, high, xhigh/,
  );
});
