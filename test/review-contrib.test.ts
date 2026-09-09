import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addTaint,
  openShellAuthority,
  closeShellAuthority,
  writersOfDelta,
  closeOpenAuthoritiesAtRecovery,
  recordCoordinatorEvent,
} from "../pi-extension/subagents/review/contrib.ts";
import type { Contributor, CoordinatorEvent } from "../pi-extension/subagents/review/types.ts";

describe("contrib", () => {
  it("taint never shrinks", () => {
    let taint: Contributor[] = [];
    taint = addTaint(taint, "anthropic");
    taint = addTaint(taint, "openai");
    taint = addTaint(taint, "anthropic");
    assert.deepEqual(taint, ["anthropic", "openai"]);
    const copy = addTaint(taint, "xai");
    assert.deepEqual(taint, ["anthropic", "openai"]);
    assert.deepEqual(copy, ["anthropic", "openai", "xai"]);
  });

  it("shell authority open/close persists families and timestamps", () => {
    const open = openShellAuthority({
      owner: "coordinator",
      families: ["anthropic"],
      root: "/repo",
      writeRoots: ["/repo"],
      openedAt: "10",
    });
    assert.equal(open.closedAt, undefined);
    assert.deepEqual(open.families, ["anthropic"]);
    const closed = closeShellAuthority(open, "20");
    assert.equal(closed.closedAt, "20");
    assert.equal(open.closedAt, undefined);
  });

  it("rule 3 unions authority families unconditionally across windows even with an unrelated author", () => {
    const auth = openShellAuthority({
      owner: "coordinator",
      families: ["anthropic", "openai"],
      root: "/shell-root",
      writeRoots: ["/shell-root"],
      openedAt: "00",
      id: "auth-1",
    });
    const closed = closeShellAuthority(auth, "99");
    const grokAuthor = {
      attemptId: "a1",
      families: ["xai"] as Contributor[],
      liveFrom: "10",
      liveTo: "90",
      role: "author" as const,
    };
    const window = { root: "/shell-root", windowStart: "20", windowEnd: "30" };
    const result = writersOfDelta({
      window,
      authorAttempts: [grokAuthor],
      coordinatorEvents: [],
      coordinatorWrote: false,
      shellAuthorities: [closed],
      coordinatorShellTaint: [],
    });
    assert.equal(result.kind, "writers");
    if (result.kind !== "writers") return;
    // rule 1 → xai (unrelated author live), rule 3 → anthropic,openai unconditionally
    assert.deepEqual(result.writers, ["anthropic", "openai", "xai"]);
  });

  it("rule 3 still attributes authority families when no other writers exist", () => {
    const auth = closeShellAuthority(
      openShellAuthority({
        owner: { attemptId: "w1" },
        families: ["moonshot"],
        root: "/r",
        writeRoots: ["/r"],
        openedAt: "1",
      }),
      "5",
    );
    const result = writersOfDelta({
      window: { root: "/r", windowStart: "2", windowEnd: "4" },
      authorAttempts: [],
      coordinatorEvents: [],
      coordinatorWrote: false,
      shellAuthorities: [auth],
      coordinatorShellTaint: ["zai"],
    });
    assert.equal(result.kind, "writers");
    if (result.kind !== "writers") return;
    assert.deepEqual(result.writers, ["moonshot"]);
  });

  it("coordinator families per window only when coordinatorWrote", () => {
    const events: CoordinatorEvent[] = [
      { at: "15", model: "anthropic/claude-opus-5", family: "anthropic" },
      { at: "50", model: "xai/grok-4.6", family: "xai" },
    ];
    const window = { root: "/r", windowStart: "10", windowEnd: "20" };
    const withWrite = writersOfDelta({
      window,
      authorAttempts: [],
      coordinatorEvents: events,
      coordinatorWrote: true,
      shellAuthorities: [],
      coordinatorShellTaint: [],
    });
    assert.equal(withWrite.kind, "writers");
    if (withWrite.kind === "writers") assert.deepEqual(withWrite.writers, ["anthropic"]);
    const without = writersOfDelta({
      window,
      authorAttempts: [],
      coordinatorEvents: events,
      coordinatorWrote: false,
      shellAuthorities: [],
      coordinatorShellTaint: [],
    });
    assert.equal(without.kind, "writers");
    if (without.kind === "writers") assert.deepEqual(without.writers, ["external"]);
  });

  it("rule 2 uses the last coordinator event at-or-before the window, not only events inside it", () => {
    const result = writersOfDelta({
      window: { root: "/r", windowStart: "10", windowEnd: "20" },
      authorAttempts: [],
      coordinatorEvents: [{ at: "05", model: "anthropic/claude-opus-5", family: "anthropic" }],
      coordinatorWrote: true,
      shellAuthorities: [],
      coordinatorShellTaint: [],
    });
    assert.equal(result.kind, "writers");
    if (result.kind === "writers") assert.deepEqual(result.writers, ["anthropic"]);
  });

  it("rule 5: empty writers with a live non-author worker → unattributed", () => {
    const result = writersOfDelta({
      window: { root: "/r", windowStart: "1", windowEnd: "2" },
      authorAttempts: [],
      coordinatorEvents: [],
      coordinatorWrote: false,
      shellAuthorities: [],
      coordinatorShellTaint: [],
      nonAuthorAttempts: [{ attemptId: "rev", families: ["openai"], liveFrom: "1", liveTo: "2", role: "reviewer" }],
    });
    assert.equal(result.kind, "unattributed");
  });

  it("rule 4: empty writers, no worker live → external ∪ taint", () => {
    const result = writersOfDelta({
      window: { root: "/r", windowStart: "1", windowEnd: "2" },
      authorAttempts: [],
      coordinatorEvents: [],
      coordinatorWrote: false,
      shellAuthorities: [],
      coordinatorShellTaint: ["anthropic"],
    });
    assert.equal(result.kind, "writers");
    if (result.kind === "writers") assert.deepEqual(result.writers, ["anthropic", "external"]);
  });

  it("authorities open at restart close with closeReason=recovery and a real timestamp", () => {
    const open = openShellAuthority({
      owner: "coordinator",
      families: ["openai"],
      root: "/r",
      writeRoots: ["/r"],
      openedAt: "2026-01-01T00:00:00.000Z",
    });
    const recoveredAt = "2026-01-02T00:00:00.000Z";
    const closed = closeOpenAuthoritiesAtRecovery([open], recoveredAt);
    assert.equal(closed[0].closedAt, recoveredAt);
    assert.equal(closed[0].closeReason, "recovery");
    assert.deepEqual(closed[0].families, ["openai"]);
  });

  it("recovery-closed authority does not contribute to a window well after the restart boundary", () => {
    const recoveredAt = "2026-01-02T00:00:00.000Z";
    const auth = closeOpenAuthoritiesAtRecovery(
      [
        openShellAuthority({
          owner: "coordinator",
          families: ["openai"],
          root: "/r",
          writeRoots: ["/r"],
          openedAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
      recoveredAt,
    )[0];
    const firstPostRestart = writersOfDelta({
      window: { root: "/r", windowStart: "2026-01-01T12:00:00.000Z", windowEnd: recoveredAt },
      authorAttempts: [],
      coordinatorEvents: [],
      coordinatorWrote: false,
      shellAuthorities: [auth],
      coordinatorShellTaint: [],
    });
    assert.equal(firstPostRestart.kind, "writers");
    if (firstPostRestart.kind === "writers") assert.deepEqual(firstPostRestart.writers, ["openai"]);

    const eighteenMonthsLater = writersOfDelta({
      window: { root: "/r", windowStart: "2027-07-01T00:00:00.000Z", windowEnd: "2027-07-02T00:00:00.000Z" },
      authorAttempts: [],
      coordinatorEvents: [],
      coordinatorWrote: false,
      shellAuthorities: [auth],
      coordinatorShellTaint: [],
    });
    assert.equal(eighteenMonthsLater.kind, "writers");
    if (eighteenMonthsLater.kind === "writers") {
      assert.deepEqual(eighteenMonthsLater.writers, ["external"]);
      assert.ok(!eighteenMonthsLater.writers.includes("openai"));
    }
  });

  it("rule 3 still contributes when rules 1+2 are empty and a non-author worker was live (not unattributed)", () => {
    const auth = closeShellAuthority(
      openShellAuthority({
        owner: { attemptId: "w1" },
        families: ["moonshot"],
        root: "/r",
        writeRoots: ["/r"],
        openedAt: "1",
      }),
      "5",
    );
    const result = writersOfDelta({
      window: { root: "/r", windowStart: "2", windowEnd: "4" },
      authorAttempts: [],
      coordinatorEvents: [],
      coordinatorWrote: false,
      shellAuthorities: [auth],
      coordinatorShellTaint: [],
      nonAuthorAttempts: [{ attemptId: "rev", families: ["openai"], liveFrom: "2", liveTo: "4", role: "reviewer" }],
    });
    assert.equal(result.kind, "writers");
    if (result.kind === "writers") {
      assert.deepEqual(result.writers, ["moonshot"]);
      assert.ok(!result.writers.includes("openai"));
    }
  });

  it("recordCoordinatorEvent appends", () => {
    const events = recordCoordinatorEvent([], { at: "1", model: "x", family: "xai" });
    assert.equal(events.length, 1);
    assert.equal(events[0].family, "xai");
  });
});
