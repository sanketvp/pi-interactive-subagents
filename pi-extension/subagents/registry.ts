import { dirname } from "node:path";
import { isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { getLifecycleAdapter, type LifecycleFs } from "./adapter.ts";
import {
  DEFAULT_GATING,
  emptyReviewState,
  emptySandboxState,
  emptyTriggerAggregate,
  type ArtifactKind,
  type ArtifactRecord,
  type ArtifactState,
  type AttemptRecordV2Fields,
  type Contributor,
  type Gating,
  type LaunchIntent,
  type QueueClass,
  type RequestRecord,
  type RequestStatus,
  type ReviewState,
  type SnapshotRecord,
  type WorkerRegistryV2,
} from "./review/types.ts";

export const REGISTRY_VERSION = 1;
/** v2 is unreadable by v1: `validateRegistry` requires version === 1. */
export const REGISTRY_VERSION_V2 = 2 as const;
export const MAX_LIVE_RESOURCES = 4;
export const MAX_CHILD_INVOCATIONS = 12; // default per-lifecycle budget
export const HARD_INVOCATION_CEILING = 100_000; // sanity bound for stored counters when the limit is raised/removed

/**
 * Effective invocation limit for a registry. `invocationLimit` is a per-session
 * override persisted in workers.json: a positive integer raises/lowers the
 * budget, `null` removes the limit for that session permanently, absent means
 * the default. Set only through the user-confirmed /subagent-limit flow.
 */
export function effectiveInvocationLimit(registry: { invocationLimit?: unknown } | null | undefined): number | null {
  const v = registry?.invocationLimit;
  if (v === null) return null;
  if (Number.isInteger(v) && (v as number) > 0) return v as number;
  return MAX_CHILD_INVOCATIONS;
}
export const MAX_PATH_LENGTH = 4096;

export const RESOURCE_STATES = [
  "preparing",
  "split_requested",
  "creating",
  "launching",
  "running",
  "taken_over",
  "unknown",
  "foreign",
  "closed",
  "released",
  "proven_absent",
] as const;
export type ResourceState = (typeof RESOURCE_STATES)[number];

export const LIVE_RESOURCE_STATES = new Set<ResourceState>([
  "preparing",
  "split_requested",
  "creating",
  "launching",
  "running",
  "taken_over",
  "unknown",
  "foreign",
]);

export const OUTCOME_TYPES = ["done", "ping", "error"] as const;
export type OutcomeType = (typeof OUTCOME_TYPES)[number];

export const DELIVERY_STATES = ["pending", "attempted"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PANE_RE = /^%\d+$/;
const WINDOW_RE = /^@\d+$/;

export interface ModelIdentity {
  provider: string;
  model: string;
  thinking: string;
}

export interface AttemptRecord {
  attemptId: string;
  parentSessionId: string;
  piSessionId: string | null;
  invocation: number;
  completionToken: string;
  tmuxSocket: string;
  windowId: string;
  surface: string | null;
  sessionFile: string;
  launchScriptFile: string;
  completionFile: string;
  paneStartCommand: string;
  requested: ModelIdentity;
  observed: ModelIdentity | null;
  resourceState: ResourceState;
  outcome: OutcomeType | null;
  outcomeBytes: string | null;
  outcomeDigest: string | null;
  deliveryState: DeliveryState | null;
  createdAt: number;
  name: string;
  task: string;
  agent?: string;
  title?: string;
  repository?: string;
  interactive?: boolean;
  /** Diagnostic recorded when a non-cancellation watcher failure forces resourceState back to `unknown`. */
  watcherDiagnostic?: string;
  [extra: string]: unknown;
}

export interface WorkerRegistry {
  version: typeof REGISTRY_VERSION;
  invocations: number;
  workers: AttemptRecord[];
  [extra: string]: unknown;
}

export class RegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryValidationError";
  }
}

const RUNTIME_KEYS = new Set([
  "abortController",
  "statusState",
  "activity",
  "activityRead",
  "activityFile",
  "cli",
  "sentinelFile",
  "startTime",
  "id",
  "surfaceRuntime",
]);

function fsNow(): LifecycleFs {
  return getLifecycleAdapter().fs;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isNonEmptyString(value: unknown, max = 1024): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
}

function isAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !value.includes("\0")
  );
}

function isModelIdentity(value: unknown): value is ModelIdentity {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return isNonEmptyString(v.provider, 256) && isNonEmptyString(v.model, 256) && isNonEmptyString(v.thinking, 64);
}

