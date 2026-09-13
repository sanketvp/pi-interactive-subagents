import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getLifecycleAdapter, type LifecycleAdapter } from "./adapter.ts";
import {
  type AttemptRecord,
  type DeliveryState,
  type ModelIdentity,
  type OutcomeType,
  type ResourceState,
  type WorkerRegistry,
  LIVE_RESOURCE_STATES,
  MAX_CHILD_INVOCATIONS,
  MAX_LIVE_RESOURCES,
  effectiveInvocationLimit,
  countLiveResources,
  loadRegistry,
  outcomeDigest,
  writeRegistryDocument,
  RegistryValidationError,
} from "./registry.ts";
import { safeScriptPreamble } from "./hardening.ts";

export const DEFAULT_DISPATCHER = join(homedir(), ".claude", "scripts", "pi-dispatch.sh");

export function dispatcherPath(): string {
  return process.env.PI_DISPATCH_SH || DEFAULT_DISPATCHER;
}

export function currentTmuxSocket(env: NodeJS.ProcessEnv = process.env): string | null {
  const tmux = env.TMUX;
  if (!tmux) return null;
  const socket = tmux.split(",")[0];
  return socket || null;
}

export function tmuxArgs(socket: string, args: string[]): string[] {
  if (!socket) throw new Error("tmux socket is required; refusing default-server operations");
  return ["-S", socket, ...args];
}

export function readSessionHeaderId(sessionFile: string, adapter = getLifecycleAdapter()): string {
  const raw = adapter.fs.readFileSync(sessionFile, "utf8");
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  const first = text.split(/\r?\n/).find((line) => line.trim());
  if (!first) throw new Error("Session file has no header");
  const header = JSON.parse(first);
  if (header?.type !== "session" || typeof header.id !== "string" || !header.id) {
    throw new Error("Session header missing canonical id");
  }
  return header.id;
}

export function canonicalizeSessionFile(sessionFile: string, adapter = getLifecycleAdapter()): string {
  try {
    return adapter.fs.realpathSync(sessionFile);
  } catch (error: any) {
    if (error?.code === "ENOENT") return sessionFile;
    throw error;
  }
}

export function freezePaneStartCommand(scriptPath: string): string {
  return `bash ${scriptPath}`;
}

function liveWorkers(registry: WorkerRegistry): AttemptRecord[] {
  return registry.workers.filter((worker) => LIVE_RESOURCE_STATES.has(worker.resourceState));
}

export function assertCanLaunch(registry: WorkerRegistry): void {
  if (countLiveResources(registry.workers) >= MAX_LIVE_RESOURCES) {
    throw new Error(`Four-worker concurrency limit reached (including retained workers)`);
  }
  const limit = effectiveInvocationLimit(registry);
  if (limit !== null && registry.invocations >= limit) {
    throw new Error(`Invocation budget reached (${registry.invocations}/${limit} this session). Ask the user: /subagent-limit raises or removes it.`);
  }
}

export function assertUniqueSessionWriter(registry: WorkerRegistry, canonicalSessionFile: string): void {
  const clash = liveWorkers(registry).find((worker) => worker.sessionFile === canonicalSessionFile);
  if (clash) {
    throw new Error(`Refusing concurrent resume of session ${canonicalSessionFile}; live attempt ${clash.attemptId} is the single writer`);
  }
}

export function persistRegistry(path: string, registry: WorkerRegistry, adapter = getLifecycleAdapter()): void {
  writeRegistryDocument(path, registry, adapter.fs);
}

export function replaceWorker(registry: WorkerRegistry, record: AttemptRecord): WorkerRegistry {
  const index = registry.workers.findIndex((worker) => worker.attemptId === record.attemptId);
  const workers = [...registry.workers];
  if (index === -1) workers.push(record);
  else workers[index] = record;
  return { ...registry, workers };
}

