import type {
  Cache,
  CacheReadiness,
  FixedWindowResult,
  FixedWindowRule,
  OneTimeValueResult,
} from "./types.js";
import { validateCacheEntry, validateFixedWindow, validateOneTimeValue } from "./types.js";

interface LocalEntry {
  value: string;
  expiresAt: number;
}

interface LocalWindow {
  count: number;
  expiresAt: number;
}

export class MemoryCache implements Cache {
  private readonly entries = new Map<string, LocalEntry>();
  private readonly fixedWindows = new Map<string, LocalWindow>();
  private readonly oneTimeAttempts = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<string | null> {
    validateCacheEntry(key);
    return this.activeEntry(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    validateCacheEntry(key, ttlSeconds);
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1_000 });
    this.oneTimeAttempts.delete(key);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    validateCacheEntry(key, ttlSeconds);
    if (this.activeEntry(key)) return false;
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1_000 });
    this.oneTimeAttempts.delete(key);
    return true;
  }

  async delete(key: string): Promise<boolean> {
    validateCacheEntry(key);
    this.oneTimeAttempts.delete(key);
    return this.entries.delete(key);
  }

  async consumeFixedWindow(
    rules: readonly FixedWindowRule[],
    windowSeconds: number,
  ): Promise<FixedWindowResult> {
    validateFixedWindow(rules, windowSeconds);
    const now = this.now();
    let allowed = true;
    let remaining = Number.POSITIVE_INFINITY;
    let retryAfterSeconds = 0;

    for (const rule of rules) {
      const current = this.fixedWindows.get(rule.key);
      const window = !current || current.expiresAt <= now
        ? { count: 1, expiresAt: now + windowSeconds * 1_000 }
        : { count: current.count + 1, expiresAt: current.expiresAt };
      this.fixedWindows.set(rule.key, window);
      remaining = Math.min(remaining, Math.max(0, rule.limit - window.count));
      if (window.count > rule.limit) {
        allowed = false;
        retryAfterSeconds = Math.max(retryAfterSeconds, Math.max(1, Math.ceil((window.expiresAt - now) / 1_000)));
      }
    }

    this.compact(now);
    return { allowed, remaining, retryAfterSeconds };
  }

  async consumeOneTimeValue(
    key: string,
    expectedValue: string,
    maxAttempts: number,
  ): Promise<OneTimeValueResult> {
    validateOneTimeValue(key, expectedValue, maxAttempts);
    const entry = this.activeEntry(key);
    if (!entry) return { status: "missing", remainingAttempts: 0 };
    if (entry.value === expectedValue) {
      const attempts = this.oneTimeAttempts.get(key) ?? 0;
      this.entries.delete(key);
      this.oneTimeAttempts.delete(key);
      return { status: "consumed", remainingAttempts: Math.max(0, maxAttempts - attempts) };
    }

    const attempts = (this.oneTimeAttempts.get(key) ?? 0) + 1;
    const remainingAttempts = Math.max(0, maxAttempts - attempts);
    if (remainingAttempts === 0) {
      this.entries.delete(key);
      this.oneTimeAttempts.delete(key);
      return { status: "exhausted", remainingAttempts: 0 };
    }
    this.oneTimeAttempts.set(key, attempts);
    return { status: "mismatch", remainingAttempts };
  }

  async readiness(): Promise<CacheReadiness> {
    return { provider: "none", status: "disabled" };
  }

  async close(): Promise<void> {
    this.entries.clear();
    this.fixedWindows.clear();
    this.oneTimeAttempts.clear();
  }

  private activeEntry(key: string): LocalEntry | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) return entry;
    if (entry) {
      this.entries.delete(key);
      this.oneTimeAttempts.delete(key);
    }
    return undefined;
  }

  private compact(now: number): void {
    if (this.entries.size > 30_000) {
      for (const [key, entry] of this.entries) {
        if (entry.expiresAt <= now) {
          this.entries.delete(key);
          this.oneTimeAttempts.delete(key);
        }
      }
      while (this.entries.size > 30_000) {
        const oldestKey = this.entries.keys().next().value as string | undefined;
        if (!oldestKey) break;
        this.entries.delete(oldestKey);
        this.oneTimeAttempts.delete(oldestKey);
      }
    }
    if (this.fixedWindows.size > 30_000) {
      for (const [key, window] of this.fixedWindows) {
        if (window.expiresAt <= now) this.fixedWindows.delete(key);
      }
      while (this.fixedWindows.size > 30_000) {
        const oldestKey = this.fixedWindows.keys().next().value as string | undefined;
        if (!oldestKey) break;
        this.fixedWindows.delete(oldestKey);
      }
    }
  }
}
