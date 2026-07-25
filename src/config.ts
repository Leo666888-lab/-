import "dotenv/config";
import { z } from "zod";

const publicOriginSchema = z.string().url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
    message: "PUBLIC_ORIGIN must use http:// or https://",
  })
  .transform((value) => new URL(value).origin);

const redisUrlSchema = z.string().url()
  .refine((value) => ["redis:", "rediss:"].includes(new URL(value).protocol), {
    message: "REDIS_URL must use redis:// or rediss://",
  });

const redisKeyPrefixSchema = z.string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9:-]*:$/i, "REDIS_KEY_PREFIX must be a colon-terminated namespace");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(666),
  PUBLIC_ORIGIN: publicOriginSchema.optional(),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: redisUrlSchema.optional(),
  REDIS_KEY_PREFIX: redisKeyPrefixSchema.optional(),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  PGLITE_DATA_DIR: z.string().default(".pglite"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 365).default(168),
  BODY_LIMIT_BYTES: z.coerce.number().int().min(16_384).max(10_485_760).default(1_048_576),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1000).default(5),
  SEED_DEMO: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
}).superRefine((config, context) => {
  if (config.NODE_ENV !== "production") return;
  if (!config.DATABASE_URL || !/^postgres(?:ql)?:\/\//i.test(config.DATABASE_URL)) {
    context.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message: "production requires a postgres:// or postgresql:// DATABASE_URL",
    });
  }
  if (!config.REDIS_URL) {
    context.addIssue({
      code: "custom",
      path: ["REDIS_URL"],
      message: "production requires a redis:// or rediss:// REDIS_URL",
    });
  } else if (new URL(config.REDIS_URL).protocol !== "rediss:") {
    context.addIssue({
      code: "custom",
      path: ["REDIS_URL"],
      message: "production REDIS_URL must use rediss://",
    });
  }
  if (config.REDIS_KEY_PREFIX !== "siyan-settlement-666:production:") {
    context.addIssue({
      code: "custom",
      path: ["REDIS_KEY_PREFIX"],
      message: "production requires REDIS_KEY_PREFIX=siyan-settlement-666:production:",
    });
  }
  if (!config.PUBLIC_ORIGIN) {
    context.addIssue({
      code: "custom",
      path: ["PUBLIC_ORIGIN"],
      message: "production requires PUBLIC_ORIGIN",
    });
  } else if (!config.PUBLIC_ORIGIN.startsWith("https://")) {
    context.addIssue({
      code: "custom",
      path: ["PUBLIC_ORIGIN"],
      message: "production PUBLIC_ORIGIN must use https://",
    });
  }
  if (config.SEED_DEMO) {
    context.addIssue({
      code: "custom",
      path: ["SEED_DEMO"],
      message: "SEED_DEMO must be false in production",
    });
  }
}).transform((config) => ({
  ...config,
  PUBLIC_ORIGIN: config.PUBLIC_ORIGIN ?? "http://127.0.0.1:666",
  REDIS_KEY_PREFIX: config.REDIS_KEY_PREFIX ?? "siyan-settlement:development:",
}));

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
