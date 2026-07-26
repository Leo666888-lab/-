import { buildApp } from "./app.js";
import { createCache, registerDependencyReadiness } from "./cache/index.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { seedDemo } from "./seed.js";
import { AliyunSmsProvider } from "./sms/index.js";

const config = loadConfig();
const smsProvider = config.SMS_ENABLED
  ? new AliyunSmsProvider({
      endpoint: config.ALIYUN_SMS_ENDPOINT,
      regionId: config.ALIYUN_SMS_REGION_ID,
      signName: config.ALIYUN_SMS_SIGN_NAME as string,
    })
  : undefined;
const cache = await createCache({
  redisUrl: config.REDIS_URL,
  keyPrefix: config.REDIS_KEY_PREFIX,
  connectTimeoutMs: config.REDIS_CONNECT_TIMEOUT_MS,
});
const database = await createDatabase({
  databaseUrl: config.DATABASE_URL,
  pgliteDataDir: config.PGLITE_DATA_DIR,
  isProduction: config.NODE_ENV === "production",
}).catch(async (error: unknown) => {
  await cache.close().catch(() => undefined);
  throw error;
});
try {
  // Production migrations run in the release's isolated CLI before activation.
  // Starting the web process must never mutate a database that may already have
  // been migrated by a newer release.
  if (config.NODE_ENV !== "production") {
    await migrate(database);
    if (config.SEED_DEMO) await seedDemo(database);
  }
} catch (error) {
  await Promise.allSettled([database.close(), cache.close()]);
  throw error;
}

const app = buildApp({
  database,
  cache,
  sessionTtlHours: config.SESSION_TTL_HOURS,
  bodyLimitBytes: config.BODY_LIMIT_BYTES,
  loginRateLimitMax: config.LOGIN_RATE_LIMIT_MAX,
  smsProvider,
  smsCodeHmacKey: config.SMS_CODE_HMAC_KEY,
  smsLoginTemplateCode: config.ALIYUN_SMS_LOGIN_TEMPLATE_CODE,
  smsCodeTtlSeconds: config.SMS_CODE_TTL_SECONDS,
  smsResendCooldownSeconds: config.SMS_RESEND_COOLDOWN_SECONDS,
  smsVerifyMaxAttempts: config.SMS_VERIFY_MAX_ATTEMPTS,
  smsSendRateLimitMax: config.SMS_SEND_RATE_LIMIT_MAX,
  smsSendRateLimitIpMax: config.SMS_SEND_RATE_LIMIT_IP_MAX,
  smsSendRateLimitWindowSeconds: config.SMS_SEND_RATE_LIMIT_WINDOW_SECONDS,
  publicOrigin: config.PUBLIC_ORIGIN,
  isProduction: config.NODE_ENV === "production",
  serveStatic: true,
  closeDatabase: true,
  logger: true,
});
registerDependencyReadiness(app, cache);
app.addHook("onClose", async () => cache.close());

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "graceful shutdown started");
  try {
    await app.close();
    app.log.info({ signal }, "graceful shutdown completed");
  } catch (error) {
    app.log.error({ error, signal }, "graceful shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  if (!shuttingDown) {
    app.log.error(error);
    await app.close();
    process.exitCode = 1;
  }
}
