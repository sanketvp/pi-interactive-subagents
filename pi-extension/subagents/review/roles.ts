import { createHash } from "node:crypto";
import type { Role } from "./types.ts";

export type AuthorClass = "heavy" | "second" | "longctx" | "fanout" | "surgical" | "bulk" | "planner" | "researcher" | "escalation";

export interface RoleBinding {
  role: Role;
  tools: readonly string[];
  authorClass?: AuthorClass;
}

const READ_NAV = ["read", "grep", "find", "ls"] as const;
const PLAN_TOOLS = [...READ_NAV, "write", "edit"] as const;
const AUTHOR_TOOLS = [...READ_NAV, "write", "edit", "bash-guard"] as const;
const REVIEWER_TOOLS = ["read", "git_ro"] as const;
const VERIFIER_TOOLS = [...READ_NAV, "verify_exec"] as const;

/**
 * Fixed profile-name → role map (I5). Unknown names are refused. Tool bounds
 * are the maximum set a role may be launched with (G1).
 * Null prototype so model-controlled names like `constructor` cannot hit Object.prototype.
 */
export const PROFILE_ROLE_MAP: Readonly<Record<string, RoleBinding>> = Object.assign(Object.create(null), {
  planner: { role: "planner", tools: PLAN_TOOLS, authorClass: "planner" },
  researcher: { role: "researcher", tools: PLAN_TOOLS, authorClass: "researcher" },
  implementer: { role: "author", tools: AUTHOR_TOOLS, authorClass: "heavy" },
  "implementer-gpt": { role: "author", tools: AUTHOR_TOOLS, authorClass: "second" },
  "implementer-k3": { role: "author", tools: AUTHOR_TOOLS, authorClass: "longctx" },
  "implementer-glm": { role: "author", tools: AUTHOR_TOOLS, authorClass: "fanout" },
  worker: { role: "author", tools: AUTHOR_TOOLS, authorClass: "surgical" },
  bulk: { role: "author", tools: AUTHOR_TOOLS, authorClass: "bulk" },
  reviewer: { role: "reviewer", tools: REVIEWER_TOOLS },
  "pr-reviewer": { role: "reviewer", tools: REVIEWER_TOOLS },
  verifier: { role: "verifier", tools: VERIFIER_TOOLS },
});

export class UnknownProfileError extends Error {
  constructor(profileName: string) {
    super(`Refused: unknown profile '${profileName}'`);
    this.name = "UnknownProfileError";
  }
}

export function roleFor(profileName: string): RoleBinding {
  if (!Object.hasOwn(PROFILE_ROLE_MAP, profileName)) throw new UnknownProfileError(profileName);
  return PROFILE_ROLE_MAP[profileName];
}

export function isKnownProfile(profileName: string): boolean {
  return Object.hasOwn(PROFILE_ROLE_MAP, profileName);
}

export function toolsWithinBounds(profileName: string, tools: readonly string[]): boolean {
  const binding = roleFor(profileName);
  const allowed = new Set(binding.tools);
  return tools.every((t) => allowed.has(t));
}

/** SHA-256 of the exact accepted profile body bytes. */
export function profileDigest(body: string | Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}
