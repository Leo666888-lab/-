import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  createPgliteDatabase,
  createPostgresDatabase,
  type Database,
} from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { DEMO_IDS, seedDemo } from "../src/seed.js";

const PUBLIC_ORIGIN = "http://localhost";
const FOREIGN_TENANT_ID = "a1000000-0000-4000-8000-000000000001";

interface Fixture {
  app: FastifyInstance;
  database: Database;
  ownerToken: string;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function createTestDatabase(): Promise<Database> {
  const postgresUrl = process.env.TEST_NOTIFICATION_SETTINGS_DATABASE_URL;
  if (!postgresUrl) return createPgliteDatabase(":memory:");
  const databaseName = decodeURIComponent(new URL(postgresUrl).pathname.replace(/^\//, ""));
  if (!/(?:_ci|_test)$/.test(databaseName)) {
    throw new Error("TEST_NOTIFICATION_SETTINGS_DATABASE_URL must target a database ending in _ci or _test");
  }
  const database = await createPostgresDatabase(postgresUrl);
  const existing = await database.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'",
  );
  if (Number(existing.rows[0]?.count) !== 0) {
    await database.close();
    throw new Error("TEST_NOTIFICATION_SETTINGS_DATABASE_URL must target an empty database");
  }
  return database;
}

function settings(version: number, overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    sendLocalTime: "09:00",
    advanceDays: 7,
    overdueDaily: true,
    receivableEnabled: true,
    payableEnabled: true,
    version,
    ...overrides,
  };
}

async function login(app: FastifyInstance, phone: string, tenantId?: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { phone, password: "demo1234", ...(tenantId ? { tenantId } : {}) },
  });
  expect(response.statusCode).toBe(200);
  return response.json().token;
}

async function addMember(
  fixture: Fixture,
  input: { id: string; phone: string; role: "finance" | "sales" | "viewer" },
): Promise<string> {
  const password = await fixture.database.query<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = $1",
    [DEMO_IDS.user],
  );
  await fixture.database.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO users (id, phone, display_name, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [input.id, input.phone, `${input.role} member`, password.rows[0]!.password_hash],
    );
    await tx.query(
      `INSERT INTO memberships (tenant_id, user_id, role)
       VALUES ($1, $2, $3)`,
      [DEMO_IDS.tenant, input.id, input.role],
    );
  });
  return login(fixture.app, input.phone, DEMO_IDS.tenant);
}

