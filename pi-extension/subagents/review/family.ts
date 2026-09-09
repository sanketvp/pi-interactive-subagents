import type { Family } from "./types.ts";

export type KnownFamily = Exclude<Family, "unknown">;

export interface FamilyRule {
  family: KnownFamily;
  /**
   * Match against the lowercased model id (full string and last path segment).
   * Built-in rules always win over additive `families.json` entries.
   */
  test: (model: string) => boolean;
}

/**
 * Training-family table (spec §3). Family is the organisation that trained the
 * model, regardless of API route — OpenRouter-routed Fable is still `anthropic`.
 */
export const FAMILY_TABLE: readonly FamilyRule[] = [
  { family: "anthropic", test: (m) => /(?:^|\/)(anthropic|claude)(?:[-/]|$)/.test(m) || m.includes("claude-") },
  {
    family: "openai",
    test: (m) =>
      /(?:^|\/)(openai|openai-codex|codex)(?:[-/]|$)/.test(m) ||
      /(?:^|\/)gpt-/.test(m) ||
      m.includes("gpt-5") ||
      m.includes("gpt-6") ||
      m.includes("astra"),
  },
  { family: "xai", test: (m) => /(?:^|\/)(xai)(?:[-/]|$)/.test(m) || m.includes("grok") },
  {
    family: "moonshot",
    test: (m) =>
      /(?:^|\/)(moonshot|kimi|kimi-coding)(?:[-/]|$)/.test(m) ||
      /(?:^|\/)k3(?:[-/]|$)/.test(m) ||
      /(?:^|\/)k2(?:[-/]|$)/.test(m) ||
      m.includes("kimi"),
  },
  {
    family: "zai",
    test: (m) => /(?:^|\/)(zai|z-ai)(?:[-/]|$)/.test(m) || m.includes("glm-") || /(?:^|\/)glm(?:[-/]|$)/.test(m),
  },
];

const KNOWN_FAMILIES = new Set<Family>(["anthropic", "openai", "xai", "moonshot", "zai"]);

function emptyFamilyMap(): Record<string, Family> {
  return Object.create(null) as Record<string, Family>;
}

function ownGet(map: Record<string, Family>, key: string): Family | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

let additive: Record<string, Family> = emptyFamilyMap();

/** Replace the additive `families.json` map. Built-in FAMILY_TABLE still wins. */
export function setAdditiveFamilies(map: Record<string, Family> | null | undefined): void {
  additive = emptyFamilyMap();
  if (!map) return;
  for (const [key, value] of Object.entries(map)) {
    if (typeof key === "string" && key && KNOWN_FAMILIES.has(value) && value !== "unknown") {
      additive[key.toLowerCase()] = value;
    }
  }
}

export function resetAdditiveFamilies(): void {
  additive = emptyFamilyMap();
}

export function additiveFamilies(): Record<string, Family> {
  return { ...additive };
}

export function coerceModelId(model: unknown): string {
  if (typeof model === "string") return model;
  if (model && typeof model === "object") {
    const rec = model as Record<string, unknown>;
    for (const key of ["id", "model", "name"]) {
      if (!Object.hasOwn(rec, key)) continue;
      if (typeof rec[key] === "string" && (rec[key] as string).length > 0) return rec[key] as string;
    }
  }
  return "";
}

/**
 * Derive the training family of an observed model id. Unknown → `unknown`
 * (fail closed: that worker cannot approve or sit as a reviewer).
 */
export function familyOf(model: unknown, extraAdditive?: Record<string, Family>): Family {
  const raw = coerceModelId(model);
  if (!raw) return "unknown";
  const lowered = raw.toLowerCase();
  const segment = lowered.includes("/") ? lowered.slice(lowered.lastIndexOf("/") + 1) : lowered;
  for (const rule of FAMILY_TABLE) {
    if (rule.test(lowered) || rule.test(segment)) return rule.family;
  }
  const map = extraAdditive ? Object.assign(emptyFamilyMap(), additive, normaliseAdditive(extraAdditive)) : additive;
  return ownGet(map, lowered) ?? ownGet(map, segment) ?? "unknown";
}

function normaliseAdditive(map: Record<string, Family>): Record<string, Family> {
  const out = emptyFamilyMap();
  for (const [key, value] of Object.entries(map)) {
    if (key && KNOWN_FAMILIES.has(value) && value !== "unknown") out[key.toLowerCase()] = value;
  }
  return out;
}

/**
 * Coordinator family is read live from `ctx.model` on every call — never
 * cached, never hard-coded (spec §3).
 */
export function coordinatorFamily(ctx: { model?: unknown } | null | undefined, extraAdditive?: Record<string, Family>): Family {
  return familyOf(ctx?.model, extraAdditive);
}