export interface BeginAttemptInput {
  registryPath: string;
  registry: WorkerRegistry;
  attemptId?: string;
  completionToken?: string;
  name: string;
  task: string;
  agent?: string;
  title?: string;
  repository?: string;
  parentSessionId: string;
  sessionFile: string;
  launchScriptFile: string;
  completionFile: string;
  tmuxSocket: string;
  windowId: string;
  requested: ModelIdentity;
  interactive: boolean;
  paneStartCommand?: string;
  /** Canonical session-header UUID already known before launch (e.g. resume). */
  expectedPiSessionId?: string | null;
}

export function persistPreparingIntent(input: BeginAttemptInput, adapter = getLifecycleAdapter()): { registry: WorkerRegistry; record: AttemptRecord } {
  assertCanLaunch(input.registry);
  assertUniqueSessionWriter(input.registry, input.sessionFile);
  const invocation = input.registry.invocations + 1;
  const record: AttemptRecord = {
    attemptId: input.attemptId ?? randomUUID(),
    parentSessionId: input.parentSessionId,
    piSessionId: input.expectedPiSessionId ?? null,
    invocation,
    completionToken: input.completionToken ?? randomUUID(),
    tmuxSocket: input.tmuxSocket,
    windowId: input.windowId,
    surface: null,
    sessionFile: input.sessionFile,
    launchScriptFile: input.launchScriptFile,
    completionFile: input.completionFile,
    paneStartCommand: input.paneStartCommand ?? freezePaneStartCommand(input.launchScriptFile),
    requested: input.requested,
    observed: null,
    resourceState: "preparing",
    outcome: null,
    outcomeBytes: null,
    outcomeDigest: null,
    deliveryState: null,
    createdAt: adapter.now(),
    name: input.name,
    task: input.task,
    agent: input.agent,
    title: input.title ?? input.name,
    repository: input.repository,
    interactive: input.interactive,
  };
  const registry: WorkerRegistry = {
    ...input.registry,
    invocations: invocation,
    workers: [...input.registry.workers, record],
  };
  persistRegistry(input.registryPath, registry, adapter);
  return { registry, record };
}

export function persistRecord(
  registryPath: string,
  registry: WorkerRegistry,
  record: AttemptRecord,
  adapter = getLifecycleAdapter(),
): WorkerRegistry {
  const next = replaceWorker(registry, record);
  persistRegistry(registryPath, next, adapter);
  return next;
}

export interface LaunchScriptInput {
  scriptPath: string;
  attemptId: string;
  token: string;
  socket: string;
  dispatcher: string;
  dispatcherArgs: string[];
  env: Record<string, string>;
  cwd?: string;
  preamble?: string;
  waitFile?: string;
}

function bashSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function writeLaunchScript(input: LaunchScriptInput, adapter = getLifecycleAdapter()): string {
  const lines = ["#!/bin/bash", "set -eu"];
  if (input.preamble) lines.push(safeScriptPreamble(input.preamble));
  if (input.waitFile) {
    lines.push(`while [ ! -f ${bashSingleQuote(input.waitFile)} ]; do sleep 0.05; done`);
  }
  lines.push(
    `tmux -S ${bashSingleQuote(input.socket)} set-option -p -t "$TMUX_PANE" @pi-attempt ${bashSingleQuote(input.attemptId)} && tmux -S ${bashSingleQuote(input.socket)} set-option -p -t "$TMUX_PANE" @pi-worker-token ${bashSingleQuote(input.token)} || exit 66`,
  );
  for (const [key, value] of Object.entries(input.env)) {
    lines.push(`export ${key}=${bashSingleQuote(value)}`);
  }
  if (input.cwd) lines.push(`cd ${bashSingleQuote(input.cwd)}`);
  // Label the pane border with the worker name (tmux pane_title via OSC 2).
  lines.push(`printf '\\033]2;%s\\033\\\\' "\${PI_SUBAGENT_NAME:-worker}" || true`);
  lines.push("dispatch_args=(");
  lines.push(`  ${bashSingleQuote(input.dispatcher)}`);
  for (const arg of input.dispatcherArgs) {
    lines.push(`  ${bashSingleQuote(arg)}`);
  }
  lines.push(")");
  lines.push('set +e');
  lines.push('"${dispatch_args[@]}"');
  lines.push("worker_exit=$?");
  lines.push("set -e");
  const completionCli = join(dirname(fileURLToPath(import.meta.url)), "completion.mjs");
  lines.push(
    `${bashSingleQuote(process.execPath)} ${bashSingleQuote(completionCli)} ${bashSingleQuote(input.env.PI_SUBAGENT_COMPLETION_FILE)} ${bashSingleQuote(input.attemptId)} ${bashSingleQuote(input.token)} ${bashSingleQuote(input.env.PI_SUBAGENT_SESSION)} "$worker_exit"`,
  );
  lines.push("exit \"$worker_exit\"");
  adapter.fs.mkdirSync(dirname(input.scriptPath), { recursive: true, mode: 0o700 });
  adapter.fs.writeFileSync(input.scriptPath, lines.join("\n") + "\n", { mode: 0o600, flag: "wx" });
  return freezePaneStartCommand(input.scriptPath);
}

