/**
 * Policy + accepted profile bodies (plan v1.3 §2, A14, A15, §13 per-file invalid).
 *
 * Per-file invalid rule: each policy file is hashed and validated independently.
 * A malformed/invalid file does not contribute its keys (defaults apply for those
 * keys) and its body digest is recorded in `rejectedDigests`. Sibling files still
 * load. Accepting a policy (P10) atomically replaces profile copies; rejecting
 * leaves copies untouched (G9).
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { DEFAULT_GATING, type Family, type Gating } from "./types.ts";
import { profileDigest, PROFILE_ROLE_MAP, isKnownProfile } from "./roles.ts";
import { setAdditiveFamilies } from "./family.ts";

export const POLICY_FILES = {
  config: "review-config.json",
  families: "families.json",
  accepted: "review-policy.accepted.json",
} as const;

export interface SandboxPolicy {
  cacheDirs: string[];
  allowLoopback: boolean;
  authorNetwork: boolean;
  unixSockets: string[];
  env: Record<string, string>;
  verifyTimeoutMs: number;
  selfTest: { dnsName: string };
}

export interface LoadedPolicy {
  policyDigest: string;
  rejectedDigests: string[];
  invalidFiles: string[];
  coverageRoots: string[];
  sandbox: SandboxPolicy;
  verifyCommands: Record<string, string[]>;
  launchArgv: string[];
  launchArgvDigest: string;
  defaultGating: Gating;
  requireHealthProbe: boolean;
  familiesAdditive: Record<string, Family>;
  profiles: Record<string, { body: string; digest: string }>;
  acceptedDigest: string | null;
}

export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
  cacheDirs: [],
  allowLoopback: false,
  authorNetwork: true,
  unixSockets: [],
  env: {},
  verifyTimeoutMs: 20 * 60 * 1000,
  selfTest: { dnsName: "example.com" },
};

/** Pinned argv pin (A15): always `--no-approve`, never `-a`. */
export const DEFAULT_LAUNCH_ARGV = ["pi", "--no-approve"];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function readOptional(path: string): { ok: true; raw: Buffer } | { ok: false; missing: true } | { ok: false; raw: Buffer } {
  try {
    return { ok: true, raw: readFileSync(path) };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { ok: false, missing: true };
    return { ok: false, raw: Buffer.alloc(0) };
  }
}

function parseJson(raw: Buffer): unknown {
  return JSON.parse(raw.toString("utf8"));
}

function isGating(value: unknown): value is Gating {
  return value === "on" || value === "shadow" || value === "off" || value === "legacy";
}

function isFamily(value: unknown): value is Family {
  return value === "anthropic" || value === "openai" || value === "xai" || value === "moonshot" || value === "zai";
}

function validateLaunchArgv(argv: unknown): string[] | null {
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) return null;
  const args = argv as string[];
  if (args.includes("-a") || args.includes("--approve")) return null;
  if (!args.includes("--no-approve")) return null;
  return args;
}

function parseSandbox(raw: unknown): SandboxPolicy | null {
  if (raw === undefined) return { ...DEFAULT_SANDBOX_POLICY, cacheDirs: [...DEFAULT_SANDBOX_POLICY.cacheDirs], unixSockets: [], env: {}, selfTest: { ...DEFAULT_SANDBOX_POLICY.selfTest } };
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const out: SandboxPolicy = {
    cacheDirs: Array.isArray(s.cacheDirs) && s.cacheDirs.every((x) => typeof x === "string") ? [...(s.cacheDirs as string[])] : [...DEFAULT_SANDBOX_POLICY.cacheDirs],
    allowLoopback: typeof s.allowLoopback === "boolean" ? s.allowLoopback : DEFAULT_SANDBOX_POLICY.allowLoopback,
    authorNetwork: typeof s.authorNetwork === "boolean" ? s.authorNetwork : DEFAULT_SANDBOX_POLICY.authorNetwork,
    unixSockets: Array.isArray(s.unixSockets) && s.unixSockets.every((x) => typeof x === "string") ? [...(s.unixSockets as string[])] : [],
    env: s.env && typeof s.env === "object" && !Array.isArray(s.env)
      ? Object.fromEntries(Object.entries(s.env as Record<string, unknown>).filter(([, v]) => typeof v === "string") as [string, string][])
      : {},
    verifyTimeoutMs: Number.isInteger(s.verifyTimeoutMs) && (s.verifyTimeoutMs as number) > 0 ? (s.verifyTimeoutMs as number) : DEFAULT_SANDBOX_POLICY.verifyTimeoutMs,
    selfTest: {
      dnsName:
        s.selfTest && typeof s.selfTest === "object" && typeof (s.selfTest as any).dnsName === "string"
          ? (s.selfTest as any).dnsName
          : DEFAULT_SANDBOX_POLICY.selfTest.dnsName,
    },
  };
  return out;
}

