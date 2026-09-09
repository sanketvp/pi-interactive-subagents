/**
 * Harness-side git shim (plan v1.3 §8.4).
 *
 * Every git call from artifact/worktree/triggers/git_ro routes through this
 * module. Argv prefix and env are EXACTLY the hardened set below.
 *
 * The sandbox hook is a NO-OP in PR-1 (PR-3 enables `harness-git` confinement).
 * Under shadow, git runs with the hardened set only.
 */
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { getLifecycleAdapter, type ConfinedSpawnResult, type SandboxAdapter } from "../adapter.ts";

/** Hardened `-c` set from §8.4. These are valid git global options. */
export const HARDENED_GIT_C_ARGS: readonly string[] = [
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.hooksPath=/var/empty",
  "-c",
  "diff.external=",
  "-c",
  "core.pager=cat",
  "-c",
  "core.sshCommand=/usr/bin/false",
  "-c",
  "credential.helper=",
  "-c",
  "gpg.program=/usr/bin/false",
  "-c",
  "protocol.allow=never",
];

/**
 * §8.4 also specifies `--no-ext-diff --no-textconv`. Those are diff-family
 * options, not git globals; they are inserted immediately after a supporting
 * subcommand so `git status` still runs. Combined with the `-c` set this is
 * the exact hardened prefix.
 */
export const HARDENED_GIT_DIFF_FLAGS: readonly string[] = ["--no-ext-diff", "--no-textconv"];

export const HARDENED_GIT_PREFIX: readonly string[] = [...HARDENED_GIT_C_ARGS, ...HARDENED_GIT_DIFF_FLAGS];

const DIFF_SUBCOMMANDS = new Set(["diff", "diff-tree", "show", "log", "format-patch", "range-diff"]);

const BASE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";

const PINNED_GIT_DIRS = ["/opt/homebrew/bin", "/usr/bin", "/usr/local/bin", "/bin"];

let pinnedGit: string | null = null;

