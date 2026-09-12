import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ROUTE_MATRIX,
  checkerPromptPrefix,
  resolveDispatchRoute,
  type RoutingAuthor,
} from "../pi-extension/subagents/routing.ts";
import { familyOf } from "../pi-extension/subagents/review/family.ts";
import subagentsExtension, { __test__ as dispatchTest } from "../pi-extension/subagents/index.ts";

const MODELS: Record<string, string> = {
  implementer: "xai/grok-4.6",
  "implementer-gpt": "openai-codex/gpt-5.6-sol",
  "implementer-k3": "kimi-coding/k3",
  "implementer-glm": "openrouter/z-ai/glm-5.3",
  bulk: "openrouter/z-ai/glm-5.3-flash",
  worker: "xai/grok-4.6",
  planner: "anthropic/claude-fable-5-1",
  reviewer: "openai-codex/gpt-5.6-sol",
  verifier: "anthropic/claude-opus-5",
  "verifier-run": "openai-codex/gpt-5.6-luna",
  scout: "openai-codex/gpt-5.6-terra",
  "pr-reviewer": "openai-codex/gpt-5.6-sol",
};
const profileModel = (profile: string) => MODELS[profile];

const cases = [
  ["general-implementation", "implementer", "xai/grok-4.6", "verifier", "anthropic/claude-opus-5"],
  ["complex-alternate", "implementer-gpt", "openai-codex/gpt-5.6-sol", "verifier", "anthropic/claude-opus-5"],
  ["large-context", "implementer-k3", "kimi-coding/k3", "verifier", "anthropic/claude-opus-5"],
  ["mechanical-bulk", "bulk", "openrouter/z-ai/glm-5.3-flash", "verifier", "anthropic/claude-opus-5"],
  ["surgical", "worker", "xai/grok-4.6", "verifier", "anthropic/claude-opus-5"],
  ["economy-fanout", "implementer-glm", "openrouter/z-ai/glm-5.3", "verifier", "anthropic/claude-opus-5"],
  ["high-risk-planning", "planner", "anthropic/claude-fable-5-1", "reviewer", "openai-codex/gpt-5.6-sol"],
] as const;