function validateAttemptRecord(worker: unknown, index: number): AttemptRecord {
  if (!worker || typeof worker !== "object") {
    throw new RegistryValidationError(`workers[${index}] is not an object`);
  }
  const w = worker as Record<string, unknown>;
  const fail = (field: string) => {
    throw new RegistryValidationError(`workers[${index}].${field} is invalid`);
  };
  if (!isUuid(w.attemptId)) fail("attemptId");
  if (!isUuid(w.parentSessionId)) fail("parentSessionId");
  if (w.piSessionId !== null && !isUuid(w.piSessionId)) fail("piSessionId");
  if (!Number.isInteger(w.invocation) || (w.invocation as number) < 1 || (w.invocation as number) > HARD_INVOCATION_CEILING) {
    fail("invocation");
  }
  if (!isUuid(w.completionToken)) fail("completionToken");
  if (!isAbsolutePath(w.tmuxSocket)) fail("tmuxSocket");
  if (typeof w.windowId !== "string" || !WINDOW_RE.test(w.windowId)) fail("windowId");
  if (w.surface !== null && (typeof w.surface !== "string" || !PANE_RE.test(w.surface))) fail("surface");
  if (!isAbsolutePath(w.sessionFile)) fail("sessionFile");
  if (!isAbsolutePath(w.launchScriptFile)) fail("launchScriptFile");
  if (!isAbsolutePath(w.completionFile)) fail("completionFile");
  if (!isNonEmptyString(w.paneStartCommand, MAX_PATH_LENGTH)) fail("paneStartCommand");
  if (!isModelIdentity(w.requested)) fail("requested");
  if (w.observed !== null && !isModelIdentity(w.observed)) fail("observed");
  if (typeof w.resourceState !== "string" || !RESOURCE_STATES.includes(w.resourceState as ResourceState)) {
    fail("resourceState");
  }
  if (w.outcome !== null && (typeof w.outcome !== "string" || !OUTCOME_TYPES.includes(w.outcome as OutcomeType))) {
    fail("outcome");
  }
  if (w.outcomeBytes !== null && typeof w.outcomeBytes !== "string") fail("outcomeBytes");
  if (w.outcomeDigest !== null && (typeof w.outcomeDigest !== "string" || !/^[0-9a-f]{64}$/.test(w.outcomeDigest))) {
    fail("outcomeDigest");
  }
  if (w.deliveryState !== null && (typeof w.deliveryState !== "string" || !DELIVERY_STATES.includes(w.deliveryState as DeliveryState))) {
    fail("deliveryState");
  }
  // Outcome/bytes/digest/delivery are one consistent unit, never independent
  // fields: an outcome type implies authenticated bytes and a matching
  // digest; a delivery state implies an outcome exists.
  if (w.outcome !== null) {
    if (typeof w.outcomeBytes !== "string" || w.outcomeBytes.length === 0) fail("outcomeBytes");
    if (typeof w.outcomeDigest !== "string" || w.outcomeDigest !== outcomeDigest(w.attemptId as string, w.outcomeBytes as string)) {
      fail("outcomeDigest");
    }
  } else {
    if (w.outcomeBytes !== null) fail("outcomeBytes");
    if (w.outcomeDigest !== null) fail("outcomeDigest");
    if (w.deliveryState !== null) fail("deliveryState");
  }
  if (!Number.isInteger(w.createdAt) || (w.createdAt as number) < 0) fail("createdAt");
  if (!isNonEmptyString(w.name, 120)) fail("name");
  if (typeof w.task !== "string" || w.task.length > 100_000) fail("task");
  return worker as AttemptRecord;
}

