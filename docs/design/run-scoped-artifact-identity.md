# Run-scoped artifact identity

Two attempts given the same path must not silently overwrite each other.

## Choice: claim original, suffix the loser

A per-session ledger binds each canonical path to exactly one `attemptId`. The
winner writes the requested path. A different attempt is redirected to
`<stem>.<attemptId><ext>` so both outputs survive. Refusal is reserved for the
D23 case below — dropping work is worse than a discoverable sibling file when
the coordinator forgot a unique name (`notes.md`).

## Concurrency

Claims live at `<artifactDir>/artifact-identity/claims/<sha256(canonical)>.json`.
The winner writes a complete tempfile then `linkSync`s it onto the claim path
(hardlink create is atomic; `EEXIST` means we lost). Fallback is
`writeFileSync(..., { flag: "wx" })`. No existence-check-then-write. Record
body `{ attemptId, path, claimedAt }` is enough for a later reader to name the
owner. Same `attemptId` seeing its own claim is an idempotent re-write, not a
conflict.

## D23

`<name>.<profile>.<attemptId>.md` already carries this attempt’s id, so
`resolveArtifactWrite` returns that path unchanged (`scoped: false`) — never
`name.profile.id.id.md`. If a *different* attempt already owns that D23 path,
the call is refused with `reason: "owned"` and the owner id (do not
double-suffix; do not forge another attempt’s identity).

## Wiring

`prepareArtifactWrite` is the choke point used for the extension’s own task
handoff and sysprompt files in `index.ts` (the writes around the former
1400–1440 region). Intercepting every worker `write`/`edit` tool would be a
Pi-core change; coordinators must still assign unique D23 paths in task text.
Tool help is unchanged because that convention remains true.

## Failure modes

- Crash between exclusive create and a readable JSON: readers spin briefly,
  then throw (fail closed). Re-claim by the same attempt still works if the
  record landed.
- Suffixed sibling also owned by a third attempt: refuse (`owned`).
- Empty / separator-bearing `attemptId` or empty path: `invalid-attempt` /
  `invalid-path`.
- Relative paths are `resolve()`d (`.` / `..` only; no symlink policy added).
