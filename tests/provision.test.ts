import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { createPgliteDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { parseProvisionOwnerEnv, provisionOwner } from "../src/provision.js";

describe("owner provisioning", () => {
  it("validates required secret input without exposing it", () => {
    expect(() => parseProvisionOwnerEnv({
      PROVISION_TENANT_NAME: "New tenant",
      PROVISION_OWNER_PHONE: "13800009999",
      PROVISION_OWNER_NAME: "Owner",
      PROVISION_OWNER_PASSWORD: "short",
    } as NodeJS.ProcessEnv)).toThrow(/12/);
    expect(() => parseProvisionOwnerEnv({
      PROVISION_TENANT_NAME: "New tenant",
      PROVISION_TENANT_TIMEZONE: "Not\/A-Timezone",
      PROVISION_OWNER_PHONE: "13800009999",
      PROVISION_OWNER_NAME: "Owner",
      PROVISION_OWNER_PASSWORD: "a-secure-password-2026",
    } as NodeJS.ProcessEnv)).toThrow(/timezone/);
  });

  it("creates one owner with a bcrypt hash, membership, and audit record", async () => {
    const database = await createPgliteDatabase(":memory:");
    try {
      await migrate(database);
      const password = "a-secure-password-2026";
      const result = await provisionOwner(database, {
        tenantName: "Provisioned Trade Co",
        tenantTimezone: "Asia/Shanghai",
        ownerPhone: "13800009999",
        ownerName: "Initial Owner",
        ownerPassword: password,
      });
      const user = await database.query<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE id = $1",
        [result.userId],
      );
      const membership = await database.query<{ role: string }>(
        "SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2",
        [result.tenantId, result.userId],
      );
      const audit = await database.query<{ action: string }>(
        "SELECT action FROM audit_logs WHERE tenant_id = $1",
        [result.tenantId],
      );
      expect(user.rows[0]?.password_hash).not.toBe(password);
      expect(await bcrypt.compare(password, user.rows[0]?.password_hash ?? "")).toBe(true);
      expect(membership.rows[0]?.role).toBe("owner");
      expect(audit.rows[0]?.action).toBe("tenant.provisioned");

      await expect(provisionOwner(database, {
        tenantName: "Different tenant",
        tenantTimezone: "Asia/Shanghai",
        ownerPhone: "13800009999",
        ownerName: "Duplicate phone",
        ownerPassword: "another-secure-password",
      })).rejects.toMatchObject({ code: "OWNER_PHONE_ALREADY_EXISTS" });
      await expect(provisionOwner(database, {
        tenantName: "provisioned trade co",
        tenantTimezone: "Asia/Shanghai",
        ownerPhone: "13900009999",
        ownerName: "Duplicate tenant",
        ownerPassword: "another-secure-password",
      })).rejects.toMatchObject({ code: "TENANT_ALREADY_EXISTS" });
      const tenants = await database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM tenants");
      expect(Number(tenants.rows[0]?.count)).toBe(1);
    } finally {
      await database.close();
    }
  });
});