describe("task routing", () => {
  it("resolves every author/checker route from current profile model IDs", () => {
    for (const [taskClass, authorProfile, authorModel, checkerProfile, checkerModel] of cases) {
      const author = resolveDispatchRoute({ taskClass, stage: "author" }, profileModel);
      assert.equal(author.profile, authorProfile);
      assert.equal(author.model, authorModel);
      assert.equal(author.launch, true);

      const authorIdentity: RoutingAuthor = {
        source: "attempt",
        attemptId: `attempt-${taskClass}`,
        sessionId: `session-${taskClass}`,
        profile: authorProfile,
        model: authorModel,
      };
      const checker = resolveDispatchRoute({ taskClass, stage: "checker", author: authorIdentity }, profileModel);
      assert.equal(checker.profile, checkerProfile);
      assert.equal(checker.model, checkerModel);
      assert.notEqual(checker.family, author.family);
      assert.match(checkerPromptPrefix(checker), /Inspect the actual artifact or diff/);
      assert.match(checkerPromptPrefix(checker), new RegExp(authorIdentity.attemptId!));
    }
    assert.equal(Object.keys(ROUTE_MATRIX).length, cases.length);
  });

  it("keeps every routed author/checker pair cross-family, including economy-fanout", () => {
    assert.equal(cases.length, 7);
    for (const [taskClass, authorProfile, authorModel] of cases) {
      const author = resolveDispatchRoute({ taskClass, stage: "author" }, profileModel);
      const checker = resolveDispatchRoute(
        {
          taskClass,
          stage: "checker",
          author: {
            source: "attempt",
            attemptId: `attempt-${taskClass}`,
            sessionId: `session-${taskClass}`,
            profile: authorProfile,
            model: authorModel,
          },
        },
        profileModel,
      );
      assert.notEqual(checker.family, author.family, `${taskClass} author/checker must be cross-family`);
    }
  });

  it("resolves economy-fanout to implementer-glm then Opus verifier", () => {
    const author = resolveDispatchRoute({ taskClass: "economy-fanout", stage: "author" }, profileModel);
    assert.equal(author.profile, "implementer-glm");
    assert.equal(author.model, "openrouter/z-ai/glm-5.3");
    const checker = resolveDispatchRoute(
      {
        taskClass: "economy-fanout",
        stage: "checker",
        author: {
          source: "attempt",
          attemptId: "attempt-economy-fanout",
          sessionId: "session-economy-fanout",
          profile: "implementer-glm",
          model: "openrouter/z-ai/glm-5.3",
        },
      },
      profileModel,
    );
    assert.equal(checker.profile, "verifier");
    assert.equal(checker.model, "anthropic/claude-opus-5");
    assert.equal(checker.family, "anthropic");
  });

  it("uses Opus verifier for large-context checks (no Sol override)", () => {
    const checker = resolveDispatchRoute(
      {
        taskClass: "large-context",
        stage: "checker",
        author: {
          source: "attempt",
          attemptId: "attempt-large-context",
          sessionId: "session-large-context",
          profile: "implementer-k3",
          model: "kimi-coding/k3",
        },
      },
      profileModel,
    );
    assert.equal(checker.profile, "verifier");
    assert.equal(checker.model, "anthropic/claude-opus-5");
    assert.notEqual(checker.model, "openai-codex/gpt-5.6-sol");
    assert.equal(checker.family, "anthropic");
  });

  it("refuses a Luna runner for a Sol complex-alternate author (same family)", () => {
    const author: RoutingAuthor = {
      source: "attempt",
      attemptId: "attempt-complex-alternate",
      sessionId: "session-complex-alternate",
      profile: "implementer-gpt",
      model: "openai-codex/gpt-5.6-sol",
    };
    assert.throws(
      () => resolveDispatchRoute({ taskClass: "complex-alternate", stage: "runner", author }, profileModel),
      /matches author family/,
    );
    assert.throws(
      () =>
        resolveDispatchRoute(
          {
            taskClass: "complex-alternate",
            stage: "runner",
            author,
            requestedModel: "openai-codex/gpt-5.6-luna",
          },
          profileModel,
        ),
      /matches author family/,
    );
  });

  it("accepts a GLM Flash runner override for a Sol complex-alternate author", () => {
    const runner = resolveDispatchRoute(
      {
        taskClass: "complex-alternate",
        stage: "runner",
        author: {
          source: "attempt",
          attemptId: "attempt-complex-alternate",
          sessionId: "session-complex-alternate",
          profile: "implementer-gpt",
          model: "openai-codex/gpt-5.6-sol",
        },
        requestedModel: "openrouter/z-ai/glm-5.3-flash",
      },
      profileModel,
    );
    assert.equal(runner.stage, "runner");
    assert.equal(runner.profile, "verifier-run");
    assert.equal(runner.model, "openrouter/z-ai/glm-5.3-flash");
    assert.equal(runner.family, "zai");
    assert.equal(runner.launch, true);
  });

  it("resolves a cross-family runner for every ordinary code class, including mechanical-bulk (D4-B)", () => {
    const runnerClasses = [
      "general-implementation",
      "large-context",
      "mechanical-bulk",
      "surgical",
      "economy-fanout",
    ] as const;
    for (const taskClass of runnerClasses) {
      const route = ROUTE_MATRIX[taskClass];
      assert.equal(route.runnerProfile, "verifier-run", `${taskClass} must have a runner stage`);
      const author = resolveDispatchRoute({ taskClass, stage: "author" }, profileModel);
      const runner = resolveDispatchRoute(
        {
          taskClass,
          stage: "runner",
          author: {
            source: "attempt",
            attemptId: `attempt-${taskClass}`,
            sessionId: `session-${taskClass}`,
            profile: route.authorProfile,
            model: author.model,
          },
        },
        profileModel,
      );
      assert.equal(runner.stage, "runner");
      assert.equal(runner.profile, "verifier-run");
      assert.equal(runner.model, "openai-codex/gpt-5.6-luna");
      assert.equal(runner.launch, true);
      assert.notEqual(runner.family, author.family, `${taskClass} author/runner must be cross-family`);
    }
    // complex-alternate has a runner stage too, but its Sol author needs the Flash override (tested below).
    assert.equal(ROUTE_MATRIX["complex-alternate"].runnerProfile, "verifier-run");
    // high-risk-planning is plan → plan review only: no runner.
    assert.equal(ROUTE_MATRIX["high-risk-planning"].runnerProfile, undefined);
  });

  it("resolves the mechanical-bulk runner as Flash(zai) author vs Luna(openai) runner", () => {
    const author = resolveDispatchRoute({ taskClass: "mechanical-bulk", stage: "author" }, profileModel);
    assert.equal(author.profile, "bulk");
    assert.equal(author.model, "openrouter/z-ai/glm-5.3-flash");
    assert.equal(author.family, "zai");
    const runner = resolveDispatchRoute(
      {
        taskClass: "mechanical-bulk",
        stage: "runner",
        author: {
          source: "attempt",
          attemptId: "attempt-mechanical-bulk",
          sessionId: "session-mechanical-bulk",
          profile: "bulk",
          model: "openrouter/z-ai/glm-5.3-flash",
        },
      },
      profileModel,
    );
    assert.equal(runner.profile, "verifier-run");
    assert.equal(runner.model, "openai-codex/gpt-5.6-luna");
    assert.equal(runner.family, "openai");
    assert.notEqual(runner.family, "zai");
    assert.equal(runner.author?.attemptId, "attempt-mechanical-bulk");
  });

  it("is wired into dispatch preflight and records observed author identity in the checker task", () => {
    const ctx = {
      model: { provider: "openai-codex", id: "gpt-5.6-sol" },
      sessionManager: { getSessionId: () => "parent-session" },
    };
    const authorRoute = dispatchTest.resolveSubagentRouting(
      {
        name: "Build",
        task: "Implement it",
        routing: { taskClass: "general-implementation", stage: "author" },
      },
      ctx,
      { version: 1, invocations: 0, workers: [] },
    );
    assert.equal(authorRoute.params.agent, "implementer");
    assert.equal(authorRoute.params.model, dispatchTest.loadAgentDefaults("implementer")?.model);

    const checkerRoute = dispatchTest.resolveSubagentRouting(
      {
        name: "Check",
        task: "Review the diff",
        routing: {
          taskClass: "general-implementation",
          stage: "checker",
          authorAttemptId: "11111111-1111-4111-8111-111111111111",
        },
      },
      ctx,
      {
        version: 1,
        invocations: 1,
        workers: [{
          attemptId: "11111111-1111-4111-8111-111111111111",
          parentSessionId: "22222222-2222-4222-8222-222222222222",
          piSessionId: "33333333-3333-4333-8333-333333333333",
          invocation: 1,
          completionToken: "44444444-4444-4444-8444-444444444444",
          tmuxSocket: "/tmp/tmux",
          windowId: "@1",
          surface: null,
          sessionFile: "/tmp/worker.jsonl",
          launchScriptFile: "/tmp/launch.sh",
          completionFile: "/tmp/done.json",
          paneStartCommand: "bash /tmp/launch.sh",
          requested: { provider: "xai", model: "grok-4.6", thinking: "high" },
          observed: { provider: "xai", model: "grok-4.6", thinking: "high" },
          resourceState: "closed",
          outcome: "done",
          outcomeBytes: "{}",
          outcomeDigest: "unused-by-routing-test",
          deliveryState: "attempted",
          createdAt: 1,
          name: "Build",
          task: "Implement it",
          agent: "implementer",
        }],
      },
    );
    assert.equal(checkerRoute.params.agent, "verifier");
    // Dispatch preflight reads live ~/.pi/agent/agents/*.md; model ID is profile-driven.
    assert.equal(checkerRoute.params.model, dispatchTest.loadAgentDefaults("verifier")?.model);
    assert.match(checkerRoute.params.task, /11111111-1111-4111-8111-111111111111/);
    assert.match(checkerRoute.params.task, /33333333-3333-4333-8333-333333333333/);
    assert.match(checkerRoute.params.task, /xai\/grok-4\.6/);
  });

  it("registers D23 tool help: unique artifact path per worker; interrupt is not kill (no API field implied)", () => {
    const tools: Record<string, any> = {};
    const api: any = {
      on() {},
      registerTool(tool: any) {
        tools[tool.name] = tool;
      },
      registerCommand() {},
      registerMessageRenderer() {},
      registerShortcut() {},
      sendUserMessage() {},
      sendMessage() {},
      getAllTools() {
        return [];
      },
    };
    subagentsExtension(api);

    const spawn = tools["subagent"];
    assert.ok(spawn, "subagent tool registered");
    for (const text of [spawn.description, spawn.promptSnippet]) {
      assert.match(text, /unique artifact path/);
      assert.match(text, /<name>\.<profile>\.<attemptId>\.md/);
      assert.match(text, /never share a path between workers/);
    }
    // Convention lives in the task text: no artifactPath-style parameter exists on the tool.
    const paramNames = Object.keys(spawn.parameters?.properties ?? {});
    assert.ok(!paramNames.some((n) => /artifact|outputPath/i.test(n)), `unexpected artifact param in ${paramNames.join(",")}`);

    const interrupt = tools["subagent_interrupt"];
    assert.ok(interrupt, "subagent_interrupt tool registered");
    for (const text of [interrupt.description, interrupt.promptSnippet]) {
      assert.match(text, /Interrupt is not kill/);
      assert.match(text, /may still run and write/);
      assert.match(text, /\/subagents-diagnose before reusing any artifact path/);
    }
  });

  it("maps all supported vendors by model trainer, including cross-provider Claude", () => {
    const models = [
      ["openrouter/anthropic/claude-sonnet-5", "anthropic"],
      ["openai-codex/gpt-5.6-sol", "openai"],
      ["xai/grok-4.6", "xai"],
      ["kimi-coding/k3", "moonshot"],
      ["openrouter/z-ai/glm-5.3", "zai"],
    ] as const;
    for (const [model, family] of models) assert.equal(familyOf(model), family);
  });

  it("keeps tiny edits in the current known-family coordinator session", () => {
    for (const model of Object.values(MODELS)) {
      const route = resolveDispatchRoute(
        {
          taskClass: "tiny-edit",
          stage: "author",
          currentAuthor: { source: "coordinator", sessionId: "parent-session", profile: "coordinator", model },
        },
        profileModel,
      );
      assert.equal(route.launch, false);
      assert.equal(route.model, model);
      assert.notEqual(route.family, "unknown");
    }
  });

  it("rejects tiny-edit checkers outright: no recorded author to verify against", () => {
    // Plain helper call, no author context at all.
    assert.throws(
      () => resolveDispatchRoute({ taskClass: "tiny-edit", stage: "checker" }, profileModel),
      /no automatic checker/,
    );

    // Even if a caller supplies what looks like a valid author identity
    // (e.g. the current coordinator's own model, known and resolvable), a
    // tiny-edit stay-here edit never recorded that identity at author time,
    // so it must still be rejected rather than silently checked against
    // whatever model happens to be current now.
    const currentModelAuthor: RoutingAuthor = {
      source: "coordinator",
      sessionId: "coordinator-session",
      profile: "coordinator",
      model: "anthropic/claude-sonnet-5",
    };
    assert.throws(
      () => resolveDispatchRoute({ taskClass: "tiny-edit", stage: "checker", author: currentModelAuthor }, profileModel),
      /no automatic checker/,
    );

    // Same rejection even if the coordinator has since switched models
    // (mid-session model switch) and supplies an explicit override request.
    const switchedModelAuthor: RoutingAuthor = {
      ...currentModelAuthor,
      model: "openai-codex/gpt-5.6-sol",
    };
    assert.throws(
      () => resolveDispatchRoute(
        {
          taskClass: "tiny-edit",
          stage: "checker",
          author: switchedModelAuthor,
          requestedModel: "xai/grok-4.6",
        },
        profileModel,
      ),
      /no automatic checker/,
    );
  });

  it("rejects tiny-edit checkers at the dispatch preflight seam, not just the pure helper", () => {
    const ctx = {
      model: { provider: "anthropic", id: "claude-sonnet-5" },
      sessionManager: { getSessionId: () => "parent-session" },
    };
    const emptyRegistry = { version: 1, invocations: 0, workers: [] };
    assert.throws(
      () => dispatchTest.resolveSubagentRouting(
        {
          name: "Check",
          task: "Review the inline edit",
          routing: { taskClass: "tiny-edit", stage: "checker" },
        },
        ctx,
        emptyRegistry,
      ),
      /no automatic checker/,
    );

    // tiny-edit author (stay-here) is unaffected: still resolves, still never launches.
    const authorRoute = dispatchTest.resolveSubagentRouting(
      {
        name: "Edit",
        task: "Fix the typo",
        routing: { taskClass: "tiny-edit", stage: "author" },
      },
      ctx,
      emptyRegistry,
    );
    assert.equal(authorRoute.resolution?.launch, false);
    assert.equal(authorRoute.resolution?.profile, "coordinator");
  });

  it("rejects same-family checkers even through another provider or an override", () => {
    const author: RoutingAuthor = {
      source: "attempt",
      attemptId: "attempt-surgical",
      sessionId: "session-surgical",
      profile: "worker",
      model: "anthropic/claude-sonnet-5",
    };
    assert.throws(
      () => resolveDispatchRoute(
        {
          taskClass: "surgical",
          stage: "checker",
          author,
          requestedModel: "openrouter/anthropic/claude-fable-5-1",
        },
        profileModel,
      ),
      /matches author family/,
    );
  });

  it("uses and validates the actual effective checker override", () => {
    const author: RoutingAuthor = {
      source: "attempt",
      attemptId: "attempt-general",
      sessionId: "session-general",
      profile: "implementer",
      model: "xai/grok-4.6",
    };
    const checker = resolveDispatchRoute(
      {
        taskClass: "general-implementation",
        stage: "checker",
        author,
        requestedModel: "openai-codex/gpt-5.6-sol",
      },
      profileModel,
    );
    assert.equal(checker.model, "openai-codex/gpt-5.6-sol");
    assert.equal(checker.family, "openai");
  });

  it("fails closed for unknown task classes, profiles, author context, and model families", () => {
    assert.throws(() => resolveDispatchRoute({ taskClass: "mystery", stage: "author" }, profileModel), /unknown task class/);
    assert.throws(() => resolveDispatchRoute({ taskClass: "general-implementation", stage: "review" }, profileModel), /unknown stage/);
    assert.throws(
      () => resolveDispatchRoute({ taskClass: "general-implementation", stage: "author" }, () => undefined),
      /has no model/,
    );
    assert.throws(
      () => resolveDispatchRoute({ taskClass: "general-implementation", stage: "author", requestedModel: "mystery/model" }, profileModel),
      /family is unknown/,
    );
    assert.throws(
      () => resolveDispatchRoute({ taskClass: "general-implementation", stage: "checker" }, profileModel),
      /known author context/,
    );
  });

  it("rejects profile mismatches instead of silently changing explicit requests", () => {
    assert.throws(
      () => resolveDispatchRoute({ taskClass: "general-implementation", stage: "author", requestedAgent: "worker" }, profileModel),
      /requires profile 'implementer'/,
    );
    const author: RoutingAuthor = {
      source: "attempt",
      attemptId: "wrong-author",
      sessionId: "wrong-session",
      profile: "implementer-gpt",
      model: "openai-codex/gpt-5.6-sol",
    };
    assert.throws(
      () => resolveDispatchRoute({ taskClass: "general-implementation", stage: "checker", author }, profileModel),
      /author must be 'implementer'/,
    );
  });
});
