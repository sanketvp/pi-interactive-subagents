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

export interface LifecycleAdapter {
  tmux: TmuxFn;
  fs: LifecycleFs;
  now: () => number;
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
  };
}

let currentAdapter: LifecycleAdapter = createDefaultAdapter();

export function getLifecycleAdapter(): LifecycleAdapter {
  return currentAdapter;
}

export function setLifecycleAdapter(adapter: LifecycleAdapter | null | undefined): void {
  currentAdapter = adapter ?? createDefaultAdapter();
}

export function resetLifecycleAdapter(): void {
  currentAdapter = createDefaultAdapter();
}
