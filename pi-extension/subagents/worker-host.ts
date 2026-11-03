import { getLifecycleAdapter, type LifecycleAdapter } from "./adapter.ts";

export type WorkerHostIdentity =
  | { kind: "tmux"; id: string }
  | { kind: "herdr"; id: string; terminalId?: string };

export interface WorkerHostLaunchOptions {
  cwd: string;
  callerPane?: string;
}

export interface WorkerSurfaceEvidence {
  surface: string;
  launchCommand: string;
  attemptTag: string;
  terminalId?: string;
}

export interface WorkerHost {
  readonly identity: WorkerHostIdentity;
  currentContainer(parentSurface: string): string;
  splitLaunch(container: string, launchScript: string, options?: WorkerHostLaunchOptions): WorkerSurfaceEvidence;
  runLaunch(surface: string, launchScript: string): void;
  listSurfaces(container: string): WorkerSurfaceEvidence[];
  ownsSurface(surface: string, attemptId: string, token: string, launchScript?: string): boolean;
  ownershipPreamble(attemptId: string, token: string): string;
  clearOwnership(surface: string): void;
  killOwned(surface: string, attemptId: string, token: string, launchScript?: string): void;
  interruptOwned(surface: string, attemptId: string, token: string, launchScript?: string): void;
  closeCompleted(surface: string, attemptId: string, token: string, launchScript?: string): void;
}

function tmuxArgs(socket: string, args: string[]): string[] {
  if (!socket) throw new Error("tmux socket is required; refusing default-server operations");
  return ["-S", socket, ...args];
}

function requirePaneId(value: string, context: string): string {
  if (!/^%\d+$/.test(value)) throw new Error(`Unexpected tmux ${context}: ${value}`);
  return value;
}

function requireWindowId(value: string): string {
  if (!/^@\d+$/.test(value)) throw new Error(`Unexpected window id: ${value}`);
  return value;
}

export class TmuxWorkerHost implements WorkerHost {
  readonly identity: WorkerHostIdentity;
  private readonly adapter: LifecycleAdapter;

  constructor(socket: string, adapter: LifecycleAdapter = getLifecycleAdapter()) {
    if (!socket) throw new Error("tmux socket is required; refusing default-server operations");
    this.identity = { kind: "tmux", id: socket };
    this.adapter = adapter;
  }

  currentContainer(parentSurface: string): string {
    return requireWindowId(this.tmux(["display-message", "-p", "-t", parentSurface, "#{window_id}"]));
  }

  splitLaunch(container: string, launchScript: string): WorkerSurfaceEvidence {
    const surface = requirePaneId(this.tmux([
      "split-window", "-d", "-P", "-F", "#{pane_id}", "-t", container, "--", "bash", launchScript,
    ]), "split-window output");
    return { surface, launchCommand: `bash ${launchScript}`, attemptTag: "" };
  }

  runLaunch(_surface: string, _launchScript: string): void {}

  listSurfaces(container: string): WorkerSurfaceEvidence[] {
    const output = this.tmux(["list-panes", "-t", container, "-F", "#{pane_id}\t#{pane_start_command}\t#{@pi-attempt}"]);
    if (!output) return [];
    return output.split(/\r?\n/).filter(Boolean).map((line) => {
      const [surface, launchCommand = "", attemptTag = ""] = line.split("\t");
      return { surface, launchCommand, attemptTag };
    });
  }

  ownsSurface(surface: string, attemptId: string, token: string): boolean {
    requirePaneId(surface, "pane id");
    void attemptId;
    const actualToken = this.tmux(["show-options", "-p", "-v", "-t", surface, "--", "@pi-worker-token"]);
    return actualToken === token;
  }

