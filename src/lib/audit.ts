import type { Queryable } from "../db/types.js";
import { newId } from "./security.js";

export async function writeAudit(
  database: Queryable,
  input: {
    tenantId: string;
    actorUserId: string;
    action: string;
    entityType: string;
    entityId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await database.query(
    `INSERT INTO audit_logs (id, tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [newId(), input.tenantId, input.actorUserId, input.action, input.entityType, input.entityId, JSON.stringify(input.metadata ?? {})],
  );
}
