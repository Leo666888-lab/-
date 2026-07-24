import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./types.js";

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const projectRoot = basename(moduleRoot) === "dist" ? dirname(moduleRoot) : moduleRoot;

export async function migrate(database: Database, migrationsDir = resolve(projectRoot, "migrations")): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  const migrations: Array<{ name: string; sql: string; checksum: string }> = [];
  for (const name of files) {
    const sql = await readFile(resolve(migrationsDir, name), "utf8");
    migrations.push({
      name,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  const byName = new Map(migrations.map((migration) => [migration.name, migration]));

  await database.transaction(async (tx) => {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["settlement-commercial:schema-migrations"],
    );
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum char(64),
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await tx.exec("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum char(64)");

    const applied = await tx.query<{ name: string; checksum: string | null }>(
      "SELECT name, checksum FROM schema_migrations ORDER BY name",
    );
    const appliedNames = new Set<string>();
    for (const row of applied.rows) {
      const migration = byName.get(row.name);
      if (!migration) {
        throw new Error(`Applied migration file is missing: ${row.name}`);
      }
      appliedNames.add(row.name);
      if (row.checksum === null) {
        await tx.query(
          "UPDATE schema_migrations SET checksum = $2 WHERE name = $1 AND checksum IS NULL",
          [row.name, migration.checksum],
        );
      } else if (row.checksum.trim() !== migration.checksum) {
        throw new Error(`Migration checksum mismatch: ${row.name}`);
      }
    }

    for (const migration of migrations) {
      if (appliedNames.has(migration.name)) continue;
      await tx.exec(migration.sql);
      await tx.query(
        "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
        [migration.name, migration.checksum],
      );
    }
  });
}