  ownershipPreamble(attemptId: string, token: string): string {
    return `tmux -S '${this.identity.id.replace(/'/g, `'\\''`)}' set-option -p -t "$TMUX_PANE" @pi-attempt '${attemptId.replace(/'/g, `'\\''`)}' && tmux -S '${this.identity.id.replace(/'/g, `'\\''`)}' set-option -p -t "$TMUX_PANE" @pi-worker-token '${token.replace(/'/g, `'\\''`)}' || exit 66`;
  }

  clearOwnership(surface: string): void {
    requirePaneId(surface, "pane id");
    this.tmux(["set-option", "-pu", "-t", surface, "@pi-attempt"]);
    this.tmux(["set-option", "-pu", "-t", surface, "@pi-worker-token"]);
  }

  killOwned(surface: string, attemptId: string, token: string): void {
    if (!this.ownsSurface(surface, attemptId, token)) throw new Error("Worker pane ownership changed; retaining pane");
    this.tmux(["kill-pane", "-t", surface]);
  }

  interruptOwned(surface: string, attemptId: string, token: string): void {
    if (!this.ownsSurface(surface, attemptId, token)) throw new Error("Worker pane ownership changed; retaining pane");
    this.tmux(["send-keys", "-t", surface, "Escape"]);
  }

  closeCompleted(surface: string, attemptId: string, token: string, launchScript?: string): void {
    this.killOwned(surface, attemptId, token, launchScript);
  }

  private tmux(args: string[]): string {
    return this.adapter.tmux(tmuxArgs(this.identity.id, args));
  }
}

type HerdrPane = {
  pane_id?: unknown;
  terminal_id?: unknown;
  tab_id?: unknown;
  workspace_id?: unknown;
};

function herdrPaneId(value: unknown, context: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Unexpected Herdr ${context}`);
  return value;
}

function herdrJson(output: string, context: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`Unexpected Herdr ${context} JSON`);
  }
}

function paneFromResponse(output: string, context: string): HerdrPane {
  const parsed = herdrJson(output, context);
  const result = parsed.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(`Unexpected Herdr ${context} result`);
  const pane = (result as Record<string, unknown>).pane;
  if (!pane || typeof pane !== "object" || Array.isArray(pane)) throw new Error(`Unexpected Herdr ${context} pane`);
  return pane as HerdrPane;
}

function panesFromResponse(output: string): HerdrPane[] {
  const parsed = herdrJson(output, "pane list");
  const result = parsed.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Unexpected Herdr pane list result");
  const panes = (result as Record<string, unknown>).panes;
  if (!Array.isArray(panes)) throw new Error("Unexpected Herdr pane list panes");
  return panes.filter((pane): pane is HerdrPane => !!pane && typeof pane === "object" && !Array.isArray(pane));
}

function foregroundArgv(output: string, pane: string): string[][] {
  const parsed = herdrJson(output, "pane process-info");
  const result = parsed.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Unexpected Herdr pane process-info result");
  const info = (result as Record<string, unknown>).process_info;
  if (!info || typeof info !== "object" || Array.isArray(info)) throw new Error("Unexpected Herdr pane process-info payload");
  const typed = info as Record<string, unknown>;
  if (typed.pane_id !== pane) throw new Error("Herdr pane process-info identity mismatch");
  const processes = typed.foreground_processes;
  if (!Array.isArray(processes)) throw new Error("Unexpected Herdr foreground processes");
  return processes.flatMap((process) => {
    if (!process || typeof process !== "object" || Array.isArray(process)) return [];
    const argv = (process as Record<string, unknown>).argv;
    return Array.isArray(argv) && argv.every((arg) => typeof arg === "string") ? [argv as string[]] : [];
  });
}

/**
 * Native Herdr worker host.
 *
 * Herdr 0.9.1 uses `pane split`, `pane run`, `pane get`, `pane process-info`,
 * `pane send-keys`, `pane read`, and `pane close` with the JSON fields measured
 * in `data/H0/report.md`.  Every invocation stays argv-based - `pane run` is
 * deliberately the CLI's typed-command API, not a shell command constructed here.
 */
export class HerdrWorkerHost implements WorkerHost {
  readonly identity: WorkerHostIdentity;
  private readonly adapter: LifecycleAdapter;

  constructor(socket: string, terminalId?: string, adapter: LifecycleAdapter = getLifecycleAdapter()) {
    if (!socket) throw new Error("Herdr socket path is required");
    this.identity = { kind: "herdr", id: socket, ...(terminalId ? { terminalId } : {}) };
    this.adapter = adapter;
  }

  currentContainer(parentSurface: string): string {
    const pane = paneFromResponse(this.herdr(["pane", "get", parentSurface]), "pane get");
    return herdrPaneId(pane.tab_id, "pane tab_id");
  }