export function persistSplitRequested(
  registryPath: string,
  registry: WorkerRegistry,
  record: AttemptRecord,
  paneStartCommand: string,
  adapter = getLifecycleAdapter(),
): { registry: WorkerRegistry; record: AttemptRecord } {
  const nextRecord: AttemptRecord = {
    ...record,
    paneStartCommand,
    resourceState: "split_requested",
  };
  const next = persistRecord(registryPath, registry, nextRecord, adapter);
  return { registry: next, record: nextRecord };
}

export interface PaneIdentity {
  paneId: string;
  paneStartCommand: string;
  attemptTag: string;
}

export function listWindowPanes(socket: string, windowId: string, adapter = getLifecycleAdapter()): PaneIdentity[] {
  const output = adapter.tmux(
    tmuxArgs(socket, ["list-panes", "-t", windowId, "-F", "#{pane_id}\t#{pane_start_command}\t#{@pi-attempt}"]),
  );
  if (!output) return [];
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [paneId, paneStartCommand = "", attemptTag = ""] = line.split("\t");
    return { paneId, paneStartCommand, attemptTag };
  });
}

export function matchPaneIdentity(record: AttemptRecord, panes: PaneIdentity[]): PaneIdentity | null {
  const byAttempt = panes.find((pane) => pane.attemptTag === record.attemptId);
  if (byAttempt) return byAttempt;
  const byStart = panes.find((pane) => pane.paneStartCommand === record.paneStartCommand);
  return byStart ?? null;
}

export function recoverSurface(
  record: AttemptRecord,
  adapter = getLifecycleAdapter(),
): { kind: "adopted"; pane: PaneIdentity } | { kind: "proven_absent" } | { kind: "unknown"; reason: string } {
  try {
    const panes = listWindowPanes(record.tmuxSocket, record.windowId, adapter);
    const match = matchPaneIdentity(record, panes);
    if (match) return { kind: "adopted", pane: match };
    if (record.resourceState === "split_requested" && record.surface === null) {
      return { kind: "proven_absent" };
    }
    if (record.surface && !panes.some((pane) => pane.paneId === record.surface) && !match) {
      return { kind: "proven_absent" };
    }
    return { kind: "unknown", reason: "no matching pane in recorded window" };
  } catch (error: any) {
    return { kind: "unknown", reason: error?.message ?? String(error) };
  }
}

export function invokeSplit(
  registryPath: string,
  registry: WorkerRegistry,
  record: AttemptRecord,
  adapter = getLifecycleAdapter(),
): { registry: WorkerRegistry; record: AttemptRecord } {
  try {
    const paneId = adapter.tmux(
      tmuxArgs(record.tmuxSocket, [
        "split-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        record.windowId,
        "--",
        "bash",
        record.launchScriptFile,
      ]),
    );
    if (!/^%\d+$/.test(paneId)) throw new Error(`Unexpected tmux split-window output: ${paneId}`);
    const nextRecord: AttemptRecord = {
      ...record,
      surface: paneId,
      resourceState: "launching",
    };
    const next = persistRecord(registryPath, registry, nextRecord, adapter);
    return { registry: next, record: nextRecord };
  } catch (error: any) {
    const recovered = recoverSurface(record, adapter);
    if (recovered.kind === "adopted") {
      const nextRecord: AttemptRecord = {
        ...record,
        surface: recovered.pane.paneId,
        resourceState: "unknown",
      };
      const next = persistRecord(registryPath, registry, nextRecord, adapter);
      return { registry: next, record: nextRecord };
    }
    if (recovered.kind === "proven_absent") {
      const nextRecord: AttemptRecord = { ...record, resourceState: "proven_absent" };
      const next = persistRecord(registryPath, registry, nextRecord, adapter);
      throw new Error(`tmux split was not accepted: ${error?.message ?? String(error)}`);
    }
    const nextRecord: AttemptRecord = { ...record, resourceState: "unknown" };
    const next = persistRecord(registryPath, registry, nextRecord, adapter);
    return { registry: next, record: nextRecord };
  }
}

