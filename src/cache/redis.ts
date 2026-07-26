import { createClient, type RedisClientType } from "redis";
import type {
  Cache,
  CacheReadiness,
  FixedWindowResult,
  FixedWindowRule,
  OneTimeValueResult,
} from "./types.js";
import { validateCacheEntry, validateFixedWindow, validateOneTimeValue } from "./types.js";

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

const CONSUME_ONE_TIME_VALUE_SCRIPT = `
local stored = redis.call("GET", KEYS[1])
if not stored then
  return { 0, 0 }
end

local value = stored
local attempts = 0
local decoded_ok, state = pcall(cjson.decode, stored)
if decoded_ok and type(state) == "table" and state.__one_time == 1 then
  value = tostring(state.value or "")
  attempts = tonumber(state.attempts) or 0
end

local max_attempts = tonumber(ARGV[2])
if value == ARGV[1] then
  redis.call("DEL", KEYS[1])
  return { 1, math.max(0, max_attempts - attempts) }
end

attempts = attempts + 1
local remaining = math.max(0, max_attempts - attempts)
if remaining == 0 then
  redis.call("DEL", KEYS[1])
  return { -2, 0 }
end

local ttl = redis.call("TTL", KEYS[1])
if ttl <= 0 then
  redis.call("DEL", KEYS[1])
  return { 0, 0 }
end
redis.call("SET", KEYS[1], cjson.encode({ __one_time = 1, value = value, attempts = attempts }), "EX", ttl)
return { -1, remaining }
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

  async consumeOneTimeValue(
    key: string,
    expectedValue: string,
    maxAttempts: number,
  ): Promise<OneTimeValueResult> {
    validateOneTimeValue(key, expectedValue, maxAttempts);
    const result = await this.client.withCommandOptions({
      abortSignal: AbortSignal.timeout(this.commandTimeoutMs),
    }).eval(CONSUME_ONE_TIME_VALUE_SCRIPT, {
      keys: [key],
      arguments: [expectedValue, String(maxAttempts)],
    });
    if (!Array.isArray(result) || result.length !== 2 || result.some((value) => typeof value !== "number")) {
      throw new Error("Redis one-time value response was invalid");
    }
    const status = result[0] === 1
      ? "consumed"
      : result[0] === -1
        ? "mismatch"
        : result[0] === -2
          ? "exhausted"
          : "missing";
    return { status, remainingAttempts: result[1] as number };
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
