import { loadConfig } from "../config.js";
import { createDatabase } from "../db/index.js";
import { migrate } from "../db/migrate.js";

const config = loadConfig();
const database = await createDatabase({
  databaseUrl: config.DATABASE_URL,
  pgliteDataDir: config.PGLITE_DATA_DIR,
  isProduction: config.NODE_ENV === "production",
});
try {
  await migrate(database);
  console.log("Database migrations applied.");
} finally {
  await database.close();
}
