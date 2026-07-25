import { NoopCache } from "./noop.js";
import { createRedisCache } from "./redis.js";
import type { Cache } from "./types.js";

export async function createCache(options: {
  redisUrl?: string;
  keyPrefix?: string;
  connectTimeoutMs?: number;
} = {}): Promise<Cache> {
  if (!options.redisUrl) return new NoopCache();
  return createRedisCache({
    url: options.redisUrl,
    keyPrefix: options.keyPrefix ?? "siyan-settlement:development:",
    connectTimeoutMs: options.connectTimeoutMs ?? 5_000,
  });
}

export { registerDependencyReadiness } from "./health.js";
export { NoopCache } from "./noop.js";
export type {
  Cache,
  CacheDependencyStatus,
  CacheReadiness,
  FixedWindowResult,
  FixedWindowRule,
} from "./types.js";
