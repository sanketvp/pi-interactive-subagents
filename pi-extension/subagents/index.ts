import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { dirname, join } from "node:path";
import { validateLaunch, shouldCloseAfterWatchError } from "./hardening.ts";
import { randomUUID } from "node:crypto";
import {
  type AttemptRecord,
  type WorkerRegistry,
  countLiveResources,
  effectiveInvocationLimit,
  loadRegistry,
} from "./registry.ts";
import {
  applyRecovery,
  applyStartupReceipt,
  assertCanLaunch,
  canAutoClose,
  canonicalizeSessionFile,
  classifySocket,
  closeOwned,
  currentTmuxSocket,
  currentWindowId,
  diagnoseText,
  dispatcherPath,
  freezePaneStartCommand,
  invokeSplit,
  LIVE_RESOURCE_STATES,
  markTakenOver,
  persistDeliveryAttempted,
  persistOutcomePending,
  persistPreparingIntent,
  persistRecord,
  persistRegistry,
  persistSplitRequested,
  readPaneToken,
  readSessionHeaderId,
  recoverSurface,
  releaseWithoutClose,
  requestedObservedMismatch,
  writeLaunchScript,
} from "./lifecycle.ts";
import { getLifecycleAdapter, setLifecycleAdapter } from "./adapter.ts";
import {
  validateCompletion,
  validateExitReceipt,
  validateStartupReceipt,
} from "./completion.mjs";
import { fileURLToPath } from "node:url";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  sendLongCommand,
  pollForExit,
  closeSurface as closeMuxSurface,
  claimSurface,
  getMuxBackend,
  sendEscape,
  shellEscape,
  renameCurrentTab,
  renameWorkspace,
  readScreen,
} from "./cmux.ts";

