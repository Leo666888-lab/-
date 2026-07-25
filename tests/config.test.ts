import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

it("keeps demo seeding disabled unless explicitly enabled", () => {
  expect(loadConfig({} as NodeJS.ProcessEnv).SEED_DEMO).toBe(false);
  expect(loadConfig({ SEED_DEMO: "true" } as NodeJS.ProcessEnv).SEED_DEMO).toBe(true);
  expect(loadConfig({ REDIS_URL: "redis://127.0.0.1:6379" } as NodeJS.ProcessEnv).REDIS_URL)
    .toBe("redis://127.0.0.1:6379");
});

it("defaults production-facing HTTP settings and accepts environment overrides", () => {
  const defaults = loadConfig({} as NodeJS.ProcessEnv);
  expect(defaults.PORT).toBe(666);
  expect(defaults.HOST).toBe("0.0.0.0");
  expect(defaults.BODY_LIMIT_BYTES).toBe(1_048_576);
  expect(defaults.PUBLIC_ORIGIN).toBe("http://127.0.0.1:666");
  expect(defaults.REDIS_KEY_PREFIX).toBe("siyan-settlement:development:");

  const configured = loadConfig({
    PORT: "7777",
    NODE_ENV: "production",
    DATABASE_URL: "postgres://user:password@localhost:5432/settlement",
    REDIS_URL: "rediss://default:password@redis.example.test:6380/0",
    REDIS_KEY_PREFIX: "siyan-settlement-666:production:",
    PUBLIC_ORIGIN: "https://123.56.254.236:666/app?ignored=true",
  } as NodeJS.ProcessEnv);
  expect(configured.PORT).toBe(7777);
  expect(configured.NODE_ENV).toBe("production");
  expect(configured.PUBLIC_ORIGIN).toBe("https://123.56.254.236:666");
  expect(configured.REDIS_URL).toBe("rediss://default:password@redis.example.test:6380/0");
});

it("requires PostgreSQL, TLS Redis with a dedicated namespace, HTTPS, and disabled demo seeding in production", () => {
  expect(() => loadConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  expect(() => loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: "https://database.example.test/db",
    REDIS_URL: "rediss://redis.example.test:6379",
    REDIS_KEY_PREFIX: "siyan-settlement-666:production:",
    PUBLIC_ORIGIN: "https://123.56.254.236:666",
  } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  expect(() => loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://user:password@localhost:5432/settlement",
    REDIS_URL: "rediss://redis.example.test:6379",
    REDIS_KEY_PREFIX: "siyan-settlement-666:production:",
  } as NodeJS.ProcessEnv)).toThrow(/PUBLIC_ORIGIN/);
  expect(() => loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://user:password@localhost:5432/settlement",
    PUBLIC_ORIGIN: "https://123.56.254.236:666",
    REDIS_KEY_PREFIX: "siyan-settlement-666:production:",
  } as NodeJS.ProcessEnv)).toThrow(/REDIS_URL/);
  expect(() => loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://user:password@localhost:5432/settlement",
    REDIS_URL: "https://redis.example.test:6379",
    REDIS_KEY_PREFIX: "siyan-settlement-666:production:",
    PUBLIC_ORIGIN: "https://123.56.254.236:666",
  } as NodeJS.ProcessEnv)).toThrow(/redis:\/\/ or rediss:\/\//);
  expect(() => loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://user:password@localhost:5432/settlement",
    REDIS_URL: "redis://redis.example.test:6379",
    REDIS_KEY_PREFIX: "siyan-settlement-666:production:",
    PUBLIC_ORIGIN: "https://123.56.254.236:666",
  } as NodeJS.ProcessEnv)).toThrow(/rediss:\/\//);
  expect(() => loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://user:password@localhost:5432/settlement",
    REDIS_URL: "rediss://redis.example.test:6379",
    PUBLIC_ORIGIN: "https://123.56.254.236:666",
  } as NodeJS.ProcessEnv)).toThrow(/REDIS_KEY_PREFIX/);
  expect(() => loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://user:password@localhost:5432/settlement",
    REDIS_URL: "rediss://redis.example.test:6379",
    REDIS_KEY_PREFIX: "siyan-settlement-666:production:",
    PUBLIC_ORIGIN: "http://123.56.254.236:666",
  } as NodeJS.ProcessEnv)).toThrow(/https/);
  expect(() => loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://user:password@localhost:5432/settlement",
    REDIS_URL: "rediss://redis.example.test:6379",
    REDIS_KEY_PREFIX: "siyan-settlement-666:production:",
    PUBLIC_ORIGIN: "https://123.56.254.236:666",
    SEED_DEMO: "true",
  } as NodeJS.ProcessEnv)).toThrow(/SEED_DEMO/);

  const production = loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://user:password@localhost:5432/settlement",
    REDIS_URL: "rediss://default:password@redis.example.test:6380",
    REDIS_KEY_PREFIX: "siyan-settlement-666:production:",
    PUBLIC_ORIGIN: "https://123.56.254.236:666",
    SEED_DEMO: "false",
  } as NodeJS.ProcessEnv);
  expect(production.NODE_ENV).toBe("production");
});
