import { familyOf } from "./review/family.ts";
import type { Family } from "./review/types.ts";

export const ROUTED_TASK_CLASSES = [
  "general-implementation",
  "complex-alternate",
  "large-context",
  "mechanical-bulk",
  "surgical",
  "economy-fanout",
  "high-risk-planning",
  "tiny-edit",
] as const;

export type RoutedTaskClass = (typeof ROUTED_TASK_CLASSES)[number];
export type RoutingStage = "author" | "checker" | "runner";

interface RouteDefinition {
  authorProfile: string;
  checkerProfile: string;
  checkerModelProfile?: string;
  /**
   * Luna medium command-runner (D4-B). Set on ordinary code classes.
   * Stage "runner" uses the same author-context and cross-family checks as
   * checker. A Sol author (openai family) must not get the default Luna
   * runner (also openai) — the family throw handles it. The coordinator
   * overrides model to openrouter/z-ai/glm-5.3-flash for that case.
   */
  runnerProfile?: string;
}

/** Profile names are stable policy; model IDs are read from the live profile files. */
export const ROUTE_MATRIX: Readonly<Record<Exclude<RoutedTaskClass, "tiny-edit">, RouteDefinition>> = {
  "general-implementation": { authorProfile: "implementer", checkerProfile: "verifier", runnerProfile: "verifier-run" },
  "complex-alternate": { authorProfile: "implementer-gpt", checkerProfile: "verifier", runnerProfile: "verifier-run" },
  "large-context": { authorProfile: "implementer-k3", checkerProfile: "verifier", runnerProfile: "verifier-run" },
  "mechanical-bulk": { authorProfile: "bulk", checkerProfile: "verifier", runnerProfile: "verifier-run" },
  surgical: { authorProfile: "worker", checkerProfile: "verifier", runnerProfile: "verifier-run" },
  "economy-fanout": { authorProfile: "implementer-glm", checkerProfile: "verifier", runnerProfile: "verifier-run" },
  "high-risk-planning": { authorProfile: "planner", checkerProfile: "reviewer" },
};

export interface RoutingAuthor {
  source: "attempt" | "coordinator";
  attemptId?: string;
  sessionId: string;
  profile: string;
  model: string;
}

export interface RoutingResolution {
  taskClass: RoutedTaskClass;
  stage: RoutingStage;
  launch: boolean;
  profile: string;
  model: string;
  family: Family;
  author?: RoutingAuthor & { family: Family };
}

export interface RoutingRequest {
  taskClass: string;
  stage: string;
  requestedAgent?: string;
  requestedModel?: string;
  author?: RoutingAuthor;
  currentAuthor?: RoutingAuthor;
}

export type ProfileModelLookup = (profile: string) => string | undefined;

export function checkerPromptPrefix(resolution: RoutingResolution): string {
  if (resolution.stage !== "checker" || !resolution.author) {
    throw new Error("Routing refused: checker prompt requires resolved author context");
  }
  const author = resolution.author;
  return [
    "[Independent routing check]",
    `Task class: ${resolution.taskClass}`,
    `Author source: ${author.source}`,
    `Author attempt: ${author.attemptId ?? "stay-here"}`,
    `Author session: ${author.sessionId}`,
    `Author profile/model/family: ${author.profile} / ${author.model} / ${author.family}`,
    `Checker profile/model/family: ${resolution.profile} / ${resolution.model} / ${resolution.family}`,
    "Inspect the actual artifact or diff and run the relevant tests. Do not rely on the author's narration. Do not modify the artifact.",
  ].join("\n");
}

function knownFamily(model: string, label: string): Family {
  const family = familyOf(model);
  if (family === "unknown") throw new Error(`Routing refused: ${label} model family is unknown (${model || "missing model"})`);
  return family;
}

function requiredProfileModel(profile: string, lookup: ProfileModelLookup): string {
  const model = lookup(profile);
  if (!model) throw new Error(`Routing refused: profile '${profile}' has no model`);
  return model;
}

function validateClass(value: string): RoutedTaskClass {
  if (!ROUTED_TASK_CLASSES.includes(value as RoutedTaskClass)) {
    throw new Error(`Routing refused: unknown task class '${value}'`);
  }
  return value as RoutedTaskClass;
}

function validateStage(value: string): RoutingStage {
  if (value !== "author" && value !== "checker" && value !== "runner") {
    throw new Error(`Routing refused: unknown stage '${value}'`);
  }
  return value;
}

