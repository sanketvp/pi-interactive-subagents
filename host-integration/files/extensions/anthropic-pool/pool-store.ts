import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_ID,
  DEFAULT_COOLDOWN_MS,
  TOKEN_URL,
} from "./constants.js";
import type {
  AccountStatusView,
  AnthropicAccount,
  PoolConfig,
  PoolFooterSnapshot,
} from "./types.js";
import { getUsageSnapshot, relevantUtilization } from "./usage-tracker.js";

const DEFAULT_QUOTA_AWARE_THRESHOLD_PCT = 90;
const DEFAULT_QUOTA_AWARE_HYSTERESIS_MS = 10 * 60 * 1000; // 10 min, matches the pool's existing cooldown-ish timescale
let lastProactiveSwitchAt = 0; // in-memory only — a missed hysteresis window on process restart is harmless (worst case: one extra proactive switch)

const POOL_FILE_PATH = join(homedir(), ".pi", "agent", "anthropic-pool.json");
const PI_AUTH_FILE_PATH = join(homedir(), ".pi", "agent", "auth.json");

export class AccountPoolStore {
  private config: PoolConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  /**
   * Multi-process safety: MANY pi sessions share one pool file, and every
   * session's extension instance keeps its own in-memory config. If any of
   * them persisted its in-memory copy on every request, the last writer
   * clobbers credentials refreshed by other processes (e.g. the reauth
   * daemon or the scheduled refresher).
   *
   * Therefore every public read/mutation starts by re-reading the disk
   * state (read-modify-write). The disk is the source of truth; in-memory
   * state only lives for the duration of one operation.
   */
  private reloadFromDisk(): void {
    try {
      const raw = readFileSync(POOL_FILE_PATH, "utf8");
      const parsed = JSON.parse(raw) as PoolConfig;
      if (Array.isArray(parsed.accounts)) {
        if (!parsed.rotation) parsed.rotation = "round-robin";
        this.config = parsed;
      }
    } catch (err) {
      // Keep the current in-memory config if the file is unreadable/corrupt
      // (e.g. mid-write from another process). Never throw from here.
      console.error("[Claude Pool] reloadFromDisk failed, keeping in-memory config:", err);
    }
  }

  private getDefaultConfig(): PoolConfig {
    return {
      version: 1,
      accounts: [],
      activeIndex: 0,
      defaultCooldownMs: DEFAULT_COOLDOWN_MS,
      rotation: "round-robin",
    };
  }

  private loadConfig(): PoolConfig {
    if (existsSync(POOL_FILE_PATH)) {
      try {
        const raw = readFileSync(POOL_FILE_PATH, "utf8");
        const parsed = JSON.parse(raw) as PoolConfig;
        if (Array.isArray(parsed.accounts)) {
          if (!parsed.rotation) {
            parsed.rotation = "round-robin";
          }
          return parsed;
        }
      } catch (err) {
        console.error("[Claude Pool] Failed to parse pool file:", err);
      }
    }

    const cfg = this.getDefaultConfig();
    this.maybeImportExistingPiAuth(cfg);
    return cfg;
  }

  private maybeImportExistingPiAuth(cfg: PoolConfig): void {
    if (!existsSync(PI_AUTH_FILE_PATH)) return;
    try {
      const raw = readFileSync(PI_AUTH_FILE_PATH, "utf8");
      const auth = JSON.parse(raw) as Record<string, unknown>;
      const ant = auth.anthropic as
        | { type: string; access?: string; refresh?: string; expires?: number }
        | undefined;

      if (
        ant &&
        ant.type === "oauth" &&
        typeof ant.access === "string" &&
        ant.access.includes("sk-ant-oat") &&
        typeof ant.refresh === "string"
      ) {
        cfg.accounts.push({
          id: `account-1`,
          name: "Account 1 (Primary)",
          credentials: {
            type: "oauth",
            access: ant.access,
            refresh: ant.refresh,
            expires: typeof ant.expires === "number" ? ant.expires : Date.now() + 3600 * 1000,
          },
          rateLimitedUntil: 0,
          createdAt: Date.now(),
          stats: {
            successCount: 0,
            rateLimitCount: 0,
            errorCount: 0,
          },
        });
        this.save(cfg);
      }
    } catch {
      // ignore
    }
  }

