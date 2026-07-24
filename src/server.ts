import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { seedDemo } from "./seed.js";

const config = loadConfig();
const database = await createDatabase({
  databaseUrl: config.DATABASE_URL,
  pgliteDataDir: config.PGLITE_DATA_DIR,
  isProduction: config.NODE_ENV === "production",
});
await migrate(database);
if (config.SEED_DEMO) await seedDemo(database);

const app = buildApp({
  database,
  sessionTtlHours: config.SESSION_TTL_HOURS,
  bodyLimitBytes: config.BODY_LIMIT_BYTES,
  loginRateLimitMax: config.LOGIN_RATE_LIMIT_MAX,
  publicOrigin: config.PUBLIC_ORIGIN,
  isProduction: config.NODE_ENV === "production",
  serveStatic: true,
  closeDatabase: true,
  logger: true,
});

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
