/**
 * Launch-time artifact path reservation (issue #15).
 * One async primitive: exclusive wx create of a per-canonical-path marker.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  promises as fsp,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";

export interface ArtifactReservation {
  version: 1;
  path: string;
  attemptId: string;
  name: string;
  createdAt: string;
}

export interface ReserveArtifactPathInput {
  path: string;
  baseDir: string;
  reservationsDir: string;
  attemptId: string;
  name: string;
}

export type ReserveArtifactPathResult =
  | { ok: true; canonicalPath: string; markerPath: string; release: () => void }
  | { ok: false; canonicalPath: string; owner: ArtifactReservation | null; message: string };

export function attemptScopedPath(p: string, attemptId: string): string {
  const ext = extname(p);
  if (!ext) return `${p}.${attemptId}`;
  return `${p.slice(0, -ext.length)}.${attemptId}${ext}`;
}

export function canonicalizeArtifactPath(p: string, baseDir: string): string {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0")) {
    throw new Error("artifactPath must be a non-empty path without NUL characters");
  }
  if (p === "." || p === "./") {
    throw new Error('artifactPath must not be "."');
  }
  const resolved = resolve(baseDir, p);
  let current = resolved;
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  let realBase = current;
  try {
    realBase = realpathSync(current);
  } catch {
    // ancestor vanished between existsSync and realpath; keep current
  }
  const canonical = normalize(missing.length === 0 ? realBase : join(realBase, ...missing));
  if (existsSync(canonical)) {
    const st = statSync(canonical);
    if (st.isDirectory()) {
      throw new Error(`artifactPath ${canonical} is a directory`);
    }
    if (!st.isFile()) {
      throw new Error(`artifactPath ${canonical} is not a regular file`);
    }
  }
  return canonical;
}

export function reservationMarkerPath(reservationsDir: string, canonicalPath: string): string {
  const digest = createHash("sha256").update(canonicalPath).digest("hex");
  return join(reservationsDir, `${digest}.json`);
}

function parseReservation(raw: string): ArtifactReservation | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed?.version !== 1 ||
      typeof parsed.path !== "string" ||
      typeof parsed.attemptId !== "string" ||
      typeof parsed.name !== "string"
    ) {
      return null;
    }
    return parsed as ArtifactReservation;
  } catch {
    return null;
  }
}

export function readReservationOwner(
  reservationsDir: string,
  canonicalPath: string,
): ArtifactReservation | null {
  try {
    return parseReservation(readFileSync(reservationMarkerPath(reservationsDir, canonicalPath), "utf8"));
  } catch {
    return null;
  }
}

async function readOwnerAfterCollision(
  reservationsDir: string,
  canonicalPath: string,
): Promise<ArtifactReservation | null> {
  const marker = reservationMarkerPath(reservationsDir, canonicalPath);
  for (let i = 0; i < 50; i++) {
    try {
      const raw = readFileSync(marker, "utf8");
      if (raw.trim().length === 0) {
        await new Promise((r) => setTimeout(r, 2));
        continue;
      }
      return parseReservation(raw);
    } catch (error: any) {
      if (error?.code !== "ENOENT") return null;
      await new Promise((r) => setTimeout(r, 2));
    }
  }
  return readReservationOwner(reservationsDir, canonicalPath);
}

function collisionMessage(
  canonicalPath: string,
  attemptId: string,
  owner: ArtifactReservation | null,
): string {
  const alt = attemptScopedPath(canonicalPath, attemptId);
  if (owner) {
    return (
      `artifactPath ${canonicalPath} is already reserved by attempt ${owner.attemptId} (${owner.name}). ` +
      `Use ${alt} or a fresh <name>.<profile>.<attemptId>.md path; /subagents-diagnose before reusing a path.`
    );
  }
  return (
    `artifactPath ${canonicalPath} is already reserved (marker unreadable). ` +
    `Use ${alt} or a fresh <name>.<profile>.<attemptId>.md path; /subagents-diagnose before reusing a path.`
  );
}

export async function reserveArtifactPath(
  input: ReserveArtifactPathInput,
): Promise<ReserveArtifactPathResult> {
  const canonicalPath = canonicalizeArtifactPath(input.path, input.baseDir);
  const markerPath = reservationMarkerPath(input.reservationsDir, canonicalPath);
  await fsp.mkdir(input.reservationsDir, { recursive: true, mode: 0o700 });
  const reservation: ArtifactReservation = {
    version: 1,
    path: canonicalPath,
    attemptId: input.attemptId,
    name: input.name,
    createdAt: new Date().toISOString(),
  };
  try {
    await fsp.writeFile(markerPath, JSON.stringify(reservation), { flag: "wx", mode: 0o600 });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    // wx creates the file before the JSON bytes land; wait for non-empty
    // contents so a racing loser names the owner instead of "unreadable".
    const owner = await readOwnerAfterCollision(input.reservationsDir, canonicalPath);
    return {
      ok: false,
      canonicalPath,
      owner,
      message: collisionMessage(canonicalPath, input.attemptId, owner),
    };
  }
  return {
    ok: true,
    canonicalPath,
    markerPath,
    release() {
      try {
        unlinkSync(markerPath);
      } catch {
        // best-effort
      }
    },
  };
}

export function guardReservedArtifactWrite(
  event: { toolName: string; input: { path?: unknown } },
  opts: {
    selfAttemptId: string;
    ownPath: string | null;
    reservationsDir: string | null;
    baseDir: string;
  },
): { block: true; reason: string } | undefined {
  if (!opts.selfAttemptId || !opts.reservationsDir) return;
  if (event.toolName !== "write" && event.toolName !== "edit") return;
  if (typeof event.input?.path !== "string") return;
  let canonical: string;
  try {
    canonical = canonicalizeArtifactPath(event.input.path, opts.baseDir);
  } catch {
    return;
  }
  if (opts.ownPath && canonical === opts.ownPath) return;
  const owner = readReservationOwner(opts.reservationsDir, canonical);
  if (!owner || owner.attemptId === opts.selfAttemptId) return;
  return {
    block: true,
    reason:
      `${canonical} is reserved by attempt ${owner.attemptId}; ` +
      `you are attempt ${opts.selfAttemptId} (artifact ${opts.ownPath ?? "none"})`,
  };
}