import {
  findLastAssistantMessage,
  findLastToolResultText,
  getNewEntries,
  seedSubagentSessionFile,
} from "./session.ts";
import {
  type StatusSnapshot,
  type SubagentStatusState,
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
} from "./status.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
import {
  checkerPromptPrefix,
  resolveDispatchRoute,
  type RoutingAuthor,
  type RoutingResolution,
} from "./routing.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads ~/.pi/agent/agents/<name>.md for model, tools, skills.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Appended to system prompt (role instructions)" }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills (overrides agent default)" }),
  ),
  tools: Type.Optional(
    Type.String({ description: "Comma-separated tools (overrides agent default)" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Force the full-context fork mode for this spawn. The sub-agent inherits the current session conversation, overriding any agent frontmatter session-mode.",
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Mark the subagent as interactive (long-running, user drives the conversation in its own pane). When true, the main session is not woken by status transitions (stalled/recovered) for this subagent. If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit` (agents that auto-exit are autonomous and get stall pings; agents that don't are interactive and stay quiet).",
    }),
  ),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        "Resume a previous Claude Code session by its ID. Loads the conversation history and continues where it left off. The session ID is returned in details of every claude tool call. Use this to retry cancelled runs or ask follow-up questions.",
    }),
  ),
  routing: Type.Optional(
    Type.Object({
      taskClass: Type.String({
        description:
          "Deterministic route: general-implementation, complex-alternate, large-context, mechanical-bulk, surgical, economy-fanout, high-risk-planning, or tiny-edit.",
      }),
      stage: Type.String({ description: "Route stage: author, checker, or runner." }),
      authorAttemptId: Type.Optional(
        Type.String({ description: "Completed author attempt ID. Required for non-tiny checker and runner dispatches." }),
      ),
    }),
  ),
});

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagent_interrupt",
  "subagents_list",
  "subagent_resume",
]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

function getPackageConfigPath(): string {
  return join(SUBAGENTS_DIR, "../../config.json");
}

interface DiscoverAgentDefinitionOptions {
  hideBundledAgents?: boolean;
  configPath?: string;
}

/** Read `hideBundledAgents` from package `config.json`. Missing/invalid config → false. */
function readHideBundledAgents(configPath = getPackageConfigPath()): boolean {
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    return (
      raw != null &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      (raw as Record<string, unknown>).hideBundledAgents === true
    );
  } catch {
    return false;
  }
}

/** Drop package-bundled entries when `hideBundledAgents` is true. Override-shadowing is applied first. */
function filterListedAgents(
  agents: ListedAgentDefinition[],
  options: { hideBundledAgents?: boolean } = {},
): ListedAgentDefinition[] {
  if (options.hideBundledAgents !== true) return agents;
  return agents.filter((agent) => agent.source !== "package");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
    spawning: parseOptionalBoolean(getFrontmatterValue(frontmatter, "spawning")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

function discoverAgentDefinitions(
  options: DiscoverAgentDefinitionOptions = {},
): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    ...(process.env.PI_INTERACTIVE_TRUST_PROJECT_AGENTS === "1" ? [{ path: join(process.cwd(), ".pi", "agents"), source: "project" as AgentSource }] : []),
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  const hideBundledAgents =
    options.hideBundledAgents ?? readHideBundledAgents(options.configPath);
  return filterListedAgents([...agents.values()], { hideBundledAgents });
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  // A repository must not silently replace the child's global configuration/auth root.
  const localAgentDir = null;
  const effectiveAgentDir = getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` tool parameter wins.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, worker, reviewer) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (planner, iterate/fork) and
 *      stall pings are noise.
 *
 * When no agent defs exist at all (bare `subagent({ name, task })` call,
 * typical for `/iterate` with `fork: true`), `autoExit` is undefined and the
 * subagent is treated as interactive — matching the intent of iterate.
 */
function resolveEffectiveInteractive(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const configDir = getAgentConfigDir();
  const paths = [
    ...(process.env.PI_INTERACTIVE_TRUST_PROJECT_AGENTS === "1" ? [join(process.cwd(), ".pi", "agents", `${agentName}.md`)] : []),
    join(configDir, "agents", `${agentName}.md`),
    join(getBundledAgentsDir(), `${agentName}.md`),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }

  return null;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`,
      },
    ],
    details: { error: "mux not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

const statusConfig = loadStatusConfig();

function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage"
  >,
  name: string,
): string {
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
    : "";

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_resume.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  ping?: { name: string; message: string };
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  completionFile?: string;
  completionToken?: string;
  tmuxSocket?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  cli?: string;
  sentinelFile?: string;
  statusState: SubagentStatusState;
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
  attempt?: AttemptRecord;
  watcherGeneration?: number;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();
let registryFile: string | undefined;
let registryReady = false;
let invocationCount = 0;
let workerRegistry: WorkerRegistry = { version: 1, invocations: 0, workers: [] };
let registryValidationError: string | null = null;
let registryRawBytes: Buffer | null = null;
let watcherGeneration = 0;
function persistWorkers() {
  if (!registryFile || !registryReady) return;
  persistRegistry(registryFile, { ...workerRegistry, invocations: invocationCount });
}
/**
 * Per-session invocation limit control. The default budget (12) can be raised,
 * lowered, or removed for THIS session only, and only through an explicit
 * user answer in the TUI — never by the model. Persisted in workers.json so it
 * survives /reload and resume.
 */
function currentLimitLabel(): string {
  const lim = effectiveInvocationLimit(workerRegistry);
  return lim === null ? "no limit (removed for this session)" : `${lim}`;
}
function setInvocationLimit(next: number | null): void {
  workerRegistry = { ...workerRegistry, invocationLimit: next };
  persistWorkers();
  updateWidget();
}
async function promptInvocationLimit(ctx: ExtensionContext, why: string): Promise<boolean> {
  if (ctx.mode !== "tui" || !ctx.ui?.select) return false;
  const used = invocationCount;
  const choice = await ctx.ui.select(
    `${why}\nUsed ${used} of ${currentLimitLabel()} subagent invocations this session. What do you want to do?`,
    [
      "Raise by 4",
      "Raise by 12",
      "Set a specific limit…",
      "Remove the limit for this session (permanent)",
      "Keep the limit — do not launch",
    ],
  );
  if (!choice || choice.startsWith("Keep")) return false;
  const lim = effectiveInvocationLimit(workerRegistry);
  const base = lim === null ? used : Math.max(lim, used);
  if (choice === "Raise by 4") setInvocationLimit(base + 4);
  else if (choice === "Raise by 12") setInvocationLimit(base + 12);
  else if (choice.startsWith("Remove")) {
    const sure = await ctx.ui.confirm("Remove the invocation limit for this session?", "Permanent for this session (until you set a new limit with /subagent-limit).");
    if (!sure) return false;
    setInvocationLimit(null);
  } else {
    const raw = await ctx.ui.input("New invocation limit for this session", `> ${used}`);
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= used) { ctx.ui.notify(`Limit must be an integer greater than ${used}; unchanged.`, "warning"); return false; }
    setInvocationLimit(n);
  }
  ctx.ui.notify(`Subagent invocation limit for this session: ${currentLimitLabel()}`, "info");
  return true;
}
async function withLaunchReservation<T>(launch: () => Promise<T>, ctx?: ExtensionContext): Promise<T> {
  if (!registryReady) throw new Error("Worker registry is not initialized or failed validation; refusing launch");
  if (process.env.PI_SUBAGENT_ID) throw new Error("Nested worker spawning is disabled");
  try {
    assertCanLaunch({ ...workerRegistry, invocations: invocationCount });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    // Only the invocation budget is user-adjustable; the live-worker cap is not.
    if (!/Invocation budget reached/.test(msg) || !ctx) throw err;
    const raised = await promptInvocationLimit(ctx, "The subagent invocation budget for this session is used up.");
    if (!raised) throw new Error(`${msg} The user chose to keep the limit; do not retry the launch.`);
    assertCanLaunch({ ...workerRegistry, invocations: invocationCount });
  }
  return await launch();
}

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const pending = agent.attempt?.deliveryState ? ` ${agent.attempt.deliveryState}` : "";
    const state = agent.attempt?.resourceState ? ` ${agent.attempt.resourceState}` : "";
    const left = ` ${elapsed}  ${agent.name}${agentTag}${state}${pending} `;
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const right = statusConfig.enabled
      ? formatWidgetRightLabel(snapshot)
      : agent.cli === "claude"
        ? " running… "
        : " starting… ";

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (registryValidationError) {
    latestCtx.ui.setWidget(
      "subagent-status",
      (_tui: any, _theme: any) => ({
        invalidate() {},
        render(_width: number) {
          return ["worker registry invalid — launches disabled", "Use /subagents-diagnose. File left byte-for-byte untouched."];
        },
      }),
      { placement: "aboveEditor" },
    );
    return;
  }

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
const SUBAGENT_CONTROL_TOOLS = ["caller_ping", "subagent_done"] as const;

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tools from subagent-done.ts would otherwise be hidden, leaving a
 * manually resumed or user-touched subagent unable to call subagent_done.
 */
function buildSubagentToolAllowlist(effectiveTools?: string): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  if (requested.length === 0) return null;

  const allow = new Set(requested);
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [
    ...(needsSeparator ? [""] : []),
    ...skillPrompts,
    params.taskArg,
  ];
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  if (running.cli === "claude") return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok) {
    running.activity = read.activity;
    running.statusState = observeStatus(running.statusState, {
      snapshot: "present",
      updatedAt: read.activity.updatedAt,
      sequence: read.activity.sequence,
      phase: read.activity.phase,
      active: read.activity.phase === "active",
      activeScope: read.activity.activeScope,
      activeSince: read.activity.activeSince,
      waitingSince: read.activity.waitingSince,
      latestEvent: read.activity.latestEvent,
      activityLabel: activityLabel(read.activity),
    }, observedAt);
    return;
  }

  running.statusState = observeStatus(running.statusState, {
    snapshot: read.reason,
    snapshotError: read.error,
  }, observedAt);
}

function resolveInterruptTarget(params: { id?: string; name?: string }):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedId = params.id?.trim();
  if (requestedId) {
    const running = runningSubagents.get(requestedId);
    return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
  }

  const requestedName = params.name?.trim();
  if (!requestedName) {
    return { error: "Provide a running subagent id or exact display name." };
  }

  const matches = Array.from(runningSubagents.values()).filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    return { error: `No running subagent named "${requestedName}".` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

/**
 * Interrupt must only ever send Escape to an exact, currently owned tmux
 * pane (`%N`) on the CURRENT tmux socket. An empty, malformed, or
 * foreign-socket surface must never reach `sendEscapeKey` -- e.g. an empty
 * string target on tmux's `send-keys` falls back to the default/active
 * pane, which could hit an unrelated pane.
 */
function isExactOwnedSurface(running: RunningSubagent): boolean {
  const surface = running.surface;
  if (!surface || !/^%\d+$/.test(surface)) return false;
  const socket = running.attempt?.tmuxSocket ?? running.tmuxSocket;
  if (!socket) return false;
  const current = currentTmuxSocket();
  if (!current || socket !== current) return false;
  // `%N` format + matching socket alone is NOT proof of current ownership:
  // tmux pane ids can be reused/collide across separate tmux server
  // processes bound to the same socket path over time, and a stale/foreign
  // record could otherwise target a pane that is no longer (or never was)
  // this attempt's pane. Require the pane's live @pi-worker-token tag to
  // match the record's completionToken -- the same ownership proof already
  // required before releasing or closing a pane (readPaneToken/killOwnedPane).
  const token = running.attempt?.completionToken ?? running.completionToken;
  if (!token) return false;
  try {
    return readPaneToken(socket, surface, getLifecycleAdapter()) === token;
  } catch {
    return false;
  }
}

function requestSubagentInterrupt(
  running: RunningSubagent,
  sendEscapeKey: (surface: string) => void = sendEscape,
): { ok: true } | { error: string } {
  if (!isExactOwnedSurface(running)) {
    return {
      error:
        `Refusing to interrupt subagent "${running.name}": no exact owned tmux surface on the ` +
        `current socket (surface=${JSON.stringify(running.surface)}). No tmux command was issued.`,
    };
  }
  try {
    sendEscapeKey(running.surface);
    return { ok: true };
  } catch (error: any) {
    const backend = getMuxBackend() ?? "unknown";
    return {
      error:
        `Failed to send Escape to subagent "${running.name}" via ${backend}: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  sendEscapeKey: (surface: string) => void = sendEscape,
) {
  const resolved = resolveInterruptTarget(params);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  if (running.cli === "claude") {
    return {
      content: [{
        type: "text" as const,
        text:
          "Turn-only Escape interrupt is currently supported only for Pi-backed subagents. Claude-backed semantics have not been verified yet.",
      }],
      details: { error: "claude interrupt unsupported", id: running.id, name: running.name },
    };
  }

  const now = Date.now();
  observeRunningSubagent(running, now);

  const interruption = requestSubagentInterrupt(running, sendEscapeKey);
  if ("error" in interruption) {
    return {
      content: [{ type: "text" as const, text: interruption.error }],
      details: { error: interruption.error, id: running.id, name: running.name },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  updateWidget();

  return {
    content: [{ type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` }],
    details: { id: running.id, name: running.name, status: "interrupt_requested" },
  };
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!statusConfig.enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive) {
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

function resolveResumeLaunchBehavior(params: { autoExit?: boolean }): { autoExit: boolean; interactive: boolean } {
  const autoExit = params.autoExit ?? true;
  return { autoExit, interactive: !autoExit };
}

function requireTuiParent(ctx: { mode?: string }): void {
  if (ctx.mode !== "tui") {
    throw new Error('Worker launches require a TUI parent (ctx.mode === "tui")');
  }
}

function currentCoordinatorAuthor(ctx: {
  model?: { provider?: string; id?: string };
  sessionManager: { getSessionId(): string };
}): RoutingAuthor {
  const provider = ctx.model?.provider;
  const model = ctx.model?.id;
  const sessionId = ctx.sessionManager.getSessionId();
  if (!provider || !model || !sessionId) {
    throw new Error("Routing refused: current coordinator model/session identity is unavailable");
  }
  return { source: "coordinator", sessionId, profile: "coordinator", model: `${provider}/${model}` };
}

function completedAuthor(
  attemptId: string | undefined,
  registry: WorkerRegistry,
): RoutingAuthor {
  if (!attemptId) throw new Error("Routing refused: checker requires authorAttemptId");
  const attempt = registry.workers.find((worker) => worker.attemptId === attemptId);
  if (!attempt) throw new Error(`Routing refused: author attempt '${attemptId}' was not found`);
  if (attempt.outcome !== "done" || !attempt.observed || !attempt.piSessionId || !attempt.agent) {
    throw new Error(`Routing refused: author attempt '${attemptId}' has no completed observed identity`);
  }
  return {
    source: "attempt",
    attemptId,
    sessionId: attempt.piSessionId,
    profile: attempt.agent,
    model: `${attempt.observed.provider}/${attempt.observed.model}`,
  };
}

function profileModel(profile: string): string | undefined {
  return loadAgentDefaults(profile)?.model;
}

function resolveSubagentRouting(
  params: Static<typeof SubagentParams>,
  ctx: {
    model?: { provider?: string; id?: string };
    sessionManager: { getSessionId(): string };
  },
  registry: WorkerRegistry,
): { params: Static<typeof SubagentParams>; resolution?: RoutingResolution } {
  if (!params.routing) return { params };
  const { taskClass, stage, authorAttemptId } = params.routing;
  const currentAuthor = currentCoordinatorAuthor(ctx);
  // tiny-edit has no automatic checker (see routing.ts); let resolveDispatchRoute
  // reject it there with a clear message instead of failing on a missing attemptId here.
  const author =
    (stage === "checker" || stage === "runner") && taskClass !== "tiny-edit" ? completedAuthor(authorAttemptId, registry) : undefined;
  const resolution = resolveDispatchRoute(
    {
      taskClass,
      stage,
      requestedAgent: params.agent,
      requestedModel: params.model,
      author,
      currentAuthor,
    },
    profileModel,
  );
  if (!resolution.launch) return { params, resolution };
  const task =
    resolution.stage === "checker"
      ? `${checkerPromptPrefix(resolution)}\n\n${params.task}`
      : params.task;
  return {
    params: { ...params, agent: resolution.profile, model: resolution.model, task },
    resolution,
  };
}

function requestedIdentity(
  params: { model?: string },
  agentDefs: AgentDefaults | null,
  ctx: { model?: { provider?: string; id?: string }; thinkingLevel?: string },
): { provider: string; model: string; thinking: string } {
  const raw = params.model ?? agentDefs?.model;
  let provider: string | undefined;
  let model: string | undefined;
  if (raw && raw.includes("/")) {
    const idx = raw.indexOf("/");
    provider = raw.slice(0, idx);
    model = raw.slice(idx + 1);
  } else if (raw) {
    model = raw;
  }
  provider = provider || ctx.model?.provider;
  model = model || ctx.model?.id;
  const thinking = agentDefs?.thinking || ctx.thinkingLevel || "off";
  if (!provider || !model) {
    throw new Error("Cannot record requested provider/model; ctx.model fields unavailable");
  }
  return { provider, model, thinking: String(thinking) };
}

function buildDispatcherArgs(options: {
  provider: string;
  model: string;
  thinking: string;
  sessionFile: string;
  extensionPath: string;
  repo: string;
  tools?: string | null;
  promptArgs: string[];
  /** "replace" -> --system-prompt <path>; "append" -> --append-system-prompt <path>. */
  systemPromptFlag?: "replace" | "append" | null;
  systemPromptPath?: string | null;
}): string[] {
  const args = [
    "--interactive",
    "--provider",
    options.provider,
    "--model",
    options.model,
    "--effort",
    options.thinking,
    "--session",
    options.sessionFile,
    "-e",
    options.extensionPath,
    "--repo",
    options.repo,
  ];
  if (options.tools) {
    args.push("--tools", options.tools);
  }
  if (options.systemPromptFlag && options.systemPromptPath) {
    args.push(
      options.systemPromptFlag === "replace" ? "--system-prompt" : "--append-system-prompt",
      options.systemPromptPath,
    );
  }
  args.push("--", ...options.promptArgs);
  return args;
}

function runningFromAttempt(
  record: AttemptRecord,
  extras: Partial<RunningSubagent> = {},
): RunningSubagent {
  return {
    id: record.attemptId,
    name: record.name,
    task: record.task,
    agent: record.agent,
    surface: record.surface ?? "",
    startTime: record.createdAt,
    sessionFile: record.sessionFile,
    launchScriptFile: record.launchScriptFile,
    completionFile: record.completionFile,
    completionToken: record.completionToken,
    tmuxSocket: record.tmuxSocket,
    interactive: !!record.interactive,
    statusState: createStatusState({ source: "pi", startTimeMs: record.createdAt }),
    attempt: record,
    ...extras,
  };
}

function syncAttempt(running: RunningSubagent, record: AttemptRecord): void {
  running.attempt = record;
  running.id = record.attemptId;
  running.surface = record.surface ?? "";
  running.sessionFile = record.sessionFile;
  running.completionFile = record.completionFile;
  running.completionToken = record.completionToken;
  running.tmuxSocket = record.tmuxSocket;
}

function commitRegistry(next: WorkerRegistry, record?: AttemptRecord, running?: RunningSubagent): void {
  workerRegistry = { ...next, invocations: next.invocations };
  invocationCount = next.invocations;
  if (record && running) syncAttempt(running, record);
}

function readJsonFile(path: string): any | null {
  try {
    return JSON.parse(getLifecycleAdapter().fs.readFileSync(path, "utf8") as string);
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  filterListedAgents,
  readHideBundledAgents,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  formatWidgetRightLabel,
  observeRunningSubagent,
  resolveDenyTools,
  resolveInterruptTarget,
  requestSubagentInterrupt,
  handleSubagentInterrupt,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  resolveSubagentRouting,
  runningSubagents,
  formatElapsed,
  setLifecycleAdapter,
  requestedIdentity,
  buildDispatcherArgs,
  requireTuiParent,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(...args: Parameters<typeof launchSubagentImpl>): Promise<RunningSubagent> {
  // args[1] is the ExtensionContext for the launching tool call.
  return withLaunchReservation(() => launchSubagentImpl(...args), args[1] as ExtensionContext | undefined);
}
async function launchSubagentImpl(
  params: typeof SubagentParams.static,
  ctx: {
    mode?: string;
    cwd: string;
    model?: { provider?: string; id?: string };
    thinkingLevel?: string;
    sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string };
  },
  _options?: { surface?: string },
): Promise<RunningSubagent> {
  requireTuiParent(ctx);
  validateLaunch(params, null, !!process.env.PI_SUBAGENT_ID);
  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  validateLaunch(params, agentDefs);
  if (getMuxBackend() !== "tmux") throw new Error("This hardened fork requires tmux; no backend fallback is allowed");
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);
  const requested = requestedIdentity(params, agentDefs, ctx);
  const adapter = getLifecycleAdapter();
  const tmuxSocket = currentTmuxSocket();
  const parentPane = process.env.TMUX_PANE;
  if (!tmuxSocket || !parentPane) throw new Error("tmux socket/window identity is required");
  const windowId = currentWindowId(tmuxSocket, parentPane, adapter);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const parentSessionId = ctx.sessionManager.getSessionId();
  if (!parentSessionId) throw new Error("Parent session UUID unavailable");
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), parentSessionId);

  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);
  const attemptId = randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const subagentSessionFile = join(sessionDir, `${timestamp}_${attemptId}.jsonl`);

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, attemptId);
  const completionFile = join(artifactDir, "completions", `${attemptId}.json`);
  mkdirSync(dirname(activityFile), { recursive: true, mode: 0o700 });
  const { inheritsConversationContext } = launchBehavior;

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions and artifact-backed handoff.
  const modeHint = agentDefs?.autoExit
    ? "Complete your task autonomously."
    : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const summaryInstruction = agentDefs?.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
  const denySet = resolveDenyTools(agentDefs);
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = inheritsConversationContext
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;
  let systemPromptFlag: "replace" | "append" | null = null;
  let systemPromptPath: string | null = null;
  if (identityInSystemPrompt && identity) {
    systemPromptFlag = systemPromptMode === "replace" ? "replace" : "append";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const syspromptPath = join(artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
    mkdirSync(dirname(syspromptPath), { recursive: true, mode: 0o700 });
    writeFileSync(syspromptPath, identity, "utf8");
    systemPromptPath = syspromptPath;
  }

  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools);
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const taskTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const artifactPath = join(artifactDir, `context/${safeName || "subagent"}-${taskTimestamp}.md`);
    mkdirSync(dirname(artifactPath), { recursive: true, mode: 0o700 });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
  }
  const promptArgs = buildPiPromptArgs({
    effectiveSkills,
    taskDelivery: launchBehavior.taskDelivery,
    taskArg,
  });
  const launchScriptFile = join(artifactDir, "subagent-scripts", `subagent-${attemptId}.sh`);
  if (!registryFile) throw new Error("Worker registry path is not initialized");
  const began = persistPreparingIntent({
    registryPath: registryFile,
    registry: { ...workerRegistry, invocations: invocationCount },
    attemptId,
    name: params.name,
    task: params.task,
    agent: params.agent,
    title: params.name,
    repository: targetCwdForSession,
    parentSessionId,
    sessionFile: subagentSessionFile,
    launchScriptFile,
    completionFile,
    tmuxSocket,
    windowId,
    requested,
    interactive: effectiveInteractive,
    paneStartCommand: freezePaneStartCommand(launchScriptFile),
  }, adapter);
  commitRegistry(began.registry, began.record);
  const env: Record<string, string> = {
    PI_SUBAGENT_NAME: params.name,
    PI_SUBAGENT_SESSION: subagentSessionFile,
    PI_SUBAGENT_COMPLETION_FILE: completionFile,
    PI_SUBAGENT_TOKEN: began.record.completionToken,
    PI_SUBAGENT_ID: began.record.attemptId,
    PI_SUBAGENT_ACTIVITY_FILE: activityFile,
  };
  if (params.agent) env.PI_SUBAGENT_AGENT = params.agent;
  if (agentDefs?.autoExit) env.PI_SUBAGENT_AUTO_EXIT = "1";
  if (denySet.size > 0) env.PI_DENY_TOOLS = [...denySet].join(",");
  if (localAgentDir && existsSync(localAgentDir)) env.PI_CODING_AGENT_DIR = localAgentDir;
  else if (process.env.PI_CODING_AGENT_DIR) env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
  const dispatcherArgs = buildDispatcherArgs({
    provider: requested.provider,
    model: requested.model,
    thinking: requested.thinking,
    sessionFile: subagentSessionFile,
    extensionPath: join(SUBAGENTS_DIR, "subagent-done.ts"),
    repo: targetCwdForSession,
    tools: toolAllowlist,
    promptArgs,
    systemPromptFlag,
    systemPromptPath,
  });
  writeLaunchScript({
    scriptPath: launchScriptFile,
    attemptId: began.record.attemptId,
    token: began.record.completionToken,
    socket: tmuxSocket,
    dispatcher: dispatcherPath(),
    dispatcherArgs,
    env,
    cwd: effectiveCwd ?? undefined,
    preamble: [`Subagent launch script for ${params.name}`, `Session: ${subagentSessionFile}`].join("\n"),
  }, adapter);
  const splitReady = persistSplitRequested(registryFile, began.registry, began.record, freezePaneStartCommand(launchScriptFile), adapter);
  commitRegistry(splitReady.registry, splitReady.record);
  const launched = invokeSplit(registryFile, splitReady.registry, splitReady.record, adapter);
  commitRegistry(launched.registry, launched.record);
  const running = runningFromAttempt(launched.record, { activityFile, watcherGeneration });
  runningSubagents.set(running.id, running);
  return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
const CLAUDE_SESSIONS_DIR = join(
  process.env.HOME ?? "/tmp",
  ".pi", "agent", "sessions", "claude-code",
);

function copyClaudeSession(sentinelFile: string): string | null {
  try {
    const transcriptFile = sentinelFile + ".transcript";
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
    const filename = transcriptPath.split("/").pop() ?? `claude-${Date.now()}.jsonl`;
    const dest = join(CLAUDE_SESSIONS_DIR, filename);
    copyFileSync(transcriptPath, dest);
    return filename;
  } catch {
    return null;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function authenticatedPresentation(summary: string): string {
  return `reported outcome (authenticated, unverified)\n${summary}`;
}

function watcherIsCurrent(running: RunningSubagent): boolean {
  return running.watcherGeneration === watcherGeneration && registryReady && !!registryFile;
}

function deliverAuthenticatedOutcome(
  pi: ExtensionAPI,
  running: RunningSubagent,
  record: AttemptRecord,
  data: any,
): AttemptRecord {
  if (!registryFile || !watcherIsCurrent(running)) return record;
  if (record.deliveryState === "attempted") return record;
  const outcomeBytes = JSON.stringify(data);
  if (record.deliveryState !== "pending") {
    const pending = persistOutcomePending(registryFile, workerRegistry, record, data.type, outcomeBytes);
    commitRegistry(pending.registry, pending.record, running);
    record = pending.record;
  }
  if (!watcherIsCurrent(running) || record.deliveryState !== "pending") return record;
  const elapsed = Math.floor((getLifecycleAdapter().now() - record.createdAt) / 1000);
  const sessionFile = record.sessionFile;
  // Summary precedence: explicit `summary` from subagent_done -> last assistant
  // text -> last tool result (models like K3/GLM often call subagent_done
  // straight after a tool call without writing prose) -> placeholder.
  const explicitSummary = typeof data.summary === "string" && data.summary.trim() ? data.summary.trim() : null;
  const entries = !data.errorMessage && existsSync(sessionFile) ? getNewEntries(sessionFile, 0) : [];
  const summary = data.errorMessage
    ? `Subagent error: ${data.errorMessage}`
    : explicitSummary
      ?? findLastAssistantMessage(entries)
      ?? (findLastToolResultText(entries) ? `(no final message; last tool output)\n${findLastToolResultText(entries)}` : null)
      ?? "Sub-agent exited without output";
  if (data.type === "ping") {
    pi.sendMessage(
      {
        customType: "subagent_ping",
        content: authenticatedPresentation(
          `Sub-agent "${data.name ?? record.name}" needs help (${formatElapsed(elapsed)}):\n\n${data.message ?? ""}\n\nSession: ${sessionFile}`,
        ),
        display: true,
        details: {
          name: data.name ?? record.name,
          message: data.message,
          sessionFile,
          attemptId: record.attemptId,
          unverified: true,
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  } else {
    const result = {
      name: record.name,
      task: record.task,
      summary,
      sessionFile,
      exitCode: data.type === "error" ? 1 : 0,
      elapsed,
      errorMessage: data.errorMessage,
    };
    pi.sendMessage(
      {
        customType: "subagent_result",
        content: authenticatedPresentation(resolveResultPresentation(result, record.name)),
        display: true,
        details: {
          name: record.name,
          task: record.task,
          agent: record.agent,
          exitCode: result.exitCode,
          elapsed,
          sessionFile,
          attemptId: record.attemptId,
          parentSessionId: record.parentSessionId,
          piSessionId: record.piSessionId,
          unverified: true,
          ...(data.errorMessage ? { errorMessage: data.errorMessage } : {}),
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }
  if (!watcherIsCurrent(running)) return record;
  const attempted = persistDeliveryAttempted(registryFile, workerRegistry, record);
  commitRegistry(attempted.registry, attempted.record, running);
  return attempted.record;
}

function attachWatcher(running: RunningSubagent, pi: ExtensionAPI): void {
  const watcherAbort = new AbortController();
  running.abortController = watcherAbort;
  running.watcherGeneration = watcherGeneration;
  void watchSubagent(running, AbortSignal.any([watcherAbort.signal, getModuleAbortSignal()]), pi)
    .then(() => {
      if (!watcherIsCurrent(running) || watcherAbort.signal.aborted) return;
      updateWidget();
    })
    .catch(() => {
      if (!watcherIsCurrent(running)) return;
      updateWidget();
    });
}

async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
  pi: ExtensionAPI,
): Promise<SubagentResult> {
  const name = running.name;
  const task = running.task;
  const startTime = running.startTime;
  const sessionFile = running.sessionFile;
  let record = running.attempt;
  if (!record || !running.completionFile || !registryFile) {
    return {
      name,
      task,
      summary: "Watcher detached; worker pane retained. This is not a task completion.",
      exitCode: 1,
      elapsed: 0,
      error: "cancelled",
      sessionFile,
    };
  }
  const foreign = classifySocket(record, currentTmuxSocket()) === "foreign";
  let sawExit = false;
  try {
    while (!signal.aborted && watcherIsCurrent(running)) {
      record = running.attempt ?? record;
      if (existsSync(`${running.completionFile}.user-owned`) && record.resourceState !== "taken_over") {
        const next = markTakenOver(registryFile, workerRegistry, record);
        commitRegistry(next.registry, next.record, running);
        record = next.record;
      }
      const identity = {
        attemptId: record.attemptId,
        token: record.completionToken,
        sessionFile: record.sessionFile,
        piSessionId: record.piSessionId ?? undefined,
      };
      const start = readJsonFile(`${running.completionFile}.start`);
      // Gate on `!record.observed`, not `!record.piSessionId`: a resumed
      // attempt already knows its expected piSessionId BEFORE the child
      // reports its live startup receipt (persisted from the canonical
      // session-file header at launch time), so `piSessionId` alone can't
      // distinguish "already observed" from "expected but not yet observed".
      if (start && !record.observed) {
        const receipt = validateStartupReceipt(start, identity);
        const next = applyStartupReceipt(registryFile, workerRegistry, record, {
          attemptId: receipt.attemptId,
          token: receipt.token,
          piSessionId: receipt.piSessionId,
          observed: receipt.observed,
        });
        commitRegistry(next.registry, next.record, running);
        record = next.record;
        const mismatch = requestedObservedMismatch(record);
        if (mismatch) latestCtx?.ui.notify(`Worker ${record.name} requested vs observed: ${mismatch}`, "warning");
      }
      // Rebuild expectations from the (possibly just-updated) record. Once a
      // startup receipt has been observed the child UUID is established and
      // every later receipt (error or shell-exit) must bind to it exactly.
      // Only pre-start shell errors may omit the UUID.
      const postStart = {
        attemptId: record.attemptId,
        token: record.completionToken,
        sessionFile: record.sessionFile,
        piSessionId: record.piSessionId ?? undefined,
        requirePiSessionId: record.observed !== null,
      };
      const completion = readJsonFile(running.completionFile);
      if (completion && record.outcome == null) {
        validateCompletion(completion, postStart);
        record = deliverAuthenticatedOutcome(pi, running, record, completion);
      }
      const exit = readJsonFile(`${running.completionFile}.exit`);
      if (exit) {
        validateExitReceipt(exit, postStart);
        sawExit = true;
      }
      if (!foreign && canAutoClose(record, sawExit, record.outcome != null)) {
        try {
          const closed = closeOwned(registryFile, workerRegistry, record);
          commitRegistry(closed.registry, closed.record, running);
          runningSubagents.delete(running.id);
          break;
        } catch {
          // Token mismatch or unreachable socket: retain. BUT if the pane is
          // provably gone from its recorded window (the worker shell exited
          // on its own and tmux reaped the pane -- the normal case once an
          // authenticated exit receipt exists), record it as `proven_absent`
          // and stop, instead of retrying kill-pane every poll forever.
          const recovered = recoverSurface(record);
          if (recovered.kind === "proven_absent") {
            const absent: AttemptRecord = { ...record, resourceState: "proven_absent" };
            const next = persistRecord(registryFile, workerRegistry, absent);
            commitRegistry(next, absent, running);
            record = absent;
            runningSubagents.delete(running.id);
            break;
          }
        }
      }
      if ((foreign || record.resourceState === "taken_over") && record.outcome && sawExit) break;
      observeRunningSubagent(running);
      await sleep(250, signal);
    }
  } catch (err: any) {
    void shouldCloseAfterWatchError();
    if (signal.aborted || getModuleAbortSignal().aborted || !watcherIsCurrent(running)) {
      return {
        name,
        task,
        summary: "Watcher detached; worker pane retained. This is not a task completion.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
        sessionFile,
      };
    }
    // A genuine (non-cancellation) watcher failure -- a malformed/parse or
    // authentication-mismatch completion/startup/exit record -- must be
    // durably persisted as `unknown` with a diagnostic, not just returned as
    // an in-memory error. Otherwise the registry silently keeps stale state
    // and `/subagents-diagnose` has nothing to show. The resource is NEVER
    // closed from this path.
    const diagnostic = err?.message ?? String(err);
    // Persist for every live state, including an already-`unknown` record, so a
    // later receipt-authentication failure is never silently dropped.
    if (registryFile && LIVE_RESOURCE_STATES.has(record.resourceState)) {
      try {
        const nextRecord: AttemptRecord = { ...record, resourceState: "unknown", watcherDiagnostic: diagnostic };
        const next = persistRecord(registryFile, workerRegistry, nextRecord);
        commitRegistry(next, nextRecord, running);
      } catch {
        // Registry write itself failing is reported via the returned error below.
      }
    }
    return {
      name,
      task,
      summary: `Subagent error: ${diagnostic}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: diagnostic,
      sessionFile,
    };
  }
  return {
    name,
    task,
    summary: record.outcome
      ? authenticatedPresentation(String(record.outcome))
      : "Watcher detached; worker pane retained. This is not a task completion.",
    sessionFile,
    exitCode: record.outcome === "error" ? 1 : 0,
    elapsed: Math.floor((Date.now() - startTime) / 1000),
  };
}
export default function subagentsExtension(pi: ExtensionAPI) {
  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    watcherGeneration += 1;
    registryReady = false;
    registryValidationError = null;
    registryRawBytes = null;
    runningSubagents.clear();
    registryFile = join(getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId()), "workers.json");
    const loaded = loadRegistry(registryFile);
    if (loaded.status === "invalid") {
      registryRawBytes = loaded.raw;
      registryValidationError = loaded.error;
      registryReady = false;
      ctx.ui.notify("worker registry invalid — launches disabled", "error");
      updateWidget();
      return;
    }
    workerRegistry = loaded.registry;
    invocationCount = loaded.registry.invocations;
    registryReady = true;
    const currentSocket = currentTmuxSocket();
    for (const original of loaded.registry.workers) {
      const recovered = applyRecovery(registryFile, workerRegistry, original, currentSocket);
      commitRegistry(recovered.registry, recovered.record);
      const record = recovered.record;
      if (record.resourceState === "closed" || record.resourceState === "released" || record.resourceState === "proven_absent") {
        continue;
      }
      const running = runningFromAttempt(record, { watcherGeneration });
      runningSubagents.set(running.id, running);
      if (classifySocket(record, currentSocket) === "foreign") {
        ctx.ui.notify(`Worker ${record.name} retained on another tmux socket; completion-only recovery (no tmux calls).`, "warning");
      }
      if (record.deliveryState === "pending" || record.deliveryState === "attempted") {
        ctx.ui.notify(`Worker ${record.name} has a pending/uncertain reported outcome (authenticated, unverified). Replay with /subagents-replay ${record.attemptId}.`, "warning");
      }
      attachWatcher(running, pi);
    }
    if (runningSubagents.size || registryValidationError) { startWidgetRefresh(); startStatusRefresh(pi); }
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (_event, _ctx) => {
    watcherGeneration += 1;
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }
    const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (moduleAbort) moduleAbort.abort();
    // A subsequent session_start in the SAME process (e.g. a new session
    // started without a full module reload) must get a live, unaborted
    // module signal -- otherwise every watcher it attaches would see
    // getModuleAbortSignal().aborted === true from birth and immediately
    // misclassify every real failure as "cancelled", silently dropping
    // diagnostics and never persisting `unknown`. Only /reload's top-level
    // module re-import path previously created a fresh controller; shutdown
    // must do the same for same-process session restarts.
    (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    registryReady = false;
    registryFile = undefined; // Old aborted closures must not rewrite the new runtime's registry.
    runningSubagents.clear();
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const shouldRegister = (name: string) => !deniedTools.has(name);

  // ── subagent tool ──
  if (shouldRegister("subagent"))
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready. " +
        "Delivery of the result message is AT-MOST-ONCE, never guaranteed exactly-once: in rare cases (parent reload/crash mid-delivery) a finished sub-agent's result may not arrive automatically. If a sub-agent you spawned seems to have gone silent, check /subagents-diagnose rather than assuming it is still running. " +
        "If a worker must write a file, assign each worker a unique artifact path in its task text (e.g. <name>.<profile>.<attemptId>.md); never share a path between workers — concurrent writers silently overwrite each other. This is a convention you state in the task, not a parameter of this tool.",
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready. Delivery is at-most-once (see /subagents-diagnose if a result seems missing). " +
        "Assign each worker a unique artifact path in its task text (e.g. <name>.<profile>.<attemptId>.md); never share a path between workers.",
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const routed = resolveSubagentRouting(params, ctx, workerRegistry);
        if (routed.resolution && !routed.resolution.launch) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Route ${routed.resolution.taskClass}: stay in this coordinator session ` +
                  `(${routed.resolution.model}, ${routed.resolution.family}). Do not spawn a worker.`,
              },
            ],
            details: { status: "stay_here", routing: routed.resolution },
          };
        }
        const launchParams = routed.params;

        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (launchParams.agent && currentAgent && launchParams.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Validate prerequisites
        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        requireTuiParent(ctx);
        // Launch the subagent (creates pane, sends command)
        const running = await launchSubagent(launchParams, ctx);

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh();
        startStatusRefresh(pi);
        attachWatcher(running, pi);

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: launchParams.name,
            task: launchParams.task,
            agent: launchParams.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            status: "started",
            routing: routed.resolution,
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const name = typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        const agent = typeof partialArgs.agent === "string" && partialArgs.agent
          ? theme.fg("dim", ` (${partialArgs.agent})`)
          : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agent +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_interrupt tool ──
  if (shouldRegister("subagent_interrupt"))
    pi.registerTool({
      name: "subagent_interrupt",
      label: "Interrupt Subagent",
      description:
        "Send Escape to the active turn of a currently running Pi-backed subagent. " +
        "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
        "and does not emit a subagent_result solely because of this request. " +
        "Interrupt is not kill: the worker may still run and write. Confirm termination via /subagents-diagnose before reusing any artifact path.",
      promptSnippet:
        "Send Escape to the active turn of a currently running Pi-backed subagent. " +
        "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
        "and does not emit a subagent_result solely because of this request. " +
        "Interrupt is not kill: the worker may still run and write. Confirm termination via /subagents-diagnose before reusing any artifact path.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
      }),

      async execute(_toolCallId, params) {
        return handleSubagentInterrupt(params);
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : args.name ?? "(unknown)";
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — interrupt turn"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.status === "interrupt_requested") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
              theme.fg("dim", " — interrupt requested"),
            0,
            0,
          );
        }

        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──
  if (shouldRegister("subagents_list"))
    pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List available subagent definitions from package-bundled, global (~/.pi/agent/agents/), and project-local (.pi/agents/) sources. " +
        "Project-local agents override global and bundled agents with the same name; global agents override bundled ones. " +
        "When hideBundledAgents is true in config.json, package-bundled agents are omitted.",
      promptSnippet:
        "List available subagent definitions from package-bundled, global (~/.pi/agent/agents/), and project-local (.pi/agents/) sources. " +
        "Project-local agents override global and bundled agents with the same name; global agents override bundled ones. " +
        "When hideBundledAgents is true in config.json, package-bundled agents are omitted.",
      parameters: Type.Object({}),

      async execute() {
        const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });



  // ── subagent_resume tool ──
  if (shouldRegister("subagent_resume"))
    pi.registerTool({
      name: "subagent_resume",
      label: "Resume Subagent",
      description:
        "Resume a previous sub-agent session in a new multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
      promptSnippet:
        "Resume a previous sub-agent session in a new multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
      parameters: Type.Object({
        sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
        name: Type.Optional(
          Type.String({ description: "Display name for the terminal tab. Default: 'Resume'" }),
        ),
        message: Type.Optional(
          Type.String({
            description: "Optional message to send after resuming (e.g. follow-up instructions)",
          }),
        ),
        autoExit: Type.Optional(
          Type.Boolean({
            description:
              "Whether the resumed session should automatically exit after completing its response. Defaults to true for autonomous follow-up work; set false for interactive resumed sessions.",
          }),
        ),
      }),

      renderCall(args, theme) {
        const name = args.name ?? "Resume";
        const text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("dim", " — resuming session");
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "Resume";

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (!registryReady) throw new Error("Worker registry is not initialized or failed validation; refusing launch");
        if (process.env.PI_SUBAGENT_ID) throw new Error("Nested worker spawning is disabled");
        requireTuiParent(ctx);
        const name = params.name ?? "Resume";
        validateLaunch({ name }, null, !!process.env.PI_SUBAGENT_ID);
        if (getMuxBackend() !== "tmux") throw new Error("This hardened fork requires tmux");
        const { autoExit, interactive } = resolveResumeLaunchBehavior(params);
        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }
        if (!existsSync(params.sessionPath)) {
          return {
            content: [
              { type: "text", text: `Error: session file not found: ${params.sessionPath}` },
            ],
            details: { error: "session not found" },
          };
        }
        const adapter = getLifecycleAdapter();
        const tmuxSocket = currentTmuxSocket();
        const parentPane = process.env.TMUX_PANE;
        if (!tmuxSocket || !parentPane) throw new Error("tmux socket/window identity is required");
        const windowId = currentWindowId(tmuxSocket, parentPane, adapter);
        const canonicalSession = canonicalizeSessionFile(params.sessionPath, adapter);
        const expectedPiSessionId = readSessionHeaderId(canonicalSession, adapter);
        const parentSessionId = ctx.sessionManager.getSessionId();
        if (!parentSessionId) throw new Error("Parent session UUID unavailable");
        // Resume on the child's ORIGINAL provider/model (from the prior
        // attempt record for this session file), not the parent's model.
        // Falls back to the parent's identity only if no prior record exists.
        const prior = workerRegistry.workers
          .filter((w) => w.sessionFile === canonicalSession && w.requested)
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        const requested = prior
          ? { ...prior.requested }
          : requestedIdentity({}, null, ctx);
        const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), parentSessionId);
        const attemptId = randomUUID();
        const activityFile = getSubagentActivityFile(artifactDir, attemptId);
        const completionFile = join(artifactDir, "completions", `${attemptId}.json`);
        mkdirSync(dirname(activityFile), { recursive: true, mode: 0o700 });
        const promptArgs: string[] = [];
        if (params.message) {
          const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const resumeMsgFile = join(artifactDir, "subagent-resume", `resume-${attemptId}-${msgTimestamp}.md`);
          mkdirSync(dirname(resumeMsgFile), { recursive: true, mode: 0o700 });
          writeFileSync(resumeMsgFile, params.message, "utf8");
          promptArgs.push(`@${resumeMsgFile}`);
        }
        const launchScriptFile = join(artifactDir, "subagent-scripts", `resume-${attemptId}.sh`);
        if (!registryFile) throw new Error("Worker registry path is not initialized");
        const began = persistPreparingIntent({
          registryPath: registryFile,
          registry: { ...workerRegistry, invocations: invocationCount },
          attemptId,
          name,
          task: params.message ?? "resumed session",
          title: name,
          repository: ctx.cwd,
          parentSessionId,
          sessionFile: canonicalSession,
          launchScriptFile,
          completionFile,
          tmuxSocket,
          windowId,
          requested,
          interactive,
          paneStartCommand: freezePaneStartCommand(launchScriptFile),
          expectedPiSessionId,
        }, adapter);
        commitRegistry(began.registry, began.record);
        const env: Record<string, string> = {
          PI_SUBAGENT_NAME: name,
          PI_SUBAGENT_SESSION: canonicalSession,
          PI_SUBAGENT_COMPLETION_FILE: completionFile,
          PI_SUBAGENT_TOKEN: began.record.completionToken,
          PI_SUBAGENT_ID: began.record.attemptId,
          PI_SUBAGENT_ACTIVITY_FILE: activityFile,
        };
        if (autoExit) env.PI_SUBAGENT_AUTO_EXIT = "1";
        if (process.env.PI_CODING_AGENT_DIR) env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
        const dispatcherArgs = buildDispatcherArgs({
          provider: requested.provider,
          model: requested.model,
          thinking: requested.thinking,
          sessionFile: canonicalSession,
          extensionPath: join(SUBAGENTS_DIR, "subagent-done.ts"),
          repo: ctx.cwd,
          promptArgs,
        });
        writeLaunchScript({
          scriptPath: launchScriptFile,
          attemptId: began.record.attemptId,
          token: began.record.completionToken,
          socket: tmuxSocket,
          dispatcher: dispatcherPath(),
          dispatcherArgs,
          env,
          preamble: [`Subagent resume script for ${name}`, `Session: ${canonicalSession}`].join("\n"),
        }, adapter);
        const splitReady = persistSplitRequested(registryFile, began.registry, began.record, freezePaneStartCommand(launchScriptFile), adapter);
        commitRegistry(splitReady.registry, splitReady.record);
        const launched = invokeSplit(registryFile, splitReady.registry, splitReady.record, adapter);
        commitRegistry(launched.registry, launched.record);
        const running = runningFromAttempt(launched.record, { activityFile, watcherGeneration });
        runningSubagents.set(running.id, running);
        startWidgetRefresh();
        startStatusRefresh(pi);
        attachWatcher(running, pi);
        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: {
            id: running.id,
            name,
            sessionPath: canonicalSession,
            launchScriptFile,
            status: "started",
          },
        };

      },
    });

  // /iterate command — fork the session into a subagent
  pi.registerCommand("iterate", {
    description: "Fork session into a subagent for focused work (bugfixes, iteration)",
    handler: async (args, _ctx) => {
      const task = args.trim() || "";
      const toolCall = task
        ? `Use subagent to fork a session. fork: true, name: "Iterate", task: ${JSON.stringify(task)}`
        : `Use subagent to fork a session. fork: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  pi.registerCommand("subagent-release", {
    description: "Release or close a worker pane: /subagent-release <attemptId>",
    handler: async (args, ctx) => {
      const attemptId = args.trim();
      if (!attemptId) {
        ctx.ui.notify("Usage: /subagent-release <attemptId>", "warning");
        return;
      }
      const record = workerRegistry.workers.find((worker) => worker.attemptId === attemptId);
      if (!record) {
        ctx.ui.notify(`Unknown attempt ${attemptId}`, "error");
        return;
      }
      if (!registryFile || !registryReady) {
        ctx.ui.notify("Registry unavailable", "error");
        return;
      }
      if (classifySocket(record, currentTmuxSocket()) === "foreign") {
        ctx.ui.notify("Foreign-socket workers cannot be released from this session (zero tmux calls).", "error");
        return;
      }
      const release = await ctx.ui.confirm("Release without closing? Pane survives as yours.", record.attemptId);
      if (release) {
        try {
          const next = releaseWithoutClose(registryFile, workerRegistry, record);
          commitRegistry(next.registry, next.record);
          runningSubagents.delete(record.attemptId);
          updateWidget();
          ctx.ui.notify(`Released ${attemptId} without closing`, "info");
        } catch (error: any) {
          ctx.ui.notify(error?.message ?? String(error), "error");
        }
        return;
      }
      const closeFirst = await ctx.ui.confirm("Close and kill the pane instead?", record.attemptId);
      if (!closeFirst) return;
      const closeSecond = await ctx.ui.confirm("Really kill this worker pane? This cannot be undone.", record.surface ?? attemptId);
      if (!closeSecond) return;
      try {
        const next = closeOwned(registryFile, workerRegistry, record);
        commitRegistry(next.registry, next.record);
        runningSubagents.delete(record.attemptId);
        updateWidget();
        ctx.ui.notify(`Closed ${attemptId}`, "info");
      } catch (error: any) {
        ctx.ui.notify(error?.message ?? String(error), "error");
      }
    },
  });

  pi.registerCommand("subagent-limit", {
    description: "Show or change this session's subagent invocation limit (raise, set, or remove permanently) — asks you to choose",
    handler: async (_args, ctx) => {
      if (!registryReady) { ctx.ui.notify("Worker registry not ready.", "error"); return; }
      const changed = await promptInvocationLimit(ctx, `Subagent invocation limit for this session is ${currentLimitLabel()}.`);
      if (!changed) ctx.ui.notify(`Limit unchanged: ${currentLimitLabel()} (used ${invocationCount}).`, "info");
    },
  });
  pi.registerCommand("subagents-diagnose", {
    description: "Show worker registry diagnostics and pending deliveries",
    handler: async (_args, ctx) => {
      const loaded = registryFile ? loadRegistry(registryFile) : { status: "missing" as const, registry: workerRegistry };
      const text = diagnoseText(loaded.status === "invalid" ? loaded : loaded, workerRegistry.workers);
      ctx.ui.notify(text.slice(0, 500), registryValidationError ? "error" : "info");
      console.log(text);
    },
  });

  pi.registerCommand("subagents-replay", {
    description: "Explicitly replay an uncertain worker outcome: /subagents-replay <attemptId>",
    handler: async (args, ctx) => {
      const attemptId = args.trim();
      const running = runningSubagents.get(attemptId);
      const record = running?.attempt ?? workerRegistry.workers.find((worker) => worker.attemptId === attemptId);
      if (!record || !record.outcomeBytes) {
        ctx.ui.notify("No pending/uncertain outcome to replay", "warning");
        return;
      }
      if (!running) {
        ctx.ui.notify("Attempt is not currently watched in this session", "warning");
        return;
      }
      const data = JSON.parse(record.outcomeBytes);
      const replayRecord = { ...record, deliveryState: "pending" as const };
      // Durable outbox (B3): persist `pending` BEFORE the replay send, not
      // only in memory. Otherwise a crash between marking pending and the
      // actual pi.sendMessage call leaves no on-disk trace that a replay was
      // even attempted.
      if (!registryFile) throw new Error("Worker registry path is not initialized");
      const persisted = persistRecord(registryFile, workerRegistry, replayRecord);
      commitRegistry(persisted, replayRecord, running);
      deliverAuthenticatedOutcome(pi, running, replayRecord, data);
      ctx.ui.notify(`Replayed reported outcome (authenticated, unverified) for ${attemptId}`, "info");
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        // P2-3: a worker's own `done` is an authenticated *report*, not an
        // independently verified completion. Never render it as a plain
        // success checkmark + "completed".
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("warning", "◌");
        const status = errorMessage
          ? "failed (provider/agent error)"
          : failed
            ? `failed (exit ${exitCode})`
            : "reported done — unverified";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nSession: .+\nResume: .+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        // Build content for the box
        const contentLines = [header];

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
            contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_ping message renderer ──
  pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.message ?? "");
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          }
        } else {
          const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // /plan command — start the full planning workflow
  pi.registerCommand("plan", {
    description: "Start a planning session: /plan <what to build>",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /plan <what to build>", "warning");
        return;
      }

      // Rename workspace and tab to show this is a planning session
      if (isMuxAvailable()) {
        try {
          const label = task.length > 40 ? task.slice(0, 40) + "..." : task;
          renameWorkspace(`🎯 ${label}`);
          renameCurrentTab(`🎯 Plan: ${label}`);
        } catch {
          // non-critical -- do not block the plan
        }
      }

      // Load the plan skill from the subagents extension directory
      const planSkillPath = join(SUBAGENTS_DIR, "plan-skill.md");
      let content = readFileSync(planSkillPath, "utf8");
      content = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
      pi.sendUserMessage(
        `<skill name="plan" location="${planSkillPath}">\n${content.trim()}\n</skill>\n\n${task}`,
      );
    },
  });
}
// test
