// Per-account usage tracking for proactive, quota-aware account selection.
// Added 2026-09-04 (user directive) after evaluating github.com/realiti4/claude-swap:
// that tool's rotation logic (proactive threshold switching before a hard rate limit,
// per-model quota awareness, hysteresis) is genuinely more capable than the pool's
// original round-robin/failover, but claude-swap itself manages the wrong credential
// layer for pi (the standalone `claude` CLI's own login, not pi's own auth.json/pool).
// This ports the THREE ideas worth having into the pool's own account-selection logic,
// as a new opt-in "quota-aware" rotation strategy — round-robin/failover are untouched.
//
// Fails open by design: any fetch/parse error here must never block a request. Callers
// treat a null/empty snapshot as "no usage data available" and fall back to whichever
// account round-robin would have picked.

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — usage doesn't change fast enough to justify tighter polling

export interface UsageSnapshot {
  fetchedAt: number;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  perModelPct: Record<string, number>; // display name ("Fable", "Opus", ...) -> pct
}

const cache = new Map<string, UsageSnapshot>();

// Same display-name normalization statusline.sh already uses for the two known API shapes
// (limits[] weekly_scoped entries with scope.model.display_name, and older seven_day_<model>
// keys) — kept in sync so the pool and the statusline agree on what "Fable" usage means.
function normalizeModelLabel(raw: string): string {
  let label = raw;
  if (label.startsWith("seven_day_")) label = label.slice("seven_day_".length);
  if (label.startsWith("five_hour_")) label = label.slice("five_hour_".length);
  switch (label.toLowerCase()) {
    case "opus": return "Opus";
    case "fable": return "Fable";
    case "sonnet": return "Sonnet";
    case "haiku": return "Haiku";
    case "oauth_apps": return "Apps";
    default:
      if (label.length === 0) return label;
      return label[0].toUpperCase() + label.slice(1);
  }
}

async function fetchUsage(accessToken: string): Promise<UsageSnapshot | null> {
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;

    const fiveHourPct = extractPct((data.five_hour as { utilization?: number } | undefined)?.utilization);
    const sevenDayPct = extractPct((data.seven_day as { utilization?: number } | undefined)?.utilization);

    const perModelPct: Record<string, number> = {};

    // Shape 1: limits[] weekly_scoped entries with scope.model.display_name
    const limits = Array.isArray(data.limits) ? (data.limits as Record<string, unknown>[]) : [];
    for (const l of limits) {
      if (l.kind !== "weekly_scoped") continue;
      const scope = l.scope as { model?: { display_name?: string } } | undefined;
      const displayName = scope?.model?.display_name;
      const pct = extractPct(l.percent as number | undefined);
      if (displayName && pct !== null) {
        perModelPct[normalizeModelLabel(displayName)] = pct;
      }
    }

    // Shape 2 (older/fallback): seven_day_<model> / five_hour_<model> objects
    for (const [key, value] of Object.entries(data)) {
      if (!/^(five_hour|seven_day)_.+/.test(key)) continue;
      if (typeof value !== "object" || value === null) continue;
      const util = (value as { utilization?: number }).utilization;
      const pct = extractPct(util);
      if (pct !== null) {
        const label = normalizeModelLabel(key);
        if (!(label in perModelPct)) perModelPct[label] = pct;
      }
    }

    return { fetchedAt: Date.now(), fiveHourPct, sevenDayPct, perModelPct };
  } catch {
    return null; // fail open — caller falls back to non-quota-aware selection
  }
}

function extractPct(v: number | undefined | null): number | null {
  if (typeof v !== "number" || Number.isNaN(v)) return null;
  return v;
}

/** Cached snapshot for one account, refetching only if stale. Never throws. */
export async function getUsageSnapshot(accountId: string, accessToken: string): Promise<UsageSnapshot | null> {
  const cached = cache.get(accountId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }
  const fresh = await fetchUsage(accessToken);
  if (fresh) {
    cache.set(accountId, fresh);
    return fresh;
  }
  // Fetch failed — serve the stale cache if we have one rather than nothing (same
  // last-known-good discipline as statusline.sh's cache policy), else null.
  return cached ?? null;
}

/** Best-effort mapping from a pi model id (e.g. "claude-fable-5", "claude-opus-5") to the
 * display name the usage API's per-model buckets use (e.g. "Fable", "Opus") — used to fold
 * the model actually being dispatched into the quota-aware decision even when the pool
 * config didn't pin a specific --model filter. Returns undefined for anything unrecognized
 * (e.g. non-Anthropic ids passed in by mistake) rather than guessing. */
export function modelIdToDisplayName(modelId: string): string | undefined {
  const id = modelId.toLowerCase();
  if (id.includes("fable")) return "Fable";
  if (id.includes("opus")) return "Opus";
  if (id.includes("sonnet")) return "Sonnet";
  if (id.includes("haiku")) return "Haiku";
  return undefined;
}

/** Worst-case utilization relevant to a dispatch: max of 5h/7d, and the specific
 * model's weekly bucket if one is configured and present. Null means "no data" —
 * caller must treat that as "unknown, don't block on it". */
export function relevantUtilization(snapshot: UsageSnapshot | null, modelLabel?: string): number | null {
  if (!snapshot) return null;
  const parts: number[] = [];
  if (snapshot.fiveHourPct !== null) parts.push(snapshot.fiveHourPct);
  if (snapshot.sevenDayPct !== null) parts.push(snapshot.sevenDayPct);
  if (modelLabel && snapshot.perModelPct[modelLabel] !== undefined) {
    parts.push(snapshot.perModelPct[modelLabel]);
  }
  if (parts.length === 0) return null;
  return Math.max(...parts);
}