export function validateRegistry(data: unknown): WorkerRegistry {
  if (!data || typeof data !== "object") throw new RegistryValidationError("Registry is not an object");
  const raw = data as Record<string, unknown>;
  if (raw.version !== REGISTRY_VERSION) throw new RegistryValidationError(`Unsupported registry version: ${String(raw.version)}`);
  if (!Number.isInteger(raw.invocations) || (raw.invocations as number) < 0 || (raw.invocations as number) > HARD_INVOCATION_CEILING) {
    throw new RegistryValidationError(`invocations must be an integer 0..${HARD_INVOCATION_CEILING}`);
  }
  if (raw.invocationLimit !== undefined && raw.invocationLimit !== null &&
      (!Number.isInteger(raw.invocationLimit) || (raw.invocationLimit as number) < 1 || (raw.invocationLimit as number) > HARD_INVOCATION_CEILING)) {
    throw new RegistryValidationError("invocationLimit must be null (no limit) or a positive integer");
  }
  if (!Array.isArray(raw.workers)) throw new RegistryValidationError("workers must be an array");
  const workers = raw.workers.map((worker, index) => validateAttemptRecord(worker, index));
  const attemptIds = new Set<string>();
  const tokens = new Set<string>();
  // Pane uniqueness is keyed by (tmuxSocket, surface), NOT surface alone: the
  // same pane number (e.g. `%1`) legitimately exists on two different tmux
  // sockets simultaneously and must not collide.
  const surfaces = new Set<string>();
  for (const worker of workers) {
    if (attemptIds.has(worker.attemptId)) throw new RegistryValidationError(`duplicate attemptId ${worker.attemptId}`);
    attemptIds.add(worker.attemptId);
    if (tokens.has(worker.completionToken)) throw new RegistryValidationError(`duplicate completionToken`);
    tokens.add(worker.completionToken);
    if (worker.surface) {
      const key = `${worker.tmuxSocket}::${worker.surface}`;
      if (surfaces.has(key)) throw new RegistryValidationError(`duplicate surface ${worker.surface} on socket ${worker.tmuxSocket}`);
      surfaces.add(key);
    }
  }
  if (countLiveResources(workers) > MAX_LIVE_RESOURCES) {
    throw new RegistryValidationError(`live resource count exceeds ${MAX_LIVE_RESOURCES}`);
  }
  return data as WorkerRegistry;
}

export function countLiveResources(workers: AttemptRecord[]): number {
  return workers.filter((worker) => LIVE_RESOURCE_STATES.has(worker.resourceState)).length;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function outcomeDigest(attemptId: string, outcomeBytes: string): string {
  return sha256(attemptId + outcomeBytes);
}

export type RegistryLoad =
  | { status: "missing"; registry: WorkerRegistry }
  | { status: "ok"; registry: WorkerRegistry; raw: Buffer }
  | { status: "invalid"; error: string; raw: Buffer };

export function loadRegistry(path: string, file = fsNow()): RegistryLoad {
  let raw: Buffer;
  try {
    raw = file.readFileSync(path) as Buffer;
    if (!Buffer.isBuffer(raw)) raw = Buffer.from(String(raw));
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return { status: "missing", registry: { version: 1, invocations: 0, workers: [] } };
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    const registry = validateRegistry(parsed);
    return { status: "ok", registry, raw };
  } catch (error: any) {
    const message = error instanceof RegistryValidationError ? error.message : error?.message ?? String(error);
    return { status: "invalid", error: message, raw };
  }
}

/** @deprecated Tests and callers should prefer loadRegistry; this throws on corruption. */
export function readRegistry(path: string): WorkerRegistry {
  const loaded = loadRegistry(path);
  if (loaded.status === "invalid") throw new RegistryValidationError(loaded.error);
  return loaded.registry;
}

function persistableWorker(worker: AttemptRecord): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(worker)) {
    if (RUNTIME_KEYS.has(key)) continue;
    record[key] = value;
  }
  return record;
}

export function writeRegistry(path: string, invocations: number, workers: AttemptRecord[], extra: Record<string, unknown> = {}, file = fsNow()): void {
  if (!Number.isInteger(invocations) || invocations < 0 || invocations > HARD_INVOCATION_CEILING) {
    throw new RegistryValidationError(`invocations must be an integer 0..${HARD_INVOCATION_CEILING}`);
  }
  const records = workers.map(persistableWorker);
  const payload: WorkerRegistry = {
    ...extra,
    version: 1,
    invocations,
    workers: records as AttemptRecord[],
  };
  validateRegistry(payload);
  file.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID() + ".tmp";
  file.writeFileSync(temp, JSON.stringify(payload), { mode: 0o600, flag: "wx" });
  file.renameSync(temp, path);
}

export function writeRegistryDocument(path: string, registry: WorkerRegistry, file = fsNow()): void {
  const extra = { ...registry };
  delete extra.version;
  delete extra.invocations;
  delete extra.workers;
  writeRegistry(path, registry.invocations, registry.workers, extra, file);
}

// ---------------------------------------------------------------------------
// Registry v2 (review gates). v1 validators cannot read v2 documents: they
// throw `Unsupported registry version: 2`. Migration is one-way; `.v1.bak` is
// written once so the pre-migration bytes remain recoverable. The file body
// carries only `revision` — never `lastWriteDigest` (A9). Authority is the
// in-memory `expectedFileSha256` of the running coordinator.
// ---------------------------------------------------------------------------