function isExecutableFile(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function realPathOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isUnderDir(real: string, dir: string): boolean {
  let root = dir;
  try {
    root = realpathSync(dir);
  } catch {
    /* keep dir */
  }
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Reject binaries whose realpath lands in a world-writable temp tree. */
function isWritableEscape(real: string): boolean {
  for (const dir of [tmpdir(), "/tmp", "/var/tmp", "/private/tmp"]) {
    if (isUnderDir(real, dir)) return true;
  }
  return false;
}

function considerGit(candidate: string): string | null {
  if (!isExecutableFile(candidate)) return null;
  const real = realPathOf(candidate) ?? candidate;
  if (isWritableEscape(real)) return null;
  try {
    const st = lstatSync(candidate);
    if (st.isSymbolicLink() && isWritableEscape(real)) return null;
  } catch {
    return null;
  }
  return real;
}

/** Resolve `git` to an absolute path once. Pinned dirs are searched FIRST (§8.4). */
export function resolvedGitPath(): string {
  if (pinnedGit) return pinnedGit;
  for (const dir of PINNED_GIT_DIRS) {
    const hit = considerGit(join(dir, "git"));
    if (hit) {
      pinnedGit = hit;
      return hit;
    }
  }
  for (const dir of (process.env.PATH ?? BASE_PATH).split(":")) {
    if (!dir) continue;
    const hit = considerGit(join(dir, "git"));
    if (hit) {
      pinnedGit = hit;
      return hit;
    }
  }
  throw new Error("hardenedGit: git binary not found");
}

export function resetResolvedGitPath(): void {
  pinnedGit = null;
}

export const PINNED_GIT_SEARCH_DIRS: readonly string[] = PINNED_GIT_DIRS;

export interface HardenedGitEnv {
  GIT_CONFIG_NOSYSTEM: "1";
  GIT_CONFIG_GLOBAL: "/dev/null";
  GIT_TERMINAL_PROMPT: "0";
  PATH: string;
  HOME: string;
  [key: string]: string;
}

export interface HardenedGitOptions {
  cwd: string;
  /** Harness-owned private tmp used as HOME so git cannot write ~/.gitconfig. */
  privateTmp?: string;
  input?: string | Buffer;
  extraEnv?: Record<string, string>;
  timeout?: number;
  maxBuffer?: number;
  encoding?: "buffer" | "utf8";
  /** Test-only: override PATH value (still the only inherited name). */
  path?: string;
}

export interface HardenedGitSpawn {
  argv: string[];
  env: HardenedGitEnv;
  cwd: string;
}

export type SandboxHook = (kind: "harness-git", argv: string[], opts: HardenedGitOptions) => void;

let sandboxHook: SandboxHook = () => {
  // PR-1: no-op. PR-3 replaces this with spawnConfined('harness-git', …).
};

let lastSpawn: HardenedGitSpawn | null = null;

export function setHardenedGitSandboxHook(hook: SandboxHook | null | undefined): void {
  sandboxHook = hook ?? (() => {});
}

export function resetHardenedGitSandboxHook(): void {
  sandboxHook = () => {};
}

export function lastHardenedGitSpawn(): HardenedGitSpawn | null {
  return lastSpawn;
}

export function hardenedGitEnv(opts: { privateTmp: string; path?: string; extraEnv?: Record<string, string> }): HardenedGitEnv {
  const env: HardenedGitEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    PATH: opts.path ?? process.env.PATH ?? BASE_PATH,
    HOME: opts.privateTmp,
  };
  if (opts.extraEnv) {
    for (const [key, value] of Object.entries(opts.extraEnv)) {
      if (!Object.hasOwn(opts.extraEnv, key)) continue;
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      if (typeof value === "string") env[key] = value;
    }
  }
  return env;
}

function withDiffFlags(gitArgs: string[]): string[] {
  if (gitArgs.length === 0) return [...gitArgs];
  const cmd = gitArgs[0];
  if (!DIFF_SUBCOMMANDS.has(cmd)) return [...gitArgs];
  return [cmd, ...HARDENED_GIT_DIFF_FLAGS, ...gitArgs.slice(1)];
}

export function buildHardenedGitSpawn(gitArgs: string[], opts: HardenedGitOptions): HardenedGitSpawn {
  const privateTmp = opts.privateTmp ?? join(tmpdir(), "pi-git-home");
  return {
    argv: [resolvedGitPath(), ...HARDENED_GIT_C_ARGS, ...withDiffFlags(gitArgs)],
    env: hardenedGitEnv({ privateTmp, path: opts.path, extraEnv: opts.extraEnv }),
    cwd: opts.cwd,
  };
}

function encodeResult(result: Buffer, encoding: HardenedGitOptions["encoding"]): Buffer | string {
  return encoding === "utf8" ? result.toString("utf8") : result;
}

/**
 * Run git with the hardened argv prefix and stripped env.
 *
 * Exactly one execution path:
 * - `sandbox.available()` → `spawnConfined` result is THE result (never also exec).
 * - otherwise (PR-1 no-op / shadow) → a single unconfined `execFileSync`.
 * Gating `on` + unavailable sandbox is refused by callers (G0/A10), not here.
 */
export function hardenedGit(gitArgs: string[], opts: HardenedGitOptions): Buffer | string {
  const spawn = buildHardenedGitSpawn(gitArgs, opts);
  lastSpawn = spawn;
  sandboxHook("harness-git", spawn.argv, opts);
  const sandbox: SandboxAdapter | undefined = getLifecycleAdapter().sandbox;
  if (sandbox?.available()) {
    if (typeof sandbox.spawnConfined !== "function") {
      throw new Error("sandbox available but spawnConfined is missing");
    }
    const confined: ConfinedSpawnResult = sandbox.spawnConfined("harness-git", spawn.argv, {
      cwd: spawn.cwd,
      env: spawn.env,
      input: opts.input,
    });
    if (confined.status !== 0) {
      const err = new Error(`confined git exited ${confined.status}`) as Error & {
        status: number;
        stdout: Buffer;
        stderr?: Buffer;
      };
      err.status = confined.status;
      err.stdout = confined.stdout;
      err.stderr = confined.stderr;
      throw err;
    }
    return encodeResult(confined.stdout, opts.encoding);
  }
  const execOpts: ExecFileSyncOptions = {
    cwd: spawn.cwd,
    env: spawn.env,
    input: opts.input,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    timeout: opts.timeout,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: opts.encoding === "utf8" ? "utf8" : null,
  };
  return execFileSync(spawn.argv[0], spawn.argv.slice(1), execOpts) as Buffer | string;
}

export function hardenedGitUtf8(gitArgs: string[], opts: HardenedGitOptions): string {
  const out = hardenedGit(gitArgs, { ...opts, encoding: "utf8" });
  return typeof out === "string" ? out : out.toString("utf8");
}

export function hardenedGitBuffer(gitArgs: string[], opts: HardenedGitOptions): Buffer {
  const out = hardenedGit(gitArgs, { ...opts, encoding: "buffer" });
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}