  public save(cfg: PoolConfig = this.config): void {
    try {
      this.config = cfg;
      const tmpPath = `${POOL_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), "utf8");
      try {
        chmodSync(tmpPath, 0o600);
      } catch {}
      renameSync(tmpPath, POOL_FILE_PATH);
    } catch (err) {
      console.error("[Claude Pool] Failed to save pool file:", err);
    }
  }

  public syncActiveAccountToPiAuth(account: AnthropicAccount): void {
    try {
      let authObj: Record<string, unknown> = {};
      if (existsSync(PI_AUTH_FILE_PATH)) {
        try {
          authObj = JSON.parse(readFileSync(PI_AUTH_FILE_PATH, "utf8"));
        } catch {}
      }
      authObj.anthropic = {
        type: "oauth",
        access: account.credentials.access,
        refresh: account.credentials.refresh,
        expires: account.credentials.expires,
      };
      const tmpAuth = `${PI_AUTH_FILE_PATH}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmpAuth, JSON.stringify(authObj, null, 2), "utf8");
      try {
        chmodSync(tmpAuth, 0o600);
      } catch {}
      renameSync(tmpAuth, PI_AUTH_FILE_PATH);
    } catch (err) {
      console.error("[Claude Pool] Failed to sync to auth.json:", err);
    }
  }

  public getAccounts(): AnthropicAccount[] {
    this.reloadFromDisk();
    return this.config.accounts;
  }

  public getActiveIndex(): number {
    this.reloadFromDisk();
    return this.config.activeIndex;
  }

  public getStatusView(): AccountStatusView[] {
    this.reloadFromDisk();
    const now = Date.now();
    return this.config.accounts.map((acc, idx) => {
      const isRateLimited = acc.rateLimitedUntil > now;
      const isExpired = acc.credentials.expires <= now;
      let status: AccountStatusView["status"] = "ready";
      if (idx === this.config.activeIndex) {
        status = isRateLimited ? "rate_limited" : "active";
      } else if (isRateLimited) {
        status = "rate_limited";
      } else if (isExpired) {
        status = "token_expired";
      }

      return {
        index: idx + 1,
        id: acc.id,
        name: acc.name,
        isActive: idx === this.config.activeIndex,
        status,
        rateLimitRemainingMs: isRateLimited ? acc.rateLimitedUntil - now : 0,
        tokenExpiresInMs: acc.credentials.expires - now,
        stats: acc.stats,
      };
    });
  }

  public getRotationStrategy(): "round-robin" | "failover" | "quota-aware" {
    this.reloadFromDisk();
    return this.config.rotation || "round-robin";
  }

  /**
   * Live snapshot for the status footer. Re-reads the pool file from disk so
   * rotations/writes from OTHER pi processes (other sessions) are reflected,
   * not just this process's in-memory config.
   */
  public getFooterSnapshot(): PoolFooterSnapshot | null {
    try {
      const raw = JSON.parse(readFileSync(POOL_FILE_PATH, "utf8")) as PoolConfig;
      if (!Array.isArray(raw.accounts) || raw.accounts.length === 0) return null;
      const idx = Math.min(raw.activeIndex ?? 0, raw.accounts.length - 1);
      const acc = raw.accounts[idx];
      const now = Date.now();
      let status: PoolFooterSnapshot["status"] = "active";
      if (acc.rateLimitedUntil > now) status = "rate_limited";
      else if (acc.credentials.expires <= now) status = "expired";
      return {
        activeIndex: idx,
        activeName: acc.name,
        status,
        rateLimitedUntil: acc.rateLimitedUntil || 0,
        tokenExpiresAt: acc.credentials.expires || 0,
        rotation: raw.rotation || "round-robin",
        totalAccounts: raw.accounts.length,
        stats: {
          successCount: acc.stats?.successCount || 0,
          rateLimitCount: acc.stats?.rateLimitCount || 0,
          errorCount: acc.stats?.errorCount || 0,
        },
      };
    } catch {
      return null;
    }
  }

  public setRotationStrategy(strategy: "round-robin" | "failover" | "quota-aware"): void {
    this.reloadFromDisk();
    this.config.rotation = strategy;
    this.save();
  }

  public setQuotaAwareConfig(opts: { thresholdPct?: number; model?: string; hysteresisMs?: number }): void {
    this.reloadFromDisk();
    this.config.quotaAware = { ...this.config.quotaAware, ...opts };
    this.save();
  }

  public async getOrRotateValidAccount(modelLabel?: string): Promise<AnthropicAccount | null> {
    this.reloadFromDisk();
    if (this.config.accounts.length === 0) {
      return null;
    }

    const now = Date.now();
    const count = this.config.accounts.length;

    // Quota-aware: proactively avoid an account nearing its limit, using cached usage
    // data. Falls open to round-robin-style selection (skipping only hard-rate-limited
    // accounts) if usage data isn't available for enough accounts to compare — this
    // path must never be why a request fails to get an account.
    if (this.config.rotation === "quota-aware" && count > 1) {
      const picked = await this.pickAccountByUsage(modelLabel, now);
      if (picked) {
        if (picked.id !== this.config.accounts[this.config.activeIndex]?.id) {
          const idx = this.config.accounts.findIndex((a) => a.id === picked.id);
          if (idx >= 0) {
            this.config.activeIndex = idx;
            this.save();
            this.syncActiveAccountToPiAuth(picked);
            lastProactiveSwitchAt = now;
          }
        }
        return await this.ensureTokenFresh(picked);
      }
      // No usage-based pick possible (all fetches failed/no cache yet) — fall through
      // to the existing round-robin healthy-account scan below rather than blocking.
    }

    // For round-robin, advance to the next healthy account on each request
    if ((this.config.rotation === "round-robin" || this.config.rotation === "quota-aware") && count > 1) {
      for (let i = 1; i <= count; i++) {
        const nextIdx = (this.config.activeIndex + i) % count;
        const candidate = this.config.accounts[nextIdx];
        if (candidate.rateLimitedUntil <= now) {
          this.config.activeIndex = nextIdx;
          this.save();
          this.syncActiveAccountToPiAuth(candidate);
          return await this.ensureTokenFresh(candidate);
        }
      }
    } else {
      // For failover (or single account): check if current active account is healthy
      const current = this.config.accounts[this.config.activeIndex];
      if (current && current.rateLimitedUntil <= now) {
        return await this.ensureTokenFresh(current);
      }

      // Current is rate-limited; find the next healthy account
      for (let i = 1; i <= count; i++) {
        const nextIdx = (this.config.activeIndex + i) % count;
        const candidate = this.config.accounts[nextIdx];
        if (candidate.rateLimitedUntil <= now) {
          this.config.activeIndex = nextIdx;
          this.save();
          this.syncActiveAccountToPiAuth(candidate);
          return await this.ensureTokenFresh(candidate);
        }
      }
    }

    // If all are rate limited, pick the one with earliest cooldown expiry
    let earliestIdx = 0;
    let earliestTime = Infinity;
    for (let i = 0; i < count; i++) {
      if (this.config.accounts[i].rateLimitedUntil < earliestTime) {
        earliestTime = this.config.accounts[i].rateLimitedUntil;
        earliestIdx = i;
      }
    }

    this.config.activeIndex = earliestIdx;
    this.save();
    return await this.ensureTokenFresh(this.config.accounts[earliestIdx]);
  }

  /**
   * Quota-aware selection (added 2026-09-04). Proactively moves off an account once its
   * usage (5h/7d, plus a configured model's weekly bucket if any) crosses the configured
   * threshold — BEFORE it hits a hard rate limit, unlike round-robin/failover which only
   * react to an actual 429. Deliberately conservative: only switches when the CURRENT
   * account is at/over threshold or already rate-limited; does not chase a marginally
   * better account while the current one is still fine, and respects a hysteresis cooldown
   * so it can't flip-flop every request. Returns null (never throws) if there isn't enough
   * usage data to make a confident decision — caller falls back to round-robin's healthy-
   * account scan, so a usage-API outage degrades to existing behavior, not a failure.
   */
  private async pickAccountByUsage(modelLabel: string | undefined, now: number): Promise<AnthropicAccount | null> {
    const threshold = this.config.quotaAware?.thresholdPct ?? DEFAULT_QUOTA_AWARE_THRESHOLD_PCT;
    const hysteresisMs = this.config.quotaAware?.hysteresisMs ?? DEFAULT_QUOTA_AWARE_HYSTERESIS_MS;
    const effectiveModelLabel = modelLabel ?? this.config.quotaAware?.model;

    const candidates = this.config.accounts.filter((a) => a.rateLimitedUntil <= now);
    if (candidates.length === 0) return null; // everything rate-limited — let existing earliest-cooldown fallback handle it

    const withUsage = await Promise.all(
      candidates.map(async (acc) => ({
        acc,
        util: relevantUtilization(await getUsageSnapshot(acc.id, acc.credentials.access), effectiveModelLabel),
      })),
    );

    const current = this.config.accounts[this.config.activeIndex];
    const currentEntry = withUsage.find((w) => w.acc.id === current?.id);
    const currentIsHealthy = current ? current.rateLimitedUntil <= now : false;
    const currentUtil = currentEntry?.util ?? null;

    // Not enough data to compare, or current account is healthy and clearly under
    // threshold — stay put (this also naturally rate-limits how often we page the usage
    // API for no behavioral benefit).
    if (currentIsHealthy && currentUtil !== null && currentUtil < threshold) {
      return current;
    }
    if (currentIsHealthy && currentUtil === null) {
      return null; // unknown utilization on an otherwise-healthy account — don't guess, fall through
    }

    // Current is over threshold, unknown-but-unhealthy, or rate-limited — look for a
    // better candidate, but respect hysteresis for a NON-reactive (proactive) switch.
    if (currentIsHealthy && now - lastProactiveSwitchAt < hysteresisMs) {
      return current; // still within the cooldown window since the last proactive switch
    }

    const usable = withUsage.filter((w) => w.util !== null) as { acc: AnthropicAccount; util: number }[];
    if (usable.length === 0) return null;
    usable.sort((a, b) => a.util - b.util);
    return usable[0].acc;
  }

  public async ensureTokenFresh(account: AnthropicAccount): Promise<AnthropicAccount> {
    this.reloadFromDisk();
    const fresh = this.config.accounts.find((a) => a.id === account.id);
    if (!fresh) return account;

    const now = Date.now();
    // Refresh if within 5 minutes of expiring or expired
    if (fresh.credentials.expires <= now + 5 * 60 * 1000) {
      try {
        const refreshed = await this.refreshToken(fresh);
        // Reload disk again to capture any writes that happened during the HTTP call,
        // then update only this account's credentials
        this.reloadFromDisk();
        const diskAcc = this.config.accounts.find((a) => a.id === account.id);
        if (diskAcc) {
          diskAcc.credentials = refreshed.credentials;
        }
        this.save();
        this.syncActiveAccountToPiAuth(refreshed);
        return refreshed;
      } catch (err) {
        console.error(`[Claude Pool] Failed refreshing token for ${fresh.name}:`, err);
      }
    }
    return fresh;
  }

  public async refreshToken(account: AnthropicAccount): Promise<AnthropicAccount> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: account.credentials.refresh,
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Token refresh HTTP ${res.status}: ${txt}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    account.credentials.access = data.access_token;
    if (data.refresh_token) {
      account.credentials.refresh = data.refresh_token;
    }
    account.credentials.expires =
      Date.now() + data.expires_in * 1000 - 5 * 60 * 1000;

    return account;
  }

  public markRateLimited(
    accountId: string,
    durationMs?: number,
    reason: string = "rate_limit",
  ): AnthropicAccount | null {
    this.reloadFromDisk();
    const now = Date.now();
    const effectiveDurationMs = durationMs ?? this.config.defaultCooldownMs;
    const acc = this.config.accounts.find((a) => a.id === accountId);
    if (acc) {
      acc.rateLimitedUntil = now + effectiveDurationMs;
      acc.rateLimitReason = reason;
      acc.stats.rateLimitCount = (acc.stats.rateLimitCount || 0) + 1;
      this.save();
      return acc;
    }
    return null;
  }

  public recordSuccess(accountId: string): void {
    this.reloadFromDisk();
    const acc = this.config.accounts.find((a) => a.id === accountId);
    if (acc) {
      acc.stats.successCount = (acc.stats.successCount || 0) + 1;
      acc.stats.lastUsedAt = Date.now();
      this.save();
    }
  }

  public recordError(accountId: string): void {
    this.reloadFromDisk();
    const acc = this.config.accounts.find((a) => a.id === accountId);
    if (acc) {
      acc.stats.errorCount = (acc.stats.errorCount || 0) + 1;
      this.save();
    }
  }

  public rotateToNext(): AnthropicAccount | null {
    this.reloadFromDisk();
    if (this.config.accounts.length === 0) return null;
    this.config.activeIndex =
      (this.config.activeIndex + 1) % this.config.accounts.length;
    const nextAcc = this.config.accounts[this.config.activeIndex];
    this.save();
    this.syncActiveAccountToPiAuth(nextAcc);
    return nextAcc;
  }

  public setActiveIndex(index: number): AnthropicAccount | null {
    this.reloadFromDisk();
    if (index >= 0 && index < this.config.accounts.length) {
      this.config.activeIndex = index;
      const acc = this.config.accounts[index];
      this.save();
      this.syncActiveAccountToPiAuth(acc);
      return acc;
    }
    return null;
  }

  public addAccount(account: Omit<AnthropicAccount, "stats" | "createdAt" | "rateLimitedUntil">): AnthropicAccount {
    this.reloadFromDisk();
    const fullAccount: AnthropicAccount = {
      ...account,
      rateLimitedUntil: 0,
      createdAt: Date.now(),
      stats: {
        successCount: 0,
        rateLimitCount: 0,
        errorCount: 0,
      },
    };
    this.config.accounts.push(fullAccount);
    this.config.activeIndex = this.config.accounts.length - 1;
    this.save();
    this.syncActiveAccountToPiAuth(fullAccount);
    return fullAccount;
  }

  public removeAccount(index: number): boolean {
    this.reloadFromDisk();
    if (index >= 0 && index < this.config.accounts.length) {
      this.config.accounts.splice(index, 1);
      if (this.config.activeIndex >= this.config.accounts.length) {
        this.config.activeIndex = Math.max(0, this.config.accounts.length - 1);
      }
      this.save();
      if (this.config.accounts.length > 0) {
        this.syncActiveAccountToPiAuth(this.config.accounts[this.config.activeIndex]);
      }
      return true;
    }
    return false;
  }

  public renameAccount(index: number, email: string): boolean {
    this.reloadFromDisk();
    const account = this.config.accounts[index];
    if (!account || !email.trim()) return false;
    account.name = email.trim();
    account.email = email.trim();
    this.save();
    return true;
  }

  public clearCooldown(index: number): boolean {
    this.reloadFromDisk();
    if (index >= 0 && index < this.config.accounts.length) {
      this.config.accounts[index].rateLimitedUntil = 0;
      delete this.config.accounts[index].rateLimitReason;
      this.save();
      return true;
    }
    return false;
  }
}
