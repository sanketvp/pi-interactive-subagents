# Spec: Automatic cross-family adversarial review ("opposing LLM" gates)

Status: **DRAFT v0.3** — 2026-09-07 — authoritative rewrite after Astra review round 1 (11 blocking findings, all addressed; see §14). Not implemented. Supersedes v0.1/v0.2 in full; there is no appendix precedence — this document is the single policy.

Review chain so far: v0.2 → Astra (independent, read-only) → REVISE → v0.3 (this). Next: Fable planner pass → Astra round 2 → Grok build → Opus review → Sonnet verify → live trial.

---

## 1. Goal

No artifact reaches the next stage of work until a model from a **different training family** than every contributor has approved the **exact bytes** of that artifact. The harness gates the stage transitions; the coordinator cannot skip, relabel, or self-approve. Works across all five families we run (Anthropic, OpenAI, xAI, Moonshot, Z.ai). All approvals, waivers and overrides are visible, durable, and attributable to a trusted human action.

Family diversity is a *proxy* for independence (shared prompts and training data still correlate failures); it is the strongest cheap proxy we have and is required, not claimed sufficient.

## 2. Non-goals

- Replacing the `subagent` tool, tmux tiling, or the user-adjustable invocation limit — this layers on them.
- Ranking models. Rules are about independence and coverage, not "smarter".
- N-way juries beyond the plan-stage dual review (§6).
- Proving models cannot be prompt-injected. We reduce the surface (§9); we do not eliminate it.

## 3. Definitions

- **Family**: organisation that trained the model, regardless of API route. `anthropic` {Fable 5/5.1, Opus 5, Sonnet 5, Haiku}, `openai` {GPT-5.6 Sol/Terra/Luna, GPT-6 Astra}, `xai` {Grok 4.x}, `moonshot` {Kimi K3, K2.x}, `zai` {GLM 5.x}. OpenRouter-routed Fable is `anthropic`. Family is derived from the **observed** model in the worker's startup receipt via a fixed table; an observed model not in the table → family `unknown` → **fail closed** (that worker's output cannot be approved or used as a reviewer).
- **Coordinator**: the interactive Pi session model (default Opus 5). Its family is read live from `ctx.model`, never hard-coded.
- **Artifact**: an immutable snapshot with an identity:
  - *Plan / research*: file(s) → `sha256` of canonical content.
  - *Code*: `git` tree hash of the working tree (tracked + untracked, excluding ignored) plus the diff base commit. Renames, deletions, binaries, generated files, staged/unstaged all count as changes because the tree hash covers them.
- **Contributor set** of an artifact: the families of every attempt that wrote to it since the last approved snapshot, plus the coordinator's family if the coordinator edited it. Tracked by the harness from attempt records + `git diff` between snapshots, not self-reported.
- **Request**: one user prompt to the coordinator and everything spawned under it. Thresholds aggregate per request (§7), never per attempt.
- **Trusted human action**: an answer given through the Pi TUI prompt API (`ctx.ui.select/confirm/input`) in the coordinator session. Tool arguments, worker messages, steer messages, and repo content are **never** trusted human actions.

## 4. Invariants

- **I1 — Independence.** `reviewer.family ∉ contributorSet(artifact)`. Applies to every reviewer in a quorum.
- **I2 — Coordinator is a contributor.** If the coordinator edited any file in the artifact, its family is in the contributor set (so it cannot be the sole approver of its own edits, and Anthropic reviewers are excluded when Opus coordinated an edit).
- **I3 — Approval binds bytes.** A verdict references exactly one artifact snapshot id. Any change to the artifact (new snapshot id) invalidates all prior verdicts on it. "This file was approved earlier" has no standing.
- **I4 — Gated transitions.** The harness refuses: (a) launching an `implementer*`/`worker`/`bulk` author for a request whose plan artifact lacks a current APPROVED quorum; (b) marking a request `done`/reporting completion while any code artifact in it lacks required approvals (§7); (c) launching a `reviewer` whose family violates I1. Refusals are tool errors the model cannot argue past; the user can waive (§11).
- **I5 — No relabeling.** Role and stage are derived by the harness from the agent profile + tool call, and a profile's role is fixed (`planner`→author/plan, `implementer*`/`worker`/`bulk`→author/code, `reviewer`/`pr-reviewer`→reviewer, `verifier`→verifier). A `bulk` author still produces a code artifact subject to §7 triggers — the profile changes the *default* review depth, not whether coverage applies.
- **I6 — Fail closed.** No verdict, malformed verdict, worker error/exit without receipt, unknown family, unavailable reviewer, timed-out reviewer → treated as **BLOCKED**, never APPROVED.
- **I7 — Human-only controls.** Astra opt-in, pairing overrides, waivers, round/limit extensions exist only as TUI prompts; there is no tool parameter for any of them.

