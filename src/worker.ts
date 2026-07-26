import { createDatabase } from "./db/index.js";
import { AliyunSmsNotificationProvider } from "./notifications/aliyun-sms-provider.js";
import { FakeNotificationProvider } from "./notifications/fake-provider.js";
import type { NotificationProvider } from "./notifications/provider.js";
import { runNotificationWorker } from "./notifications/runtime.js";
import { AliyunSmsProvider } from "./sms/index.js";
import { loadNotificationWorkerConfig, type NotificationWorkerConfig } from "./worker-config.js";

function createProvider(config: NotificationWorkerConfig): NotificationProvider {
  if (config.NOTIFICATION_PROVIDER === "fake" && config.NODE_ENV !== "production") {
    return new FakeNotificationProvider();
  }
  if (config.NOTIFICATION_PROVIDER === "aliyun") {
    return new AliyunSmsNotificationProvider(new AliyunSmsProvider({
      endpoint: config.ALIYUN_SMS_ENDPOINT,
      regionId: config.ALIYUN_SMS_REGION_ID,
      signName: config.ALIYUN_SMS_SIGN_NAME as string,
    }), config.ALIYUN_SMS_DIGEST_TEMPLATE_CODE as string);
  }
  throw new Error("unsupported notification provider");
}

const config = loadNotificationWorkerConfig();
const database = await createDatabase({
  databaseUrl: config.DATABASE_URL,
  pgliteDataDir: config.PGLITE_DATA_DIR,
  isProduction: config.NODE_ENV === "production",
});
const abortController = new AbortController();
const stop = () => abortController.abort();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

let provider: NotificationProvider | undefined;
try {
  provider = createProvider(config);
  await runNotificationWorker({
    database,
    provider,
    workerName: config.NOTIFICATION_WORKER_NAME,
    releaseId: config.RELEASE_ID,
    pollIntervalMs: config.NOTIFICATION_POLL_INTERVAL_MS,
    batchSize: config.NOTIFICATION_BATCH_SIZE,
    leaseSeconds: config.NOTIFICATION_LEASE_SECONDS,
    maxAttempts: config.NOTIFICATION_MAX_ATTEMPTS,
    signal: abortController.signal,
    onError: () => process.stderr.write("notification worker cycle failed\n"),
  });
} finally {
  await provider?.close?.().catch(() => undefined);
  await database.close().catch(() => undefined);
}