export function currentWindowId(socket: string, pane: string, adapter = getLifecycleAdapter()): string {
  const windowId = adapter.tmux(tmuxArgs(socket, ["display-message", "-p", "-t", pane, "#{window_id}"]));
  if (!/^@\d+$/.test(windowId)) throw new Error(`Unexpected window id: ${windowId}`);
  return windowId;
}

export function readPaneToken(socket: string, surface: string, adapter = getLifecycleAdapter()): string {
  return adapter.tmux(tmuxArgs(socket, ["show-options", "-p", "-v", "-t", surface, "@pi-worker-token"]));
}

export function clearPaneTags(socket: string, surface: string, adapter = getLifecycleAdapter()): void {
  adapter.tmux(tmuxArgs(socket, ["set-option", "-pu", "-t", surface, "@pi-attempt"]));
  adapter.tmux(tmuxArgs(socket, ["set-option", "-pu", "-t", surface, "@pi-worker-token"]));
}

export function killOwnedPane(socket: string, surface: string, token: string, adapter = getLifecycleAdapter()): void {
  const actual = readPaneToken(socket, surface, adapter);
  if (actual !== token) throw new Error("Worker pane ownership changed; retaining pane");
  adapter.tmux(tmuxArgs(socket, ["kill-pane", "-t", surface]));
}

export function releaseWithoutClose(
  registryPath: string,
  registry: WorkerRegistry,
  record: AttemptRecord,
  adapter = getLifecycleAdapter(),
): { registry: WorkerRegistry; record: AttemptRecord } {
  if (!record.surface) throw new Error("Cannot release an attempt with no surface");
  const actual = readPaneToken(record.tmuxSocket, record.surface, adapter);
  if (actual !== record.completionToken) throw new Error("Worker pane ownership changed; retaining pane");
  clearPaneTags(record.tmuxSocket, record.surface, adapter);
  const nextRecord: AttemptRecord = { ...record, resourceState: "released" };
  const next = persistRecord(registryPath, registry, nextRecord, adapter);
  return { registry: next, record: nextRecord };
}

export function closeOwned(
  registryPath: string,
  registry: WorkerRegistry,
  record: AttemptRecord,
  adapter = getLifecycleAdapter(),
): { registry: WorkerRegistry; record: AttemptRecord } {
  if (!record.surface) throw new Error("Cannot close an attempt with no surface");
  killOwnedPane(record.tmuxSocket, record.surface, record.completionToken, adapter);
  const nextRecord: AttemptRecord = { ...record, resourceState: "closed" };
  const next = persistRecord(registryPath, registry, nextRecord, adapter);
  return { registry: next, record: nextRecord };
}

export function classifySocket(record: AttemptRecord, currentSocket: string | null): "current" | "foreign" {
  if (!currentSocket || record.tmuxSocket !== currentSocket) return "foreign";
  return "current";
}