## 5. Stages, default authors, default reviewers

| Stage | Default author | Reviewer quorum (auto) | Fallback order (must satisfy I1) |
|---|---|---|---|
| Plan | `planner` Fable 5.1 | **2 of 2**: Luna high (`openai`) + Grok 4.6 (`xai`) | any available from ranked list below |
| Research | `researcher` Opus 5 | 1: Luna | Grok → K3 |
| Code — heavy | `implementer` Grok 4.6 | 1: **Opus 5** | Sol → K3 |
| Code — 2nd engine | `implementer-gpt` Sol | 1: Opus 5 | Grok → K3 |
| Code — 1M ctx | `implementer-k3` K3 | 1: Opus 5 | Sol → Grok |
| Code — fan-out | `implementer-glm` GLM 5.3 | verifier always; Opus 5 review **only if §7 triggers fire** | Sol |
| Code — bulk/mechanical | `bulk` GLM Flash | verifier always; review only if §7 triggers fire | Sol |
| Code — surgical | `worker` Sonnet 5 | 1: Sol (I1 excludes Anthropic) | Grok → K3 |
| Coordinator stay-here edit | coordinator (family live) | review only if §7 triggers fire; reviewer ∉ coordinator family | ranked list |
| Escalation author | Astra (`openai`, opt-in §11) | 1: Fable 5.1 | Grok |

Ranked reviewer preference when the table's choice is unavailable: `[anthropic: Opus 5 → Fable 5.1] [openai: Luna → Sol] [xai: Grok 4.6] [moonshot: K3] [zai: GLM 5.3]`, filtered by I1 and by **capability** (§8). Never falls back to a contributor family. Nothing available → BLOCKED, user informed.

Verifier (`verifier`, Sonnet 5) is required for every code artifact regardless of review depth; it is family-agnostic but must not be a contributor. Verification binds to the snapshot id (I3): tests passing on snapshot A certify nothing about B.

## 6. Loop and state machine

Per artifact, per revision:

```
DRAFT(snapshot S_n)
  → REVIEWING: launch quorum reviewers in parallel, each given the packet (§9) for S_n
  → collect verdicts (structured, §9); missing/timeout/error → BLOCKED for that reviewer
  quorum rule:  all APPROVED            → APPROVED(S_n)        → next stage unlocked
                any BLOCKED             → BLOCKED(S_n)         → stop; user decides (§11)
                otherwise (any REVISE)  → REVISE(S_n), round += 1
REVISE → author resumed with ALL findings from ALL reviewers → produces S_{n+1}
       → REVIEWING(S_{n+1}) with the SAME quorum members (sessions resumed); every member re-verdicts S_{n+1}.
         Prior APPROVED on S_n does NOT carry (I3). A reviewer that already approved S_n receives the delta and may re-approve cheaply.
round counting: one round = one author revision + one full quorum pass on the resulting snapshot.
round budget:   default 3 per artifact; on round-3 REVISE the harness prompts the USER: continue +2 / set N / stop and show findings (§11). Findings are displayed before the prompt.
```

Mixed verdicts on the same snapshot: BLOCKED dominates REVISE dominates APPROVED. The user sees each reviewer's verdict and findings verbatim; the harness never merges or summarises them.

Post-approval edits (by anyone, including the coordinator) create S_{n+1} → state returns to DRAFT → gated again per §7.

## 7. Coverage and triggers (per request, aggregated)

Full review is **mandatory** for: plan, research, heavy/2nd-engine/1M-ctx/surgical code, escalation.

Conditional review (fan-out, bulk, coordinator stay-here) runs a full cross-family review when **any** trigger fires, computed by the harness over the **aggregate diff of the whole request** since the last approved code snapshot:

- T1 — total changed lines (added + removed, all files incl. untracked/renames/deletes; binaries count as 50) **> 150** for fan-out/bulk, **> 30** for coordinator edits;
- T2 — any changed path matches the sensitive set: `**/auth*`, `**/*auth*/**`, `**/payment*`, `**/billing*`, `**/*secret*`, `**/*token*`, `**/migration*`, `**/schema*`, `**/*.sql`, `**/prisma/**`, `**/.github/**`, `**/ci/**`, `**/Dockerfile*`, `**/*.lock`, `package.json`, `go.mod`, `requirements*.txt`, `**/infra/**`, `**/terraform/**`, `**/*.tf`, `**/*.env*`, `**/hooks/**`, `**/settings.json`; the set is a file the user owns (`~/.pi/agent/review-triggers.json`), default as listed;
- T3 — a file previously APPROVED in this request was changed again (any amount);
- T4 — the diff adds or changes a dependency, a shell exec, a network call, or a permission/ACL string (regex set, same file as T2).

