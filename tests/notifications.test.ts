import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPgliteDatabase,
  createPostgresDatabase,
  type Database,
} from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { FakeNotificationProvider } from "../src/notifications/fake-provider.js";
import {
  claimNotificationBatch,
  enqueueDueNotificationDigests,
  processClaimedNotification,
  recordDeliveryReceipt,
  writeWorkerHeartbeat,
} from "../src/notifications/service.js";
import { loadNotificationWorkerConfig } from "../src/worker-config.js";
import { DEMO_IDS, seedDemo } from "../src/seed.js";

const ENDPOINT_ID = "aa000000-0000-4000-8000-000000000001";
const SECOND_ENDPOINT_ID = "aa000000-0000-4000-8000-000000000002";
const SEND_TIME = new Date("2026-07-25T01:05:00.000Z");

async function createTestDatabase(): Promise<Database> {
  const postgresUrl = process.env.TEST_NOTIFICATION_DATABASE_URL;
  if (!postgresUrl) return createPgliteDatabase(":memory:");
  const databaseName = new URL(postgresUrl).pathname.slice(1);
  if (!/(?:_ci|_test)$/.test(databaseName)) {
    throw new Error("TEST_NOTIFICATION_DATABASE_URL must target a database ending in _ci or _test");
  }
  const database = await createPostgresDatabase(postgresUrl);
  const existing = await database.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'",
  );
  if (Number(existing.rows[0]?.count) !== 0) {
    await database.close();
    throw new Error("TEST_NOTIFICATION_DATABASE_URL must target an empty database");
  }
  return database;
}

describe("notification worker configuration", () => {
  it("uses a conservative default batch with enough lease headroom", () => {
    expect(loadNotificationWorkerConfig({} as NodeJS.ProcessEnv)).toMatchObject({
      NOTIFICATION_BATCH_SIZE: 5,
      NOTIFICATION_LEASE_SECONDS: 120,
    });
  });

  it("requires the lease to cover 15 seconds per serial send plus a safety margin", () => {
    expect(loadNotificationWorkerConfig({
      NOTIFICATION_BATCH_SIZE: "6",
      NOTIFICATION_LEASE_SECONDS: "120",
    } as NodeJS.ProcessEnv)).toMatchObject({
      NOTIFICATION_BATCH_SIZE: 6,
      NOTIFICATION_LEASE_SECONDS: 120,
    });
    expect(() => loadNotificationWorkerConfig({
      NOTIFICATION_BATCH_SIZE: "7",
      NOTIFICATION_LEASE_SECONDS: "120",
    } as NodeJS.ProcessEnv)).toThrow(
      /NOTIFICATION_LEASE_SECONDS=120 is too short for NOTIFICATION_BATCH_SIZE=7; use at least 135 seconds \(15 seconds per SMS plus a 30-second safety margin\)/,
    );
    expect(loadNotificationWorkerConfig({
      NOTIFICATION_BATCH_SIZE: "7",
      NOTIFICATION_LEASE_SECONDS: "135",
    } as NodeJS.ProcessEnv)).toMatchObject({
      NOTIFICATION_BATCH_SIZE: 7,
      NOTIFICATION_LEASE_SECONDS: 135,
    });
  });
});

