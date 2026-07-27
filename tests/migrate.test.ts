import { appendFile, copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createPgliteDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";

const migrationsDir = resolve(process.cwd(), "migrations");

describe("migration integrity", () => {
  it("records checksums and rejects modified historical SQL", async () => {
    const database = await createPgliteDatabase(":memory:");
    const copiedDir = await mkdtemp(join(tmpdir(), "settlement-migrations-"));
    try {
      await migrate(database);
      const applied = await database.query<{ name: string; checksum: string }>(
        "SELECT name, checksum FROM schema_migrations ORDER BY name",
      );
      expect(applied.rows).toHaveLength(10);
      expect(applied.rows.every((row) => row.checksum.trim().length === 64)).toBe(true);

      for (const name of (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql"))) {
        await copyFile(resolve(migrationsDir, name), resolve(copiedDir, name));
      }
      await appendFile(resolve(copiedDir, "001_initial.sql"), "\n-- unauthorized history edit\n", "utf8");
      await expect(migrate(database, copiedDir)).rejects.toThrow("Migration checksum mismatch: 001_initial.sql");
    } finally {
      await database.close();
      await rm(copiedDir, { recursive: true, force: true });
    }
  });

  it("upgrades the legacy migration table and hardens normal old-001 rows", async () => {
    const database = await createPgliteDatabase(":memory:");
    try {
      await database.exec(`
        CREATE TABLE tenants (id uuid PRIMARY KEY, name text NOT NULL);
        CREATE TABLE partners (
          id uuid PRIMARY KEY,
          tenant_id uuid NOT NULL REFERENCES tenants(id),
          name text NOT NULL
        );
        CREATE TABLE orders (
          id uuid PRIMARY KEY,
          tenant_id uuid NOT NULL REFERENCES tenants(id),
          fulfillment_status varchar(16) NOT NULL DEFAULT 'planned',
          fulfilled_at timestamptz,
          due_at timestamptz,
          UNIQUE (tenant_id, id)
        );
        CREATE TABLE users (id uuid PRIMARY KEY);
        CREATE TABLE memberships (
          tenant_id uuid NOT NULL REFERENCES tenants(id),
          user_id uuid NOT NULL REFERENCES users(id),
          role varchar(16) NOT NULL,
          is_active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (tenant_id, user_id)
        );
        CREATE TABLE payments (
          id uuid PRIMARY KEY,
          tenant_id uuid NOT NULL,
          order_id uuid NOT NULL
        );
        CREATE TABLE reminders (
          id uuid PRIMARY KEY,
          tenant_id uuid NOT NULL REFERENCES tenants(id),
          order_id uuid NOT NULL,
          due_at timestamptz NOT NULL,
          status varchar(16) NOT NULL DEFAULT 'open',
          snoozed_until timestamptz,
          acknowledged_at timestamptz,
          closed_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT reminders_order_tenant_fk FOREIGN KEY (tenant_id, order_id)
            REFERENCES orders(tenant_id, id)
        );
        CREATE TABLE audit_logs (
          id uuid PRIMARY KEY,
          tenant_id uuid NOT NULL
        );
        CREATE TABLE schema_migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO tenants (id, name)
          VALUES ('11111111-1111-4111-8111-111111111111', 'Legacy tenant');
        INSERT INTO partners (id, tenant_id, name)
          VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'Legacy partner');
        INSERT INTO orders (id, tenant_id, fulfillment_status)
          VALUES ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'planned');
        INSERT INTO schema_migrations (name)
          VALUES ('001_initial.sql'), ('002_partner_version.sql');
      `);

      await migrate(database);
      const tenant = await database.query<{ timezone: string }>("SELECT timezone FROM tenants");
      const partner = await database.query<{ version: number }>("SELECT version FROM partners");
      const userColumns = await database.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'users' AND column_name = 'phone_verified_at'`,
      );
      const migrations = await database.query<{ checksum: string }>("SELECT checksum FROM schema_migrations");
      expect(tenant.rows[0]?.timezone).toBe("Asia/Shanghai");
      expect(Number(partner.rows[0]?.version)).toBe(1);
      expect(userColumns.rowCount).toBe(1);
      expect(migrations.rows).toHaveLength(10);
      expect(migrations.rows.every((row) => row.checksum.trim().length === 64)).toBe(true);

      await expect(database.query(
        `INSERT INTO orders (id, tenant_id, fulfillment_status)
         VALUES ('44444444-4444-4444-8444-444444444444',
                 '11111111-1111-4111-8111-111111111111', 'fulfilled')`,
      )).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
});