const QUEUE_CLASSES: readonly QueueClass[] = ["author", "repair", "seat"];
const INTENT_STATUSES = ["queued", "reserved", "pane-created", "attached", "abandoned"] as const;
const GATING_VALUES: readonly Gating[] = ["on", "shadow", "off", "legacy"];

function isProcIdentity(value: unknown): value is { pid: number; startSec: number; startUsec: number } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    Number.isInteger(v.pid) &&
    (v.pid as number) > 0 &&
    Number.isInteger(v.startSec) &&
    (v.startSec as number) >= 0 &&
    Number.isInteger(v.startUsec) &&
    (v.startUsec as number) >= 0 &&
    (v.startUsec as number) < 1_000_000
  );
}

function validateAttemptRecordV2(worker: unknown, index: number): Record<string, unknown> & AttemptRecordV2Fields {
  const base = validateAttemptRecord(worker, index) as Record<string, unknown> & AttemptRecordV2Fields;
  const w = worker as Record<string, unknown>;
  const fail = (field: string) => {
    throw new RegistryValidationError(`workers[${index}].${field} is invalid`);
  };
  if (w.panePid !== undefined && !isProcIdentity(w.panePid)) fail("panePid");
  if (w.workerProc !== undefined) {
    if (!isProcIdentity(w.workerProc)) fail("workerProc");
    const wp = w.workerProc as Record<string, unknown>;
    if (typeof wp.registeredAt !== "string" || wp.registeredAt.length === 0) fail("workerProc.registeredAt");
  }
  return base;
}

function migrateLegacyIntents(raw: unknown): LaunchIntent[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return [];
  const out: LaunchIntent[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" && rec.id ? rec.id : `legacy-${i}`;
    const assignmentRaw = rec.assignment && typeof rec.assignment === "object" ? (rec.assignment as Record<string, unknown>) : {};
    const queueClass = QUEUE_CLASSES.includes(assignmentRaw.queueClass as QueueClass)
      ? (assignmentRaw.queueClass as QueueClass)
      : undefined;
    const statusOk = INTENT_STATUSES.includes(rec.status as (typeof INTENT_STATUSES)[number]);
    if (!queueClass || !statusOk) {
      out.push({
        id,
        status: "abandoned",
        assignment: { queueClass: queueClass ?? "author" },
        attemptId: typeof rec.attemptId === "string" ? rec.attemptId : undefined,
      });
      continue;
    }
    out.push({
      id,
      status: rec.status as LaunchIntent["status"],
      assignment: { queueClass, artifactKey: typeof assignmentRaw.artifactKey === "string" ? assignmentRaw.artifactKey : undefined },
      attemptId: typeof rec.attemptId === "string" ? rec.attemptId : undefined,
    });
  }
  return out;
}

const REQUEST_STATUSES: readonly RequestStatus[] = ["open", "plan-approved", "cleared", "closed", "unreviewed", "abandoned"];
const ARTIFACT_KINDS: readonly ArtifactKind[] = ["plan", "research", "code", "escalation"];
const ARTIFACT_STATES: readonly ArtifactState[] = [
  "DRAFT",
  "QUEUED",
  "REVIEWING",
  "REVISE",
  "BLOCKED",
  "APPROVED",
  "WAIVED",
  "NOT_REQUIRED",
  "UNREVIEWED",
];
const CONTRIBUTORS: readonly Contributor[] = ["anthropic", "openai", "xai", "moonshot", "zai", "unknown", "external"];

function isContributorList(value: unknown): value is Contributor[] {
  return Array.isArray(value) && value.every((v) => CONTRIBUTORS.includes(v as Contributor));
}

function isSnapshotRecord(value: unknown): value is SnapshotRecord {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.contentId === "string" &&
    typeof s.bindingId === "string" &&
    (s.baseCommit === null || typeof s.baseCommit === "string") &&
    isContributorList(s.contributors) &&
    Number.isInteger(s.epoch) &&
    typeof s.persisted === "boolean"
  );
}

const HOLDS = ["recovery", "policy", "repair", "tamper", "budget"] as const;
const QUORUM_OUTCOMES = ["APPROVED", "REVISE", "BLOCKED", "CANCELLED"] as const;
const CANCEL_REASONS = [
  "invalidated-by-edit",
  "invalidated-by-base",
  "invalidated-by-contributors",
  "cancelled-by-user",
  "waived",
  "recovery",
] as const;
const VERIFY_RESULTS = ["PASS", "FAIL", "ERROR", "INVALID", "NO_COMMANDS", "ACCEPTED_NO_COMMANDS", "VERIFY_FAILED"] as const;
const SEAT_STATUSES = ["pending", "launched", "authenticated", "failed", "verdict"] as const;
const CLOSE_REASONS = ["recovery", "tool-return"] as const;
const FAMILIES = ["anthropic", "openai", "xai", "moonshot", "zai", "unknown"] as const;