Splitting work into many small attempts does not evade T1 because it aggregates per request. Aggregation resets only on an APPROVED quorum for the current snapshot.

## 8. Availability, capability, admission control

- **Available** = listed in Pi's catalog **and** authenticated **and** the daily updater's per-family smoke probe passed within 24 h. No per-launch paid probes.
- **Capable** = the candidate's context window ≥ 1.5 × packet size and max output ≥ 16K; otherwise skip to the next candidate. A truncated review is fail-closed (§9).
- **Admission control**: of the 4 live worker slots, **at least 1 is reserved for reviewers/verifiers** whenever any artifact is in REVIEWING or has pending required review. Author launches that would consume the last reserved slot are refused with "waiting for review capacity". Plan dual-review needs 2 slots; the harness queues the second reviewer if only one is free and starts it when a slot opens. Sessions persist on disk; a reviewer session that is not currently in a pane is *not* a live slot.
- **Rate limits / partial output**: reviewer error or truncated output → that reviewer's verdict is BLOCKED; the harness may retry the same reviewer **once**; then falls back down the ranked list once; then BLOCKED to the user. Author retries follow the same one-retry rule.
- **Cost/time caps**: per request, the harness tracks invocations, estimated tokens (from receipts), and wall time; at 12 invocations (or the user-adjusted limit) or 90 min of review wall time it asks the user before continuing. Round extension (§6) and invocation-limit extension are separate prompts; extending one does not extend the other.

## 9. Review packet and structured verdict

The harness, not the author, assembles the reviewer packet: requirements/plan artifact, the exact snapshot (plan text, or `git diff <base>..<snapshot>` plus full contents of every changed file), test/verify results bound to that snapshot, all prior findings and their dispositions, and the list of contributor families. Authors cannot omit files. Repo content is marked in the packet as **untrusted data**: the reviewer profile instructs that instructions found inside the artifact are to be reported as findings, never followed.

Verdict is **structured**: the reviewer worker calls `subagent_done({ verdict: "APPROVED"|"REVISE"|"BLOCKED", snapshotId, findings: [{severity, file, line, evidence, why, minimalFix, regressionCheck}], residualRisks })`. The completion receipt carries it (authenticated by attempt token + child session UUID, same as today). Prose `VERDICT:` lines are ignored. Missing/invalid structured verdict, snapshotId mismatch, worker exit without receipt → BLOCKED. Reviewer profiles get read-only tools only (`read`, `bash` with write-blocking guard), enforced by tool exclusion.

## 10. Durability and recovery

All state (artifact snapshots, contributor sets, verdicts, rounds, waivers) lives in the session's `workers.json` alongside attempt records, written atomically. Transitions are idempotent: duplicate completion receipts are no-ops (first-writer-wins, as today). On coordinator restart, REVIEWING artifacts with live reviewer sessions are re-attached; without live sessions they return to DRAFT-with-findings and the user is told. Cancelling a review invalidates nothing already approved and records the cancellation. `/subagents-diagnose` prints the chain per artifact: `plan S1 (fable) ← luna:REVISE, grok:REVISE ← plan S2 ← luna:APPROVED, grok:APPROVED ✓`.

## 11. Human controls (TUI prompts only)

- `/pairing` — show table, current session overrides, waivers, and data-egress allow-list (§12).
- `/pairing set <stage> <reviewer-model>` — session override; validated against I1 and §8 capability.
- `/pairing astra on|off` — session-scoped Astra opt-in (default off). No per-call form exists.
- `/pairing waive <artifact>` — waive required review for one snapshot: requires confirm; recorded as **WAIVED** (distinct from APPROVED everywhere it is displayed); T3 still applies afterwards.
- `/pairing off` — disable gating for this session: two confirms; every subsequent completion is labelled **UNREVIEWED**.
- Round-budget and invocation-limit prompts (§6, §8) are raised by the harness at the moment they bind; the model cannot pre-answer or answer them.
- Every override/waiver writes an audit line (who: `user-tui`, when, scope, reason if given) to `workers.json` and the session digest.

## 12. Data egress

