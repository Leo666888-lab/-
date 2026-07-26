import { createHash } from "node:crypto";
import type { Database, Queryable } from "../db/types.js";
import { newId } from "../lib/security.js";
import type { NotificationMessage, NotificationProvider } from "./provider.js";

const EVENT_TYPE = "settlement_daily_digest";
const TEMPLATE_KEY = "settlement_daily_digest";

interface EligibleReminderRow extends Record<string, unknown> {
  tenant_id: string;
  endpoint_id: string;
  reminder_id: string;
  order_id: string;
  reminder_version: number;
  occurrence_on: string;
  locale: string;
  scheduled_at: Date | string;
  expires_at: Date | string;
}

export interface ClaimedNotification {
  id: string;
  tenantId: string;
  endpointId: string;
  channel: "sms";
  destination: string;
  locale: string;
  templateKey: string;
  templateParams: Record<string, unknown>;
  expiresAt: string;
  leaseToken: string;
  attemptCount: number;
}

export interface DeliveryReceiptInput {
  provider: string;
  providerMessageId: string;
  outId?: string;
  status: "delivered" | "failed" | "unknown";
  providerCode?: string;
  reportedAt: Date;
  metadata?: Record<string, unknown>;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function rescheduleQueuedDailyDigests(
  database: Queryable,
  input: { tenantId: string; userId: string; sendLocalTime: string },
): Promise<number> {
  const updated = await database.query(
    `UPDATE notification_outbox outbox
     SET scheduled_at = ((outbox.occurrence_on + $3::time) AT TIME ZONE tenant.timezone),
         available_at = CASE
           WHEN outbox.status = 'pending'
             THEN ((outbox.occurrence_on + $3::time) AT TIME ZONE tenant.timezone)
           ELSE GREATEST(
             outbox.available_at,
             ((outbox.occurrence_on + $3::time) AT TIME ZONE tenant.timezone)
           )
         END,
         updated_at = now()
     FROM notification_endpoints endpoint, tenants tenant
     WHERE outbox.tenant_id = $1
       AND endpoint.tenant_id = outbox.tenant_id
       AND endpoint.id = outbox.endpoint_id
       AND endpoint.user_id = $2
       AND endpoint.channel = 'sms'
       AND tenant.id = outbox.tenant_id
       AND outbox.event_type = $4
       AND outbox.occurrence_on = (now() AT TIME ZONE tenant.timezone)::date
       AND outbox.expires_at > now()
       AND outbox.status IN ('pending', 'retry')
       AND outbox.scheduled_at IS DISTINCT FROM
           ((outbox.occurrence_on + $3::time) AT TIME ZONE tenant.timezone)
     RETURNING outbox.id`,
    [input.tenantId, input.userId, input.sendLocalTime, EVENT_TYPE],
  );
  return updated.rows.length;
}

export async function enqueueDueNotificationDigests(
  database: Database,
  now = new Date(),
): Promise<number> {
  return database.transaction(async (tx) => {
    // Keep preference reads locked through insertion so settings updates can safely reschedule the same day's row.
    const eligible = await tx.query<EligibleReminderRow>(
      `SELECT r.tenant_id, endpoint.id AS endpoint_id, r.id AS reminder_id,
            r.order_id, r.version AS reminder_version,
            (($1::timestamptz AT TIME ZONE tenant.timezone)::date)::text AS occurrence_on,
            preference.locale,
            ((($1::timestamptz AT TIME ZONE tenant.timezone)::date + preference.send_local_time)
              AT TIME ZONE tenant.timezone) AS scheduled_at,
            (((($1::timestamptz AT TIME ZONE tenant.timezone)::date + 1)::timestamp)
              AT TIME ZONE tenant.timezone) AS expires_at
     FROM reminders r
     JOIN tenants tenant ON tenant.id = r.tenant_id
     JOIN orders order_record
       ON order_record.tenant_id = r.tenant_id
      AND order_record.id = r.order_id
      AND order_record.fulfillment_status = 'fulfilled'
     JOIN notification_preferences preference
       ON preference.tenant_id = r.tenant_id
      AND preference.channel = 'sms'
      AND preference.enabled = true
     JOIN memberships membership
       ON membership.tenant_id = preference.tenant_id
      AND membership.user_id = preference.user_id
      AND membership.is_active = true
      AND membership.role IN ('owner', 'finance')
     JOIN users recipient
       ON recipient.id = membership.user_id
      AND recipient.is_active = true
     JOIN notification_endpoints endpoint
       ON endpoint.tenant_id = preference.tenant_id
      AND endpoint.user_id = preference.user_id
      AND endpoint.channel = preference.channel
      AND endpoint.verified_at IS NOT NULL
      AND endpoint.consented_at IS NOT NULL
      AND endpoint.disabled_at IS NULL
     WHERE (($1::timestamptz AT TIME ZONE tenant.timezone)::time >= preference.send_local_time)
       AND r.due_at < (((($1::timestamptz AT TIME ZONE tenant.timezone)::date
                         + preference.advance_days + 1)::timestamp) AT TIME ZONE tenant.timezone)
       AND (
         r.due_at >= (((($1::timestamptz AT TIME ZONE tenant.timezone)::date)::timestamp)
                       AT TIME ZONE tenant.timezone)
         OR preference.overdue_daily = true
       )
       AND (
         r.status = 'open'
         OR (r.status IN ('acked', 'snoozed') AND r.snoozed_until <= $1::timestamptz)
       )
       AND (
         (order_record.direction = 'receivable' AND preference.receivable_enabled = true)
         OR (order_record.direction = 'payable' AND preference.payable_enabled = true)
       )
       AND order_record.total_cents > COALESCE((
         SELECT SUM(payment.amount_cents)
         FROM payments payment
         WHERE payment.tenant_id = order_record.tenant_id
           AND payment.order_id = order_record.id
           AND NOT EXISTS (
             SELECT 1 FROM payment_reversals reversal
             WHERE reversal.tenant_id = payment.tenant_id
               AND reversal.payment_id = payment.id
               AND reversal.order_id = payment.order_id
           )
       ), 0)
     ORDER BY r.tenant_id, endpoint.id, r.due_at, r.id
     FOR SHARE OF preference`,
      [now.toISOString()],
    );

    const groups = new Map<string, { rows: EligibleReminderRow[]; first: EligibleReminderRow }>();
    for (const row of eligible.rows) {
      const key = `${row.tenant_id}:${row.endpoint_id}:${row.occurrence_on}`;
      const group = groups.get(key);
      if (group) group.rows.push(row);
      else groups.set(key, { rows: [row], first: row });
    }

    let insertedCount = 0;
    for (const group of groups.values()) {
      const outboxId = newId();
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO notification_outbox (
           id, tenant_id, endpoint_id, event_type, occurrence_on, locale,
           template_key, template_params, scheduled_at, expires_at, available_at
         ) VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8::jsonb, $9, $10, $9)
         ON CONFLICT (tenant_id, endpoint_id, event_type, occurrence_on) DO NOTHING
         RETURNING id`,
        [
          outboxId,
          group.first.tenant_id,
          group.first.endpoint_id,
          EVENT_TYPE,
          group.first.occurrence_on,
          group.first.locale,
          TEMPLATE_KEY,
          JSON.stringify({ count: group.rows.length }),
          iso(group.first.scheduled_at),
          iso(group.first.expires_at),
        ],
      );
      if (!inserted.rowCount) continue;

      for (const item of group.rows) {
        await tx.query(
          `INSERT INTO notification_outbox_items
             (tenant_id, outbox_id, reminder_id, order_id, reminder_version)
           VALUES ($1, $2, $3, $4, $5)`,
          [item.tenant_id, outboxId, item.reminder_id, item.order_id, Number(item.reminder_version)],
        );
      }
      insertedCount += 1;
    }
    return insertedCount;
  });
}

export async function claimNotificationBatch(
  database: Database,
  options: { batchSize: number; leaseSeconds: number; now?: Date },
): Promise<ClaimedNotification[]> {
  const now = options.now ?? new Date();
  const leaseToken = newId();
  const leaseExpiresAt = new Date(now.getTime() + options.leaseSeconds * 1_000);

  return database.transaction(async (tx) => {
    await tx.query(
      `UPDATE notification_delivery_attempts attempt
       SET status = 'ambiguous', error_class = 'ambiguous', provider_code = 'LEASE_EXPIRED',
           finished_at = $1, updated_at = $1
       FROM notification_outbox outbox
       WHERE attempt.tenant_id = outbox.tenant_id
         AND attempt.outbox_id = outbox.id
         AND attempt.status = 'started'
         AND outbox.status = 'leased'
         AND outbox.lease_expires_at <= $1`,
      [now.toISOString()],
    );
    await tx.query(
      `UPDATE notification_outbox outbox
       SET status = 'ambiguous', lease_token = NULL, lease_expires_at = NULL,
           last_error_code = 'LEASE_EXPIRED_AFTER_ATTEMPT', updated_at = $1
       WHERE outbox.status = 'leased'
         AND outbox.lease_expires_at <= $1
         AND EXISTS (
           SELECT 1 FROM notification_delivery_attempts attempt
           WHERE attempt.tenant_id = outbox.tenant_id
             AND attempt.outbox_id = outbox.id
             AND attempt.attempt_no = outbox.attempt_count
             AND attempt.status = 'ambiguous'
         )`,
      [now.toISOString()],
    );
    await tx.query(
      `UPDATE notification_outbox
       SET status = 'expired', updated_at = $1
       WHERE status IN ('pending', 'retry') AND expires_at <= $1`,
      [now.toISOString()],
    );
    await tx.query(
      `WITH candidate AS (
         SELECT id
         FROM notification_outbox
         WHERE scheduled_at <= $1
           AND expires_at > $1
           AND (
             (status IN ('pending', 'retry') AND available_at <= $1)
             OR (status = 'leased' AND lease_expires_at <= $1)
           )
         ORDER BY available_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE notification_outbox outbox
       SET status = 'leased', lease_token = $3, lease_expires_at = $4, updated_at = $1
       FROM candidate
       WHERE outbox.id = candidate.id`,
      [now.toISOString(), options.batchSize, leaseToken, leaseExpiresAt.toISOString()],
    );
    const claimed = await tx.query<Record<string, unknown>>(
      `SELECT outbox.id, outbox.tenant_id, outbox.endpoint_id, endpoint.channel,
              endpoint.destination, outbox.locale, outbox.template_key,
              outbox.template_params, outbox.expires_at, outbox.lease_token,
              outbox.attempt_count
       FROM notification_outbox outbox
       JOIN notification_endpoints endpoint
         ON endpoint.tenant_id = outbox.tenant_id
        AND endpoint.id = outbox.endpoint_id
       WHERE outbox.status = 'leased' AND outbox.lease_token = $1
       ORDER BY outbox.available_at, outbox.id`,
      [leaseToken],
    );
    return claimed.rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      endpointId: String(row.endpoint_id),
      channel: "sms" as const,
      destination: String(row.destination),
      locale: String(row.locale),
      templateKey: String(row.template_key),
      templateParams: objectValue(row.template_params),
      expiresAt: iso(row.expires_at as Date | string),
      leaseToken: String(row.lease_token),
      attemptCount: Number(row.attempt_count),
    }));
  });
}

async function cancelLeasedNotification(
  database: Queryable,
  job: ClaimedNotification,
  now: Date,
): Promise<void> {
  await database.query(
    `UPDATE notification_outbox
     SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
         cancelled_at = $3, updated_at = $3
     WHERE tenant_id = $1 AND id = $2 AND status = 'leased' AND lease_token = $4`,
    [job.tenantId, job.id, now.toISOString(), job.leaseToken],
  );
}

async function prepareLeasedNotification(
  database: Database,
  job: ClaimedNotification,
  now: Date,
): Promise<Omit<NotificationMessage, "outId"> | null> {
  return database.transaction(async (tx) => {
    const valid = await tx.query<{ destination: string; locale: string }>(
      `SELECT endpoint.destination, preference.locale
       FROM notification_outbox_items item
       JOIN notification_outbox outbox
         ON outbox.tenant_id = item.tenant_id AND outbox.id = item.outbox_id
       JOIN notification_endpoints endpoint
         ON endpoint.tenant_id = outbox.tenant_id AND endpoint.id = outbox.endpoint_id
       JOIN notification_preferences preference
         ON preference.tenant_id = endpoint.tenant_id
        AND preference.user_id = endpoint.user_id
        AND preference.channel = endpoint.channel
       JOIN memberships membership
         ON membership.tenant_id = endpoint.tenant_id
        AND membership.user_id = endpoint.user_id
        AND membership.role IN ('owner', 'finance')
       JOIN users recipient ON recipient.id = endpoint.user_id
       JOIN tenants tenant ON tenant.id = item.tenant_id
       JOIN reminders reminder
         ON reminder.tenant_id = item.tenant_id
        AND reminder.id = item.reminder_id
        AND reminder.version = item.reminder_version
       JOIN orders order_record
         ON order_record.tenant_id = item.tenant_id
        AND order_record.id = item.order_id
        AND order_record.fulfillment_status = 'fulfilled'
       WHERE outbox.tenant_id = $1 AND outbox.id = $2
         AND outbox.status = 'leased' AND outbox.lease_token = $3
         AND outbox.expires_at > $4
         AND endpoint.verified_at IS NOT NULL
         AND endpoint.consented_at IS NOT NULL
         AND endpoint.disabled_at IS NULL
         AND preference.enabled = true
         AND membership.is_active = true
         AND recipient.is_active = true
         AND reminder.due_at < ((((($4::timestamptz AT TIME ZONE tenant.timezone)::date
                                     + preference.advance_days + 1)::timestamp)
                                   AT TIME ZONE tenant.timezone))
         AND (
           reminder.due_at >= (((($4::timestamptz AT TIME ZONE tenant.timezone)::date)::timestamp)
                                AT TIME ZONE tenant.timezone)
           OR preference.overdue_daily = true
         )
         AND (
           reminder.status = 'open'
           OR (reminder.status IN ('acked', 'snoozed') AND reminder.snoozed_until <= $4)
         )
         AND (
           (order_record.direction = 'receivable' AND preference.receivable_enabled = true)
           OR (order_record.direction = 'payable' AND preference.payable_enabled = true)
         )
         AND order_record.total_cents > COALESCE((
           SELECT SUM(payment.amount_cents)
           FROM payments payment
           WHERE payment.tenant_id = order_record.tenant_id
             AND payment.order_id = order_record.id
             AND NOT EXISTS (
               SELECT 1 FROM payment_reversals reversal
               WHERE reversal.tenant_id = payment.tenant_id
                 AND reversal.payment_id = payment.id
                 AND reversal.order_id = payment.order_id
             )
         ), 0)
       ORDER BY reminder.due_at, reminder.id`,
      [job.tenantId, job.id, job.leaseToken, now.toISOString()],
    );
    if (!valid.rowCount) {
      await cancelLeasedNotification(tx, job, now);
      return null;
    }

    const updated = await tx.query(
      `UPDATE notification_outbox
       SET template_params = $5::jsonb, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 AND status = 'leased' AND lease_token = $3
       RETURNING id`,
      [job.tenantId, job.id, job.leaseToken, now.toISOString(), JSON.stringify({ count: valid.rowCount })],
    );
    if (!updated.rowCount) return null;
    return {
      channel: job.channel,
      destination: valid.rows[0]!.destination,
      locale: valid.rows[0]!.locale,
      templateKey: job.templateKey,
      templateParams: { count: valid.rowCount },
    };
  });
}

async function startDeliveryAttempt(
  database: Database,
  provider: string,
  job: ClaimedNotification,
  now: Date,
): Promise<{ id: string; attemptNo: number } | null> {
  return database.transaction(async (tx) => {
    const updated = await tx.query<{ attempt_count: number }>(
      `UPDATE notification_outbox
       SET attempt_count = attempt_count + 1, provider = $5, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 AND status = 'leased'
         AND lease_token = $3 AND lease_expires_at > $4
       RETURNING attempt_count`,
      [job.tenantId, job.id, job.leaseToken, now.toISOString(), provider],
    );
    if (!updated.rowCount) return null;
    const attemptId = newId();
    const attemptNo = Number(updated.rows[0]!.attempt_count);
    await tx.query(
      `INSERT INTO notification_delivery_attempts (
         id, tenant_id, outbox_id, attempt_no, provider, out_id, status, started_at
       ) VALUES ($1, $2, $3, $4, $5, $1, 'started', $6)`,
      [attemptId, job.tenantId, job.id, attemptNo, provider, now.toISOString()],
    );
    return { id: attemptId, attemptNo };
  });
}

async function markAmbiguous(
  database: Database,
  job: ClaimedNotification,
  attemptId: string,
  now: Date,
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.query(
      `UPDATE notification_delivery_attempts
       SET status = 'ambiguous', error_class = 'ambiguous',
           provider_code = 'PROVIDER_OUTCOME_UNKNOWN', finished_at = $3, updated_at = $3
       WHERE tenant_id = $1 AND id = $2 AND status = 'started'`,
      [job.tenantId, attemptId, now.toISOString()],
    );
    await tx.query(
      `UPDATE notification_outbox
       SET status = 'ambiguous', lease_token = NULL, lease_expires_at = NULL,
           last_error_code = 'PROVIDER_OUTCOME_UNKNOWN', updated_at = $4
       WHERE tenant_id = $1 AND id = $2 AND status = 'leased' AND lease_token = $3`,
      [job.tenantId, job.id, job.leaseToken, now.toISOString()],
    );
  });
}

export async function processClaimedNotification(
  database: Database,
  provider: NotificationProvider,
  job: ClaimedNotification,
  options: { maxAttempts: number; now?: () => Date } = { maxAttempts: 5 },
): Promise<"submitted" | "retry" | "failed" | "ambiguous" | "cancelled" | "lease_lost"> {
  const clock = options.now ?? (() => new Date());
  const prepared = await prepareLeasedNotification(database, job, clock());
  if (!prepared) return "cancelled";
  const attempt = await startDeliveryAttempt(database, provider.name, job, clock());
  if (!attempt) return "lease_lost";

  try {
    const result = await provider.send({ ...prepared, outId: attempt.id });
    const finishedAt = clock();
    if (result.outcome === "accepted") {
      await database.transaction(async (tx) => {
        await tx.query(
          `UPDATE notification_delivery_attempts
           SET status = 'accepted', provider_request_id = $3, provider_message_id = $4,
               finished_at = $5, updated_at = $5
           WHERE tenant_id = $1 AND id = $2 AND status = 'started'`,
          [job.tenantId, attempt.id, result.providerRequestId ?? null, result.providerMessageId, finishedAt.toISOString()],
        );
        const updated = await tx.query(
          `UPDATE notification_outbox
           SET status = 'submitted', provider = $5, provider_message_id = $6,
               submitted_at = $4, lease_token = NULL, lease_expires_at = NULL,
               last_error_code = NULL, updated_at = $4
           WHERE tenant_id = $1 AND id = $2 AND status = 'leased' AND lease_token = $3
           RETURNING id`,
          [job.tenantId, job.id, job.leaseToken, finishedAt.toISOString(), provider.name, result.providerMessageId],
        );
        if (!updated.rowCount) throw new Error("notification lease was lost after provider acceptance");
      });
      return "submitted";
    }

    const retryDelaySeconds = Math.min(60 * (2 ** Math.max(0, attempt.attemptNo - 1)), 3_600);
    const nextRetryAt = new Date(finishedAt.getTime() + retryDelaySeconds * 1_000);
    const retry = result.retryable
      && attempt.attemptNo < options.maxAttempts
      && nextRetryAt.getTime() < new Date(job.expiresAt).getTime();
    await database.transaction(async (tx) => {
      await tx.query(
        `UPDATE notification_delivery_attempts
         SET status = 'rejected', provider_request_id = $3, provider_code = $4,
             error_class = $5, finished_at = $6, next_retry_at = $7, updated_at = $6
         WHERE tenant_id = $1 AND id = $2 AND status = 'started'`,
        [
          job.tenantId,
          attempt.id,
          result.providerRequestId ?? null,
          result.code,
          result.retryable ? "retryable" : "permanent",
          finishedAt.toISOString(),
          retry ? nextRetryAt.toISOString() : null,
        ],
      );
      const updated = await tx.query(
        `UPDATE notification_outbox
         SET status = $4, available_at = $5, lease_token = NULL, lease_expires_at = NULL,
             last_error_code = $6, failed_at = $7, updated_at = $8
         WHERE tenant_id = $1 AND id = $2 AND status = 'leased' AND lease_token = $3
         RETURNING id`,
        [
          job.tenantId,
          job.id,
          job.leaseToken,
          retry ? "retry" : "failed",
          retry ? nextRetryAt.toISOString() : finishedAt.toISOString(),
          result.code,
          retry ? null : finishedAt.toISOString(),
          finishedAt.toISOString(),
        ],
      );
      if (!updated.rowCount) throw new Error("notification lease was lost after provider rejection");
    });
    return retry ? "retry" : "failed";
  } catch {
    await markAmbiguous(database, job, attempt.id, clock());
    return "ambiguous";
  }
}

export async function processNotificationBatch(
  database: Database,
  provider: NotificationProvider,
  options: {
    batchSize: number;
    leaseSeconds: number;
    maxAttempts: number;
    now?: () => Date;
  },
) {
  const clock = options.now ?? (() => new Date());
  const jobs = await claimNotificationBatch(database, {
    batchSize: options.batchSize,
    leaseSeconds: options.leaseSeconds,
    now: clock(),
  });
  const outcomes = [];
  for (const job of jobs) {
    outcomes.push(await processClaimedNotification(database, provider, job, {
      maxAttempts: options.maxAttempts,
      now: clock,
    }));
  }
  return outcomes;
}

export async function recordDeliveryReceipt(
  database: Database,
  input: DeliveryReceiptInput,
): Promise<{ matched: boolean; duplicate: boolean }> {
  return database.transaction(async (tx) => {
    const match = await tx.query<{
      tenant_id: string;
      outbox_id: string;
      attempt_id: string;
    }>(
      `SELECT attempt.tenant_id, attempt.outbox_id, attempt.id AS attempt_id
       FROM notification_delivery_attempts attempt
       WHERE attempt.provider = $1
         AND (
           attempt.provider_message_id = $2
           OR ($3::uuid IS NOT NULL AND attempt.out_id = $3::uuid)
         )
       ORDER BY attempt.attempt_no DESC
       LIMIT 1`,
      [input.provider, input.providerMessageId, input.outId ?? null],
    );
    const found = match.rows[0];
    if (!found) return { matched: false, duplicate: false };

    const receiptKey = createHash("sha256").update([
      input.provider,
      input.providerMessageId,
      input.outId ?? "",
      input.status,
      input.providerCode ?? "",
      input.reportedAt.toISOString(),
    ].join("\0")).digest("hex");
    const receiptId = newId();
    const inserted = await tx.query(
      `INSERT INTO notification_delivery_receipts (
         id, tenant_id, outbox_id, attempt_id, provider, receipt_key,
         provider_message_id, status, provider_code, reported_at, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       ON CONFLICT (receipt_key) DO NOTHING
       RETURNING id`,
      [
        receiptId,
        found.tenant_id,
        found.outbox_id,
        found.attempt_id,
        input.provider,
        receiptKey,
        input.providerMessageId,
        input.status,
        input.providerCode ?? null,
        input.reportedAt.toISOString(),
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    if (!inserted.rowCount) return { matched: true, duplicate: true };

    if (input.status === "delivered") {
      await tx.query(
        `UPDATE notification_outbox
         SET status = 'delivered', provider = $3, provider_message_id = $4,
             delivered_at = $5, lease_token = NULL, lease_expires_at = NULL,
             last_error_code = NULL, updated_at = $5
         WHERE tenant_id = $1 AND id = $2 AND status <> 'delivered'`,
        [found.tenant_id, found.outbox_id, input.provider, input.providerMessageId, input.reportedAt.toISOString()],
      );
    } else if (input.status === "failed") {
      await tx.query(
        `UPDATE notification_outbox
         SET status = 'failed', provider = $3, provider_message_id = $4,
             failed_at = $5, lease_token = NULL, lease_expires_at = NULL,
             last_error_code = $6, updated_at = $5
         WHERE tenant_id = $1 AND id = $2 AND status NOT IN ('delivered', 'failed')`,
        [
          found.tenant_id,
          found.outbox_id,
          input.provider,
          input.providerMessageId,
          input.reportedAt.toISOString(),
          input.providerCode ?? "DELIVERY_FAILED",
        ],
      );
    }
    return { matched: true, duplicate: false };
  });
}

export async function writeWorkerHeartbeat(
  database: Database,
  input: {
    workerName: string;
    instanceId: string;
    releaseId: string;
    provider: string;
    startedAt: Date;
    seenAt: Date;
    scheduled?: boolean;
    delivered?: boolean;
    failed?: boolean;
  },
): Promise<void> {
  await database.query(
    `INSERT INTO notification_worker_heartbeats (
       worker_name, instance_id, release_id, provider, started_at, last_seen_at,
       last_schedule_at, last_delivery_at, last_error_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (worker_name) DO UPDATE
     SET instance_id = EXCLUDED.instance_id,
         release_id = EXCLUDED.release_id,
         provider = EXCLUDED.provider,
         started_at = CASE
           WHEN notification_worker_heartbeats.instance_id = EXCLUDED.instance_id
             THEN notification_worker_heartbeats.started_at
           ELSE EXCLUDED.started_at
         END,
         last_seen_at = EXCLUDED.last_seen_at,
         last_schedule_at = COALESCE(EXCLUDED.last_schedule_at, notification_worker_heartbeats.last_schedule_at),
         last_delivery_at = COALESCE(EXCLUDED.last_delivery_at, notification_worker_heartbeats.last_delivery_at),
         last_error_at = COALESCE(EXCLUDED.last_error_at, notification_worker_heartbeats.last_error_at),
         updated_at = EXCLUDED.last_seen_at`,
    [
      input.workerName,
      input.instanceId,
      input.releaseId,
      input.provider,
      input.startedAt.toISOString(),
      input.seenAt.toISOString(),
      input.scheduled ? input.seenAt.toISOString() : null,
      input.delivered ? input.seenAt.toISOString() : null,
      input.failed ? input.seenAt.toISOString() : null,
    ],
  );
}
