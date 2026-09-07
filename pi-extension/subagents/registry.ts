import { dirname } from "node:path";
import { isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { getLifecycleAdapter, type LifecycleFs } from "./adapter.ts";

export const REGISTRY_VERSION = 1;
export const MAX_LIVE_RESOURCES = 4;
export const MAX_CHILD_INVOCATIONS = 12;
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
  if (!Number.isInteger(w.invocation) || (w.invocation as number) < 1 || (w.invocation as number) > MAX_CHILD_INVOCATIONS) {
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
  if (!Number.isInteger(raw.invocations) || (raw.invocations as number) < 0 || (raw.invocations as number) > MAX_CHILD_INVOCATIONS) {
    throw new RegistryValidationError(`invocations must be an integer 0..${MAX_CHILD_INVOCATIONS}`);
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
  if (!Number.isInteger(invocations) || invocations < 0 || invocations > MAX_CHILD_INVOCATIONS) {
    throw new RegistryValidationError(`invocations must be an integer 0..${MAX_CHILD_INVOCATIONS}`);
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
