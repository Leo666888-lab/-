import { createHash } from "node:crypto";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import bcrypt from "bcryptjs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database, Queryable } from "./db/types.js";
import { writeAudit } from "./lib/audit.js";
import { ApiError } from "./lib/errors.js";
import { hashSessionToken, newId, newSessionToken } from "./lib/security.js";

const roleSchema = z.enum(["owner", "finance", "sales", "viewer"]);
type Role = z.infer<typeof roleSchema>;
const SESSION_COOKIE_NAME = "settlement_session";
const PAYMENT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const COOKIE_ORIGIN_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface AuthContext {
  sessionId: string;
  tenantId: string;
  tenantName: string;
  tenantTimezone: string;
  userId: string;
  phone: string;
  displayName: string;
  role: Role;
}

interface AppOptions {
  database: Database;
  sessionTtlHours?: number;
  closeDatabase?: boolean;
  logger?: boolean;
  isProduction?: boolean;
  bodyLimitBytes?: number;
  loginRateLimitMax?: number;
  publicOrigin?: string;
  serveStatic?: boolean;
  staticRoot?: string;
}

function normalizePhone(value: string): string {
  return value.trim();
}

const loginSchema = z.object({
  phone: z.string().transform(normalizePhone).pipe(z.string().min(5).max(32)),
  password: z.string().min(6).max(128),
  tenantId: z.uuid().optional(),
}).strict();

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
}).strict();

const itemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().int().positive().max(10_000_000),
  unitPriceCents: z.number().int().nonnegative().max(9_000_000_000),
}).strict();

const createOrderSchema = z.object({
  partnerId: z.uuid(),
  orderNo: z.string().trim().min(1).max(100),
  direction: z.enum(["receivable", "payable"]),
  orderDate: z.iso.date(),
  plannedDeliveryDate: z.iso.date().nullable().optional(),
  settlementDays: z.number().int().min(0).max(3650).default(0),
  settlementMonths: z.number().int().min(0).max(120).default(0),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("CNY"),
  notes: z.string().trim().max(2000).nullable().optional(),
  items: z.array(itemSchema).min(1).max(500),
}).strict().refine((value) => value.settlementDays === 0 || value.settlementMonths === 0, {
  message: "天数账期与月数账期不能同时设置",
  path: ["settlementMonths"],
});

const paymentSchema = z.object({
  amountCents: z.number().int().positive().max(9_000_000_000_000),
  method: z.string().trim().min(1).max(32),
  paidAt: z.iso.datetime({ offset: true }).optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  proofKey: z.string().trim().max(500).nullable().optional(),
}).strict();

const paymentReversalSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
}).strict();

const fulfillSchema = z.object({
  fulfilledAt: z.iso.datetime({ offset: true }).optional(),
}).strict();

const snoozeSchema = z.object({
  until: z.iso.datetime({ offset: true }),
}).strict();

const partnerKindSchema = z.enum(["customer", "supplier", "both"]);
const nullableContactSchema = z.string().trim().max(100).nullable();
const nullablePhoneSchema = z.string().trim().max(32).nullable();

const createPartnerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: partnerKindSchema,
  contactName: nullableContactSchema.optional(),
  phone: nullablePhoneSchema.optional(),
}).strict();

const updatePartnerSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
  kind: partnerKindSchema.optional(),
  contactName: nullableContactSchema.optional(),
  phone: nullablePhoneSchema.optional(),
}).strict().refine(
  (value) => value.name !== undefined || value.kind !== undefined || value.contactName !== undefined || value.phone !== undefined,
  { message: "至少提供一个需要修改的字段" },
);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "请求参数不正确", z.flattenError(result.error));
  }
  return result.data;
}

function money(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed)) throw new ApiError(500, "UNSAFE_MONEY_VALUE", "金额超出安全范围");
  return parsed;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function dateOnly(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function paymentRequestHash(orderId: string, input: z.infer<typeof paymentSchema>): string {
  return createHash("sha256").update(JSON.stringify({
    orderId,
    amountCents: input.amountCents,
    method: input.method,
    paidAt: input.paidAt ?? null,
    note: input.note ?? null,
    proofKey: input.proofKey ?? null,
  })).digest("hex");
}

function paymentReversalRequestHash(paymentId: string, input: z.infer<typeof paymentReversalSchema>): string {
  return createHash("sha256").update(JSON.stringify({
    paymentId,
    reason: input.reason,
  })).digest("hex");
}

function requestIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const idempotencyKey = (Array.isArray(header) ? header[0] : header)?.trim();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key 请求头必填且不能超过 128 个字符");
  }
  return idempotencyKey;
}

function requireRole(auth: AuthContext, allowed: Role[]): void {
  if (!allowed.includes(auth.role)) throw new ApiError(403, "FORBIDDEN", "当前角色没有此操作权限");
}

function requestSessionToken(request: FastifyRequest, publicOrigin: string): string {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice(7).trim();
    if (token) return token;
  }
  const cookieToken = request.cookies[SESSION_COOKIE_NAME];
  if (cookieToken) {
    if (COOKIE_ORIGIN_METHODS.has(request.method) && request.headers.origin !== publicOrigin) {
      throw new ApiError(403, "INVALID_ORIGIN", "请求来源无效，请刷新页面后重试");
    }
    return cookieToken;
  }
  throw new ApiError(401, "UNAUTHORIZED", "请先登录");
}