function parseConfig(raw: unknown): {
  coverageRoots: string[];
  sandbox: SandboxPolicy;
  verifyCommands: Record<string, string[]>;
  launchArgv: string[];
  defaultGating: Gating;
  requireHealthProbe: boolean;
} | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const sandbox = parseSandbox(c.sandbox);
  if (!sandbox) return null;
  const coverageRoots = Array.isArray(c.coverageRoots) && c.coverageRoots.every((x) => typeof x === "string") ? [...(c.coverageRoots as string[])] : [];
  const verifyCommands: Record<string, string[]> = Object.create(null);
  if (c.verifyCommands !== undefined) {
    if (!c.verifyCommands || typeof c.verifyCommands !== "object" || Array.isArray(c.verifyCommands)) return null;
    for (const [root, cmds] of Object.entries(c.verifyCommands as Record<string, unknown>)) {
      if (!root || root === "__proto__" || root === "constructor" || root === "prototype") return null;
      if (!Array.isArray(cmds) || cmds.some((x) => typeof x !== "string")) return null;
      verifyCommands[root] = [...(cmds as string[])];
    }
  }
  let launchArgv = DEFAULT_LAUNCH_ARGV.slice();
  if (c.launchArgv !== undefined) {
    const parsed = validateLaunchArgv(c.launchArgv);
    if (!parsed) return null;
    launchArgv = parsed;
  }
  let defaultGating: Gating = DEFAULT_GATING;
  if (c.defaultGating !== undefined) {
    if (!isGating(c.defaultGating)) return null;
    // PR-1 must not provide a config path to gating 'on' (approved scope is shadow).
    defaultGating = c.defaultGating === "on" ? DEFAULT_GATING : c.defaultGating;
  }
  const requireHealthProbe = c.requireHealthProbe === undefined ? true : c.requireHealthProbe === true;
  if (c.requireHealthProbe !== undefined && typeof c.requireHealthProbe !== "boolean") return null;
  return { coverageRoots, sandbox, verifyCommands, launchArgv, defaultGating, requireHealthProbe };
}

function parseFamilies(raw: unknown): Record<string, Family> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, Family> = Object.create(null);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== "string" || !key) return null;
    if (!isFamily(value)) return null;
    out[key] = value;
  }
  return out;
}

function loadProfiles(agentsDir: string): Record<string, { body: string; digest: string }> {
  const profiles: Record<string, { body: string; digest: string }> = Object.create(null);
  if (!existsSync(agentsDir)) return profiles;
  let names: string[] = [];
  try {
    names = readdirSync(agentsDir);
  } catch {
    return profiles;
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const profileName = name.slice(0, -3);
    if (!isKnownProfile(profileName)) continue;
    try {
      const body = readFileSync(join(agentsDir, name));
      profiles[profileName] = { body: body.toString("utf8"), digest: profileDigest(body) };
    } catch {
      // unreadable profile: skip (launch of that name will fail closed)
    }
  }
  return profiles;
}

