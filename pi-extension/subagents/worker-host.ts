import { getLifecycleAdapter, type LifecycleAdapter } from "./adapter.ts";

export interface WorkerHostIdentity {
  kind: "tmux";
  id: string;
}

export interface WorkerSurfaceEvidence {
  surface: string;
  launchCommand: string;
  attemptTag: string;
}

export interface WorkerHost {
  readonly identity: WorkerHostIdentity;
  currentContainer(parentSurface: string): string;
  splitLaunch(container: string, launchScript: string): string;
  listSurfaces(container: string): WorkerSurfaceEvidence[];
  ownsSurface(surface: string, attemptId: string, token: string): boolean;
  ownershipPreamble(attemptId: string, token: string): string;
  clearOwnership(surface: string): void;
  killOwned(surface: string, attemptId: string, token: string): void;
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

  splitLaunch(container: string, launchScript: string): string {
    return requirePaneId(this.tmux([
      "split-window", "-d", "-P", "-F", "#{pane_id}", "-t", container, "--", "bash", launchScript,
    ]), "split-window output");
  }

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

  private tmux(args: string[]): string {
    return this.adapter.tmux(tmuxArgs(this.identity.id, args));
  }
}

export function tmuxSocketFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const socket = env.TMUX?.split(",")[0];
  return socket || null;
}

export function currentWorkerHost(env: NodeJS.ProcessEnv = process.env, adapter = getLifecycleAdapter()): WorkerHost | null {
  const socket = tmuxSocketFromEnv(env);
  return socket ? new TmuxWorkerHost(socket, adapter) : null;
}