describe("durable settlement notification worker", () => {
  let database: Database;

  beforeAll(async () => {
    database = await createTestDatabase();
    await migrate(database);
    await seedDemo(database);
    await database.query(
      `INSERT INTO notification_endpoints (
         id, tenant_id, user_id, channel, destination, destination_hash,
         destination_hint, verified_at, consented_at
       ) VALUES ($1, $2, $3, 'sms', '+8613800000000', repeat('a', 64), '尾号 0000', $4, $4)`,
      [ENDPOINT_ID, DEMO_IDS.tenant, DEMO_IDS.user, SEND_TIME.toISOString()],
    );
    await database.query(
      `INSERT INTO notification_preferences
         (tenant_id, user_id, channel, enabled, send_local_time, advance_days, overdue_daily)
       VALUES ($1, $2, 'sms', true, time '09:00', 7, true)`,
      [DEMO_IDS.tenant, DEMO_IDS.user],
    );
  });

  afterAll(async () => {
    await database.close();
  });

  it("enforces one enabled endpoint per member and restricts scheduling to finance roles", async () => {
    await expect(database.query(
      `INSERT INTO notification_endpoints (
         id, tenant_id, user_id, channel, destination, destination_hash,
         destination_hint, verified_at, consented_at
       ) VALUES ($1, $2, $3, 'sms', '+8613900000000', repeat('b', 64), '尾号 0000', $4, $4)`,
      [SECOND_ENDPOINT_ID, DEMO_IDS.tenant, DEMO_IDS.user, SEND_TIME.toISOString()],
    )).rejects.toThrow();

    await database.query(
      "UPDATE memberships SET role = 'sales' WHERE tenant_id = $1 AND user_id = $2",
      [DEMO_IDS.tenant, DEMO_IDS.user],
    );
    expect(await enqueueDueNotificationDigests(database, SEND_TIME)).toBe(0);
    await database.query(
      "UPDATE memberships SET role = 'owner' WHERE tenant_id = $1 AND user_id = $2",
      [DEMO_IDS.tenant, DEMO_IDS.user],
    );
  });

  it("creates one daily digest after local send time and submits it exactly once", async () => {
    expect(await enqueueDueNotificationDigests(
      database,
      new Date("2026-07-25T00:59:59.000Z"),
    )).toBe(0);
    expect(await enqueueDueNotificationDigests(database, SEND_TIME)).toBe(1);
    expect(await enqueueDueNotificationDigests(database, SEND_TIME)).toBe(0);

    const firstClaim = await claimNotificationBatch(database, {
      batchSize: 10,
      leaseSeconds: 120,
      now: SEND_TIME,
    });
    expect(firstClaim).toHaveLength(1);
    const concurrentClaim = await claimNotificationBatch(database, {
      batchSize: 10,
      leaseSeconds: 120,
      now: SEND_TIME,
    });
    expect(concurrentClaim).toHaveLength(0);

    const provider = new FakeNotificationProvider();
    const outcome = await processClaimedNotification(database, provider, firstClaim[0]!, {
      maxAttempts: 5,
      now: () => SEND_TIME,
    });
    expect(outcome).toBe("submitted");
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({
      destination: "+8613800000000",
      templateKey: "settlement_daily_digest",
      templateParams: { count: 1 },
    });

    const outbox = await database.query<{ status: string; attempt_count: number }>(
      "SELECT status, attempt_count FROM notification_outbox",
    );
    expect(outbox.rows[0]).toMatchObject({ status: "submitted", attempt_count: 1 });
  });

  it("stores delivery receipts idempotently and keeps them append-only", async () => {
    const attempt = await database.query<{ id: string; provider_message_id: string }>(
      "SELECT id, provider_message_id FROM notification_delivery_attempts ORDER BY created_at LIMIT 1",
    );
    const row = attempt.rows[0]!;
    const receipt = {
      provider: "fake",
      providerMessageId: row.provider_message_id,
      outId: row.id,
      status: "delivered" as const,
      reportedAt: new Date("2026-07-25T01:06:00.000Z"),
    };
    expect(await recordDeliveryReceipt(database, receipt)).toEqual({ matched: true, duplicate: false });
    expect(await recordDeliveryReceipt(database, receipt)).toEqual({ matched: true, duplicate: true });

    const outbox = await database.query<{ status: string }>("SELECT status FROM notification_outbox");
    expect(outbox.rows[0]?.status).toBe("delivered");
    const stored = await database.query<{ id: string }>("SELECT id FROM notification_delivery_receipts");
    expect(stored.rowCount).toBe(1);
    await expect(database.query(
      "UPDATE notification_delivery_receipts SET provider_code = 'tampered' WHERE id = $1",
      [stored.rows[0]!.id],
    )).rejects.toThrow(/append-only/);
  });

  it("retries definitive transient rejection but quarantines unknown provider outcomes", async () => {
    const nextDay = new Date("2026-07-26T01:05:00.000Z");
    expect(await enqueueDueNotificationDigests(database, nextDay)).toBe(1);
    const [job] = await claimNotificationBatch(database, {
      batchSize: 1,
      leaseSeconds: 120,
      now: nextDay,
    });
    const rejecting = new FakeNotificationProvider(() => ({
      outcome: "rejected",
      retryable: true,
      code: "TEMPORARY_BUSY",
    }));
    expect(await processClaimedNotification(database, rejecting, job!, {
      maxAttempts: 5,
      now: () => nextDay,
    })).toBe("retry");

    const retryAt = new Date(nextDay.getTime() + 61_000);
    const [retryJob] = await claimNotificationBatch(database, {
      batchSize: 1,
      leaseSeconds: 120,
      now: retryAt,
    });
    expect(retryJob?.attemptCount).toBe(1);
    const uncertain = new FakeNotificationProvider(() => {
      throw new Error("simulated transport timeout");
    });
    expect(await processClaimedNotification(database, uncertain, retryJob!, {
      maxAttempts: 5,
      now: () => retryAt,
    })).toBe("ambiguous");

    const state = await database.query<{ status: string; attempt_count: number }>(
      "SELECT status, attempt_count FROM notification_outbox WHERE occurrence_on = '2026-07-26'",
    );
    expect(state.rows[0]).toMatchObject({ status: "ambiguous", attempt_count: 2 });
    expect(await claimNotificationBatch(database, {
      batchSize: 1,
      leaseSeconds: 120,
      now: new Date(retryAt.getTime() + 600_000),
    })).toHaveLength(0);
  });

  it("cancels a leased digest when its reminder version becomes stale", async () => {
    const nextDay = new Date("2026-07-27T01:05:00.000Z");
    expect(await enqueueDueNotificationDigests(database, nextDay)).toBe(1);
    const [job] = await claimNotificationBatch(database, {
      batchSize: 1,
      leaseSeconds: 120,
      now: nextDay,
    });
    await database.query(
      `UPDATE reminders
       SET version = version + 1, status = 'snoozed', snoozed_until = $2, updated_at = $2
       WHERE tenant_id = $1 AND id = $3`,
      [DEMO_IDS.tenant, new Date(nextDay.getTime() + 86_400_000).toISOString(), DEMO_IDS.reminder],
    );
    const provider = new FakeNotificationProvider();
    expect(await processClaimedNotification(database, provider, job!, {
      maxAttempts: 5,
      now: () => nextDay,
    })).toBe("cancelled");
    expect(provider.sent).toHaveLength(0);
  });

  it("reclaims a pre-send lease but quarantines a lease lost after an attempt started", async () => {
    const preSendDay = new Date("2026-07-28T01:05:00.000Z");
    expect(await enqueueDueNotificationDigests(database, preSendDay)).toBe(1);
    const [firstLease] = await claimNotificationBatch(database, {
      batchSize: 1,
      leaseSeconds: 60,
      now: preSendDay,
    });
    const [reclaimed] = await claimNotificationBatch(database, {
      batchSize: 1,
      leaseSeconds: 60,
      now: new Date(preSendDay.getTime() + 61_000),
    });
    expect(reclaimed?.id).toBe(firstLease?.id);
    expect(reclaimed?.leaseToken).not.toBe(firstLease?.leaseToken);

    const attemptId = "cc000000-0000-4000-8000-000000000001";
    await database.query(
      `UPDATE notification_outbox SET attempt_count = 1, provider = 'fake' WHERE id = $1`,
      [reclaimed!.id],
    );
    await database.query(
      `INSERT INTO notification_delivery_attempts (
         id, tenant_id, outbox_id, attempt_no, provider, out_id, status, started_at
       ) VALUES ($1, $2, $3, 1, 'fake', $1, 'started', $4)`,
      [attemptId, DEMO_IDS.tenant, reclaimed!.id, preSendDay.toISOString()],
    );
    expect(await claimNotificationBatch(database, {
      batchSize: 1,
      leaseSeconds: 60,
      now: new Date(preSendDay.getTime() + 122_000),
    })).toHaveLength(0);
    const ambiguous = await database.query<{ outbox_status: string; attempt_status: string }>(
      `SELECT outbox.status AS outbox_status, attempt.status AS attempt_status
       FROM notification_outbox outbox
       JOIN notification_delivery_attempts attempt ON attempt.outbox_id = outbox.id
       WHERE outbox.id = $1`,
      [reclaimed!.id],
    );
    expect(ambiguous.rows[0]).toEqual({ outbox_status: "ambiguous", attempt_status: "ambiguous" });
  });

  it("records worker heartbeat and rejects fake provider in production config", async () => {
    await writeWorkerHeartbeat(database, {
      workerName: "test-reminders",
      instanceId: "bb000000-0000-4000-8000-000000000001",
      releaseId: "test-release",
      provider: "fake",
      startedAt: SEND_TIME,
      seenAt: SEND_TIME,
      scheduled: true,
    });
    const heartbeat = await database.query<{ provider: string; release_id: string }>(
      "SELECT provider, release_id FROM notification_worker_heartbeats WHERE worker_name = 'test-reminders'",
    );
    expect(heartbeat.rows[0]).toEqual({ provider: "fake", release_id: "test-release" });

    const failedAt = new Date(SEND_TIME.getTime() + 30_000);
    await writeWorkerHeartbeat(database, {
      workerName: "test-reminders",
      instanceId: "bb000000-0000-4000-8000-000000000001",
      releaseId: "test-release",
      provider: "fake",
      startedAt: SEND_TIME,
      seenAt: failedAt,
      failed: true,
    });
    const failure = await database.query<{ last_error_at: Date | string | null }>(
      "SELECT last_error_at FROM notification_worker_heartbeats WHERE worker_name = 'test-reminders'",
    );
    expect(new Date(failure.rows[0]!.last_error_at!).toISOString()).toBe(failedAt.toISOString());

    expect(() => loadNotificationWorkerConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://worker:test@database.test/settlement",
      NOTIFICATION_PROVIDER: "aliyun",
      ALIYUN_SMS_SIGN_NAME: "思燕家居",
      ALIYUN_SMS_DIGEST_TEMPLATE_CODE: "SMS_123456789",
      RELEASE_ID: "a".repeat(40),
    } as NodeJS.ProcessEnv)).toThrow(/exactly one sslmode=require, verify-ca, or verify-full/);

    expect(() => loadNotificationWorkerConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://worker:test@database.test/settlement?sslmode=require",
      NOTIFICATION_PROVIDER: "fake",
    } as NodeJS.ProcessEnv)).toThrow(/Aliyun provider/);

    expect(() => loadNotificationWorkerConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://worker:test@database.test/settlement?sslmode=require",
      NOTIFICATION_PROVIDER: "aliyun",
      ALIYUN_SMS_SIGN_NAME: "思燕家居",
      ALIYUN_SMS_DIGEST_TEMPLATE_CODE: "SMS_123456789",
      RELEASE_ID: "development",
    } as NodeJS.ProcessEnv)).toThrow(/Git release SHA/);

    expect(loadNotificationWorkerConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://worker:test@database.test/settlement?sslmode=require",
      NOTIFICATION_PROVIDER: "aliyun",
      ALIYUN_SMS_SIGN_NAME: "思燕家居",
      ALIYUN_SMS_DIGEST_TEMPLATE_CODE: "SMS_123456789",
      RELEASE_ID: "a".repeat(40),
    } as NodeJS.ProcessEnv)).toMatchObject({
      NOTIFICATION_PROVIDER: "aliyun",
      ALIYUN_SMS_SIGN_NAME: "思燕家居",
      ALIYUN_SMS_DIGEST_TEMPLATE_CODE: "SMS_123456789",
    });

  });
});