function isShellAuthority(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  if (typeof a.id !== "string" || !a.id) return false;
  if (a.owner === "coordinator") {
    /* ok */
  } else if (!a.owner || typeof a.owner !== "object" || typeof (a.owner as { attemptId?: unknown }).attemptId !== "string") {
    return false;
  }
  if (!isContributorList(a.families)) return false;
  if (typeof a.root !== "string") return false;
  if (!Array.isArray(a.writeRoots) || a.writeRoots.some((x) => typeof x !== "string")) return false;
  if (typeof a.openedAt !== "string") return false;
  if (a.closedAt !== undefined && typeof a.closedAt !== "string") return false;
  if (a.closeReason !== undefined && !CLOSE_REASONS.includes(a.closeReason as (typeof CLOSE_REASONS)[number])) return false;
  return true;
}

function isVerificationRecord(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.contentId === "string" &&
    (v.baseCommit === null || typeof v.baseCommit === "string") &&
    VERIFY_RESULTS.includes(v.result as (typeof VERIFY_RESULTS)[number]) &&
    typeof v.at === "string"
  );
}

function isQuorumRecord(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const q = value as Record<string, unknown>;
  if (!Number.isInteger(q.round) || (q.round as number) < 0) return false;
  if (typeof q.bindingId !== "string") return false;
  if (!Array.isArray(q.seats)) return false;
  for (const seat of q.seats) {
    if (!seat || typeof seat !== "object") return false;
    const s = seat as Record<string, unknown>;
    if (typeof s.id !== "string") return false;
    if (typeof s.model !== "string") return false;
    if (!FAMILIES.includes(s.family as (typeof FAMILIES)[number])) return false;
    if (!SEAT_STATUSES.includes(s.status as (typeof SEAT_STATUSES)[number])) return false;
  }
  if (q.outcome !== undefined && !QUORUM_OUTCOMES.includes(q.outcome as (typeof QUORUM_OUTCOMES)[number])) return false;
  if (q.refunded !== undefined && typeof q.refunded !== "boolean") return false;
  if (q.cancelReason !== undefined && !CANCEL_REASONS.includes(q.cancelReason as (typeof CANCEL_REASONS)[number])) return false;
  return true;
}

function tryRequestRecord(value: unknown): RequestRecord | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || r.id.includes("\0")) return null;
  if (!REQUEST_STATUSES.includes(r.status as RequestStatus)) return null;
  if (!Array.isArray(r.artifactKeys) || r.artifactKeys.some((k) => typeof k !== "string")) return null;
  if (!isContributorList(r.coordinatorShellTaint)) return null;
  if (!Array.isArray(r.shellAuthorities) || !r.shellAuthorities.every(isShellAuthority)) return null;
  if (!Array.isArray(r.sourceRoots) || r.sourceRoots.some((k) => typeof k !== "string")) return null;
  const agg = r.triggerAggregate;
  if (!agg || typeof agg !== "object") return null;
  const a = agg as Record<string, unknown>;
  if (typeof a.lines !== "number" || !Number.isFinite(a.lines)) return null;
  return r as unknown as RequestRecord;
}

function tryArtifactRecord(value: unknown): ArtifactRecord | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.key !== "string" || !r.key) return null;
  if (!ARTIFACT_KINDS.includes(r.kind as ArtifactKind)) return null;
  if (typeof r.requestId !== "string" || !r.requestId) return null;
  if (!ARTIFACT_STATES.includes(r.state as ArtifactState)) return null;
  if (!isSnapshotRecord(r.current)) return null;
  if (r.minQuorum !== 1 && r.minQuorum !== 2) return null;
  if (!Array.isArray(r.egressRoots) || r.egressRoots.some((k) => typeof k !== "string")) return null;
  if (typeof r.required !== "boolean") return null;
  if (!Number.isInteger(r.round) || (r.round as number) < 0) return null;
  if (!Number.isInteger(r.roundBudget) || (r.roundBudget as number) < 0) return null;
  if (!Array.isArray(r.authorClasses) || r.authorClasses.some((k) => typeof k !== "string")) return null;
  if (!Array.isArray(r.certifiedPaths) || r.certifiedPaths.some((k) => typeof k !== "string")) return null;
  if (typeof r.persisted !== "boolean") return null;
  if (r.hold !== undefined && !HOLDS.includes(r.hold as (typeof HOLDS)[number])) return null;
  if (r.quorum !== undefined && !isQuorumRecord(r.quorum)) return null;
  if (r.verifications !== undefined) {
    if (!Array.isArray(r.verifications) || !r.verifications.every(isVerificationRecord)) return null;
  }
  return r as unknown as ArtifactRecord;
}