function assertRequestedProfile(requested: string | undefined, selected: string): void {
  if (requested && requested !== selected) {
    throw new Error(`Routing refused: task class requires profile '${selected}', not '${requested}'`);
  }
}

function resolvePairedStage(
  stage: "checker" | "runner",
  taskClass: Exclude<RoutedTaskClass, "tiny-edit">,
  request: RoutingRequest,
  profileModel: ProfileModelLookup,
  route: RouteDefinition,
): RoutingResolution {
  const { authorProfile, checkerProfile, checkerModelProfile, runnerProfile } = route;
  const author = request.author;
  if (!author) throw new Error(`Routing refused: ${stage} requires known author context`);
  if (author.profile !== authorProfile) {
    throw new Error(`Routing refused: ${taskClass} author must be '${authorProfile}', not '${author.profile}'`);
  }
  const authorFamily = knownFamily(author.model, "author");

  if (stage === "runner") {
    if (!runnerProfile) {
      throw new Error(`Routing refused: ${taskClass} has no runner stage`);
    }
    assertRequestedProfile(request.requestedAgent, runnerProfile);
    const defaultRunnerModel = requiredProfileModel(runnerProfile, profileModel);
    const model = request.requestedModel ?? defaultRunnerModel;
    const runnerFamily = knownFamily(model, "runner");
    if (runnerFamily === authorFamily) {
      throw new Error(
        `Routing refused: runner family '${runnerFamily}' matches author family; choose a different model family`,
      );
    }
    return {
      taskClass,
      stage,
      launch: true,
      profile: runnerProfile,
      model,
      family: runnerFamily,
      author: { ...author, family: authorFamily },
    };
  }

  assertRequestedProfile(request.requestedAgent, checkerProfile);
  const defaultCheckerModel = requiredProfileModel(checkerModelProfile ?? checkerProfile, profileModel);
  const model = request.requestedModel ?? defaultCheckerModel;
  const checkerFamily = knownFamily(model, "checker");
  if (checkerFamily === authorFamily) {
    throw new Error(
      `Routing refused: checker family '${checkerFamily}' matches author family; choose a different model family`,
    );
  }

  return {
    taskClass,
    stage,
    launch: true,
    profile: checkerProfile,
    model,
    family: checkerFamily,
    author: { ...author, family: authorFamily },
  };
}

/** Resolve one dispatch. This selects/preflights a worker; it does not schedule the paired workflow. */
export function resolveDispatchRoute(request: RoutingRequest, profileModel: ProfileModelLookup): RoutingResolution {
  const taskClass = validateClass(request.taskClass);
  const stage = validateStage(request.stage);

  if (taskClass === "tiny-edit" && stage === "author") {
    const author = request.currentAuthor;
    if (!author || author.source !== "coordinator") {
      throw new Error("Routing refused: tiny-edit requires the current coordinator session identity");
    }
    assertRequestedProfile(request.requestedAgent, "coordinator");
    if (request.requestedModel && request.requestedModel !== author.model) {
      throw new Error("Routing refused: tiny-edit stays in the current coordinator model; model override is not a stay-here route");
    }
    const model = author.model;
    return {
      taskClass,
      stage,
      launch: false,
      profile: "coordinator",
      model,
      family: knownFamily(model, "author"),
    };
  }

  if (taskClass === "tiny-edit") {
    if (stage === "runner") {
      throw new Error("Routing refused: tiny-edit has no runner stage");
    }
    // stage === "checker": tiny-edit stay-here author never records an identity
    // (no attempt, no observed model), so there is nothing a checker could
    // verify against. Reject before launch instead of guessing the author
    // from whatever model the current coordinator happens to be running now.
    throw new Error(
      "Routing refused: tiny-edit has no automatic checker (stay-here edits leave no recorded author); delegate the task with routing:{taskClass:'surgical'|'general-implementation', stage:'author'} instead if you need a recorded, checkable author",
    );
  }

  const route = ROUTE_MATRIX[taskClass];
  const { authorProfile } = route;

  if (stage === "author") {
    assertRequestedProfile(request.requestedAgent, authorProfile);
    const model = request.requestedModel ?? requiredProfileModel(authorProfile, profileModel);
    return {
      taskClass,
      stage,
      launch: true,
      profile: authorProfile,
      model,
      family: knownFamily(model, "author"),
    };
  }

  return resolvePairedStage(stage, taskClass, request, profileModel, route);
}
