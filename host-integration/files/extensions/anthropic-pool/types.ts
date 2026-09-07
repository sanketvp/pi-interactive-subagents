import type { OAuthCredentials } from "@earendil-works/pi-ai";

export interface AccountStats {
  successCount: number;
  rateLimitCount: number;
  errorCount: number;
  lastUsedAt?: number;
}

export interface AnthropicAccount {
  id: string;
  name: string;
  email?: string;
  credentials: {
    type: "oauth";
    access: string;
    refresh: string;
    expires: number;
  };
  rateLimitedUntil: number; // timestamp ms (0 if ready)
  rateLimitReason?: string;
  createdAt: number;
  stats: AccountStats;
}

export interface PoolConfig {
  version: 1;
  accounts: AnthropicAccount[];
  activeIndex: number;
  defaultCooldownMs: number; // default 3 hours (10,800,000 ms)
  rotation: "round-robin" | "failover" | "quota-aware";
  // quota-aware only (added 2026-09-04, ideas ported from github.com/realiti4/claude-swap's
  // rotation logic after evaluating it for pi — see usage-tracker.ts header). All optional;
  // absent = sane defaults (threshold 90, no model filter, 10-min hysteresis cooldown).
  quotaAware?: {
    thresholdPct?: number; // proactively rotate away once the active account is >= this
    model?: string; // e.g. "Fable" — also factor this model's weekly bucket into the decision
    hysteresisMs?: number; // minimum time between proactive (non-reactive) switches
  };
}

export type AccountStatus = "active" | "ready" | "rate_limited" | "token_expired";

export interface PoolFooterSnapshot {
  activeIndex: number;
  activeName: string;
  status: "active" | "rate_limited" | "expired";
  rateLimitedUntil: number;
  tokenExpiresAt: number;
  rotation: "round-robin" | "failover" | "quota-aware";
  totalAccounts: number;
  stats: AccountStats;
}

export interface AccountStatusView {
  index: number;
  id: string;
  name: string;
  isActive: boolean;
  status: AccountStatus;
  rateLimitRemainingMs: number;
  tokenExpiresInMs: number;
  stats: AccountStats;
}
