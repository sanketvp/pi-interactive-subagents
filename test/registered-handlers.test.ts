// Exercises ACTUAL REGISTERED Pi event handlers (not just their extracted
// helper functions) per sol-post-review.log finding P1-6: "the 'registered
// handlers' test checks registration + session_start only... this allowed
// findings 1-3 to pass 153 tests."
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";

function makeApi() {
  const handlers: Record<string, Function[]> = {};
  const tools: Record<string, any> = {};
  const api: any = {
    on(event: string, handler: Function) {
      (handlers[event] ??= []).push(handler);
    },
    registerTool(tool: any) {
      tools[tool.name] = tool;
    },
    registerShortcut() {},
    getAllTools() {
      return [];
    },
  };
  return { api, handlers, tools };
}

function fireOnly(handlers: Record<string, Function[]>, event: string, ...args: any[]) {
  for (const h of handlers[event] ?? []) h(...args);
}

function setup(root: string, opts: { autoExit?: boolean } = {}) {
  const completionFile = join(root, "done.json");
  const sessionFile = join(root, "worker.jsonl");
  process.env.PI_SUBAGENT_COMPLETION_FILE = completionFile;
  process.env.PI_SUBAGENT_TOKEN = randomUUID();
  process.env.PI_SUBAGENT_ID = randomUUID();
  process.env.PI_SUBAGENT_SESSION = sessionFile;
  if (opts.autoExit) process.env.PI_SUBAGENT_AUTO_EXIT = "1";
  else delete process.env.PI_SUBAGENT_AUTO_EXIT;
  delete process.env.PI_SUBAGENT_NAME;
  delete process.env.PI_SUBAGENT_AGENT;
  delete process.env.PI_DENY_TOOLS;

  const { api, handlers } = makeApi();
  subagentDoneExtension(api);

  let shutdownCalls = 0;
  const ctx: any = {
    ui: { setWidget() {} },
    sessionManager: {
      getSessionId: () => "pi-sess-" + randomUUID(),
    },
    model: { provider: "xai", id: "grok-4.6" },
    thinkingLevel: "high",
    shutdown() {
      shutdownCalls += 1;
    },
  };

  fireOnly(handlers, "session_start", {}, ctx);
  return { handlers, ctx, completionFile, getShutdownCalls: () => shutdownCalls };
}

function cleanupEnv() {
  for (const key of [
    "PI_SUBAGENT_COMPLETION_FILE",
    "PI_SUBAGENT_TOKEN",
    "PI_SUBAGENT_ID",
    "PI_SUBAGENT_SESSION",
    "PI_SUBAGENT_AUTO_EXIT",
    "PI_SUBAGENT_NAME",
    "PI_SUBAGENT_AGENT",
    "PI_DENY_TOOLS",
  ]) {
    delete process.env[key];
  }
}

test("registered agent_end never publishes a completion; only agent_settled does (error -> success -> settled gives one final done, no early record)", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agentend-"));
  try {
    const { handlers, ctx, completionFile } = setup(root, { autoExit: true });

    // agent_end(error): must NOT write anything yet -- agent_end only retains.
    fireOnly(handlers, "agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }],
    }, ctx);
    assert.equal(existsSync(completionFile), false, "agent_end(error) must not publish a completion record");

    // agent_end(success): still must NOT write anything -- Pi could still retry/continue.
    fireOnly(handlers, "agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }],
    }, ctx);
    assert.equal(existsSync(completionFile), false, "agent_end(success) must not publish a completion record either");

    // agent_settled: NOW the final outcome is decided from the LAST recorded agent_end result (success).
    fireOnly(handlers, "agent_settled", {}, ctx);
    assert.equal(existsSync(completionFile), true);
    const record = JSON.parse(readFileSync(completionFile, "utf8"));
    assert.equal(record.type, "done");
  } finally {
    cleanupEnv();
  }
});

test("registered agent_settled: an error result publishes type=error", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agentend-err-"));
  try {
    const { handlers, ctx, completionFile } = setup(root, { autoExit: true });
    fireOnly(handlers, "agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "still overloaded" }],
    }, ctx);
    assert.equal(existsSync(completionFile), false);
    fireOnly(handlers, "agent_settled", {}, ctx);
    const record = JSON.parse(readFileSync(completionFile, "utf8"));
    assert.equal(record.type, "error");
    assert.equal(record.errorMessage, "still overloaded");
  } finally {
    cleanupEnv();
  }
});

test("registered agent_settled: a second terminal write (duplicate settle) cannot replace the first", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agentend-dup-"));
  try {
    const { handlers, ctx, completionFile } = setup(root, { autoExit: true });
    fireOnly(handlers, "agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }],
    }, ctx);
    fireOnly(handlers, "agent_settled", {}, ctx);
    const first = JSON.parse(readFileSync(completionFile, "utf8"));
    assert.equal(first.type, "done");

    // Simulate a second, later agent_end/agent_settled cycle (e.g. a spurious
    // re-fire) that would produce an error. It must NOT overwrite the
    // already-published first terminal record.
    fireOnly(handlers, "agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "should never land" }],
    }, ctx);
    fireOnly(handlers, "agent_settled", {}, ctx);
    const after = JSON.parse(readFileSync(completionFile, "utf8"));
    assert.equal(after.type, "done", "first terminal record must be preserved");
  } finally {
    cleanupEnv();
  }
});

test("registered session_start writes the startup receipt from ctx.sessionManager/model/thinkingLevel", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-startup-"));
  try {
    const { completionFile } = setup(root, { autoExit: true });
    const startPath = `${completionFile}.start`;
    assert.equal(existsSync(startPath), true);
    const receipt = JSON.parse(readFileSync(startPath, "utf8"));
    assert.equal(receipt.kind, "startup");
    assert.equal(receipt.observed.provider, "xai");
    assert.equal(receipt.observed.model, "grok-4.6");
    assert.equal(receipt.observed.thinking, "high");
    assert.ok(receipt.piSessionId.startsWith("pi-sess-"));
  } finally {
    cleanupEnv();
  }
});

test("registered subagent_done tool writes done and calls ctx.shutdown exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-done-tool-"));
  try {
    process.env.PI_SUBAGENT_COMPLETION_FILE = join(root, "done.json");
    process.env.PI_SUBAGENT_TOKEN = randomUUID();
    process.env.PI_SUBAGENT_ID = randomUUID();
    process.env.PI_SUBAGENT_SESSION = join(root, "worker.jsonl");
    const { api, handlers, tools } = makeApi();
    subagentDoneExtension(api);
    let shutdownCalls = 0;
    const ctx: any = {
      ui: { setWidget() {} },
      sessionManager: { getSessionId: () => "pi-sess-" + randomUUID() },
      model: { provider: "xai", id: "grok-4.6" },
      thinkingLevel: "high",
      shutdown() { shutdownCalls += 1; },
    };
    fireOnly(handlers, "session_start", {}, ctx);
    const result = await tools["subagent_done"].execute("tc1", {}, undefined, undefined, ctx);
    assert.equal(result.terminate, true);
    assert.equal(shutdownCalls, 1);
    const record = JSON.parse(readFileSync(process.env.PI_SUBAGENT_COMPLETION_FILE!, "utf8"));
    assert.equal(record.type, "done");
  } finally {
    cleanupEnv();
  }
});