function sanitizeRequests(raw: unknown): RequestRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: RequestRecord[] = [];
  for (const item of raw) {
    const parsed = tryRequestRecord(item);
    if (!parsed) continue;
    out.push({
      ...parsed,
      triggerAggregate: emptyTriggerAggregate(),
      shellAuthorities: Array.isArray(parsed.shellAuthorities) ? parsed.shellAuthorities : [],
      coordinatorShellTaint: isContributorList(parsed.coordinatorShellTaint) ? parsed.coordinatorShellTaint : [],
    });
  }
  return out;
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeKey(key: string): boolean {
  return typeof key === "string" && key.length > 0 && !key.includes("\0") && !DANGEROUS_KEYS.has(key);
}

function sanitizeArtifacts(raw: unknown): Record<string, ArtifactRecord> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, ArtifactRecord> = Object.create(null);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSafeKey(key)) continue;
    const parsed = tryArtifactRecord(value);
    if (!parsed) continue;
    const dest = parsed.key || key;
    if (!isSafeKey(dest)) continue;
    out[dest] = parsed;
  }
  return out;
}

function validateReviewState(raw: unknown): ReviewState {
  if (!raw || typeof raw !== "object") throw new RegistryValidationError("review is not an object");
  const r = raw as Record<string, unknown>;
  if (!GATING_VALUES.includes(r.gating as Gating)) throw new RegistryValidationError("review.gating is invalid");
  if (r.sessionHold !== undefined && r.sessionHold !== "tamper") throw new RegistryValidationError("review.sessionHold is invalid");
  if (!Array.isArray(r.requests)) throw new RegistryValidationError("review.requests must be an array");
  if (!r.artifacts || typeof r.artifacts !== "object" || Array.isArray(r.artifacts)) {
    throw new RegistryValidationError("review.artifacts must be an object");
  }
  for (let i = 0; i < (r.requests as unknown[]).length; i++) {
    if (!tryRequestRecord((r.requests as unknown[])[i])) {
      throw new RegistryValidationError(`review.requests[${i}] is invalid`);
    }
  }
  for (const [key, value] of Object.entries(r.artifacts as Record<string, unknown>)) {
    if (!isSafeKey(key)) throw new RegistryValidationError(`review.artifacts[${key}] is invalid`);
    if (!tryArtifactRecord(value)) throw new RegistryValidationError(`review.artifacts[${key}] is invalid`);
  }
  if (!Array.isArray(r.intents)) throw new RegistryValidationError("review.intents must be an array");
  if (!Number.isInteger(r.roundBudget) || (r.roundBudget as number) < 0) {
    throw new RegistryValidationError("review.roundBudget is invalid");
  }
  if (!r.sandbox || typeof r.sandbox !== "object") throw new RegistryValidationError("review.sandbox is invalid");
  const sandbox = r.sandbox as Record<string, unknown>;
  if (typeof sandbox.available !== "boolean" || typeof sandbox.addonLoaded !== "boolean") {
    throw new RegistryValidationError("review.sandbox is invalid");
  }
  if (!r.receiptSock || typeof r.receiptSock !== "object") throw new RegistryValidationError("review.receiptSock is invalid");
  if (typeof r.verifyBase !== "string") throw new RegistryValidationError("review.verifyBase is invalid");
  if (!Array.isArray(r.protectedSet) || r.protectedSet.some((p) => typeof p !== "string")) {
    throw new RegistryValidationError("review.protectedSet is invalid");
  }
  if (typeof r.launchArgvDigest !== "string") throw new RegistryValidationError("review.launchArgvDigest is invalid");
  if (!Array.isArray(r.coordinatorEvents)) throw new RegistryValidationError("review.coordinatorEvents is invalid");
  if (!r.profileCopies || typeof r.profileCopies !== "object" || Array.isArray(r.profileCopies)) {
    throw new RegistryValidationError("review.profileCopies is invalid");
  }
  return raw as ReviewState;
}

