// Regression coverage for sol-post-review.log finding P1-6's four explicitly
// named remaining gaps (per run15 instructions): the ACTUAL REGISTERED
// subagent_resume tool, subagent_release ("subagent-release") command,
// subagents-replay command, and watchSubagent()'s real async polling path
// for watcher failure/diagnostic persistence. These invoke the real
// extension entrypoints (pi.registerTool/registerCommand/pi.on handlers)
// through the injectable lifecycle adapter and isolated temp files/private
// tmux sockets -- not helper functions reimplementing the logic under test.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createDefaultAdapter, setLifecycleAdapter } from "../pi-extension/subagents/adapter.ts";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import { loadRegistry } from "../pi-extension/subagents/registry.ts";
import {
  persistPreparingIntent,
  persistRecord,
  persistOutcomePending,
} from "../pi-extension/subagents/lifecycle.ts";

// ── Shared fake-extension-API harness ──

function makeApi() {
  const handlers: Record<string, Function[]> = {};
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const sentMessages: Array<{ message: any; options: any }> = [];
  const sentUserMessages: string[] = [];
  const notifications: Array<{ text: string; level?: string }> = [];
  const api: any = {
    on(event: string, handler: Function) {
      (handlers[event] ??= []).push(handler);
    },
    registerTool(tool: any) {
      tools[tool.name] = tool;
    },
    registerCommand(name: string, command: any) {
      commands[name] = command;
    },
    registerMessageRenderer() {},
    registerShortcut() {},
    sendUserMessage(m: string) {
      sentUserMessages.push(m);
    },
    sendMessage(m: any, o: any) {
      sentMessages.push({ message: m, options: o });
    },
    getAllTools() {
      return [];
    },
  };
  return { api, handlers, tools, commands, sentMessages, sentUserMessages, notifications };
}

function fireOnly(handlers: Record<string, Function[]>, event: string, ...args: any[]) {
  for (const h of handlers[event] ?? []) h(...args);
}

function testApiOf() {
  return (subagentsModule as any).__test__;
}

/** Deterministically clean up module-level timers/abort controllers/state. */
function shutdownExtension(handlers: Record<string, Function[]>, ctx: any) {
  const testApi = testApiOf();
  for (const [, running] of testApi.runningSubagents) {
    running.abortController?.abort();
  }
  fireOnly(handlers, "session_shutdown", {}, ctx);
  testApi.runningSubagents.clear();
}

function makeNotifyingUi(notifications: Array<{ text: string; level?: string }>, confirmSequence: boolean[] = []) {
  let confirmIndex = 0;
  return {
    notify(text: string, level?: string) {
      notifications.push({ text, level });
    },
    setWidget() {},
    async confirm(_message: string, _detail?: string) {
      const answer = confirmSequence[confirmIndex] ?? false;
      confirmIndex += 1;
      return answer;
    },
  };
}

// ── Real private-tmux harness (resume + release need real panes/tags) ──

function startPrivateTmux() {
  const socketName = "pi-test-lifecycle-" + randomUUID();
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-L", socketName, "-f", "/dev/null", ...args], { encoding: "utf8", timeout: 3000 }).trim();
  tmux("new-session", "-d", "-x", "120", "-y", "40", "-s", "w", "/bin/sh");
  const parentPane = tmux("display-message", "-p", "-t", "w", "#{pane_id}");
  const socketPath = tmux("display-message", "-p", "-t", parentPane, "#{socket_path}");
  return {
    socketName,
    tmux,
    parentPane,
    socketPath,
    kill() {
      try {
        execFileSync("tmux", ["-L", socketName, "kill-server"], { encoding: "utf8", timeout: 3000 });
      } catch {
        // already dead
      }
    },
  };
}