export function applyRecovery(
  registryPath: string,
  registry: WorkerRegistry,
  record: AttemptRecord,
  currentSocket: string | null,
  adapter = getLifecycleAdapter(),
): { registry: WorkerRegistry; record: AttemptRecord; tmuxCalls: boolean } {
  if (classifySocket(record, currentSocket) === "foreign") {
    if (!LIVE_RESOURCE_STATES.has(record.resourceState)) return { registry, record, tmuxCalls: false };
    if (record.resourceState === "foreign") return { registry, record, tmuxCalls: false };
    const nextRecord: AttemptRecord = { ...record, resourceState: "foreign" };
    const next = persistRecord(registryPath, registry, nextRecord, adapter);
    return { registry: next, record: nextRecord, tmuxCalls: false };
  }
  // A `preparing` record with no surface proves tmux was never even
  // requested (that intent is persisted strictly BEFORE `split_requested`,
  // which is itself persisted strictly BEFORE tmux is invoked). Recovering
  // it is therefore provably `proven_absent` -- no pane could ever exist for
  // it -- and requires zero tmux calls, unlike `split_requested`'s
  // uncertain in-flight window which still must be checked via
  // `recoverSurface`.
  if (record.resourceState === "preparing" && record.surface === null) {
    const nextRecord: AttemptRecord = { ...record, resourceState: "proven_absent" };
    const next = persistRecord(registryPath, registry, nextRecord, adapter);
    return { registry: next, record: nextRecord, tmuxCalls: false };
  }

  const recovered = recoverSurface(record, adapter);
  if (recovered.kind === "adopted") {
    const nextState: ResourceState =
      record.resourceState === "preparing" || record.resourceState === "split_requested"
        ? "unknown"
        : record.resourceState;
    const nextRecord: AttemptRecord = {
      ...record,
      surface: recovered.pane.paneId,
      resourceState: nextState,
    };
    const next = persistRecord(registryPath, registry, nextRecord, adapter);
    return { registry: next, record: nextRecord, tmuxCalls: true };
  }
  if (recovered.kind === "proven_absent") {
    const nextRecord: AttemptRecord = { ...record, resourceState: "proven_absent" };
    const next = persistRecord(registryPath, registry, nextRecord, adapter);
    return { registry: next, record: nextRecord, tmuxCalls: true };
  }
  const nextRecord: AttemptRecord = {
    ...record,
    resourceState: record.resourceState === "preparing" ? "unknown" : record.resourceState === "split_requested" ? "unknown" : record.resourceState,
  };
  if (nextRecord.resourceState === record.resourceState && nextRecord.surface === record.surface) {
    return { registry, record, tmuxCalls: true };
  }
  const next = persistRecord(registryPath, registry, nextRecord, adapter);
  return { registry: next, record: nextRecord, tmuxCalls: true };
}

export function persistOutcomePending(
  registryPath: string,
  registry: WorkerRegistry,
  record: AttemptRecord,
  outcome: OutcomeType,
  outcomeBytes: string,
  adapter = getLifecycleAdapter(),
): { registry: WorkerRegistry; record: AttemptRecord } {
  const nextRecord: AttemptRecord = {
    ...record,
    outcome,
    outcomeBytes,
    outcomeDigest: outcomeDigest(record.attemptId, outcomeBytes),
    deliveryState: "pending",
  };
  const next = persistRecord(registryPath, registry, nextRecord, adapter);
  return { registry: next, record: nextRecord };
}

export function persistDeliveryAttempted(
  registryPath: string,
  registry: WorkerRegistry,
  record: AttemptRecord,
  adapter = getLifecycleAdapter(),
): { registry: WorkerRegistry; record: AttemptRecord } {
  const nextRecord: AttemptRecord = { ...record, deliveryState: "attempted" as DeliveryState };
  const next = persistRecord(registryPath, registry, nextRecord, adapter);
  return { registry: next, record: nextRecord };
}

