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

function hasRequiredPostgresSsl(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    const modes = url.searchParams.getAll("sslmode").map((value) => value.trim().toLowerCase());
    return modes.length === 1 && ["require", "verify-ca", "verify-full"].includes(modes[0] ?? "");
  } catch {
    return false;
  }
}

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
  SMS_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  SMS_CODE_HMAC_KEY: z.string().min(32).max(1024).optional(),
  SMS_CODE_TTL_SECONDS: z.coerce.number().int().min(60).max(600).default(300),
  SMS_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(30).max(600).default(60),
  SMS_VERIFY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  SMS_SEND_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100).default(5),
  SMS_SEND_RATE_LIMIT_IP_MAX: z.coerce.number().int().min(1).max(1000).default(20),
  SMS_SEND_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3_600),
  ALIYUN_SMS_REGION_ID: z.string().trim().min(1).max(64).default("cn-hangzhou"),
  ALIYUN_SMS_ENDPOINT: z.string().trim().regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,
    "ALIYUN_SMS_ENDPOINT must be a DNS hostname",
  ).default("dysmsapi.aliyuncs.com"),
  ALIYUN_SMS_SIGN_NAME: z.string().trim().min(1).max(100).optional(),
  ALIYUN_SMS_LOGIN_TEMPLATE_CODE: z.string().trim().regex(/^SMS_\d+$/).optional(),
  SEED_DEMO: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
}).superRefine((config, context) => {
  if (config.SMS_ENABLED) {
    for (const [path, value, message] of [
      ["SMS_CODE_HMAC_KEY", config.SMS_CODE_HMAC_KEY, "SMS_CODE_HMAC_KEY is required when SMS is enabled"],
      ["ALIYUN_SMS_SIGN_NAME", config.ALIYUN_SMS_SIGN_NAME, "ALIYUN_SMS_SIGN_NAME is required when SMS is enabled"],
      ["ALIYUN_SMS_LOGIN_TEMPLATE_CODE", config.ALIYUN_SMS_LOGIN_TEMPLATE_CODE, "ALIYUN_SMS_LOGIN_TEMPLATE_CODE is required when SMS is enabled"],
    ] as const) {
      if (!value) context.addIssue({ code: "custom", path: [path], message });
    }
  }
  if (config.NODE_ENV !== "production") return;
  if (!config.DATABASE_URL || !/^postgres(?:ql)?:\/\//i.test(config.DATABASE_URL)) {
    context.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message: "production requires a postgres:// or postgresql:// DATABASE_URL",
    });
  } else if (!hasRequiredPostgresSsl(config.DATABASE_URL)) {
    context.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message: "production DATABASE_URL must contain exactly one sslmode=require, verify-ca, or verify-full",
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
