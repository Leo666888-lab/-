import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createCache,
  MemoryCache,
  NoopCache,
  registerDependencyReadiness,
  type Cache,
  type CacheReadiness,
  type FixedWindowResult,
  type FixedWindowRule,
  type OneTimeValueResult,
} from "../src/cache/index.js";

class ReadinessCache implements Cache {
  constructor(private readonly state: CacheReadiness) {}
  async get(): Promise<null> { return null; }
  async set(): Promise<void> {}
  async setIfAbsent(): Promise<boolean> { return true; }
  async delete(): Promise<boolean> { return false; }
  async consumeFixedWindow(): Promise<FixedWindowResult> {
    return { allowed: true, remaining: 1, retryAfterSeconds: 0 };
  }
  async consumeOneTimeValue(): Promise<OneTimeValueResult> {
    return { status: "missing", remainingAttempts: 0 };
  }
  async readiness(): Promise<CacheReadiness> { return this.state; }
  async close(): Promise<void> {}
}

describe("cache infrastructure", () => {
  it("uses an explicit disabled cache when REDIS_URL is omitted", async () => {
    const cache = await createCache();
    expect(cache).toBeInstanceOf(NoopCache);
    expect(await cache.get("verification:phone")).toBeNull();
    expect(await cache.setIfAbsent("reminder:job", "1", 60)).toBe(true);
    expect(await cache.delete("session:id")).toBe(false);
    expect(await cache.readiness()).toEqual({ provider: "none", status: "disabled" });
  });

  it("applies local fixed-window limits atomically for development", async () => {
    const cache = new NoopCache();
    const rules: FixedWindowRule[] = [{ key: "login:test", limit: 2 }];
    const attempts = await Promise.all([
      cache.consumeFixedWindow(rules, 60),
      cache.consumeFixedWindow(rules, 60),
      cache.consumeFixedWindow(rules, 60),
    ]);
    expect(attempts.map((attempt) => attempt.allowed)).toEqual([true, true, false]);
    expect(attempts[2]).toMatchObject({ remaining: 0, retryAfterSeconds: 60 });
  });

  it("atomically validates, limits, expires, and consumes in-memory one-time values", async () => {
    let now = 1_000;
    const cache = new MemoryCache(() => now);
    await cache.set("verification:first", "expected", 60);
    expect(await cache.consumeOneTimeValue("verification:first", "wrong", 2)).toEqual({
      status: "mismatch",
      remainingAttempts: 1,
    });
    expect(await cache.consumeOneTimeValue("verification:first", "expected", 2)).toEqual({
      status: "consumed",
      remainingAttempts: 1,
    });
    expect(await cache.consumeOneTimeValue("verification:first", "expected", 2)).toEqual({
      status: "missing",
      remainingAttempts: 0,
    });

    await cache.set("verification:concurrent", "value", 60);
    const concurrent = await Promise.all([
      cache.consumeOneTimeValue("verification:concurrent", "value", 3),
      cache.consumeOneTimeValue("verification:concurrent", "value", 3),
    ]);
    expect(concurrent.map((result) => result.status).sort()).toEqual(["consumed", "missing"]);

    await cache.set("verification:exhausted", "value", 60);
    expect((await cache.consumeOneTimeValue("verification:exhausted", "wrong", 1)).status).toBe("exhausted");
    await cache.set("verification:expired", "value", 1);
    now += 1_001;
    expect((await cache.consumeOneTimeValue("verification:expired", "value", 3)).status).toBe("missing");
  });

  it("rejects an unavailable Redis dependency without disclosing its URL", async () => {
    const url = "redis://default:do-not-leak@127.0.0.1:1/0";
    let failure: Error | undefined;
    try {
      await createCache({ redisUrl: url, connectTimeoutMs: 100 });
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toBe("Redis dependency connection failed");
    expect(String(failure)).not.toContain("do-not-leak");
  });

  it.each([
    [{ provider: "redis", status: "ready" } satisfies CacheReadiness, 200, "ok"],
    [{ provider: "none", status: "disabled" } satisfies CacheReadiness, 200, "ok"],
    [{ provider: "redis", status: "unavailable" } satisfies CacheReadiness, 200, "degraded"],
  ])("reports dependency readiness without connection details", async (state, statusCode, status) => {
    const app = Fastify();
    app.get("/api/health", async () => ({ status: "ok", time: "2026-07-25T00:00:00.000Z" }));
    registerDependencyReadiness(app, new ReadinessCache(state));

    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({
      status,
      time: "2026-07-25T00:00:00.000Z",
      dependencies: {
        database: { status: "ready" },
        cache: state,
      },
    });
    expect(response.body).not.toMatch(/redis:\/\//);
    await app.close();
  });

  it("marks the database unavailable when the underlying health handler fails", async () => {
    const app = Fastify();
    app.setErrorHandler((_error, _request, reply) => {
      void reply.status(500).send({ error: { code: "INTERNAL_ERROR" } });
    });
    app.get("/api/health", async () => {
      throw new Error("database unavailable");
    });
    registerDependencyReadiness(app, new ReadinessCache({ provider: "redis", status: "ready" }));

    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json().dependencies).toEqual({
      database: { status: "unavailable" },
      cache: { provider: "redis", status: "ready" },
    });
    await app.close();
  });
});

it.skipIf(!process.env.TEST_REDIS_URL)("shares atomic limits across real Redis clients and isolates namespaces", async () => {
  const redisUrl = process.env.TEST_REDIS_URL as string;
  const namespace = `siyan-settlement:test:${randomUUID()}:`;
  const first = await createCache({ redisUrl, keyPrefix: namespace, connectTimeoutMs: 2_000 });
  const second = await createCache({ redisUrl, keyPrefix: namespace, connectTimeoutMs: 2_000 });
  const isolated = await createCache({ redisUrl, keyPrefix: `${namespace}isolated:`, connectTimeoutMs: 2_000 });
  try {
    await first.set("namespace", "shared", 60);
    expect(await second.get("namespace")).toBe("shared");
    expect(await isolated.get("namespace")).toBeNull();

    const rules = [{ key: "fixed-window", limit: 1 }];
    const attempts = await Promise.all([
      first.consumeFixedWindow(rules, 60),
      second.consumeFixedWindow(rules, 60),
    ]);
    expect(attempts.filter((attempt) => attempt.allowed)).toHaveLength(1);
    expect(attempts.filter((attempt) => !attempt.allowed)).toHaveLength(1);

    await first.set("one-time", "expected", 60);
    const consumed = await Promise.all([
      first.consumeOneTimeValue("one-time", "expected", 3),
      second.consumeOneTimeValue("one-time", "expected", 3),
    ]);
    expect(consumed.filter((result) => result.status === "consumed")).toHaveLength(1);
    expect(consumed.filter((result) => result.status === "missing")).toHaveLength(1);
  } finally {
    await Promise.allSettled([
      first.delete("namespace"),
      first.delete("fixed-window"),
      first.delete("one-time"),
      isolated.delete("namespace"),
    ]);
    await Promise.allSettled([first.close(), second.close(), isolated.close()]);
  }
});
