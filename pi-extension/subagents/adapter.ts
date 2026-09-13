import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";

export type TmuxFn = (args: string[]) => string;

export interface LifecycleFs {
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
  mkdirSync: typeof mkdirSync;
  existsSync: typeof existsSync;
  renameSync: typeof renameSync;
  realpathSync: typeof realpathSync;
  unlinkSync: typeof unlinkSync;
  copyFileSync: typeof copyFileSync;
  statSync: typeof statSync;
}

/** Native-addon wrappers; real implementations land in PR-3. Fakeable no-ops in PR-1. */
export interface ConfinedSpawnResult {
  pid: number;
  stdout: Buffer;
  stderr?: Buffer;
  status: number;
}

export interface SandboxAdapter {
  available(): boolean;
  /**
   * Exclusive execution path when `available()` is true. Callers MUST use this
   * result as the process output and MUST NOT also exec `argv` themselves.
   * When `available()` is false the caller runs unconfined (shadow).
   */
  spawnConfined?(
    kind: string,
    argv: string[],
    opts?: { cwd?: string; env?: NodeJS.ProcessEnv; writeRoots?: string[]; input?: string | Buffer },
  ): ConfinedSpawnResult;
}

export interface SocketAdapter {
  listen?(path: string, handler: (msg: unknown) => unknown | Promise<unknown>): { close: () => void };
  send?(path: string, msg: unknown): void;
}

export interface ProcAdapter {
  peerPid?(fd: number): number;
  procInfo?(pid: number): { ppid: number; uid: number; startSec: number; startUsec: number } | null;
  procArgs?(pid: number): string | null;
}

export function createNoopSandboxAdapter(): SandboxAdapter {
  return {
    available: () => false,
    spawnConfined() {
      throw new Error("sandbox adapter is a no-op until PR-3");
    },
  };
}

export function createNoopSocketAdapter(): SocketAdapter {
  return {
    listen() {
      return { close() {} };
    },
    send() {},
  };
}

export function createNoopProcAdapter(): ProcAdapter {
  return {
    peerPid() {
      return 0;
    },
    procInfo() {
      return null;
    },
    procArgs() {
      return null;
    },
  };
}

export interface LifecycleAdapter {
  tmux: TmuxFn;
  fs: LifecycleFs;
  now: () => number;
  sandbox?: SandboxAdapter;
  socket?: SocketAdapter;
  proc?: ProcAdapter;
}

export function createDefaultAdapter(): LifecycleAdapter {
  return {
    tmux(args: string[]): string {
      return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    },
    fs: {
      readFileSync,
      writeFileSync,
      mkdirSync,
      existsSync,
      renameSync,
      realpathSync,
      unlinkSync,
      copyFileSync,
      statSync,
    },
    now: () => Date.now(),
    sandbox: createNoopSandboxAdapter(),
    socket: createNoopSocketAdapter(),
    proc: createNoopProcAdapter(),
  };
}

let currentAdapter: LifecycleAdapter = createDefaultAdapter();

export function getLifecycleAdapter(): LifecycleAdapter {
  return currentAdapter;
}

export function setLifecycleAdapter(adapter: LifecycleAdapter | null | undefined): void {
  if (!adapter) {
    currentAdapter = createDefaultAdapter();
    return;
  }
  const defaults = createDefaultAdapter();
  currentAdapter = {
    ...defaults,
    ...adapter,
    sandbox: adapter.sandbox ?? defaults.sandbox,
    socket: adapter.socket ?? defaults.socket,
    proc: adapter.proc ?? defaults.proc,
  };
}

export function resetLifecycleAdapter(): void {
  currentAdapter = createDefaultAdapter();
}
