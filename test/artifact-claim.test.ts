import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createDefaultAdapter, setLifecycleAdapter } from "../pi-extension/subagents/adapter.ts";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { loadRegistry } from "../pi-extension/subagents/registry.ts";
import {
  attemptScopedPath,
  canonicalizeArtifactPath,
  guardReservedArtifactWrite,
  reservationMarkerPath,
  reserveArtifactPath,
} from "../pi-extension/subagents/artifact-claim.ts";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

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
    registerCommand() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    sendUserMessage() {},
    sendMessage() {},
    getAllTools() {
      return [];
    },
  };
  return { api, handlers, tools };
}

function fireOnly(handlers: Record<string, Function[]>, event: string, ...args: any[]) {
  for (const h of handlers[event] ?? []) h(...args);
}

function startPrivateTmux() {
  const socketName = "pi-test-artifact-" + randomUUID();
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

function writeFakeDispatcher(root: string): string {
  const path = join(root, "fake-dispatch.sh");
  writeFileSync(path, "#!/bin/bash\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

function makeCtx(opts: {
  cwd: string;
  sessionDir: string;
  parentSessionId: string;
  parentSessionFile: string;
}) {
  return {
    mode: "tui",
    hasUI: true,
    ui: { notify() {}, setWidget() {}, confirm: async () => false },
    cwd: opts.cwd,
    model: { provider: "xai", id: "grok-4.6" },
    thinkingLevel: "high",
    sessionManager: {
      getSessionFile: () => opts.parentSessionFile,
      getSessionId: () => opts.parentSessionId,
      getSessionDir: () => opts.sessionDir,
    },
  } as any;
}

function cleanupGuardEnv() {
  for (const key of [
    "PI_SUBAGENT_COMPLETION_FILE",
    "PI_SUBAGENT_TOKEN",
    "PI_SUBAGENT_ID",
    "PI_SUBAGENT_SESSION",
    "PI_SUBAGENT_AUTO_EXIT",
    "PI_SUBAGENT_NAME",
    "PI_SUBAGENT_AGENT",
    "PI_DENY_TOOLS",
    "PI_SUBAGENT_ARTIFACT_PATH",
    "PI_SUBAGENT_RESERVATIONS_DIR",
  ]) {
    delete process.env[key];
  }
}

function abortRunning() {
  const testApi = (subagentsModule as any).__test__;
  for (const [, running] of testApi.runningSubagents) {
    running.abortController?.abort();
  }
  testApi.runningSubagents.clear();
}

describe("artifact-claim helpers", () => {
  it("two concurrent reserves of the same path: exactly one wins; loser is refused; both outputs preserved", async () => {
    for (let i = 0; i < 20; i++) {
      const baseDir = makeTempDir("pi-claim-race-");
      const reservationsDir = join(baseDir, "reservations");
      try {
        const path = join(baseDir, "plan.md");
        const idA = randomUUID();
        const idB = randomUUID();
        const [ra, rb] = await Promise.all([
          reserveArtifactPath({ path, baseDir, reservationsDir, attemptId: idA, name: "alice" }),
          reserveArtifactPath({ path, baseDir, reservationsDir, attemptId: idB, name: "bob" }),
        ]);
        const results = [ra, rb];
        const winners = results.filter((r) => r.ok);
        const losers = results.filter((r) => !r.ok);
        assert.equal(winners.length, 1, `iteration ${i}: exactly one winner`);
        assert.equal(losers.length, 1, `iteration ${i}: exactly one loser`);
        const winner = winners[0];
        const loser = losers[0];
        if (!winner.ok || loser.ok) throw new Error("unreachable");
        const winnerId = winner === ra ? idA : idB;
        const loserId = loser === ra ? idA : idB;
        const winnerName = winner === ra ? "alice" : "bob";
        assert.ok(existsSync(reservationMarkerPath(reservationsDir, winner.canonicalPath)));
        assert.equal(winner.canonicalPath, canonicalizeArtifactPath(path, baseDir));
        assert.match(loser.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(loser.message, new RegExp(winnerId));
        assert.match(loser.message, new RegExp(winnerName));
        assert.match(loser.message, new RegExp(attemptScopedPath(path, loserId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        writeFileSync(path, "WINNER");
        const again = await reserveArtifactPath({
          path,
          baseDir,
          reservationsDir,
          attemptId: loserId,
          name: "loser-retry",
        });
        assert.equal(again.ok, false, "re-reserve of the winner path must still be refused");
        const scoped = attemptScopedPath(path, loserId);
        const scopedReserve = await reserveArtifactPath({
          path: scoped,
          baseDir,
          reservationsDir,
          attemptId: loserId,
          name: "loser",
        });
        assert.equal(scopedReserve.ok, true);
        writeFileSync(scoped, "LOSER");
        assert.equal(readFileSync(path, "utf8"), "WINNER");
        assert.equal(readFileSync(scoped, "utf8"), "LOSER");
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
    }
  });

  it("symlink/alias spellings reserve once", async () => {
    const baseDir = makeTempDir("pi-claim-alias-");
    const reservationsDir = join(baseDir, "reservations");
    try {
      mkdirSync(join(baseDir, "real"));
      symlinkSync(join(baseDir, "real"), join(baseDir, "link"));
      const viaLink = join(baseDir, "link", "report.md");
      const viaReal = join(baseDir, "real", "report.md");
      const viaDotDot = join(baseDir, "real", "sub", "..", "report.md");
      const c1 = canonicalizeArtifactPath(viaLink, baseDir);
      const c2 = canonicalizeArtifactPath(viaReal, baseDir);
      const c3 = canonicalizeArtifactPath(viaDotDot, baseDir);
      assert.equal(c1, c2);
      assert.equal(c2, c3);
      assert.equal(canonicalizeArtifactPath("real/report.md", baseDir), c2);
      const a = await reserveArtifactPath({
        path: viaLink,
        baseDir,
        reservationsDir,
        attemptId: "attempt-a",
        name: "first",
      });
      assert.equal(a.ok, true);
      const b = await reserveArtifactPath({
        path: viaReal,
        baseDir,
        reservationsDir,
        attemptId: "attempt-b",
        name: "second",
      });
      assert.equal(b.ok, false);
      if (b.ok) throw new Error("unreachable");
      assert.equal(b.owner?.attemptId, "attempt-a");
      const c = await reserveArtifactPath({
        path: viaDotDot,
        baseDir,
        reservationsDir,
        attemptId: "attempt-c",
        name: "third",
      });
      assert.equal(c.ok, false);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("convention paths both succeed and release unlinks only its marker", async () => {
    const baseDir = makeTempDir("pi-claim-conv-");
    const reservationsDir = join(baseDir, "reservations");
    try {
      const idA = randomUUID();
      const idB = randomUUID();
      const ra = await reserveArtifactPath({
        path: join(baseDir, `plan.planner.${idA}.md`),
        baseDir,
        reservationsDir,
        attemptId: idA,
        name: "planner-a",
      });
      const rb = await reserveArtifactPath({
        path: join(baseDir, `plan.planner.${idB}.md`),
        baseDir,
        reservationsDir,
        attemptId: idB,
        name: "planner-b",
      });
      assert.equal(ra.ok, true);
      assert.equal(rb.ok, true);
      if (!ra.ok || !rb.ok) throw new Error("unreachable");
      assert.ok(existsSync(ra.markerPath));
      assert.ok(existsSync(rb.markerPath));
      ra.release();
      assert.equal(existsSync(ra.markerPath), false);
      assert.ok(existsSync(rb.markerPath));
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("corrupt marker refuses the second reserve with owner null and names the path", async () => {
    const baseDir = makeTempDir("pi-claim-corrupt-");
    const reservationsDir = join(baseDir, "reservations");
    try {
      const path = join(baseDir, "report.md");
      const first = await reserveArtifactPath({
        path,
        baseDir,
        reservationsDir,
        attemptId: "owner-1",
        name: "first",
      });
      assert.equal(first.ok, true);
      if (!first.ok) throw new Error("unreachable");
      writeFileSync(first.markerPath, "NOT JSON{{{");
      const second = await reserveArtifactPath({
        path,
        baseDir,
        reservationsDir,
        attemptId: "owner-2",
        name: "second",
      });
      assert.equal(second.ok, false);
      if (second.ok) throw new Error("unreachable");
      assert.equal(second.owner, null);
      assert.match(second.message, /report\.md/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("canonicalize rejects empty/NUL, '.', existing directories, and non-regular files before any marker", async () => {
    const baseDir = makeTempDir("pi-claim-valid-");
    const reservationsDir = join(baseDir, "reservations");
    try {
      await assert.rejects(
        () => reserveArtifactPath({ path: "", baseDir, reservationsDir, attemptId: "a", name: "n" }),
        /non-empty|NUL/i,
      );
      await assert.rejects(
        () => reserveArtifactPath({ path: "foo\0bar", baseDir, reservationsDir, attemptId: "a", name: "n" }),
        /NUL/i,
      );
      await assert.rejects(
        () => reserveArtifactPath({ path: ".", baseDir, reservationsDir, attemptId: "a", name: "n" }),
        /\./,
      );
      await assert.rejects(
        () => reserveArtifactPath({ path: baseDir, baseDir, reservationsDir, attemptId: "a", name: "n" }),
        /directory/i,
      );
      await assert.rejects(
        () => reserveArtifactPath({ path: "/dev/null", baseDir, reservationsDir, attemptId: "a", name: "n" }),
        /regular file/i,
      );
      assert.equal(existsSync(reservationsDir), false, "validation errors must not create a marker dir");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe("artifact-claim launch seam", () => {
  it(
    "real subagent tool: same/aliased artifactPath is refused; distinct path and no-param succeed",
    { timeout: 20000 },
    async () => {
      const harness = startPrivateTmux();
      const root = makeTempDir("pi-claim-seam-");
      const previousTmux = process.env.TMUX;
      const previousPane = process.env.TMUX_PANE;
      const previousDispatch = process.env.PI_DISPATCH_SH;
      delete process.env.PI_SUBAGENT_ID;
      const { api, handlers, tools } = makeApi();
      subagentsModule.default(api);
      const parentSessionId = randomUUID();
      const sessionDir = join(root, "sessions");
      mkdirSync(sessionDir, { recursive: true });
      const parentSessionFile = join(root, "parent.jsonl");
      writeFileSync(parentSessionFile, JSON.stringify({ type: "session", id: parentSessionId }) + "\n");
      const ctx = makeCtx({ cwd: root, sessionDir, parentSessionId, parentSessionFile });
      const splitCalls: string[][] = [];
      const realAdapter = createDefaultAdapter();
      setLifecycleAdapter({
        ...realAdapter,
        tmux(args: string[]) {
          if (args.includes("split-window")) splitCalls.push([...args]);
          return realAdapter.tmux(args);
        },
      });
      try {
        process.env.TMUX = `${harness.socketPath},0,0`;
        process.env.TMUX_PANE = harness.parentPane;
        process.env.PI_DISPATCH_SH = writeFakeDispatcher(root);
        fireOnly(handlers, "session_start", { reason: "startup" }, ctx);

        const report = join(root, "out", "report.md");
        const first = await tools["subagent"].execute(
          "tc1",
          { name: "first", task: "t", artifactPath: report },
          undefined,
          undefined,
          ctx,
        );
        assert.equal(first.details.status, "started");
        assert.ok(first.details.id);
        const canonical = canonicalizeArtifactPath(report, root);
        assert.equal(first.details.artifactPath, canonical);
        const reservationsDir = join(sessionDir, "artifacts", parentSessionId, "reservations");
        const marker = reservationMarkerPath(reservationsDir, canonical);
        assert.ok(existsSync(marker), "winner marker must exist");
        const owner = JSON.parse(readFileSync(marker, "utf8"));
        assert.equal(owner.attemptId, first.details.id);
        const scriptBody = readFileSync(first.details.launchScriptFile, "utf8");
        assert.match(scriptBody, /PI_SUBAGENT_ARTIFACT_PATH/);
        assert.match(scriptBody, /PI_SUBAGENT_RESERVATIONS_DIR/);
        assert.equal(splitCalls.length, 1, "first spawn must attempt exactly one split-window");

        await assert.rejects(
          () =>
            tools["subagent"].execute(
              "tc2",
              { name: "second", task: "t", artifactPath: report },
              undefined,
              undefined,
              ctx,
            ),
          (err: any) => {
            const msg = String(err?.message ?? err);
            assert.match(msg, /already reserved by attempt/);
            assert.match(msg, new RegExp(first.details.id));
            assert.match(msg, /\(first\)/);
            return true;
          },
        );
        const aliased = join(root, "out", "..", "out", "report.md");
        await assert.rejects(
          () =>
            tools["subagent"].execute(
              "tc2b",
              { name: "aliased", task: "t", artifactPath: aliased },
              undefined,
              undefined,
              ctx,
            ),
          /already reserved by attempt/,
        );
        assert.equal(splitCalls.length, 1, "refused spawns must not invoke split-window");
        const loadedAfterRefuse = loadRegistry(join(sessionDir, "artifacts", parentSessionId, "workers.json"));
        assert.equal(loadedAfterRefuse.status, "ok");
        assert.equal(loadedAfterRefuse.registry.workers.length, 1);

        const distinct = join(root, "out", `report.${randomUUID()}.md`);
        const third = await tools["subagent"].execute(
          "tc3",
          { name: "third", task: "t", artifactPath: distinct },
          undefined,
          undefined,
          ctx,
        );
        assert.equal(third.details.status, "started");
        assert.equal(splitCalls.length, 2, "distinct path must launch");

        const markersBeforePlain = existsSync(reservationsDir)
          ? readdirSync(reservationsDir).filter((f) => f.endsWith(".json")).length
          : 0;
        const fourth = await tools["subagent"].execute(
          "tc4",
          { name: "plain", task: "t" },
          undefined,
          undefined,
          ctx,
        );
        assert.equal(fourth.details.status, "started");
        assert.equal(fourth.details.artifactPath, undefined);
        const plainScript = readFileSync(fourth.details.launchScriptFile, "utf8");
        assert.doesNotMatch(plainScript, /PI_SUBAGENT_ARTIFACT_PATH/);
        const markersAfterPlain = existsSync(reservationsDir)
          ? readdirSync(reservationsDir).filter((f) => f.endsWith(".json")).length
          : 0;
        assert.equal(markersAfterPlain, markersBeforePlain, "no-param spawn must not write a marker");
        assert.equal(splitCalls.length, 3);
      } finally {
        abortRunning();
        fireOnly(handlers, "session_shutdown", {}, ctx);
        if (previousTmux === undefined) delete process.env.TMUX;
        else process.env.TMUX = previousTmux;
        if (previousPane === undefined) delete process.env.TMUX_PANE;
        else process.env.TMUX_PANE = previousPane;
        if (previousDispatch === undefined) delete process.env.PI_DISPATCH_SH;
        else process.env.PI_DISPATCH_SH = previousDispatch;
        setLifecycleAdapter(null);
        harness.kill();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "failed launch before split releases the marker so a retry can reserve",
    { timeout: 20000 },
    async () => {
      const harness = startPrivateTmux();
      const root = makeTempDir("pi-claim-presplit-");
      const previousTmux = process.env.TMUX;
      const previousPane = process.env.TMUX_PANE;
      const previousDispatch = process.env.PI_DISPATCH_SH;
      delete process.env.PI_SUBAGENT_ID;
      const { api, handlers, tools } = makeApi();
      subagentsModule.default(api);
      const parentSessionId = randomUUID();
      const sessionDir = join(root, "sessions");
      mkdirSync(sessionDir, { recursive: true });
      const parentSessionFile = join(root, "parent.jsonl");
      writeFileSync(parentSessionFile, JSON.stringify({ type: "session", id: parentSessionId }) + "\n");
      const ctx = makeCtx({ cwd: root, sessionDir, parentSessionId, parentSessionFile });
      const realAdapter = createDefaultAdapter();
      setLifecycleAdapter({
        ...realAdapter,
        fs: {
          ...realAdapter.fs,
          writeFileSync(path: any, data: any, options: any) {
            if (String(path).includes("subagent-scripts")) throw new Error("script write boom");
            return realAdapter.fs.writeFileSync(path, data, options);
          },
        },
      });
      const report = join(root, "out", "report.md");
      const canonical = canonicalizeArtifactPath(report, root);
      const reservationsDir = join(sessionDir, "artifacts", parentSessionId, "reservations");
      const marker = reservationMarkerPath(reservationsDir, canonical);
      try {
        process.env.TMUX = `${harness.socketPath},0,0`;
        process.env.TMUX_PANE = harness.parentPane;
        process.env.PI_DISPATCH_SH = writeFakeDispatcher(root);
        fireOnly(handlers, "session_start", { reason: "startup" }, ctx);
        await assert.rejects(
          () =>
            tools["subagent"].execute(
              "tc1",
              { name: "pre-split", task: "t", artifactPath: report },
              undefined,
              undefined,
              ctx,
            ),
          /script write boom/,
        );
        assert.equal(existsSync(marker), false, "pre-split failure must release the marker");
        setLifecycleAdapter(createDefaultAdapter());
        const retry = await tools["subagent"].execute(
          "tc2",
          { name: "retry", task: "t", artifactPath: report },
          undefined,
          undefined,
          ctx,
        );
        assert.equal(retry.details.status, "started");
        assert.ok(existsSync(marker));
      } finally {
        abortRunning();
        fireOnly(handlers, "session_shutdown", {}, ctx);
        if (previousTmux === undefined) delete process.env.TMUX;
        else process.env.TMUX = previousTmux;
        if (previousPane === undefined) delete process.env.TMUX_PANE;
        else process.env.TMUX_PANE = previousPane;
        if (previousDispatch === undefined) delete process.env.PI_DISPATCH_SH;
        else process.env.PI_DISPATCH_SH = previousDispatch;
        setLifecycleAdapter(null);
        harness.kill();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "failed launch after split attempt keeps the marker; second reservation is refused",
    { timeout: 20000 },
    async () => {
      const harness = startPrivateTmux();
      const root = makeTempDir("pi-claim-postsplit-");
      const previousTmux = process.env.TMUX;
      const previousPane = process.env.TMUX_PANE;
      const previousDispatch = process.env.PI_DISPATCH_SH;
      delete process.env.PI_SUBAGENT_ID;
      const { api, handlers, tools } = makeApi();
      subagentsModule.default(api);
      const parentSessionId = randomUUID();
      const sessionDir = join(root, "sessions");
      mkdirSync(sessionDir, { recursive: true });
      const parentSessionFile = join(root, "parent.jsonl");
      writeFileSync(parentSessionFile, JSON.stringify({ type: "session", id: parentSessionId }) + "\n");
      const ctx = makeCtx({ cwd: root, sessionDir, parentSessionId, parentSessionFile });
      const realAdapter = createDefaultAdapter();
      setLifecycleAdapter({
        ...realAdapter,
        tmux(args: string[]) {
          if (args.includes("split-window")) throw new Error("split-window boom");
          return realAdapter.tmux(args);
        },
      });
      const report = join(root, "out", "report.md");
      const canonical = canonicalizeArtifactPath(report, root);
      const reservationsDir = join(sessionDir, "artifacts", parentSessionId, "reservations");
      const marker = reservationMarkerPath(reservationsDir, canonical);
      try {
        process.env.TMUX = `${harness.socketPath},0,0`;
        process.env.TMUX_PANE = harness.parentPane;
        process.env.PI_DISPATCH_SH = writeFakeDispatcher(root);
        fireOnly(handlers, "session_start", { reason: "startup" }, ctx);
        await assert.rejects(
          () =>
            tools["subagent"].execute(
              "tc1",
              { name: "post-split", task: "t", artifactPath: report },
              undefined,
              undefined,
              ctx,
            ),
          /split was not accepted|split-window boom/,
        );
        assert.ok(existsSync(marker), "post-split failure must keep the marker");
        const second = await reserveArtifactPath({
          path: report,
          baseDir: root,
          reservationsDir,
          attemptId: randomUUID(),
          name: "retry",
        });
        assert.equal(second.ok, false, "kept marker must refuse a second reservation");
        if (second.ok) throw new Error("unreachable");
        assert.match(second.message, /already reserved/);
      } finally {
        abortRunning();
        fireOnly(handlers, "session_shutdown", {}, ctx);
        if (previousTmux === undefined) delete process.env.TMUX;
        else process.env.TMUX = previousTmux;
        if (previousPane === undefined) delete process.env.TMUX_PANE;
        else process.env.TMUX_PANE = previousPane;
        if (previousDispatch === undefined) delete process.env.PI_DISPATCH_SH;
        else process.env.PI_DISPATCH_SH = previousDispatch;
        setLifecycleAdapter(null);
        harness.kill();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("artifact-claim worker guard", () => {
  it("blocks write/edit of a foreign reserved path and is inactive without env", async () => {
    const root = makeTempDir("pi-claim-guard-");
    try {
      const own = join(root, "own.md");
      const foreign = join(root, "foreign.md");
      const reservationsDir = join(root, "reservations");
      const reserved = await reserveArtifactPath({
        path: foreign,
        baseDir: root,
        reservationsDir,
        attemptId: "other",
        name: "other-worker",
      });
      assert.equal(reserved.ok, true);
      const canonicalOwn = canonicalizeArtifactPath(own, root);
      const canonicalForeign = canonicalizeArtifactPath(foreign, root);

      process.env.PI_SUBAGENT_ID = "self";
      process.env.PI_SUBAGENT_ARTIFACT_PATH = canonicalOwn;
      process.env.PI_SUBAGENT_RESERVATIONS_DIR = reservationsDir;
      const { api, handlers } = makeApi();
      subagentDoneExtension(api);
      const ctx: any = { cwd: root, ui: { setWidget() {} } };

      const blocked = await Promise.all(
        handlers.tool_call.map((h) => h({ toolName: "write", input: { path: foreign } }, ctx)),
      );
      assert.ok(
        blocked.some((r) => r && r.block === true && /other.*self/s.test(r.reason)),
        `expected a block naming other then self, got ${JSON.stringify(blocked)}`,
      );

      const ownWrite = await Promise.all(
        handlers.tool_call.map((h) => h({ toolName: "write", input: { path: own } }, ctx)),
      );
      assert.ok(ownWrite.every((r) => r == null));

      const readCall = await Promise.all(
        handlers.tool_call.map((h) => h({ toolName: "read", input: { path: foreign } }, ctx)),
      );
      assert.ok(readCall.every((r) => r == null));

      delete process.env.PI_SUBAGENT_ID;
      const inactiveId = await Promise.all(
        handlers.tool_call.map((h) => h({ toolName: "write", input: { path: foreign } }, ctx)),
      );
      assert.ok(inactiveId.every((r) => r == null), "guard inactive without PI_SUBAGENT_ID");

      process.env.PI_SUBAGENT_ID = "self";
      delete process.env.PI_SUBAGENT_RESERVATIONS_DIR;
      const inactiveDir = await Promise.all(
        handlers.tool_call.map((h) => h({ toolName: "write", input: { path: foreign } }, ctx)),
      );
      assert.ok(inactiveDir.every((r) => r == null), "guard inactive without reservations dir");

      const pure = guardReservedArtifactWrite(
        { toolName: "edit", input: { path: foreign } },
        { selfAttemptId: "self", ownPath: canonicalOwn, reservationsDir, baseDir: root },
      );
      assert.equal(pure?.block, true);
      assert.match(pure!.reason, new RegExp(canonicalForeign));
    } finally {
      cleanupGuardEnv();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
