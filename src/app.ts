import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import bcrypt from "bcryptjs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { NoopCache, type Cache, type FixedWindowResult, type FixedWindowRule } from "./cache/index.js";
import type { Database, Queryable } from "./db/types.js";
import { writeAudit } from "./lib/audit.js";
import { ApiError } from "./lib/errors.js";
import { OrderImportFileError, parseOrderImport, type OrderImportMapping } from "./lib/order-import.js";
import { normalizePhone } from "./lib/phone.js";
import { hashSessionToken, newId, newSessionToken } from "./lib/security.js";
import { rescheduleQueuedDailyDigests } from "./notifications/service.js";
import { SmsProviderError, type SmsProvider } from "./sms/index.js";
import { postFulfillmentJournal, postPaymentJournal, postPaymentReversalJournal } from "./accounting.js";

const roleSchema = z.enum(["owner", "finance", "sales", "viewer"]);
type Role = z.infer<typeof roleSchema>;
const SESSION_COOKIE_NAME = "settlement_session";
const PAYMENT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const FULFILLMENT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MEMBER_INVITATION_TTL_MS = 72 * 60 * 60 * 1000;
const LOGIN_RATE_LIMIT_WINDOW_SECONDS = 60;
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

interface LoginUser extends Record<string, unknown> {
  user_id: string;
  phone: string;
  display_name: string;
  password_hash: string;
  tenant_id: string;
  tenant_name: string;
  tenant_timezone: string;
  role: string;
}

interface AppOptions {
  database: Database;
  cache?: Cache;
  sessionTtlHours?: number;
  closeDatabase?: boolean;
  logger?: boolean;
  isProduction?: boolean;
  bodyLimitBytes?: number;
  loginRateLimitMax?: number;
  loginRateLimitIpMax?: number;
  smsProvider?: SmsProvider;
  smsCodeHmacKey?: string;
  smsLoginTemplateCode?: string;
  smsCodeTtlSeconds?: number;
  smsResendCooldownSeconds?: number;
  smsVerifyMaxAttempts?: number;
  smsSendRateLimitMax?: number;
  smsSendRateLimitIpMax?: number;
  smsSendRateLimitWindowSeconds?: number;
  smsResponseMinMs?: number;
  publicOrigin?: string;
  serveStatic?: boolean;
  staticRoot?: string;
}

function loginRateLimitKey(scope: "ip" | "phone" | "ip-phone", value: string): string {
  const digest = createHash("sha256").update(`login:${scope}\0${value}`).digest("hex");
  return `rate-limit:login:${scope}:${digest}`;
}

function smsRateLimitKey(scope: "ip" | "phone" | "ip-phone", value: string): string {
  const digest = createHash("sha256").update(`sms:${scope}\0${value}`).digest("hex");
  return `rate-limit:sms:${scope}:${digest}`;
}

function smsPhoneKey(phone: string): string {
  return createHash("sha256").update(`sms:phone\0${phone}`).digest("hex");
}

function smsCodeDigest(
  secret: string,
  challengeId: string,
  phone: string,
  tenantId: string | undefined,
  code: string,
): string {
  return createHmac("sha256", secret)
    .update(`${challengeId}\0${phone}\0${tenantId ?? ""}\0${code}`)
    .digest("hex");
}

const phoneSchema = z.string().max(64).transform((value, context) => {
  const normalized = normalizePhone(value);
  if (!normalized) {
    context.addIssue({ code: "custom", message: "手机号格式不正确" });
    return z.NEVER;
  }
  return normalized;
});

const loginSchema = z.object({
  phone: phoneSchema,
  password: z.string().min(6).max(128),
  tenantId: z.uuid().optional(),
}).strict();

const requestSmsCodeSchema = z.object({
  phone: phoneSchema,
  tenantId: z.uuid().optional(),
}).strict();

const smsLoginSchema = z.object({
  phone: phoneSchema,
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{6}$/),
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
}).refine((value) => !value.plannedDeliveryDate || value.plannedDeliveryDate >= value.orderDate, {
  message: "计划交货日期不能早于订货日期",
  path: ["plannedDeliveryDate"],
});

const updateOrderSchema = z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2000),
  partnerId: z.uuid(),
  orderNo: z.string().trim().min(1).max(100),
  direction: z.enum(["receivable", "payable"]),
  orderDate: z.iso.date(),
  plannedDeliveryDate: z.iso.date().nullable().optional(),
  fulfilledAt: z.iso.datetime({ offset: true }).nullable().optional(),
  settlementDays: z.number().int().min(0).max(3650).default(0),
  settlementMonths: z.number().int().min(0).max(120).default(0),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  notes: z.string().trim().max(2000).nullable().optional(),
  items: z.array(itemSchema).min(1).max(500),
}).strict().refine((value) => value.settlementDays === 0 || value.settlementMonths === 0, {
  message: "天数账期与月数账期不能同时设置",
  path: ["settlementMonths"],
}).refine((value) => !value.plannedDeliveryDate || value.plannedDeliveryDate >= value.orderDate, {
  message: "计划交货日期不能早于订货日期",
  path: ["plannedDeliveryDate"],
});

const orderImportMappingSchema = z.object({
  partnerName: z.number().int().positive().optional(),
  orderNo: z.number().int().positive().optional(),
  direction: z.number().int().positive().optional(),
  orderDate: z.number().int().positive().optional(),
  plannedDeliveryDate: z.number().int().positive().optional(),
  settlementMonths: z.number().int().positive().optional(),
  currency: z.number().int().positive().optional(),
  itemDescription: z.number().int().positive().optional(),
  quantity: z.number().int().positive().optional(),
  unitPrice: z.number().int().positive().optional(),
}).strict();

const orderImportFileSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentBase64: z.string().min(1).max(14_000_000),
  mapping: orderImportMappingSchema.optional(),
}).strict();

const commitOrderImportSchema = orderImportFileSchema.extend({
  rowNumbers: z.array(z.number().int().min(2).max(10_001)).min(1).max(1_000).optional(),
}).strict();

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

const createMemberSchema = z.object({
  phone: phoneSchema,
  displayName: z.string().trim().min(1).max(100),
  role: roleSchema,
}).strict();

const acceptMemberInvitationSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: z.string().min(12).max(128),
}).strict();

const updateMemberRoleSchema = z.object({
  role: roleSchema,
}).strict();

const updateMemberStatusSchema = z.object({
  active: z.boolean(),
}).strict();

const notificationSettingsSchema = z.object({
  enabled: z.boolean(),
  sendLocalTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  advanceDays: z.number().int().min(0).max(365),
  overdueDaily: z.boolean(),
  receivableEnabled: z.boolean(),
  payableEnabled: z.boolean(),
  version: z.number().int().nonnegative(),
}).strict();

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

function calculateOrderItems(items: Array<z.infer<typeof itemSchema>>) {
  const calculatedItems = items.map((item) => {
    const lineTotalCents = item.quantity * item.unitPriceCents;
    if (!Number.isSafeInteger(lineTotalCents)) {
      throw new ApiError(400, "AMOUNT_TOO_LARGE", "商品金额超出安全范围");
    }
    return { ...item, lineTotalCents };
  });
  const totalCents = calculatedItems.reduce((sum, item) => sum + item.lineTotalCents, 0);
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
    throw new ApiError(400, "INVALID_TOTAL", "订单总额必须大于 0 且不能超出安全范围");
  }
  return { calculatedItems, totalCents };
}

function decodeOrderImportContent(contentBase64: string): Buffer {
  if (contentBase64.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) {
    throw new ApiError(400, "INVALID_FILE_ENCODING", "导入文件编码无效");
  }
  const buffer = Buffer.from(contentBase64, "base64");
  if (!buffer.length || buffer.toString("base64") !== contentBase64) {
    throw new ApiError(400, "INVALID_FILE_ENCODING", "导入文件编码无效");
  }
  return buffer;
}

async function inspectOrderImport(
  buffer: Buffer,
  fileName: string,
  mapping: OrderImportMapping | undefined,
  existingOrderNumbers: Iterable<string>,
  allowIncompleteMapping = false,
) {
  try {
    return await parseOrderImport(buffer, {
      fileName,
      mapping,
      allowIncompleteMapping,
      existingOrderNumbers,
      limits: { maxRows: 1_000 },
    });
  } catch (error) {
    if (error instanceof OrderImportFileError) {
      throw new ApiError(400, error.code, error.message, error.details);
    }
    throw error;
  }
}

