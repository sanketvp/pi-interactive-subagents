/**
 * Shared types for adversarial review gates (plan v1.3 §3.1).
 *
 * Registry v2 is unreadable by v1 validators: a v1 `validateRegistry` requires
 * `version === 1` and throws `Unsupported registry version: 2`. Migration is
 * one-way; a `.v1.bak` sidecar is written once so pre-migration bytes remain
 * recoverable. Do not put `lastWriteDigest` in the file body (A9) — the
 * in-memory `expectedFileSha256` is authoritative.
 */

export type Family = "anthropic" | "openai" | "xai" | "moonshot" | "zai" | "unknown";
export type Contributor = Family | "external";

export type ArtifactKind = "plan" | "research" | "code" | "escalation";
export type ArtifactState =
  | "DRAFT"
  | "QUEUED"
  | "REVIEWING"
  | "REVISE"
  | "BLOCKED"
  | "APPROVED"
  | "WAIVED"
  | "NOT_REQUIRED"
  | "UNREVIEWED";

export type Gating = "on" | "shadow" | "off" | "legacy";
export type QueueClass = "author" | "repair" | "seat";
export type ChangeKind = "none" | "content" | "base" | "provenance";
export type Role = "planner" | "researcher" | "author" | "reviewer" | "verifier";
export type Hold = "recovery" | "policy" | "repair" | "tamper" | "budget";
export type RequestStatus = "open" | "plan-approved" | "cleared" | "closed" | "unreviewed" | "abandoned";
export type IntentStatus = "queued" | "reserved" | "pane-created" | "attached" | "abandoned";
export type QuorumOutcome = "APPROVED" | "REVISE" | "BLOCKED" | "CANCELLED";
export type CancelReason =
  | "invalidated-by-edit"
  | "invalidated-by-base"
  | "invalidated-by-contributors"
  | "cancelled-by-user"
  | "waived"
  | "recovery";
export type VerdictKind = "APPROVED" | "REVISE" | "BLOCKED";
export type SyntheticVerdict =
  | "no-receipt"
  | "timeout"
  | "malformed"
  | "identity-mismatch"
  | "packet-tampered"
  | "receipt-rejected"
  | "snapshot-mismatch";

export interface ProcIdentity {
  pid: number;
  startSec: number;
  startUsec: number;
}

export interface CoordinatorEvent {
  at: string;
  model: string;
  family: Contributor;
}

export interface ProfileCopy {
  digest: string;
  path: string;
}

export interface SandboxState {
  available: boolean;
  checkedAt: string;
  profileVersion: number;
  addonLoaded: boolean;
  selfTest: Record<string, { control: "ok" | "setup-failed" | "untested"; sandboxed: "blocked" | "leaked" | "untested" }>;
  positive: Record<string, "ok" | "failed" | "untested">;
}

export interface ReceiptSockState {
  dir: string;
  path: string;
  createdAt: string;
}

export interface ShellAuthority {
  id: string;
  owner: "coordinator" | { attemptId: string };
  families: Contributor[];
  root: string;
  writeRoots: string[];
  openedAt: string;
  /** ISO-8601 (or any ordered timestamp). Never the reason string. */
  closedAt?: string;
  closeReason?: "recovery" | "tool-return";
}

export interface TriggerAggregate {
  lines: number;
  perRoot: Record<string, number>;
  threshold: number;
  computedAt: string;
}

export interface SnapshotRecord {
  contentId: string;
  bindingId: string;
  baseCommit: string | null;
  contributors: Contributor[];
  epoch: number;
  persisted: boolean;
}

export interface FindingRecord {
  severity: string;
  file?: string;
  line?: number;
  evidence?: string;
  why?: string;
  minimalFix?: string;
  regressionCheck?: string;
}

export interface VerdictRecord {
  seatId: string;
  verdict: VerdictKind;
  snapshotId: string;
  findings: FindingRecord[];
  residualRisks?: string;
  synthetic?: SyntheticVerdict;
}

export interface SeatRecord {
  id: string;
  attemptId?: string;
  model: string;
  family: Family;
  status: "pending" | "launched" | "authenticated" | "failed" | "verdict";
  verdict?: VerdictRecord;
}