export function loadPolicy(opts: { configDir: string; agentsDir: string }): LoadedPolicy {
  const rejectedDigests: string[] = [];
  const invalidFiles: string[] = [];

  const defaults = parseConfig({})!;
  let coverageRoots = defaults.coverageRoots;
  let sandbox = defaults.sandbox;
  let verifyCommands = defaults.verifyCommands;
  let launchArgv = defaults.launchArgv;
  let defaultGating = DEFAULT_GATING;
  let requireHealthProbe = true;
  let familiesAdditive: Record<string, Family> = {};
  let acceptedDigest: string | null = null;

  const configPath = join(opts.configDir, POLICY_FILES.config);
  const configRead = readOptional(configPath);
  if (configRead.ok) {
    try {
      const parsed = parseConfig(parseJson(configRead.raw));
      if (!parsed) throw new Error("invalid");
      coverageRoots = parsed.coverageRoots;
      sandbox = parsed.sandbox;
      verifyCommands = parsed.verifyCommands;
      launchArgv = parsed.launchArgv;
      defaultGating = parsed.defaultGating;
      requireHealthProbe = parsed.requireHealthProbe;
    } catch {
      rejectedDigests.push(sha256(configRead.raw));
      invalidFiles.push(POLICY_FILES.config);
    }
  } else if (!("missing" in configRead) || !configRead.missing) {
    rejectedDigests.push(sha256((configRead as { raw: Buffer }).raw ?? Buffer.alloc(0)));
    invalidFiles.push(POLICY_FILES.config);
  }

  const famPath = join(opts.configDir, POLICY_FILES.families);
  const famRead = readOptional(famPath);
  if (famRead.ok) {
    try {
      const parsed = parseFamilies(parseJson(famRead.raw));
      if (!parsed) throw new Error("invalid");
      familiesAdditive = parsed;
    } catch {
      rejectedDigests.push(sha256(famRead.raw));
      invalidFiles.push(POLICY_FILES.families);
    }
  } else if (!("missing" in famRead) || !famRead.missing) {
    rejectedDigests.push(sha256((famRead as { raw: Buffer }).raw ?? Buffer.alloc(0)));
    invalidFiles.push(POLICY_FILES.families);
  }

  const accPath = join(opts.configDir, POLICY_FILES.accepted);
  const accRead = readOptional(accPath);
  if (accRead.ok) {
    try {
      const parsed = parseJson(accRead.raw);
      if (!parsed || typeof parsed !== "object" || typeof (parsed as any).digest !== "string") throw new Error("invalid");
      acceptedDigest = (parsed as any).digest;
    } catch {
      rejectedDigests.push(sha256(accRead.raw));
      invalidFiles.push(POLICY_FILES.accepted);
    }
  }

  const profiles = loadProfiles(opts.agentsDir);
  setAdditiveFamilies(familiesAdditive);

  const launchArgvDigest = sha256(canonicalJson(launchArgv));
  const policyDigest = sha256(
    canonicalJson({
      coverageRoots,
      sandbox,
      verifyCommands,
      launchArgv,
      defaultGating,
      requireHealthProbe,
      familiesAdditive,
      profiles: Object.fromEntries(Object.entries(profiles).map(([k, v]) => [k, v.digest])),
    }),
  );

  return {
    policyDigest,
    rejectedDigests,
    invalidFiles,
    coverageRoots,
    sandbox,
    verifyCommands,
    launchArgv,
    launchArgvDigest,
    defaultGating,
    requireHealthProbe,
    familiesAdditive,
    profiles,
    acceptedDigest,
  };
}

/**
 * Persist accepted profile bodies as launch copies (A14):
 * `<sessionDir>/profiles/<digest>/<name>.md`
 */
export function materializeProfileCopies(
  sessionDir: string,
  policy: LoadedPolicy,
): Record<string, { digest: string; path: string }> {
  const dir = join(sessionDir, "profiles", policy.policyDigest);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const copies: Record<string, { digest: string; path: string }> = Object.create(null);
  for (const name of Object.keys(PROFILE_ROLE_MAP)) {
    if (!Object.hasOwn(policy.profiles, name)) continue;
    const profile = policy.profiles[name];
    const path = join(dir, `${name}.md`);
    writeFileSync(path, profile.body, { mode: 0o600 });
    copies[name] = { digest: profile.digest, path: path };
  }
  return copies;
}

export function profileCopyPath(sessionDir: string, digest: string, name: string): string {
  return join(sessionDir, "profiles", digest, `${basename(name)}.md`);
}
