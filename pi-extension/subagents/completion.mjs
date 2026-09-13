// Private, per-attempt completion records. Tokens prevent accidental/stale or
// transcript-text completion; this is not a security boundary against the OS user.
import { writeFileSync, mkdirSync, linkSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

function requireEnv(env, key) {
  const value = env[key];
  if (!value) throw new Error("Missing worker completion identity");
  return value;
}

export function completionFromEnv(payload, env = process.env) {
  if (!env.PI_SUBAGENT_COMPLETION_FILE || !env.PI_SUBAGENT_TOKEN || !env.PI_SUBAGENT_ID || !env.PI_SUBAGENT_SESSION) {
    throw new Error("Missing worker completion identity");
  }
  const attemptId = env.PI_SUBAGENT_ID;
  return {
    version: 1,
    attemptId,
    token: env.PI_SUBAGENT_TOKEN,
    sessionFile: env.PI_SUBAGENT_SESSION,
    ...payload,
  };
}

export function validateCompletion(data, expected) {
  if (!data || !["done", "ping", "error"].includes(data.type)) throw new Error("Invalid worker outcome");
  if (expected) {
    if (data.version !== 1) throw new Error("Worker completion identity mismatch");
    const attemptId = expected.attemptId ?? expected.workerId;
    if (data.attemptId !== attemptId || data.token !== expected.token || data.sessionFile !== expected.sessionFile) {
      throw new Error("Worker completion identity mismatch");
    }
    if (data.type === "done" || data.type === "ping") {
      if (!expected.piSessionId || !data.piSessionId || data.piSessionId !== expected.piSessionId) {
        throw new Error("done/ping require the exact established piSessionId");
      }
    }
    // After startup has been observed the child UUID is established; an error
    // receipt must then carry that exact UUID (a missing/different UUID is a
    // foreign or stale writer). Pre-start shell errors may legitimately omit it.
    if (data.type === "error" && expected.requirePiSessionId) {
      if (!expected.piSessionId || !data.piSessionId || data.piSessionId !== expected.piSessionId) {
        throw new Error("Post-start error receipt must bind to the established piSessionId");
      }
    }
  }
  return data;
}

// Atomically publish `value` at `path`, but NEVER replace an existing
// terminal record: first writer wins. Returns true if this call's value is
// the one that landed on disk, false if an existing record was preserved
// (in which case the caller's value was discarded).
export function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID() + ".tmp";
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  try {
    // Hard-link fails with EEXIST if `path` already exists, unlike
    // renameSync (which silently replaces it on POSIX). This makes
    // publication atomically first-writer-wins.
    linkSync(temp, path);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return false;
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // best-effort temp cleanup
    }
  }
}

export function writeCompletion(payload, env = process.env) {
  const value = completionFromEnv(payload, env);
  if ((value.type === "done" || value.type === "ping") && !value.piSessionId) {
    throw new Error("done/ping require the exact established piSessionId");
  }
  writeAtomic(env.PI_SUBAGENT_COMPLETION_FILE, value);
  return value;
}

export function writeStartupReceipt(fields, env = process.env) {
  const completionFile = requireEnv(env, "PI_SUBAGENT_COMPLETION_FILE");
  if (!fields?.piSessionId) throw new Error("Startup receipt missing piSessionId");
  if (!fields?.observed?.provider || !fields?.observed?.model || fields.observed.thinking == null) {
    throw new Error("Startup receipt missing ctx.model/ctx.thinkingLevel fields");
  }
  const value = {
    version: 1,
    kind: "startup",
    attemptId: requireEnv(env, "PI_SUBAGENT_ID"),
    token: requireEnv(env, "PI_SUBAGENT_TOKEN"),
    sessionFile: requireEnv(env, "PI_SUBAGENT_SESSION"),
    piSessionId: fields.piSessionId,
    observed: {
      provider: fields.observed.provider,
      model: fields.observed.model,
      thinking: String(fields.observed.thinking),
    },
  };
  writeAtomic(`${completionFile}.start`, value);
  return value;
}

export function validateStartupReceipt(data, expected) {
  if (!data || data.version !== 1 || data.kind !== "startup") throw new Error("Invalid startup receipt");
  if (!data.piSessionId) throw new Error("Startup receipt missing piSessionId");
  if (!data.observed?.provider || !data.observed?.model || data.observed.thinking == null) {
    throw new Error("Startup receipt missing observed provider/model/thinking");
  }
  if (expected) {
    if (data.attemptId !== expected.attemptId || data.token !== expected.token) {
      throw new Error("Startup receipt identity mismatch");
    }
    if (expected.sessionFile && data.sessionFile !== expected.sessionFile) {
      throw new Error("Startup receipt session path mismatch");
    }
    if (expected.piSessionId && data.piSessionId !== expected.piSessionId) {
      throw new Error("Startup receipt session UUID mismatch");
    }
  }
  return data;
}

export function writeExitReceipt(fields) {
  const value = {
    version: 1,
    kind: "shell-exit",
    attemptId: fields.attemptId,
    token: fields.token,
    sessionFile: fields.sessionFile,
    exitCode: fields.exitCode,
    piSessionId: fields.piSessionId ?? null,
  };
  const path = `${fields.path}.exit`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return value;
}

export function validateExitReceipt(data, expected) {
  if (!data || data.version !== 1 || data.kind !== "shell-exit") throw new Error("Invalid shell-exit receipt");
  if (!Number.isInteger(data.exitCode)) throw new Error("Invalid shell-exit receipt");
  if (expected && (data.attemptId !== expected.attemptId || data.token !== expected.token || data.sessionFile !== expected.sessionFile)) {
    throw new Error("Shell-exit receipt identity mismatch");
  }
  // Same post-start binding rule as error receipts: once the child UUID is
  // established, the shell-exit receipt must name exactly that session.
  if (expected?.requirePiSessionId) {
    if (!expected.piSessionId || !data.piSessionId || data.piSessionId !== expected.piSessionId) {
      throw new Error("Post-start shell-exit receipt must bind to the established piSessionId");
    }
  }
  return data;
}

function readJsonIfExists(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Shell fallback reports process exit with the same attempt identity. Never
// overwrite an earlier child-produced error/ping/done record. Exit 0 without a
// child outcome is an error. This writes a distinct shell-exit receipt AFTER
// the Pi process exits.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [path, attemptId, token, sessionFile, code] = process.argv.slice(2);
  if (!path || !attemptId || !token || !sessionFile || !/^\d+$/.test(code ?? "")) process.exit(64);
  const exitCode = Number(code);
  const start = readJsonIfExists(`${path}.start`);
  const piSessionId = start?.piSessionId ?? null;
  writeExitReceipt({ path, attemptId, token, sessionFile, exitCode, piSessionId });
  const existing = readJsonIfExists(path);
  if (existing) process.exit(0);
  const isPreStart = !start;
  const value = {
    version: 1,
    attemptId,
    token,
    sessionFile,
    piSessionId: isPreStart ? null : piSessionId,
    type: "error",
    errorMessage:
      exitCode === 0
        ? "pi exited 0 without a completion record"
        : `Pi process exited ${exitCode}`,
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