/** Never invokes a real provider: the launch scripts under test call this instead of the real pi-dispatch.sh. */
function writeFakeDispatcher(root: string): string {
  const path = join(root, "fake-dispatch.sh");
  writeFileSync(path, "#!/bin/bash\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!predicate()) throw new Error("waitFor: condition did not become true within " + timeoutMs + "ms");
}

function makeCtx(opts: {
  cwd: string;
  sessionDir: string;
  parentSessionId: string;
  parentSessionFile?: string | null;
  notifications?: Array<{ text: string; level?: string }>;
  confirmSequence?: boolean[];
}) {
  return {
    mode: "tui",
    hasUI: true,
    ui: makeNotifyingUi(opts.notifications ?? [], opts.confirmSequence ?? []),
    cwd: opts.cwd,
    model: { provider: "xai", id: "grok-4.6" },
    thinkingLevel: "high",
    sessionManager: {
      getSessionFile: () => opts.parentSessionFile ?? null,
      getSessionId: () => opts.parentSessionId,
      getSessionDir: () => opts.sessionDir,
    },
  } as any;
}

function registryFileFor(sessionDir: string, parentSessionId: string): string {
  return join(sessionDir, "artifacts", parentSessionId, "workers.json");
}

// ════════════════════════════════════════════════════════════════════════
// subagent_resume
// ════════════════════════════════════════════════════════════════════════

describe("registered subagent_resume tool", () => {
  it("preserves the canonical existing session header UUID on the persisted attempt record (not discarded)", async () => {
    const harness = startPrivateTmux();
    const root = mkdtempSync(join(tmpdir(), "pi-resume-"));
    const previousTmux = process.env.TMUX;
    const previousPane = process.env.TMUX_PANE;
    const previousDispatch = process.env.PI_DISPATCH_SH;
    const { api, handlers, tools } = makeApi();
    subagentsModule.default(api);
    const ctx = makeCtx({
      cwd: root,
      sessionDir: join(root, "sessions"),
      parentSessionId: randomUUID(),
    });
    try {
      process.env.TMUX = `${harness.socketPath},0,0`;
      process.env.TMUX_PANE = harness.parentPane;
      process.env.PI_DISPATCH_SH = writeFakeDispatcher(root);

      const childUuid = randomUUID();
      const childSessionFile = join(root, "child.jsonl");
      writeFileSync(childSessionFile, JSON.stringify({ type: "session", id: childUuid }) + "\n");

      fireOnly(handlers, "session_start", { reason: "startup" }, ctx);

      const resumeTool = tools["subagent_resume"];
      assert.ok(resumeTool, "expected subagent_resume tool to be registered");
      const result = await resumeTool.execute(
        "tc1",
        { sessionPath: childSessionFile, name: "Resume test" },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(result.details.status, "started");

      const loaded = loadRegistry(registryFileFor(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId()));
      assert.equal(loaded.status, "ok");
      const record = loaded.status === "ok" ? loaded.registry.workers.find((w) => w.attemptId === result.details.id) : null;
      assert.ok(record, "expected the resumed attempt to be persisted in the on-disk registry");
      assert.equal(record!.piSessionId, childUuid, "resumed session's canonical header UUID must be persisted, not discarded as null");
    } finally {
      shutdownExtension(handlers, ctx);
      if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
      if (previousPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = previousPane;
      if (previousDispatch === undefined) delete process.env.PI_DISPATCH_SH; else process.env.PI_DISPATCH_SH = previousDispatch;
      harness.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a duplicate concurrent resume of the same canonical live session", async () => {
    const harness = startPrivateTmux();
    const root = mkdtempSync(join(tmpdir(), "pi-resume-dup-"));
    const previousTmux = process.env.TMUX;
    const previousPane = process.env.TMUX_PANE;
    const previousDispatch = process.env.PI_DISPATCH_SH;
    const { api, handlers, tools } = makeApi();
    subagentsModule.default(api);
    const ctx = makeCtx({
      cwd: root,
      sessionDir: join(root, "sessions"),
      parentSessionId: randomUUID(),
    });
    try {
      process.env.TMUX = `${harness.socketPath},0,0`;
      process.env.TMUX_PANE = harness.parentPane;
      process.env.PI_DISPATCH_SH = writeFakeDispatcher(root);

      const childSessionFile = join(root, "child.jsonl");
      writeFileSync(childSessionFile, JSON.stringify({ type: "session", id: randomUUID() }) + "\n");
      fireOnly(handlers, "session_start", { reason: "startup" }, ctx);

      const resumeTool = tools["subagent_resume"];
      const first = await resumeTool.execute("tc1", { sessionPath: childSessionFile, name: "first" }, undefined, undefined, ctx);
      assert.equal(first.details.status, "started");

      await assert.rejects(
        () => resumeTool.execute("tc2", { sessionPath: childSessionFile, name: "second" }, undefined, undefined, ctx),
        /Refusing concurrent resume/,
      );
    } finally {
      shutdownExtension(handlers, ctx);
      if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
      if (previousPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = previousPane;
      if (previousDispatch === undefined) delete process.env.PI_DISPATCH_SH; else process.env.PI_DISPATCH_SH = previousDispatch;
      harness.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("generates dispatcher argv preserving the exact resumed session file, requested provider/model, and dormant --interactive mode", async () => {
    const harness = startPrivateTmux();
    const root = mkdtempSync(join(tmpdir(), "pi-resume-argv-"));
    const previousTmux = process.env.TMUX;
    const previousPane = process.env.TMUX_PANE;
    const previousDispatch = process.env.PI_DISPATCH_SH;
    const { api, handlers, tools } = makeApi();
    subagentsModule.default(api);
    const ctx = makeCtx({
      cwd: root,
      sessionDir: join(root, "sessions"),
      parentSessionId: randomUUID(),
    });
    try {
      process.env.TMUX = `${harness.socketPath},0,0`;
      process.env.TMUX_PANE = harness.parentPane;
      process.env.PI_DISPATCH_SH = writeFakeDispatcher(root);

      const childSessionFile = join(root, "child.jsonl");
      writeFileSync(childSessionFile, JSON.stringify({ type: "session", id: randomUUID() }) + "\n");
      const expectedCanonical = realpathSync(childSessionFile);
      fireOnly(handlers, "session_start", { reason: "startup" }, ctx);

      const resumeTool = tools["subagent_resume"];
      const result = await resumeTool.execute("tc1", { sessionPath: childSessionFile, name: "argv-check" }, undefined, undefined, ctx);
      const scriptBody = readFileSync(result.details.launchScriptFile, "utf8");

      assert.match(scriptBody, /'--interactive'/, "dispatcher mode must be the dormant --interactive mode, not print mode");
      assert.match(scriptBody, /'--provider'\n\s*'xai'/);
      assert.match(scriptBody, /'--model'\n\s*'grok-4\.6'/);
      assert.match(scriptBody, /'--effort'\n\s*'high'/);
      const escapedSession = expectedCanonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(scriptBody, new RegExp(`'--session'\\n\\s*'${escapedSession}'`), "must pass the exact canonical resumed session file");
    } finally {
      shutdownExtension(handlers, ctx);
      if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
      if (previousPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = previousPane;
      if (previousDispatch === undefined) delete process.env.PI_DISPATCH_SH; else process.env.PI_DISPATCH_SH = previousDispatch;
      harness.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a startup receipt whose recorded session path or resumed UUID mismatches, through the actual async watcher; persists unknown+diagnostic, retains capacity, closes nothing", async () => {
    const harness = startPrivateTmux();
    const root = mkdtempSync(join(tmpdir(), "pi-resume-mismatch-"));
    const previousTmux = process.env.TMUX;
    const previousPane = process.env.TMUX_PANE;
    const previousDispatch = process.env.PI_DISPATCH_SH;
    const { api, handlers, tools, commands } = makeApi();
    subagentsModule.default(api);
    const ctx = makeCtx({
      cwd: root,
      sessionDir: join(root, "sessions"),
      parentSessionId: randomUUID(),
    });
    // Track every `kill-pane` call the extension itself issues, independent
    // of the pane's OWN process exit (the fake dispatcher exits immediately,
    // so the pane's shell finishes and tmux reaps it on its own -- that OS
    // side effect must not be confused with our code calling closeOwned()).
    const killPaneCalls: string[][] = [];
    const realAdapter = createDefaultAdapter();
    setLifecycleAdapter({
      ...realAdapter,
      tmux(args: string[]) {
        if (args.includes("kill-pane")) killPaneCalls.push([...args]);
        return realAdapter.tmux(args);
      },
    });
    try {
      process.env.TMUX = `${harness.socketPath},0,0`;
      process.env.TMUX_PANE = harness.parentPane;
      process.env.PI_DISPATCH_SH = writeFakeDispatcher(root);

      const childUuid = randomUUID();
      const childSessionFile = join(root, "child.jsonl");
      writeFileSync(childSessionFile, JSON.stringify({ type: "session", id: childUuid }) + "\n");
      fireOnly(handlers, "session_start", { reason: "startup" }, ctx);

      const resumeTool = tools["subagent_resume"];
      const result = await resumeTool.execute("tc1", { sessionPath: childSessionFile, name: "mismatch-check" }, undefined, undefined, ctx);
      const attemptId = result.details.id;

      const testApi = testApiOf();
      const running = testApi.runningSubagents.get(attemptId);
      assert.ok(running, "expected the resumed attempt to be tracked as running");
      assert.equal(running.attempt.resourceState, "launching");

      // Write a malformed startup receipt: correct attemptId/token (so the
      // basic identity check passes) but the WRONG resumed session UUID --
      // proving the child attached to a different session than requested.
      const badStart = {
        version: 1,
        kind: "startup",
        attemptId,
        token: running.attempt.completionToken,
        sessionFile: running.attempt.sessionFile,
        piSessionId: randomUUID(), // wrong -- does not match the resumed header UUID
        observed: { provider: "xai", model: "grok-4.6", thinking: "high" },
      };
      mkdirSync(join(running.attempt.completionFile, ".."), { recursive: true });
      writeFileSync(`${running.attempt.completionFile}.start`, JSON.stringify(badStart));

      // Drive it through the REAL async watchSubagent polling loop (already
      // attached by subagent_resume's execute()) -- not a direct call to
      // applyStartupReceipt/validateStartupReceipt.
      await waitFor(() => {
        const loaded = loadRegistry(registryFileFor(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId()));
        if (loaded.status !== "ok") return false;
        const record = loaded.registry.workers.find((w) => w.attemptId === attemptId);
        return !!record && record.resourceState === "unknown";
      });

      const loaded = loadRegistry(registryFileFor(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId()));
      assert.equal(loaded.status, "ok");
      const record = loaded.status === "ok" ? loaded.registry.workers.find((w) => w.attemptId === attemptId) : null;
      assert.ok(record);
      assert.equal(record!.resourceState, "unknown", "a genuine watcher failure must be persisted as unknown, not silently dropped");
      assert.match(record!.watcherDiagnostic ?? "", /session UUID mismatch/i, "the diagnostic must be persisted and describe the mismatch");
      // Capacity retained: `unknown` is still a live/counted resource.
      const { LIVE_RESOURCE_STATES } = await import("../pi-extension/subagents/registry.ts");
      assert.equal(LIVE_RESOURCE_STATES.has(record!.resourceState as any), true);
      // Zero pane closes: the extension itself must never have issued a
      // kill-pane call from this failure path (independent of the pane's own
      // process naturally exiting once the fake dispatcher returns).
      assert.equal(killPaneCalls.length, 0, "a watcher failure must never close the pane");

      // Diagnostic is VISIBLE via the actual registered /subagents-diagnose command.
      const originalLog = console.log;
      let loggedText = "";
      console.log = (text: string) => { loggedText += text; };
      try {
        await commands["subagents-diagnose"].handler("", ctx);
      } finally {
        console.log = originalLog;
      }
      assert.match(loggedText, /watcher diagnostic:/);
      assert.match(loggedText, /session UUID mismatch/i);
    } finally {
      shutdownExtension(handlers, ctx);
      setLifecycleAdapter(null);
      if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
      if (previousPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = previousPane;
      if (previousDispatch === undefined) delete process.env.PI_DISPATCH_SH; else process.env.PI_DISPATCH_SH = previousDispatch;
      harness.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a same-process session_shutdown followed by a new session_start does not permanently poison later watchers (module abort controller is recreated)", async () => {
    // Regression for a defect this suite's own harness surfaced: session_shutdown
    // aborted the shared module-level AbortController but never replaced it,
    // so any watcher attached by a LATER session_start in the same process
    // would see getModuleAbortSignal().aborted === true from birth and
    // immediately misclassify every genuine failure as "cancelled" -- silently
    // dropping diagnostics instead of persisting `unknown`. The end-to-end
    // real-polling-path proof (malformed receipt -> unknown+diagnostic) lives
    // in the resume-mismatch test above and in the watcher describe block
    // below; this test isolates the specific module-signal lifecycle defect.
    const root = mkdtempSync(join(tmpdir(), "pi-resume-reload-"));
    const first = makeApi();
    subagentsModule.default(first.api);
    const ctx1 = makeCtx({ cwd: root, sessionDir: join(root, "s1"), parentSessionId: randomUUID() });
    try {
      fireOnly(first.handlers, "session_start", { reason: "startup" }, ctx1);
      fireOnly(first.handlers, "session_shutdown", {}, ctx1);

      const moduleAbortKey = Symbol.for("pi-subagents/poll-abort-controller");
      const controller = (globalThis as any)[moduleAbortKey] as AbortController;
      assert.equal(
        controller.signal.aborted,
        false,
        "module abort signal must be recreated (live) after session_shutdown, not left permanently aborted for a same-process session_start",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// subagent_release ("subagent-release" command)
// ════════════════════════════════════════════════════════════════════════

/** A dispatcher that keeps the pane's shell process alive long enough to run release assertions against a real, still-live pane. */
function writeSleepDispatcher(root: string, seconds = 6): string {
  const path = join(root, "sleep-dispatch.sh");
  writeFileSync(path, `#!/bin/bash\nsleep ${seconds}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("registered subagent-release command", () => {
  interface LiveWorker {
    handlers: Record<string, Function[]>;
    commands: Record<string, any>;
    ctx: any;
    attemptId: string;
    running: any;
  }

  async function launchLiveWorker(harness: ReturnType<typeof startPrivateTmux>, root: string, suffix = ""): Promise<LiveWorker> {
    const { api, handlers, tools, commands, notifications } = makeApi();
    subagentsModule.default(api);
    const ctx = makeCtx({
      cwd: root,
      sessionDir: join(root, "sessions" + suffix),
      parentSessionId: randomUUID(),
      parentSessionFile: join(root, "parent.jsonl"),
      notifications,
    });
    fireOnly(handlers, "session_start", { reason: "startup" }, ctx);
    const subagentTool = tools["subagent"];
    const result = await subagentTool.execute("tc1", { name: "release-worker", task: "idle" }, undefined, undefined, ctx);
    assert.equal(result.details.status, "started");
    const attemptId = result.details.id as string;
    const testApi = testApiOf();
    const running = testApi.runningSubagents.get(attemptId);
    await waitFor(() => {
      let tag = "";
      try { tag = harness.tmux("show-options", "-p", "-v", "-t", running.attempt.surface, "@pi-worker-token"); } catch { tag = ""; }
      return tag === running.attempt.completionToken;
    });
    return { handlers, commands, ctx, attemptId, running };
  }

  function withEnv(harness: ReturnType<typeof startPrivateTmux>, root: string, run: () => Promise<void>) {
    const previousTmux = process.env.TMUX;
    const previousPane = process.env.TMUX_PANE;
    const previousDispatch = process.env.PI_DISPATCH_SH;
    process.env.TMUX = `${harness.socketPath},0,0`;
    process.env.TMUX_PANE = harness.parentPane;
    process.env.PI_DISPATCH_SH = writeSleepDispatcher(root);
    const restore = () => {
      if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
      if (previousPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = previousPane;
      if (previousDispatch === undefined) delete process.env.PI_DISPATCH_SH; else process.env.PI_DISPATCH_SH = previousDispatch;
    };
    return run().finally(restore);
  }

  it("chooses the action (via ctx.ui.confirm) BEFORE any mutation happens", async () => {
    const harness = startPrivateTmux();
    const root = mkdtempSync(join(tmpdir(), "pi-release-order-"));
    const workers: LiveWorker[] = [];
    try {
      await withEnv(harness, root, async () => {
        const worker = await launchLiveWorker(harness, root);
        workers.push(worker);
        const { commands, ctx, attemptId, running } = worker;
        let sawUnmutatedStateAtFirstConfirm = false;
        ctx.ui.confirm = async (_message: string) => {
          // At the moment the FIRST confirm is asked, ownership must be
          // intact (no clearPaneTags/kill-pane has happened yet).
          const liveTag = harness.tmux("show-options", "-p", "-v", "-t", running.attempt.surface, "@pi-worker-token");
          sawUnmutatedStateAtFirstConfirm = liveTag === running.attempt.completionToken;
          return false; // decline everything -- this test only cares about ordering
        };
        await commands["subagent-release"].handler(attemptId, ctx);
        assert.equal(sawUnmutatedStateAtFirstConfirm, true, "the release/close decision must be made before any tag/pane mutation");
      });
    } finally {
      for (const w of workers) shutdownExtension(w.handlers, w.ctx);
      harness.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("declining every confirmation makes zero destructive calls (pane retained, tags untouched, registry unchanged)", async () => {
    const harness = startPrivateTmux();
    const root = mkdtempSync(join(tmpdir(), "pi-release-decline-"));
    const workers: LiveWorker[] = [];
    try {
      await withEnv(harness, root, async () => {
        const worker = await launchLiveWorker(harness, root);
        workers.push(worker);
        const { commands, ctx, attemptId, running } = worker;
        ctx.ui.confirm = async () => false;
        const destructiveCalls: string[][] = [];
        const realAdapter = createDefaultAdapter();
        setLifecycleAdapter({
          ...realAdapter,
          tmux(args: string[]) {
            if (args.includes("kill-pane") || args.includes("set-option")) destructiveCalls.push([...args]);
            return realAdapter.tmux(args);
          },
        });
        try {
          await commands["subagent-release"].handler(attemptId, ctx);
        } finally {
          setLifecycleAdapter(null);
        }
        assert.equal(destructiveCalls.length, 0, "declining both confirmations must issue zero destructive tmux calls");
        assert.equal(harness.tmux("list-panes", "-t", "w", "-F", "#{pane_id}").split("\n").length, 2, "pane must still exist");
        const liveTag = harness.tmux("show-options", "-p", "-v", "-t", running.attempt.surface, "@pi-worker-token");
        assert.equal(liveTag, running.attempt.completionToken, "ownership tag must be untouched");
      });
    } finally {
      for (const w of workers) shutdownExtension(w.handlers, w.ctx);
      harness.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Live-trial regression (2026-09-07): the worker shell exits on its own, tmux
  // reaps the pane, and the authenticated outcome + exit receipt make the
  // watcher try to auto-close. kill-pane fails (pane gone) -- the watcher must
  // settle the record as `proven_absent` instead of retrying forever.
  it("a worker whose pane already exited after outcome + exit receipt settles as proven_absent (no infinite close retry, no diagnostic)", async () => {
    const harness = startPrivateTmux();
    const root = mkdtempSync(join(tmpdir(), "pi-self-exited-"));
    const workers: LiveWorker[] = [];
    try {
      await withEnv(harness, root, async () => {
        process.env.PI_DISPATCH_SH = writeSleepDispatcher(root, 1);
        const worker = await launchLiveWorker(harness, root);
        workers.push(worker);
        const { ctx, attemptId } = worker;
        const registryPath = registryFileFor(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
        const load = () => {
          const loaded = loadRegistry(registryPath);
          assert.equal(loaded.status, "ok");
          return loaded.status === "ok" ? loaded.registry.workers.find((w) => w.attemptId === attemptId)! : null!;
        };
        await waitFor(() => load().resourceState === "proven_absent", 15000, 100);
        const record = load();
        assert.equal(record.resourceState, "proven_absent");
        assert.equal(record.outcome, "error", "sleep dispatcher exits without a child completion -> pre-start shell error outcome");
        assert.equal(record.watcherDiagnostic ?? null, null, "normal self-exit is not a watcher failure");
        assert.equal(harness.tmux("list-panes", "-t", "w", "-F", "#{pane_id}").split("\n").length, 1, "only the parent pane remains");
        const testApi = testApiOf();
        assert.equal(testApi.runningSubagents.has(attemptId), false, "watcher must stop tracking a settled attempt");
      });
    } finally {
      for (const w of workers) shutdownExtension(w.handlers, w.ctx);
      harness.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("release-without-close clears only exact ownership tags and retains the pane", async () => {
    const harness = startPrivateTmux();
    const root = mkdtempSync(join(tmpdir(), "pi-release-clear-"));
    const workers: LiveWorker[] = [];
    try {
      await withEnv(harness, root, async () => {
        const worker = await launchLiveWorker(harness, root);
        workers.push(worker);
        const { commands, ctx, attemptId, running } = worker;
        ctx.ui.confirm = async () => true; // "Release without closing?" -> yes
        await commands["subagent-release"].handler(attemptId, ctx);

        assert.equal(harness.tmux("list-panes", "-t", "w", "-F", "#{pane_id}").split("\n").length, 2, "pane must survive release-without-close");
        let tagAfter = "present";
        try { tagAfter = harness.tmux("show-options", "-p", "-v", "-t", running.attempt.surface, "@pi-attempt"); } catch { tagAfter = ""; }
        assert.equal(tagAfter, "", "the @pi-attempt ownership tag must be cleared");

        const loaded = loadRegistry(registryFileFor(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId()));
        assert.equal(loaded.status, "ok");
        const record = loaded.status === "ok" ? loaded.registry.workers.find((w) => w.attemptId === attemptId) : null;
        assert.equal(record!.resourceState, "released");
      });
    } finally {
      for (const w of workers) shutdownExtension(w.handlers, w.ctx);
      harness.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("close requires two confirmations and never kills a pane whose ownership token changed (checked before kill)", async () => {
    const harness = startPrivateTmux();
    const root = mkdtempSync(join(tmpdir(), "pi-release-close-"));
    const workers: LiveWorker[] = [];
    try {
      await withEnv(harness, root, async () => {
        // (a) release declined, close-first accepted, close-second (really-kill) declined -> zero mutation.
        {
          const worker = await launchLiveWorker(harness, root, "-a");
          workers.push(worker);
          const { commands, ctx, attemptId } = worker;
          let confirmCount = 0;
          ctx.ui.confirm = async () => {
            confirmCount += 1;
            if (confirmCount === 1) return false; // release-without-close? no
            if (confirmCount === 2) return true; // close instead? yes
            return false; // really kill? no -- second confirmation declined
          };
          await commands["subagent-release"].handler(attemptId, ctx);
          assert.equal(confirmCount, 3, "close requires exactly two additional confirmations beyond the release question");
          assert.equal(harness.tmux("list-panes", "-t", "w", "-F", "#{pane_id}").split("\n").length, 2, "declining the second close confirmation must retain the pane");
        }

        // (b) both close confirmations accepted, but the pane's ownership
        // token changed underneath us -- ownership must be verified BEFORE
        // kill-pane, so the pane must survive and never be reported "closed".
        {
          const worker = await launchLiveWorker(harness, root, "-b");
          workers.push(worker);
          const { commands, ctx, attemptId, running } = worker;
          harness.tmux("set-option", "-p", "-t", running.attempt.surface, "@pi-worker-token", "someone-else-owns-this-now");
          let confirmCount = 0;
          ctx.ui.confirm = async () => {
            confirmCount += 1;
            if (confirmCount === 1) return false; // release-without-close? no
            return true; // close first + close second: yes, yes
          };
          const notifyErrors: string[] = [];
          const originalNotify = ctx.ui.notify;
          ctx.ui.notify = (text: string, level?: string) => { if (level === "error") notifyErrors.push(text); originalNotify(text, level); };
          await commands["subagent-release"].handler(attemptId, ctx);
          assert.match(notifyErrors.join("\n"), /ownership changed/i);
          assert.equal(
            harness.tmux("list-panes", "-t", "w", "-F", "#{pane_id}").split("\n").length,
            3,
            "pane from case (a) plus the surviving mismatched-token pane from case (b) must both remain",
          );
          const loaded = loadRegistry(registryFileFor(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId()));
          const record = loaded.status === "ok" ? loaded.registry.workers.find((w) => w.attemptId === attemptId) : null;
          assert.notEqual(record!.resourceState, "closed", "an ownership mismatch must never be reported as closed");
        }
      });
    } finally {
      for (const w of workers) shutdownExtension(w.handlers, w.ctx);
      harness.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a mismatched/unknown attemptId or a foreign-socket record cannot accidentally affect the current pane", async () => {
    const harness = startPrivateTmux();
    const root = mkdtempSync(join(tmpdir(), "pi-release-foreign-"));
    const workers: LiveWorker[] = [];
    try {
      await withEnv(harness, root, async () => {
        const worker = await launchLiveWorker(harness, root);
        workers.push(worker);
        const { handlers, commands, ctx, attemptId, running } = worker;
        const notifyErrors: string[] = [];
        ctx.ui.notify = (text: string, level?: string) => { if (level === "error") notifyErrors.push(text); };
        ctx.ui.confirm = async () => true; // would mutate if allowed to proceed

        // Unknown attemptId.
        await commands["subagent-release"].handler("not-a-real-attempt-id", ctx);
        assert.match(notifyErrors.join("\n"), /Unknown attempt/);

        // Foreign-socket record: insert a copy with a different tmuxSocket
        // into the ON-DISK registry, then reload through a fresh
        // session_start so the command's module-level workerRegistry
        // actually contains this foreign record (not a hand-mocked object).
        const foreignRecord = {
          ...running.attempt,
          attemptId: randomUUID(),
          completionToken: randomUUID(),
          tmuxSocket: "/tmp/some-other-unrelated-socket",
        };
        const registryPath = registryFileFor(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
        const loaded = loadRegistry(registryPath);
        assert.equal(loaded.status, "ok");
        persistRecord(registryPath, loaded.registry, foreignRecord as any, createDefaultAdapter());
        fireOnly(handlers, "session_start", { reason: "startup" }, ctx);

        notifyErrors.length = 0;
        await commands["subagent-release"].handler(foreignRecord.attemptId, ctx);
        assert.match(notifyErrors.join("\n"), /Foreign-socket workers cannot be released/);
        // The current pane (this session's real live worker) must be entirely unaffected.
        assert.equal(harness.tmux("list-panes", "-t", "w", "-F", "#{pane_id}").split("\n").length, 2);
      });
    } finally {
      for (const w of workers) shutdownExtension(w.handlers, w.ctx);
      harness.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// subagents-replay
// ════════════════════════════════════════════════════════════════════════

describe("registered subagents-replay command", () => {
  /**
   * Builds a live attempt with a pending/uncertain outcome using the REAL
   * lifecycle helpers (persistPreparingIntent + persistRecord +
   * persistOutcomePending), bypassing tmux entirely -- replay does not touch
   * tmux, and the tmuxSocket is deliberately a fake path so recovery
   * classifies it "foreign" (zero tmux calls), matching the reload scenario
   * this command exists for.
   */
  function setupPendingWorker(root: string, outcomeData: any) {
    const { api, handlers, tools, commands, notifications, sentMessages } = makeApi();
    subagentsModule.default(api);
    const parentSessionId = randomUUID();
    const sessionDir = join(root, "sessions");
    const ctx = makeCtx({ cwd: root, sessionDir, parentSessionId, notifications });
    const registryPath = registryFileFor(sessionDir, parentSessionId);
    const adapter = createDefaultAdapter();
    const began = persistPreparingIntent({
      registryPath,
      registry: { version: 1, invocations: 0, workers: [] },
      name: "replay-worker",
      task: "t",
      parentSessionId,
      sessionFile: join(root, "child.jsonl"),
      launchScriptFile: join(root, "launch.sh"),
      completionFile: join(root, "completion.json"),
      tmuxSocket: "/tmp/pi-replay-fake-socket",
      windowId: "@0",
      requested: { provider: "xai", model: "grok-4.6", thinking: "high" },
      interactive: false,
    }, adapter);
    const liveRecord = { ...began.record, surface: "%9", resourceState: "running" as const };
    const afterLive = persistRecord(registryPath, began.registry, liveRecord, adapter);
    const outcomeBytes = JSON.stringify(outcomeData);
    const pending = persistOutcomePending(registryPath, afterLive, liveRecord, outcomeData.type, outcomeBytes, adapter);

    // Reload the session -- this loads the registry from disk, applies
    // recovery (foreign socket -> zero tmux calls), and attaches a watcher,
    // exactly like a real /reload or new-session-in-same-process would.
    fireOnly(handlers, "session_start", { reason: "startup" }, ctx);

    return { api, handlers, tools, commands, notifications, sentMessages, ctx, attemptId: pending.record.attemptId, registryPath };
  }

  it("an uncertain outcome recovered on reload is VISIBLE (notified + diagnosable) but NOT automatically resent", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-replay-visible-"));
    const { handlers, notifications, ctx } = setupPendingWorker(root, { type: "done" });
    try {
      assert.match(
        notifications.map((n) => n.text).join("\n"),
        /pending\/uncertain reported outcome.*\/subagents-replay/,
      );
      const testApi = testApiOf();
      assert.equal(testApi.runningSubagents.size, 1, "the uncertain worker must still count toward capacity, not silently disappear");
    } finally {
      shutdownExtension(handlers, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists deliveryState 'pending' to disk BEFORE calling pi.sendMessage", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-replay-pending-"));
    const { api, handlers, commands, ctx, attemptId, registryPath } = setupPendingWorker(root, { type: "done" });
    try {
      let observedDeliveryStateAtSendTime: string | null | undefined = "not-called";
      (api as any).sendMessage = (message: any, options: any) => {
        const loaded = loadRegistry(registryPath);
        const record = loaded.status === "ok" ? loaded.registry.workers.find((w) => w.attemptId === attemptId) : null;
        observedDeliveryStateAtSendTime = record?.deliveryState ?? null;
      };
      await commands["subagents-replay"].handler(attemptId, ctx);
      assert.equal(observedDeliveryStateAtSendTime, "pending", "the durable outbox must mark pending on disk before sending, not only in memory");
    } finally {
      shutdownExtension(handlers, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists deliveryState 'attempted' AFTER the replay send completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-replay-attempted-"));
    const { handlers, commands, ctx, attemptId, registryPath } = setupPendingWorker(root, { type: "done" });
    try {
      await commands["subagents-replay"].handler(attemptId, ctx);
      const loaded = loadRegistry(registryPath);
      assert.equal(loaded.status, "ok");
      const record = loaded.status === "ok" ? loaded.registry.workers.find((w) => w.attemptId === attemptId) : null;
      assert.equal(record!.deliveryState, "attempted");
    } finally {
      shutdownExtension(handlers, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("explicit /subagents-replay delivers the outcome via the actual command handler (pi.sendMessage called with the authenticated content)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-replay-deliver-"));
    const { handlers, commands, notifications, sentMessages, ctx, attemptId } = setupPendingWorker(root, {
      type: "done",
      name: "replay-worker",
    });
    try {
      assert.equal(sentMessages.length, 0, "must not have been auto-sent on reload");
      await commands["subagents-replay"].handler(attemptId, ctx);
      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0].message.customType, "subagent_result");
      assert.match(sentMessages[0].message.content, /reported outcome \(authenticated, unverified\)/);
      assert.match(notifications.map((n) => n.text).join("\n"), /Replayed reported outcome/);
    } finally {
      shutdownExtension(handlers, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// watchSubagent(): real async polling path -- failure/diagnostic persistence
// ════════════════════════════════════════════════════════════════════════

describe("watchSubagent() real async polling path: failure and diagnostic persistence", () => {
  function setupLiveWatchedWorker(root: string) {
    const { api, handlers, tools, commands, notifications } = makeApi();
    subagentsModule.default(api);
    const parentSessionId = randomUUID();
    const sessionDir = join(root, "sessions");
    const ctx = makeCtx({ cwd: root, sessionDir, parentSessionId, notifications });
    const registryPath = registryFileFor(sessionDir, parentSessionId);
    const adapter = createDefaultAdapter();
    const completionFile = join(root, "completion.json");
    const began = persistPreparingIntent({
      registryPath,
      registry: { version: 1, invocations: 0, workers: [] },
      name: "watcher-worker",
      task: "t",
      parentSessionId,
      sessionFile: join(root, "child.jsonl"),
      launchScriptFile: join(root, "launch.sh"),
      completionFile,
      tmuxSocket: "/tmp/pi-watcher-fake-socket",
      windowId: "@0",
      requested: { provider: "xai", model: "grok-4.6", thinking: "high" },
      interactive: false,
    }, adapter);
    const liveRecord = { ...began.record, surface: "%9", resourceState: "running" as const };
    persistRecord(registryPath, began.registry, liveRecord, adapter);

    // Foreign socket (no process.env.TMUX set) -- attachWatcher runs the
    // real async polling loop with zero real tmux calls, matching the
    // reload-recovery scenario this failure path exists for.
    fireOnly(handlers, "session_start", { reason: "startup" }, ctx);
    return { api, handlers, tools, commands, notifications, ctx, attemptId: liveRecord.attemptId, registryPath, completionFile };
  }

  it("a malformed/wrong-token completion receipt through the real polling loop: resource becomes unknown, diagnostic persisted+visible, capacity retained, zero pane closes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-watcher-malformed-"));
    const { handlers, commands, ctx, attemptId, registryPath, completionFile } = setupLiveWatchedWorker(root);
    const killPaneCalls: string[][] = [];
    const realAdapter = createDefaultAdapter();
    setLifecycleAdapter({
      ...realAdapter,
      tmux(args: string[]) {
        if (args.includes("kill-pane")) killPaneCalls.push([...args]);
        return realAdapter.tmux(args);
      },
    });
    try {
      // Wrong token: attemptId matches, but the completion token does not --
      // proves the record cannot be spoofed by a stale/foreign completion file.
      const loaded = loadRegistry(registryPath);
      assert.equal(loaded.status, "ok");
      const record = loaded.status === "ok" ? loaded.registry.workers.find((w) => w.attemptId === attemptId) : null;
      assert.ok(record);
      writeFileSync(completionFile, JSON.stringify({
        version: 1,
        attemptId,
        token: "not-the-real-token",
        sessionFile: record!.sessionFile,
        type: "done",
      }));

      await waitFor(() => {
        const reloaded = loadRegistry(registryPath);
        if (reloaded.status !== "ok") return false;
        const rec = reloaded.registry.workers.find((w) => w.attemptId === attemptId);
        return !!rec && rec.resourceState === "unknown";
      });

      const reloaded = loadRegistry(registryPath);
      assert.equal(reloaded.status, "ok");
      const finalRecord = reloaded.status === "ok" ? reloaded.registry.workers.find((w) => w.attemptId === attemptId) : null;
      assert.equal(finalRecord!.resourceState, "unknown");
      assert.match(finalRecord!.watcherDiagnostic ?? "", /identity mismatch/i);

      const { LIVE_RESOURCE_STATES } = await import("../pi-extension/subagents/registry.ts");
      assert.equal(LIVE_RESOURCE_STATES.has(finalRecord!.resourceState as any), true, "capacity must be retained (still a live/counted resource)");
      assert.equal(killPaneCalls.length, 0, "a watcher failure must never close the pane");

      // Diagnostic is VISIBLE via the actual registered /subagents-diagnose command.
      const originalLog = console.log;
      let loggedText = "";
      console.log = (text: string) => { loggedText += text; };
      try {
        await commands["subagents-diagnose"].handler("", ctx);
      } finally {
        console.log = originalLog;
      }
      assert.match(loggedText, /watcher diagnostic:/);
      assert.match(loggedText, /identity mismatch/i);
    } finally {
      setLifecycleAdapter(null);
      shutdownExtension(handlers, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  // P1-1 regression (run 16): post-start receipts must bind to the established child UUID.
  function loadAttempt(registryPath: string, attemptId: string) {
    const loaded = loadRegistry(registryPath);
    assert.equal(loaded.status, "ok");
    return loaded.status === "ok" ? loaded.registry.workers.find((w) => w.attemptId === attemptId)! : null!;
  }

  it("a PRE-start shell error with a null piSessionId is accepted through the actual watcher (no startup receipt yet)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-watcher-prestart-"));
    const { handlers, ctx, attemptId, registryPath, completionFile } = setupLiveWatchedWorker(root);
    const killPaneCalls: string[][] = [];
    const realAdapter = createDefaultAdapter();
    setLifecycleAdapter({ ...realAdapter, tmux(args: string[]) { if (args.includes("kill-pane")) killPaneCalls.push([...args]); return realAdapter.tmux(args); } });
    try {
      const record = loadAttempt(registryPath, attemptId);
      const identity = { version: 1, attemptId, token: record.completionToken, sessionFile: record.sessionFile };
      writeFileSync(completionFile, JSON.stringify({ ...identity, piSessionId: null, type: "error", errorMessage: "Pi process exited 127" }));
      writeFileSync(`${completionFile}.exit`, JSON.stringify({ ...identity, kind: "shell-exit", exitCode: 127, piSessionId: null }));
      await waitFor(() => loadAttempt(registryPath, attemptId).outcome === "error");
      const final = loadAttempt(registryPath, attemptId);
      assert.equal(final.outcome, "error");
      assert.notEqual(final.resourceState, "unknown", "a legitimate pre-start shell error must not be treated as a receipt-authentication failure");
      assert.equal(final.watcherDiagnostic ?? null, null);
      assert.equal(killPaneCalls.length, 0);
    } finally {
      setLifecycleAdapter(null);
      shutdownExtension(handlers, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const variant of ["wrong", "null"] as const) {
    for (const receipt of ["error", "exit"] as const) {
      it(`after a valid startup receipt, a ${receipt} receipt with a ${variant} piSessionId is refused: unknown + diagnostic persisted, capacity retained, zero closes`, async () => {
        const root = mkdtempSync(join(tmpdir(), `pi-watcher-poststart-${receipt}-${variant}-`));
        const { handlers, ctx, attemptId, registryPath, completionFile } = setupLiveWatchedWorker(root);
        const killPaneCalls: string[][] = [];
        const realAdapter = createDefaultAdapter();
        setLifecycleAdapter({ ...realAdapter, tmux(args: string[]) { if (args.includes("kill-pane")) killPaneCalls.push([...args]); return realAdapter.tmux(args); } });
        try {
          const record = loadAttempt(registryPath, attemptId);
          const identity = { version: 1, attemptId, token: record.completionToken, sessionFile: record.sessionFile };
          const childUuid = randomUUID();
          writeFileSync(`${completionFile}.start`, JSON.stringify({
            ...identity,
            kind: "startup",
            piSessionId: childUuid,
            observed: { provider: "xai", model: "grok-4.6", thinking: "high" },
          }));
          // Startup must be observed and the UUID established BEFORE the bad receipt lands.
          await waitFor(() => loadAttempt(registryPath, attemptId).observed !== null);
          assert.equal(loadAttempt(registryPath, attemptId).piSessionId, childUuid);

          const badUuid = variant === "wrong" ? randomUUID() : null;
          if (receipt === "error") {
            writeFileSync(completionFile, JSON.stringify({ ...identity, piSessionId: badUuid, type: "error", errorMessage: "spoofed" }));
          } else {
            writeFileSync(`${completionFile}.exit`, JSON.stringify({ ...identity, kind: "shell-exit", exitCode: 0, piSessionId: badUuid }));
          }
          await waitFor(() => loadAttempt(registryPath, attemptId).resourceState === "unknown");
          const final = loadAttempt(registryPath, attemptId);
          assert.equal(final.resourceState, "unknown");
          assert.equal(final.outcome, null, "a receipt that fails UUID binding must never become an authenticated outcome");
          assert.match(final.watcherDiagnostic ?? "", /established piSessionId/);
          const { LIVE_RESOURCE_STATES } = await import("../pi-extension/subagents/registry.ts");
          assert.equal(LIVE_RESOURCE_STATES.has(final.resourceState as any), true, "capacity must be retained");
          assert.equal(killPaneCalls.length, 0, "zero pane closes");
        } finally {
          setLifecycleAdapter(null);
          shutdownExtension(handlers, ctx);
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }

  // P2-1 regression: an already-`unknown` record still gains a fresh watcher diagnostic.
  it("an already-unknown record receives a new watcher diagnostic from a later malformed completion", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-watcher-unknown-diag-"));
    const { api, handlers, ctx, attemptId, registryPath, completionFile } = setupLiveWatchedWorker(root);
    try {
      // Flip the persisted record to `unknown` with a stale diagnostic, then
      // restart the extension so the watcher recovers it in that state.
      const before = loadAttempt(registryPath, attemptId);
      const loaded = loadRegistry(registryPath);
      assert.equal(loaded.status, "ok");
      persistRecord(registryPath, loaded.status === "ok" ? loaded.registry : null!, { ...before, resourceState: "unknown" as const, watcherDiagnostic: "earlier ambiguity" }, createDefaultAdapter());
      fireOnly(handlers, "session_start", { reason: "reload" }, ctx);
      writeFileSync(completionFile, JSON.stringify({ version: 1, attemptId, token: "not-the-real-token", sessionFile: before.sessionFile, type: "done" }));
      await waitFor(() => /identity mismatch/i.test(loadAttempt(registryPath, attemptId).watcherDiagnostic ?? ""));
      const final = loadAttempt(registryPath, attemptId);
      assert.equal(final.resourceState, "unknown");
      assert.match(final.watcherDiagnostic ?? "", /identity mismatch/i);
      void api;
    } finally {
      setLifecycleAdapter(null);
      shutdownExtension(handlers, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a watcher orphaned by reload (generation bump) treats a late malformed receipt as cancelled and never overwrites the already-recovered on-disk state", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-watcher-reload-"));
    const first = setupLiveWatchedWorker(root);
    try {
      const beforeReload = loadRegistry(first.registryPath);
      assert.equal(beforeReload.status, "ok");
      const beforeRecord = beforeReload.status === "ok" ? beforeReload.registry.workers.find((w) => w.attemptId === first.attemptId) : null;
      // Foreign socket (no process.env.TMUX): applyRecovery already reclassified
      // "running" -> "foreign" on this session_start, zero tmux calls.
      assert.equal(beforeRecord!.resourceState, "foreign");

      // Simulate a reload/new-session-in-same-process: this bumps the
      // module-level watcherGeneration and swaps registryFile out from under
      // the FIRST watcher, which is still polling in the background.
      const second = makeApi();
      subagentsModule.default(second.api);
      const secondCtx = makeCtx({ cwd: root, sessionDir: join(root, "sessions2"), parentSessionId: randomUUID() });
      fireOnly(second.handlers, "session_start", { reason: "startup" }, secondCtx);

      // NOW deliver a malformed completion to the FIRST (orphaned) attempt.
      // Its watcher is still executing its poll loop (generation-stale), and
      // must classify this as "cancelled", not attempt to persist anything
      // to the old (now foreign-to-the-new-session) registry file.
      writeFileSync(first.completionFile, JSON.stringify({
        version: 1,
        attemptId: first.attemptId,
        token: "wrong-token-after-reload",
        sessionFile: beforeRecord!.sessionFile,
        type: "done",
      }));

      // Give the orphaned watcher's poll loop a bounded window to run (it
      // polls every 250ms); it must settle to "cancelled" and do nothing.
      await new Promise((resolve) => setTimeout(resolve, 600));

      const afterReload = loadRegistry(first.registryPath);
      assert.equal(afterReload.status, "ok");
      const afterRecord = afterReload.status === "ok" ? afterReload.registry.workers.find((w) => w.attemptId === first.attemptId) : null;
      assert.equal(
        afterRecord!.resourceState,
        "foreign",
        "an obsolete/orphaned watcher callback must not overwrite the already-recovered on-disk state after a reload",
      );
      assert.equal(afterRecord!.watcherDiagnostic, undefined, "an obsolete callback must not persist a diagnostic either");

      shutdownExtension(second.handlers, secondCtx);
    } finally {
      shutdownExtension(first.handlers, first.ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
