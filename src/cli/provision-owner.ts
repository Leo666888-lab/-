import { loadConfig } from "../config.js";
import { createDatabase } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { parseProvisionOwnerEnv, provisionOwner } from "../provision.js";

const config = loadConfig();
const input = parseProvisionOwnerEnv();
const database = await createDatabase({
  databaseUrl: config.DATABASE_URL,
  pgliteDataDir: config.PGLITE_DATA_DIR,
  isProduction: config.NODE_ENV === "production",
});

try {
  await migrate(database);
  const result = await provisionOwner(database, input);
  console.log(`Provisioned tenant ${result.tenantId} with owner ${result.userId}.`);
} finally {
  await database.close();
}
