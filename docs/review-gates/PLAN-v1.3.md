Staying here: no `subagent` tool is exposed in this context, so this synthesis is done inline (disclosed per contract). Text-only; no repository inspection, no tests run.

# Implementation plan v1.3 — cross-family adversarial review gates

Basis: spec v0.3 + decisions Q7, Q8 + amendments §1. Supersedes plan v1.2 in full. Target: `pi-interactive-subagents`, extension root `pi-extension/subagents/`. Not implemented; no tests run.

**Change map (v1.3 vs v1.2).** Revised scope per Q8 = sandbox + receipt socket. Sections tagged **[v1.3 CHANGED]** or **[v1.3 NEW]** differ from v1.2; everything tagged **[unchanged]** is v1.2 text verbatim and is APPROVED for build under Q8. Three minimal cross-scope touches (Astra 9–11) are tagged **[v1.3 MINIMAL TOUCH — outside Q8 scope, must be carried into PR-4/PR-5]**: §4.3 writer rule 3, §5.1 evidence rules, §5.2 three rows.

Changed: §0 (3 rows added), §1 A5/A10/A11 + new A15/A16, §2 (11 rows), §3.1 (4 fields), §4.3 (root registration + rule 3), §5.1, §5.2 (3 rows), §6 G0/G1/G5/G8/G12, §8.3–§8.5, §12 (P2 text, `/pairing` rendering, P16), §13 (sandbox rows), §14 (sandbox tests, #15/#18/#23b/#38/#45/#46 extended, #47–#56 added, T9–T12), §15 PR-2/PR-3, §16, §17, new §20.

## 0. Decision ledger (closed — do not reopen) **[v1.3 CHANGED — 3 rows added]**

| Decision | Where applied |
|---|---|
| (v1.1 rows unchanged) | — |
| **Q7 (user, round 3): OS sandbox built** — `sandbox-exec` for `verify_exec` and coordinator `bash` under gating `on`; refusal when unavailable; receipts over unix socket with peer verification; adversarial variants that must FAIL without the sandbox; residuals stated verbatim. Own module `review/sandbox.ts` + `review/receipt-socket.ts`, own PR (PR-3) | §1 A10, §2, §8.4, §8.5, §14, §15 |
| Refinement of "REPAIR resume never refused for capacity": repair resumes are never **rejected** and are scheduled ahead of authors, but cannot consume the reserved reviewer/verifier slot (Astra r3 #14) | §10 |
| Refinement of "single round increment point": `round` +1 at `QUORUM_RESOLVED`, −1 (refund, audited) at quorum `CANCELLED`; budget enforced **before** quorum launch with `>=` (Astra r3 #4 / Fable r3 #5) | §5.2, §1 A13 |
| Blob materialisation (no checkout, no `.git`) replaces `git worktree` for verification (Astra r3 #9) | §8.3 |
| Author-worker `bash` also sandboxed (extension of Q7, required by Astra r3 #6); worker `write`/`edit` targets intercepted worker-side | §6 G8/G12, §8.4 |
| **Q8 (user, round 4): split.** Non-sandbox scope approved for build; PR-3 continues its own loop (this v1.3 → round 5) and must land before gating `on`. Pi loads project-local `.pi/` only with explicit `-a`; every worker launch passes `--no-approve`, pinned in the dispatcher; #48 | §1 A15, §2 `lifecycle.ts`, §6 G1, §14 #48, §15 PR-3 |
| **(v1.3) Deny-default sandbox profiles** with explicit allow sets; self-test with harness-owned canaries and mandatory unsandboxed controls; sandboxed shells spawned via `posix_spawn` (`SETSID`, `CLOEXEC_DEFAULT`), no controlling tty; protected-path set applied to every write-capable tool with race-resistant opening; harness-side `git` hardened and sandboxed (Fable r4 #1–#3, Astra r4 #3–#5, #7) | §1 A10/A16, §8.4, §6 G8/G12 |
| **(v1.3) `verify_exec` executes coordinator-side**: the verifier forwards `{cmd}` over the receipt socket; the coordinator spawns the sandboxed process and owns the ledger. Receipt producers = registered worker Pi processes identified by (pid, start time); socket at a short harness-owned path; verification trees outside the session directory (Fable r4 #4–#5, Astra r4 #2, #6) | §8.3, §8.5, §1 A5 |

## 1. Spec amendments for v0.4

**A1 — I4(b) enforcement is labelling, not refusal.** [unchanged] A Pi extension cannot block the coordinator's final assistant message. I4(b) is enforced by: (1) every completion/report carries a harness-derived label `UNREVIEWED` / `WAIVED` / `APPROVED` / `ABANDONED` per artifact; (2) at `agent_end`, if any request (open **or explicitly closed with uncleared artifacts**) has an uncleared artifact, the harness injects a visible `⛔` banner message into the transcript and a steer to the coordinator; (3) `subagents_list`, the footer widget and `/subagents-diagnose` show the same state. TUI answers are trusted only because every harness-spawned shell is sandboxed away from the tmux socket (A10); with the sandbox unavailable gating `on` refuses shells rather than trusting prompts. Test #18 exercises the real `agent_end` hook and the `send-keys` variant.

**A2 — Bootstrap review is manual evidence.** [unchanged] Reviews of this plan and of PR-1…PR-7 are orchestrated by hand; they are authenticated evidence, not harness enforcement and not proof the gates work. `ORCHESTRATION-CONTRACT.md` rev 2026-09-08a must say so.

**A3 — Two snapshot identities; three change kinds.** [unchanged] *Exact wording:* "An artifact snapshot has a **content id** (`tree:<hash>` for code; `sha256:<64hex>` manifest hash for plan/research) and an **approval-binding id** `bind:<sha256>` over `contentId ‖ baseCommit-or-'null' ‖ sorted contributor set since last approval ‖ contributor epoch`. A snapshot change is one of: **content** (content id differs), **base** (content same, base commit differs), **provenance** (content and base same, contributor set/epoch differs). Verdicts bind to the binding id; verification binds to content id + base. I3: any content or base change invalidates all prior verdicts and verification. A provenance change invalidates verdicts; APPROVED is restored on the new binding id only if the content and base equal the last approved ones and every approving reviewer's family is ∉ the current contributor set (re-checked). WAIVED is **never** carried across any binding change; the user must waive again. A quorum in flight when any change kind occurs is cancelled and re-resolved."

**A4 — Request lifecycle.** [unchanged] *Exact wording:* "A request has states `open → plan-approved → cleared → closed`, plus `unreviewed` and `abandoned`. It enters `plan-approved` when its plan artifact is APPROVED or WAIVED. It closes automatically only when **every** artifact under it is cleared (§5.8) and the coordinator turn ends. The user may close it explicitly (`/pairing close-request`, TUI confirm); if any artifact is uncleared the request becomes `abandoned`, its artifacts are labelled `ABANDONED` in every completion report, and they remain in `reviewPending`/banner computation until cleared or waived. `/pairing off` → `unreviewed`. At the next user prompt, if the most recent request is `plan-approved`, P11 decides join vs new. A new request's opening content id for a root is the **last cleared content id for that root in this session** when one exists, else the current tree. `/pairing waive plan` without a plan artifact creates `plan:<req>` at `sha256:` of the empty manifest, WAIVED, reason mandatory."

**A5 — Verification evidence protocol.** **[v1.3 CHANGED]** *Exact wording:* "Verification evidence = the harness-materialised raw-byte tree of the pinned content id (written from blobs, never via checkout, at a harness-owned location outside `~/.pi` and the session directory; manifest checked before any command), the **coordinator-owned** command ledger (the verifier's `verify_exec` tool only forwards `{cmd}` to the coordinator over the receipt socket; the coordinator spawns the sandboxed process, records the ledger in its own memory and persists it under the session directory), and the verifier's structured payload. Every forwarded command runs inside the OS sandbox (A10) with no network and no access to session, harness, policy or tmux state. PASS requires the canonical required-command set (§8.3 discovery), every required command present in the ledger with exit 0, payload ⊆ ledger, and post-run manifest integrity (no manifest entry modified or deleted). Empty discovery → `NO_COMMANDS` (cleared only via `ACCEPTED_NO_COMMANDS`). **Residual (verbatim in contract): test code executed under `verify_exec` can forge its own exit status; nothing else — it cannot read or write session, harness, policy or `~/.pi` state, cannot inspect other processes, cannot reach the receipt socket, the tmux socket, launch services, Apple events or any controlling tty, cannot write outside its tree, and cannot influence the ledger because the ledger is written by the coordinator process, not the verifier process.**"

**A6 — Health probe prerequisite.** [unchanged] `requireHealthProbe:false` substitutes catalog ∧ authenticated with a visible warning; default `true`.

**A7 — Waiver scope.** [unchanged] Waivers apply to one fully attributed binding id; not waivable: `unknown` contributor, unattributed delta, unsupported tree, unavailable bytes. Never satisfies verification, egress or provenance.

**A8 — Worker model identity (synchronous gate).** [unchanged] *Exact wording:* "A worker's model is fixed at launch. The worker extension enforces, in its own `before_agent_start`, that `ctx.model` equals the assigned model **before any provider request**: on mismatch it aborts the turn, emits a `model` transition receipt, and idles until the harness interrupts it; the mismatching provider receives zero requests. A reviewer or verifier seat whose observed model ever differs is failed (`identity-mismatch`); an author whose model changes adds the new family to contributors (`unknown` → unresolvable). G5 identity and egress checks apply to reviewers **and verifiers**. Resumed seats require a fresh startup receipt before packet release."

**A9 — Registry authority.** [unchanged] *Exact wording:* "The in-memory registry of the running coordinator is authoritative. The harness keeps in memory the SHA-256 of the exact file bytes it last wrote (or first read); the file body carries only `revision`. On every write and tick, the on-disk bytes are re-hashed; a mismatch is evidence of tampering or a second process: `tamper` hold on all open artifacts, audit, P13; on-disk state is never adopted."

**A10 — Same-user process boundary (Q7).** **[v1.3 CHANGED]** *Exact wording:* "Under gating `on`, every process the harness or a worker executes on the model's behalf — `verify_exec` commands, coordinator `bash`, author-worker `bash`, and every harness-side `git` invocation — runs inside a macOS `sandbox-exec` profile generated by the harness with `(deny default)` and an explicit allow set (§8.4): file reads everywhere except the protected set; `process-exec` only from system binary directories, the Node and git installations, and the profile's write set; a fixed `sysctl-read` name allowlist that excludes process enumeration and process arguments; a fixed `mach-lookup` allowlist that excludes LaunchServices, `lsd`, launchd bootstrap and every other process-launching or input-injecting broker; no `lsopen`, no `appleevent-send`, no `file-ioctl` on ttys, no signals except to self; writes confined to the profile's write set (verification tree + private tmp for `verify`; registered roots ∪ coverage roots ∪ declared cache dirs ∪ private tmp for `coordinator`/`author`; `<root>/.git` + temp index dir for `harness-git`); network denied for `verify` and `harness-git`; for `coordinator`/`author`, outbound to non-loopback IP endpoints and the system DNS resolver only, loopback and unix-domain endpoints denied unless declared in digested config. Every sandboxed process is spawned with `posix_spawn` using `POSIX_SPAWN_SETSID` (new session, no controlling tty) and `POSIX_SPAWN_CLOEXEC_DEFAULT` (no inherited descriptors beyond the three harness-owned stdio pipes), and its process group is killed when the tool call returns. The **protected set** (A16) is denied last in every profile and is enforced independently of the sandbox for every write-capable and read-capable tool (G8/G12). All paths are canonicalised (`realpath`) before profile generation; profile literals are escaped; paths containing control characters, newlines, quotes or invalid UTF-8 refuse the launch. If `sandbox-exec` is missing, the native addon fails to load, or the runtime self-test (§8.4) fails or cannot be set up, the sandbox is `unavailable`: `verify_exec` returns `ERROR{'no-sandbox'}`, coordinator/author `bash` are refused, shell-bearing profiles cannot launch, and harness-side snapshot/trigger/materialisation operations that require `git` are refused with `no-sandbox` (delegate or use non-shell tools). Receipts and `verify_exec` requests are exchanged over a unix socket owned by the harness at a short harness-owned path (§8.5); the peer is identified as a process instance (pid + process start time) and must be the **registered worker Pi process** of exactly one attempt, itself verified to descend from the tmux pane the harness created for that attempt; messages from any other process instance are rejected. Authenticity does not depend on any secret readable by same-user processes. Residuals stated verbatim: test self-forgery of exit status; read-based exfiltration of repository content by reviewers via `read`; prompt injection into seats; coordinator O1 pre-plan edits; the worker Pi process itself is not sandboxed — it is bounded by `--no-approve` (A15), harness-owned profile copies, bounded tool lists and the protected-path filter only; harness-side `git` still reads `.git/config` (dangerous keys are overridden and the sandbox blocks any resulting exec, but repo config can still make snapshot operations fail — availability only)."

**A11 — Coverage roots and request-wide triggers.** **[v1.3 CHANGED]** *Exact wording:* "Review covers registered git roots (worker cwd roots, coordinator write targets, `review-config.json.coverageRoots`, digested). A root is registered only after canonicalisation and only if it neither contains nor is contained in any protected path (A16); otherwise registration is refused and the launch/write that needed it is refused. Writes outside registered roots by sandboxed shells fail (EPERM) and are audited; writes by `write`/`edit` tools to unregistered or protected paths are refused. T1 aggregates changed lines across **all** code artifacts of a request; approval of one root removes only that root's contribution."

**A12 — Stage-minimum quorum.** [unchanged] *Exact wording:* "Quorum size is derived from artifact kind first (plan: 2 distinct families; research, code, escalation: 1). Author classes select reviewer preferences and may raise, never lower, the minimum. Every plan revision, by any author including the coordinator, requires two distinct-family approvals."

**A13 — Round budget.** [unchanged] *Exact wording:* "A round is a quorum pass that reaches an outcome (APPROVED/REVISE/BLOCKED). Cancelled passes do not consume rounds. No quorum is launched while `round >= roundBudget`; instead the user is prompted (P1) with findings shown. `Stop` blocks the artifact until the user extends or sets the budget."

**A14 — Immutable accepted profiles.** [unchanged] *Exact wording:* "Workers are launched from harness-owned copies of the last user-accepted profile bodies, never from `~/.pi/agent/agents/*.md` directly. Accepting a policy change (P10) atomically replaces the copies and their digests; rejecting leaves them untouched. A policy change that makes a NOT_REQUIRED artifact required returns it to DRAFT and schedules review."

**A15 — Worker launch pin (Q8).** **[v1.3 NEW]** *Exact wording:* "Every worker is launched with a pinned argv template owned by the dispatcher (`lifecycle.ts`): `pi --no-approve --session <path> --model <assigned> …`; the template never contains `-a` and always contains `--no-approve`; the template is digested with the policy and any deviation refuses the launch. Pi loads project-local `.pi/` (extensions, skills, settings) only with explicit `-a`; therefore no repository or verification-tree content is executed by a worker Pi process. This is verified by adversarial #48 and re-verified against the Pi source at every Pi upgrade recorded in the health file (`pi.version`); a version whose flag semantics are unverified refuses gating `on`."

**A16 — Protected path set.** **[v1.3 NEW]** *Exact wording:* "The protected set is computed once per session from canonical paths: `~/.pi` (whole tree), the session directory, the tmux socket directory, the receipt socket directory, the verification base directory (except each attempt's own tree for its own `verify` sandbox), the policy files, the Pi installation directory and the extension root, the Node executable (`process.execPath`) and its containing directory, the native addon, and the harness-owned profile copies. No write-capable tool (coordinator or worker `write`/`edit`, `bash` guards, `verify_exec`, harness `git`) may create, modify, rename, delete or link any path whose canonical form is inside the protected set, regardless of which root it appears to belong to; worker read tools may not read `~/.pi`, the session directory, the receipt socket directory or other attempts' verification trees. Target resolution is race-resistant: the tool opens the parent directory by walking components with `O_NOFOLLOW|O_DIRECTORY` from a canonical root and opens the target with `O_NOFOLLOW` relative to that directory descriptor; a symlink anywhere in the path after the root is refused (`symlink-in-path`)."

## 2. Modules **[v1.3 CHANGED — rows marked ★]**

All under `pi-extension/subagents/review/` unless marked. Dependency direction: `types ← family/roles/policy/triggers/egress/health/resolver/admission/machine/gates ← packet/artifact/worktree/contrib/store/sandbox/receipt-socket/protected ← orchestrator/recovery ← index`. `machine.ts`, `gates.ts`, `resolver.ts`, `triggers.ts`, `admission.ts` are pure (`deps`, never `ctx`).

| File | Responsibility |
|---|---|
| `review/types.ts` | Shared types (§3). |
| `review/family.ts` | `FAMILY_TABLE`, `familyOf`, `coordinatorFamily(ctx)` re-read every hook; `families.json` additive via `policy.ts`. |
| `review/roles.ts` | Fixed profile→role map keyed by profile **name**; tool bounds per role; `profileDigest`; unknown → refused. |
| `review/policy.ts` | Loads policy files + profile bodies; `policyDigest`; accepted **bodies** persisted and materialised as launch copies `<sessionDir>/profiles/<digest>/<name>.md` (A14); `rejectedDigests`; per-file invalid rule (§13); `coverageRoots`, `sandbox.*` (§8.4 keys), `verifyCommands`, `launchArgv` (A15). |
| `review/artifact.ts` | Exact-bytes tree snapshots (§4.1), plan/research manifests (§4.2), pin/unpin, `diffTrees`, `addedLines`, `packetDiff`, submodule check, `changeKind(prev,next)`. ★ All git calls via `hardenedGit` (§8.4 `harness-git`). |
| `review/store.ts` | Content-addressed store for plan/research bytes; manifests; durable before packet release. |
| ★ `review/worktree.ts` | `materialize(contentId, attemptId) → {dir, manifest}` from blobs via hardened, sandboxed `git cat-file --batch` into `<verifyBase>/<attemptId>/tree` (outside `~/.pi` and the session dir; no checkout, no `.git`), `manifestOf(dir)`, `manifestIntegrity(dir, manifest)`, `remove(dir)` (§8.3). |
| ★ `review/protected.ts` | Protected set computation (A16), `isProtected(path)`, `overlaps(root)`, `safeOpenForWrite(root, rel)` / `safeOpenForRead` via the native addon (`openat` walk, `O_NOFOLLOW`), SBPL literal escaping, canonicalisation. Shared by coordinator and worker extensions. |
| `review/contrib.ts` | Write windows, delta writers incl. coordinator model events per window, `coordinatorShellTaint: Contributor[]`, ★ `shellAuthorities` (§4.3 rule 3), `external`/unattributed, epoch. |
| `review/triggers.ts` | T1 request-wide, T2, T3, T4 with `timedOut`/`truncated` fail-closed (§11). ★ git via `hardenedGit`. |
| `review/egress.ts` | `allowedFamilies(roots[])` = intersection over roots; none accepted ⇒ deny all. |
| `review/health.ts` | Catalog ∧ auth ∧ `model-health.json` freshness; `requireHealthProbe` default `true`; ★ `pi.version` flag-semantics verification (A15). |
| `review/resolver.ts` | Kind-minimum quorum, seat-aware ordering, all-filter diagnostics, greedy distinct-family, `unblockHint` (§7). |
| `review/admission.ts` | Queued vs reserved intents, reserved slot, three queue classes (§10). |
| `review/packet.ts` | Packet assembly after durability check; `packetDigest`; `verifyIntact(seat)` (§8.1). |
| `review/verdict-schema.mjs` | Shared validator (§9). |
| `review/machine.ts` | Pure total reducer (§5). ★ minimal touches §5.1/§5.2. |
| `review/orchestrator.ts` | Effects, `QUIESCENT`, retries, prompts, audit, persist. |
| `review/recovery.ts` | Restart reconciliation with launch barrier (§5.3). |
| `review/gates.ts` | `assertLaunch`, `assertResume`, `assertCoordinatorTool`, `completionStatus`, `requestLifecycle` (§6). |
| ★ **`review/sandbox.ts`** | Deny-default SBPL generator (`verify` / `coordinator` / `author` / `harness-git` / `selftest`), path canonicalisation + overlap refusal, self-test with harness-owned canaries and mandatory controls, `spawnConfined(kind, argv, {cwd, writeRoots, env}) → {pid, stdio}` via the native addon (`posix_spawn` SETSID + CLOEXEC_DEFAULT), process-group kill on return (§8.4). |
| ★ **`review/receipt-socket.ts`** | Unix-socket listener at `<receiptSockDir>/<8-char>.sock`; peer process-instance identity (pid + start time) via native addon; registered-worker-process check; pane pid-tree check at registration; bidirectional `verify` request handling; rejection audit (§8.5). |
| ★ **`native/pi-review.c`** (N-API, ≈200 lines, prebuilt binary + source checked in) | `peerPid(fd)` (`LOCAL_PEERPID`), `procInfo(pid) → {ppid, uid, startSec, startUsec}` (`proc_pidinfo PROC_PIDTBSDINFO`), `procArgs(pid)` (self-test probe only), `spawnConfined(argv, env, cwd, stdioFds)` (`posix_spawn` with `POSIX_SPAWN_SETSID|POSIX_SPAWN_CLOEXEC_DEFAULT`), `openAtNoFollow(dirfd, name, flags)`, `openDirNoFollow(dirfd, name)`, `tiocsti(fd, byte)` (self-test only). Load failure ⇒ sandbox unavailable. |
| ★ **`review/tools/bash-guard.ts`** | Coordinator `bash` replacement under gating `on`: `spawnConfined('coordinator', …)`, cwd root registered (overlap-refused), shell authority opened/closed, taint recorded; refuses when sandbox unavailable (§6 G8). Same guard shipped to author workers (`author` profile from the harness-written `guard-config.json`). |
| `review/pairing.ts` | `/pairing` incl. `close-request`, `gating on`, `rounds` (§12). |
| `review/audit.ts`, `review/diagnose.ts` | Audit writer; chain renderer. |
| `review/tools/git-ro.ts` | `git_ro` (§8.2): `diff, log, show` only (`blame` dropped); packet-integrity check per call. ★ Runs under `harness-git` sandbox in addition to its hardened set. |
| ★ `review/tools/verify-exec.ts` | Coordinator side: `verifyExecHandler(attempt, cmd)` — materialised-tree check, `spawnConfined('verify', …)`, ledger, output caps. Verifier side: `verify_exec({cmd})` = thin client forwarding `{kind:'verify', attemptId, token, cmd}` over the receipt socket and returning the coordinator's reply (§8.3). |
| `review/tools/review-start.ts` | `review_start({artifact})`: clears `repair` hold only; refused under `recovery` hold (P9 decides). |
| `registry.ts` (modify) | v2 schema, strict validator, migration, `revision`, file-digest tamper detection (§3.4). |
| ★ `completion.mjs` (modify) | Receipts sent over the unix socket (no receipt files); startup/`model`/completion/`root`/`shell` receipts; `verify` requests; worker-side synchronous model gate (A8); worker `write`/`edit`/read-tool target interception via `protected.ts` (G12); role capability for planner/researcher assigned path. |
| ★ `lifecycle.ts` (modify) | Launches from accepted profile copies with the pinned argv (A15: `--no-approve`, never `-a`); writes `guard-config.json` (protected set, write roots, cache dirs, socket path) into the attempt's launch dir before pane creation; records pane pid + start time. |
| `subagent-done.ts`, `index.ts`, `adapter.ts` (modify) | As v1.1; ★ `adapter` adds `SandboxAdapter`, `SocketAdapter`, `ProcAdapter` (native addon wrappers, fakeable). |
| Profiles `reviewer.md`, `pr-reviewer.md` | tools `read, git_ro`; untrusted-content rules; end with `subagent_done` echoing binding id. |
| ★ `verifier.md` | tools `read, grep, find, ls, verify_exec`; cwd = materialised tree; read tools bounded to the tree (G12). |
| ★ `planner.md`, `researcher.md` | tools `read, grep, find, ls, write, edit` (no `bash`); `write`/`edit` permitted only on the assigned artifact path (G12 role capability). |

## 3. Registry schema v2

### 3.1 Types **[v1.3 CHANGED — fields marked ★★; all other fields as v1.2/v1.1]**

```ts
interface WorkerRegistryV2 { version:2; revision:number; invocations:number; invocationLimit?:number;
  workers:AttemptRecordV2[]; review:ReviewState }                       // no lastWriteDigest in body (A9)

interface ReviewState { /* as v1.1, plus: */
  sandbox:{available:boolean; checkedAt:string; profileVersion:number; addonLoaded:boolean;          ★★
           selfTest:Record<string,{control:'ok'|'setup-failed'|'untested'; sandboxed:'blocked'|'leaked'|'untested'}>;
           positive:Record<string /*kind*/, 'ok'|'failed'|'untested'>};
  receiptSock:{dir:string; path:string; createdAt:string};              ★★
  verifyBase:string;                                                    ★★   // canonical, outside ~/.pi and sessionDir
  protectedSet:string[];                                                ★★   // canonical, computed at G0, digested
  launchArgvDigest:string;                                              ★★   // A15
  coordinatorEvents:Array<{at:string; model:string; family:Contributor}>;
  profileCopies:Record<string /*name*/, {digest:string; path:string}>;
}
interface AttemptRecordV2 { /* as v1.1, plus: */
  panePid?:{pid:number; startSec:number; startUsec:number};             ★★
  workerProc?:{pid:number; startSec:number; startUsec:number; registeredAt:string}; ★★  // set by first accepted startup receipt
}
interface RequestRecord { /* as v1.1, but: */
  status:'open'|'plan-approved'|'cleared'|'closed'|'unreviewed'|'abandoned';
  coordinatorShellTaint:Contributor[];                                       // families, never shrinks
  shellAuthorities:Array<{id:string; owner:'coordinator'|{attemptId:string}; families:Contributor[]; root:string;
                          writeRoots:string[]; openedAt:string; closedAt?:string}>; ★★   // §4.3 rule 3
  triggerAggregate:{lines:number; perRoot:Record<string,number>; threshold:number; computedAt:string};
  sourceRoots:string[];
}
interface ArtifactRecord { /* as v1.1, but: */
  hold?:'recovery'|'policy'|'repair'|'tamper'|'budget';
  minQuorum:1|2;
  egressRoots:string[];
}
interface QuorumRecord { /* as v1.1 */ outcome?:'APPROVED'|'REVISE'|'BLOCKED'|'CANCELLED'; refunded?:boolean;   ★★
  cancelReason?:'invalidated-by-edit'|'invalidated-by-base'|'invalidated-by-contributors'|'cancelled-by-user'|'waived'|'recovery' }
interface VerdictRecord { synthetic?: /* v1.1 set | */ 'packet-tampered'|'receipt-rejected' }
interface LaunchIntent { status:'queued'|'reserved'|'pane-created'|'attached'|'abandoned';
  assignment:{ /* v1.1 */ queueClass:'author'|'repair'|'seat' } }
type QueueClass='author'|'repair'|'seat';
```

### 3.2 Migration — [unchanged] as v1.1 (validator-clean, `.v1.bak` once, legacy intents), plus `sandbox:{available:false, addonLoaded:false, selfTest:{}, positive:{}}`, `coordinatorEvents:[]`, `profileCopies:{}`, `triggerAggregate` zeroed; ★★ `receiptSock`, `verifyBase`, `protectedSet`, `launchArgvDigest` recomputed at G0; `shellAuthorities:[]`. Fresh registry: `gating ∈ {on, shadow}` from config, `'on'` default.

### 3.3 Retention — [unchanged] as v1.1 (referenced snapshots kept for the session; audit append-only). ★★ Verification trees under `verifyBase` are removed at attempt end; ledgers kept.

### 3.4 Writes and authority (A9) [unchanged]

In memory: `expectedFileSha256` = sha256 of the bytes last written by this process, or of the bytes first read at load. Every write: `revision+1`; before writing, re-read and hash the file; `≠ expectedFileSha256` → no write, `sessionHold='tamper'`, `hold='tamper'` on all open artifacts, audit `registry-tamper {revision, expected, found}`, P13. On write success `expectedFileSha256 := sha256(bytesWritten)`. Watcher tick performs the same comparison. Only P13 "Overwrite" clears the hold. No lock file; nothing on disk is adopted.

## 4. Snapshots, requests, provenance

### 4.1 Code snapshot — [unchanged in rule; ★ execution] as v1.1 (NUL-safe, `hash-object -w --no-filters` in argv chunks, temp index only for `update-index`/`write-tree`, submodule rules, pin via `refs/pi-subagents/<session>/<n>`, `persisted` flag). `changeKind(prev, next)` ∈ {`none`,`content`,`base`,`provenance`}. ★ Every git invocation goes through `hardenedGit` (§8.4): hardened `-c` set + stripped env + `harness-git` sandbox with write set `<root>/.git` ∪ temp index dir; sandbox unavailable ⇒ snapshot refused (`no-sandbox`), audited.

### 4.2 Plan/research snapshot — [unchanged] as v1.1 (assigned path under `<sessionDir>/artifacts/<req>/`, manifest with repo paths from the author window, store-before-record). `artifact.egressRoots = sourceRoots` = every registered root whose paths appear in the manifest ∪ roots of quoted repo content (all registered roots at author completion; conservative). A `plan.md` written by the coordinator without a planner has no standing: `plan:<req>` exists only via a `planner` attempt or `/pairing waive plan` (fail closed, stated). ★ The assigned file is created empty (0600) by the harness before launch; the planner/researcher worker may write exactly that canonical path (G12).

### 4.3 Requests, roots, write windows **[v1.3 CHANGED — root registration; rule 3 is a MINIMAL TOUCH outside Q8 scope (Astra 11)]**

- `before_agent_start`: as v1.1; new request registers cwd root with opening content id per A4 (last cleared for that root else current); `coverageRoots` from accepted config registered at every snapshot boundary.
- Root registration: canonicalise; refuse if the root contains or is contained in any protected path (A16) — the dependent launch/write is refused with `Refused (A16): root <p> overlaps protected path <q>.`. Author launch registers worker cwd root; worker-side `write`/`edit` interception (§6 G12) sends a `root` receipt for a new git root → registered with opening snapshot; coordinator `write`/`edit` resolves target path; coordinator/author `bash` registers **only its cwd root** — the sandbox makes any other write fail. Writes outside every registered root are uncovered by construction and stated in §16.
- Snapshot boundaries: as v1.1 plus `root` receipt intake, shell-authority close, and every P1/P2/P5/P11/P13 confirmation.
- **Shell authority** (Astra r4 #11): every coordinator or author `bash` call opens `shellAuthority {families: {family of the caller at call time} (author: the attempt's families), root: cwd root, writeRoots: the profile write set, openedAt}`; it closes when the tool call returns, after the guard has killed the sandboxed process group (`closedAt`). Authorities are persisted; an authority open at coordinator restart is closed at recovery with `closedAt=recovery` and its families are unioned into every delta of its write roots up to the first post-restart snapshot.
- **Writers of a delta** (window between consecutive snapshots of the same root with `changeKind ≠ none`):
  1. families of every author attempt live at any instant in the window (all `modelEvents`);
  2. + **every coordinator family observed in the window** (`coordinatorEvents` overlapping the window) if the coordinator called a write-capable or non-allowlisted tool in the window;
  3. **+ families of every shell authority whose `writeRoots` include the root and whose `[openedAt, closedAt]` overlaps the window, regardless of other writers** (applied unconditionally, before rules 4–5);
  4. if (1)∪(2)∪(3) empty and no worker live → `external`; if `request.coordinatorShellTaint ≠ ∅` → `external ∪ coordinatorShellTaint`;
  5. if (1)∪(2)∪(3) empty and a non-author worker was live → unattributed → BLOCKED `unattributed-write`, not waivable.
- `coordinatorShellTaint ∪= {coordinator family at call time}` on every coordinator `bash`/non-allowlisted tool call; never shrinks within the request (fallback for anything the authority tracking misses). Coordinator model changes append to `coordinatorEvents` at every hook; a model change cannot occur inside a tool call, so an authority's family set is fixed at open.
- `USER_CANCEL` from `unattributed-write`: writers := `{external} ∪ families(live workers in window) ∪ all coordinator families in window ∪ overlapping authorities`, audited; DRAFT `required=true`.
- Replay (A3): content **and** base equal `lastApproved` ∧ `approverFamilies ∩ contributors = ∅` → APPROVED with `replayOf`; verification PASS for that content id + base restored from history. WAIVED never replays.
- Renames = delete+add.

## 5. State machine (`machine.ts`)

### 5.1 Events **[v1.3 MINIMAL TOUCH — outside Q8 scope (Astra 9, 10)]**

As v1.1 plus `SNAPSHOT_CHANGED{snapshot, kind:'content'|'base'|'provenance', writers|'unattributed'}`, `AUTHOR_LAUNCHED`, `RECOVERY_RELEASE`, `PACKET_TAMPERED{seatId}`, `USER_REWAIVE_DECLINED`. Idempotency keys; stale-event rule as v1.1 (binding-mismatched seat events and content/base-mismatched verification events go to history, never apply).

**State-independent evidence rules (precede the matrix):**
- `VERIFY_RESULT` whose `contentId+base` equals `current` is recorded on `current.verifications` in **every** state; clearance (§5.8) is re-evaluated after every event.
- **Verification action derivation (Astra r4 #9):** after every event, the reducer derives `verifyAction(current)` from the latest verification on `current.contentId+base` and emits it as an idempotent effect keyed by `(verificationId, action)`: `FAIL` → `REPAIR` (deferred while a quorum is unsettled or an author is live for this artifact; re-derived and emitted at settlement/author completion); `ERROR`/`INVALID`/`VERIFY_FAILED` → §5.4 ladder step for that verification; `NO_COMMANDS` → P12 (once per verification id). Deferred actions are persisted as `current.pendingVerifyAction` and survive restart. A verification superseded by a content/base change drops its pending action.
- **Quorum settlement** applies in QUEUED **and** REVIEWING: whenever every seat has a verdict (real or synthetic), the quorum settles (rule in the REVIEWING|`VERDICT` row). Pre-authentication exhaustion of all seats therefore settles as BLOCKED from QUEUED.
- **Refund rule (Astra r4 #10):** a quorum is `CANCELLED` only if it exists, was charged (`round` incremented at its `QUORUM_RESOLVED`) and is unsettled (`outcome === undefined`); cancellation sets `outcome='CANCELLED'`, `refunded=true` and `round -= 1` exactly once (audit `round-refunded`). Events that would cancel from a state with no such quorum (DRAFT, REVISE, BLOCKED, APPROVED, WAIVED, NOT_REQUIRED) record no `CANCELLED` and no refund. Reducer asserts `round >= 0`.

### 5.2 Transitions (total; unlisted pairs are explicit no-ops with audit `noop-event`) **[v1.3 MINIMAL TOUCH — rows marked ★ (Astra 9, 10); all others unchanged]**

| State | Event | Result |
|---|---|---|
| any | `SNAPSHOT_CHANGED kind=none` | no-op |
| QUEUED/REVIEWING | `SNAPSHOT_CHANGED` any kind | `[DEQUEUE, INTERRUPT seats, INTERRUPT verifier if content/base]`; quorum CANCELLED (`invalidated-by-edit|base|contributors`), round refunded, `sameSeats` retained; DRAFT; provenance-only changes keep verification |
| APPROVED | `SNAPSHOT_CHANGED content|base` | DRAFT; verification invalidated by binding rule; T3 via `certifiedPaths` |
| APPROVED | `SNAPSHOT_CHANGED provenance` | A3 replay check → APPROVED on new binding (`replayOf`, audit `binding-revalidated`) else DRAFT |
| WAIVED | `SNAPSHOT_CHANGED` any kind | DRAFT; if provenance-only ∧ `waivable` → `[PROMPT_P5(rewaive)]` |
| NOT_REQUIRED | `SNAPSHOT_CHANGED` any kind | recompute triggers/`required`; required → DRAFT (`[QUIESCENT-eligible]`), else stay; verifier interrupted on content/base |
| ★ any except UNREVIEWED | `SNAPSHOT_CHANGED` writers=unattributed | BLOCKED `unattributed-write`; interrupt seats + verifier; CANCELLED **only if an unsettled charged quorum exists (§5.1 refund rule)** |
| any except UNREVIEWED | `USER_GATING_OFF` | UNREVIEWED (sticky) |
| any | `POLICY_CHANGED` | `hold='policy'`; queued seats frozen; live seats continue unless acceptance disallows their family (egress) → interrupted, substituted |
| any | `POLICY_DECIDED{accept}` | hold cleared; recompute `required` for DRAFT/NOT_REQUIRED/QUEUED; NOT_REQUIRED that becomes required → DRAFT + `QUIESCENT` scheduled; approvals stand |
| any | `TAMPER_HOLD` | `hold='tamper'` |
| any with `hold='repair'` | `AUTHOR_LAUNCHED` (this artifact) / `SNAPSHOT_CHANGED` with coordinator or author writer | hold cleared (audit `repair-hold-cleared`), then the row for the event applies |
| DRAFT | `AUTHOR_DONE`/`SNAPSHOT_CHANGED` | recompute current, contributors, triggers, `required`; replay → APPROVED (+PASS restored) else DRAFT |
| DRAFT/REVISE | `AUTHOR_FAILED{exhausted:false}` | `[RETRY_AUTHOR]` (resume else fresh with findings) |
| DRAFT/REVISE | `AUTHOR_FAILED{exhausted:true}` | BLOCKED `author-failed`, `hold='repair'` |
| DRAFT | `QUIESCENT` / `REVIEW_START` (no hold) | plan/research always required; if `required ∧ round >= roundBudget` → REVISE (findings retained) `[SHOW_VERDICTS, PROMPT_P1]`; else `required` → `[RESOLVE_QUORUM, LAUNCH_VERIFIER if code]`; `!required ∧ code` → NOT_REQUIRED `[LAUNCH_VERIFIER]` |
| DRAFT | `QUORUM_RESOLVED` | QUEUED; `round += 1`; `quorum={round, bindingId:current.bindingId, seats}`; `[ENQUEUE]` (reducer asserts `round <= roundBudget`) |
| DRAFT | `QUORUM_UNRESOLVABLE` | BLOCKED `unresolvable` `[PROMPT_P2]` |
| NOT_REQUIRED | `VERIFY_RESULT PASS` | cleared |
| NOT_REQUIRED | `VERIFY_RESULT FAIL` | `[REPAIR]` |
| NOT_REQUIRED/APPROVED/WAIVED | `VERIFY_RESULT ERROR/INVALID/NO_COMMANDS` / `VERIFY_FAILED` | §5.4 ladder |
| QUEUED | `SEAT_LAUNCHED` / `SEAT_AUTHENTICATED` | status update; REVIEWING on first authentication; `[RELEASE_PACKET seat]` |
| REVIEWING | later `SEAT_LAUNCHED`/`SEAT_AUTHENTICATED` | status; `[RELEASE_PACKET]` |
| QUEUED/REVIEWING | `SEAT_FAILED{reason}` | ladder as v1.1 (`retries`/`substitutions` per slot; `identity-mismatch`/`packet-tampered`/`receipt-rejected`/`malformed`/`snapshot-mismatch` → no same-model retry; `packet-tampered` → synthetic BLOCKED, no substitution); settlement rule applies when all seats done |
| REVIEWING | `PACKET_TAMPERED{seatId}` | seat failed `packet-tampered` → synthetic BLOCKED; audit |
| QUEUED/REVIEWING | `USER_CANCEL` | dequeue/interrupt; CANCELLED `cancelled-by-user`, refunded; DRAFT |
| ★ DRAFT/REVISE/BLOCKED/QUEUED/REVIEWING | `USER_WAIVE` (§5.7) | interrupt seats (+ verifier only if not PASS on current); **CANCELLED `waived` + refund only from QUEUED/REVIEWING (unsettled charged quorum); from DRAFT/REVISE/BLOCKED nothing is cancelled or refunded**; WAIVED on `current.bindingId`; `certifiedPaths ∪=`; `[LAUNCH_VERIFIER]` if code ∧ no PASS on current content |
| ★ QUEUED/REVIEWING | `VERDICT` / settlement | record; when all seats done: any BLOCKED → BLOCKED `[SHOW_VERDICTS, PROMPT_P2]`; else any REVISE → REVISE; if `round >= roundBudget` → `[SHOW_VERDICTS, PROMPT_P1]` else `[SHOW_VERDICTS, REPAIR]`; all APPROVED → APPROVED, `lastApproved`, `certifiedPaths ∪=`, `authorClasses=[]`, `[STEER]`; cleared iff PASS on current content+base; **then `verifyAction(current)` is re-derived and emitted (a stored FAIL → `[REPAIR]`; stored ERROR/INVALID → ladder; stored NO_COMMANDS → P12)** |
| REVIEWING | `VERIFY_RESULT FAIL` | recorded; `pendingVerifyAction=REPAIR`; emitted at settlement (§5.1) |
| APPROVED/WAIVED | `VERIFY_RESULT PASS` | cleared |
| APPROVED/WAIVED | `VERIFY_RESULT FAIL` | kept, not cleared; `[REPAIR]` |
| REVISE | `AUTHOR_DONE`/`SNAPSHOT_CHANGED` | DRAFT; `QUIESCENT` → budget check → `RESOLVE_QUORUM` with `sameSeats` |
| REVISE | `USER_EXTEND_ROUNDS{n}` / `USER_SET_ROUNDS{N>round}` | budget updated; `[REPAIR]` |
| REVISE | `USER_STOP` | BLOCKED `user-stop`, `hold='budget'` |
| BLOCKED(`hold=budget`) | `USER_EXTEND_ROUNDS`/`USER_SET_ROUNDS` | hold cleared; DRAFT if snapshot changed since, else REVISE `[REPAIR]` |
| BLOCKED | `SNAPSHOT_CHANGED` / `USER_CANCEL` | DRAFT (hold `budget` persists until extended; cancel from unattributed re-attributes) |
| any with `hold` set | `QUIESCENT` | ignored; `REVIEW_START` clears `repair` only; P9 (`RECOVERY_RELEASE`)/P10/P13/rounds prompts clear their own |

BLOCKED > REVISE > APPROVED per snapshot; verdicts verbatim.

### 5.3 Recovery [unchanged]

`recovery.ts`: (1) install `hold='recovery'` on **every** QUEUED/REVIEWING artifact and on every NOT_REQUIRED/APPROVED/WAIVED artifact with a live verifier intent — before any effect is processed; (2) reattach seats/verifiers whose pane is alive (tag match) and whose model matches; (3) dead seats → `SEAT_FAILED{cancelled}` reduced with effects **captured, not executed**; dead verifier → `VERIFY_FAILED` likewise; (4) intents `queued/reserved/pane-created` without attached attempt → `abandoned` (refund only `reserved`); queue rebuilt; (5) P9 per artifact: `Relaunch replacements/review now` → `RECOVERY_RELEASE` clears hold and runs captured effects · `Hold` → effects retained, nothing launched, `/pairing` shows "recovery hold: N captured launches". Live reattached seats continue and may settle the quorum normally; nothing is launched under the hold. `review_start` is refused under `recovery` hold. ★ Reattachment of a seat/verifier additionally requires its `workerProc` (pid + start time) to be alive and its pane pid identity to match (§8.5); otherwise the seat is dead.

### 5.4 Verification ladder — [unchanged] as v1.1 (`ERROR` one retry → fallback model → stays; `INVALID` one retry; `NO_COMMANDS` → P12; `no-sandbox` is `ERROR` with **no retry** and P2-style notice).

### 5.5 Revision owner (`REPAIR`) — [unchanged] as v1.1; hold clearance rows explicit in §5.2.

### 5.6 Quiescence — [unchanged] as v1.1 (author receipt intake, `agent_end`, hold clearance), plus `root` receipt intake and P1/P9/P10 resolution.

### 5.7 Waiver eligibility — [unchanged] as v1.1; plus `hold ∉ {tamper, budget}`. Re-waive after provenance change requires a fresh P5 (never automatic).

### 5.8 Release eligibility — [unchanged] `cleared(a)` = state ∈ {APPROVED, WAIVED, NOT_REQUIRED} on `current.bindingId` ∧ (non-code ∨ latest verification on `current.contentId+base` ∈ {PASS, ACCEPTED_NO_COMMANDS}) ∧ no hold ∧ persisted. `requestCleared(r)` = every artifact in `r.artifactKeys` cleared. TOCTOU re-snapshot before labelling.

## 6. Gate enforcement points (`gates.ts`) **[v1.3 CHANGED — G0, G1, G5, G8, G12]**

| Gate | Hook | Check | Refusal text |
|---|---|---|---|
| G0 ★ | first `before_agent_start` | policy + profile bodies vs `review-policy.accepted.json`; differs/absent → P10 before any launch; accepted bodies copied to `<sessionDir>/profiles/<digest>/` (A14); **protected set computed (A16) and digested; native addon loaded; receipt socket dir + socket created (§8.5); `verifyBase` created; sandbox self-test with controls (§8.4) recorded; launch argv template digested (A15); Pi version flag semantics verified (A15); every custom tool enabled in the coordinator session enumerated — any write-capable tool not in {`write`, `edit`, `bash-guard`, harness tools} refuses gating `on`** | `Refused: review policy/profiles not yet confirmed (P10 pending).` · `Refused (A10): sandbox unavailable ({reason}); gating 'on' cannot start shells or verification.` |
| G1 ★ | `subagent` → `assertLaunch` | profile name in role map; launch **from accepted copy** with the **pinned argv** (`--no-approve`, never `-a`); tool bounds by role (`reviewer ⊆ {read, git_ro}`, `verifier ⊆ {read, grep, find, ls, verify_exec}`, `planner/researcher ⊆ {read, grep, find, ls, write, edit}`, code authors: `{read, grep, find, ls, write, edit, bash-guard}`; no `subagent_done` forging/harness tools; any other tool → refused); code author: request-linked plan APPROVED/WAIVED, git cwd (canonical, not overlapping protected set), clean submodules, admission, no `policy`/`tamper` hold; **gating `on` ∧ sandbox unavailable ∧ profile lists `bash` → refused; `guard-config.json` written into the launch dir before pane creation; pane pid + start time recorded at pane creation** | v1.1 texts + `Refused (A10): OS sandbox unavailable; shell-bearing profiles cannot launch under gating 'on'.` · `Refused (A16): cwd <p> overlaps protected path <q>.` |
| G1′ | same | coordinator family unknown ⇒ no author launches | as v1.1 |
| G2 | same | manual reviewer = advisory; I1/egress/known; G5 + packet protocol; `queueClass:'author'` (never starves seats) | as v1.1 |
| G3 | orchestrator | same `assertLaunch` | — |
| G4 | `subagent_resume` | as v1.1; fresh startup receipt required | as v1.1 |
| G5 ★ | receipt intake (socket) | **§8.5 peer identity: startup receipt registers `workerProc` (pid + start time) iff its ancestry (via `procInfo`) reaches the intent's recorded pane pid with matching start time and every intermediate process is alive with consistent start times; every later message must come from exactly `workerProc` (pid + start time), re-checked to be alive before the message is applied; otherwise `receipt-rejected` (audited, never applied)**; reviewer **and verifier**: observed model == assigned ∧ family ∧ egress ∧ resolver filters → authenticated; any difference → interrupt, seat/verifier failed `identity-mismatch`, `.released` removed; author: families appended; startup timeout 5 min | — |
| G6 | completion receipt | §9 validation; `packet.verifyIntact(seat)` at verdict intake; mismatch → `PACKET_TAMPERED` | — |
| G7 | `agent_end` | re-snapshot; lifecycle (A4: auto-close only when `requestCleared`); banner for any uncleared artifact in open **or abandoned** requests; labels incl. `ABANDONED` | — |
| G8 ★ coordinator writes | `tool_call` | `write`/`edit`: target canonicalised; **inside the protected set → refused regardless of root**; under a registered/registrable (non-overlapping) root or the request's `<sessionDir>/artifacts/<req>/` files → allowed **via `safeOpenForWrite` (`openat` walk, `O_NOFOLLOW`; symlink in path → refused)**; coordinator writer marked, family appended to window. **`bash`: replaced by `bash-guard` under gating `on` — `spawnConfined('coordinator')` (write set = registered roots ∪ coverageRoots ∪ `sandbox.cacheDirs` ∪ private tmp; network per A10), cwd root registered (overlap-refused), shell authority opened/closed, process group killed on return, `coordinatorShellTaint ∪= family`; sandbox unavailable → refused**; policy-path writes refused (protected) and audited | `Refused (I4): write to <path> is outside every registered git repository.` · `Refused (A16): <path> is a protected harness path.` · `Refused (A16): symlink in path.` · `Refused (A10): shell is unavailable without the OS sandbox; delegate to a worker or use write/edit.` |
| G9 | policy load | as v1.1; accept ⇒ profile copies + `profileDigests` + `profileCopies` replaced atomically; reject ⇒ untouched | as v1.1 |
| G10 | `/pairing` only | schemas `additionalProperties:false` | — |
| G11 | `writeRegistry` | §3.4 | as v1.1 |
| G12 ★ worker writes/reads | worker extension `tool_call` | Uses `guard-config.json` (protected set, registered roots, write set, socket path, role, assigned path). `write`/`edit`: canonicalise; **protected → refused**; `planner`/`researcher`: allowed iff the canonical target equals the assigned artifact path (exact, `O_NOFOLLOW`), everything else refused (`Refused (A16): only the assigned artifact path is writable.`); code authors: under a registered root → allowed via `safeOpenForWrite`; under an unregistered, non-overlapping git root → `root` receipt, then allowed after harness ack (snapshot taken); under no git root or overlapping → refused. **Read tools (`read`, `grep`, `find`, `ls`): protected read set (`~/.pi`, session dir, receipt socket dir, other attempts' verification trees) refused; verifier: every target's canonical path must be inside its materialised tree (symlinks resolving outside are refused).** `bash` (code authors only) → `spawnConfined('author')` from the guard (write set = registered roots ∪ coverageRoots ∪ cache dirs ∪ private tmp; network per A10/O9); shell authority reported via `shell` receipts (open/close); process group killed on return; sandbox unavailable → refused (launch already refused by G1) | `Refused (A11): write to <path> is outside review coverage.` · `Refused (A16): <path> is protected.` · `Refused (A16): read outside verification tree.` |

Role map as v1.1. Coordinator stay-here edits not subject to G1 (O1).

## 7. Resolver (`resolver.ts`) [unchanged]

```
minQ = kind==='plan' ? 2 : 1                                   // A12
cls  = first of CLASS_PRECEDENCE present in authorClasses (∅ → coordinator)
q    = max(minQ, DEFAULTS[cls].q)
picks_slot = DEFAULTS[cls].picks[slot] ?? (kind==='plan' ? DEFAULTS.planner.picks[slot] : [])
egressFamilies = egress.allowed(artifact.egressRoots)            // intersection over roots
```
Candidate diagnostics, per-seat greedy with distinct families, `sameSeats`, seat overrides, `retainedCtx`, `unblockHint` as v1.1. Verifier resolution `[SONNET, GLM_FLASH, GROK]` filtered by catalog/auth/health/egress over `egressRoots`; observed model checked at G5. Property test: for q=2, greedy is complete over all family subsets and per-slot preference orders; for an approved plan edited by the coordinator, `q` stays 2.

## 8. Packet, reviewer tools, verifier execution, sandbox, receipts

### 8.1 Packet release — [unchanged] as v1.1 (empty seat cwd; packet only after `SEAT_AUTHENTICATED` and persistence; `.released`). `packetDigest` = sha256 over `packet.md` + every file under `files/`; `verifyIntact(seat)` recomputes it at **every `git_ro` call** and at verdict intake; mismatch → `PACKET_TAMPERED` (seat failed, synthetic BLOCKED, no retry, audited). Egress for the packet = `egressRoots` intersection.

### 8.2 Reviewer tools — [unchanged] as v1.1 (`read`, `git_ro` via `execFile`, hardened `-c` set, stripped env, allowlist) with `sub ∈ {diff, log, show}`; `blame` removed. Fixture #21b: no child process for malicious `.gitattributes`/`.git/config` on all three subcommands. Read-based exfiltration of repository content remains unprevented (stated). ★ `git_ro` additionally runs under the `harness-git` sandbox (§8.4); reviewer `read` is subject to the G12 protected read set.

### 8.3 Verifier execution and evidence (A5) **[v1.3 CHANGED — fully inlined; no v1.1 deferrals remain]**

**Locations.** `verifyBase = realpath($TMPDIR)/pi-rv-<uid>/<sessionShort>/` (dir 0700, created at G0, outside `~/.pi` and the session directory); `dir = <verifyBase>/<attemptId>/tree`; `privateTmp = <verifyBase>/<attemptId>/tmp`; `home = <verifyBase>/<attemptId>/home`. The ledger lives in coordinator memory and is persisted to `<sessionDir>/verify/<attemptId>.ledger.json` (protected path; the verifier cannot read or write it).

**Materialisation** (`worktree.materialize`, coordinator side, `hardenedGit` under `harness-git` sandbox with read-only access to `<root>/.git`): `git ls-tree -r -z <tree>` enumerates entries; blobs fetched with `git cat-file --batch` (raw object bytes, no filters, no attributes, no encoding, no hooks — no checkout code path is used); regular files written with mode from the tree entry via `safeOpenForWrite` under `dir`; symlinks created from blob bytes (the `verify` sandbox and the G12 verifier read bound prevent following them outside `dir`); gitlinks → `UnsupportedTree`. No `.git` is created (commands needing git metadata fail and are reported as FAIL/ERROR — stated residual). Pre-execution `manifestOf(dir)` must equal the snapshot manifest else `INVALID{materialisation-mismatch}`.

**Required-command discovery** (from the pinned tree only, evaluated coordinator-side): (1) `verifyCommands[<root>]` from digested config, if present — exact list; (2) else the first matching ecosystem, all of its commands required: `package.json` scripts ∩ {`test`, `lint`, `typecheck`} → `<pm> run <script>` with `<pm>` from the lockfile (`pnpm-lock.yaml`→pnpm, `yarn.lock`→yarn, else npm); `go.mod` → `go test ./...`, `go vet ./...`; `Cargo.toml` → `cargo test`; `pyproject.toml`/`pytest.ini`/`setup.cfg` with pytest config → `python -m pytest`; `Makefile` with target `test` or `check` → `make <target>`; (3) none → `NO_COMMANDS`. The required set is written into the verifier's packet and into the ledger header.

**`verify_exec({cmd})` (verifier tool)** sends `{kind:'verify', attemptId, token, cmd}` over the receipt socket connection from the registered worker process (§8.5). **Coordinator handler:** peer identity verified (G5); attempt must be a live verifier with a materialised tree; `sandbox.available` else reply `ERROR{'no-sandbox'}` and nothing is spawned; `spawnConfined('verify', ['/bin/bash','-c',cmd], {cwd:dir, env})` with env exactly `{PATH:'/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin' ∪ nodeBinDir, HOME:home, TMPDIR:privateTmp, LANG:'C.UTF-8', TERM:'dumb', CI:'1'}` (nothing inherited; `PI_*`/harness variables absent — defence in depth, not a boundary); stdout/stderr captured through harness-owned pipes, capped at 1 MiB each (`truncated` flag); timeout `sandbox.verifyTimeoutMs` (default 20 min) → process group killed, `exit=null`, `timedOut`; ledger entry `{seq, cmd, startedAt, durationMs, exit, signal, stdoutSha256, stderrSha256, truncated, timedOut}` appended and persisted before the reply; reply `{seq, exit, stdoutTail, stderrTail, truncated, timedOut}` (tails ≤ 64 KiB). At most one command runs per attempt at a time; a second concurrent request is refused `busy`.

**Result derivation (coordinator, at verifier completion):** `payload.commands[]` (claims `{cmd, exit}`) must each match a ledger entry exactly (string-equal `cmd`, same `exit`) else `INVALID{payload-not-in-ledger}`; every required command must appear in the ledger (exact string) with `exit===0` else `FAIL` (required command missing → `FAIL{missing-required}`); `manifestIntegrity(dir, manifest)` after the run: any manifest entry modified, deleted, or type-changed → `INVALID{tree-modified}` (new untracked files are allowed and listed in the ledger footer); required set empty → forced `NO_COMMANDS` regardless of payload; verifier exit without completion receipt → `VERIFY_FAILED`. `PASS` otherwise. Residual per A5: a test can forge its own exit status.

### 8.4 OS sandbox (`sandbox.ts`, Q7) **[v1.3 CHANGED — rewritten]**

**Profile kinds:** `verify`, `coordinator`, `author`, `harness-git`, `selftest`. Generated per call from canonical paths; every path literal escaped (`"`→`\"`, `\`→`\\`); a path containing `\n`, `\r`, `"`, control characters or invalid UTF-8 refuses the operation (`unsafe-path`). Rule precedence in SBPL is **not** relied upon beyond what the self-test proves: every protected path has a deny probe and every permitted operation has an allow probe (below).

```
(version 1)
(deny default)
;; --- capabilities common to all kinds ---
(allow process-fork)
(allow process-exec (subpath "/bin") (subpath "/usr/bin") (subpath "/usr/sbin") (subpath "/usr/lib") (subpath "/usr/libexec")
                    (subpath "/System/Library/Frameworks") (subpath "/opt/homebrew") (subpath "/usr/local")
                    (subpath "<nodeExecDir>") (subpath "<gitExecPath>") <…write set…>)   ; harness-git: only <gitBin> + <gitExecPath>
(allow file-read* file-read-metadata (subpath "/"))                                       ; protected denies follow LAST
(allow file-write* (literal "/dev/null"))
(allow file-ioctl (regex #"^/dev/(null|zero|random|urandom)$"))                          ; no tty ioctls
(allow sysctl-read (sysctl-name "hw.ncpu") (sysctl-name "hw.memsize") (sysctl-name "hw.pagesize") (sysctl-name "hw.machine")
                   (sysctl-name "kern.osrelease") (sysctl-name "kern.osversion") (sysctl-name "kern.hostname")
                   (sysctl-name "kern.version") (sysctl-name "kern.boottime") (sysctl-name "kern.maxfilesperproc")
                   (sysctl-name "vm.loadavg") (sysctl-name "kern.argmax"))
(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center")
                   (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.SecurityServer")
                   (global-name "com.apple.trustd") (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent"))
(allow ipc-posix-shm-read-data ipc-posix-shm-read-metadata)
(allow signal (target self))
(allow sysctl-read (sysctl-name-prefix "kern.proc.pid.<selfpid>"))   ; NOT emitted — process-info of self is via allow process-info-pidinfo (target self)
(allow process-info-pidinfo (target self)) (allow process-info-setcontrol (target self))
;; explicit denies (redundant under deny-default; kept so leaks surface as profile bugs, not silent allows)
(deny process-info* (target others)) (deny sysctl-read (sysctl-name-prefix "kern.proc") (sysctl-name-prefix "kern.procargs"))
(deny lsopen) (deny appleevent-send) (deny file-ioctl (regex #"^/dev/(tty|pty|cons)"))
(deny mach-lookup (global-name-prefix "com.apple.coreservices.launchservicesd") (global-name-prefix "com.apple.lsd.")
                  (global-name-prefix "com.apple.xpc.launchd") (global-name-prefix "com.apple.launchservices")
                  (global-name-prefix "com.apple.tccd") (global-name-prefix "com.apple.iohideventsystem")
                  (global-name-prefix "com.apple.SystemConfiguration") (global-name-prefix "com.apple.distributed_notifications"))
;; --- per kind ---
verify:      (allow file-write* (subpath "<dir>") (subpath "<privateTmp>") (subpath "<home>"))            ; no network rule at all
coordinator: (allow file-write* (subpath r)…registeredRoots ∪ coverageRoots… (subpath "<privateTmp>") (subpath c)…sandbox.cacheDirs…)
             (allow network-outbound (remote ip "*:*")) (deny network-outbound (remote ip "localhost:*"))   ; unless sandbox.allowLoopback
             (allow network-outbound (literal "/private/var/run/mDNSResponder"))                           ; DNS only
             (allow mach-lookup (global-name "com.apple.system.dnsserver"))
author:      same as coordinator; network per sandbox.authorNetwork (O9) — deny-all when false
harness-git: (allow file-write* (subpath "<root>/.git") (subpath "<tmpIndexDir>"))                         ; no network; process-exec = <gitBin>, <gitExecPath> only
;; --- protected set: emitted LAST in every kind (A16) ---
(deny file* (subpath "<HOME>/.pi") (subpath "<sessionDir>") (subpath "<tmuxSockDir>") (subpath "<receiptSockDir>")
            (subpath "<verifyBase>") (subpath "<piInstallDir>") (subpath "<extensionRoot>") (literal "<nodeExecPath>") (literal "<addonPath>"))
(deny network-outbound (subpath "<tmuxSockDir>") (subpath "<receiptSockDir>"))
verify only, after the protected denies: (allow file-read* file-write* (subpath "<dir>") (subpath "<privateTmp>") (subpath "<home>"))
   ; the generator asserts <verifyBase>/<attemptId> is the only protected ancestor of these three paths
```

The unix-domain deny for `<receiptSockDir>`/`<tmuxSockDir>` plus deny-default means no other unix socket is reachable by sandboxed processes except the DNS resolver (coordinator/author) and those listed in `sandbox.unixSockets` (digested, default empty). `sandbox.cacheDirs` (digested; default `~/.npm`, `~/.cache`, `~/Library/Caches`) must not overlap the protected set (checked; overlap ⇒ config invalid). `tmuxSockDir` = dirname of `tmux display -p '#{socket_path}'` (from `$TMUX` at G0; cross-checked at every launch).

**Spawn.** `spawnConfined(kind, argv, opts)`: profile written to `<sessionDir>/sandbox/<kind>-<n>.sb` (0600, protected), then `posix_spawn(['/usr/bin/sandbox-exec','-f',profile,…argv])` through the native addon with `POSIX_SPAWN_SETSID` and `POSIX_SPAWN_CLOEXEC_DEFAULT`; stdio = three harness-owned pipes; no controlling tty; cwd = canonical, inside the write set; env exactly as given (§8.3 for `verify`; coordinator/author: `{PATH, HOME:<real HOME>, TMPDIR:<privateTmp>, LANG, TERM:'dumb'}` plus digested `sandbox.env` keys). On tool return or timeout the whole process group (`-pgid`) receives SIGKILL; the shell authority closes after the group is gone.

**Harness-side git (`hardenedGit`).** Every `git` call from `artifact.ts`, `worktree.ts`, `triggers.ts`, `git_ro`: argv prefix `git -c core.fsmonitor= -c core.hooksPath=/var/empty -c diff.external= -c core.pager=cat -c core.sshCommand=/usr/bin/false -c credential.helper= -c gpg.program=/usr/bin/false -c protocol.allow=never --no-ext-diff --no-textconv` (plus subcommand-specific `--no-filters`), env `{GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0', PATH, HOME:<privateTmp>}`, run under `harness-git` (process-exec restricted to the git binary and its exec-path, so any surviving config-driven exec fails; writes only `<root>/.git` + temp index dir; no network). Sandbox unavailable ⇒ the operation is refused (`no-sandbox`), audited; under `shadow` it runs unsandboxed with the hardened set only (audited).

**Self-test** (G0, again on every policy accept, again hourly; ≤ 1 h cache): the harness first sets up **canaries it owns**: `<sessionDir>/canary.txt` (readable, secret content), `<HOME>/.pi/canary.txt`, a writable dir outside every write set, a live loopback TCP listener, a live unix listener in `<receiptSockDir>`, the real tmux socket, the real receipt socket, a `.command` file and a launchd plist in the write set that write a token into a harness-owned file, a pty pair for TIOCSTI, and a harness-owned `probe` helper (the addon's `procArgs`). Each probe is run **twice**: the unsandboxed **control** must succeed (`control:'ok'`), then the sandboxed run must fail (`sandboxed:'blocked'`). Any control that fails ⇒ `control:'setup-failed'` ⇒ `sandbox.available=false` (reason shown; for (i) the notice names the Automation/TCC permission the terminal needs). Probes, per kind: (a) read `<sessionDir>/canary.txt` and `~/.pi/canary.txt`; (b) `probe procargs <harnessPid>` and `ps -p <harnessPid> -o command=`; (c) `connect()` to the tmux socket path; (d) `connect()` to the receipt socket real path; (e) create a file in the outside dir; (f) `verify`/`harness-git`: TCP connect to the loopback listener and unix connect to the listener in `<receiptSockDir>`; coordinator/author: unix connect to that listener (loopback TCP per `allowLoopback`); (g) `open <x>.command` — token must not appear within 5 s; (h) `launchctl bootstrap gui/$UID <plist>` — token must not appear; (i) `osascript -e 'tell application "System Events" to count processes'`; (j) `probe tiocsti` on `/dev/tty` — no byte arrives on the harness pty; (k) `kill -0 <harnessPid>` then `kill -USR1 <canary child>` — signal must not arrive; (l) `sandbox-exec` re-entry escape: `sandbox-exec -n no-sandbox true` must fail. **Positive probes** (each kind): read + exec a script in its write set; write a file in its write set; `verify`: run `node -e`, `git --version` (no repo), `bash -c 'echo ok'`; coordinator/author: DNS lookup of `sandbox.selfTest.dnsName` (default `example.com`, `untested` if offline) and remote TCP connect to the same (offline ⇒ `untested`, not failure); `harness-git`: `git write-tree` against a temp repo in its write set. Any positive probe failure ⇒ `positive[kind]='failed'` ⇒ `available=false`. `sandbox-exec` missing, non-macOS, addon load failure, or any `leaked`/`setup-failed`/`failed` ⇒ `sandbox.available=false`, audited; under gating `on` → G0/G1/G8/G12/verify_exec/snapshot refusals per A10. Shadow: sandbox used when available, unavailability audited. The self-test is the authority, not the profile text.

### 8.5 Receipt socket (`receipt-socket.ts`, Q7) **[v1.3 CHANGED — rewritten]**

**Path.** `receiptSockDir = realpath($TMPDIR)/pi-rs-<uid>/` (0700, created at G0), socket `<receiptSockDir>/<8 random chars>.sock` (0600), total path length asserted < 100 bytes else G0 refuses gating `on` with the actual length; recorded in `ReviewState.receiptSock`; passed to workers via `guard-config.json` and the launch env; denied in every profile; self-test (d) connects to this real path. Unit test: session directory path of 120 characters still binds.

**Protocol.** One connection per worker Pi process for its lifetime (reconnect allowed; every connection re-authenticates). Newline-delimited JSON messages: `{kind:'startup'|'model'|'completion'|'root'|'shell', attemptId, token, piSessionId, body}` and `{kind:'verify', attemptId, token, cmd}` (reply on the same connection). Receipt files are never read. The attempt token is an identifier only.

**Peer identity.** On `accept`: `peer = {pid: peerPid(fd) /* LOCAL_PEERPID */, ...procInfo(pid) /* uid, startSec/usec */}`; `uid` must equal the harness uid. Ancestry is resolved with `procInfo` per hop (pid → ppid, each hop's start time must be ≤ its child's; a hop that is dead or whose start time changed ⇒ retry the walk once after 50 ms, then reject). **Registration:** a `startup` message is accepted iff the walk from `peer.pid` reaches `attempt.panePid.pid` **with the recorded pane start time**, the intent→attempt mapping matches, and no `workerProc` is registered for the attempt (or a resume was requested by G4 and the previous `workerProc` is dead); on acceptance `attempt.workerProc := {pid, startSec, startUsec}`. **Every subsequent message** (including `verify` requests) is accepted iff `peer.pid === workerProc.pid` and `procInfo(peer.pid)` still returns the registered start time **at the moment the message is applied** (peer alive, same instance); a descendant, a sibling in the same pane, a process that inherited the descriptor after the worker exited, a reused pid, or a replaced pane fails this check ⇒ `receipt-rejected` / `verify-rejected`, audited `receipt-peer-mismatch {peerPid, peerStart, expected, attemptId, reason}`, no state change. `LOCAL_PEERPID` semantics are validated at G0 by the self-test: a harness-spawned child connects and its reported pid/start time must equal the spawn result. `SO_PEERCRED` is Linux-only and part of O8. The addon failing to load ⇒ every message rejected `no-peerpid`; gating `on` fails closed (P2-style notice).

**Consequences.** Sandboxed processes cannot reach the socket (§8.4) and cannot read tokens; an unsandboxed worker Pi process — which executes no repository code (A15) — can speak only for its own attempt; verification commands never touch the ledger because they run in a process spawned by the coordinator, and their host process (the verifier) can only *request* execution.

## 9. Structured verdict / verification schema — [unchanged] as v1.1 (`subagent_done` args with `additionalProperties:false`; reviewer/verifier host rules; truncation; duplicate/conflicting/late receipts), plus: a message whose peer verification failed is rejected before schema validation; a verdict whose packet integrity check fails is `packet-tampered`. ★ Verification payload `commands[]` is cross-checked against the coordinator ledger per §8.3.

## 10. Admission control (`admission.ts`) [unchanged]

```
MAX_LIVE=4; RESERVE=1
liveTotal = attached panes + intents in {reserved, pane-created}           // 'queued' NOT counted
reviewPending = as v1.1
admit(intent):                                                           // called exactly once per intent
  free = MAX_LIVE - liveTotal
  free<=0 → wait
  class 'seat'   → ok (may use the reserved slot)
  class 'repair' → reviewPending ∧ free<=RESERVE → wait (ahead of authors)  else ok
  class 'author' → reviewPending ∧ free<=RESERVE → wait ('waiting for review capacity') else ok
on ok: intent.status='queued'→'reserved' (counted from now), invocations+1, then pane creation
queue: three FIFOs; tick() drains seat, then repair, then author; each admission re-runs gates.assertLaunch
```
Advisory reviewers are class `author`. Launch phases as v1.1 (`queued` → `reserved` → `pane-created` → `attached`). Tests: four queued intents on an empty session all get admitted (no self-block); four concurrent repairs with a pending review leave one slot for the seat.

## 11. Triggers (`triggers.ts`) [unchanged]

`required = depth==='full' ∨ 'external' ∈ contributors ∨ T1 ∨ T2 ∨ T3 ∨ T4 ∨ t4.timedOut ∨ t4.truncated`.

- **T1 (request-wide)**: for every code artifact `a` in the request, `lines(a)` = Σ(binary?50:added+removed) over `diffTrees(baseline(a), a.current)` with `baseline = lastApproved.contentId ?? opening`; `request.triggerAggregate.lines = Σ lines(a)`; threshold = min over classes contributing anywhere in the request `{fanout:150, bulk:150, coordinator:30}`; T1 fires for **every** conditional artifact of the request when `aggregate > threshold`. Reset happens per artifact via its own baseline on approval; other roots keep their contribution.
- **T2**: as v1.1 (glob compiler, fixtures depth ≥2).
- **T3**: as v1.1 (union of `certifiedPaths` over request + root).
- **T4**: as v1.1 patterns and worker-thread bound; any truncation (line > 4 KB, file > 2 MB, unreadable blob) sets `t4.truncated=true` ⇒ required; timeout ⇒ required.

Config, invalid handling, `TriggerEval` as v1.1 plus `t4.truncated`, `t1.aggregate`.

## 12. TUI prompts **[v1.3 CHANGED — P2 text, P16, `/pairing` rendering; others unchanged]**

All via `ctx.ui.*`; audit lines; stale-target prompts re-raised. Trust basis: A10.

| # | When | Text / options |
|---|---|---|
| P1 | quorum would launch or REVISE settled with `round >= roundBudget` (findings first) | `Review budget for {key}@{id} is exhausted ({round}/{roundBudget}); last outcome REVISE ({seat: verdict, n findings}…). Continue?` → `Continue +2 rounds` · `Set total round limit…` (int > round) · `Stop — block until extended` (`hold='budget'`) |
| P2 ★ | BLOCKED | as v1.1; for `no-sandbox`: `… BLOCKED: OS sandbox unavailable — {reason: missing sandbox-exec | addon not loaded | self-test {probe}: {control:setup-failed | sandboxed:leaked} | positive probe {kind} failed | socket path too long}; shells, snapshots and verification are refused under gating 'on'.` |
| P3 | invocation limit | unchanged |
| P4 | review wall 90-min multiples | as v1.1 |
| P5 | waive / re-waive | as v1.1; re-waive variant: `Contributors of {key} changed ({old} → {new}); the previous waiver does not carry. Waive again?` |
| P6–P8 | off / astra / set | as v1.1 |
| P9 | restart with dead seats/verifier | `Recovery for {key}@{id}: {live} live seat(s) reattached; {n} launch(es) needed ({list}). Launch them now?` → `Launch now` (`RECOVERY_RELEASE`) · `Hold` |
| P10 | policy/profile change | as v1.1; `Apply` also replaces profile copies/digests |
| P11 | plan-approved continuation | as v1.1 |
| P12 | NO_COMMANDS | as v1.1 |
| P13 | tamper | as v1.1 (file-digest wording) |
| P14 | `close-request` | `Close request {id}? {n} artifact(s) are not cleared: {list}. They will be labelled ABANDONED and remain visible until cleared or waived.` · `gating on` as v1.1 |
| P15 | `/pairing rounds <artifact> +n|N` | `Extend round budget for {key} from {b} to {b'}?` → confirm → `USER_EXTEND/SET` |
| P16 ★ | self-test control (i) fails with a TCC error, or a sandbox EPERM audit names a path under an unregistered dir 3+ times | `Sandbox self-test cannot run probe {p}: {error}. Grant the permission and retry, or keep the sandbox unavailable.` → `Retry self-test` · `Keep unavailable` · (EPERM variant) `Add {dir} to coverageRoots/cacheDirs? (policy change → P10)` |

`/pairing` additionally renders: sandbox status per kind with self-test control/sandboxed/positive results and last run; receipt socket path + addon status; protected set; verification base; launch argv digest + Pi version verification; request trigger aggregate; coverage roots; open shell authorities; abandoned requests; profile copies in force.

## 13. Failure handling **[v1.3 CHANGED — sandbox rows]**

As v1.1 with these rows changed/added:

| Failure | Detection | Handling |
|---|---|---|
| Sandbox unavailable / self-test leak / control setup failure / positive probe failure | G0, policy accept, hourly | `sandbox.available=false` with reason; gating `on`: `verify_exec` `ERROR{no-sandbox}` (no retry), coordinator/author `bash` refused, shell-bearing launches refused, snapshot/trigger/materialisation git operations refused; shadow: audited, hardened-set-only git |
| Message from wrong peer / dead peer / reused pid / replaced pane / same-pane descendant | §8.5 | rejected, audited; seat proceeds to `no-receipt`/timeout ladder; `verify` request refused |
| Native addon load failure | G0 | all messages rejected under gating `on` (fail closed); sandbox unavailable; P2-style notice |
| Receipt socket path too long / bind failure | G0 | gating `on` refused with actual length; shadow continues without receipts (audited) |
| Root or cache dir overlaps protected set; unsafe path characters | registration / profile generation | registration/launch/write refused (`A16`); audited |
| Sandboxed shell EPERM outside write set | audit | `write-out-of-scope {path}`; P16 after 3 hits on the same dir |
| Repo `.git/config` with `core.fsmonitor`/`diff.external`/filters | `hardenedGit` | overridden by `-c`; any residual exec blocked by `harness-git` process-exec allowlist; operation may FAIL → audited `git-config-interference` (availability only) |
| Repo/tree containing `.pi/` | A15 | never loaded (`--no-approve`, no `-a`); #48 |
| Packet tampered | `git_ro` call / verdict intake | `PACKET_TAMPERED` → synthetic BLOCKED, no retry |
| Binding change during quorum | `SNAPSHOT_CHANGED` any kind | CANCELLED (reason by kind), round refunded once, DRAFT, re-resolve with `sameSeats` |
| Waiver with live verifier | `USER_WAIVE` | verifier relaunched if no PASS on current; no refund unless an unsettled quorum existed |
| Early verification FAIL/ERROR/INVALID/NO_COMMANDS | §5.1 derivation | pending action persisted; emitted at settlement/author completion; idempotent |
| Budget exhausted | pre-launch check | P1; `Stop` → `hold='budget'` until P15/P1 extend |
| Request closed with uncleared artifacts | P14 | `abandoned`; still in banner/`reviewPending` |
| Multi-root evasion | request-wide T1 | required on all conditional artifacts |
| T4 input truncation | `RegexRunner` | `t4.truncated` ⇒ required |
| Coordinator model switch mid-request | `coordinatorEvents` | all families observed in window attributed; taint retains families; shell authorities carry call-time families |
| Worker `/model` | worker-side gate | turn aborted before provider request; transition receipt; harness interrupts |
| Partial recovery | `recovery.ts` | hold + captured effects; P9 decides; open shell authorities closed at recovery and attributed to the next delta |
| Author write outside coverage | G12 / sandbox EPERM | refused / fails; audited `write-out-of-scope`; uncovered writes cannot occur through harness-spawned processes |
| Process filter / encoding in repo | blob materialisation | no checkout path; fixture proves no execution, raw bytes |

## 14. Test plan **[v1.3 CHANGED — sandbox-scope tests; unchanged items reproduced]**

Framework as v1.1 (`node:test`, fake adapters, real git, real hooks; 195 existing tests pass unchanged). Every test names expected outcome and environment. Tests marked **control** run each attack twice; the sandboxed run must block and the unsandboxed run (test-only `sandbox.disable`) must succeed, otherwise the test fails.

**Unit additions/changes** — ★ `sandbox` (deny-default profile generation per kind; literal escaping; unsafe-path refusal; protected denies emitted last; overlap refusal for roots/cache dirs; self-test: every probe has a control, control failure ⇒ unavailable, positive probe failure ⇒ unavailable, cache ≤ 1 h; `spawnConfined` has no controlling tty and no inherited fds ≥ 3 — asserted via `/dev/fd` listing and `tty` inside the child; process-group kill on return); ★ `receipt-socket` (short path binds with 120-char session dir; peer pid+start identity; registration only via startup with pane ancestry + pane start time; later messages only from registered instance; dead-peer, reused-pid, replaced-pane, same-pane-descendant, inherited-fd rejections; `verify` request routing; addon-missing fail-closed); ★ `protected` (protected set computation; `isProtected` for aliases/relative/`..`/symlinked paths; `safeOpenForWrite` refuses symlink components and follows none; `openat` walk from root); ★ `worktree` (materialisation under `verifyBase`; manifest equality; `manifestIntegrity` distinguishes new files from modified entries; blob materialisation with `filter.*.process`, `working-tree-encoding`, `post-checkout`, smudge, autocrlf → no execution, raw bytes); ★ `hardenedGit` (argv prefix + env exact; runs under `harness-git`; `core.fsmonitor`/`diff.external`/`credential.helper` in `.git/config` → zero child processes); ★ `verify-exec` (discovery precedence per ecosystem incl. `verifyCommands` override; payload⊆ledger; missing required ⇒ FAIL; `tree-modified` ⇒ INVALID; `busy`; timeout; output caps; ledger persisted before reply; no-sandbox ⇒ ERROR without spawn); `contrib` (coordinator families per window, taint never shrinks, ★ shell authority open/close, rule 3 unconditional union across multiple boundaries with an unrelated concurrent author, authority open at restart); `triggers` (as v1.2); `resolver` (as v1.2); `machine` (every §5.2 row incl. VERIFY in DRAFT/QUEUED recorded; all seats fail pre-auth → BLOCKED from QUEUED; waive relaunches verifier; ★ waive from DRAFT/REVISE/BLOCKED cancels nothing and refunds nothing; ★ unattributed write in DRAFT no refund; ★ duplicate cancellation refunds once; ★ pending verify action derived and emitted for FAIL/ERROR/INVALID/NO_COMMANDS in DRAFT/QUEUED/REVIEWING and after settlement; REVISE + `AUTHOR_FAILED{exhausted:false}`; repair-hold clearance rows; budget gate at launch; refund on cancel; `hold='budget'`; each change kind × {QUEUED, REVIEWING, APPROVED, WAIVED, NOT_REQUIRED}; policy accept promotes NOT_REQUIRED); `admission` (as v1.2); `registry` (as v1.2); `policy` (as v1.2 plus ★ `launchArgv` digest and `sandbox.*` validation); `gates` (★ G12 role capability: planner writes assigned path, sibling refused; verifier read bound; protected-path refusals for every write-capable tool; G1 tool-list bound; no-sandbox refusals; request auto-close only when all cleared; abandoned still pending).

**Executable traces** — recorded event sequences replayed through reducer + orchestrator with fake adapters, asserting terminal state and effects: T1 verifier-first-then-quorum ★ extended to FAIL, ERROR, INVALID, NO_COMMANDS (each asserts the eventual REPAIR/ladder/P12 effect exactly once); T2 all-seats-fail-pre-auth; T3 waive-during-verify; T4 revise-author-fail-retry; T5 repair-hold-then-coordinator-edit; T6 cancel-at-budget-then-edit; T7 partial-recovery-hold-release; T8 provenance-change-during-review; ★ T9 waive-in-DRAFT (no cancel/refund); ★ T10 settled-REVISE-then-waive (no refund); ★ T11 unattributed-write-in-DRAFT (no refund); ★ T12 duplicate cancellation (one refund).

**Property/model-based** — as v1.1 plus: `round` mutated only by `QUORUM_RESOLVED` (+1) and first `CANCELLED` of a charged unsettled quorum (−1), never negative, never `> roundBudget` at `QUORUM_RESOLVED`; ★ `Σ refunds ≤ Σ charges` over any event sequence; ★ every recorded FAIL/ERROR/INVALID/NO_COMMANDS on `current` eventually yields exactly one action effect unless superseded by a content/base change; plan artifacts never APPROVED with < 2 distinct approving families; no request auto-closes with an uncleared artifact; no message applied from an unregistered or dead peer instance.

**Integration** — as v1.1 plus: multi-root request (A cleared, B blocked → request stays open; explicit close → abandoned + banner); approved plan edited by coordinator → two seats; policy accept promoting NOT_REQUIRED; worker `/model` mid-review with a mock provider counting requests (= 0 for the new model); partial recovery (1 live + 1 dead: no launch until P9); ★ full verifier round trip: real materialisation under `verifyBase`, real `verify_exec` over the socket running `npm test` in a fixture (PASS), then the same fixture with a failing test (FAIL) and with a test that modifies a tracked file (INVALID); ★ planner attempt writes its assigned plan file over G12 and completes.

**Adversarial** (`test/adversarial/*.test.ts`) — v1.1 #1–#30 retained; #15, #18, #23b, #38, #45, #46 extended; #31–#44 as v1.2; #47–#56 new:

| # | Scenario | Expected | Env |
|---|---|---|---|
| 15 ★ | receipt forgery: (a) file-based receipt, (b) socket connection from coordinator `bash`, (c) from a `verify_exec` test, (d) from an author-worker `bash`, (e) token harvested via `ps`/`procargs` then replayed from an unsandboxed helper outside any pane, **(f) replayed from an unsandboxed helper inside the victim pane (same pane, unregistered process), (g) `verify` request from a `verify_exec` test** | all rejected; (e) harvest fails inside sandbox; **controls:** with sandbox disabled (c)/(d)/(e) harvest succeeds and the connection is made, yet every message is rejected by the process-instance check (only the registered worker instance is accepted, so (f) is rejected even with the sandbox disabled) | real hooks + real sandbox (macOS) |
| 18 ★ | completion bypass: banner/steer on real `agent_end`; **(b) `tmux send-keys` from coordinator `bash`, verify_exec, author `bash` while P2 is open; (c) `open x.command`; (d) `launchctl bootstrap gui/$UID`; (e) `osascript keystroke`; (f) TIOCSTI on the inherited tty; (g) `at`/`cron`-style scheduling; (h) loopback connect to a helper that answers prompts** | (b)–(h) fail under sandbox (prompt unanswered; audit shows no `user-tui` entry; no outside write); **each succeeds with sandbox disabled** (control; (e) requires Automation permission on the CI host) | real hooks + tmux + real sandbox |
| 23b ★ | verifier: forged log, inherited env, **(c) overwrite packet/`.released`/content store/ledger from a test, (d) read `<sessionDir>`, `~/.pi`, another attempt's tree, (e) outbound network incl. loopback listener and unix listener, (f) ledger forgery from a compromised verifier process (test double sends a fake `verify` reply/ledger claim)** | ledger unaffected (coordinator-owned); (c)/(d)/(e) EPERM/ECONNREFUSED; (f) impossible — verifier has no ledger write path, payload claim not in ledger ⇒ INVALID; **(c)/(d)/(e) succeed with sandbox disabled** (control) | real git + real sandbox |
| 31–37, 39–44 | as v1.2 | as v1.2 | as v1.2 |
| 38 ★ | Anthropic coordinator starts a shell writer, switches to OpenAI; deltas land across three snapshot boundaries while an unrelated Grok author is live in another root | every delta in the shell's write roots attributes `{anthropic, openai(if a coordinator write-capable call overlapped), grok(if the author's root)}` ∪ authority families; authority families present in **all** three windows regardless of the author | real hooks |
| 45 ★ | author writes outside cwd via absolute path; shell computes destination dynamically (`cp x $(cat dest)`); **`write` to `<root>/.git/config`; `write` via a symlink inside the root pointing at `<sessionDir>/workers.json`; parent-directory symlink swapped between validation and open** | `write` refused (G12/A16); shell write EPERM + audit; symlink cases refused `symlink-in-path`; swap race refused by `openat` walk; **shell write succeeds with sandbox disabled** (control) | real worker hooks + sandbox |
| 46 ★ | sandbox unavailable (PATH without `sandbox-exec`; addon missing; a self-test control failing; a positive probe failing) under gating `on` | `verify_exec` `ERROR{no-sandbox}`; coordinator `bash` refused; shell-bearing launch refused; snapshot refused; `/pairing` shows the exact failing probe | real hooks |
| 47 ★ | author writes `.git/config` with `core.fsmonitor`, `diff.external`, `filter.x.process`, `credential.helper`; then snapshot, trigger evaluation, materialisation and `git_ro` run | zero child processes other than git and its exec-path helpers; no tmux/socket reach; snapshot result correct or `git-config-interference` audited; **with sandbox disabled + hardened set removed, the fsmonitor payload executes** (control) | real git + real sandbox |
| 48 ★ | repository and materialised tree containing `.pi/extensions/evil.ts`, `.pi/skills/*`, `.pi/settings.json` that would write a canary and send-keys | nothing executes in author, verifier or reviewer worker processes; launch argv contains `--no-approve` and no `-a`; **with the pin removed and `-a` added, the canary appears** (control) | real worker launch |
| 49 ★ | coordinator/author `write`/`edit` targets: `<sessionDir>/workers.json`, policy files, profile copies, the receipt socket, `~/.pi/agent/agents/*.md`, extension source, `process.execPath` — directly and via a registered root that is `$HOME` | all refused (A16) before any open; audited | real hooks |
| 50 ★ | root = `$HOME`; root containing a symlink alias to `~/.pi`; cache dir configured under `<sessionDir>`; path with newline/quote; sandboxed shell inherits a pre-opened fd to `workers.json` (test injects) | root registration refused; alias refused; config invalid; unsafe-path refusal; child sees no fd ≥ 3 (`CLOEXEC_DEFAULT`), write to `<sessionDir>/workers.json` EPERM | real hooks + sandbox |
| 51 ★ | self-test soundness: remove the loopback listener; make `procArgs` probe unavailable; make the canary unreadable | each yields `control:'setup-failed'` and `available=false` — never a false `blocked` | real sandbox |
| 52 ★ | peer identity: worker forks a child that sends a message; worker exits and the child inherits the descriptor; pid reuse simulated by fake `ProcAdapter`; pane killed and recreated with the same pid; second Pi in the same pane | all rejected with the named reason; registered worker unaffected | real socket + fake `ProcAdapter` for reuse |
| 53 ★ | verification tree access: `verify_exec` reads test files, dependencies and directory listings in `dir`, writes build output in `dir`, runs `node`/`git --version`; attempts to read/write a sibling attempt's tree and `verifyBase` itself | own-tree operations succeed; siblings EPERM; **siblings succeed with sandbox disabled** (control) | real sandbox |
| 54 ★ | planner/researcher worker writes its assigned artifact; then `<sessionDir>/artifacts/<req>/other.md`, `<sessionDir>/workers.json`, and a repo path | assigned path written; all others refused (A16/G12) | real worker hooks |
| 55 ★ | receipt socket under a 120-char session directory; `$TMPDIR` unset | binds at `pi-rs-<uid>` under the resolved temp dir; path < 100 bytes; gating `on` unaffected | real socket |
| 56 ★ | local helper execution: sandboxed shell tries `open -a Terminal`, XPC to `launchservicesd`, `mach-lookup` of `com.apple.lsd.*`, connect to a loopback service that spawns processes, `sandbox-exec` re-entry, `posix_spawn` with `POSIX_SPAWN_SETEXEC` of a binary outside the exec allowlist | all denied; no process appears outside the sandboxed group (asserted by process listing from the harness); **each succeeds with sandbox disabled** (control) | real sandbox |

Target: ≈ +340 unit, 12 traces, 11 property, 14 integration, 56 adversarial on top of 195.

## 15. PR list (ordered; all manually orchestrated per A2) **[v1.3 CHANGED — PR-2, PR-3; PR-1 note]**

| PR | Content | Acceptance criteria |
|---|---|---|
| PR-1 foundations | `types`, `family`, `roles`, `policy` (+profile copies), `registry` v2 (file-digest authority), `adapter` (+Sandbox/Socket/Proc adapters), `artifact` (+`changeKind`), `store`, `worktree` (blob materialisation), `contrib` (coordinator events, taint families). ★ Git calls routed through a `hardenedGit` shim whose sandbox hook is a no-op until PR-3; `verifyBase` location per §8.3 | 195 pass; unit suites incl. real-git fixtures for deletion/symlink/newline/submodule/process-filter/encoding; migration validator-clean; v2-unreadable-by-v1 stated |
| PR-2 protocol + tools ★ | `verdict-schema`, `subagent-done`, `git_ro` (no `blame`, integrity check hook), `verify_exec` **coordinator-side handler + ledger + discovery** (spawn refuses until PR-3), verifier-side thin client (socket transport stub), worker-side model gate + `write`/`edit`/read interception via `protected.ts` (A16, planner/researcher assigned-path capability, verifier read bound), profile updates (planner/researcher without `bash`), `lifecycle` pinned argv (A15) | schema tests; #21/#21b; worker gate test with mock provider (0 requests); ledger outside tree; discovery precedence tests; #48; #49; #54 |
| **PR-3 sandbox + receipts (Q7)** ★ | `sandbox.ts` (deny-default profiles for five kinds, canonicalisation/overlap/escaping, self-test with controls and positive probes, `spawnConfined`), `native/pi-review.c` (`peerPid`, `procInfo`, `procArgs`, `spawnConfined`, `openAtNoFollow`, `openDirNoFollow`, `tiocsti`; prebuilt + source), `receipt-socket.ts` (short path, process-instance identity, registration, bidirectional `verify`), `bash-guard.ts` (coordinator + author; shell authorities; pg kill), `completion.mjs` socket transport + `shell` receipts, `hardenedGit` sandbox hook enabled, `verify_exec` sandboxed spawn enabled, G0/G1/G5/G8/G12 sandbox and identity checks, `/pairing` sandbox rendering, P16, docs of A5/A10/A15/A16 residuals verbatim | self-test passes on the build machine with every control `ok` and every positive probe `ok`; adversarial #15(a–g), #18(b–h), #23b(c–f), #45, #46, #47, #50, #51, #52, #53, #55, #56 with **controls**; addon-missing fail-closed test; no-tty/no-inherited-fd unit tests; socket-length unit test; contract residual text present |
| PR-4 engine (shadow) | `triggers` (request-wide, truncation), `egress` (intersection), `health` (+A15 version check), `resolver` (minQ), `admission`, `machine` (total + evidence rules + budget gate + refund ★ incl. §5.1 refund rule and verify-action derivation), `packet` (+`verifyIntact`), `orchestrator`, `gates`, `review_start`, `diagnose`; `defaultGating:'shadow'` | unit + traces (★ T1 extended, T9–T12) + property; integration plan/code/REVISE/multi-root/plan-edited-by-coordinator; #31–#37, #42 |
| PR-5 human controls + recovery | `pairing` P1–P16, `audit`, `recovery` (barrier, ★ workerProc liveness, authority close), `agent_end` banner/labels incl. ABANDONED, lifecycle (A4), session-digest lines; ★ `contrib` rule 3 (shell authorities) | pairing tests; restart integration incl. #43; #36, #38 (extended), #41, #44 |
| PR-6 adversarial qualification | complete `test/adversarial/*` (#1–#56), docs (`ORCHESTRATION-CONTRACT.md` rev 2026-09-08a incl. A1–A16 and residuals verbatim; `AGENTS.md` note) | every adversarial test yields its stated outcome in its stated env; controls verified |
| PR-7 live trial + gates on | throwaway repos (two roots) across five families and every trigger, sandbox refusal path, abandoned request, re-waive, budget stop, tamper, ★ real `npm test` verification under sandbox, ★ `.pi/` in repo; then `defaultGating:'on'` for fresh sessions | `requireHealthProbe:false` warning visible; artifacts: exit codes, `/subagents-diagnose` transcript, `/pairing` sandbox self-test output (all probes `ok`/`blocked`); rollout rule as v1.1 (persisted `gating` kept; `legacy`/`shadow` unchanged until P14) |

Per Q8: PR-1, PR-2 (non-sandbox parts), PR-4, PR-5, PR-6 (minus gating `on`) are approved for build; PR-3 and the ★ items in PR-2/PR-4/PR-5 that this v1.3 introduces (A15/A16 interception, refund rule, verify-action derivation, shell authorities) are subject to round 5.

## 16. Risks **[v1.3 CHANGED]**

| Risk | Mitigation / statement |
|---|---|
| `sandbox-exec` is deprecated by Apple; profile semantics undocumented | deny-default profile; runtime self-test with controls and positive probes is the authority; any leak/setup failure ⇒ fail closed; Linux is O8 |
| Deny-default breaks legitimate tooling (mach services, sysctls, loopback dev servers) | positive probes catch broad breakage at G0; per-tool EPERM/denial audited with the denied operation so the user can extend digested allowlists (`sandbox.unixSockets`, `allowLoopback`, `cacheDirs`, `coverageRoots`, `env`); P16 after repeated hits |
| Self-test control (i) needs Automation permission | one-time TCC grant to the terminal app; P16 explains; without it gating `on` stays refused (stated friction) |
| Sandboxed author `bash` breaks tooling that writes outside caches | `sandbox.cacheDirs` (digested); EPERM audited with path |
| `cacheDirs` (`~/.npm`, `~/.cache`) are a user-level supply-chain write path for later unsandboxed package-manager runs | stated; users may narrow `cacheDirs`; not prevented |
| No `.git` in verification tree | commands needing git metadata FAIL/ERROR; stated; `verifyCommands` override available |
| Harness git still reads `.git/config` | dangerous keys overridden; residual execs blocked by `harness-git` exec allowlist; availability-only interference audited |
| Writes outside registered/coverage roots are uncovered | cannot occur through harness-spawned processes; human/out-of-band edits are covered only in registered roots (stated) |
| Test self-forgery of exit status | residual, verbatim in contract (A5) |
| Worker Pi process unsandboxed | `--no-approve` pin (A15) removes repo code execution; tool lists bounded and digested; protected set on every tool; no shell outside the guard; stated |
| Native addon build burden (≈200 lines C) | prebuilt binary checked in with source; load failure fails closed; G0 validates `LOCAL_PEERPID` semantics on the running macOS |
| Verification trees under `$TMPDIR` may be cleaned by the OS | removed at attempt end anyway; pre-run manifest check catches loss ⇒ `INVALID{materialisation-mismatch}`, retried once |
| Snapshot cost, probe updater, invocation budget, `external` review cost, read-based exfiltration, policy/tamper/recovery holds, machine divergence, regex overhead | as v1.1 |
| Request-wide T1 makes small edits in one root require review because of another root | by design (spec §7 per-request aggregation) |
| Budget hold stalls artifact | P15 one prompt |

## 17. Open spec issues (plan default in brackets) **[v1.3 CHANGED — O8, O9, O10 added]**

- **O1**–**O6** as v1.1.
- **O7** Prompt injection into seats via repo content. [Reviewer profile reports; not prevented; stated.]
- **O8** Non-macOS sandbox (bwrap/landlock, `SO_PEERCRED`). [Not built; gating `on` refuses shells and snapshots on non-macOS; shadow permitted.]
- **O9** Whether author-worker sandbox should allow network by default. [Yes, non-loopback only; `sandbox.authorNetwork` and `sandbox.allowLoopback` config, digested.]
- **O10** Whether the self-test Automation probe (i) should be mandatory. [Yes; profile denies `appleevent-send` by construction but the self-test is the authority; friction stated in §16.]

## 18. Disposition of round-2 findings [unchanged]

Unchanged from plan v1.1 §18 except the items re-opened by round 3, which are redisposed in §19.

## 19. Disposition of round-3 findings [unchanged from v1.2]

| Reviewer | # | Disposition | Section changed |
|---|---|---|---|
| Fable | 1 (accepted in full, Q7) | `sandbox.ts` profiles for `verify_exec` and coordinator `bash`; unavailable ⇒ `ERROR{no-sandbox}` / bash refused; receipts over unix socket with peer verification; #15/#18/#23b variants with controls; residuals verbatim in A5/A10; own module + PR-3; extended to author-worker `bash` (Astra #6) | §0, §1 A1/A5/A10, §2, §8.4, §8.5, §6 G0/G1/G8/G12, §13, §14, §15 PR-3 |
| Fable | 2 | `bash` handling explicit (taint + cwd root only; sandbox confines other writes); `coverageRoots` digested; uncovered writes stated; `packetDigest` verified at every `git_ro` call and verdict intake → `PACKET_TAMPERED`; #31 | §1 A11, §4.3, §6 G8, §8.1, §14 #31, §16 |
| Fable | 3 / Astra 1 | any binding change during QUEUED/REVIEWING cancels the quorum, refunds the round, re-resolves with `sameSeats`; per-kind handling; waiver never replays; #37 | §1 A3, §4.3, §5.2, §12 P5, §14 |
| Fable | 4 / Astra 5 | auto-close only when every artifact cleared; explicit close of uncleared → `abandoned`; opening content id = last cleared; #36 | §1 A4, §3.1, §5.8, §6 G7, §12 P14, §14 |
| Fable | 5 / Astra 4 | budget gate at quorum launch, refund on cancel, `Stop` → `hold='budget'`; #35; property invariant | §0, §1 A13, §5.1, §5.2, §12 P1/P15, §14 |
| Fable | minor | `review_start` refused under `recovery` hold; advisory reviewers class `author`; `materialise` hold dropped; coordinator-written plan has no standing; `blame` dropped; NOT_REQUIRED recomputes on provenance change | §2, §4.2, §5.2, §5.3, §8.2, §10 |
| Astra | 2 | state-independent evidence recording and settlement; traces T1–T8 | §5.1, §5.2, §14 |
| Astra | 3 | `minQuorum` from kind; #34 | §1 A12, §3.1, §7, §14 |
| Astra | 6 | worker-side `write`/`edit` interception (G12); author and coordinator `bash` sandboxed; #45 | §1 A11, §6 G12, §8.4, §14 |
| Astra | 7 | `coordinatorShellTaint`; `coordinatorEvents`; #38 | §3.1, §4.3, §14 |
| Astra | 8 | worker-local synchronous model gate; G5 for verifiers; #39 | §1 A8, §2, §6 G5, §14 |
| Astra | 9 | blob materialisation; #40 | §0, §2, §8.3, §14 |
| Astra | 10 | receipt boundary via sandbox + peer socket; env stripping demoted; residual narrowed; #15/#23b controls | §1 A5/A10, §8.3–§8.5, §14 |
| Astra | 11 | truncation ⇒ required; #33 | §11, §14 |
| Astra | 12 | request-wide T1; #32 | §1 A11, §3.1, §11, §14 |
| Astra | 13 | accepted profile copies; NOT_REQUIRED promotion; packet egress intersection; #41 | §1 A14, §2, §5.2, §6 G1/G9, §7, §8.1, §14 |
| Astra | 14 | `queued` not counted live; admission once; repair cannot take reserve; #42 | §0, §3.1, §10, §14 |
| Astra | 15 | recovery launch barrier; #43 | §5.3, §12 P9, §14 |
| Astra | 16 | body carries only `revision`; in-memory digest; #44 | §1 A9, §3.1, §3.4, §14 |

## 20. Disposition of round-4 findings **[v1.3 NEW]**

| Reviewer | # | Finding | Disposition in v1.3 | Sections |
|---|---|---|---|---|
| Fable | 1 | allow-default leaks via launchd/LaunchServices/Apple events/TIOCSTI | Profiles switched to `(deny default)` with explicit allow sets; explicit denies for `lsopen`, `appleevent-send`, launchservicesd/lsd/launchd/tccd/iohid mach names, tty `file-ioctl`; `posix_spawn` with `SETSID` (no controlling tty); self-test probes (g)–(l) with controls; #18(c)–(h), #56 | §1 A10, §8.4, §14 |
| Fable | 2 | rule order inverted for overlapping roots | Protected denies emitted last; every path canonicalised; roots/cache dirs overlapping the protected set refused at registration/config; `write/edit` targets under protected paths refused regardless of root; precedence not relied upon — every protected path has a deny probe; #49, #50 | §1 A11/A16, §4.3, §6 G8/G12, §8.4, §14 |
| Fable | 3 | harness-side git unsandboxed and honours repo config | `hardenedGit`: `git_ro` hardened `-c` set + stripped env for every harness git call, run under `harness-git` sandbox (write set `<root>/.git` + temp index; process-exec = git binary + exec-path only; no network); sandbox unavailable ⇒ snapshot/trigger/materialise refused under gating `on`; residual (config can still break operations — availability only) stated; #47 | §4.1, §8.2, §8.4, §13, §16, §14 |
| Fable | 4 | worker Pi trusts cwd; ledger lives in verifier process | Decided fact (Q8): Pi loads `.pi/` only with `-a`; dispatcher pins `--no-approve`, never `-a`, argv digested, Pi version flag semantics verified (A15); `verify_exec` executes coordinator-side (verifier forwards `{cmd}` over the socket; coordinator spawns, owns and persists the ledger) so A5's residual holds against a compromised verifier process; #48, #23b(f) | §0, §1 A5/A15, §2, §6 G1, §8.3, §8.5, §14 |
| Fable | 5 | socket path exceeds `sun_path` | Socket at `$TMPDIR/pi-rs-<uid>/<8-char>.sock` (dir 0700, sock 0600), length asserted < 100 bytes, recorded in `ReviewState.receiptSock`, denied in all profiles, used by self-test (d); #55 | §3.1, §8.5, §14 |
| Fable | minor | ancestor exit false rejection; materialised symlinks followed by verifier tools; `cacheDirs` supply-chain path | Ancestry walk retried once after 50 ms; verifier read tools bounded to canonical paths inside its tree (G12) and `verify` sandbox denies reads outside `dir`; `cacheDirs` risk stated in §16 | §6 G12, §8.3, §8.5, §16 |
| Astra | 1 | v1.2 not standalone; v1.1 text and original findings absent | **Within Q8 scope applied:** §8.3 fully inlined (discovery precedence, ledger, result derivation, locations) and §8.4/§8.5 self-contained; PR-3 acceptance lists every test by number. **Outside scope (Q8-approved sections) not re-inlined**; the round-5 review packet must carry plan v1.1, plan v1.2 and the round-3/round-4 findings as immutable references (packet requirement, recorded here) | §8.3–§8.5, §15, §20 |
| Astra | 2 | sandbox denies its own verification tree | Verification tree, private tmp and home moved to `<verifyBase>` under `$TMPDIR` (outside `~/.pi` and the session dir); explicit `file-read*`+`file-write*` exception for the own tree after the protected denies; sibling trees denied; positive probes prove a real command runs; #53 and the full-round-trip integration test | §1 A5, §3.1, §8.3, §8.4, §14 |
| Astra | 3 | allow-default is not a process boundary (Mach/XPC brokers, local execution services) | Deny-default with enumerated `mach-lookup` allowlist; network for coordinator/author restricted to non-loopback IP + DNS resolver, unix sockets denied except digested allowlist; `verify`/`harness-git` no network; controls for launch-service and local-helper execution (#18(c)–(h), #56) asserting no outside write and no `user-tui` action | §1 A10, §8.4, §14 |
| Astra | 4 | precedence, canonicalisation, escaping, inherited descriptors, harness executables unspecified | A16 protected set incl. Pi install dir, extension root, node binary, addon, profile copies; `realpath` everywhere; overlap refusal; SBPL literal escaping with unsafe-path refusal; `POSIX_SPAWN_CLOEXEC_DEFAULT` + explicit stdio (no inherited fds); self-test proves every deny and every allow rather than relying on rule order; #50 | §1 A10/A16, §8.4, §14 |
| Astra | 5 | self-test can certify a non-working probe | Harness-owned canaries (readable secret, writable dir, live loopback TCP and unix listeners, real sockets, `.command`/plist token writers, pty, `procArgs` probe); every probe run unsandboxed first — control failure ⇒ `setup-failed` ⇒ `available=false`; positive probes per kind; results persisted per probe as `{control, sandboxed}`; #51 | §3.1, §8.4, §12 P2/P16, §14 |
| Astra | 6 | PID-reuse/descriptor-inheritance races; pane tree authenticates a subtree, not the producer | Peer identity = process instance (pid + `proc_pidinfo` start time); ancestry verified only at registration (startup receipt, pane pid + pane start time, consistent start times per hop); every later message must come from exactly the registered `workerProc` instance, re-checked alive at application time; `LOCAL_PEERPID` validated at G0; `SO_PEERCRED` moved to O8; #52, #15(f) | §3.1, §6 G5, §8.5, §14 |
| Astra | 7 | non-shell tools bypass; git-root check is not a boundary; symlink swaps | A16 applied to every write-capable tool (coordinator and worker `write`/`edit`, guards, `verify_exec`, harness git) regardless of root; race-resistant `openat` walk with `O_NOFOLLOW` in the native addon; G0 enumerates coordinator custom tools and refuses gating `on` for unbounded write-capable tools; G1 refuses any worker tool outside the role list; #45 extended, #49 | §1 A16, §2 `protected.ts`, §6 G0/G1/G8/G12, §14 |
| Astra | 8 | G12 blocks planner/researcher output | Role capability: planner/researcher may write exactly the harness-precreated assigned path (canonical equality, `O_NOFOLLOW`); all sibling/session paths refused; planner/researcher profiles drop `bash`; #54 + integration test | §2, §4.2, §6 G1/G12, §14 |
| Astra | 9 (minimal) | early verification evidence stored but not acted on | State-independent **verification action derivation**: after every event the reducer derives an idempotent effect (FAIL→REPAIR deferred until settlement/author completion; ERROR/INVALID→ladder; NO_COMMANDS→P12) keyed by verification id, persisted as `pendingVerifyAction`; settlement row re-derives and emits; T1 extended to FAIL/ERROR/INVALID/NO_COMMANDS; property "every recorded result yields exactly one action" | §5.1, §5.2 (2 rows), §13, §14 |
| Astra | 10 (minimal) | refunds can debit rounds never charged | Refund rule: cancel only an existing, charged, unsettled quorum, exactly once (`refunded` flag); `USER_WAIVE` and unattributed writes from DRAFT/REVISE/BLOCKED cancel and refund nothing; reducer asserts `round ≥ 0`; T9–T12; property `Σ refunds ≤ Σ charges` | §3.1, §5.1, §5.2 (2 rows), §14 |
| Astra | 11 (minimal) | background-writer attribution contradicts #38 | Shell authorities: every coordinator/author `bash` call opens a persisted authority (families fixed at call time, write roots) that closes when the guard has killed the process group; rule 3 unions authority families into every delta of overlapping roots in overlapping windows **unconditionally**, before the empty-set rules; authorities open at restart closed at recovery and attributed to the next delta; taint retained as fallback; #38 rewritten with three boundaries and an unrelated concurrent author | §3.1, §4.3, §6 G8/G12, §13, §14 |
| — | Q8 decided facts | `--no-approve` pin, no `-a`; #48 | §0, §1 A15, §14 |

Round-5 packet requirement (from Astra 1): supply plan v1.1, v1.2, v1.3, the round-3 and round-4 findings, spec v0.3 + decisions, as immutable references.

repo: pi-interactive-subagents (target, uninspected; cwd `/private/tmp`) · session UUID: not exposed in this context (not fabricated) · model: Claude Opus