  splitLaunch(container: string, launchScript: string, options?: WorkerHostLaunchOptions): WorkerSurfaceEvidence {
    if (!options?.callerPane) throw new Error("Herdr caller pane id is required");
    if (!options?.cwd) throw new Error("Herdr worker launch cwd is required");
    const args = ["pane", "split", "--pane", options.callerPane, "--direction", "right", "--cwd", options.cwd, "--no-focus"];
    const pane = paneFromResponse(this.herdr(args), "pane split");
    const surface = herdrPaneId(pane.pane_id, "split pane_id");
    const terminalId = herdrPaneId(pane.terminal_id, "split terminal_id");
    if (pane.tab_id !== container) throw new Error("Herdr split returned a pane outside the recorded tab");
    return { surface, launchCommand: `bash ${launchScript}`, attemptTag: "", terminalId };
  }

  runLaunch(surface: string, launchScript: string): void {
    this.herdr(["pane", "run", surface, "bash", launchScript]);
  }

  listSurfaces(container: string): WorkerSurfaceEvidence[] {
    return panesFromResponse(this.herdr(["pane", "list"]))
      .filter((pane) => pane.tab_id === container)
      .flatMap((pane) => {
        if (typeof pane.pane_id !== "string") return [];
        return [{ surface: pane.pane_id, launchCommand: "", attemptTag: "", terminalId: typeof pane.terminal_id === "string" ? pane.terminal_id : undefined }];
      });
  }

  ownsSurface(surface: string, attemptId: string, token: string, launchScript?: string): boolean {
    void attemptId;
    void token;
    if (!this.identity.terminalId || !launchScript) return false;
    try {
      const pane = paneFromResponse(this.herdr(["pane", "get", surface]), "pane get");
      if (pane.terminal_id !== this.identity.terminalId) return false;
      return foregroundArgv(this.herdr(["pane", "process-info", "--pane", surface]), surface)
        .some((argv) => argv.length === 2 && argv[0] === "bash" && argv[1] === launchScript);
    } catch {
      return false;
    }
  }

  ownershipPreamble(_attemptId: string, _token: string): string {
    // Ownership comes from terminal_id plus the live bash argv, not a mutable pane tag.
    return "true";
  }

  clearOwnership(surface: string): void {
    herdrPaneId(surface, "pane id");
    // There are no Herdr pane tags to clear.  The live argv proof is transient.
  }

  killOwned(surface: string, attemptId: string, token: string, launchScript?: string): void {
    if (!this.ownsSurface(surface, attemptId, token, launchScript)) throw new Error("Worker pane ownership changed; retaining pane");
    this.herdr(["pane", "close", surface]);
  }

  interruptOwned(surface: string, attemptId: string, token: string, launchScript?: string): void {
    if (!this.ownsSurface(surface, attemptId, token, launchScript)) throw new Error("Worker pane ownership changed; retaining pane");
    this.herdr(["pane", "send-keys", surface, "esc"]);
  }

  closeCompleted(surface: string, _attemptId: string, _token: string, _launchScript?: string): void {
    if (!this.identity.terminalId) throw new Error("Worker pane ownership changed; retaining pane");
    const pane = paneFromResponse(this.herdr(["pane", "get", surface]), "pane get");
    if (pane.terminal_id !== this.identity.terminalId) throw new Error("Worker pane ownership changed; retaining pane");
    this.herdr(["pane", "close", surface]);
  }

  private herdr(args: string[]): string {
    return this.adapter.herdr(args);
  }
}

export function tmuxSocketFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const socket = env.TMUX?.split(",")[0];
  return socket || null;
}

export function herdrHostFromEnv(env: NodeJS.ProcessEnv = process.env, adapter = getLifecycleAdapter()): HerdrWorkerHost | null {
  const socket = env.HERDR_SOCKET_PATH;
  const pane = env.HERDR_PANE_ID;
  return socket && pane ? new HerdrWorkerHost(socket, undefined, adapter) : null;
}

export function currentWorkerHost(env: NodeJS.ProcessEnv = process.env, adapter = getLifecycleAdapter()): WorkerHost | null {
  // Pi runs inside tmux when both hosts are present, so the innermost tmux wins.
  const socket = tmuxSocketFromEnv(env);
  if (socket) return new TmuxWorkerHost(socket, adapter);
  return herdrHostFromEnv(env, adapter);
}
