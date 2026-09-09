/**
 * Write windows, delta writers, coordinator events, taint, shell authorities
 * (plan v1.3 §4.3, including ★ rule 3 unconditional union).
 */
import { randomUUID } from "node:crypto";
import type { Contributor, CoordinatorEvent, Role, ShellAuthority } from "./types.ts";

export interface LiveAttempt {
  attemptId: string;
  families: Contributor[];
  liveFrom: string;
  liveTo?: string;
  role: Role;
}

export interface WriterWindow {
  root: string;
  windowStart: string;
  windowEnd: string;
}

export type WriterResult =
  | { kind: "writers"; writers: Contributor[] }
  | { kind: "unattributed" };

function uniqueSorted(values: Iterable<Contributor>): Contributor[] {
  return [...new Set(values)].sort();
}

function overlaps(aStart: string, aEnd: string | undefined, bStart: string, bEnd: string): boolean {
  const a1 = aStart;
  const a2 = aEnd ?? bEnd;
  return a1 <= bEnd && a2 >= bStart;
}

function authorityOverlaps(auth: ShellAuthority, window: WriterWindow): boolean {
  if (!auth.writeRoots.includes(window.root) && auth.root !== window.root) return false;
  return overlaps(auth.openedAt, auth.closedAt, window.windowStart, window.windowEnd);
}

/**
 * Taint never shrinks within a request: union only.
 */
export function addTaint(taint: readonly Contributor[], family: Contributor): Contributor[] {
  if (taint.includes(family)) return [...taint];
  return uniqueSorted([...taint, family]);
}

export function openShellAuthority(input: {
  owner: ShellAuthority["owner"];
  families: Contributor[];
  root: string;
  writeRoots: string[];
  openedAt: string;
  id?: string;
}): ShellAuthority {
  return {
    id: input.id ?? randomUUID(),
    owner: input.owner,
    families: uniqueSorted(input.families),
    root: input.root,
    writeRoots: [...input.writeRoots],
    openedAt: input.openedAt,
  };
}

export function closeShellAuthority(
  auth: ShellAuthority,
  closedAt: string,
  closeReason: ShellAuthority["closeReason"] = "tool-return",
): ShellAuthority {
  return { ...auth, closedAt, closeReason };
}

export function recordCoordinatorEvent(
  events: CoordinatorEvent[],
  event: CoordinatorEvent,
): CoordinatorEvent[] {
  return [...events, event];
}

/**
 * Writers of a delta (window between consecutive snapshots of the same root
 * with changeKind ≠ none). Rules 1–5 of §4.3; rule 3 is applied unconditionally
 * before the empty-set rules 4–5.
 */
export function writersOfDelta(input: {
  window: WriterWindow;
  authorAttempts: LiveAttempt[];
  coordinatorEvents: CoordinatorEvent[];
  /** Coordinator called a write-capable or non-allowlisted tool in the window. */
  coordinatorWrote: boolean;
  shellAuthorities: ShellAuthority[];
  coordinatorShellTaint: Contributor[];
  nonAuthorAttempts?: LiveAttempt[];
}): WriterResult {
  const { window } = input;
  const set = new Set<Contributor>();

  // Rule 1: families of every author attempt live at any instant in the window.
  for (const attempt of input.authorAttempts) {
    if (overlaps(attempt.liveFrom, attempt.liveTo, window.windowStart, window.windowEnd)) {
      for (const family of attempt.families) set.add(family);
    }
  }

  // Rule 2: if the coordinator called a write-capable / non-allowlisted tool in
  // the window, attribute the governing model — last event at-or-before window
  // start — plus any events inside the window (§4.3).
  if (input.coordinatorWrote) {
    let lastAtOrBefore: CoordinatorEvent | undefined;
    for (const event of input.coordinatorEvents) {
      if (event.at <= window.windowStart) {
        if (!lastAtOrBefore || event.at >= lastAtOrBefore.at) lastAtOrBefore = event;
      }
      if (event.at >= window.windowStart && event.at <= window.windowEnd) {
        set.add(event.family);
      }
    }
    if (lastAtOrBefore) set.add(lastAtOrBefore.family);
  }

  // Rule 3: families of every shell authority whose writeRoots include the root
  // and whose [openedAt, closedAt] overlaps the window, regardless of other
  // writers. Applied unconditionally, before rules 4–5.
  for (const auth of input.shellAuthorities) {
    if (authorityOverlaps(auth, window)) {
      for (const family of auth.families) set.add(family);
    }
  }

  if (set.size > 0) return { kind: "writers", writers: uniqueSorted(set) };

  const nonAuthors = input.nonAuthorAttempts ?? [];
  const nonAuthorLive = nonAuthors.some((a) =>
    overlaps(a.liveFrom, a.liveTo, window.windowStart, window.windowEnd),
  );
  // Rule 5: empty (1)∪(2)∪(3) and a non-author worker was live → unattributed.
  if (nonAuthorLive) return { kind: "unattributed" };

  // Rule 4: empty and no worker live → external; taint unions in if present.
  const writers = new Set<Contributor>(["external"]);
  for (const family of input.coordinatorShellTaint) writers.add(family);
  return { kind: "writers", writers: uniqueSorted(writers) };
}

/**
 * Close authorities still open at coordinator restart. `closedAt` is the
 * recovery instant (ISO); `closeReason` is `'recovery'`. Families union into
 * deltas of the write roots up to the first post-restart snapshot — i.e. any
 * window overlapping `[openedAt, recoveredAt]` — and not forever.
 */
export function closeOpenAuthoritiesAtRecovery(authorities: ShellAuthority[], recoveredAt: string): ShellAuthority[] {
  return authorities.map((auth) => (auth.closedAt ? auth : closeShellAuthority(auth, recoveredAt, "recovery")));
}