describe.sequential("current member notification settings", () => {
  let fixture: Fixture;
  let database: Database;

  beforeAll(async () => {
    database = await createTestDatabase();
    await migrate(database);
  });

  beforeEach(async () => {
    await database.exec("TRUNCATE TABLE tenants, users CASCADE");
    await seedDemo(database);
    const app = buildApp({ database, publicOrigin: PUBLIC_ORIGIN });
    await app.ready();
    fixture = { app, database, ownerToken: await login(app, "13800000000", DEMO_IDS.tenant) };
  });

  afterEach(async () => {
    await fixture.app.close();
  });

  afterAll(async () => {
    await database.close();
  });

  it("returns stable defaults, requires phone verification, records consent, and preserves disabled history", async () => {
    const initial = await fixture.app.inject({
      method: "GET",
      url: "/api/notification-settings/me",
      headers: bearer(fixture.ownerToken),
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({
      eligible: true,
      phoneMasked: "138****0000",
      phoneVerified: false,
      preference: {
        enabled: false,
        sendLocalTime: "09:00",
        advanceDays: 7,
        overdueDaily: true,
        receivableEnabled: true,
        payableEnabled: true,
        version: 0,
      },
    });
    expect(initial.body).not.toContain("13800000000");

    const passwordVerification = await fixture.database.query<{ phone_verified_at: string | null }>(
      "SELECT phone_verified_at FROM users WHERE id = $1",
      [DEMO_IDS.user],
    );
    expect(passwordVerification.rows[0]?.phone_verified_at).toBeNull();

    const blocked = await fixture.app.inject({
      method: "PUT",
      url: "/api/notification-settings/me",
      headers: bearer(fixture.ownerToken),
      payload: settings(0),
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("PHONE_NOT_VERIFIED");

    const verifiedAt = "2026-07-26T02:00:00.000Z";
    await fixture.database.query(
      "UPDATE users SET phone_verified_at = $2 WHERE id = $1",
      [DEMO_IDS.user, verifiedAt],
    );
    const enabled = await fixture.app.inject({
      method: "PUT",
      url: "/api/notification-settings/me",
      headers: bearer(fixture.ownerToken),
      payload: settings(0, {
        sendLocalTime: "10:15",
        advanceDays: 14,
        overdueDaily: false,
        payableEnabled: false,
      }),
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toEqual({
      eligible: true,
      phoneMasked: "138****0000",
      phoneVerified: true,
      preference: {
        enabled: true,
        sendLocalTime: "10:15",
        advanceDays: 14,
        overdueDaily: false,
        receivableEnabled: true,
        payableEnabled: false,
        version: 1,
      },
    });
    expect(enabled.body).not.toContain("13800000000");

    const endpoint = await fixture.database.query<{
      destination: string;
      destination_hash: string;
      destination_hint: string;
      verified_at: Date | string | null;
      consented_at: Date | string | null;
      disabled_at: Date | string | null;
    }>(
      `SELECT destination, destination_hash, destination_hint, verified_at, consented_at, disabled_at
       FROM notification_endpoints WHERE tenant_id = $1 AND user_id = $2`,
      [DEMO_IDS.tenant, DEMO_IDS.user],
    );
    expect(endpoint.rows[0]).toMatchObject({
      destination: "13800000000",
      destination_hash: createHash("sha256").update("13800000000").digest("hex"),
      destination_hint: "138****0000",
      disabled_at: null,
    });
    expect(endpoint.rows[0]?.verified_at).not.toBeNull();
    expect(endpoint.rows[0]?.consented_at).not.toBeNull();

    const disabled = await fixture.app.inject({
      method: "PUT",
      url: "/api/notification-settings/me",
      headers: bearer(fixture.ownerToken),
      payload: settings(1, { enabled: false }),
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().preference).toMatchObject({ enabled: false, version: 2 });
    const preserved = await fixture.database.query<{ enabled: boolean; endpoints: string }>(
      `SELECT preference.enabled,
              (SELECT COUNT(*)::text FROM notification_endpoints endpoint
               WHERE endpoint.tenant_id = preference.tenant_id
                 AND endpoint.user_id = preference.user_id) AS endpoints
       FROM notification_preferences preference
       WHERE preference.tenant_id = $1 AND preference.user_id = $2`,
      [DEMO_IDS.tenant, DEMO_IDS.user],
    );
    expect(preserved.rows[0]).toEqual({ enabled: false, endpoints: "1" });

    const audits = await fixture.database.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_logs
       WHERE tenant_id = $1 AND actor_user_id = $2 AND action = 'notification.settings_updated'
       ORDER BY created_at, id`,
      [DEMO_IDS.tenant, DEMO_IDS.user],
    );
    expect(audits.rows).toHaveLength(2);
    expect(audits.rows.map((row) => row.metadata)).toEqual([
      expect.objectContaining({ fromVersion: 0, toVersion: 1, enabled: true }),
      expect.objectContaining({ fromVersion: 1, toVersion: 2, enabled: false }),
    ]);
    expect(JSON.stringify(audits.rows)).not.toContain("13800000000");
  });

  it("allows finance members and rejects sales and viewer roles", async () => {
    const financeToken = await addMember(fixture, {
      id: "b1000000-0000-4000-8000-000000000001",
      phone: "13900000001",
      role: "finance",
    });
    const salesToken = await addMember(fixture, {
      id: "b1000000-0000-4000-8000-000000000002",
      phone: "13900000002",
      role: "sales",
    });
    const viewerToken = await addMember(fixture, {
      id: "b1000000-0000-4000-8000-000000000003",
      phone: "13900000003",
      role: "viewer",
    });

    const financeGet = await fixture.app.inject({
      method: "GET",
      url: "/api/notification-settings/me",
      headers: bearer(financeToken),
    });
    expect(financeGet.statusCode).toBe(200);
    expect(financeGet.json()).toMatchObject({
      eligible: true,
      phoneMasked: "139****0001",
      phoneVerified: false,
      preference: { enabled: false, version: 0 },
    });
    const financePut = await fixture.app.inject({
      method: "PUT",
      url: "/api/notification-settings/me",
      headers: bearer(financeToken),
      payload: settings(0, { enabled: false }),
    });
    expect(financePut.statusCode).toBe(200);
    expect(financePut.json().preference.version).toBe(1);

    const forbidden = await Promise.all([salesToken, viewerToken].flatMap((token) => [
      fixture.app.inject({
        method: "GET",
        url: "/api/notification-settings/me",
        headers: bearer(token),
      }),
      fixture.app.inject({
        method: "PUT",
        url: "/api/notification-settings/me",
        headers: bearer(token),
        payload: settings(0, { enabled: false }),
      }),
    ]));
    expect(forbidden.map((response) => response.statusCode)).toEqual([403, 403, 403, 403]);
  });

  it("isolates the same member's settings by session tenant", async () => {
    await fixture.database.transaction(async (tx) => {
      await tx.query("INSERT INTO tenants (id, name) VALUES ($1, '第二企业')", [FOREIGN_TENANT_ID]);
      await tx.query(
        "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'finance')",
        [FOREIGN_TENANT_ID, DEMO_IDS.user],
      );
      await tx.query(
        `INSERT INTO notification_preferences (
           tenant_id, user_id, channel, enabled, send_local_time, advance_days,
           overdue_daily, receivable_enabled, payable_enabled, version
         ) VALUES ($1, $2, 'sms', false, time '11:30', 30, false, false, true, 5)`,
        [FOREIGN_TENANT_ID, DEMO_IDS.user],
      );
    });
    const foreignToken = await login(fixture.app, "13800000000", FOREIGN_TENANT_ID);

    const [primary, foreign] = await Promise.all([
      fixture.app.inject({
        method: "GET",
        url: "/api/notification-settings/me",
        headers: bearer(fixture.ownerToken),
      }),
      fixture.app.inject({
        method: "GET",
        url: "/api/notification-settings/me",
        headers: bearer(foreignToken),
      }),
    ]);
    expect(primary.json().preference).toMatchObject({ sendLocalTime: "09:00", advanceDays: 7, version: 0 });
    expect(foreign.json().preference).toMatchObject({ sendLocalTime: "11:30", advanceDays: 30, version: 5 });

    const primaryUpdate = await fixture.app.inject({
      method: "PUT",
      url: "/api/notification-settings/me",
      headers: bearer(fixture.ownerToken),
      payload: settings(0, { enabled: false, sendLocalTime: "08:45" }),
    });
    expect(primaryUpdate.statusCode).toBe(200);
    const foreignAfter = await fixture.app.inject({
      method: "GET",
      url: "/api/notification-settings/me",
      headers: bearer(foreignToken),
    });
    expect(foreignAfter.json().preference).toMatchObject({ sendLocalTime: "11:30", advanceDays: 30, version: 5 });
  });

  it("reschedules today's queued digests without touching leased, ambiguous, or delivered records", async () => {
    await fixture.database.query(
      "UPDATE users SET phone_verified_at = now() WHERE id = $1",
      [DEMO_IDS.user],
    );
    const enabled = await fixture.app.inject({
      method: "PUT",
      url: "/api/notification-settings/me",
      headers: bearer(fixture.ownerToken),
      payload: settings(0),
    });
    expect(enabled.statusCode).toBe(200);

    const activeEndpoint = await fixture.database.query<{ id: string }>(
      `SELECT id FROM notification_endpoints
       WHERE tenant_id = $1 AND user_id = $2 AND channel = 'sms' AND disabled_at IS NULL`,
      [DEMO_IDS.tenant, DEMO_IDS.user],
    );
    const activeEndpointId = activeEndpoint.rows[0]!.id;
    await fixture.database.query(
      `INSERT INTO notification_endpoints (
         id, tenant_id, user_id, channel, destination, destination_hash,
         destination_hint, verified_at, consented_at, disabled_at
       ) VALUES
         ('c1000000-0000-4000-8000-000000000001', $1, $2, 'sms', '13900000001', repeat('b', 64), '139****0001', now(), now(), now()),
         ('c1000000-0000-4000-8000-000000000002', $1, $2, 'sms', '13900000002', repeat('c', 64), '139****0002', now(), now(), now()),
         ('c1000000-0000-4000-8000-000000000003', $1, $2, 'sms', '13900000003', repeat('d', 64), '139****0003', now(), now(), now()),
         ('c1000000-0000-4000-8000-000000000004', $1, $2, 'sms', '13900000004', repeat('e', 64), '139****0004', now(), now(), now()),
         ('c1000000-0000-4000-8000-000000000005', $1, $2, 'sms', '13900000005', repeat('f', 64), '139****0005', now(), now(), now())`,
      [DEMO_IDS.tenant, DEMO_IDS.user],
    );
    await fixture.database.query(
      `WITH clock AS (
         SELECT (now() AT TIME ZONE timezone)::date AS occurrence_on, timezone
         FROM tenants WHERE id = $1
       ), queued(id, endpoint_id, status, available_local_time) AS (
         VALUES
           ('d1000000-0000-4000-8000-000000000001'::uuid, $2::uuid, 'pending', time '09:00'),
           ('d1000000-0000-4000-8000-000000000002'::uuid, 'c1000000-0000-4000-8000-000000000001'::uuid, 'retry', time '09:30'),
           ('d1000000-0000-4000-8000-000000000003'::uuid, 'c1000000-0000-4000-8000-000000000002'::uuid, 'retry', time '12:30'),
           ('d1000000-0000-4000-8000-000000000004'::uuid, 'c1000000-0000-4000-8000-000000000003'::uuid, 'leased', time '09:00'),
           ('d1000000-0000-4000-8000-000000000005'::uuid, 'c1000000-0000-4000-8000-000000000004'::uuid, 'ambiguous', time '09:00'),
           ('d1000000-0000-4000-8000-000000000006'::uuid, 'c1000000-0000-4000-8000-000000000005'::uuid, 'delivered', time '09:00')
       )
       INSERT INTO notification_outbox (
         id, tenant_id, endpoint_id, event_type, occurrence_on, locale,
         template_key, template_params, scheduled_at, expires_at, available_at,
         status, lease_token, lease_expires_at, delivered_at
       )
       SELECT queued.id, $1, queued.endpoint_id, 'settlement_daily_digest', clock.occurrence_on,
              'zh-CN', 'settlement_daily_digest', '{"count":1}'::jsonb,
              ((clock.occurrence_on + time '09:00') AT TIME ZONE clock.timezone),
              (((clock.occurrence_on + 1)::timestamp) AT TIME ZONE clock.timezone),
              ((clock.occurrence_on + queued.available_local_time) AT TIME ZONE clock.timezone),
              queued.status,
              CASE WHEN queued.status = 'leased' THEN 'e1000000-0000-4000-8000-000000000001'::uuid END,
              CASE WHEN queued.status = 'leased' THEN now() + interval '1 hour' END,
              CASE WHEN queued.status = 'delivered' THEN now() END
       FROM clock CROSS JOIN queued`,
      [DEMO_IDS.tenant, activeEndpointId],
    );

    const changed = await fixture.app.inject({
      method: "PUT",
      url: "/api/notification-settings/me",
      headers: bearer(fixture.ownerToken),
      payload: settings(1, { sendLocalTime: "10:15" }),
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().preference).toMatchObject({ sendLocalTime: "10:15", version: 2 });

    const clock = await fixture.database.query<{
      old_schedule: Date | string;
      new_schedule: Date | string;
      late_retry: Date | string;
    }>(
      `SELECT
         (((now() AT TIME ZONE timezone)::date + time '09:00') AT TIME ZONE timezone) AS old_schedule,
         (((now() AT TIME ZONE timezone)::date + time '10:15') AT TIME ZONE timezone) AS new_schedule,
         (((now() AT TIME ZONE timezone)::date + time '12:30') AT TIME ZONE timezone) AS late_retry
       FROM tenants WHERE id = $1`,
      [DEMO_IDS.tenant],
    );
    const rows = await fixture.database.query<{
      id: string;
      status: string;
      scheduled_at: Date | string;
      available_at: Date | string;
    }>(
      `SELECT id, status, scheduled_at, available_at
       FROM notification_outbox WHERE tenant_id = $1 ORDER BY id`,
      [DEMO_IDS.tenant],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    const expected = clock.rows[0]!;
    expect(rows.rows).toHaveLength(6);

    for (const id of [
      "d1000000-0000-4000-8000-000000000001",
      "d1000000-0000-4000-8000-000000000002",
      "d1000000-0000-4000-8000-000000000003",
    ]) {
      expect(toIso(byId.get(id)!.scheduled_at)).toBe(toIso(expected.new_schedule));
    }
    expect(toIso(byId.get("d1000000-0000-4000-8000-000000000001")!.available_at))
      .toBe(toIso(expected.new_schedule));
    expect(toIso(byId.get("d1000000-0000-4000-8000-000000000002")!.available_at))
      .toBe(toIso(expected.new_schedule));
    expect(toIso(byId.get("d1000000-0000-4000-8000-000000000003")!.available_at))
      .toBe(toIso(expected.late_retry));

    for (const id of [
      "d1000000-0000-4000-8000-000000000004",
      "d1000000-0000-4000-8000-000000000005",
      "d1000000-0000-4000-8000-000000000006",
    ]) {
      expect(toIso(byId.get(id)!.scheduled_at)).toBe(toIso(expected.old_schedule));
      expect(toIso(byId.get(id)!.available_at)).toBe(toIso(expected.old_schedule));
    }
    expect(byId.get("d1000000-0000-4000-8000-000000000004")!.status).toBe("leased");
    expect(byId.get("d1000000-0000-4000-8000-000000000005")!.status).toBe("ambiguous");
    expect(byId.get("d1000000-0000-4000-8000-000000000006")!.status).toBe("delivered");

    const audit = await fixture.database.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs
       WHERE tenant_id = $1 AND actor_user_id = $2 AND action = 'notification.settings_updated'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [DEMO_IDS.tenant, DEMO_IDS.user],
    );
    expect(audit.rows[0]?.metadata).toMatchObject({
      sendLocalTime: "10:15",
      rescheduledOutboxCount: 3,
    });
  });

  it("accepts only one of two concurrent writes using the same version", async () => {
    await fixture.database.query(
      "UPDATE users SET phone_verified_at = now() WHERE id = $1",
      [DEMO_IDS.user],
    );
    const responses = await Promise.all([
      fixture.app.inject({
        method: "PUT",
        url: "/api/notification-settings/me",
        headers: bearer(fixture.ownerToken),
        payload: settings(0, { sendLocalTime: "08:30" }),
      }),
      fixture.app.inject({
        method: "PUT",
        url: "/api/notification-settings/me",
        headers: bearer(fixture.ownerToken),
        payload: settings(0, { sendLocalTime: "10:30" }),
      }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const conflict = responses.find((response) => response.statusCode === 409)!;
    expect(conflict.json().error).toMatchObject({
      code: "NOTIFICATION_SETTINGS_VERSION_CONFLICT",
      details: { currentVersion: 1 },
    });
    const current = await fixture.app.inject({
      method: "GET",
      url: "/api/notification-settings/me",
      headers: bearer(fixture.ownerToken),
    });
    expect(current.json().preference.version).toBe(1);
    expect(["08:30", "10:30"]).toContain(current.json().preference.sendLocalTime);

    const counts = await fixture.database.query<{ preferences: string; endpoints: string; audits: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM notification_preferences WHERE tenant_id = $1 AND user_id = $2) AS preferences,
         (SELECT COUNT(*)::text FROM notification_endpoints WHERE tenant_id = $1 AND user_id = $2) AS endpoints,
         (SELECT COUNT(*)::text FROM audit_logs
          WHERE tenant_id = $1 AND actor_user_id = $2 AND action = 'notification.settings_updated') AS audits`,
      [DEMO_IDS.tenant, DEMO_IDS.user],
    );
    expect(counts.rows[0]).toEqual({ preferences: "1", endpoints: "1", audits: "1" });
  });
});