export function validateRegistryV2(data: unknown): WorkerRegistryV2 {
  if (!data || typeof data !== "object") throw new RegistryValidationError("Registry is not an object");
  const raw = data as Record<string, unknown>;
  if (raw.version !== REGISTRY_VERSION_V2) {
    throw new RegistryValidationError(`Unsupported registry version: ${String(raw.version)}`);
  }
  if (!Number.isInteger(raw.revision) || (raw.revision as number) < 0) {
    throw new RegistryValidationError("revision must be a non-negative integer");
  }
  if (!Number.isInteger(raw.invocations) || (raw.invocations as number) < 0 || (raw.invocations as number) > HARD_INVOCATION_CEILING) {
    throw new RegistryValidationError(`invocations must be an integer 0..${HARD_INVOCATION_CEILING}`);
  }
  if (
    raw.invocationLimit !== undefined &&
    raw.invocationLimit !== null &&
    (!Number.isInteger(raw.invocationLimit) || (raw.invocationLimit as number) < 1 || (raw.invocationLimit as number) > HARD_INVOCATION_CEILING)
  ) {
    throw new RegistryValidationError("invocationLimit must be null (no limit) or a positive integer");
  }
  if (!Array.isArray(raw.workers)) throw new RegistryValidationError("workers must be an array");
  const workers = raw.workers.map((worker, index) => validateAttemptRecordV2(worker, index));
  const attemptIds = new Set<string>();
  const tokens = new Set<string>();
  const surfaces = new Set<string>();
  for (const worker of workers) {
    const w = worker as unknown as AttemptRecord;
    if (attemptIds.has(w.attemptId)) throw new RegistryValidationError(`duplicate attemptId ${w.attemptId}`);
    attemptIds.add(w.attemptId);
    if (tokens.has(w.completionToken)) throw new RegistryValidationError(`duplicate completionToken`);
    tokens.add(w.completionToken);
    if (w.surface) {
      const key = `${w.tmuxSocket}::${w.surface}`;
      if (surfaces.has(key)) throw new RegistryValidationError(`duplicate surface ${w.surface} on socket ${w.tmuxSocket}`);
      surfaces.add(key);
    }
  }
  if (countLiveResources(workers as unknown as AttemptRecord[]) > MAX_LIVE_RESOURCES) {
    throw new RegistryValidationError(`live resource count exceeds ${MAX_LIVE_RESOURCES}`);
  }
  const review = validateReviewState(raw.review);
  return data as WorkerRegistryV2;
}

export function freshRegistryV2(opts?: { gating?: Gating }): WorkerRegistryV2 {
  return {
    version: 2,
    revision: 0,
    invocations: 0,
    workers: [],
    review: emptyReviewState({ gating: opts?.gating ?? DEFAULT_GATING }),
  };
}

export function migrateV1toV2(v1: WorkerRegistry, opts?: { gating?: Gating }): WorkerRegistryV2 {
  const extra = v1 as WorkerRegistry & { review?: unknown; revision?: unknown };
  const priorReview = extra.review && typeof extra.review === "object" ? (extra.review as Record<string, unknown>) : {};
  const intents = migrateLegacyIntents(priorReview.intents);
  // Never honour gating (or other security-relevant fields) from the untrusted v1 body.
  const gating = opts?.gating ?? DEFAULT_GATING;
  const review: ReviewState = {
    ...emptyReviewState({ gating }),
    intents,
    // §3.2 / A9: carry legacy intents only. Never adopt requests/artifacts
    // (APPROVED/WAIVED/cleared/certifiedPaths/verifications) from the v1 body.
    requests: [],
    artifacts: {},
    coordinatorEvents: [],
    profileCopies: {},
    sandbox: emptySandboxState(),
    receiptSock: { dir: "", path: "", createdAt: "" },
    verifyBase: "",
    protectedSet: [],
    launchArgvDigest: "",
  };
  const migrated: WorkerRegistryV2 = {
    version: 2,
    revision: 0,
    invocations: v1.invocations,
    invocationLimit: v1.invocationLimit as number | null | undefined,
    workers: v1.workers as WorkerRegistryV2["workers"],
    review,
  };
  return validateRegistryV2(migrated);
}

export type ReviewRegistryLoad =
  | { status: "missing"; registry: WorkerRegistryV2 }
  | { status: "ok"; registry: WorkerRegistryV2; raw: Buffer }
  | { status: "migrated"; registry: WorkerRegistryV2; raw: Buffer; bakPath: string }
  | { status: "invalid"; error: string; raw: Buffer }
  | { status: "tamper"; expected: string; found: string; raw: Buffer };

