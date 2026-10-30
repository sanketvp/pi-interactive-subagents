# Issue #15 — run-scoped artifact identity

**Problem.** Two workers told to write the same file silently overwrite each other. The D23 task-text convention (`<name>.<profile>.<attemptId>.md`) is still the default, but it was never enforced: bash-only profiles (`agents/reviewer.md:4`, `scout.md:4`, `worker.md:4` for bash) never go through `write`/`edit`.

**Mechanism.** Optional `artifactPath` on `subagent`. After `attemptId` is known and *before* session seeding or registry writes, `launchSubagentImpl` awaits `reserveArtifactPath`, which canonicalizes the path and creates `<artifactDir>/reservations/<sha256(canonical)>.json` with `fsp.writeFile(..., { flag: "wx", mode: 0o600 })` — the same exclusive-create primitive as `completion.mjs` `writeAtomic`. EEXIST refuses the spawn with a message naming the path, owning attempt, and an attempt-suffixed alternative (`plan.md` → `plan.<attemptId>.md`). No pane, no registry row. Successful reservations are never auto-released (interrupt ≠ kill; the worker may still write). Markers live under the parent-session artifact dir.

**Canonicalization.** `path.resolve(cwd, p)`, then `realpath` of the deepest existing ancestor plus remaining segments. Relative vs absolute, `dir/../x`, and a symlinked directory hash identically. Empty/NUL, `.`, existing directories, and non-regular files (`/dev/null`) throw *before* any marker.

**Failure-path release (fail-closed).** A post-reservation throw in `launchSubagentImpl` unlinks the marker only if no split/pane attempt has started (`invokeSplit` not yet called). After a split attempt the marker stays: a worker pane may exist and may be writing.

**Secondary guard.** When `PI_SUBAGENT_ARTIFACT_PATH` and `PI_SUBAGENT_RESERVATIONS_DIR` are set, `subagent-done.ts` blocks `write`/`edit` of a path reserved by another attempt. Inactive without `PI_SUBAGENT_ID`. Defence in depth only; bash can still write elsewhere — but it was never *handed* a colliding path.

**D23 → optional parameter.** D23 refused an API field so the tool would not imply enforcement that did not exist. #15 adds real launch-time enforcement, so `artifactPath` now *means* something. Omit it: no reservation, no guard, no env, text convention unchanged. `subagent_resume` has no param; a resumed session keeps its original env/reservation.

**Weakest points.** (1) Opt-in — omitting `artifactPath` is today's convention with no enforcement. (2) Per parent-session dir; two parent sessions can still target one path (out of scope; the issue is run-scoped). (3) A bash worker that ignores its assigned path and writes elsewhere is not stoppable. (4) Marker dir is local disk; NFS `O_EXCL` caveats as for `writeAtomic`. Windows is out of scope. A path whose ancestor is symlinked *after* reservation is accepted.

**Rollback.** Revert the `index.ts` / `subagent-done.ts` hunks, restore `routing.test.ts:334-336`, delete `artifact-claim.ts`, its test, and this note. Stale `reservations/` dirs are inert JSON.
