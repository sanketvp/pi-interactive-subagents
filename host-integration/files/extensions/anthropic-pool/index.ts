import { spawn } from "node:child_process";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sessionIdLines } from "./session-id-lines.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  generatePKCE,
  parseCallbackInput,
  startOAuthCallbackServer,
} from "./auth-flow.js";
import { resolveBuiltinAnthropicStreamSimple } from "./host-transport.js";
import { AccountPoolStore } from "./pool-store.js";
import { createPoolStreamSimple } from "./pool-transport.js";

function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function openBrowserUrl(url: string): boolean {
  try {
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "cmd"
          : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const pool = new AccountPoolStore();
  const builtinAnthropicTransport = await resolveBuiltinAnthropicStreamSimple();

  // Replace default Anthropic registration with our pool transport
  pi.unregisterProvider("anthropic");
  pi.registerProvider("anthropic", {
    api: "anthropic-messages",
    streamSimple: createPoolStreamSimple(builtinAnthropicTransport, pool),
  });

  // --------------------------------------------------------------------------
  // Status footer: session id + active pool account + per-account usage.
  // Installed at session_start so EVERY pi session (current and future) shows
  // the same live status bar. The pool snapshot is re-read from disk on a
  // timer, so rotations/writes from other pi processes appear here too.
  // --------------------------------------------------------------------------
  let footerModelId: string | undefined;
  let widgetEnabled = true;
  pi.on("model_select", (event) => {
    footerModelId = event.model.id;
  });

  // --------------------------------------------------------------------------
  // Per-account colors: 4 visually distinct ANSI-256 hues, keyed by account
  // INDEX (stable across renames) so every session shows the same color for
  // the same pool slot. Applied to all Claude-usage segments in the footer.
  // --------------------------------------------------------------------------
  const ACCOUNT_COLORS = [46, 213, 208, 75]; // green, pink, orange, blue
  const accountFg = (index: number, text: string): string => {
    const code = ACCOUNT_COLORS[((index % ACCOUNT_COLORS.length) + ACCOUNT_COLORS.length) % ACCOUNT_COLORS.length];
    return `\x1b[38;5;${code}m${text}\x1b[0m`;
  };

  const installFooter = (ctx: ExtensionContext) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
      let lastSnapKey = "";
      const timer = setInterval(() => {
        const snap = pool.getFooterSnapshot();
        const key = JSON.stringify(snap) + "|" + (footerModelId || ctx.model?.id);
        if (key !== lastSnapKey) {
          lastSnapKey = key;
          tui.requestRender();
        }
      }, 5000);
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      // Repo-name resolution (added 2026-09-06, user directive): the naive
      // `cwd.split("/").pop()` breaks inside a git worktree, where the last path
      // component is often the worktree's own folder (frequently named after the
      // branch/feature, not the repo). `git rev-parse --git-common-dir` always
      // resolves to the MAIN repo's .git even from inside a linked worktree, so
      // its parent directory's basename is the true repo name (same fix already
      // applied in hooks/statusline.sh for the Claude Code statusline). Resolved
      // async (spawn, not execSync) so the TUI render loop never blocks on a
      // subprocess; cached per-cwd and re-rendered once ready.
      const repoNameCache = new Map<string, string>();
      const repoNamePending = new Set<string>();
      const resolveRepoName = (cwd: string) => {
        if (repoNameCache.has(cwd) || repoNamePending.has(cwd)) return;
        repoNamePending.add(cwd);
        const proc = spawn("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
        let out = "";
        proc.stdout?.on("data", (d) => (out += d.toString()));
        proc.on("close", (code) => {
          repoNamePending.delete(cwd);
          const commonDir = out.trim();
          const name = code === 0 && commonDir ? path.basename(path.dirname(commonDir)) : cwd.split("/").pop() || cwd;
          repoNameCache.set(cwd, name);
          tui.requestRender();
        });
        proc.on("error", () => {
          repoNamePending.delete(cwd);
          repoNameCache.set(cwd, cwd.split("/").pop() || cwd);
          tui.requestRender();
        });
      };

      return {
        dispose: () => {
          clearInterval(timer);
          unsub();
        },
        invalidate() {},
        render(width: number): string[] {
          // NO TRUNCATION (user directive 2026-09-06): show the full session ID, always.
          // Root cause this replaces: session IDs are UUIDv7 -- the first ~12 chars are a
          // millisecond timestamp, not random -- so truncating to any short prefix risks
          // real collisions between sessions created close together in time (confirmed
          // live: a 17-terminal batch restart produced two different repos both showing
          // "sid:01a07933" on a first-8-chars truncation). A last-N-chars truncation would
          // avoid THAT specific collision class but is still truncation -- the user wants
          // the complete, unambiguous ID on screen regardless of footer width.
          const sid = ctx.sessionManager.getSessionId() || "?";
          const model = footerModelId || ctx.model?.id || "no-model";
          const snap = pool.getFooterSnapshot();
          const usage = ctx.getContextUsage();

          const segSession = theme.fg("dim", `sid:${sid}`);
          resolveRepoName(ctx.cwd);
          const repo = repoNameCache.get(ctx.cwd) || ctx.cwd.split("/").pop() || ctx.cwd;
          const branch = footerData.getGitBranch();
          const segBranch = branch ? theme.fg("dim", branch) : "";
          const segCtx =
            usage && usage.percent != null
              ? theme.fg(
                  usage.percent > 80 ? "warning" : usage.percent > 60 ? "accent" : "dim",
                  `${Math.round(usage.percent)}%ctx`,
                )
              : theme.fg("dim", "ctx?");

          let segAccount: string;
          let segUsage = "";
          let segRot = "";
          let segTtl = "";
          if (snap) {
            const acctColor = (s: string) => accountFg(snap.activeIndex, s);
            const account = snap.activeName.split("@")[0] || snap.activeName;
            const marker =
              snap.status === "rate_limited"
                ? "⚠"
                : snap.status === "expired"
                  ? "✗"
                  : "★";
            segAccount = acctColor(`${marker} ${account}`);
            const s = snap.stats;
            segUsage = acctColor(
              `✓${s.successCount} ⚡${s.rateLimitCount}${s.errorCount ? ` ✗${s.errorCount}` : ""}`,
            );
            segRot = acctColor(
              `${snap.rotation === "round-robin" ? "RR" : snap.rotation === "quota-aware" ? "QA" : "FO"} ${snap.activeIndex + 1}/${snap.totalAccounts}`,
            );
            const ttl = snap.tokenExpiresAt - Date.now();
            segTtl =
              snap.status === "expired"
                ? theme.fg("error", "EXPIRED")
                : ttl > 0
                  ? acctColor(`${formatDuration(ttl)}`)
                  : theme.fg("warning", "~expiry");
          } else {
            segAccount = theme.fg("dim", "no pool");
          }

          const segModel = theme.fg("dim", model);
          // Top line: repo name alone, bold/prominent (user directive 2026-09-06) --
          // no branch/worktree/feature name here, just the repo, so it's the first
          // thing visible at a glance without having to parse the whole footer.
          const repoLine = truncateToWidth(theme.fg("accent", repo), width);
          const parts = [segSession, segAccount, segUsage, segRot, segCtx, segBranch, segTtl, segModel].filter(Boolean);
          const line = parts.join(" · ");
          if (visibleWidth(line) <= width) return [repoLine, line];
          // Fall back to the essentials when the terminal is narrow.
          // Identity gets its own lossless line(s). Truncate only optional status.
          const identityLines = sessionIdLines(sid, width).map((text) => theme.fg("dim", text));
          const compact = [segAccount, segUsage, segCtx, segModel].filter(Boolean).join(" · ");
          return [repoLine, ...identityLines, truncateToWidth(compact, width)];
        },
      };
    });
  };

  const installWidget = (ctx: ExtensionContext) => {
    if (!widgetEnabled) return;
    ctx.ui.setWidget("pool-model-status", (tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        const sid = ctx.sessionManager.getSessionId() || "?";
        const model = footerModelId || ctx.model?.id || "no-model";
        const usage = ctx.getContextUsage();
        const repo = ctx.cwd.split("/").pop() || ctx.cwd;

        const lines: string[] = [];
        lines.push(theme.fg("accent", "─ Model pool & limits ─"));
        // Pool accounts first, colored by their slot (matches footer).
        for (const acc of pool.getStatusView()) {
          const ttl = acc.tokenExpiresInMs > 0 ? formatDuration(acc.tokenExpiresInMs) : "EXPIRED";
          const marker = acc.isActive ? "★" : acc.status === "rate_limited" ? "⚠" : acc.status === "token_expired" ? "✗" : "·";
          const row = `${marker} #${acc.index} ${acc.name}  ✓${acc.stats.successCount} ⚡${acc.stats.rateLimitCount}  ${ttl}`;
          lines.push(accountFg(acc.index - 1, row));
        }
        lines.push(theme.fg("dim", ""));
        for (const pid of ["anthropic", "xai", "openai-codex", "openrouter"]) {
          const provider = ctx.modelRegistry.getProvider(pid);
          if (!provider) continue;
          const models = ctx.modelRegistry.getAvailable().filter((m) => m.provider === pid);
          if (!models.length) continue;
          lines.push(theme.fg("dim", `▸ ${pid}`));
          for (const m of models.slice(0, 4)) {
            const cw = (m.contextWindow / 1000).toFixed(0) + "k";
            const mo = (m.maxTokens / 1000).toFixed(0) + "k";
            const auth = ctx.modelRegistry.hasConfiguredAuth(m) ? "✓" : "—";
            lines.push(
              theme.fg("dim", `  ${m.id.padEnd(30)} ctx:${cw.padStart(6)}  max:${mo.padStart(6)}  ${auth}`),
            );
          }
        }
        lines.push(
          theme.fg(
            "muted",
            `session: ${sid} · model: ${model} · ctx: ${usage?.percent != null ? Math.round(usage.percent) + "%" : "?"} · ${repo}`,
          ),
        );
        return lines.map((l) => truncateToWidth(l, width));
      },
    }));
  };

  pi.on("session_start", (_event, ctx) => {
    installFooter(ctx);
    // installWidget() showed a "Model pool & limits" panel with the full
    // per-provider model/ctx/max listing. Disabled — the footer already
    // carries everything needed (session, account, usage, ctx%, repo, model).
  });

  const handleStatus = (ctx: ExtensionCommandContext) => {
    const accounts = pool.getStatusView();
    if (accounts.length === 0) {
      ctx.ui.notify(
        "No Claude accounts configured. Run `/claude-pool add [name]` to add your first account.",
        "warning",
      );
      return;
    }

    const lines: string[] = [
      "╔══════════════════════════════════════════════════════════════════════════╗",
      "║                       CLAUDE ACCOUNT POOL STATUS                         ║",
      "╠═══╦══════════════════════╦══════════════╦═════════════════╦══════════════╣",
      "║ # ║ Name                 ║ Status       ║ Rate Limit Left ║ Requests     ║",
      "╠═══╬══════════════════════╬══════════════╬═════════════════╬══════════════╣",
    ];

    for (const acc of accounts) {
      const num = String(acc.index).padEnd(2);
      const name = acc.name.slice(0, 20).padEnd(20);
      let statusStr = "";
      if (acc.isActive) {
        statusStr = acc.status === "rate_limited" ? "ACTIVE (LIMITED)" : "★ ACTIVE";
      } else if (acc.status === "rate_limited") {
        statusStr = "RATE LIMITED";
      } else if (acc.status === "token_expired") {
        statusStr = "EXPIRED";
      } else {
        statusStr = "READY";
      }
      statusStr = statusStr.slice(0, 12).padEnd(12);

      const cooldown =
        acc.rateLimitRemainingMs > 0
          ? formatDuration(acc.rateLimitRemainingMs).padEnd(15)
          : "-".padEnd(15);

      const stats = `✓${acc.stats.successCount || 0} ⚡${acc.stats.rateLimitCount || 0}`.padEnd(12);

      lines.push(`║ ${num}║ ${name} ║ ${statusStr} ║ ${cooldown} ║ ${stats} ║`);
    }

    lines.push(
      "╚═══╩══════════════════════╩══════════════╩═════════════════╩══════════════╝",
    );
    lines.push(
      `Mode: ${pool.getRotationStrategy().toUpperCase()} · Commands: \`/claude-pool mode [round-robin|failover]\`, \`/claude-pool add\`, \`/claude-pool rotate\`, \`/claude-pool switch <#>\`, \`/claude-pool remove <#>\``,
    );

    ctx.ui.notify(lines.join("\n"), "info");
  };

  const handleAdd = async (args: string, ctx: ExtensionCommandContext) => {
    // If an email was passed as the argument (e.g. `/claude-pool add name@example.com`),
    // use it directly instead of re-prompting for it.
    const provided = args.trim();
    let name = provided || `Account ${pool.getAccounts().length + 1}`;

    if (!provided) {
      const email = await ctx.ui.input(
        "Add a Claude account — enter the email address for this account:",
        "account@example.com",
      );
      if (!email?.trim()) {
        ctx.ui.notify("Account email is required so the active account is identifiable.", "warning");
        return;
      }
      name = email.trim();
    }

    ctx.ui.notify(`Starting Claude OAuth login for "${name}"...`, "info");

    const { verifier, challenge } = await generatePKCE();
    const state = crypto.randomUUID().replace(/-/g, "");

    let serverSession;
    try {
      serverSession = await startOAuthCallbackServer(state);
    } catch (err) {
      ctx.ui.notify(`Failed to start callback server on port 53692: ${err}`, "error");
      return;
    }

    const authUrl = buildAuthorizeUrl(challenge, state);
    const browserOpened = openBrowserUrl(authUrl);

    ctx.ui.notify(
      `${browserOpened ? "Opening" : "Could not open"} browser for Claude sign in...\nIf it didn't open automatically, copy this URL into your browser:\n${authUrl}`,
      "info",
    );

    // Wait for callback or manual input
    let callbackResult = null;
    try {
      const waitPromise = serverSession.waitForCode();
      const promptPromise = ctx.ui
        .input("Paste callback URL (or press Enter if browser completes):")
        .then((input: string | undefined) => {
          if (input?.trim()) {
            return parseCallbackInput(input.trim());
          }
          return null;
        })
        .catch(() => null);

      const winner = await Promise.race([
        waitPromise,
        promptPromise.then((p: { code?: string; state?: string } | null) => (p?.code ? { code: p.code, state: p.state || state } : null)),
      ]);

      callbackResult = winner || (await waitPromise);
    } finally {
      serverSession.cancel();
    }

    if (!callbackResult?.code) {
      ctx.ui.notify("Login cancelled or no code received.", "warning");
      return;
    }

    ctx.ui.notify("Exchanging OAuth code for tokens...", "info");
    try {
      const credentials = await exchangeCodeForTokens(
        callbackResult.code,
        callbackResult.state,
        verifier,
      );

      const added = pool.addAccount({
        id: `account-${Date.now()}`,
        name,
        email: name,
        credentials: {
          type: "oauth",
          ...credentials,
        },
      });

      ctx.ui.notify(
        `✓ "${added.name}" added successfully and set as ACTIVE!\nTotal accounts: ${pool.getAccounts().length}`,
        "info",
      );
    } catch (err) {
      ctx.ui.notify(`Failed to complete OAuth token exchange: ${err}`, "error");
    }
  };

  const handleSwitch = (args: string, ctx: ExtensionCommandContext) => {
    const idx = parseInt(args.trim(), 10) - 1;
    if (isNaN(idx)) {
      ctx.ui.notify("Usage: /claude-pool switch <account number>", "warning");
      return;
    }
    const acc = pool.setActiveIndex(idx);
    if (acc) {
      ctx.ui.notify(`Switched active account to #${idx + 1}: "${acc.name}"`, "info");
    } else {
      ctx.ui.notify(`Invalid account index: ${idx + 1}`, "error");
    }
  };

  const handleRotate = (ctx: ExtensionCommandContext) => {
    const next = pool.rotateToNext();
    if (next) {
      ctx.ui.notify(
        `Rotated to #${pool.getActiveIndex() + 1}: "${next.name}"`,
        "info",
      );
    } else {
      ctx.ui.notify("No accounts available to rotate.", "warning");
    }
  };

  const handleRemove = async (args: string, ctx: ExtensionCommandContext) => {
    const idx = parseInt(args.trim(), 10) - 1;
    if (isNaN(idx)) {
      ctx.ui.notify("Usage: /claude-pool remove <account number>", "warning");
      return;
    }
    const accounts = pool.getAccounts();
    if (idx < 0 || idx >= accounts.length) {
      ctx.ui.notify(`Invalid account index: ${idx + 1}`, "error");
      return;
    }

    const target = accounts[idx];
    const confirmed = await ctx.ui.confirm(
      `Remove "${target.name}"?`,
      "Are you sure you want to remove this account from the pool?",
    );

    if (confirmed) {
      pool.removeAccount(idx);
      ctx.ui.notify(`Removed account "${target.name}".`, "info");
    }
  };

  const handleCooldown = (args: string, ctx: ExtensionCommandContext) => {
    const parts = args.trim().split(/\s+/);
    const idx = parseInt(parts[0], 10) - 1;
    if (isNaN(idx)) {
      ctx.ui.notify("Usage: /claude-pool cooldown <#> [minutes | 0 to reset]", "warning");
      return;
    }

    const minutes = parts[1] ? parseInt(parts[1], 10) : 0;
    if (minutes <= 0) {
      pool.clearCooldown(idx);
      ctx.ui.notify(`Cleared cooldown for account #${idx + 1}.`, "info");
    } else {
      const acc = pool.getAccounts()[idx];
      if (acc) {
        pool.markRateLimited(acc.id, minutes * 60 * 1000, "manual");
        ctx.ui.notify(`Set ${minutes}m cooldown for #${idx + 1} "${acc.name}".`, "info");
      } else {
        ctx.ui.notify(`Invalid account index #${idx + 1}`, "error");
      }
    }
  };

  const poolCommandHandler = async (
    args: string,
    ctx: ExtensionCommandContext,
  ) => {
    const trimmed = args.trim();
    const [subcommand, ...rest] = trimmed.split(/\s+/);
    const restArgs = rest.join(" ");

    switch (subcommand?.toLowerCase()) {
      case "add":
      case "login":
        await handleAdd(restArgs, ctx);
        break;
      case "switch":
      case "set":
        handleSwitch(restArgs, ctx);
        break;
      case "rotate":
      case "next":
        handleRotate(ctx);
        break;
      case "remove":
      case "delete":
      case "rm":
        await handleRemove(restArgs, ctx);
        break;
      case "rename":
      case "email": {
        const parts = restArgs.trim().split(/\s+/);
        const idx = parseInt(parts[0], 10) - 1;
        const email = parts.slice(1).join(" ");
        if (!Number.isInteger(idx) || !email) {
          ctx.ui.notify("Usage: /claude-pool rename <#> <email>", "warning");
        } else if (pool.renameAccount(idx, email)) {
          ctx.ui.notify(`Account #${idx + 1} is now labeled ${email}.`, "info");
        } else {
          ctx.ui.notify(`Invalid account number: ${idx + 1}`, "error");
        }
        break;
      }
      case "cooldown":
      case "reset":
        handleCooldown(restArgs, ctx);
        break;
      case "mode":
      case "strategy": {
        const parts = restArgs.trim().split(/\s+/).filter(Boolean);
        const strat = (parts[0] || "").toLowerCase();
        if (strat === "round-robin" || strat === "rr") {
          pool.setRotationStrategy("round-robin");
          ctx.ui.notify("Rotation strategy set to: round-robin (auto-rotates requests across all healthy accounts).", "info");
        } else if (strat === "failover" || strat === "fo") {
          pool.setRotationStrategy("failover");
          ctx.ui.notify("Rotation strategy set to: failover (uses active account until limited).", "info");
        } else if (strat === "quota-aware" || strat === "qa") {
          // Optional trailing flags: --threshold <pct> --model <name>
          let threshold: number | undefined;
          let modelName: string | undefined;
          for (let i = 1; i < parts.length; i++) {
            if (parts[i] === "--threshold" && parts[i + 1]) { threshold = Number(parts[i + 1]); i++; }
            if (parts[i] === "--model" && parts[i + 1]) { modelName = parts[i + 1]; i++; }
          }
          pool.setRotationStrategy("quota-aware");
          if (threshold !== undefined || modelName !== undefined) {
            pool.setQuotaAwareConfig({
              ...(Number.isFinite(threshold) ? { thresholdPct: threshold } : {}),
              ...(modelName ? { model: modelName } : {}),
            });
          }
          ctx.ui.notify(
            `Rotation strategy set to: quota-aware (proactively switches before an account hits its limit; threshold=${threshold ?? "90 (default)"}${modelName ? `, model=${modelName}` : ""}). Ideas ported from claude-swap's rotation logic, ADR 2026-09-04.`,
            "info",
          );
        } else {
          ctx.ui.notify(`Current rotation strategy: ${pool.getRotationStrategy()}.\nUsage: /claude-pool mode [round-robin|failover|quota-aware [--threshold <pct>] [--model <name>]]`, "info");
        }
        break;
      }
      case "status":
      case "list":
      case "ls":
      default:
        handleStatus(ctx);
        break;
    }
  };

  pi.registerCommand("claude-pool", {
    description: "Manage Anthropic Claude multi-account rotation pool: /claude-pool [status|add|switch|rotate|remove|cooldown]",
    handler: poolCommandHandler,
  });

  pi.registerCommand("claude:accounts", {
    description: "Alias for /claude-pool",
    handler: poolCommandHandler,
  });

  pi.registerCommand("pool-widget", {
    description: "Toggle the detailed model-limits pool widget (above editor)",
    handler: async (_args, ctx) => {
      widgetEnabled = !widgetEnabled;
      if (widgetEnabled) {
        installWidget(ctx);
        ctx.ui.notify("Pool & limits widget shown.", "info");
      } else {
        ctx.ui.setWidget("pool-model-status", undefined);
        ctx.ui.notify("Pool & limits widget hidden (/pool-widget to show).", "info");
      }
    },
  });
}
