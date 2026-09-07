/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeCompletion, writeStartupReceipt } from "./completion.mjs";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createSubagentActivityRecorder } from "./activity.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
  userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Once the user takes over, only explicit exit/completion may close this Pi.
  if (userTookOver) return false;
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function observedFromExtensionContext(ctx: any): {
  piSessionId: string;
  observed: { provider: string; model: string; thinking: string };
} {
  const piSessionId = ctx?.sessionManager?.getSessionId?.();
  if (!piSessionId || typeof piSessionId !== "string") {
    throw new Error("session_start missing ctx.sessionManager.getSessionId()");
  }
  const provider = ctx?.model?.provider;
  const model = ctx?.model?.id;
  const thinking = ctx?.thinkingLevel;
  if (!provider || typeof provider !== "string") throw new Error("session_start missing ctx.model.provider");
  if (!model || typeof model !== "string") throw new Error("session_start missing ctx.model.id");
  if (thinking == null || thinking === "") throw new Error("session_start missing ctx.thinkingLevel");
  return { piSessionId, observed: { provider, model, thinking: String(thinking) } };
}

function currentPiSessionId(ctx?: any): string | undefined {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return typeof id === "string" && id ? id : process.env.PI_SUBAGENT_PI_SESSION_ID;
  } catch {
    return process.env.PI_SUBAGENT_PI_SESSION_ID;
  }
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = !!process.env.PI_SUBAGENT_COMPLETION_FILE && existsSync(`${process.env.PI_SUBAGENT_COMPLETION_FILE}.user-owned`);
  let agentStarted = false;
  let lastAgentEnd: { messages?: any[] } | null = null;
  let establishedPiSessionId: string | undefined;
  let completionWriteFailed = false;

  function rememberWriteFault(error: unknown) {
    completionWriteFailed = true;
    process.exitCode = process.exitCode || 1;
    void error;
  }

  function writeChildCompletion(payload: Record<string, unknown>, ctx?: any) {
    const piSessionId = payload.piSessionId ?? establishedPiSessionId ?? currentPiSessionId(ctx);
    writeCompletion({ ...payload, ...(piSessionId ? { piSessionId } : {}) });
  }

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);
    if (process.env.PI_SUBAGENT_COMPLETION_FILE) {
      const receipt = observedFromExtensionContext(ctx);
      establishedPiSessionId = receipt.piSessionId;
      process.env.PI_SUBAGENT_PI_SESSION_ID = receipt.piSessionId;
      writeStartupReceipt(receipt);
    }
    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    recorder.input();
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
    const completionFile = process.env.PI_SUBAGENT_COMPLETION_FILE;
    if (completionFile) {
      mkdirSync(dirname(completionFile), { recursive: true, mode: 0o700 });
      writeFileSync(`${completionFile}.user-owned`, "user takeover\n", { mode: 0o600 });
    }
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    recorder.agentStart();
  });

  // `agent_end` can fire before Pi settles (retry/compaction/continuation may
  // still follow). It must ONLY retain the latest result for `agent_settled`
  // to consult -- it must never itself publish a final error/done outcome,
  // otherwise a transient failure that Pi goes on to retry/recover from could
  // be delivered to the parent as final.
  pi.on("agent_end", (event, _ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    lastAgentEnd = { messages };
    if (autoExit && shouldAutoExitOnAgentEnd(userTookOver, messages)) {
      recorder.agentEndDone();
      return;
    }
    recorder.agentEndWaiting();
  });

  // `agent_settled` is the single point that decides and publishes the final
  // outcome (error or done), using the last recorded `agent_end` result.
  // Error notification is not gated on `autoExit`: an interactive (non
  // auto-exit) session still needs to notify the parent of a provider/turn
  // error, it just doesn't shut itself down for it. `done` publication and
  // self-shutdown remain gated on `autoExit`/`shouldAutoExitOnAgentEnd`, same
  // as before.
  pi.on("agent_settled", (_event, ctx) => {
    const messages = lastAgentEnd?.messages;
    const errorInfo = findLatestAssistantError(messages);
    const shouldExit = autoExit && shouldAutoExitOnAgentEnd(userTookOver, messages);
    if (!shouldExit && !errorInfo) return;
    try {
      if (process.env.PI_SUBAGENT_COMPLETION_FILE && process.env.PI_SUBAGENT_SESSION) {
        if (errorInfo) {
          writeChildCompletion({ type: "error", errorMessage: errorInfo.errorMessage, stopReason: errorInfo.stopReason }, ctx);
        } else if (shouldExit) {
          writeChildCompletion({ type: "done" }, ctx);
        }
      }
    } catch (error) {
      rememberWriteFault(error);
    }
    if (completionWriteFailed) process.exitCode = process.exitCode || 1;
    if (shouldExit) ctx.shutdown();
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      recorder.callerPing();
      const exitData = {
        type: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
        piSessionId: establishedPiSessionId ?? currentPiSessionId(ctx),
      };
      writeChildCompletion(exitData, ctx);

      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
        details: {},
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "Pass `summary` with what you accomplished (results, outputs, file paths, test exit codes). " +
      "If omitted, your LAST assistant text message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({
      summary: Type.Optional(Type.String({ description: "What you accomplished: results, outputs, paths, test exit codes. Returned verbatim to the caller." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      recorder.subagentDone();
      if (sessionFile) {
        const summary = typeof params?.summary === "string" && params.summary.trim() ? params.summary.trim() : undefined;
        writeChildCompletion({ type: "done", ...(summary ? { summary } : {}), piSessionId: establishedPiSessionId ?? currentPiSessionId(ctx) }, ctx);
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
        terminate: true,
      };
    },
  });
}