async function authenticate(database: Database, request: FastifyRequest, publicOrigin: string): Promise<AuthContext> {
  const tokenHash = hashSessionToken(requestSessionToken(request, publicOrigin));
  const result = await database.query<{
    session_id: string;
    tenant_id: string;
    tenant_name: string;
    tenant_timezone: string;
    user_id: string;
    phone: string;
    display_name: string;
    role: string;
  }>(
    `SELECT s.id AS session_id, s.tenant_id, t.name AS tenant_name, t.timezone AS tenant_timezone,
            s.user_id, u.phone, u.display_name, m.role
     FROM sessions s
     JOIN users u ON u.id = s.user_id AND u.is_active = true
     JOIN tenants t ON t.id = s.tenant_id
     JOIN memberships m ON m.tenant_id = s.tenant_id AND m.user_id = s.user_id AND m.is_active = true
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(401, "UNAUTHORIZED", "登录已过期，请重新登录");
  return {
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    tenantTimezone: row.tenant_timezone,
    userId: row.user_id,
    phone: row.phone,
    displayName: row.display_name,
    role: roleSchema.parse(row.role),
  };
}

function mapOrder(row: Record<string, unknown>) {
  const totalCents = money(row.total_cents);
  const paidCents = money(row.paid_cents);
  const fulfillmentStatus = String(row.fulfillment_status);
  const settlementStatus = fulfillmentStatus === "planned"
    ? "planned"
    : fulfillmentStatus === "cancelled"
      ? "cancelled"
      : paidCents === 0
        ? "awaiting"
        : paidCents < totalCents
          ? "partial"
          : "settled";
  return {
    id: row.id,
    partnerId: row.partner_id,
    partnerName: row.partner_name,
    orderNo: row.order_no,
    direction: row.direction,
    orderDate: dateOnly(row.order_date),
    plannedDeliveryDate: dateOnly(row.planned_delivery_date),
    fulfillmentStatus,
    settlementStatus,
    fulfilledAt: iso(row.fulfilled_at),
    settlementDays: Number(row.settlement_days),
    settlementMonths: Number(row.settlement_months),
    dueAt: iso(row.due_at),
    currency: row.currency,
    totalCents,
    paidCents,
    outstandingCents: totalCents - paidCents,
    notes: row.notes,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const orderSelect = `
  SELECT o.id, o.partner_id, p.name AS partner_name, o.order_no, o.direction, o.order_date,
         o.planned_delivery_date, o.fulfillment_status, o.fulfilled_at, o.settlement_days, o.settlement_months,
         o.due_at, o.currency, o.total_cents::text, o.notes, o.created_at, o.updated_at,
         COALESCE(SUM(CASE WHEN reversal.id IS NULL THEN pay.amount_cents ELSE 0 END), 0)::text AS paid_cents
  FROM orders o
  JOIN partners p ON p.tenant_id = o.tenant_id AND p.id = o.partner_id
  LEFT JOIN payments pay ON pay.tenant_id = o.tenant_id AND pay.order_id = o.id
  LEFT JOIN payment_reversals reversal
    ON reversal.tenant_id = pay.tenant_id
   AND reversal.payment_id = pay.id
   AND reversal.order_id = pay.order_id
`;

async function getOrder(database: Queryable, auth: AuthContext, orderId: string) {
  const orderResult = await database.query(
    `SELECT o.id, o.partner_id, p.name AS partner_name, o.order_no, o.direction, o.order_date,
            o.planned_delivery_date, o.fulfillment_status, o.fulfilled_at, o.settlement_days,
            o.settlement_months, o.due_at, o.currency, o.total_cents::text, o.notes,
            o.created_at, o.updated_at,
            COALESCE((
              SELECT SUM(pay.amount_cents)
              FROM payments pay
              WHERE pay.tenant_id = o.tenant_id
                AND pay.order_id = o.id
                AND NOT EXISTS (
                  SELECT 1 FROM payment_reversals reversal
                  WHERE reversal.tenant_id = pay.tenant_id
                    AND reversal.payment_id = pay.id
                    AND reversal.order_id = pay.order_id
                )
            ), 0)::text AS paid_cents,
            COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object(
                  'id', item.id,
                  'description', item.description,
                  'quantity', item.quantity,
                  'unitPriceCents', item.unit_price_cents::text,
                  'lineTotalCents', item.line_total_cents::text
                ) ORDER BY item.created_at, item.id
              )
              FROM order_items item
              WHERE item.tenant_id = o.tenant_id AND item.order_id = o.id
            ), '[]'::jsonb) AS items,
            COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object(
                  'id', pay.id,
                  'amountCents', pay.amount_cents::text,
                  'method', pay.method,
                  'paidAt', pay.paid_at,
                  'note', pay.note,
                  'proofKey', pay.proof_key,
                  'createdBy', pay.created_by,
                  'createdAt', pay.created_at,
                  'reversedAt', reversal.reversed_at,
                  'reversalReason', reversal.reason
                ) ORDER BY pay.paid_at, pay.created_at, pay.id
              )
              FROM payments pay
              LEFT JOIN payment_reversals reversal
                ON reversal.tenant_id = pay.tenant_id
               AND reversal.payment_id = pay.id
               AND reversal.order_id = pay.order_id
              WHERE pay.tenant_id = o.tenant_id AND pay.order_id = o.id
            ), '[]'::jsonb) AS payments
     FROM orders o
     JOIN partners p ON p.tenant_id = o.tenant_id AND p.id = o.partner_id
     WHERE o.tenant_id = $1 AND o.id = $2`,
    [auth.tenantId, orderId],
  );
  const row = orderResult.rows[0];
  if (!row) throw new ApiError(404, "NOT_FOUND", "订单不存在");
  const items = Array.isArray(row.items) ? row.items as Record<string, unknown>[] : [];
  const payments = Array.isArray(row.payments) ? row.payments as Record<string, unknown>[] : [];
  return {
    ...mapOrder(row),
    items: items.map((item) => ({
      id: item.id,
      description: item.description,
      quantity: Number(item.quantity),
      unitPriceCents: money(item.unitPriceCents),
      lineTotalCents: money(item.lineTotalCents),
    })),
    payments: payments.map((payment) => ({
      id: payment.id,
      amountCents: money(payment.amountCents),
      method: payment.method,
      paidAt: iso(payment.paidAt),
      note: payment.note,
      proofKey: payment.proofKey,
      createdBy: payment.createdBy,
      createdAt: iso(payment.createdAt),
      reversedAt: iso(payment.reversedAt),
      reversalReason: payment.reversalReason,
    })),
  };
}

async function listPartners(database: Queryable, tenantId: string) {
  const [partnersResult, balancesResult] = await Promise.all([
    database.query(
      `SELECT id, name, kind, contact_name, phone, version, created_at, updated_at
       FROM partners WHERE tenant_id = $1 ORDER BY name, id`,
      [tenantId],
    ),
    database.query(
      `SELECT o.partner_id, o.currency,
              COALESCE(SUM(CASE WHEN o.direction = 'receivable'
                THEN o.total_cents - COALESCE(pay.paid_cents, 0) ELSE 0 END), 0)::text AS receivable_cents,
              COALESCE(SUM(CASE WHEN o.direction = 'payable'
                THEN o.total_cents - COALESCE(pay.paid_cents, 0) ELSE 0 END), 0)::text AS payable_cents
       FROM orders o
       LEFT JOIN (
         SELECT pay.tenant_id, pay.order_id, SUM(pay.amount_cents) AS paid_cents
         FROM payments pay
         LEFT JOIN payment_reversals reversal
           ON reversal.tenant_id = pay.tenant_id
          AND reversal.payment_id = pay.id
          AND reversal.order_id = pay.order_id
         WHERE pay.tenant_id = $1 AND reversal.id IS NULL
         GROUP BY pay.tenant_id, pay.order_id
       ) pay ON pay.tenant_id = o.tenant_id AND pay.order_id = o.id
       WHERE o.tenant_id = $1 AND o.fulfillment_status = 'fulfilled'
       GROUP BY o.partner_id, o.currency
       ORDER BY o.partner_id, o.currency`,
      [tenantId],
    ),
  ]);
  const balancesByPartner = new Map<string, Array<{ currency: unknown; receivableCents: number; payableCents: number }>>();
  for (const row of balancesResult.rows) {
    const balances = balancesByPartner.get(String(row.partner_id)) ?? [];
    balances.push({
      currency: row.currency,
      receivableCents: money(row.receivable_cents),
      payableCents: money(row.payable_cents),
    });
    balancesByPartner.set(String(row.partner_id), balances);
  }
  return partnersResult.rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    contactName: row.contact_name,
    phone: row.phone,
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    balances: balancesByPartner.get(String(row.id)) ?? [],
  }));
}

async function getPartnerView(database: Queryable, tenantId: string, partnerId: string) {
  const partner = (await listPartners(database, tenantId)).find((item) => item.id === partnerId);
  if (!partner) throw new ApiError(404, "NOT_FOUND", "往来单位不存在");
  return partner;
}

async function listReminders(database: Queryable, auth: AuthContext) {
  const result = await database.query(
    `SELECT r.id, r.order_id, r.due_at, r.status, r.snoozed_until,
            o.order_no, o.direction, o.total_cents::text, p.name AS partner_name,
            COALESCE(SUM(CASE WHEN reversal.id IS NULL THEN pay.amount_cents ELSE 0 END), 0)::text AS paid_cents
     FROM reminders r
     JOIN orders o ON o.tenant_id = r.tenant_id AND o.id = r.order_id AND o.fulfillment_status = 'fulfilled'
     JOIN partners p ON p.tenant_id = o.tenant_id AND p.id = o.partner_id
     LEFT JOIN payments pay ON pay.tenant_id = o.tenant_id AND pay.order_id = o.id
     LEFT JOIN payment_reversals reversal
       ON reversal.tenant_id = pay.tenant_id
      AND reversal.payment_id = pay.id
      AND reversal.order_id = pay.order_id
     WHERE r.tenant_id = $1
       AND (
         (r.status = 'open' AND r.due_at <= (((now() AT TIME ZONE $2) + interval '7 days') AT TIME ZONE $2))
         OR (r.status IN ('acked', 'snoozed') AND r.snoozed_until <= now())
       )
     GROUP BY r.id, o.id, p.name
     ORDER BY COALESCE(r.snoozed_until, r.due_at), r.id`,
    [auth.tenantId, auth.tenantTimezone],
  );
  return result.rows.map((row) => {
    const totalCents = money(row.total_cents);
    const paidCents = money(row.paid_cents);
    return {
      id: row.id,
      orderId: row.order_id,
      orderNo: row.order_no,
      partnerName: row.partner_name,
      direction: row.direction,
      dueAt: iso(row.due_at),
      status: row.status,
      snoozedUntil: iso(row.snoozed_until),
      outstandingCents: totalCents - paidCents,
    };
  });
}

export function buildApp(options: AppOptions): FastifyInstance {
  const isProduction = options.isProduction ?? false;
  if (isProduction && !options.publicOrigin) {
    throw new Error("publicOrigin is required in production");
  }
  const publicOriginUrl = new URL(options.publicOrigin ?? "http://127.0.0.1:666");
  if (publicOriginUrl.protocol !== "http:" && publicOriginUrl.protocol !== "https:") {
    throw new Error("publicOrigin must use http:// or https://");
  }
  if (isProduction && publicOriginUrl.protocol !== "https:") {
    throw new Error("publicOrigin must use https:// in production");
  }
  const publicOrigin = publicOriginUrl.origin;
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: options.bodyLimitBytes ?? 1_048_576,
    trustProxy: ["127.0.0.0/8", "::1/128"],
  });
  const database = options.database;
  const sessionTtlHours = options.sessionTtlHours ?? 168;
  const loginRateLimitMax = options.loginRateLimitMax ?? 5;
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();

  void app.register(cookie);
  void app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        formAction: ["'self'"],
        upgradeInsecureRequests: isProduction ? [] : null,
      },
    },
    strictTransportSecurity: isProduction ? undefined : false,
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });
  const enforceLoginRateLimit = async (request: FastifyRequest, reply: FastifyReply) => {
    const rawPhone = typeof request.body === "object" && request.body !== null && "phone" in request.body
      ? (request.body as { phone?: unknown }).phone
      : undefined;
    const phone = typeof rawPhone === "string" ? normalizePhone(rawPhone).slice(0, 64) : "";
    const key = `${request.ip}:${phone}`;
    const now = Date.now();
    const current = loginAttempts.get(key);
    const attempt = !current || current.resetAt <= now
      ? { count: 1, resetAt: now + 60_000 }
      : { count: current.count + 1, resetAt: current.resetAt };
    loginAttempts.set(key, attempt);
    reply.header("X-RateLimit-Limit", loginRateLimitMax);
    reply.header("X-RateLimit-Remaining", Math.max(0, loginRateLimitMax - attempt.count));
    if (attempt.count > loginRateLimitMax) {
      reply.header("Retry-After", Math.max(1, Math.ceil((attempt.resetAt - now) / 1000)));
      throw new ApiError(429, "LOGIN_RATE_LIMITED", "登录尝试过于频繁，请稍后再试");
    }
    if (loginAttempts.size > 10_000) {
      for (const [storedKey, value] of loginAttempts) {
        if (value.resetAt <= now) loginAttempts.delete(storedKey);
      }
      if (loginAttempts.size > 10_000) loginAttempts.delete(loginAttempts.keys().next().value as string);
    }
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      void reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    const databaseError = error as Error & { code?: string; constraint?: string };
    if (databaseError.code === "23505") {
      void reply.status(409).send({ error: { code: "CONFLICT", message: "数据已存在，请勿重复提交" } });
      return;
    }
    const httpError = error as Error & { statusCode?: number; code?: string };
    if (httpError.statusCode && httpError.statusCode >= 400 && httpError.statusCode < 500) {
      void reply.status(httpError.statusCode).send({
        error: {
          code: httpError.statusCode === 413 ? "PAYLOAD_TOO_LARGE" : (httpError.code ?? "REQUEST_REJECTED"),
          message: httpError.statusCode === 413 ? "请求内容过大" : httpError.message,
        },
      });
      return;
    }
    app.log.error(error);
    void reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "服务器处理失败" } });
  });

  app.get("/api/health", async () => {
    await database.query("SELECT 1");
    return { status: "ok", time: new Date().toISOString() };
  });

  app.post("/api/auth/login", {
    preHandler: enforceLoginRateLimit,
  }, async (request, reply) => {
    const input = parse(loginSchema, request.body);
    const token = newSessionToken();
    const sessionId = newId();
    const expiresAt = new Date(Date.now() + sessionTtlHours * 3_600_000);
    const user = await database.transaction(async (tx) => {
      const result = await tx.query<{
      user_id: string;
      phone: string;
      display_name: string;
      password_hash: string;
      tenant_id: string;
      tenant_name: string;
      tenant_timezone: string;
      role: string;
      }>(
        `SELECT u.id AS user_id, u.phone, u.display_name, u.password_hash,
                m.tenant_id, t.name AS tenant_name, t.timezone AS tenant_timezone, m.role
         FROM users u
         JOIN memberships m ON m.user_id = u.id AND m.is_active = true
         JOIN tenants t ON t.id = m.tenant_id
         WHERE u.phone = $1 AND u.is_active = true
           AND ($2::uuid IS NULL OR m.tenant_id = $2::uuid)
         ORDER BY m.created_at
         LIMIT 1
         FOR UPDATE OF u`,
        [input.phone, input.tenantId ?? null],
      );
      const lockedUser = result.rows[0];
      if (!lockedUser || !(await bcrypt.compare(input.password, lockedUser.password_hash))) {
        throw new ApiError(401, "INVALID_CREDENTIALS", "手机号或密码错误");
      }
      await tx.query(
        `INSERT INTO sessions (id, tenant_id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, lockedUser.tenant_id, lockedUser.user_id, hashSessionToken(token), expiresAt.toISOString()],
      );
      await writeAudit(tx, {
        tenantId: lockedUser.tenant_id,
        actorUserId: lockedUser.user_id,
        action: "auth.login",
        entityType: "session",
        entityId: sessionId,
      });
      return lockedUser;
    });
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: isProduction,
      maxAge: sessionTtlHours * 3_600,
    });
    reply.header("Cache-Control", "no-store");
    return reply.send({
      token,
      expiresAt: expiresAt.toISOString(),
      user: { id: user.user_id, phone: user.phone, displayName: user.display_name },
      tenant: { id: user.tenant_id, name: user.tenant_name, timezone: user.tenant_timezone },
      role: roleSchema.parse(user.role),
    });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const auth = await authenticate(database, request, publicOrigin);
    await database.transaction(async (tx) => {
      await tx.query(
        `UPDATE sessions SET revoked_at = now()
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND revoked_at IS NULL`,
        [auth.sessionId, auth.tenantId, auth.userId],
      );
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "auth.logout",
        entityType: "session",
        entityId: auth.sessionId,
      });
    });
    reply.clearCookie(SESSION_COOKIE_NAME, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: isProduction,
    });
    reply.header("Cache-Control", "no-store");
    return reply.send({ success: true });
  });

  app.post("/api/auth/change-password", async (request, reply) => {
    const auth = await authenticate(database, request, publicOrigin);
    const input = parse(changePasswordSchema, request.body);
    if (input.currentPassword === input.newPassword) {
      throw new ApiError(400, "PASSWORD_UNCHANGED", "新密码不能与当前密码相同");
    }
    let revokedSessions = 0;
    await database.transaction(async (tx) => {
      const userResult = await tx.query<{ password_hash: string }>(
        `SELECT u.password_hash
         FROM users u
         JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $2 AND m.is_active = true
         WHERE u.id = $1 AND u.is_active = true
         FOR UPDATE OF u`,
        [auth.userId, auth.tenantId],
      );
      const currentHash = userResult.rows[0]?.password_hash;
      if (!currentHash || !(await bcrypt.compare(input.currentPassword, currentHash))) {
        throw new ApiError(401, "INVALID_CURRENT_PASSWORD", "当前密码不正确");
      }
      const nextHash = await bcrypt.hash(input.newPassword, 12);
      await tx.query(
        `UPDATE users SET password_hash = $2, updated_at = now()
         WHERE id = $1`,
        [auth.userId, nextHash],
      );
      const revoked = await tx.query(
        `UPDATE sessions SET revoked_at = now()
         WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL
         RETURNING id`,
        [auth.userId, auth.sessionId],
      );
      revokedSessions = revoked.rowCount;
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "auth.password_changed",
        entityType: "user",
        entityId: auth.userId,
        metadata: { revokedSessions },
      });
    });
    reply.header("Cache-Control", "no-store");
    return reply.send({ success: true, revokedSessions });
  });

  app.get("/api/bootstrap", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    const [ordersResult, partners, reminders] = await Promise.all([
      database.query(
        `${orderSelect}
         WHERE o.tenant_id = $1
         GROUP BY o.id, p.name
         ORDER BY o.created_at DESC, o.id`,
        [auth.tenantId],
      ),
      listPartners(database, auth.tenantId),
      listReminders(database, auth),
    ]);
    return {
      user: { id: auth.userId, phone: auth.phone, displayName: auth.displayName },
      tenant: { id: auth.tenantId, name: auth.tenantName, timezone: auth.tenantTimezone },
      role: auth.role,
      orders: ordersResult.rows.map(mapOrder),
      partners,
      reminders,
    };
  });

  const readPartners = async (request: FastifyRequest) => {
    const auth = await authenticate(database, request, publicOrigin);
    return listPartners(database, auth.tenantId);
  };

  const createPartner = async (request: FastifyRequest) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance", "sales"]);
    const input = parse(createPartnerSchema, request.body);
    const partnerId = newId();
    await database.transaction(async (tx) => {
      const duplicate = await tx.query(
        "SELECT id FROM partners WHERE tenant_id = $1 AND name = $2",
        [auth.tenantId, input.name],
      );
      if (duplicate.rowCount) throw new ApiError(409, "DUPLICATE_PARTNER_NAME", "往来单位名称已存在");
      await tx.query(
        `INSERT INTO partners (id, tenant_id, name, kind, contact_name, phone)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [partnerId, auth.tenantId, input.name, input.kind, input.contactName ?? null, input.phone ?? null],
      );
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "partner.created",
        entityType: "partner",
        entityId: partnerId,
        metadata: { name: input.name, kind: input.kind },
      });
    });
    return getPartnerView(database, auth.tenantId, partnerId);
  };

  const updatePartner = async (request: FastifyRequest) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance", "sales"]);
    const params = parse(z.object({ id: z.uuid() }), request.params);
    const input = parse(updatePartnerSchema, request.body);
    await database.transaction(async (tx) => {
      const currentResult = await tx.query<{
        name: string;
        kind: "customer" | "supplier" | "both";
        contact_name: string | null;
        phone: string | null;
        version: number;
      }>(
        `SELECT name, kind, contact_name, phone, version FROM partners
         WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [auth.tenantId, params.id],
      );
      const current = currentResult.rows[0];
      if (!current) throw new ApiError(404, "NOT_FOUND", "往来单位不存在");
      if (Number(current.version) !== input.version) {
        throw new ApiError(409, "PARTNER_VERSION_CONFLICT", "往来单位已被其他人修改，请刷新后重试", {
          currentVersion: Number(current.version),
        });
      }
      const nextName = input.name ?? current.name;
      const nextKind = input.kind ?? current.kind;
      if (nextName !== current.name) {
        const duplicate = await tx.query(
          "SELECT id FROM partners WHERE tenant_id = $1 AND name = $2 AND id <> $3",
          [auth.tenantId, nextName, params.id],
        );
        if (duplicate.rowCount) throw new ApiError(409, "DUPLICATE_PARTNER_NAME", "往来单位名称已存在");
      }
      if (nextKind !== "both") {
        const incompatibleDirection = nextKind === "customer" ? "payable" : "receivable";
        const incompatible = await tx.query(
          `SELECT id FROM orders
           WHERE tenant_id = $1 AND partner_id = $2 AND direction = $3 LIMIT 1`,
          [auth.tenantId, params.id, incompatibleDirection],
        );
        if (incompatible.rowCount) {
          throw new ApiError(409, "PARTNER_KIND_IN_USE", "现有订单与新的往来单位类型不兼容");
        }
      }
      const updated = await tx.query(
        `UPDATE partners
         SET name = $3, kind = $4, contact_name = $5, phone = $6,
             version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND version = $7
         RETURNING id`,
        [
          auth.tenantId,
          params.id,
          nextName,
          nextKind,
          input.contactName !== undefined ? input.contactName : current.contact_name,
          input.phone !== undefined ? input.phone : current.phone,
          input.version,
        ],
      );
      if (!updated.rowCount) throw new ApiError(409, "PARTNER_VERSION_CONFLICT", "往来单位已被其他人修改，请刷新后重试");
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "partner.updated",
        entityType: "partner",
        entityId: params.id,
        metadata: { fromVersion: input.version, toVersion: input.version + 1, changes: input },
      });
    });
    return getPartnerView(database, auth.tenantId, params.id);
  };

  app.get("/api/partners", async (request) => ({ partners: await readPartners(request) }));
  app.get("/api/contacts", async (request) => ({ contacts: await readPartners(request) }));
  app.post("/api/partners", async (request, reply) => reply.status(201).send({ partner: await createPartner(request) }));
  app.post("/api/contacts", async (request, reply) => reply.status(201).send({ contact: await createPartner(request) }));
  app.patch("/api/partners/:id", async (request) => ({ partner: await updatePartner(request) }));
  app.patch("/api/contacts/:id", async (request) => ({ contact: await updatePartner(request) }));

  app.get("/api/orders", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    const query = parse(z.object({
      direction: z.enum(["receivable", "payable"]).optional(),
      fulfillmentStatus: z.enum(["planned", "fulfilled", "cancelled"]).optional(),
    }), request.query);
    const result = await database.query(
      `${orderSelect}
       WHERE o.tenant_id = $1
         AND ($2::text IS NULL OR o.direction = $2)
         AND ($3::text IS NULL OR o.fulfillment_status = $3)
       GROUP BY o.id, p.name
       ORDER BY o.created_at DESC, o.id`,
      [auth.tenantId, query.direction ?? null, query.fulfillmentStatus ?? null],
    );
    return { orders: result.rows.map(mapOrder) };
  });

  app.post("/api/orders", async (request, reply) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance", "sales"]);
    const input = parse(createOrderSchema, request.body);
    const calculatedItems = input.items.map((item) => {
      const lineTotalCents = item.quantity * item.unitPriceCents;
      if (!Number.isSafeInteger(lineTotalCents)) throw new ApiError(400, "AMOUNT_TOO_LARGE", "商品金额超出安全范围");
      return { ...item, lineTotalCents };
    });
    const totalCents = calculatedItems.reduce((sum, item) => sum + item.lineTotalCents, 0);
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
      throw new ApiError(400, "INVALID_TOTAL", "订单总额必须大于 0 且不能超出安全范围");
    }
    const orderId = newId();
    await database.transaction(async (tx) => {
      const partnerResult = await tx.query<{ kind: string }>(
        "SELECT kind FROM partners WHERE tenant_id = $1 AND id = $2",
        [auth.tenantId, input.partnerId],
      );
      const partner = partnerResult.rows[0];
      if (!partner) throw new ApiError(404, "PARTNER_NOT_FOUND", "往来单位不存在");
      const validKind = partner.kind === "both"
        || (input.direction === "receivable" && partner.kind === "customer")
        || (input.direction === "payable" && partner.kind === "supplier");
      if (!validKind) throw new ApiError(400, "PARTNER_KIND_MISMATCH", "往来单位类型与收付方向不匹配");
      const duplicate = await tx.query(
        "SELECT id FROM orders WHERE tenant_id = $1 AND order_no = $2",
        [auth.tenantId, input.orderNo],
      );
      if (duplicate.rowCount) throw new ApiError(409, "DUPLICATE_ORDER_NO", "订单号已存在");
      await tx.query(
        `INSERT INTO orders (
           id, tenant_id, partner_id, order_no, direction, order_date, planned_delivery_date,
           fulfillment_status, settlement_days, settlement_months, currency, total_cents, notes, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'planned', $8, $9, $10, $11, $12, $13)`,
        [orderId, auth.tenantId, input.partnerId, input.orderNo, input.direction, input.orderDate,
          input.plannedDeliveryDate ?? null, input.settlementDays, input.settlementMonths, input.currency, totalCents,
          input.notes ?? null, auth.userId],
      );
      for (const item of calculatedItems) {
        await tx.query(
          `INSERT INTO order_items
             (id, tenant_id, order_id, description, quantity, unit_price_cents, line_total_cents)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [newId(), auth.tenantId, orderId, item.description, item.quantity, item.unitPriceCents, item.lineTotalCents],
        );
      }
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "order.created",
        entityType: "order",
        entityId: orderId,
        metadata: { orderNo: input.orderNo, totalCents, fulfillmentStatus: "planned" },
      });
    });
    return reply.status(201).send({ order: await getOrder(database, auth, orderId) });
  });

  app.get("/api/orders/:id", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    const params = parse(z.object({ id: z.uuid() }), request.params);
    return { order: await getOrder(database, auth, params.id) };
  });

  app.post("/api/orders/:id/cancel", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance", "sales"]);
    const params = parse(z.object({ id: z.uuid() }), request.params);
    let replayed = false;
    await database.transaction(async (tx) => {
      const orderResult = await tx.query<{ fulfillment_status: string }>(
        `SELECT fulfillment_status FROM orders
         WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [auth.tenantId, params.id],
      );
      const order = orderResult.rows[0];
      if (!order) throw new ApiError(404, "NOT_FOUND", "订单不存在");
      if (order.fulfillment_status === "cancelled") {
        replayed = true;
        return;
      }
      if (order.fulfillment_status !== "planned") {
        throw new ApiError(409, "ORDER_NOT_PLANNED", "只有待交货订单可以取消");
      }
      const payments = await tx.query(
        `SELECT id FROM payments
         WHERE tenant_id = $1 AND order_id = $2
         LIMIT 1`,
        [auth.tenantId, params.id],
      );
      if (payments.rowCount) {
        throw new ApiError(409, "ORDER_HAS_PAYMENTS", "已有收付款记录的订单不能取消");
      }
      await tx.query(
        `UPDATE orders
         SET fulfillment_status = 'cancelled', updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [auth.tenantId, params.id],
      );
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "order.cancelled",
        entityType: "order",
        entityId: params.id,
      });
    });
    return {
      order: await getOrder(database, auth, params.id),
      idempotentReplay: replayed,
    };
  });

  app.post("/api/orders/:id/fulfill", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance", "sales"]);
    const params = parse(z.object({ id: z.uuid() }), request.params);
    const input = parse(fulfillSchema, request.body ?? {});
    await database.transaction(async (tx) => {
      const result = await tx.query<{ fulfillment_status: string; settlement_days: number; settlement_months: number }>(
        `SELECT fulfillment_status, settlement_days, settlement_months FROM orders
         WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [auth.tenantId, params.id],
      );
      const order = result.rows[0];
      if (!order) throw new ApiError(404, "NOT_FOUND", "订单不存在");
      if (order.fulfillment_status === "cancelled") throw new ApiError(409, "ORDER_CANCELLED", "已取消订单不能确认交货");
      if (order.fulfillment_status === "fulfilled") return;
      const fulfilledAt = input.fulfilledAt ? new Date(input.fulfilledAt) : new Date();
      const dueResult = await tx.query<{ due_at: Date | string }>(
        `SELECT ((($1::timestamptz AT TIME ZONE $2)
                  + make_interval(months => $3, days => $4))
                 AT TIME ZONE $2) AS due_at`,
        [fulfilledAt.toISOString(), auth.tenantTimezone, Number(order.settlement_months), Number(order.settlement_days)],
      );
      const dueAt = new Date(String(dueResult.rows[0]?.due_at));
      if (Number.isNaN(dueAt.getTime())) throw new ApiError(500, "DUE_DATE_CALCULATION_FAILED", "账期计算失败");
      await tx.query(
        `UPDATE orders SET fulfillment_status = 'fulfilled', fulfilled_at = $3, due_at = $4, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [auth.tenantId, params.id, fulfilledAt.toISOString(), dueAt.toISOString()],
      );
      const reminderId = newId();
      await tx.query(
        `INSERT INTO reminders (id, tenant_id, order_id, due_at, status)
         VALUES ($1, $2, $3, $4, 'open')`,
        [reminderId, auth.tenantId, params.id, dueAt.toISOString()],
      );
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "reminder.created",
        entityType: "reminder",
        entityId: reminderId,
        metadata: { orderId: params.id, dueAt: dueAt.toISOString() },
      });
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "order.fulfilled",
        entityType: "order",
        entityId: params.id,
        metadata: { fulfilledAt: fulfilledAt.toISOString(), dueAt: dueAt.toISOString() },
      });
    });
    return { order: await getOrder(database, auth, params.id) };
  });

  app.post("/api/orders/:id/payments", async (request, reply) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance"]);
    const params = parse(z.object({ id: z.uuid() }), request.params);
    const input = parse(paymentSchema, request.body);
    const idempotencyKey = requestIdempotencyKey(request);
    const requestHash = paymentRequestHash(params.id, input);
    let paymentId = "";
    let replayed = false;
    await database.transaction(async (tx) => {
      // Serialize this tenant/key pair, including concurrent retries against different orders.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${auth.tenantId}:${idempotencyKey}`]);
      const existing = await tx.query<{ id: string; order_id: string; request_hash: string }>(
        `SELECT id, order_id, request_hash FROM payments
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [auth.tenantId, idempotencyKey],
      );
      const prior = existing.rows[0];
      if (prior) {
        if (prior.order_id !== params.id || prior.request_hash !== requestHash) {
          throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "该幂等键已用于另一笔付款");
        }
        paymentId = prior.id;
        replayed = true;
        return;
      }
      const orderResult = await tx.query<{ fulfillment_status: string; fulfilled_at: Date | string; total_cents: string }>(
        `SELECT fulfillment_status, fulfilled_at, total_cents::text FROM orders
         WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [auth.tenantId, params.id],
      );
      const order = orderResult.rows[0];
      if (!order) throw new ApiError(404, "NOT_FOUND", "订单不存在");
      if (order.fulfillment_status !== "fulfilled") {
        throw new ApiError(409, "ORDER_NOT_FULFILLED", "订单确认交货后才能收付款");
      }
      const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
      if (paidAt.getTime() > Date.now() + PAYMENT_CLOCK_SKEW_MS) {
        throw new ApiError(400, "PAYMENT_IN_FUTURE", "收付款时间不能晚于当前时间 5 分钟以上");
      }
      if (paidAt.getTime() < new Date(order.fulfilled_at).getTime()) {
        throw new ApiError(400, "PAYMENT_BEFORE_FULFILLMENT", "收付款时间不能早于实际交货时间");
      }
      const paidResult = await tx.query<{ paid_cents: string }>(
        `SELECT COALESCE(SUM(pay.amount_cents), 0)::text AS paid_cents
         FROM payments pay
         LEFT JOIN payment_reversals reversal
           ON reversal.tenant_id = pay.tenant_id
          AND reversal.payment_id = pay.id
          AND reversal.order_id = pay.order_id
         WHERE pay.tenant_id = $1 AND pay.order_id = $2 AND reversal.id IS NULL`,
        [auth.tenantId, params.id],
      );
      const totalCents = money(order.total_cents);
      const paidCents = money(paidResult.rows[0]?.paid_cents);
      const outstandingCents = totalCents - paidCents;
      if (input.amountCents > outstandingCents) {
        throw new ApiError(409, "PAYMENT_EXCEEDS_OUTSTANDING", "付款金额不能超过未结金额", { outstandingCents });
      }
      paymentId = newId();
      await tx.query(
        `INSERT INTO payments (
           id, tenant_id, order_id, amount_cents, method, paid_at, note, proof_key, idempotency_key, request_hash, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [paymentId, auth.tenantId, params.id, input.amountCents, input.method,
          paidAt.toISOString(), input.note ?? null, input.proofKey ?? null,
          idempotencyKey, requestHash, auth.userId],
      );
      const remainingCents = outstandingCents - input.amountCents;
      if (remainingCents === 0) {
        const closedReminders = await tx.query<{ id: string }>(
          `UPDATE reminders
           SET status = 'closed', closed_at = now(), updated_at = now()
           WHERE tenant_id = $1 AND order_id = $2 AND status IN ('open', 'snoozed', 'acked')
           RETURNING id`,
          [auth.tenantId, params.id],
        );
        for (const reminder of closedReminders.rows) {
          await writeAudit(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: "reminder.closed",
            entityType: "reminder",
            entityId: reminder.id,
            metadata: { orderId: params.id, paymentId },
          });
        }
      }
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "payment.created",
        entityType: "payment",
        entityId: paymentId,
        metadata: { orderId: params.id, amountCents: input.amountCents, remainingCents, idempotencyKey },
      });
    });
    return reply.status(replayed ? 200 : 201).send({
      payment: { id: paymentId },
      idempotentReplay: replayed,
      order: await getOrder(database, auth, params.id),
    });
  });

  app.post("/api/payments/:id/reverse", async (request, reply) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance"]);
    const params = parse(z.object({ id: z.uuid() }), request.params);
    const input = parse(paymentReversalSchema, request.body);
    const idempotencyKey = requestIdempotencyKey(request);
    const requestHash = paymentReversalRequestHash(params.id, input);
    let replayed = false;
    let reversal: {
      id: string;
      paymentId: string;
      orderId: string;
      reason: string;
      reversedBy: string;
      reversedAt: string | null;
    } | undefined;

    await database.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${auth.tenantId}:${idempotencyKey}`]);
      const existingByKey = await tx.query<{
        id: string;
        payment_id: string;
        order_id: string;
        reason: string;
        request_hash: string;
        reversed_by: string;
        reversed_at: Date | string;
      }>(
        `SELECT id, payment_id, order_id, reason, request_hash, reversed_by, reversed_at
         FROM payment_reversals
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [auth.tenantId, idempotencyKey],
      );
      const prior = existingByKey.rows[0];
      if (prior) {
        if (prior.payment_id !== params.id || prior.request_hash !== requestHash) {
          throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "该幂等键已用于另一笔冲销");
        }
        replayed = true;
        reversal = {
          id: prior.id,
          paymentId: prior.payment_id,
          orderId: prior.order_id,
          reason: prior.reason,
          reversedBy: prior.reversed_by,
          reversedAt: iso(prior.reversed_at),
        };
        return;
      }

      const paymentLookup = await tx.query<{ order_id: string }>(
        `SELECT order_id FROM payments
         WHERE tenant_id = $1 AND id = $2`,
        [auth.tenantId, params.id],
      );
      const paymentReference = paymentLookup.rows[0];
      if (!paymentReference) throw new ApiError(404, "NOT_FOUND", "收付款记录不存在");

      const orderResult = await tx.query<{
        fulfillment_status: string;
        total_cents: string;
        due_at: Date | string | null;
      }>(
        `SELECT fulfillment_status, total_cents::text, due_at
         FROM orders
         WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [auth.tenantId, paymentReference.order_id],
      );
      const order = orderResult.rows[0];
      if (!order) throw new ApiError(404, "NOT_FOUND", "订单不存在");

      const paymentResult = await tx.query<{
        order_id: string;
        amount_cents: string;
      }>(
        `SELECT order_id, amount_cents::text FROM payments
         WHERE tenant_id = $1 AND id = $2 AND order_id = $3
         FOR UPDATE`,
        [auth.tenantId, params.id, paymentReference.order_id],
      );
      const payment = paymentResult.rows[0];
      if (!payment) throw new ApiError(404, "NOT_FOUND", "收付款记录不存在");

      const existingReversal = await tx.query(
        `SELECT id FROM payment_reversals
         WHERE tenant_id = $1 AND payment_id = $2`,
        [auth.tenantId, params.id],
      );
      if (existingReversal.rowCount) {
        throw new ApiError(409, "PAYMENT_ALREADY_REVERSED", "该笔收付款已经冲销");
      }

      const paidResult = await tx.query<{ paid_cents: string }>(
        `SELECT COALESCE(SUM(pay.amount_cents), 0)::text AS paid_cents
         FROM payments pay
         LEFT JOIN payment_reversals existing
           ON existing.tenant_id = pay.tenant_id
          AND existing.payment_id = pay.id
          AND existing.order_id = pay.order_id
         WHERE pay.tenant_id = $1 AND pay.order_id = $2 AND existing.id IS NULL`,
        [auth.tenantId, payment.order_id],
      );
      const preReversalPaidCents = money(paidResult.rows[0]?.paid_cents);
      const reversalId = newId();
      const inserted = await tx.query<{ reversed_at: Date | string }>(
        `INSERT INTO payment_reversals (
           id, tenant_id, payment_id, order_id, reason, idempotency_key,
           request_hash, reversed_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING reversed_at`,
        [reversalId, auth.tenantId, params.id, payment.order_id, input.reason,
          idempotencyKey, requestHash, auth.userId],
      );
      reversal = {
        id: reversalId,
        paymentId: params.id,
        orderId: payment.order_id,
        reason: input.reason,
        reversedBy: auth.userId,
        reversedAt: iso(inserted.rows[0]?.reversed_at),
      };

      if (order.fulfillment_status === "fulfilled"
          && preReversalPaidCents === money(order.total_cents)
          && order.due_at !== null) {
        const reminderId = newId();
        await tx.query(
          `INSERT INTO reminders (id, tenant_id, order_id, due_at, status)
           VALUES ($1, $2, $3, $4, 'open')`,
          [reminderId, auth.tenantId, payment.order_id, order.due_at],
        );
        await writeAudit(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: "reminder.created",
          entityType: "reminder",
          entityId: reminderId,
          metadata: {
            orderId: payment.order_id,
            paymentId: params.id,
            reversalId,
            dueAt: iso(order.due_at),
          },
        });
      }

      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "payment.reversed",
        entityType: "payment",
        entityId: params.id,
        metadata: {
          orderId: payment.order_id,
          reversalId,
          amountCents: money(payment.amount_cents),
          reason: input.reason,
          idempotencyKey,
        },
      });
    });

    if (!reversal) throw new ApiError(500, "REVERSAL_FAILED", "冲销记录创建失败");
    return reply.status(replayed ? 200 : 201).send({
      reversal,
      idempotentReplay: replayed,
      order: await getOrder(database, auth, reversal.orderId),
    });
  });

  app.post("/api/reminders/:id/ack", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance", "sales"]);
    const params = parse(z.object({ id: z.uuid() }), request.params);
    let nextReminderAt = "";
    await database.transaction(async (tx) => {
      const result = await tx.query<{ status: string }>(
        "SELECT status FROM reminders WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [auth.tenantId, params.id],
      );
      const reminder = result.rows[0];
      if (!reminder) throw new ApiError(404, "NOT_FOUND", "提醒不存在");
      if (reminder.status === "closed") throw new ApiError(409, "REMINDER_CLOSED", "已结清提醒不能再次处理");
      const updated = await tx.query<{ snoozed_until: Date | string }>(
        `UPDATE reminders
         SET status = 'acked', acknowledged_at = now(),
             snoozed_until = ((((now() AT TIME ZONE $3)::date + 1) + time '09:00') AT TIME ZONE $3),
             updated_at = now()
         WHERE tenant_id = $1 AND id = $2
         RETURNING snoozed_until`,
        [auth.tenantId, params.id, auth.tenantTimezone],
      );
      nextReminderAt = new Date(String(updated.rows[0]?.snoozed_until)).toISOString();
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "reminder.acknowledged",
        entityType: "reminder",
        entityId: params.id,
        metadata: { nextReminderAt },
      });
    });
    return { reminder: { id: params.id, status: "acked", snoozedUntil: nextReminderAt } };
  });

  app.post("/api/reminders/:id/snooze", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance", "sales"]);
    const params = parse(z.object({ id: z.uuid() }), request.params);
    const input = parse(snoozeSchema, request.body);
    const until = new Date(input.until);
    if (until.getTime() <= Date.now()) throw new ApiError(400, "INVALID_SNOOZE_TIME", "暂缓时间必须晚于当前时间");
    await database.transaction(async (tx) => {
      const result = await tx.query<{ status: string }>(
        "SELECT status FROM reminders WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [auth.tenantId, params.id],
      );
      const reminder = result.rows[0];
      if (!reminder) throw new ApiError(404, "NOT_FOUND", "提醒不存在");
      if (reminder.status === "closed") throw new ApiError(409, "REMINDER_CLOSED", "已结清提醒不能暂缓");
      await tx.query(
        `UPDATE reminders SET status = 'snoozed', snoozed_until = $3, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [auth.tenantId, params.id, until.toISOString()],
      );
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "reminder.snoozed",
        entityType: "reminder",
        entityId: params.id,
        metadata: { until: until.toISOString() },
      });
    });
    return { reminder: { id: params.id, status: "snoozed", snoozedUntil: until.toISOString() } };
  });

  app.get("/api/audit", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance"]);
    const query = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }), request.query);
    const result = await database.query(
      `SELECT a.id, a.actor_user_id, u.display_name AS actor_name, a.action,
              a.entity_type, a.entity_id, a.metadata, a.created_at
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.tenant_id = $1
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $2`,
      [auth.tenantId, query.limit],
    );
    return {
      audit: result.rows.map((row) => ({
        id: row.id,
        actorUserId: row.actor_user_id,
        actorName: row.actor_name,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        metadata: row.metadata,
        createdAt: iso(row.created_at),
      })),
    };
  });

  if (options.serveStatic) {
    void app.register(fastifyStatic, {
      root: options.staticRoot ?? resolve(process.cwd(), "public"),
      prefix: "/",
      index: ["index.html"],
      dotfiles: "deny",
      maxAge: isProduction ? "1h" : 0,
    });
    app.setNotFoundHandler((request, reply) => {
      const pathname = request.url.split("?", 1)[0] ?? request.url;
      if (request.method === "GET" && !pathname.startsWith("/api/")) {
        reply.header("Cache-Control", "no-cache");
        return reply.type("text/html; charset=utf-8").sendFile("index.html");
      }
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "接口不存在" } });
    });
  }

  if (options.closeDatabase) {
    app.addHook("onClose", async () => database.close());
  }

  return app;
}