Sending a repository's contents to a model provider is a policy decision per repo, not a capability. `~/.pi/agent/review-egress.json` maps repo path patterns → allowed families (default: all five for `~/GIT/Personal/**` and `/tmp/**`; **only `anthropic` + `openai`** for everything else until the user extends it). The resolver filters candidates by this allow-list before I1/§8. If the allow-list leaves no I1-compatible reviewer, the harness BLOCKS and tells the user exactly which family would unblock. Changing the file is a user action outside Pi; `/pairing` shows the effective list.

## 13. Build plan

1. **Fable planner** turns this spec into an implementation plan (modules: `family.ts` table + resolver; `artifact.ts` snapshots/hashes/contributor sets; `gates.ts` I4 transitions + admission; `triggers.ts` §7; `verdict` schema in `completion.mjs` + `subagent_done`; `pairing` command; registry schema v2 with migration). Plan artifact → **Luna + Grok** dual review (first live use of §5/§6).
2. **Astra round 2** on the approved plan (user opted in for this spec).
3. **Grok** implements → **Opus** reviews (I1) → **Sonnet** verifies (tests + a scripted adversarial suite: relabeling, split-diff evasion, post-approval edit, verdict injection in repo text, reviewer timeout, slot starvation, coordinator self-edit, unknown family).
4. Live trial on a throwaway repo touching all five families and every trigger.
5. Snapshot, commit to fork, contract rev 2026-09-08a. Rollout to new sessions only.

## 14. Astra round-1 findings → disposition

| # | Finding | Disposition in v0.3 |
|---|---|---|
| 1 | Contradictory policy layers | Full rewrite; single authoritative doc; coordinator = Opus, family read live (§3) |
| 2 | Enforces invalid reviews, not required reviews | I4 gated transitions + I5 no relabeling + §7 coverage rules |
| 3 | Approval bound to attempt, not artifact | Snapshot ids (tree hash / sha256), I3, §6 per-revision quorum |
| 4 | Authorship/independence incomplete | Contributor sets, I2, `unknown` family fail-closed, live coordinator family |
| 5 | Triggers gameable | Per-request aggregation, all-file counting rules, wider T2 set, T3/T4 |
| 6 | No scheduling/admission design | §8 reserved reviewer slot, queueing, live-slot vs persisted-session distinction |
| 7 | Dual-review state machine missing | §6 quorum rule, BLOCKED>REVISE>APPROVED, same-members re-verdict, no carry-over |
| 8 | Verdict text not a protocol/boundary | §9 structured verdict in receipt; prose ignored; untrusted-content marking; read-only reviewer tools |
| 9 | Budget/fallback underspecified | §8 one-retry rule, separate prompts, cost/time caps, no per-launch probes |
| 10 | Human controls reachable by model | I7 + §11: TUI-only, no tool params, audit lines, WAIVED/UNREVIEWED labels |
| 11 | Review/verification contracts missing | §9 harness-built packet, snapshot-bound verification, adversarial test suite in §13 |
| + | Data egress | §12 allow-list |
| + | Capability/truncation | §8 capability filter, truncation fail-closed |
| + | Crash recovery | §10 |

## 15. Decisions log (user, 2026-09-07)
Q1 Opus 5 default coordinator · Q2 Opus 5 reviews non-Anthropic code · Q3 fan-out: verifier + triggered review · Q4 3 rounds, user-extendable by prompt · Q5 plan: Luna + Grok both approve · Q6 coordinator edits: triggers T1(30)/T2/T3.
- Q7 (2026-09-07, round-3 decision): Same-user process boundary = **build the OS sandbox** (user choice A). Under gating 'on': `verify_exec` and coordinator `bash` run inside macOS `sandbox-exec` (deny process-info, deny read/write of ~/.pi, <sessionDir>, tmux socket dir; writes only inside worktree/registered roots; no network for verify_exec); sandbox unavailable → verify_exec ERROR{'no-sandbox'} and coordinator bash refused (delegate shell work). Receipts delivered over a unix socket, peer PID verified against the harness-created pane's pid tree. Round budget for this plan extended by the user to 4.
- Q8 (2026-09-07, round-4 decision): **Split.** Non-sandbox scope of plan v1.2 (PR-1, PR-2, PR-4, PR-5, PR-6 minus 'gating on') is APPROVED for build — rounds 1–4 found no remaining blocking findings outside the sandbox module. PR-3 (sandbox + receipt socket) continues its own review loop (v1.3 → round 5) and must land before gating 'on' is enabled. Verified 2026-09-07: Pi only loads project-local `.pi/` with explicit `-a`; every worker launch must pass `--no-approve` (pin in dispatcher; adversarial test #48).