function orderImportRequestHash(
  buffer: Buffer,
  fileName: string,
  mapping: OrderImportMapping | undefined,
  rowNumbers: number[] | undefined,
): string {
  return createHash("sha256").update(JSON.stringify({
    fileName,
    fileHash: createHash("sha256").update(buffer).digest("hex"),
    mapping: mapping ?? {},
    rowNumbers: rowNumbers ? [...rowNumbers].sort((left, right) => left - right) : null,
  })).digest("hex");
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

function maskPhone(phone: string): string {
  if (/^1[3-9]\d{9}$/.test(phone)) return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
  const digits = phone.startsWith("+") ? phone.slice(1) : phone;
  const prefixLength = Math.min(3, Math.max(1, digits.length - 4));
  return `${phone.startsWith("+") ? "+" : ""}${digits.slice(0, prefixLength)}****${digits.slice(-4)}`;
}

function localTime(value: unknown): string {
  return String(value ?? "09:00").slice(0, 5);
}

function mapNotificationSettings(row: Record<string, unknown>) {
  return {
    eligible: true,
    phoneMasked: maskPhone(String(row.phone)),
    phoneVerified: row.phone_verified_at !== null && row.phone_verified_at !== undefined,
    preference: {
      enabled: row.preference_version === null || row.preference_version === undefined ? false : row.enabled === true,
      sendLocalTime: localTime(row.send_local_time),
      advanceDays: Number(row.advance_days ?? 7),
      overdueDaily: row.overdue_daily === null || row.overdue_daily === undefined ? true : row.overdue_daily === true,
      receivableEnabled: row.receivable_enabled === null || row.receivable_enabled === undefined
        ? true
        : row.receivable_enabled === true,
      payableEnabled: row.payable_enabled === null || row.payable_enabled === undefined
        ? true
        : row.payable_enabled === true,
      version: Number(row.preference_version ?? 0),
    },
  };
}

async function getNotificationSettings(database: Queryable, auth: AuthContext) {
  const result = await database.query(
    `SELECT u.phone, u.phone_verified_at, preference.enabled, preference.send_local_time,
            preference.advance_days, preference.overdue_daily, preference.receivable_enabled,
            preference.payable_enabled, preference.version AS preference_version
     FROM memberships membership
     JOIN users u ON u.id = membership.user_id AND u.is_active = true
     LEFT JOIN notification_preferences preference
       ON preference.tenant_id = membership.tenant_id
      AND preference.user_id = membership.user_id
      AND preference.channel = 'sms'
     WHERE membership.tenant_id = $1 AND membership.user_id = $2 AND membership.is_active = true`,
    [auth.tenantId, auth.userId],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(401, "UNAUTHORIZED", "登录已过期，请重新登录");
  return mapNotificationSettings(row);
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

function memberInvitationHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mapMember(row: Record<string, unknown>) {
  const active = row.is_active === true;
  const invitationId = row.invitation_id ? String(row.invitation_id) : null;
  const acceptedAt = iso(row.invitation_accepted_at);
  const revokedAt = iso(row.invitation_revoked_at);
  const expiresAt = iso(row.invitation_expires_at);
  const invitationStatus = !invitationId
    ? null
    : acceptedAt
      ? "accepted"
      : revokedAt
        ? "revoked"
        : expiresAt && new Date(expiresAt).getTime() <= Date.now()
          ? "expired"
          : "pending";
  return {
    id: row.user_id,
    phone: row.phone,
    displayName: row.display_name,
    role: roleSchema.parse(row.role),
    active,
    status: active
      ? "active"
      : invitationStatus === "pending"
        ? "invited"
        : invitationStatus === "expired"
          ? "invitation_expired"
          : "inactive",
    createdAt: iso(row.membership_created_at),
    invitation: invitationId ? {
      status: invitationStatus,
      expiresAt,
      acceptedAt,
      revokedAt,
    } : null,
  };
}

async function listMembers(database: Queryable, tenantId: string) {
  const result = await database.query(
    `SELECT u.id AS user_id, u.phone, u.display_name, m.role, m.is_active,
            m.created_at AS membership_created_at,
            invitation.id AS invitation_id,
            invitation.expires_at AS invitation_expires_at,
            invitation.accepted_at AS invitation_accepted_at,
            invitation.revoked_at AS invitation_revoked_at
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN member_invitations invitation
       ON invitation.tenant_id = m.tenant_id
      AND invitation.user_id = m.user_id
     WHERE m.tenant_id = $1
     ORDER BY m.created_at, u.id`,
    [tenantId],
  );
  return result.rows.map(mapMember);
}

async function getMemberView(database: Queryable, tenantId: string, userId: string) {
  const member = (await listMembers(database, tenantId)).find((item) => item.id === userId);
  if (!member) throw new ApiError(404, "MEMBER_NOT_FOUND", "成员不存在");
  return member;
}

async function lockTenantForMemberMutation(database: Queryable, tenantId: string): Promise<void> {
  const tenant = await database.query("SELECT id FROM tenants WHERE id = $1 FOR UPDATE", [tenantId]);
  if (!tenant.rowCount) throw new ApiError(404, "TENANT_NOT_FOUND", "企业不存在");
}

async function requireAnotherActiveOwner(database: Queryable, tenantId: string): Promise<void> {
  const owners = await database.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM memberships
     WHERE tenant_id = $1 AND role = 'owner' AND is_active = true`,
    [tenantId],
  );
  if (Number(owners.rows[0]?.count) <= 1) {
    throw new ApiError(409, "LAST_OWNER_REQUIRED", "企业必须保留至少一名启用中的负责人");
  }
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
    version: Number(row.version ?? 1),
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
  SELECT o.id, o.version, o.partner_id, p.name AS partner_name, o.order_no, o.direction, o.order_date,
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
    `SELECT o.id, o.version, o.partner_id, p.name AS partner_name, o.order_no, o.direction, o.order_date,
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
            ), '[]'::jsonb) AS payments,
            COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object(
                  'id', correction.id,
                  'reason', correction.reason,
                  'changedFields', correction.changed_fields,
                  'correctedBy', correction.corrected_by,
                  'correctedByName', correcting_user.display_name,
                  'fromVersion', correction.before_snapshot ->> 'version',
                  'toVersion', correction.after_snapshot ->> 'version',
                  'createdAt', correction.created_at
                ) ORDER BY correction.created_at DESC, correction.id DESC
              )
              FROM order_corrections correction
              LEFT JOIN users correcting_user ON correcting_user.id = correction.corrected_by
              WHERE correction.tenant_id = o.tenant_id AND correction.order_id = o.id
            ), '[]'::jsonb) AS corrections
     FROM orders o
     JOIN partners p ON p.tenant_id = o.tenant_id AND p.id = o.partner_id
     WHERE o.tenant_id = $1 AND o.id = $2`,
    [auth.tenantId, orderId],
  );
  const row = orderResult.rows[0];
  if (!row) throw new ApiError(404, "NOT_FOUND", "订单不存在");
  const items = Array.isArray(row.items) ? row.items as Record<string, unknown>[] : [];
  const payments = Array.isArray(row.payments) ? row.payments as Record<string, unknown>[] : [];
  const corrections = Array.isArray(row.corrections) ? row.corrections as Record<string, unknown>[] : [];
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
    corrections: corrections.map((correction) => ({
      id: correction.id,
      reason: correction.reason,
      changedFields: Array.isArray(correction.changedFields) ? correction.changedFields : [],
      correctedBy: correction.correctedBy,
      correctedByName: correction.correctedByName,
      fromVersion: Number(correction.fromVersion),
      toVersion: Number(correction.toVersion),
      createdAt: iso(correction.createdAt),
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

async function getOrderImportBatch(database: Queryable, tenantId: string, batchId: string) {
  const [batchResult, ordersResult] = await Promise.all([
    database.query(
      `SELECT id, file_name, selected_rows, created_by, created_at
       FROM order_import_batches WHERE tenant_id = $1 AND id = $2`,
      [tenantId, batchId],
    ),
    database.query(
      `SELECT id, order_no FROM orders
       WHERE tenant_id = $1 AND import_batch_id = $2
       ORDER BY created_at, id`,
      [tenantId, batchId],
    ),
  ]);
  const batch = batchResult.rows[0];
  if (!batch) throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "导入批次不存在");
  return {
    id: batch.id,
    fileName: batch.file_name,
    selectedRows: Array.isArray(batch.selected_rows) ? batch.selected_rows.map(Number) : [],
    createdBy: batch.created_by,
    createdAt: iso(batch.created_at),
    importedCount: ordersResult.rowCount,
    orders: ordersResult.rows.map((row) => ({ id: row.id, orderNo: row.order_no })),
  };
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
       AND r.due_at <= (((now() AT TIME ZONE $2) + interval '7 days') AT TIME ZONE $2)
       AND (
         r.status = 'open'
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
  const cache = options.cache ?? new NoopCache();
  const sessionTtlHours = options.sessionTtlHours ?? 168;
  const loginRateLimitMax = options.loginRateLimitMax ?? 5;
  const loginRateLimitIpMax = options.loginRateLimitIpMax ?? Math.max(20, loginRateLimitMax * 20);
  const smsProvider = options.smsProvider;
  const smsCodeHmacKey = options.smsCodeHmacKey;
  const smsLoginTemplateCode = options.smsLoginTemplateCode;
  const smsCodeTtlSeconds = options.smsCodeTtlSeconds ?? 300;
  const smsResendCooldownSeconds = options.smsResendCooldownSeconds ?? 60;
  const smsVerifyMaxAttempts = options.smsVerifyMaxAttempts ?? 5;
  const smsSendRateLimitMax = options.smsSendRateLimitMax ?? 5;
  const smsSendRateLimitIpMax = options.smsSendRateLimitIpMax ?? 20;
  const smsSendRateLimitWindowSeconds = options.smsSendRateLimitWindowSeconds ?? 3_600;
  const smsResponseMinMs = options.smsResponseMinMs ?? 250;
  const pendingSmsDispatches = new Set<Promise<void>>();
  if (smsProvider && (!smsCodeHmacKey || smsCodeHmacKey.length < 32 || !smsLoginTemplateCode)) {
    throw new Error("SMS provider requires a login template and an HMAC key of at least 32 characters");
  }

  const dispatchSms = (operation: () => Promise<void>) => {
    let tracked: Promise<void>;
    tracked = Promise.resolve()
      .then(operation)
      .catch((error) => app.log.error({ error }, "SMS background dispatch failed"))
      .finally(() => pendingSmsDispatches.delete(tracked));
    pendingSmsDispatches.add(tracked);
  };

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
    const phone = typeof rawPhone === "string"
      ? (normalizePhone(rawPhone) ?? rawPhone.normalize("NFKC").trim().slice(0, 64))
      : "";
    const rules: FixedWindowRule[] = [{
      key: loginRateLimitKey("ip", request.ip),
      limit: loginRateLimitIpMax,
    }];
    if (phone) {
      rules.push(
        { key: loginRateLimitKey("phone", phone), limit: loginRateLimitMax },
        { key: loginRateLimitKey("ip-phone", `${request.ip}\0${phone}`), limit: loginRateLimitMax },
      );
    }

    let attempt: FixedWindowResult;
    try {
      attempt = await cache.consumeFixedWindow(rules, LOGIN_RATE_LIMIT_WINDOW_SECONDS);
    } catch {
      reply.header("Retry-After", "1");
      throw new ApiError(503, "LOGIN_RATE_LIMIT_UNAVAILABLE", "登录保护服务暂不可用，请稍后再试");
    }
    reply.header("X-RateLimit-Limit", loginRateLimitMax);
    reply.header("X-RateLimit-Remaining", attempt.remaining);
    if (!attempt.allowed) {
      reply.header("Retry-After", Math.max(1, attempt.retryAfterSeconds));
      throw new ApiError(429, "LOGIN_RATE_LIMITED", "登录尝试过于频繁，请稍后再试");
    }
  };

  const issueSession = async (
    reply: FastifyReply,
    resolveUser: (tx: Queryable) => Promise<LoginUser>,
    method: "password" | "sms",
  ) => {
    const token = newSessionToken();
    const sessionId = newId();
    const expiresAt = new Date(Date.now() + sessionTtlHours * 3_600_000);
    const user = await database.transaction(async (tx) => {
      const lockedUser = await resolveUser(tx);
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
        metadata: method === "sms" ? { method } : undefined,
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

  app.post("/api/auth/sms-codes", async (request, reply) => {
    if (!smsProvider || !smsCodeHmacKey || !smsLoginTemplateCode) {
      throw new ApiError(503, "SMS_UNAVAILABLE", "短信登录暂不可用");
    }
    const responseStartedAt = Date.now();
    const input = parse(requestSmsCodeSchema, request.body);
    const phoneKey = smsPhoneKey(input.phone);
    const cooldownKey = `sms:cooldown:login:${phoneKey}`;
    const rateRules: FixedWindowRule[] = [
      { key: smsRateLimitKey("ip", request.ip), limit: smsSendRateLimitIpMax },
      { key: smsRateLimitKey("phone", input.phone), limit: smsSendRateLimitMax },
      { key: smsRateLimitKey("ip-phone", `${request.ip}\0${input.phone}`), limit: smsSendRateLimitMax },
    ];

    let sendLimit: FixedWindowResult;
    let acquiredCooldown = false;
    try {
      sendLimit = await cache.consumeFixedWindow(rateRules, smsSendRateLimitWindowSeconds);
      if (sendLimit.allowed) {
        acquiredCooldown = await cache.setIfAbsent(cooldownKey, "1", smsResendCooldownSeconds);
      }
    } catch {
      reply.header("Retry-After", "1");
      throw new ApiError(503, "SMS_VERIFICATION_UNAVAILABLE", "短信验证服务暂不可用，请稍后再试");
    }
    reply.header("X-RateLimit-Limit", smsSendRateLimitMax);
    reply.header("X-RateLimit-Remaining", sendLimit.remaining);
    if (!sendLimit.allowed) {
      reply.header("Retry-After", Math.max(1, sendLimit.retryAfterSeconds));
      throw new ApiError(429, "SMS_CODE_RATE_LIMITED", "验证码发送过于频繁，请稍后再试");
    }
    if (!acquiredCooldown) {
      reply.header("Retry-After", smsResendCooldownSeconds);
      throw new ApiError(429, "SMS_CODE_RATE_LIMITED", "验证码发送过于频繁，请稍后再试");
    }

    const challengeId = newId();
    const challengeKey = `sms:challenge:login:${challengeId}`;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const digest = smsCodeDigest(smsCodeHmacKey, challengeId, input.phone, input.tenantId, code);
    try {
      await cache.set(challengeKey, digest, smsCodeTtlSeconds);
    } catch {
      await cache.delete(cooldownKey).catch(() => undefined);
      reply.header("Retry-After", "1");
      throw new ApiError(503, "SMS_VERIFICATION_UNAVAILABLE", "短信验证服务暂不可用，请稍后再试");
    }

    const recipient = await database.query<{ id: string }>(
      `SELECT u.id
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.is_active = true
       WHERE u.phone = $1 AND u.is_active = true
         AND ($2::uuid IS NULL OR m.tenant_id = $2::uuid)
       LIMIT 1`,
      [input.phone, input.tenantId ?? null],
    );
    const hasRecipient = Boolean(recipient.rowCount);
    dispatchSms(async () => {
      if (!hasRecipient) {
        await cache.delete(challengeKey).catch(() => undefined);
        return;
      }
      try {
        await smsProvider.sendSms({
          phone: input.phone,
          templateCode: smsLoginTemplateCode,
          params: { code },
          outId: challengeId,
        });
      } catch (error) {
        await cache.delete(challengeKey).catch(() => undefined);
        const providerCode = error instanceof SmsProviderError ? error.providerCode : "UNEXPECTED_ERROR";
        request.log.error({ smsProvider: smsProvider.name, providerCode }, "SMS verification send failed");
      }
    });

    if (smsResponseMinMs > 0) {
      const targetDurationMs = smsResponseMinMs + randomInt(0, 51);
      const remainingMs = targetDurationMs - (Date.now() - responseStartedAt);
      if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs));
    }

    return reply.status(202).send({
      accepted: true,
      challengeId,
      expiresInSeconds: smsCodeTtlSeconds,
      retryAfterSeconds: smsResendCooldownSeconds,
    });
  });

  app.post("/api/auth/login", {
    preHandler: enforceLoginRateLimit,
  }, async (request, reply) => {
    const input = parse(loginSchema, request.body);
    return issueSession(reply, async (tx) => {
      const result = await tx.query<LoginUser>(
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
      return lockedUser;
    }, "password");
  });

  app.post("/api/auth/sms-login", {
    preHandler: enforceLoginRateLimit,
  }, async (request, reply) => {
    if (!smsProvider || !smsCodeHmacKey || !smsLoginTemplateCode) {
      throw new ApiError(503, "SMS_UNAVAILABLE", "短信登录暂不可用");
    }
    const input = parse(smsLoginSchema, request.body);
    const expectedDigest = smsCodeDigest(
      smsCodeHmacKey,
      input.challengeId,
      input.phone,
      input.tenantId,
      input.code,
    );
    let consumed;
    try {
      consumed = await cache.consumeOneTimeValue(
        `sms:challenge:login:${input.challengeId}`,
        expectedDigest,
        smsVerifyMaxAttempts,
      );
    } catch {
      reply.header("Retry-After", "1");
      throw new ApiError(503, "SMS_VERIFICATION_UNAVAILABLE", "短信验证服务暂不可用，请稍后再试");
    }
    if (consumed.status !== "consumed") {
      throw new ApiError(401, "INVALID_SMS_CODE", "验证码错误或已过期");
    }

    return issueSession(reply, async (tx) => {
      const result = await tx.query<LoginUser>(
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
      if (!lockedUser) throw new ApiError(401, "INVALID_SMS_CODE", "验证码错误或已过期");
      await tx.query(
        `UPDATE users SET phone_verified_at = now(), updated_at = now()
         WHERE id = $1`,
        [lockedUser.user_id],
      );
      return lockedUser;
    }, "sms");
  });

  app.post("/api/auth/accept-invitation", async (request, reply) => {
    const input = parse(acceptMemberInvitationSchema, request.body);
    const tokenHash = memberInvitationHash(input.token);
    let acceptedMember: { tenantId: string; userId: string; phone: string; role: Role } | undefined;
    await database.transaction(async (tx) => {
      const reference = await tx.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM member_invitations WHERE token_hash = $1",
        [tokenHash],
      );
      if (!reference.rows[0]) throw new ApiError(400, "INVALID_INVITATION", "邀请无效或已过期");
      await lockTenantForMemberMutation(tx, reference.rows[0].tenant_id);
      const result = await tx.query<{
        invitation_id: string;
        tenant_id: string;
        user_id: string;
        phone: string;
        role: string;
        membership_active: boolean;
        expires_at: Date | string;
        accepted_at: Date | string | null;
        revoked_at: Date | string | null;
      }>(
        `SELECT invitation.id AS invitation_id, invitation.tenant_id, invitation.user_id,
                u.phone, m.role, m.is_active AS membership_active,
                invitation.expires_at, invitation.accepted_at, invitation.revoked_at
         FROM member_invitations invitation
         JOIN memberships m
           ON m.tenant_id = invitation.tenant_id
          AND m.user_id = invitation.user_id
         JOIN users u ON u.id = invitation.user_id
         WHERE invitation.tenant_id = $1 AND invitation.token_hash = $2
         FOR UPDATE OF invitation, m, u`,
        [reference.rows[0].tenant_id, tokenHash],
      );
      const invitation = result.rows[0];
      if (!invitation
          || invitation.accepted_at !== null
          || invitation.revoked_at !== null
          || invitation.membership_active
          || new Date(invitation.expires_at).getTime() <= Date.now()) {
        throw new ApiError(400, "INVALID_INVITATION", "邀请无效或已过期");
      }
      const passwordHash = await bcrypt.hash(input.password, 12);
      await tx.query(
        `UPDATE users SET password_hash = $2, is_active = true, updated_at = now()
         WHERE id = $1`,
        [invitation.user_id, passwordHash],
      );
      await tx.query(
        `UPDATE memberships SET is_active = true
         WHERE tenant_id = $1 AND user_id = $2`,
        [invitation.tenant_id, invitation.user_id],
      );
      await tx.query(
        `UPDATE member_invitations SET accepted_at = now()
         WHERE id = $1 AND accepted_at IS NULL`,
        [invitation.invitation_id],
      );
      const role = roleSchema.parse(invitation.role);
      await writeAudit(tx, {
        tenantId: invitation.tenant_id,
        actorUserId: invitation.user_id,
        action: "member.invitation_accepted",
        entityType: "member",
        entityId: invitation.user_id,
        metadata: { role },
      });
      acceptedMember = {
        tenantId: invitation.tenant_id,
        userId: invitation.user_id,
        phone: invitation.phone,
        role,
      };
    });
    if (!acceptedMember) throw new ApiError(500, "INVITATION_ACCEPTANCE_FAILED", "接受邀请失败");
    return reply.send({ success: true, member: acceptedMember });
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

  app.get("/api/notification-settings/me", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance"]);
    return getNotificationSettings(database, auth);
  });

  app.put("/api/notification-settings/me", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance"]);
    const input = parse(notificationSettingsSchema, request.body);
    const preference = await database.transaction(async (tx) => {
      const memberResult = await tx.query<{
        phone: string;
        phone_verified_at: Date | string | null;
        role: string;
      }>(
        `SELECT u.phone, u.phone_verified_at, membership.role
         FROM memberships membership
         JOIN users u ON u.id = membership.user_id AND u.is_active = true
         WHERE membership.tenant_id = $1 AND membership.user_id = $2 AND membership.is_active = true
         FOR UPDATE OF membership, u`,
        [auth.tenantId, auth.userId],
      );
      const member = memberResult.rows[0];
      if (!member) throw new ApiError(401, "UNAUTHORIZED", "登录已过期，请重新登录");
      if (!["owner", "finance"].includes(roleSchema.parse(member.role))) {
        throw new ApiError(403, "FORBIDDEN", "当前角色没有此操作权限");
      }

      const currentResult = await tx.query<{ version: number; enabled: boolean }>(
        `SELECT version, enabled
         FROM notification_preferences
         WHERE tenant_id = $1 AND user_id = $2 AND channel = 'sms'
         FOR UPDATE`,
        [auth.tenantId, auth.userId],
      );
      const current = currentResult.rows[0];
      const currentVersion = Number(current?.version ?? 0);
      if (currentVersion !== input.version) {
        throw new ApiError(
          409,
          "NOTIFICATION_SETTINGS_VERSION_CONFLICT",
          "提醒设置已在其他页面修改，请刷新后重试",
          { currentVersion },
        );
      }
      if (input.enabled && !member.phone_verified_at) {
        throw new ApiError(409, "PHONE_NOT_VERIFIED", "请先通过短信验证当前手机号");
      }

      if (input.enabled) {
        const destinationHash = createHash("sha256").update(member.phone).digest("hex");
        await tx.query(
          `UPDATE notification_endpoints
           SET disabled_at = now(), updated_at = now()
           WHERE tenant_id = $1 AND user_id = $2 AND channel = 'sms'
             AND destination_hash <> $3 AND disabled_at IS NULL`,
          [auth.tenantId, auth.userId, destinationHash],
        );
        await tx.query(
          `INSERT INTO notification_endpoints (
             id, tenant_id, user_id, channel, destination, destination_hash,
             destination_hint, verified_at, consented_at
           ) VALUES ($1, $2, $3, 'sms', $4, $5, $6, $7, now())
           ON CONFLICT (tenant_id, user_id, channel, destination_hash) DO UPDATE
           SET destination = EXCLUDED.destination,
               destination_hint = EXCLUDED.destination_hint,
               verified_at = EXCLUDED.verified_at,
               consented_at = now(),
               disabled_at = NULL,
               updated_at = now()`,
          [
            newId(),
            auth.tenantId,
            auth.userId,
            member.phone,
            destinationHash,
            maskPhone(member.phone),
            member.phone_verified_at,
          ],
        );
      }

      const nextVersion = currentVersion + 1;
      if (current) {
        const updated = await tx.query(
          `UPDATE notification_preferences
           SET enabled = $4, send_local_time = $5::time, advance_days = $6,
               overdue_daily = $7, receivable_enabled = $8, payable_enabled = $9,
               version = version + 1, updated_at = now()
           WHERE tenant_id = $1 AND user_id = $2 AND channel = 'sms' AND version = $3
           RETURNING version`,
          [
            auth.tenantId,
            auth.userId,
            input.version,
            input.enabled,
            input.sendLocalTime,
            input.advanceDays,
            input.overdueDaily,
            input.receivableEnabled,
            input.payableEnabled,
          ],
        );
        if (!updated.rowCount) {
          throw new ApiError(409, "NOTIFICATION_SETTINGS_VERSION_CONFLICT", "提醒设置已在其他页面修改，请刷新后重试");
        }
      } else {
        const inserted = await tx.query(
          `INSERT INTO notification_preferences (
             tenant_id, user_id, channel, enabled, send_local_time, advance_days,
             overdue_daily, receivable_enabled, payable_enabled, version
           ) VALUES ($1, $2, 'sms', $3, $4::time, $5, $6, $7, $8, 1)
           ON CONFLICT (tenant_id, user_id, channel) DO NOTHING
           RETURNING version`,
          [
            auth.tenantId,
            auth.userId,
            input.enabled,
            input.sendLocalTime,
            input.advanceDays,
            input.overdueDaily,
            input.receivableEnabled,
            input.payableEnabled,
          ],
        );
        if (!inserted.rowCount) {
          throw new ApiError(409, "NOTIFICATION_SETTINGS_VERSION_CONFLICT", "提醒设置已在其他页面修改，请刷新后重试");
        }
      }

      const rescheduledOutboxCount = await rescheduleQueuedDailyDigests(tx, {
        tenantId: auth.tenantId,
        userId: auth.userId,
        sendLocalTime: input.sendLocalTime,
      });

      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "notification.settings_updated",
        entityType: "notification_preference",
        entityId: auth.userId,
        metadata: {
          fromVersion: currentVersion,
          toVersion: nextVersion,
          previousEnabled: current?.enabled ?? false,
          enabled: input.enabled,
          sendLocalTime: input.sendLocalTime,
          advanceDays: input.advanceDays,
          overdueDaily: input.overdueDaily,
          receivableEnabled: input.receivableEnabled,
          payableEnabled: input.payableEnabled,
          rescheduledOutboxCount,
        },
      });
      return getNotificationSettings(tx, auth);
    });
    return preference;
  });

  app.get("/api/members", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner"]);
    return { members: await listMembers(database, auth.tenantId) };
  });

  app.post("/api/members", async (request, reply) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner"]);
    const input = parse(createMemberSchema, request.body);
    const userId = newId();
    const invitationId = newId();
    const invitationToken = randomBytes(32).toString("base64url");
    const invitationTokenHash = memberInvitationHash(invitationToken);
    const placeholderPasswordHash = await bcrypt.hash(randomBytes(32).toString("base64url"), 12);
    const expiresAt = new Date(Date.now() + MEMBER_INVITATION_TTL_MS);
    await database.transaction(async (tx) => {
      await lockTenantForMemberMutation(tx, auth.tenantId);
      const existing = await tx.query("SELECT id FROM users WHERE phone = $1", [input.phone]);
      if (existing.rowCount) {
        throw new ApiError(409, "MEMBER_PHONE_IN_USE", "该手机号已绑定其他账号");
      }
      await tx.query(
        `INSERT INTO users (id, phone, display_name, password_hash)
         VALUES ($1, $2, $3, $4)`,
        [userId, input.phone, input.displayName, placeholderPasswordHash],
      );
      await tx.query(
        `INSERT INTO memberships (tenant_id, user_id, role, is_active)
         VALUES ($1, $2, $3, false)`,
        [auth.tenantId, userId, input.role],
      );
      await tx.query(
        `INSERT INTO member_invitations
           (id, tenant_id, user_id, token_hash, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [invitationId, auth.tenantId, userId, invitationTokenHash, expiresAt.toISOString(), auth.userId],
      );
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "member.invited",
        entityType: "member",
        entityId: userId,
        metadata: { phone: input.phone, displayName: input.displayName, role: input.role, expiresAt: expiresAt.toISOString() },
      });
    });
    return reply.status(201).send({
      member: await getMemberView(database, auth.tenantId, userId),
      invitation: { token: invitationToken, expiresAt: expiresAt.toISOString() },
    });
  });

  app.post("/api/members/:id/reinvite", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner"]);
    const params = parse(z.object({ id: z.uuid() }).strict(), request.params);
    const invitationToken = randomBytes(32).toString("base64url");
    const invitationTokenHash = memberInvitationHash(invitationToken);
    const expiresAt = new Date(Date.now() + MEMBER_INVITATION_TTL_MS);
    await database.transaction(async (tx) => {
      await lockTenantForMemberMutation(tx, auth.tenantId);
      const memberResult = await tx.query<{ is_active: boolean }>(
        `SELECT is_active FROM memberships
         WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
        [auth.tenantId, params.id],
      );
      const member = memberResult.rows[0];
      if (!member) throw new ApiError(404, "MEMBER_NOT_FOUND", "成员不存在");
      const invitationResult = await tx.query<{ id: string; accepted_at: Date | string | null }>(
        `SELECT id, accepted_at FROM member_invitations
         WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
        [auth.tenantId, params.id],
      );
      const invitation = invitationResult.rows[0];
      if (!invitation || invitation.accepted_at !== null || member.is_active) {
        throw new ApiError(409, "MEMBER_ALREADY_ACTIVATED", "已激活成员不需要重新邀请");
      }
      await tx.query(
        `UPDATE member_invitations
         SET token_hash = $3, expires_at = $4, revoked_at = NULL,
             created_by = $5, created_at = now()
         WHERE tenant_id = $1 AND user_id = $2`,
        [auth.tenantId, params.id, invitationTokenHash, expiresAt.toISOString(), auth.userId],
      );
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "member.reinvited",
        entityType: "member",
        entityId: params.id,
        metadata: { expiresAt: expiresAt.toISOString() },
      });
    });
    return {
      member: await getMemberView(database, auth.tenantId, params.id),
      invitation: { token: invitationToken, expiresAt: expiresAt.toISOString() },
    };
  });

  app.patch("/api/members/:id/role", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner"]);
    const params = parse(z.object({ id: z.uuid() }).strict(), request.params);
    const input = parse(updateMemberRoleSchema, request.body);
    let changed = false;
    await database.transaction(async (tx) => {
      await lockTenantForMemberMutation(tx, auth.tenantId);
      const result = await tx.query<{ role: string; is_active: boolean }>(
        `SELECT role, is_active FROM memberships
         WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
        [auth.tenantId, params.id],
      );
      const member = result.rows[0];
      if (!member) throw new ApiError(404, "MEMBER_NOT_FOUND", "成员不存在");
      const previousRole = roleSchema.parse(member.role);
      if (previousRole === input.role) return;
      if (previousRole === "owner" && member.is_active && input.role !== "owner") {
        await requireAnotherActiveOwner(tx, auth.tenantId);
      }
      await tx.query(
        `UPDATE memberships SET role = $3
         WHERE tenant_id = $1 AND user_id = $2`,
        [auth.tenantId, params.id, input.role],
      );
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "member.role_changed",
        entityType: "member",
        entityId: params.id,
        metadata: { previousRole, role: input.role },
      });
      changed = true;
    });
    return {
      member: await getMemberView(database, auth.tenantId, params.id),
      idempotentReplay: !changed,
    };
  });

  app.patch("/api/members/:id/status", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner"]);
    const params = parse(z.object({ id: z.uuid() }).strict(), request.params);
    const input = parse(updateMemberStatusSchema, request.body);
    let changed = false;
    let revokedSessions = 0;
    await database.transaction(async (tx) => {
      await lockTenantForMemberMutation(tx, auth.tenantId);
      const result = await tx.query<{
        role: string;
        is_active: boolean;
        invitation_id: string | null;
        invitation_accepted_at: Date | string | null;
        invitation_revoked_at: Date | string | null;
      }>(
        `SELECT m.role, m.is_active, invitation.id AS invitation_id,
                invitation.accepted_at AS invitation_accepted_at,
                invitation.revoked_at AS invitation_revoked_at
         FROM memberships m
         LEFT JOIN member_invitations invitation
           ON invitation.tenant_id = m.tenant_id
          AND invitation.user_id = m.user_id
         WHERE m.tenant_id = $1 AND m.user_id = $2
         FOR UPDATE OF m`,
        [auth.tenantId, params.id],
      );
      const member = result.rows[0];
      if (!member) throw new ApiError(404, "MEMBER_NOT_FOUND", "成员不存在");
      if (!input.active
          && !member.is_active
          && member.invitation_id
          && member.invitation_accepted_at === null
          && member.invitation_revoked_at === null) {
        await tx.query(
          `UPDATE member_invitations SET revoked_at = now()
           WHERE tenant_id = $1 AND user_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
          [auth.tenantId, params.id],
        );
        await writeAudit(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: "member.invitation_revoked",
          entityType: "member",
          entityId: params.id,
        });
        changed = true;
        return;
      }
      if (member.is_active === input.active) return;
      if (input.active && member.invitation_id && member.invitation_accepted_at === null) {
        throw new ApiError(409, "MEMBER_INVITATION_PENDING", "成员接受邀请后才能启用");
      }
      const role = roleSchema.parse(member.role);
      if (!input.active && role === "owner") {
        await requireAnotherActiveOwner(tx, auth.tenantId);
      }
      await tx.query(
        `UPDATE memberships SET is_active = $3
         WHERE tenant_id = $1 AND user_id = $2`,
        [auth.tenantId, params.id, input.active],
      );
      if (!input.active) {
        const revoked = await tx.query(
          `UPDATE sessions SET revoked_at = now()
           WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL
           RETURNING id`,
          [auth.tenantId, params.id],
        );
        revokedSessions = revoked.rowCount;
      }
      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: input.active ? "member.reactivated" : "member.deactivated",
        entityType: "member",
        entityId: params.id,
        metadata: input.active ? {} : { revokedSessions },
      });
      changed = true;
    });
    return {
      member: await getMemberView(database, auth.tenantId, params.id),
      revokedSessions,
      idempotentReplay: !changed,
    };
  });

  app.get("/api/bootstrap", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    const [ordersResult, partners, reminders, recentPaymentsResult] = await Promise.all([
      database.query(
        `${orderSelect}
         WHERE o.tenant_id = $1
         GROUP BY o.id, p.name
         ORDER BY o.created_at DESC, o.id`,
        [auth.tenantId],
      ),
      listPartners(database, auth.tenantId),
      listReminders(database, auth),
      database.query(
        `SELECT pay.id, pay.order_id, pay.amount_cents::text, pay.method, pay.paid_at,
                o.order_no, o.direction, o.currency, p.name AS partner_name,
                reversal.reversed_at
         FROM payments pay
         JOIN orders o
           ON o.tenant_id = pay.tenant_id
          AND o.id = pay.order_id
         JOIN partners p
           ON p.tenant_id = o.tenant_id
          AND p.id = o.partner_id
         LEFT JOIN payment_reversals reversal
           ON reversal.tenant_id = pay.tenant_id
          AND reversal.payment_id = pay.id
          AND reversal.order_id = pay.order_id
         WHERE pay.tenant_id = $1
         ORDER BY pay.paid_at DESC, pay.created_at DESC, pay.id DESC
         LIMIT 6`,
        [auth.tenantId],
      ),
    ]);
    return {
      user: { id: auth.userId, phone: auth.phone, displayName: auth.displayName },
      tenant: { id: auth.tenantId, name: auth.tenantName, timezone: auth.tenantTimezone },
      role: auth.role,
      orders: ordersResult.rows.map(mapOrder),
      partners,
      reminders,
      recentPayments: recentPaymentsResult.rows.map((row) => ({
        id: row.id,
        orderId: row.order_id,
        orderNo: row.order_no,
        partnerName: row.partner_name,
        direction: row.direction,
        currency: row.currency,
        amountCents: money(row.amount_cents),
        method: row.method,
        paidAt: iso(row.paid_at),
        reversedAt: iso(row.reversed_at),
      })),
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

  app.post("/api/order-imports/preview", { bodyLimit: 14_500_000 }, async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance", "sales"]);
    const input = parse(orderImportFileSchema, request.body);
    const buffer = decodeOrderImportContent(input.contentBase64);
    const existingResult = await database.query<{ order_no: string }>(
      "SELECT order_no FROM orders WHERE tenant_id = $1",
      [auth.tenantId],
    );
    const preview = await inspectOrderImport(
      buffer,
      input.fileName,
      input.mapping,
      existingResult.rows.map((row) => row.order_no),
      input.mapping === undefined,
    );
    return { preview };
  });

  app.post("/api/order-imports/commit", { bodyLimit: 14_500_000 }, async (request, reply) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance", "sales"]);
    const input = parse(commitOrderImportSchema, request.body);
    const idempotencyKey = requestIdempotencyKey(request);
    const buffer = decodeOrderImportContent(input.contentBase64);
    const requestHash = orderImportRequestHash(buffer, input.fileName, input.mapping, input.rowNumbers);
    if (input.rowNumbers && new Set(input.rowNumbers).size !== input.rowNumbers.length) {
      throw new ApiError(400, "DUPLICATE_ROW_SELECTION", "导入行号不能重复");
    }

    const existingBatch = await database.query<{ id: string; request_hash: string }>(
      `SELECT id, request_hash FROM order_import_batches
       WHERE tenant_id = $1 AND idempotency_key = $2`,
      [auth.tenantId, idempotencyKey],
    );
    if (existingBatch.rows[0]) {
      if (existingBatch.rows[0].request_hash !== requestHash) {
        throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "同一 Idempotency-Key 不能用于不同导入内容");
      }
      return reply.send({
        batch: await getOrderImportBatch(database, auth.tenantId, existingBatch.rows[0].id),
        idempotentReplay: true,
      });
    }

    const existingOrders = await database.query<{ order_no: string }>(
      "SELECT order_no FROM orders WHERE tenant_id = $1",
      [auth.tenantId],
    );
    const preview = await inspectOrderImport(
      buffer,
      input.fileName,
      input.mapping,
      existingOrders.rows.map((row) => row.order_no),
    );
    const requestedRows = input.rowNumbers ? new Set(input.rowNumbers) : null;
    if (requestedRows) {
      const availableRows = new Set(preview.rows.map((row) => row.rowNumber));
      const missingRows = [...requestedRows].filter((rowNumber) => !availableRows.has(rowNumber));
      if (missingRows.length) {
        throw new ApiError(400, "IMPORT_ROWS_NOT_FOUND", "选择的导入行不存在", { rowNumbers: missingRows });
      }
    }
    const selectedRows = preview.rows.filter((row) => requestedRows ? requestedRows.has(row.rowNumber) : row.valid);
    const invalidSelectedRows = selectedRows.filter((row) => !row.valid);
    if (invalidSelectedRows.length) {
      throw new ApiError(400, "INVALID_IMPORT_ROWS", "选中的行仍有校验错误", {
        rows: invalidSelectedRows.map((row) => ({ rowNumber: row.rowNumber, errors: row.errors })),
      });
    }
    if (!selectedRows.length) throw new ApiError(400, "NO_VALID_IMPORT_ROWS", "没有可以导入的有效行");

    const partnerKinds = new Map<string, "customer" | "supplier" | "both">();
    for (const row of selectedRows) {
      const name = row.values.partnerName;
      const direction = row.values.direction;
      if (!name || !direction) throw new ApiError(500, "INVALID_IMPORT_STATE", "已校验导入行缺少关键字段");
      const requiredKind = direction === "receivable" ? "customer" : "supplier";
      const currentKind = partnerKinds.get(name);
      partnerKinds.set(name, !currentKind || currentKind === requiredKind ? requiredKind : "both");
    }

    let batchId = "";
    let replayed = false;
    await database.transaction(async (tx) => {
      await tx.query("SELECT id FROM tenants WHERE id = $1 FOR UPDATE", [auth.tenantId]);
      const concurrentBatch = await tx.query<{ id: string; request_hash: string }>(
        `SELECT id, request_hash FROM order_import_batches
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [auth.tenantId, idempotencyKey],
      );
      if (concurrentBatch.rows[0]) {
        if (concurrentBatch.rows[0].request_hash !== requestHash) {
          throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "同一 Idempotency-Key 不能用于不同导入内容");
        }
        batchId = concurrentBatch.rows[0].id;
        replayed = true;
        return;
      }

      const orderNumbers = selectedRows.map((row) => row.values.orderNo as string);
      const duplicateOrders = await tx.query<{ order_no: string }>(
        "SELECT order_no FROM orders WHERE tenant_id = $1 AND order_no = ANY($2::text[])",
        [auth.tenantId, orderNumbers],
      );
      if (duplicateOrders.rowCount) {
        throw new ApiError(409, "IMPORT_ORDER_ALREADY_EXISTS", "部分订单号已存在，请重新预览", {
          orderNumbers: duplicateOrders.rows.map((row) => row.order_no),
        });
      }

      batchId = newId();
      const selectedRowNumbers = selectedRows.map((row) => row.rowNumber);
      await tx.query(
        `INSERT INTO order_import_batches
           (id, tenant_id, file_name, idempotency_key, request_hash, selected_rows, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [batchId, auth.tenantId, input.fileName, idempotencyKey, requestHash, selectedRowNumbers, auth.userId],
      );

      const partnerNames = [...partnerKinds.keys()];
      const existingPartners = await tx.query<{ id: string; name: string; kind: "customer" | "supplier" | "both" }>(
        "SELECT id, name, kind FROM partners WHERE tenant_id = $1 AND name = ANY($2::text[])",
        [auth.tenantId, partnerNames],
      );
      const partnersByName = new Map(existingPartners.rows.map((partner) => [partner.name, partner]));
      for (const [name, requiredKind] of partnerKinds) {
        const existing = partnersByName.get(name);
        if (!existing) {
          const partnerId = newId();
          await tx.query(
            `INSERT INTO partners (id, tenant_id, name, kind)
             VALUES ($1, $2, $3, $4)`,
            [partnerId, auth.tenantId, name, requiredKind],
          );
          partnersByName.set(name, { id: partnerId, name, kind: requiredKind });
          await writeAudit(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: "partner.created",
            entityType: "partner",
            entityId: partnerId,
            metadata: { name, kind: requiredKind, importBatchId: batchId },
          });
        } else if (existing.kind !== "both" && existing.kind !== requiredKind) {
          await tx.query(
            `UPDATE partners SET kind = 'both', version = version + 1, updated_at = now()
             WHERE tenant_id = $1 AND id = $2`,
            [auth.tenantId, existing.id],
          );
          existing.kind = "both";
          await writeAudit(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: "partner.updated",
            entityType: "partner",
            entityId: existing.id,
            metadata: { changes: { kind: "both" }, importBatchId: batchId },
          });
        }
      }

      for (const row of selectedRows) {
        const values = row.values;
        const partner = values.partnerName ? partnersByName.get(values.partnerName) : undefined;
        if (!partner || !values.orderNo || !values.direction || !values.orderDate
            || !values.itemDescription || values.quantity === null
            || values.unitPriceCents === null || values.lineTotalCents === null) {
          throw new ApiError(500, "INVALID_IMPORT_STATE", "已校验导入行缺少关键字段");
        }
        const orderId = newId();
        await tx.query(
          `INSERT INTO orders (
             id, tenant_id, partner_id, order_no, direction, order_date, planned_delivery_date,
             fulfillment_status, settlement_days, settlement_months, currency, total_cents,
             notes, created_by, import_batch_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'planned', 0, $8, $9, $10, $11, $12, $13)`,
          [
            orderId, auth.tenantId, partner.id, values.orderNo, values.direction, values.orderDate,
            values.plannedDeliveryDate, values.settlementMonths, values.currency, values.lineTotalCents,
            `由 ${input.fileName} 第 ${row.rowNumber} 行导入`, auth.userId, batchId,
          ],
        );
        await tx.query(
          `INSERT INTO order_items
             (id, tenant_id, order_id, description, quantity, unit_price_cents, line_total_cents)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            newId(), auth.tenantId, orderId, values.itemDescription, values.quantity,
            values.unitPriceCents, values.lineTotalCents,
          ],
        );
        await writeAudit(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: "order.imported",
          entityType: "order",
          entityId: orderId,
          metadata: { importBatchId: batchId, sourceRow: row.rowNumber, orderNo: values.orderNo },
        });
      }

      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "import.completed",
        entityType: "order_import",
        entityId: batchId,
        metadata: {
          fileName: input.fileName,
          importedCount: selectedRows.length,
          skippedInvalidCount: preview.invalidRowCount,
        },
      });
    });

    return reply.status(replayed ? 200 : 201).send({
      batch: await getOrderImportBatch(database, auth.tenantId, batchId),
      idempotentReplay: replayed,
      skippedInvalidCount: preview.invalidRowCount,
    });
  });

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
    const { calculatedItems, totalCents } = calculateOrderItems(input.items);
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

  app.patch("/api/orders/:id", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance", "sales"]);
    const params = parse(z.object({ id: z.uuid() }).strict(), request.params);
    const input = parse(updateOrderSchema, request.body);
    const { calculatedItems, totalCents } = calculateOrderItems(input.items);
    let changed = false;

    await database.transaction(async (tx) => {
      const currentResult = await tx.query<{
        version: number;
        partner_id: string;
        order_no: string;
        direction: "receivable" | "payable";
        order_date: string;
        planned_delivery_date: string | null;
        fulfillment_status: "planned" | "fulfilled" | "cancelled";
        fulfilled_at: Date | string | null;
        settlement_days: number;
        settlement_months: number;
        due_at: Date | string | null;
        currency: string;
        total_cents: string;
        notes: string | null;
        paid_cents: string;
        has_payment_history: boolean;
        items: unknown;
      }>(
        `SELECT o.version, o.partner_id, o.order_no, o.direction, o.order_date::text,
                o.planned_delivery_date::text, o.fulfillment_status, o.fulfilled_at,
                o.settlement_days, o.settlement_months, o.due_at, o.currency,
                o.total_cents::text, o.notes,
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
                EXISTS(
                  SELECT 1 FROM payments pay
                  WHERE pay.tenant_id = o.tenant_id AND pay.order_id = o.id
                ) AS has_payment_history,
                COALESCE((
                  SELECT jsonb_agg(
                    jsonb_build_object(
                      'description', item.description,
                      'quantity', item.quantity,
                      'unitPriceCents', item.unit_price_cents::text,
                      'lineTotalCents', item.line_total_cents::text
                    ) ORDER BY item.created_at, item.id
                  )
                  FROM order_items item
                  WHERE item.tenant_id = o.tenant_id AND item.order_id = o.id
                ), '[]'::jsonb) AS items
         FROM orders o
         WHERE o.tenant_id = $1 AND o.id = $2
         FOR UPDATE`,
        [auth.tenantId, params.id],
      );
      const current = currentResult.rows[0];
      if (!current) throw new ApiError(404, "NOT_FOUND", "订单不存在");
      if (current.fulfillment_status === "cancelled") {
        throw new ApiError(409, "ORDER_CANCELLED", "已取消订单不能更正");
      }
      if (current.fulfillment_status === "fulfilled" && auth.role === "sales") {
        throw new ApiError(403, "FULFILLED_ORDER_CORRECTION_FORBIDDEN", "已交货订单只能由负责人或财务更正");
      }
      if (Number(current.version) !== input.version) {
        throw new ApiError(409, "ORDER_VERSION_CONFLICT", "订单已被其他人修改，请刷新后重试", {
          currentVersion: Number(current.version),
        });
      }

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

      if (input.orderNo !== current.order_no) {
        const duplicate = await tx.query(
          "SELECT id FROM orders WHERE tenant_id = $1 AND order_no = $2 AND id <> $3",
          [auth.tenantId, input.orderNo, params.id],
        );
        if (duplicate.rowCount) throw new ApiError(409, "DUPLICATE_ORDER_NO", "订单号已存在");
      }

      if (current.has_payment_history
          && (input.currency !== current.currency
            || input.direction !== current.direction
            || input.partnerId !== current.partner_id)) {
        throw new ApiError(
          409,
          "SETTLED_IDENTITY_LOCKED",
          "已有收付款历史，不能修改往来单位、收付方向或币种",
        );
      }
      const paidCents = money(current.paid_cents);
      if (totalCents < paidCents) {
        throw new ApiError(409, "TOTAL_BELOW_PAID", "更正后的订单金额不能低于已结金额");
      }

      let fulfilledAt = iso(current.fulfilled_at);
      let dueAt = iso(current.due_at);
      if (current.fulfillment_status === "planned") {
        if (input.fulfilledAt) {
          throw new ApiError(400, "PLANNED_ORDER_HAS_FULFILLMENT", "待交货订单不能填写实际交货时间");
        }
        fulfilledAt = null;
        dueAt = null;
      } else {
        fulfilledAt = input.fulfilledAt ?? fulfilledAt;
        if (!fulfilledAt) throw new ApiError(500, "MISSING_FULFILLMENT_TIME", "已交货订单缺少实际交货时间");
        const fulfilledDate = new Date(fulfilledAt);
        if (fulfilledDate.getTime() > Date.now() + FULFILLMENT_CLOCK_SKEW_MS) {
          throw new ApiError(400, "FULFILLMENT_IN_FUTURE", "实际交货时间不能晚于当前时间 5 分钟以上");
        }
        const dueResult = await tx.query<{ due_at: Date | string; before_order_date: boolean }>(
          `SELECT ((($1::timestamptz AT TIME ZONE $2)
                    + make_interval(months => $3, days => $4))
                   AT TIME ZONE $2) AS due_at,
                  (($1::timestamptz AT TIME ZONE $2)::date < $5::date) AS before_order_date`,
          [fulfilledDate.toISOString(), auth.tenantTimezone, input.settlementMonths, input.settlementDays, input.orderDate],
        );
        if (dueResult.rows[0]?.before_order_date) {
          throw new ApiError(400, "FULFILLMENT_BEFORE_ORDER_DATE", "实际交货日期不能早于订货日期");
        }
        const calculatedDueAt = new Date(String(dueResult.rows[0]?.due_at));
        if (Number.isNaN(calculatedDueAt.getTime())) {
          throw new ApiError(500, "DUE_DATE_CALCULATION_FAILED", "账期计算失败");
        }
        fulfilledAt = fulfilledDate.toISOString();
        dueAt = calculatedDueAt.toISOString();
      }

      const currentItems = Array.isArray(current.items)
        ? (current.items as Record<string, unknown>[]).map((item) => ({
          description: String(item.description),
          quantity: Number(item.quantity),
          unitPriceCents: money(item.unitPriceCents),
          lineTotalCents: money(item.lineTotalCents),
        }))
        : [];
      const beforeSnapshot = {
        version: Number(current.version),
        partnerId: current.partner_id,
        orderNo: current.order_no,
        direction: current.direction,
        orderDate: dateOnly(current.order_date),
        plannedDeliveryDate: dateOnly(current.planned_delivery_date),
        fulfillmentStatus: current.fulfillment_status,
        fulfilledAt: iso(current.fulfilled_at),
        settlementDays: Number(current.settlement_days),
        settlementMonths: Number(current.settlement_months),
        dueAt: iso(current.due_at),
        currency: current.currency,
        totalCents: money(current.total_cents),
        notes: current.notes,
        items: currentItems,
      };
      const afterSnapshot = {
        version: input.version + 1,
        partnerId: input.partnerId,
        orderNo: input.orderNo,
        direction: input.direction,
        orderDate: input.orderDate,
        plannedDeliveryDate: input.plannedDeliveryDate ?? null,
        fulfillmentStatus: current.fulfillment_status,
        fulfilledAt,
        settlementDays: input.settlementDays,
        settlementMonths: input.settlementMonths,
        dueAt,
        currency: input.currency,
        totalCents,
        notes: input.notes ?? null,
        items: calculatedItems,
      };
      const changedFields = [
        "partnerId", "orderNo", "direction", "orderDate", "plannedDeliveryDate",
        "fulfilledAt", "settlementDays", "settlementMonths", "dueAt", "currency",
        "totalCents", "notes", "items",
      ].filter((field) => JSON.stringify(beforeSnapshot[field as keyof typeof beforeSnapshot])
        !== JSON.stringify(afterSnapshot[field as keyof typeof afterSnapshot]));
      if (!changedFields.length) return;

      const updated = await tx.query(
        `UPDATE orders
         SET partner_id = $3, order_no = $4, direction = $5, order_date = $6,
             planned_delivery_date = $7, fulfilled_at = $8, settlement_days = $9,
             settlement_months = $10, due_at = $11, currency = $12, total_cents = $13,
             notes = $14, version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND version = $15
         RETURNING id`,
        [
          auth.tenantId, params.id, input.partnerId, input.orderNo, input.direction,
          input.orderDate, input.plannedDeliveryDate ?? null, fulfilledAt, input.settlementDays,
          input.settlementMonths, dueAt, input.currency, totalCents, input.notes ?? null, input.version,
        ],
      );
      if (!updated.rowCount) {
        throw new ApiError(409, "ORDER_VERSION_CONFLICT", "订单已被其他人修改，请刷新后重试");
      }
      if (changedFields.includes("items")) {
        await tx.query("DELETE FROM order_items WHERE tenant_id = $1 AND order_id = $2", [auth.tenantId, params.id]);
        for (const item of calculatedItems) {
          await tx.query(
            `INSERT INTO order_items
               (id, tenant_id, order_id, description, quantity, unit_price_cents, line_total_cents)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [newId(), auth.tenantId, params.id, item.description, item.quantity, item.unitPriceCents, item.lineTotalCents],
          );
        }
      }

      const correctionId = newId();
      await tx.query(
        `INSERT INTO order_corrections
           (id, tenant_id, order_id, reason, changed_fields, before_snapshot, after_snapshot, corrected_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
        [
          correctionId, auth.tenantId, params.id, input.reason, changedFields,
          JSON.stringify(beforeSnapshot), JSON.stringify(afterSnapshot), auth.userId,
        ],
      );

      if (current.fulfillment_status === "fulfilled" && dueAt) {
        const activeReminders = await tx.query<{ id: string }>(
          `SELECT id FROM reminders
           WHERE tenant_id = $1 AND order_id = $2 AND status IN ('open', 'acked', 'snoozed')
           FOR UPDATE`,
          [auth.tenantId, params.id],
        );
        if (totalCents === paidCents) {
          await tx.query(
            `UPDATE reminders
             SET status = 'closed', closed_at = now(), version = version + 1, updated_at = now()
             WHERE tenant_id = $1 AND order_id = $2 AND status IN ('open', 'acked', 'snoozed')`,
            [auth.tenantId, params.id],
          );
          for (const reminder of activeReminders.rows) {
            await writeAudit(tx, {
              tenantId: auth.tenantId,
              actorUserId: auth.userId,
              action: "reminder.closed",
              entityType: "reminder",
              entityId: reminder.id,
              metadata: { orderId: params.id, correctionId },
            });
          }
        } else if (activeReminders.rowCount) {
          if (changedFields.includes("dueAt")) {
            await tx.query(
              `UPDATE reminders
               SET due_at = $3, status = 'open', snoozed_until = NULL,
                   acknowledged_at = NULL, version = version + 1, updated_at = now()
               WHERE tenant_id = $1 AND order_id = $2 AND status IN ('open', 'acked', 'snoozed')`,
              [auth.tenantId, params.id, dueAt],
            );
          } else {
            await tx.query(
              `UPDATE reminders SET version = version + 1, updated_at = now()
               WHERE tenant_id = $1 AND order_id = $2 AND status IN ('open', 'acked', 'snoozed')`,
              [auth.tenantId, params.id],
            );
          }
        } else {
          const reminderId = newId();
          await tx.query(
            `INSERT INTO reminders (id, tenant_id, order_id, due_at, status)
             VALUES ($1, $2, $3, $4, 'open')`,
            [reminderId, auth.tenantId, params.id, dueAt],
          );
          await writeAudit(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: "reminder.created",
            entityType: "reminder",
            entityId: reminderId,
            metadata: { orderId: params.id, correctionId, dueAt },
          });
        }
      }

      await writeAudit(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: "order.corrected",
        entityType: "order",
        entityId: params.id,
        metadata: {
          correctionId,
          reason: input.reason,
          changedFields,
          fromVersion: input.version,
          toVersion: input.version + 1,
        },
      });
      changed = true;
    });

    return {
      order: await getOrder(database, auth, params.id),
      idempotentReplay: !changed,
    };
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
         SET fulfillment_status = 'cancelled', version = version + 1, updated_at = now()
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
      const result = await tx.query<{ fulfillment_status: string; order_date: string; settlement_days: number; settlement_months: number; direction: "receivable" | "payable"; total_cents: string }>(
        `SELECT fulfillment_status, order_date::text, settlement_days, settlement_months, direction, total_cents::text FROM orders
         WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [auth.tenantId, params.id],
      );
      const order = result.rows[0];
      if (!order) throw new ApiError(404, "NOT_FOUND", "订单不存在");
      if (order.fulfillment_status === "cancelled") throw new ApiError(409, "ORDER_CANCELLED", "已取消订单不能确认交货");
      if (order.fulfillment_status === "fulfilled") return;
      const fulfilledAt = input.fulfilledAt ? new Date(input.fulfilledAt) : new Date();
      if (fulfilledAt.getTime() > Date.now() + FULFILLMENT_CLOCK_SKEW_MS) {
        throw new ApiError(400, "FULFILLMENT_IN_FUTURE", "实际交货时间不能晚于当前时间 5 分钟以上");
      }
      const dueResult = await tx.query<{ due_at: Date | string; before_order_date: boolean }>(
        `SELECT ((($1::timestamptz AT TIME ZONE $2)
                  + make_interval(months => $3, days => $4))
                 AT TIME ZONE $2) AS due_at,
                (($1::timestamptz AT TIME ZONE $2)::date < $5::date) AS before_order_date`,
        [fulfilledAt.toISOString(), auth.tenantTimezone, Number(order.settlement_months), Number(order.settlement_days), order.order_date],
      );
      if (dueResult.rows[0]?.before_order_date) {
        throw new ApiError(400, "FULFILLMENT_BEFORE_ORDER_DATE", "实际交货日期不能早于订货日期");
      }
      const dueAt = new Date(String(dueResult.rows[0]?.due_at));
      if (Number.isNaN(dueAt.getTime())) throw new ApiError(500, "DUE_DATE_CALCULATION_FAILED", "账期计算失败");
      await tx.query(
        `UPDATE orders SET fulfillment_status = 'fulfilled', fulfilled_at = $3, due_at = $4,
             version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [auth.tenantId, params.id, fulfilledAt.toISOString(), dueAt.toISOString()],
      );
      await postFulfillmentJournal(tx, {
        tenantId: auth.tenantId,
        orderId: params.id,
        direction: order.direction,
        amountCents: money(order.total_cents),
        postedAt: fulfilledAt.toISOString(),
        createdBy: auth.userId,
      });
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
      const orderResult = await tx.query<{ fulfillment_status: string; fulfilled_at: Date | string; total_cents: string; direction: "receivable" | "payable" }>(
        `SELECT fulfillment_status, fulfilled_at, total_cents::text, direction FROM orders
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
      await postPaymentJournal(tx, {
        tenantId: auth.tenantId,
        paymentId,
        orderId: params.id,
        direction: order.direction,
        amountCents: input.amountCents,
        postedAt: paidAt.toISOString(),
        createdBy: auth.userId,
      });
      const remainingCents = outstandingCents - input.amountCents;
      if (remainingCents === 0) {
        const closedReminders = await tx.query<{ id: string }>(
          `UPDATE reminders
           SET status = 'closed', closed_at = now(), version = version + 1, updated_at = now()
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
        direction: "receivable" | "payable";
      }>(
        `SELECT fulfillment_status, total_cents::text, due_at, direction
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

      await postPaymentReversalJournal(tx, {
        tenantId: auth.tenantId,
        reversalId,
        paymentId: params.id,
        direction: order.direction,
        amountCents: money(payment.amount_cents),
        postedAt: new Date(String(inserted.rows[0]?.reversed_at ?? new Date().toISOString())).toISOString(),
        createdBy: auth.userId,
      });

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
             version = version + 1, updated_at = now()
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
        `UPDATE reminders
         SET status = 'snoozed', snoozed_until = $3, version = version + 1, updated_at = now()
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

  app.get("/api/accounting/accounts", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance", "viewer"]);
    const result = await database.query(
      `SELECT id, code, name, category, is_system, created_at
       FROM accounting_accounts WHERE tenant_id = $1 ORDER BY code`,
      [auth.tenantId],
    );
    return { accounts: result.rows.map((row) => ({
      id: row.id, code: row.code, name: row.name, category: row.category,
      system: row.is_system === true, createdAt: iso(row.created_at),
    })) };
  });

  app.get("/api/accounting/journals", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance", "viewer"]);
    const query = parse(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), request.query);
    const result = await database.query(
      `SELECT j.id, j.entry_no, j.source_type, j.source_id, j.description,
              j.entry_date, j.created_at, p.period_start::text,
              COALESCE(jsonb_agg(jsonb_build_object(
                'accountCode', a.code, 'accountName', a.name, 'lineNo', line.line_no,
                'description', line.description, 'debitCents', line.debit_cents::text, 'creditCents', line.credit_cents::text
              ) ORDER BY line.line_no) FILTER (WHERE line.id IS NOT NULL), '[]'::jsonb) AS lines
       FROM journal_entries j
       JOIN accounting_periods p ON p.tenant_id = j.tenant_id AND p.id = j.period_id
       LEFT JOIN journal_lines line ON line.tenant_id = j.tenant_id AND line.journal_entry_id = j.id
       LEFT JOIN accounting_accounts a ON a.tenant_id = line.tenant_id AND a.id = line.account_id
       WHERE j.tenant_id = $1 AND ($2::text IS NULL OR to_char(p.period_start, 'YYYY-MM') = $2)
       GROUP BY j.id, p.period_start ORDER BY j.entry_date DESC, j.id DESC LIMIT $3`,
      [auth.tenantId, query.period ?? null, query.limit],
    );
    return { journals: result.rows.map((row) => ({
      id: row.id, voucherNo: String(row.entry_no), sourceType: row.source_type,
      sourceId: row.source_id, description: row.description, postedAt: iso(row.entry_date),
      period: dateOnly(row.period_start)?.slice(0, 7), lines: row.lines,
    })) };
  });

  app.get("/api/accounting/ledger", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance", "viewer"]);
    const query = parse(z.object({
      accountCode: z.string().trim().max(32).optional(),
      period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(500),
    }), request.query);
    const result = await database.query(
      `SELECT e.id, e.entry_no, e.entry_date::text, e.source_type, e.source_id,
              e.description AS entry_description, line.line_no, line.description,
              account.code AS account_code, account.name AS account_name,
              line.debit_cents::text, line.credit_cents::text, line.currency,
              partner.name AS partner_name, bank.name AS bank_account_name
       FROM journal_entries e
       JOIN journal_lines line ON line.tenant_id = e.tenant_id AND line.journal_entry_id = e.id
       JOIN accounting_accounts account ON account.tenant_id = line.tenant_id AND account.id = line.account_id
       LEFT JOIN partners partner ON partner.tenant_id = line.tenant_id AND partner.id = line.partner_id
       LEFT JOIN bank_accounts bank ON bank.tenant_id = line.tenant_id AND bank.id = line.bank_account_id
       WHERE e.tenant_id = $1
         AND ($2::text IS NULL OR account.code = $2)
         AND ($3::text IS NULL OR to_char(e.entry_date, 'YYYY-MM') = $3)
       ORDER BY e.entry_date DESC, e.entry_no DESC, line.line_no
       LIMIT $4`,
      [auth.tenantId, query.accountCode ?? null, query.period ?? null, query.limit],
    );
    return { ledger: result.rows.map((row) => ({
      id: row.id, entryNo: Number(row.entry_no), entryDate: dateOnly(row.entry_date),
      sourceType: row.source_type, sourceId: row.source_id,
      entryDescription: row.entry_description, lineNo: Number(row.line_no),
      description: row.description, accountCode: row.account_code, accountName: row.account_name,
      debitCents: money(row.debit_cents), creditCents: money(row.credit_cents), currency: row.currency,
      partnerName: row.partner_name, bankAccountName: row.bank_account_name,
    })) };
  });

  app.get("/api/accounting/bank-journal", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance", "viewer"]);
    const query = parse(z.object({
      bankAccountId: z.uuid().optional(),
      period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(500),
    }), request.query);
    const result = await database.query(
      `SELECT line.id, e.entry_no, e.entry_date::text, e.source_type, e.source_id,
              e.description AS entry_description, line.description,
              bank.id AS bank_account_id, bank.name AS bank_account_name,
              line.debit_cents::text, line.credit_cents::text, line.currency,
              partner.name AS partner_name
       FROM journal_entries e
       JOIN journal_lines line ON line.tenant_id = e.tenant_id AND line.journal_entry_id = e.id
       JOIN bank_accounts bank ON bank.tenant_id = line.tenant_id AND bank.id = line.bank_account_id
       LEFT JOIN partners partner ON partner.tenant_id = line.tenant_id AND partner.id = line.partner_id
       WHERE e.tenant_id = $1
         AND ($2::uuid IS NULL OR bank.id = $2)
         AND ($3::text IS NULL OR to_char(e.entry_date, 'YYYY-MM') = $3)
       ORDER BY e.entry_date DESC, e.entry_no DESC, line.line_no
       LIMIT $4`,
      [auth.tenantId, query.bankAccountId ?? null, query.period ?? null, query.limit],
    );
    return { bankJournal: result.rows.map((row) => ({
      id: row.id, entryNo: Number(row.entry_no), entryDate: dateOnly(row.entry_date),
      sourceType: row.source_type, sourceId: row.source_id,
      entryDescription: row.entry_description, description: row.description,
      bankAccountId: row.bank_account_id, bankAccountName: row.bank_account_name,
      debitCents: money(row.debit_cents), creditCents: money(row.credit_cents), currency: row.currency,
      partnerName: row.partner_name,
    })) };
  });

  app.get("/api/accounting/bank-accounts", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance", "viewer"]);
    const result = await database.query(
      `SELECT bank.id, bank.name, bank.account_type, bank.account_no, bank.currency,
              bank.opening_balance_cents::text, bank.is_default, bank.is_active,
              account.code AS account_code
       FROM bank_accounts bank
       JOIN accounting_accounts account ON account.tenant_id = bank.tenant_id AND account.id = bank.account_id
       WHERE bank.tenant_id = $1 ORDER BY bank.is_active DESC, bank.is_default DESC, bank.name`,
      [auth.tenantId],
    );
    return { bankAccounts: result.rows.map((row) => ({
      id: row.id, name: row.name, type: row.account_type, accountNo: row.account_no,
      currency: row.currency, openingBalanceCents: money(row.opening_balance_cents),
      isDefault: row.is_default === true, isActive: row.is_active === true, accountCode: row.account_code,
    })) };
  });

  app.get("/api/accounting/periods", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance", "viewer"]);
    const result = await database.query(
      `SELECT id, period_start::text, period_end::text, status, closed_at, closed_by
       FROM accounting_periods WHERE tenant_id = $1 ORDER BY period_start DESC`, [auth.tenantId],
    );
    return { periods: result.rows.map((row) => ({
      id: row.id, start: dateOnly(row.period_start), end: dateOnly(row.period_end), status: row.status,
      closedAt: iso(row.closed_at), closedBy: row.closed_by,
    })) };
  });

  app.post("/api/accounting/periods/:id/close", async (request) => {
    const auth = await authenticate(database, request, publicOrigin);
    requireRole(auth, ["owner", "finance"]);
    const params = parse(z.object({ id: z.uuid() }).strict(), request.params);
    await database.transaction(async (tx) => {
      const result = await tx.query<{ status: string }>(
        `SELECT status FROM accounting_periods WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [auth.tenantId, params.id],
      );
      const period = result.rows[0];
      if (!period) throw new ApiError(404, "ACCOUNTING_PERIOD_NOT_FOUND", "会计期间不存在");
      if (period.status === "closed") return;
      await tx.query(
        `UPDATE accounting_periods SET status = 'closed', closed_at = now(), closed_by = $3 WHERE tenant_id = $1 AND id = $2`,
        [auth.tenantId, params.id, auth.userId],
      );
      await writeAudit(tx, { tenantId: auth.tenantId, actorUserId: auth.userId, action: "accounting.period_closed", entityType: "accounting_period", entityId: params.id });
    });
    return { period: { id: params.id, status: "closed" } };
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

  app.addHook("onClose", async () => {
    await Promise.allSettled([...pendingSmsDispatches]);
  });

  if (options.closeDatabase) app.addHook("onClose", async () => database.close());

  return app;
}
