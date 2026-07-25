export type CacheDependencyStatus = "ready" | "disabled" | "unavailable";

export interface CacheReadiness {
  provider: "redis" | "none";
  status: CacheDependencyStatus;
}

export interface FixedWindowRule {
  key: string;
  limit: number;
}

export interface FixedWindowResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  consumeFixedWindow(rules: readonly FixedWindowRule[], windowSeconds: number): Promise<FixedWindowResult>;
  readiness(): Promise<CacheReadiness>;
  close(): Promise<void>;
}

export function validateFixedWindow(rules: readonly FixedWindowRule[], windowSeconds: number): void {
  if (!rules.length) throw new TypeError("fixed-window rules must not be empty");
  validateCacheEntry("fixed-window", windowSeconds);
  const keys = new Set<string>();
  for (const rule of rules) {
    validateCacheEntry(rule.key);
    if (!Number.isSafeInteger(rule.limit) || rule.limit <= 0) {
      throw new TypeError("fixed-window limit must be a positive integer");
    }
    if (keys.has(rule.key)) throw new TypeError("fixed-window keys must be unique");
    keys.add(rule.key);
  }
}

export function validateCacheEntry(key: string, ttlSeconds?: number): void {
  if (!key) throw new TypeError("cache key must not be empty");
  if (ttlSeconds !== undefined && (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0)) {
    throw new TypeError("cache TTL must be a positive integer");
  }
}
