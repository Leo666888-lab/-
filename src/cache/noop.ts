import type { Cache, CacheReadiness, FixedWindowResult, FixedWindowRule } from "./types.js";
import { validateCacheEntry, validateFixedWindow } from "./types.js";

interface LocalWindow {
  count: number;
  expiresAt: number;
}

export class NoopCache implements Cache {
  private readonly fixedWindows = new Map<string, LocalWindow>();

  async get(key: string): Promise<null> {
    validateCacheEntry(key);
    return null;
  }

  async set(key: string, _value: string, ttlSeconds: number): Promise<void> {
    validateCacheEntry(key, ttlSeconds);
  }

  async setIfAbsent(key: string, _value: string, ttlSeconds: number): Promise<boolean> {
    validateCacheEntry(key, ttlSeconds);
    return true;
  }

  async delete(key: string): Promise<boolean> {
    validateCacheEntry(key);
    return false;
  }

  async consumeFixedWindow(
    rules: readonly FixedWindowRule[],
    windowSeconds: number,
  ): Promise<FixedWindowResult> {
    validateFixedWindow(rules, windowSeconds);
    const now = Date.now();
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
    return { allowed, remaining, retryAfterSeconds };
  }

  async readiness(): Promise<CacheReadiness> {
    return { provider: "none", status: "disabled" };
  }

  async close(): Promise<void> {
    this.fixedWindows.clear();
  }
}
