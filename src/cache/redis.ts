import { createClient, type RedisClientType } from "redis";
import type { Cache, CacheReadiness, FixedWindowResult, FixedWindowRule } from "./types.js";
import { validateCacheEntry, validateFixedWindow } from "./types.js";

const FIXED_WINDOW_SCRIPT = `
local window_seconds = tonumber(ARGV[1])
local allowed = 1
local remaining = nil
local retry_after = 0

for index, key in ipairs(KEYS) do
  local limit = tonumber(ARGV[index + 1])
  local count = redis.call("INCR", key)
  local ttl
  if count == 1 then
    redis.call("EXPIRE", key, window_seconds)
    ttl = window_seconds
  else
    ttl = redis.call("TTL", key)
    if ttl < 0 then
      redis.call("EXPIRE", key, window_seconds)
      ttl = window_seconds
    end
  end

  local key_remaining = limit - count
  if key_remaining < 0 then key_remaining = 0 end
  if remaining == nil or key_remaining < remaining then remaining = key_remaining end
  if count > limit then
    allowed = 0
    if ttl > retry_after then retry_after = ttl end
  end
end

return { allowed, remaining, retry_after }
`;

export class RedisCache implements Cache {
  constructor(
    private readonly client: RedisClientType,
    private readonly commandTimeoutMs: number,
  ) {}

  async get(key: string): Promise<string | null> {
    validateCacheEntry(key);
    return this.client.withCommandOptions({
      abortSignal: AbortSignal.timeout(this.commandTimeoutMs),
    }).get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    validateCacheEntry(key, ttlSeconds);
    await this.client.withCommandOptions({
      abortSignal: AbortSignal.timeout(this.commandTimeoutMs),
    }).set(key, value, {
      expiration: { type: "EX", value: ttlSeconds },
    });
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    validateCacheEntry(key, ttlSeconds);
    const result = await this.client.withCommandOptions({
      abortSignal: AbortSignal.timeout(this.commandTimeoutMs),
    }).set(key, value, {
      expiration: { type: "EX", value: ttlSeconds },
      condition: "NX",
    });
    return result === "OK";
  }

  async delete(key: string): Promise<boolean> {
    validateCacheEntry(key);
    return (await this.client.withCommandOptions({
      abortSignal: AbortSignal.timeout(this.commandTimeoutMs),
    }).del(key)) > 0;
  }

  async consumeFixedWindow(
    rules: readonly FixedWindowRule[],
    windowSeconds: number,
  ): Promise<FixedWindowResult> {
    validateFixedWindow(rules, windowSeconds);
    const result = await this.client.withCommandOptions({
      abortSignal: AbortSignal.timeout(this.commandTimeoutMs),
    }).eval(FIXED_WINDOW_SCRIPT, {
      keys: rules.map((rule) => rule.key),
      arguments: [String(windowSeconds), ...rules.map((rule) => String(rule.limit))],
    });
    if (!Array.isArray(result) || result.length !== 3 || result.some((value) => typeof value !== "number")) {
      throw new Error("Redis fixed-window response was invalid");
    }
    return {
      allowed: result[0] === 1,
      remaining: result[1] as number,
      retryAfterSeconds: result[2] as number,
    };
  }

  async readiness(): Promise<CacheReadiness> {
    if (!this.client.isReady) return { provider: "redis", status: "unavailable" };
    try {
      await this.client.withCommandOptions({
        abortSignal: AbortSignal.timeout(this.commandTimeoutMs),
      }).ping();
      return { provider: "redis", status: "ready" };
    } catch {
      return { provider: "redis", status: "unavailable" };
    }
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.close();
  }
}

export async function createRedisCache(options: {
  url: string;
  keyPrefix: string;
  connectTimeoutMs: number;
}): Promise<RedisCache> {
  let startupComplete = false;
  const client = createClient({
    url: options.url,
    keyPrefix: options.keyPrefix,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: options.connectTimeoutMs,
      reconnectStrategy(retries) {
        if (!startupComplete) return false;
        return Math.min(100 * (retries + 1), 3_000);
      },
    },
  });

  // The client requires an error listener. Readiness reports outages without exposing connection details.
  client.on("error", () => undefined);

  try {
    await client.connect();
    await client.withCommandOptions({
      abortSignal: AbortSignal.timeout(options.connectTimeoutMs),
    }).ping();
    startupComplete = true;
    return new RedisCache(client, options.connectTimeoutMs);
  } catch {
    if (client.isOpen) await client.close().catch(() => undefined);
    throw new Error("Redis dependency connection failed");
  }
}