export interface QuorumRecord {
  round: number;
  bindingId: string;
  seats: SeatRecord[];
  outcome?: QuorumOutcome;
  refunded?: boolean;
  cancelReason?: CancelReason;
}

export interface VerificationRecord {
  id: string;
  contentId: string;
  baseCommit: string | null;
  result: "PASS" | "FAIL" | "ERROR" | "INVALID" | "NO_COMMANDS" | "ACCEPTED_NO_COMMANDS" | "VERIFY_FAILED";
  at: string;
}

export interface ArtifactRecord {
  key: string;
  kind: ArtifactKind;
  requestId: string;
  root?: string;
  state: ArtifactState;
  current: SnapshotRecord;
  lastApproved?: SnapshotRecord;
  hold?: Hold;
  minQuorum: 1 | 2;
  egressRoots: string[];
  required: boolean;
  round: number;
  roundBudget: number;
  authorClasses: string[];
  certifiedPaths: string[];
  persisted: boolean;
  quorum?: QuorumRecord;
  verifications?: VerificationRecord[];
  pendingVerifyAction?: string;
}

export interface RequestRecord {
  id: string;
  status: RequestStatus;
  artifactKeys: string[];
  coordinatorShellTaint: Contributor[];
  shellAuthorities: ShellAuthority[];
  triggerAggregate: TriggerAggregate;
  sourceRoots: string[];
}

export interface LaunchAssignment {
  artifactKey?: string;
  role?: Role;
  model?: string;
  family?: Family;
  queueClass: QueueClass;
}

export interface LaunchIntent {
  id: string;
  status: IntentStatus;
  assignment: LaunchAssignment;
  attemptId?: string;
}

export interface ReviewState {
  gating: Gating;
  sessionHold?: "tamper";
  requests: RequestRecord[];
  artifacts: Record<string, ArtifactRecord>;
  intents: LaunchIntent[];
  roundBudget: number;
  policyDigest?: string;
  profileDigests?: Record<string, string>;
  sandbox: SandboxState;
  receiptSock: ReceiptSockState;
  verifyBase: string;
  protectedSet: string[];
  launchArgvDigest: string;
  coordinatorEvents: CoordinatorEvent[];
  profileCopies: Record<string, ProfileCopy>;
}

/**
 * v2 attempt extras on top of the v1 AttemptRecord (panePid / workerProc are
 * ★★ v1.3 fields). Other v1 fields live on the existing AttemptRecord and are
 * preserved through migration.
 */
export interface AttemptRecordV2Fields {
  panePid?: ProcIdentity;
  workerProc?: ProcIdentity & { registeredAt: string };
}

export interface WorkerRegistryV2 {
  version: 2;
  revision: number;
  invocations: number;
  invocationLimit?: number | null;
  workers: Array<Record<string, unknown> & AttemptRecordV2Fields>;
  review: ReviewState;
}

export const DEFAULT_ROUND_BUDGET = 3;

/** PR-1/PR-4 default. PR-7 is the only change that may set gating `'on'`. */
export const DEFAULT_GATING: Gating = "shadow";

export function emptySandboxState(): SandboxState {
  return {
    available: false,
    checkedAt: "",
    profileVersion: 0,
    addonLoaded: false,
    selfTest: {},
    positive: {},
  };
}

export function emptyTriggerAggregate(at = ""): TriggerAggregate {
  return { lines: 0, perRoot: {}, threshold: 0, computedAt: at };
}

export function emptyReviewState(opts?: { gating?: Gating }): ReviewState {
  return {
    gating: opts?.gating ?? DEFAULT_GATING,
    requests: [],
    artifacts: {},
    intents: [],
    roundBudget: DEFAULT_ROUND_BUDGET,
    sandbox: emptySandboxState(),
    receiptSock: { dir: "", path: "", createdAt: "" },
    verifyBase: "",
    protectedSet: [],
    launchArgvDigest: "",
    coordinatorEvents: [],
    profileCopies: {},
  };
}
