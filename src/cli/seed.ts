import { loadConfig } from "../config.js";
import { createDatabase } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { seedDemo } from "../seed.js";

const config = loadConfig();
if (config.NODE_ENV === "production") throw new Error("Demo seeding is disabled in production");
const database = await createDatabase({ databaseUrl: config.DATABASE_URL, pgliteDataDir: config.PGLITE_DATA_DIR });
try {
  await migrate(database);
  await seedDemo(database);
  console.log("Demo tenant and account seeded: 13800000000 / demo1234");
} finally {
  await database.close();
}
