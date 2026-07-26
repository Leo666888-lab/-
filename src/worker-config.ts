import "dotenv/config";
import { z } from "zod";

const NOTIFICATION_SEND_BUDGET_SECONDS = 15;
const NOTIFICATION_LEASE_MARGIN_SECONDS = 30;

function hasRequiredPostgresSsl(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    const modes = url.searchParams.getAll("sslmode").map((value) => value.trim().toLowerCase());
    return modes.length === 1 && ["require", "verify-ca", "verify-full"].includes(modes[0] ?? "");
  } catch {
    return false;
  }
}

const workerConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url().optional(),
  PGLITE_DATA_DIR: z.string().default(".pglite"),
  NOTIFICATION_PROVIDER: z.enum(["fake", "aliyun"]).default("fake"),
  NOTIFICATION_WORKER_NAME: z.string().trim().min(1).max(100).default("settlement-reminders"),
  NOTIFICATION_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(300_000).default(5_000),
  NOTIFICATION_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(5),
  NOTIFICATION_LEASE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(120),
  NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  ALIYUN_SMS_REGION_ID: z.string().trim().min(1).max(64).default("cn-hangzhou"),
  ALIYUN_SMS_ENDPOINT: z.string().trim().regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,
    "ALIYUN_SMS_ENDPOINT must be a DNS hostname",
  ).default("dysmsapi.aliyuncs.com"),
  ALIYUN_SMS_SIGN_NAME: z.string().trim().min(1).max(100).optional(),
  ALIYUN_SMS_DIGEST_TEMPLATE_CODE: z.string().trim().regex(/^SMS_\d+$/).optional(),
  RELEASE_ID: z.string().trim().min(1).max(100).default("development"),
}).superRefine((config, context) => {
  const minimumLeaseSeconds = config.NOTIFICATION_BATCH_SIZE * NOTIFICATION_SEND_BUDGET_SECONDS
    + NOTIFICATION_LEASE_MARGIN_SECONDS;
  if (config.NOTIFICATION_LEASE_SECONDS < minimumLeaseSeconds) {
    context.addIssue({
      code: "custom",
      path: ["NOTIFICATION_LEASE_SECONDS"],
      message: `NOTIFICATION_LEASE_SECONDS=${config.NOTIFICATION_LEASE_SECONDS} is too short for `
        + `NOTIFICATION_BATCH_SIZE=${config.NOTIFICATION_BATCH_SIZE}; use at least ${minimumLeaseSeconds} seconds `
        + `(${NOTIFICATION_SEND_BUDGET_SECONDS} seconds per SMS plus a `
        + `${NOTIFICATION_LEASE_MARGIN_SECONDS}-second safety margin)`,
    });
  }
  if (config.NOTIFICATION_PROVIDER === "aliyun") {
    if (!config.ALIYUN_SMS_SIGN_NAME) {
      context.addIssue({
        code: "custom",
        path: ["ALIYUN_SMS_SIGN_NAME"],
        message: "Aliyun notification worker requires an approved SMS sign",
      });
    }
    if (!config.ALIYUN_SMS_DIGEST_TEMPLATE_CODE) {
      context.addIssue({
        code: "custom",
        path: ["ALIYUN_SMS_DIGEST_TEMPLATE_CODE"],
        message: "Aliyun notification worker requires an approved digest template",
      });
    }
  }
  if (config.NODE_ENV !== "production") return;
  if (!config.DATABASE_URL || !/^postgres(?:ql)?:\/\//i.test(config.DATABASE_URL)) {
    context.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message: "production notification worker requires PostgreSQL",
    });
  } else if (!hasRequiredPostgresSsl(config.DATABASE_URL)) {
    context.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message: "production notification worker DATABASE_URL must contain exactly one sslmode=require, verify-ca, or verify-full",
    });
  }
  if (config.NOTIFICATION_PROVIDER !== "aliyun") {
    context.addIssue({
      code: "custom",
      path: ["NOTIFICATION_PROVIDER"],
      message: "production notification worker requires the Aliyun provider",
    });
  }
  if (!/^[0-9a-f]{40}$/.test(config.RELEASE_ID)) {
    context.addIssue({
      code: "custom",
      path: ["RELEASE_ID"],
      message: "production notification worker requires a 40-character Git release SHA",
    });
  }
});

export type NotificationWorkerConfig = z.infer<typeof workerConfigSchema>;

export function loadNotificationWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): NotificationWorkerConfig {
  return workerConfigSchema.parse(env);
}
