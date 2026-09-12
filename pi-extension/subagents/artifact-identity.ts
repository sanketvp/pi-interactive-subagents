/**
 * Run-scoped artifact identity: atomic claim of a canonical path by attempt id.
 * Winner keeps the path; a different attempt is redirected to an attempt-suffixed
 * sibling (both outputs preserved) unless the requested path already embeds this
 * attempt id (D23), in which case a foreign owner is refused — never double-suffixed.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

export const ARTIFACT_IDENTITY_LEDGER = "artifact-identity";

export type ArtifactIdentityReason = "invalid-path" | "invalid-attempt" | "owned";

export interface ArtifactClaim {
  attemptId: string;
  path: string;
  claimedAt: string;
}

export type ArtifactWriteOk = {
  ok: true;
  path: string;
  scoped: boolean;
};

export type ArtifactWriteErr = {
  ok: false;
  reason: ArtifactIdentityReason;
  message: string;
  owner?: string;
};

export type ArtifactWriteResolution = ArtifactWriteOk | ArtifactWriteErr;

export function artifactIdentityLedgerDir(artifactDir: string): string {
  return join(artifactDir, ARTIFACT_IDENTITY_LEDGER);
}

function fail(
  reason: ArtifactIdentityReason,
  message: string,
  owner?: string,
): ArtifactWriteErr {
  return owner === undefined ? { ok: false, reason, message } : { ok: false, reason, message, owner };
}

function isUsableAttemptId(attemptId: string): boolean {
  return attemptId.length > 0 && attemptId.length <= 128 && !/[/\\\0]/.test(attemptId);
}

export function pathCarriesAttemptId(filePath: string, attemptId: string): boolean {
  const base = basename(filePath);
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return stem === attemptId || stem.endsWith(`.${attemptId}`) || base.includes(`.${attemptId}.`);
}

export function applyAttemptSuffix(filePath: string, attemptId: string): string {
  if (pathCarriesAttemptId(filePath, attemptId)) return filePath;
  const dir = dirname(filePath);
  const base = basename(filePath);
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return join(dir, `${stem}.${attemptId}${ext}`);
}

function claimFileFor(ledgerDir: string, canonicalPath: string): string {
  const digest = createHash("sha256").update(canonicalPath).digest("hex");
  return join(ledgerDir, "claims", `${digest}.json`);
}

function parseClaim(raw: string): ArtifactClaim | null {
  try {
    const parsed = JSON.parse(raw) as ArtifactClaim;
    if (parsed && typeof parsed.attemptId === "string" && typeof parsed.path === "string") {
      return parsed;
    }
  } catch {
    // incomplete or corrupt; caller retries
  }
  return null;
}

function readClaimFile(file: string): ArtifactClaim {
  let lastErr: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      const parsed = parseClaim(readFileSync(file, "utf8"));
      if (parsed) return parsed;
    } catch (err) {
      lastErr = err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const until = Date.now() + 5;
    while (Date.now() < until) {
      /* spin until the winner finishes the exclusive create */
    }
  }
  throw new Error(
    `artifact identity claim unreadable: ${file}${lastErr ? ` (${String(lastErr)})` : ""}`,
  );
}

/**
 * Atomically bind `canonicalPath` to `attemptId`. Uses a complete tempfile plus
 * `linkSync` (O_EXCL equivalent) so a racing reader never sees a truncated record.
 */
function claimCanonical(
  ledgerDir: string,
  canonicalPath: string,
  attemptId: string,
): { won: boolean; owner: string } {
  mkdirSync(join(ledgerDir, "claims"), { recursive: true, mode: 0o700 });
  const dest = claimFileFor(ledgerDir, canonicalPath);
  const record: ArtifactClaim = {
    attemptId,
    path: canonicalPath,
    claimedAt: new Date().toISOString(),
  };
  const payload = `${JSON.stringify(record)}\n`;
  const tmp = join(
    ledgerDir,
    "claims",
    `.tmp-${attemptId.slice(0, 32)}-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
  try {
    try {
      linkSync(tmp, dest);
      return { won: true, owner: attemptId };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // Fallback for filesystems without hardlinks: exclusive create.
        if (code === "EXDEV" || code === "ENOTSUP" || code === "EPERM" || code === "ENOSYS") {
          try {
            writeFileSync(dest, payload, { flag: "wx", encoding: "utf8", mode: 0o600 });
            return { won: true, owner: attemptId };
          } catch (wxErr) {
            if ((wxErr as NodeJS.ErrnoException).code !== "EEXIST") throw wxErr;
          }
        } else {
          throw err;
        }
      }
      const existing = readClaimFile(dest);
      return { won: false, owner: existing.attemptId };
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp may already be gone
    }
  }
}

export function readArtifactClaim(ledgerDir: string, path: string): ArtifactClaim | null {
  if (!path?.trim()) return null;
  const file = claimFileFor(ledgerDir, resolve(path));
  if (!existsSync(file)) return null;
  return readClaimFile(file);
}

export function resolveArtifactWrite(params: {
  path: string;
  attemptId: string;
  ledgerDir: string;
}): ArtifactWriteResolution {
  const attemptId = params.attemptId?.trim() ?? "";
  if (!isUsableAttemptId(attemptId)) {
    return fail("invalid-attempt", "attemptId is required and must not contain path separators");
  }
  const rawPath = params.path?.trim() ?? "";
  if (!rawPath) {
    return fail("invalid-path", "artifact path is required");
  }
  const ledgerDir = params.ledgerDir?.trim() ?? "";
  if (!ledgerDir) {
    return fail("invalid-path", "ledgerDir is required");
  }

  const canonical = resolve(rawPath);
  const alreadyScoped = pathCarriesAttemptId(canonical, attemptId);
  const claimed = claimCanonical(ledgerDir, canonical, attemptId);
  if (claimed.won || claimed.owner === attemptId) {
    return { ok: true, path: canonical, scoped: false };
  }

  if (alreadyScoped) {
    return fail(
      "owned",
      `Artifact path '${canonical}' is owned by attempt ${claimed.owner}; this attempt (${attemptId}) cannot overwrite it. Assign a unique D23 path (<name>.<profile>.${attemptId}.md).`,
      claimed.owner,
    );
  }

  const scopedPath = applyAttemptSuffix(canonical, attemptId);
  const scopedClaim = claimCanonical(ledgerDir, scopedPath, attemptId);
  if (scopedClaim.won || scopedClaim.owner === attemptId) {
    return { ok: true, path: scopedPath, scoped: true };
  }
  return fail(
    "owned",
    `Artifact path '${canonical}' is owned by attempt ${claimed.owner}, and scoped path '${scopedPath}' is owned by attempt ${scopedClaim.owner}.`,
    scopedClaim.owner,
  );
}

/** Resolve identity and ensure the parent directory exists. Throws on refusal. */
export function prepareArtifactWrite(params: {
  path: string;
  attemptId: string;
  ledgerDir: string;
}): string {
  const resolved = resolveArtifactWrite(params);
  if (!resolved.ok) throw new Error(resolved.message);
  mkdirSync(dirname(resolved.path), { recursive: true, mode: 0o700 });
  return resolved.path;
}
