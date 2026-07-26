import bcrypt from "bcryptjs";
import { z } from "zod";
import type { Database } from "./db/types.js";
import { writeAudit } from "./lib/audit.js";
import { ApiError } from "./lib/errors.js";
import { normalizePhone } from "./lib/phone.js";
import { newId } from "./lib/security.js";

const ownerPhoneSchema = z.string().max(64).transform((value, context) => {
  const normalized = normalizePhone(value);
  if (!normalized) {
    context.addIssue({ code: "custom", message: "invalid owner phone" });
    return z.NEVER;
  }
  return normalized;
});

const provisionOwnerSchema = z.object({
  tenantName: z.string().trim().min(1).max(200),
  tenantTimezone: z.string().trim().min(1).max(100).default("Asia/Shanghai"),
  ownerPhone: ownerPhoneSchema,
  ownerName: z.string().trim().min(1).max(100),
  ownerPassword: z.string().min(12).max(128),
}).strict().superRefine((input, context) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.tenantTimezone }).format();
  } catch {
    context.addIssue({ code: "custom", path: ["tenantTimezone"], message: "invalid IANA timezone" });
  }
});

export type ProvisionOwnerInput = z.infer<typeof provisionOwnerSchema>;

export function parseProvisionOwnerEnv(env: NodeJS.ProcessEnv = process.env): ProvisionOwnerInput {
  return provisionOwnerSchema.parse({
    tenantName: env.PROVISION_TENANT_NAME,
    tenantTimezone: env.PROVISION_TENANT_TIMEZONE ?? "Asia/Shanghai",
    ownerPhone: env.PROVISION_OWNER_PHONE,
    ownerName: env.PROVISION_OWNER_NAME,
    ownerPassword: env.PROVISION_OWNER_PASSWORD,
  });
}

export async function provisionOwner(database: Database, rawInput: ProvisionOwnerInput) {
  const input = provisionOwnerSchema.parse(rawInput);
  const passwordHash = await bcrypt.hash(input.ownerPassword, 12);
  const tenantId = newId();
  const userId = newId();

  await database.transaction(async (tx) => {
    const lockKeys = [
      `provision-owner:tenant:${input.tenantName.toLowerCase()}`,
      `provision-owner:phone:${input.ownerPhone}`,
    ].sort();
    for (const lockKey of lockKeys) {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
    }
    const existingTenant = await tx.query(
      "SELECT id FROM tenants WHERE lower(name) = lower($1) LIMIT 1",
      [input.tenantName],
    );
    if (existingTenant.rowCount) throw new ApiError(409, "TENANT_ALREADY_EXISTS", "企业名称已存在");
    const existingUser = await tx.query(
      "SELECT id FROM users WHERE phone = $1 LIMIT 1",
      [input.ownerPhone],
    );
    if (existingUser.rowCount) throw new ApiError(409, "OWNER_PHONE_ALREADY_EXISTS", "负责人手机号已存在");

    await tx.query(
      "INSERT INTO tenants (id, name, timezone) VALUES ($1, $2, $3)",
      [tenantId, input.tenantName, input.tenantTimezone],
    );
    await tx.query(
      `INSERT INTO users (id, phone, display_name, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [userId, input.ownerPhone, input.ownerName, passwordHash],
    );
    await tx.query(
      "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')",
      [tenantId, userId],
    );
    await writeAudit(tx, {
      tenantId,
      actorUserId: userId,
      action: "tenant.provisioned",
      entityType: "tenant",
      entityId: tenantId,
      metadata: { ownerUserId: userId },
    });
  });

  return { tenantId, userId };
}
