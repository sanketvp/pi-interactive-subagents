import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync, unlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  HARDENED_GIT_C_ARGS,
  HARDENED_GIT_DIFF_FLAGS,
  HARDENED_GIT_PREFIX,
  PINNED_GIT_SEARCH_DIRS,
  buildHardenedGitSpawn,
  hardenedGitUtf8,
  lastHardenedGitSpawn,
  resetHardenedGitSandboxHook,
  resetResolvedGitPath,
  resolvedGitPath,
} from "../pi-extension/subagents/review/hardened-git.ts";
import {
  createDefaultAdapter,
  setLifecycleAdapter,
  resetLifecycleAdapter,
  type SandboxAdapter,
} from "../pi-extension/subagents/adapter.ts";

function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "pipe" });
}

describe("hardenedGit", () => {
  it("argv prefix and env are exact", () => {
    resetHardenedGitSandboxHook();
    const privateTmp = mkdtempSync(join(tmpdir(), "pi-git-home-"));
    assert.deepEqual([...HARDENED_GIT_PREFIX], [...HARDENED_GIT_C_ARGS, ...HARDENED_GIT_DIFF_FLAGS]);
    const spawn = buildHardenedGitSpawn(["status", "--porcelain"], { cwd: "/tmp", privateTmp });
    assert.equal(spawn.argv[0], resolvedGitPath());
    assert.equal(spawn.argv[0].startsWith("/"), true);
    assert.match(spawn.argv[0], /\/git$/);
    assert.deepEqual(spawn.argv.slice(1, 1 + HARDENED_GIT_C_ARGS.length), [...HARDENED_GIT_C_ARGS]);
    assert.deepEqual(spawn.argv.slice(1 + HARDENED_GIT_C_ARGS.length), ["status", "--porcelain"]);
    const diffSpawn = buildHardenedGitSpawn(["diff"], { cwd: "/tmp", privateTmp });
    assert.deepEqual(diffSpawn.argv.slice(1 + HARDENED_GIT_C_ARGS.length), ["diff", ...HARDENED_GIT_DIFF_FLAGS]);
    const envKeys = Object.keys(spawn.env).sort();
    assert.deepEqual(envKeys, ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "HOME", "PATH"]);
    assert.equal(spawn.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(spawn.env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(spawn.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(spawn.env.HOME, privateTmp);
  });

  it("a .git/config with core.fsmonitor / diff.external / credential.helper produces zero child processes other than git", () => {
    resetHardenedGitSandboxHook();
    const root = mkdtempSync(join(tmpdir(), "pi-hgit-"));
    const repo = join(root, "repo");
    initRepo(repo);
    const canary = join(root, "canary");
    const helper = join(root, "helper.sh");
    writeFileSync(helper, `#!/bin/sh\necho ran >> "${canary}"\nexit 0\n`);
    chmodSync(helper, 0o755);
    execFileSync("git", ["config", "core.fsmonitor", helper], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["config", "diff.external", helper], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["config", "credential.helper", `!${helper}`], { cwd: repo, stdio: "pipe" });
    writeFileSync(join(repo, "a.txt"), "hello\n");
    execFileSync("git", ["add", "a.txt"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "c"], { cwd: repo, stdio: "pipe" });
    writeFileSync(join(repo, "a.txt"), "hello world\n");
    if (existsSync(canary)) unlinkSync(canary);

    const privateTmp = join(root, "tmp");
    mkdirSync(privateTmp);
    hardenedGitUtf8(["status", "--porcelain"], { cwd: repo, privateTmp });
    assert.equal(existsSync(canary), false, "core.fsmonitor must not spawn helper");
    hardenedGitUtf8(["diff"], { cwd: repo, privateTmp });
    assert.equal(existsSync(canary), false, "diff.external must not spawn helper");
    try {
      hardenedGitUtf8(["credential", "fill"], {
        cwd: repo,
        privateTmp,
        input: "protocol=https\nhost=example.com\n\n",
      });
    } catch {
      // fill with no helper may fail; the helper must still not have run
    }
    assert.equal(existsSync(canary), false, "credential.helper must not spawn helper");
    hardenedGitUtf8(["hash-object", "-w", "--no-filters", "--", "a.txt"], { cwd: repo, privateTmp });
    const spawn = lastHardenedGitSpawn();
    assert.ok(spawn);
    assert.equal(spawn!.argv[1], "-c");
    assert.equal(spawn!.argv[2], "core.fsmonitor=");
    assert.equal(existsSync(canary), false, "malicious git config must not spawn helper");
  });

  it("confined sandbox result is the only execution (never also execFileSync)", () => {
    resetHardenedGitSandboxHook();
    let confinedCalls = 0;
    const sandbox: SandboxAdapter = {
      available: () => true,
      spawnConfined() {
        confinedCalls += 1;
        return { pid: 1, stdout: Buffer.from("CONFINED-ONLY\n"), status: 0 };
      },
    };
    setLifecycleAdapter({ ...createDefaultAdapter(), sandbox });
    try {
      const privateTmp = mkdtempSync(join(tmpdir(), "pi-git-home-"));
      // cwd does not exist: an unconfined execFileSync fallthrough would throw.
      const out = hardenedGitUtf8(["status"], { cwd: "/no/such/pi-hardened-git-cwd", privateTmp });
      assert.equal(out, "CONFINED-ONLY\n");
      assert.equal(confinedCalls, 1);
    } finally {
      resetLifecycleAdapter();
    }
  });

  it("pinned git dirs win over a fake git prepended to PATH", () => {
    resetResolvedGitPath();
    const evilDir = mkdtempSync(join(tmpdir(), "pi-evilbin-"));
    const evilGit = join(evilDir, "git");
    writeFileSync(evilGit, "#!/bin/sh\necho EVIL-GIT\nexit 0\n");
    chmodSync(evilGit, 0o755);
    const prevPath = process.env.PATH;
    process.env.PATH = `${evilDir}:${prevPath ?? ""}`;
    try {
      resetResolvedGitPath();
      const resolved = resolvedGitPath();
      assert.notEqual(resolved, evilGit);
      assert.ok(!resolved.startsWith(evilDir + "/"), resolved);
      const spawn = buildHardenedGitSpawn(["--version"], {
        cwd: evilDir,
        privateTmp: mkdtempSync(join(tmpdir(), "pi-git-home-")),
      });
      assert.equal(spawn.argv[0], resolved);
      const pinned = PINNED_GIT_SEARCH_DIRS.some((d) => {
        const candidate = join(d, "git");
        if (resolved === candidate || resolved.startsWith(d + "/")) return true;
        try {
          return existsSync(candidate) && realpathSync(candidate) === resolved;
        } catch {
          return false;
        }
      });
      assert.equal(pinned, true, `resolved git ${resolved} is not a pinned binary`);
      const out = hardenedGitUtf8(["--version"], {
        cwd: evilDir,
        privateTmp: mkdtempSync(join(tmpdir(), "pi-git-home-")),
      });
      assert.match(out, /^git version /);
      assert.doesNotMatch(out, /EVIL-GIT/);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      resetResolvedGitPath();
    }
  });
});