export function applyStartupReceipt(
  registryPath: string,
  registry: WorkerRegistry,
  record: AttemptRecord,
  receipt: { attemptId: string; token: string; piSessionId: string; observed: ModelIdentity },
  adapter = getLifecycleAdapter(),
): { registry: WorkerRegistry; record: AttemptRecord } {
  if (receipt.attemptId !== record.attemptId || receipt.token !== record.completionToken) {
    throw new Error("Startup receipt identity mismatch");
  }
  if (!receipt.piSessionId) throw new Error("Startup receipt missing piSessionId");
  // A resumed attempt already knows the canonical child session UUID from
  // the session file header before the child even starts; the live receipt
  // must match it exactly, or the wrong session was resumed/attached.
  if (record.piSessionId && receipt.piSessionId !== record.piSessionId) {
    throw new Error("Startup receipt session UUID mismatch with expected resumed session");
  }
  const nextRecord: AttemptRecord = {
    ...record,
    piSessionId: receipt.piSessionId,
    observed: receipt.observed,
    resourceState: record.resourceState === "taken_over" ? "taken_over" : "running",
  };
  const next = persistRecord(registryPath, registry, nextRecord, adapter);
  return { registry: next, record: nextRecord };
}

export function markTakenOver(
  registryPath: string,
  registry: WorkerRegistry,
  record: AttemptRecord,
  adapter = getLifecycleAdapter(),
): { registry: WorkerRegistry; record: AttemptRecord } {
  const nextRecord: AttemptRecord = { ...record, resourceState: "taken_over" };
  const next = persistRecord(registryPath, registry, nextRecord, adapter);
  return { registry: next, record: nextRecord };
}

export function canAutoClose(record: AttemptRecord, hasExitReceipt: boolean, hasOutcome: boolean): boolean {
  if (record.resourceState === "taken_over" || record.resourceState === "foreign") return false;
  if (record.resourceState === "closed" || record.resourceState === "released" || record.resourceState === "proven_absent") {
    return false;
  }
  if (!record.surface) return false;
  return hasExitReceipt && hasOutcome;
}

export function requestedObservedMismatch(record: AttemptRecord): string | null {
  if (!record.observed) return null;
  const diffs: string[] = [];
  if (record.requested.provider !== record.observed.provider) {
    diffs.push(`provider requested=${record.requested.provider} observed=${record.observed.provider}`);
  }
  if (record.requested.model !== record.observed.model) {
    diffs.push(`model requested=${record.requested.model} observed=${record.observed.model}`);
  }
  if (record.requested.thinking !== record.observed.thinking) {
    diffs.push(`thinking requested=${record.requested.thinking} observed=${record.observed.thinking}`);
  }
  return diffs.length ? diffs.join("; ") : null;
}

export function diagnoseText(
  load: ReturnType<typeof loadRegistry>,
  records: AttemptRecord[],
): string {
  const lines = [
    "Worker registry diagnostics",
    "Launches are disabled while the registry is invalid. Do not delete the file; repair it manually.",
    "Automatic delivery is at-most-once. Pending/uncertain outcomes are displayed and replayed only by /subagents-replay.",
  ];
  if (load.status === "invalid") {
    lines.push(`Validation error: ${load.error}`);
    lines.push(`File bytes preserved (${load.raw.length} bytes).`);
  } else {
    lines.push(`Registry status: ${load.status}`);
    const lim = load.status === "missing" ? MAX_CHILD_INVOCATIONS : effectiveInvocationLimit(load.registry);
    lines.push(`Invocations: ${load.status === "missing" ? 0 : load.registry.invocations}/${lim === null ? "unlimited (removed for this session)" : lim}`);
    lines.push(`Live resources: ${countLiveResources(records)}/${MAX_LIVE_RESOURCES}`);
  }
  for (const record of records) {
    lines.push(
      `${record.attemptId} name=${record.name} resource=${record.resourceState} outcome=${record.outcome ?? "null"} delivery=${record.deliveryState ?? "none"} surface=${record.surface ?? "none"} session=${record.sessionFile}`,
    );
    if (record.deliveryState === "pending" || record.deliveryState === "attempted") {
      lines.push(`  uncertain delivery (at-most-once); replay with /subagents-replay ${record.attemptId}`);
    }
    if (record.watcherDiagnostic) {
      lines.push(`  watcher diagnostic: ${record.watcherDiagnostic}`);
    }
  }
  return lines.join("\n");
}

export { loadRegistry, RegistryValidationError, LIVE_RESOURCE_STATES, MAX_CHILD_INVOCATIONS, MAX_LIVE_RESOURCES };
export type { LifecycleAdapter };