function writeAtomic(path: string, bytes: string | Buffer, file: LifecycleFs): void {
  file.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID() + ".tmp";
  file.writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
  file.renameSync(temp, path);
}

function hashBytes(raw: Buffer | string): string {
  return sha256(raw);
}

/**
 * In-memory file-digest authority (A9 / §3.4). Re-reads and hashes on-disk bytes
 * before every write; mismatch → no write, tamper hold, audit caller-side.
 */
export class ReviewRegistryStore {
  expectedFileSha256: string | null = null;
  sessionHold: "tamper" | null = null;
  lastAudit: { kind: string; revision?: number; expected?: string; found?: string } | null = null;
  readonly path: string;
  private readonly file: LifecycleFs;

  constructor(path: string, file: LifecycleFs = fsNow()) {
    this.path = path;
    this.file = file;
  }

  load(): ReviewRegistryLoad {
    let raw: Buffer;
    try {
      raw = this.file.readFileSync(this.path) as Buffer;
      if (!Buffer.isBuffer(raw)) raw = Buffer.from(String(raw));
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        this.expectedFileSha256 = null;
        return { status: "missing", registry: freshRegistryV2() };
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw.toString("utf8"));
      if (parsed && parsed.version === 1) {
        const v1 = validateRegistry(parsed);
        const v2 = migrateV1toV2(v1);
        const bakPath = this.path + ".v1.bak";
        if (!this.file.existsSync(bakPath)) {
          this.file.copyFileSync(this.path, bakPath);
        }
        const bytes = JSON.stringify(v2);
        writeAtomic(this.path, bytes, this.file);
        this.expectedFileSha256 = hashBytes(bytes);
        return { status: "migrated", registry: v2, raw, bakPath };
      }
      const registry = validateRegistryV2(parsed);
      this.expectedFileSha256 = hashBytes(raw);
      return { status: "ok", registry, raw };
    } catch (error: any) {
      const message = error instanceof RegistryValidationError ? error.message : error?.message ?? String(error);
      return { status: "invalid", error: message, raw };
    }
  }

  /** Compare on-disk bytes to the last written/read digest. */
  checkTamper(): { ok: true } | { ok: false; expected: string; found: string } {
    if (this.expectedFileSha256 === null) {
      if (!this.file.existsSync(this.path)) return { ok: true };
      const found = hashBytes(this.file.readFileSync(this.path) as Buffer);
      this.sessionHold = "tamper";
      return { ok: false, expected: "", found };
    }
    try {
      const raw = this.file.readFileSync(this.path) as Buffer;
      const found = hashBytes(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)));
      if (found !== this.expectedFileSha256) {
        this.sessionHold = "tamper";
        this.lastAudit = { kind: "registry-tamper", expected: this.expectedFileSha256, found };
        return { ok: false, expected: this.expectedFileSha256, found };
      }
      return { ok: true };
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        this.sessionHold = "tamper";
        return { ok: false, expected: this.expectedFileSha256, found: "" };
      }
      throw error;
    }
  }

  write(registry: WorkerRegistryV2): { ok: true; registry: WorkerRegistryV2; digest: string } | { ok: false; tamper: true; expected: string; found: string } {
    if (this.sessionHold === "tamper") {
      this.lastAudit = {
        kind: "registry-tamper",
        revision: registry.revision,
        expected: this.expectedFileSha256 ?? "",
        found: "hold",
      };
      return { ok: false, tamper: true, expected: this.expectedFileSha256 ?? "", found: "hold" };
    }
    const tamper = this.checkTamper();
    if (!tamper.ok) {
      this.lastAudit = {
        kind: "registry-tamper",
        revision: registry.revision,
        expected: tamper.expected,
        found: tamper.found,
      };
      return { ok: false, tamper: true, expected: tamper.expected, found: tamper.found };
    }
    const next: WorkerRegistryV2 = { ...registry, version: 2, revision: registry.revision + 1 };
    const validated = validateRegistryV2(next);
    const bytes = JSON.stringify(validated);
    writeAtomic(this.path, bytes, this.file);
    this.expectedFileSha256 = hashBytes(bytes);
    return { ok: true, registry: validated, digest: this.expectedFileSha256 };
  }

  /** P13 Overwrite: adopt current on-disk bytes as expected, clear tamper hold. */
  overwriteHold(): void {
    if (this.file.existsSync(this.path)) {
      const raw = this.file.readFileSync(this.path) as Buffer;
      this.expectedFileSha256 = hashBytes(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)));
    } else {
      this.expectedFileSha256 = null;
    }
    this.sessionHold = null;
  }
}

