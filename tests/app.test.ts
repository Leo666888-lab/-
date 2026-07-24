import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPgliteDatabase, type Database, type Queryable } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { DEMO_IDS, seedDemo } from "../src/seed.js";

const SECOND_TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECOND_PARTNER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VIEWER_USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FINANCE_USER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SALES_USER_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const PUBLIC_ORIGIN = "http://localhost";

interface QueryTrace {
  scope: "outside" | "transaction";
  sql: string;
}

function withQueryTrace(database: Database, trace: QueryTrace[]): Database {
  return {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      trace.push({ scope: "outside", sql });
      return database.query<Row>(sql, params);
    },
    async exec(sql: string) {
      trace.push({ scope: "outside", sql });
      await database.exec(sql);
    },
    async transaction<T>(callback: (tx: Queryable) => Promise<T>): Promise<T> {
      return database.transaction((tx) => callback({
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) {
          trace.push({ scope: "transaction", sql });
          return tx.query<Row>(sql, params);
        },
        async exec(sql: string) {
          trace.push({ scope: "transaction", sql });
          await tx.exec(sql);
        },
      }));
    },
    async close() {
      await database.close();
    },
  };
}

describe.sequential("commercial settlement API", () => {
  let database: Database;
  let app: FastifyInstance;
  let ownerToken: string;
  let secondTenantToken: string;
  let viewerToken: string;
  let financeToken: string;
  let salesToken: string;
  let workflowOrderId: string;
  let workflowReminderId: string;
  let ownerCookie: string;
  let createdPartnerId: string;
  const queryTrace: QueryTrace[] = [];

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const paymentBody = {
    amountCents: 10_000,
    method: "bank_transfer",
    paidAt: "2026-04-30T10:00:00.000Z",
    note: "第一笔款",
    proofKey: "tenant/demo/proof-1.jpg",
  };

  const createOrder = async (options: {
    orderNo: string;
    token?: string;
    partnerId?: string;
    totalCents?: number;
  }) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: auth(options.token ?? ownerToken),
      payload: {
        partnerId: options.partnerId ?? DEMO_IDS.customer,
        orderNo: options.orderNo,
        direction: "receivable",
        orderDate: new Date().toISOString().slice(0, 10),
        items: [{ description: `Test item ${options.orderNo}`, quantity: 1, unitPriceCents: options.totalCents ?? 10_000 }],
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json().order as { id: string; totalCents: number };
  };

  const fulfillOrder = async (orderId: string, token = ownerToken) => {
    const response = await app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/fulfill`,
      headers: auth(token),
      payload: { fulfilledAt: new Date().toISOString() },
    });
    expect(response.statusCode).toBe(200);
    return response.json().order;
  };

  const recordPayment = async (options: {
    orderId: string;
    key: string;
    amountCents?: number;
    token?: string;
  }) => {
    const response = await app.inject({
      method: "POST",
      url: `/api/orders/${options.orderId}/payments`,
      headers: { ...auth(options.token ?? ownerToken), "idempotency-key": options.key },
      payload: { amountCents: options.amountCents ?? 10_000, method: "bank_transfer", note: options.key },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { payment: { id: string }; order: Record<string, unknown> };
  };

  beforeAll(async () => {
    database = await createPgliteDatabase(":memory:");
    await migrate(database);
    await seedDemo(database);

    const passwordHash = await bcrypt.hash("demo1234", 4);
    await database.transaction(async (tx) => {
      await tx.query("INSERT INTO tenants (id, name) VALUES ($1, '另一家企业')", [SECOND_TENANT_ID]);
      await tx.query(
        "INSERT INTO users (id, phone, display_name, password_hash) VALUES ($1, '13900000000', '第二租户老板', $2)",
        [SECOND_USER_ID, passwordHash],
      );
      await tx.query(
        "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')",
        [SECOND_TENANT_ID, SECOND_USER_ID],
      );
      await tx.query(
        `INSERT INTO partners (id, tenant_id, name, kind, contact_name)
         VALUES ($1, $2, 'Second Tenant Customer', 'customer', 'Tester')`,
        [SECOND_PARTNER_ID, SECOND_TENANT_ID],
      );
      await tx.query(
        "INSERT INTO users (id, phone, display_name, password_hash) VALUES ($1, '13700000000', '只读员工', $2)",
        [VIEWER_USER_ID, passwordHash],
      );
      await tx.query(
        "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'viewer')",
        [DEMO_IDS.tenant, VIEWER_USER_ID],
      );
      await tx.query(
        "INSERT INTO users (id, phone, display_name, password_hash) VALUES ($1, '13600000001', '财务员工', $2)",
        [FINANCE_USER_ID, passwordHash],
      );
      await tx.query(
        "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'finance')",
        [DEMO_IDS.tenant, FINANCE_USER_ID],
      );
      await tx.query(
        "INSERT INTO users (id, phone, display_name, password_hash) VALUES ($1, '13600000002', '销售员工', $2)",
        [SALES_USER_ID, passwordHash],
      );
      await tx.query(
        "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'sales')",
        [DEMO_IDS.tenant, SALES_USER_ID],
      );
    });
    app = buildApp({
      database: withQueryTrace(database, queryTrace),
      sessionTtlHours: 24,
      publicOrigin: PUBLIC_ORIGIN,
    });
    await app.ready();
    const [financeLogin, salesLogin] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { phone: "13600000001", password: "demo1234" },
      }),
      app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { phone: "13600000002", password: "demo1234" },
      }),
    ]);
    if (financeLogin.statusCode !== 200 || salesLogin.statusCode !== 200) {
      throw new Error("Failed to authenticate role fixtures");
    }
    financeToken = financeLogin.json().token;
    salesToken = salesLogin.json().token;
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("logs in and stores only a SHA-256 session digest", async () => {
    queryTrace.length = 0;
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: "13800000000", password: "demo1234" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    ownerToken = body.token;
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(sessionCookie).toContain("settlement_session=");
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Strict");
    expect(sessionCookie).not.toContain("Secure");
    ownerCookie = String(sessionCookie).split(";", 1)[0] ?? "";
    expect(ownerToken).toHaveLength(43);
    expect(body.role).toBe("owner");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");

    const stored = await database.query<{ token_hash: string }>(
      "SELECT token_hash FROM sessions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1",
      [DEMO_IDS.tenant],
    );
    expect(stored.rows[0]?.token_hash).toHaveLength(64);
    expect(stored.rows[0]?.token_hash).not.toBe(ownerToken);

    const lockedUserRead = queryTrace.findIndex((entry) =>
      entry.sql.includes("u.password_hash") && entry.sql.includes("FOR UPDATE OF u"));
    const sessionInsert = queryTrace.findIndex((entry) => entry.sql.includes("INSERT INTO sessions"));
    expect(lockedUserRead).toBeGreaterThanOrEqual(0);
    expect(sessionInsert).toBeGreaterThan(lockedUserRead);
    expect(queryTrace[lockedUserRead]?.scope).toBe("transaction");
    expect(queryTrace[sessionInsert]?.scope).toBe("transaction");
    expect(queryTrace.some((entry) => entry.scope === "outside" && entry.sql.includes("u.password_hash"))).toBe(false);
  });

  it("rejects a wrong password", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: "13800000000", password: "wrong-password" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("INVALID_CREDENTIALS");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("returns 404 instead of leaking another tenant's order", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: "13900000000", password: "demo1234" },
    });
    secondTenantToken = login.json().token;
    const response = await app.inject({
      method: "GET",
      url: `/api/orders/${DEMO_IDS.receivableOrder}`,
      headers: auth(secondTenantToken),
    });
    expect(response.statusCode).toBe(404);
  });

  it("forbids viewer writes", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: "13700000000", password: "demo1234" },
    });
    viewerToken = login.json().token;
    const response = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: auth(viewerToken),
      payload: {
        partnerId: DEMO_IDS.customer,
        orderNo: "VIEWER-MUST-NOT-WRITE",
        direction: "receivable",
        orderDate: "2026-01-01",
        items: [{ description: "测试商品", quantity: 1, unitPriceCents: 100 }],
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it("computes order total from items and rejects duplicate order numbers", async () => {
    const payload = {
      partnerId: DEMO_IDS.customer,
      orderNo: "COMM-TEST-ORDER-001",
      direction: "receivable",
      orderDate: "2026-01-01",
      plannedDeliveryDate: "2026-01-31",
      settlementMonths: 3,
      items: [
        { description: "商品 A", quantity: 2, unitPriceCents: 12_345 },
        { description: "商品 B", quantity: 1, unitPriceCents: 100 },
      ],
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: auth(ownerToken),
      payload,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    workflowOrderId = body.order.id;
    expect(body.order.totalCents).toBe(24_790);
    expect(body.order.paidCents).toBe(0);
    expect(body.order.fulfillmentStatus).toBe("planned");
    expect(body.order.settlementStatus).toBe("planned");

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: auth(ownerToken),
      payload,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("DUPLICATE_ORDER_NO");
  });

  it("allows the same order number in another tenant without leaking list, writes, or audit", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: auth(secondTenantToken),
      payload: {
        partnerId: SECOND_PARTNER_ID,
        orderNo: "COMM-TEST-ORDER-001",
        direction: "receivable",
        orderDate: "2026-01-01",
        items: [{ description: "Tenant two item", quantity: 1, unitPriceCents: 500 }],
      },
    });
    expect(create.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/api/orders", headers: auth(secondTenantToken) });
    expect(list.statusCode).toBe(200);
    expect(list.json().orders).toHaveLength(1);
    expect(list.json().orders[0].id).toBe(create.json().order.id);

    const crossTenantFulfill = await app.inject({
      method: "POST",
      url: `/api/orders/${workflowOrderId}/fulfill`,
      headers: auth(secondTenantToken),
      payload: {},
    });
    expect(crossTenantFulfill.statusCode).toBe(404);

    const crossTenantPayment = await app.inject({
      method: "POST",
      url: `/api/orders/${workflowOrderId}/payments`,
      headers: { ...auth(secondTenantToken), "idempotency-key": "tenant-two-cross-write" },
      payload: { amountCents: 1, method: "cash" },
    });
    expect(crossTenantPayment.statusCode).toBe(404);

    const audit = await app.inject({ method: "GET", url: "/api/audit", headers: auth(secondTenantToken) });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().audit.some((entry: { entityId: string }) => entry.entityId === workflowOrderId)).toBe(false);
    expect(audit.json().audit.some((entry: { entityId: string }) => entry.entityId === DEMO_IDS.receivableOrder)).toBe(false);
  });

  it("keeps a planned order out of reminders and blocks payment before fulfillment", async () => {
    const reminders = await database.query(
      "SELECT id FROM reminders WHERE tenant_id = $1 AND order_id = $2",
      [DEMO_IDS.tenant, workflowOrderId],
    );
    expect(reminders.rowCount).toBe(0);

    const payment = await app.inject({
      method: "POST",
      url: `/api/orders/${workflowOrderId}/payments`,
      headers: { ...auth(ownerToken), "idempotency-key": "before-fulfillment" },
      payload: paymentBody,
    });
    expect(payment.statusCode).toBe(409);
    expect(payment.json().error.code).toBe("ORDER_NOT_FULFILLED");
  });

  it("requires explicit fulfillment and calculates three months by calendar month", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/orders/${workflowOrderId}/fulfill`,
      headers: auth(ownerToken),
      payload: { fulfilledAt: "2026-01-31T10:00:00.000Z" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().order.fulfillmentStatus).toBe("fulfilled");
    expect(response.json().order.settlementStatus).toBe("awaiting");
    expect(response.json().order.dueAt).toBe("2026-04-30T10:00:00.000Z");

    const repeat = await app.inject({
      method: "POST",
      url: `/api/orders/${workflowOrderId}/fulfill`,
      headers: auth(ownerToken),
      payload: { fulfilledAt: "2026-02-01T10:00:00.000Z" },
    });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().order.fulfilledAt).toBe("2026-01-31T10:00:00.000Z");
    const reminders = await database.query(
      "SELECT id FROM reminders WHERE tenant_id = $1 AND order_id = $2",
      [DEMO_IDS.tenant, workflowOrderId],
    );
    expect(reminders.rowCount).toBe(1);
    workflowReminderId = String(reminders.rows[0]?.id);
  });

  it("snoozes and acknowledges a reminder with audit-safe state changes", async () => {
    const futureSnooze = new Date(Date.now() + 86_400_000).toISOString();
    const snooze = await app.inject({
      method: "POST",
      url: `/api/reminders/${workflowReminderId}/snooze`,
      headers: auth(ownerToken),
      payload: { until: futureSnooze },
    });
    expect(snooze.statusCode).toBe(200);
    expect(snooze.json().reminder.status).toBe("snoozed");

    const ack = await app.inject({
      method: "POST",
      url: `/api/reminders/${workflowReminderId}/ack`,
      headers: auth(ownerToken),
    });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().reminder.status).toBe("acked");
    expect(new Date(ack.json().reminder.snoozedUntil).getTime()).toBeGreaterThan(Date.now());

    const beforeTomorrow = await app.inject({ method: "GET", url: "/api/bootstrap", headers: auth(ownerToken) });
    expect(beforeTomorrow.json().reminders.some((item: { id: string }) => item.id === workflowReminderId)).toBe(false);

    await database.query(
      "UPDATE reminders SET snoozed_until = now() - interval '1 minute' WHERE tenant_id = $1 AND id = $2",
      [DEMO_IDS.tenant, workflowReminderId],
    );
    const nextDay = await app.inject({ method: "GET", url: "/api/bootstrap", headers: auth(ownerToken) });
    expect(nextDay.json().reminders.some((item: { id: string }) => item.id === workflowReminderId)).toBe(true);
  });

  it("rejects payment timestamps before actual fulfillment", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/orders/${workflowOrderId}/payments`,
      headers: { ...auth(ownerToken), "idempotency-key": "payment-too-early" },
      payload: { ...paymentBody, paidAt: "2026-01-30T10:00:00.000Z" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("PAYMENT_BEFORE_FULFILLMENT");
  });

  it("rejects future payments beyond five minutes but tolerates small clock skew", async () => {
    const baseTime = Date.now();
    const created = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: auth(ownerToken),
      payload: {
        partnerId: DEMO_IDS.customer,
        orderNo: "PAYMENT-CLOCK-SKEW-001",
        direction: "receivable",
        orderDate: new Date(baseTime).toISOString().slice(0, 10),
        items: [{ description: "Clock skew test", quantity: 1, unitPriceCents: 100 }],
      },
    });
    expect(created.statusCode).toBe(201);
    const orderId = created.json().order.id;
    const fulfilled = await app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/fulfill`,
      headers: auth(ownerToken),
      payload: { fulfilledAt: new Date(baseTime).toISOString() },
    });
    expect(fulfilled.statusCode).toBe(200);

    const tooFarAhead = await app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/payments`,
      headers: { ...auth(ownerToken), "idempotency-key": "future-payment-rejected" },
      payload: { amountCents: 100, method: "cash", paidAt: new Date(baseTime + 6 * 60_000).toISOString() },
    });
    expect(tooFarAhead.statusCode).toBe(400);
    expect(tooFarAhead.json().error.code).toBe("PAYMENT_IN_FUTURE");

    const tolerated = await app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/payments`,
      headers: { ...auth(ownerToken), "idempotency-key": "future-payment-tolerated" },
      payload: { amountCents: 100, method: "cash", paidAt: new Date(baseTime + 4 * 60_000).toISOString() },
    });
    expect(tolerated.statusCode).toBe(201);
    expect(tolerated.json().order.settlementStatus).toBe("settled");
  });

  it("rejects zero and negative payment amounts", async () => {
    for (const amountCents of [0, -1]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/orders/${workflowOrderId}/payments`,
        headers: { ...auth(ownerToken), "idempotency-key": `invalid-amount-${amountCents}` },
        payload: { amountCents, method: "cash" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("settles a 10000 yuan order through 3000, 2000, and 5000 yuan payments", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: auth(ownerToken),
      payload: {
        partnerId: DEMO_IDS.customer,
        orderNo: "PARTIAL-3000-2000-5000",
        direction: "receivable",
        orderDate: new Date().toISOString().slice(0, 10),
        items: [{ description: "分次结算测试订单", quantity: 1, unitPriceCents: 1_000_000 }],
      },
    });
    expect(created.statusCode).toBe(201);
    const orderId = created.json().order.id;

    const fulfilled = await app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/fulfill`,
      headers: auth(ownerToken),
      payload: { fulfilledAt: new Date().toISOString() },
    });
    expect(fulfilled.statusCode).toBe(200);

    const splits = [300_000, 200_000, 500_000];
    const expectedOutstanding = [700_000, 500_000, 0];
    for (const [index, amountCents] of splits.entries()) {
      const payment = await app.inject({
        method: "POST",
        url: `/api/orders/${orderId}/payments`,
        headers: { ...auth(ownerToken), "idempotency-key": `split-payment-${index + 1}` },
        payload: { amountCents, method: "bank_transfer", note: `第 ${index + 1} 笔` },
      });
      expect(payment.statusCode).toBe(201);
      expect(payment.json().order.paidCents).toBe(splits.slice(0, index + 1).reduce((sum, value) => sum + value, 0));
      expect(payment.json().order.outstandingCents).toBe(expectedOutstanding[index]);
      expect(payment.json().order.settlementStatus).toBe(index === splits.length - 1 ? "settled" : "partial");
    }

    const reminder = await database.query<{ status: string }>(
      "SELECT status FROM reminders WHERE tenant_id = $1 AND order_id = $2",
      [DEMO_IDS.tenant, orderId],
    );
    expect(reminder.rows[0]?.status).toBe("closed");
  });

  it("records a partial payment once and validates the complete idempotent request", async () => {
    const request = () => app.inject({
      method: "POST",
      url: `/api/orders/${workflowOrderId}/payments`,
      headers: { ...auth(ownerToken), "idempotency-key": "partial-payment-001" },
      payload: paymentBody,
    });
    const [first, replay] = await Promise.all([request(), request()]);
    expect([first.statusCode, replay.statusCode].sort()).toEqual([200, 201]);
    const bodies = [first.json(), replay.json()];
    expect(bodies.some((body) => body.idempotentReplay === true)).toBe(true);
    expect(bodies[0].payment.id).toBe(bodies[1].payment.id);
    expect(bodies[0].order.paidCents).toBe(10_000);
    expect(bodies[0].order.outstandingCents).toBe(14_790);
    expect(bodies[0].order.settlementStatus).toBe("partial");
    expect(bodies[0].order.payments).toHaveLength(1);

    const changedRequest = await app.inject({
      method: "POST",
      url: `/api/orders/${workflowOrderId}/payments`,
      headers: { ...auth(ownerToken), "idempotency-key": "partial-payment-001" },
      payload: { ...paymentBody, method: "cash" },
    });
    expect(changedRequest.statusCode).toBe(409);
    expect(changedRequest.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("rejects an overpayment", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/orders/${workflowOrderId}/payments`,
      headers: { ...auth(ownerToken), "idempotency-key": "overpayment-001" },
      payload: { ...paymentBody, amountCents: 14_791, note: "超额测试" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PAYMENT_EXCEEDS_OUTSTANDING");
    expect(response.json().error.details.outstandingCents).toBe(14_790);
  });

  it("serializes concurrent payments so their sum cannot exceed the balance", async () => {
    const makePayment = (key: string) => app.inject({
      method: "POST",
      url: `/api/orders/${workflowOrderId}/payments`,
      headers: { ...auth(ownerToken), "idempotency-key": key },
      payload: { ...paymentBody, amountCents: 10_000, note: key },
    });
    const responses = await Promise.all([makePayment("concurrent-a"), makePayment("concurrent-b")]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const order = await app.inject({
      method: "GET",
      url: `/api/orders/${workflowOrderId}`,
      headers: auth(ownerToken),
    });
    expect(order.json().order.paidCents).toBe(20_000);
    expect(order.json().order.outstandingCents).toBe(4_790);
  });

  it("derives settlement from payments and closes reminders when fully settled", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/orders/${workflowOrderId}/payments`,
      headers: { ...auth(ownerToken), "idempotency-key": "final-payment-001" },
      payload: { ...paymentBody, amountCents: 4_790, note: "尾款" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().order.paidCents).toBe(24_790);
    expect(response.json().order.outstandingCents).toBe(0);
    expect(response.json().order.settlementStatus).toBe("settled");

    const reminder = await database.query<{ status: string }>(
      "SELECT status FROM reminders WHERE tenant_id = $1 AND order_id = $2",
      [DEMO_IDS.tenant, workflowOrderId],
    );
    expect(reminder.rows[0]?.status).toBe("closed");
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers: auth(ownerToken) });
    expect(bootstrap.json().reminders.some((item: { orderId: string }) => item.orderId === workflowOrderId)).toBe(false);
  });

  it("validates payment reversal input and enforces finance-only permissions and tenant isolation", async () => {
    const order = await createOrder({ orderNo: "REVERSAL-PERMISSIONS-001", totalCents: 20_000 });
    await fulfillOrder(order.id);
    const createdPayment = await recordPayment({
      orderId: order.id,
      key: "reversal-permissions-payment",
      amountCents: 10_000,
    });
    const paymentId = createdPayment.payment.id;

    const missingKey = await app.inject({
      method: "POST",
      url: `/api/payments/${paymentId}/reverse`,
      headers: auth(ownerToken),
      payload: { reason: "录入错误" },
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const emptyReason = await app.inject({
      method: "POST",
      url: `/api/payments/${paymentId}/reverse`,
      headers: { ...auth(ownerToken), "idempotency-key": "reversal-empty-reason" },
      payload: { reason: "   " },
    });
    expect(emptyReason.statusCode).toBe(400);
    expect(emptyReason.json().error.code).toBe("VALIDATION_ERROR");

    for (const [token, key] of [[salesToken, "reversal-sales-forbidden"], [viewerToken, "reversal-viewer-forbidden"]] as const) {
      const forbidden = await app.inject({
        method: "POST",
        url: `/api/payments/${paymentId}/reverse`,
        headers: { ...auth(token), "idempotency-key": key },
        payload: { reason: "没有冲销权限" },
      });
      expect(forbidden.statusCode).toBe(403);
    }

    const crossTenant = await app.inject({
      method: "POST",
      url: `/api/payments/${paymentId}/reverse`,
      headers: { ...auth(secondTenantToken), "idempotency-key": "reversal-cross-tenant" },
      payload: { reason: "不应看到其他租户付款" },
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json().error.code).toBe("NOT_FOUND");

    const financeReversal = await app.inject({
      method: "POST",
      url: `/api/payments/${paymentId}/reverse`,
      headers: { ...auth(financeToken), "idempotency-key": "reversal-finance-allowed" },
      payload: { reason: "财务复核后冲销" },
    });
    expect(financeReversal.statusCode).toBe(201);
    expect(financeReversal.json().idempotentReplay).toBe(false);
    expect(financeReversal.json().order.paidCents).toBe(0);
    expect(financeReversal.json().order.outstandingCents).toBe(20_000);
  });

  it("reopens a settled balance after reversal, preserves history, and supports a replacement payment", async () => {
    const partnerResponse = await app.inject({
      method: "POST",
      url: "/api/partners",
      headers: auth(ownerToken),
      payload: { name: "冲销生命周期客户", kind: "customer" },
    });
    expect(partnerResponse.statusCode).toBe(201);
    const partnerId = partnerResponse.json().partner.id;
    const order = await createOrder({
      orderNo: "REVERSAL-LIFECYCLE-001",
      partnerId,
      totalCents: 10_000,
    });
    const fulfilled = await fulfillOrder(order.id);
    const originalReminder = await database.query<{ id: string; due_at: Date | string; status: string }>(
      "SELECT id, due_at, status FROM reminders WHERE tenant_id = $1 AND order_id = $2",
      [DEMO_IDS.tenant, order.id],
    );
    expect(originalReminder.rows).toHaveLength(1);
    expect(originalReminder.rows[0]?.status).toBe("open");
    const originalReminderId = String(originalReminder.rows[0]?.id);
    const originalDueAt = new Date(String(originalReminder.rows[0]?.due_at)).toISOString();
    expect(originalDueAt).toBe(fulfilled.dueAt);

    const payment = await recordPayment({ orderId: order.id, key: "reversal-lifecycle-original" });
    const paymentId = payment.payment.id;
    expect(payment.order.paidCents).toBe(10_000);
    expect(payment.order.outstandingCents).toBe(0);
    expect(payment.order.settlementStatus).toBe("settled");
    const closedBeforeReversal = await database.query<{ status: string }>(
      "SELECT status FROM reminders WHERE tenant_id = $1 AND id = $2",
      [DEMO_IDS.tenant, originalReminderId],
    );
    expect(closedBeforeReversal.rows[0]?.status).toBe("closed");

    const reverseRequest = (reason = "银行流水对应错订单") => app.inject({
      method: "POST",
      url: `/api/payments/${paymentId}/reverse`,
      headers: { ...auth(ownerToken), "idempotency-key": "reversal-lifecycle-key" },
      payload: { reason },
    });
    const reversed = await reverseRequest();
    expect(reversed.statusCode).toBe(201);
    const reversedBody = reversed.json();
    expect(reversedBody.idempotentReplay).toBe(false);
    expect(reversedBody.reversal.paymentId).toBe(paymentId);
    expect(reversedBody.reversal.reason).toBe("银行流水对应错订单");
    expect(new Date(reversedBody.reversal.reversedAt).toISOString()).toBe(reversedBody.reversal.reversedAt);
    expect(reversedBody.order.paidCents).toBe(0);
    expect(reversedBody.order.outstandingCents).toBe(10_000);
    expect(reversedBody.order.settlementStatus).toBe("awaiting");
    const reversedPayment = reversedBody.order.payments.find((item: { id: string }) => item.id === paymentId);
    expect(reversedPayment.reversedAt).toBe(reversedBody.reversal.reversedAt);
    expect(reversedPayment.reversalReason).toBe("银行流水对应错订单");

    const detail = await app.inject({ method: "GET", url: `/api/orders/${order.id}`, headers: auth(ownerToken) });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().order.paidCents).toBe(0);
    expect(detail.json().order.outstandingCents).toBe(10_000);
    expect(detail.json().order.payments).toHaveLength(1);
    expect(detail.json().order.payments[0]).toMatchObject({
      id: paymentId,
      amountCents: 10_000,
      reversalReason: "银行流水对应错订单",
    });

    const orderList = await app.inject({ method: "GET", url: "/api/orders", headers: auth(ownerToken) });
    const listedOrder = orderList.json().orders.find((item: { id: string }) => item.id === order.id);
    expect(listedOrder).toMatchObject({ paidCents: 0, outstandingCents: 10_000, settlementStatus: "awaiting" });

    const afterReversal = await app.inject({ method: "GET", url: "/api/bootstrap", headers: auth(ownerToken) });
    const lifecyclePartner = afterReversal.json().partners.find((item: { id: string }) => item.id === partnerId);
    expect(lifecyclePartner.balances).toContainEqual({
      currency: "CNY",
      receivableCents: 10_000,
      payableCents: 0,
    });
    expect(afterReversal.json().reminders).toContainEqual(expect.objectContaining({
      orderId: order.id,
      outstandingCents: 10_000,
      status: "open",
    }));

    const remindersAfterReversal = await database.query<{ id: string; due_at: Date | string; status: string }>(
      `SELECT id, due_at, status FROM reminders
       WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at, id`,
      [DEMO_IDS.tenant, order.id],
    );
    expect(remindersAfterReversal.rows).toHaveLength(2);
    expect(remindersAfterReversal.rows.find((item) => item.id === originalReminderId)?.status).toBe("closed");
    const reopenedReminder = remindersAfterReversal.rows.find((item) => item.id !== originalReminderId);
    expect(reopenedReminder?.status).toBe("open");
    expect(new Date(String(reopenedReminder?.due_at)).toISOString()).toBe(originalDueAt);

    const replay = await reverseRequest();
    expect(replay.statusCode).toBe(200);
    expect(replay.json().idempotentReplay).toBe(true);
    expect(replay.json().reversal.id).toBe(reversedBody.reversal.id);

    const changedReason = await reverseRequest("相同幂等键但不同原因");
    expect(changedReason.statusCode).toBe(409);
    expect(changedReason.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const secondKey = await app.inject({
      method: "POST",
      url: `/api/payments/${paymentId}/reverse`,
      headers: { ...auth(ownerToken), "idempotency-key": "reversal-lifecycle-second-key" },
      payload: { reason: "尝试再次冲销" },
    });
    expect(secondKey.statusCode).toBe(409);
    expect(secondKey.json().error.code).toBe("PAYMENT_ALREADY_REVERSED");

    const reversalRows = await database.query<{ id: string; reason: string }>(
      "SELECT id, reason FROM payment_reversals WHERE tenant_id = $1 AND payment_id = $2",
      [DEMO_IDS.tenant, paymentId],
    );
    expect(reversalRows.rows).toEqual([{ id: reversedBody.reversal.id, reason: "银行流水对应错订单" }]);
    await expect(database.query(
      "UPDATE payment_reversals SET reason = '篡改原因' WHERE tenant_id = $1 AND id = $2",
      [DEMO_IDS.tenant, reversedBody.reversal.id],
    )).rejects.toThrow();
    await expect(database.query(
      "DELETE FROM payment_reversals WHERE tenant_id = $1 AND id = $2",
      [DEMO_IDS.tenant, reversedBody.reversal.id],
    )).rejects.toThrow();
    const immutableReversal = await database.query<{ reason: string }>(
      "SELECT reason FROM payment_reversals WHERE tenant_id = $1 AND id = $2",
      [DEMO_IDS.tenant, reversedBody.reversal.id],
    );
    expect(immutableReversal.rows[0]?.reason).toBe("银行流水对应错订单");

    const tooLargeReplacement = await app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/payments`,
      headers: { ...auth(ownerToken), "idempotency-key": "reversal-lifecycle-overpayment" },
      payload: { amountCents: 10_001, method: "cash" },
    });
    expect(tooLargeReplacement.statusCode).toBe(409);
    expect(tooLargeReplacement.json().error.code).toBe("PAYMENT_EXCEEDS_OUTSTANDING");
    expect(tooLargeReplacement.json().error.details.outstandingCents).toBe(10_000);

    const replacement = await recordPayment({ orderId: order.id, key: "reversal-lifecycle-replacement" });
    expect(replacement.order.paidCents).toBe(10_000);
    expect(replacement.order.outstandingCents).toBe(0);
    expect(replacement.order.settlementStatus).toBe("settled");
    const finalDetail = await app.inject({ method: "GET", url: `/api/orders/${order.id}`, headers: auth(ownerToken) });
    expect(finalDetail.json().order.payments).toHaveLength(2);
    expect(finalDetail.json().order.payments.find((item: { id: string }) => item.id === paymentId)).toMatchObject({
      reversedAt: reversedBody.reversal.reversedAt,
      reversalReason: "银行流水对应错订单",
    });
    expect(finalDetail.json().order.payments.find((item: { id: string }) => item.id === replacement.payment.id).reversedAt).toBeNull();

    const finalBootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers: auth(ownerToken) });
    const finalPartner = finalBootstrap.json().partners.find((item: { id: string }) => item.id === partnerId);
    expect(finalPartner.balances).toContainEqual({ currency: "CNY", receivableCents: 0, payableCents: 0 });
    expect(finalBootstrap.json().reminders.some((item: { orderId: string }) => item.orderId === order.id)).toBe(false);
    const finalReminders = await database.query<{ status: string }>(
      "SELECT status FROM reminders WHERE tenant_id = $1 AND order_id = $2",
      [DEMO_IDS.tenant, order.id],
    );
    expect(finalReminders.rows).toHaveLength(2);
    expect(finalReminders.rows.every((item) => item.status === "closed")).toBe(true);

    const auditRows = await database.query<{ action: string }>(
      `SELECT action FROM audit_logs
       WHERE tenant_id = $1 AND metadata->>'orderId' = $2
         AND action IN ('payment.reversed', 'reminder.created')`,
      [DEMO_IDS.tenant, order.id],
    );
    expect(auditRows.rows.filter((item) => item.action === "payment.reversed")).toHaveLength(1);
    expect(auditRows.rows.filter((item) => item.action === "reminder.created")).toHaveLength(2);
  });

  it("cancels a planned order naturally idempotently without leaking it across tenants", async () => {
    const order = await createOrder({ orderNo: "CANCEL-IDEMPOTENT-001" });

    const crossTenant = await app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/cancel`,
      headers: auth(secondTenantToken),
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json().error.code).toBe("NOT_FOUND");

    const viewer = await app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/cancel`,
      headers: auth(viewerToken),
    });
    expect(viewer.statusCode).toBe(403);

    const first = await app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/cancel`,
      headers: auth(ownerToken),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().idempotentReplay).toBe(false);
    expect(first.json().order.fulfillmentStatus).toBe("cancelled");
    expect(first.json().order.settlementStatus).toBe("cancelled");

    const repeat = await app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/cancel`,
      headers: auth(ownerToken),
    });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().idempotentReplay).toBe(true);
    expect(repeat.json().order.fulfillmentStatus).toBe("cancelled");

    const audit = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_logs
       WHERE tenant_id = $1 AND action = 'order.cancelled' AND entity_id = $2`,
      [DEMO_IDS.tenant, order.id],
    );
    expect(Number(audit.rows[0]?.count)).toBe(1);
  });

  it("allows finance and sales to cancel planned orders", async () => {
    for (const [token, suffix] of [[financeToken, "FINANCE"], [salesToken, "SALES"]] as const) {
      const order = await createOrder({ orderNo: `CANCEL-${suffix}-001`, token });
      const response = await app.inject({
        method: "POST",
        url: `/api/orders/${order.id}/cancel`,
        headers: auth(token),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().idempotentReplay).toBe(false);
      expect(response.json().order.fulfillmentStatus).toBe("cancelled");
    }
  });

  it("rejects cancellation after fulfillment or when any historical payment row exists", async () => {
    const fulfilledOrder = await createOrder({ orderNo: "CANCEL-FULFILLED-001" });
    await fulfillOrder(fulfilledOrder.id);
    const fulfilledCancellation = await app.inject({
      method: "POST",
      url: `/api/orders/${fulfilledOrder.id}/cancel`,
      headers: auth(ownerToken),
    });
    expect(fulfilledCancellation.statusCode).toBe(409);
    expect(fulfilledCancellation.json().error.code).toBe("ORDER_NOT_PLANNED");

    const legacyOrder = await createOrder({ orderNo: "CANCEL-REVERSED-PAYMENT-001" });
    const paymentId = randomUUID();
    const reversalId = randomUUID();
    await database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO payments (
           id, tenant_id, order_id, amount_cents, method, paid_at, note,
           idempotency_key, request_hash, created_by
         ) VALUES ($1, $2, $3, 100, 'cash', now(), 'legacy row', $4, repeat('a', 64), $5)`,
        [paymentId, DEMO_IDS.tenant, legacyOrder.id, `legacy-payment-${paymentId}`, DEMO_IDS.user],
      );
      await tx.query(
        `INSERT INTO payment_reversals (
           id, tenant_id, payment_id, order_id, reason, idempotency_key,
           request_hash, reversed_by
         ) VALUES ($1, $2, $3, $4, 'legacy reversal', $5, repeat('b', 64), $6)`,
        [reversalId, DEMO_IDS.tenant, paymentId, legacyOrder.id, `legacy-reversal-${reversalId}`, DEMO_IDS.user],
      );
    });

    const hasHistoricalPayment = await app.inject({
      method: "POST",
      url: `/api/orders/${legacyOrder.id}/cancel`,
      headers: auth(ownerToken),
    });
    expect(hasHistoricalPayment.statusCode).toBe(409);
    expect(hasHistoricalPayment.json().error.code).toBe("ORDER_HAS_PAYMENTS");
    const unchanged = await app.inject({ method: "GET", url: `/api/orders/${legacyOrder.id}`, headers: auth(ownerToken) });
    expect(unchanged.json().order.fulfillmentStatus).toBe("planned");
  });

  it("calculates calendar-month terms in the tenant timezone across offset, leap-year, and year boundaries", async () => {
    const cases = [
      {
        orderNo: "CALENDAR-OFFSET-001",
        orderDate: "2026-03-01",
        months: 1,
        fulfilledAt: "2026-03-01T00:30:00+08:00",
        expectedDueAt: "2026-03-31T16:30:00.000Z",
      },
      {
        orderNo: "CALENDAR-LEAP-001",
        orderDate: "2024-01-31",
        months: 1,
        fulfilledAt: "2024-01-31T08:00:00+08:00",
        expectedDueAt: "2024-02-29T00:00:00.000Z",
      },
      {
        orderNo: "CALENDAR-YEAR-001",
        orderDate: "2026-12-31",
        months: 2,
        fulfilledAt: "2026-12-31T08:00:00+08:00",
        expectedDueAt: "2027-02-28T00:00:00.000Z",
      },
    ];

    for (const testCase of cases) {
      const created = await app.inject({
        method: "POST",
        url: "/api/orders",
        headers: auth(ownerToken),
        payload: {
          partnerId: DEMO_IDS.customer,
          orderNo: testCase.orderNo,
          direction: "receivable",
          orderDate: testCase.orderDate,
          settlementMonths: testCase.months,
          items: [{ description: "Calendar test", quantity: 1, unitPriceCents: 100 }],
        },
      });
      expect(created.statusCode).toBe(201);
      const fulfilled = await app.inject({
        method: "POST",
        url: `/api/orders/${created.json().order.id}/fulfill`,
        headers: auth(ownerToken),
        payload: { fulfilledAt: testCase.fulfilledAt },
      });
      expect(fulfilled.statusCode).toBe(200);
      expect(fulfilled.json().order.dueAt).toBe(testCase.expectedDueAt);
    }
  });

  it("round-trips Chinese, English, and Arabic and keeps partner balances separated by currency", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: auth(ownerToken),
      payload: {
        partnerId: DEMO_IDS.customer,
        orderNo: "طلب-中文-001",
        direction: "receivable",
        orderDate: new Date().toISOString().slice(0, 10),
        settlementMonths: 3,
        currency: "USD",
        notes: "中文 English العربية",
        items: [{ description: "运动袜 Sports Socks جوارب رياضية", quantity: 3, unitPriceCents: 250 }],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().order.orderNo).toBe("طلب-中文-001");
    expect(created.json().order.notes).toBe("中文 English العربية");
    expect(created.json().order.items[0].description).toBe("运动袜 Sports Socks جوارب رياضية");

    const fulfilled = await app.inject({
      method: "POST",
      url: `/api/orders/${created.json().order.id}/fulfill`,
      headers: auth(ownerToken),
      payload: { fulfilledAt: new Date().toISOString() },
    });
    expect(fulfilled.statusCode).toBe(200);

    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers: auth(ownerToken) });
    const customer = bootstrap.json().partners.find((partner: { id: string }) => partner.id === DEMO_IDS.customer);
    expect(customer).not.toHaveProperty("receivableCents");
    expect(customer.balances.find((balance: { currency: string }) => balance.currency === "USD")).toEqual({
      currency: "USD",
      receivableCents: 750,
      payableCents: 0,
    });
    expect(customer.balances.some((balance: { currency: string }) => balance.currency === "CNY")).toBe(true);
    expect(bootstrap.json().reminders.some((item: { orderId: string }) => item.orderId === created.json().order.id)).toBe(false);
  });

  it("creates and lists partners through both partners and contacts routes", async () => {
    const name = "多语言客户 Multilingual عميل";
    const created = await app.inject({
      method: "POST",
      url: "/api/partners",
      headers: auth(ownerToken),
      payload: { name, kind: "customer", contactName: "李经理", phone: "+86 138 0000 0002" },
    });
    expect(created.statusCode).toBe(201);
    createdPartnerId = created.json().partner.id;
    expect(created.json().partner.version).toBe(1);

    const partners = await app.inject({ method: "GET", url: "/api/partners", headers: auth(ownerToken) });
    const contacts = await app.inject({ method: "GET", url: "/api/contacts", headers: { cookie: ownerCookie } });
    expect(partners.json().partners.some((partner: { id: string }) => partner.id === createdPartnerId)).toBe(true);
    expect(contacts.json().contacts.some((partner: { id: string }) => partner.id === createdPartnerId)).toBe(true);

    const sameNameOtherTenant = await app.inject({
      method: "POST",
      url: "/api/contacts",
      headers: auth(secondTenantToken),
      payload: { name, kind: "customer" },
    });
    expect(sameNameOtherTenant.statusCode).toBe(201);
  });

  it("uses partner versions to reject stale updates and enforces tenant and role boundaries", async () => {
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/contacts/${createdPartnerId}`,
      headers: auth(ownerToken),
      payload: { version: 1, contactName: "Updated Contact", phone: null },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().contact.version).toBe(2);
    expect(updated.json().contact.phone).toBeNull();

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/partners/${createdPartnerId}`,
      headers: auth(ownerToken),
      payload: { version: 1, contactName: "Stale write" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("PARTNER_VERSION_CONFLICT");

    const crossTenant = await app.inject({
      method: "PATCH",
      url: `/api/partners/${createdPartnerId}`,
      headers: auth(secondTenantToken),
      payload: { version: 2, contactName: "Cross tenant" },
    });
    expect(crossTenant.statusCode).toBe(404);

    const viewerWrite = await app.inject({
      method: "POST",
      url: "/api/partners",
      headers: auth(viewerToken),
      payload: { name: "Viewer forbidden", kind: "customer" },
    });
    expect(viewerWrite.statusCode).toBe(403);
  });

  it("writes tenant-scoped audit records for every business mutation", async () => {
    const response = await app.inject({ method: "GET", url: "/api/audit?limit=200", headers: auth(ownerToken) });
    expect(response.statusCode).toBe(200);
    const relevant = response.json().audit.filter((entry: { entityId: string; metadata: { orderId?: string } }) =>
      entry.entityId === workflowOrderId || entry.metadata?.orderId === workflowOrderId);
    expect(relevant.some((entry: { action: string }) => entry.action === "order.created")).toBe(true);
    expect(relevant.some((entry: { action: string }) => entry.action === "order.fulfilled")).toBe(true);
    expect(relevant.some((entry: { action: string }) => entry.action === "reminder.created")).toBe(true);
    expect(relevant.some((entry: { action: string }) => entry.action === "reminder.closed")).toBe(true);
    expect(relevant.filter((entry: { action: string }) => entry.action === "payment.created")).toHaveLength(3);
    expect(response.json().audit.some((entry: { action: string; entityId: string }) =>
      entry.action === "partner.created" && entry.entityId === createdPartnerId)).toBe(true);
    expect(response.json().audit.some((entry: { action: string; entityId: string }) =>
      entry.action === "partner.updated" && entry.entityId === createdPartnerId)).toBe(true);

    const viewerAudit = await app.inject({ method: "GET", url: "/api/audit", headers: auth(viewerToken) });
    expect(viewerAudit.statusCode).toBe(403);
  });

  it("requires an exact Origin for cookie mutations and leaves Bearer clients unaffected", async () => {
    const payload = {
      currentPassword: "not-the-current-password",
      newPassword: "origin-check-password-2026",
    };
    const rejectedOrigins = [undefined, "null", "not-an-origin", "http://localhost:777"];
    for (const origin of rejectedOrigins) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers: origin ? { cookie: ownerCookie, origin } : { cookie: ownerCookie },
        payload,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("INVALID_ORIGIN");
    }

    const sameOrigin = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: ownerCookie, origin: PUBLIC_ORIGIN },
      payload,
    });
    expect(sameOrigin.statusCode).toBe(401);
    expect(sameOrigin.json().error.code).toBe("INVALID_CURRENT_PASSWORD");

    const bearerCrossOrigin = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { ...auth(ownerToken), origin: "https://untrusted.example.test" },
      payload,
    });
    expect(bearerCrossOrigin.statusCode).toBe(401);
    expect(bearerCrossOrigin.json().error.code).toBe("INVALID_CURRENT_PASSWORD");
  });

  it("authenticates with HttpOnly cookies and revokes the session on logout", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: "13800000000", password: "demo1234" },
    });
    const setCookie = login.headers["set-cookie"];
    const cookieHeader = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";", 1)[0] ?? "";
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { cookie: cookieHeader } });
    expect(bootstrap.statusCode).toBe(200);

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: cookieHeader, origin: PUBLIC_ORIGIN },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers["set-cookie"]).toContain("settlement_session=");
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
    const afterLogout = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { cookie: cookieHeader } });
    expect(afterLogout.statusCode).toBe(401);

    const audit = await app.inject({ method: "GET", url: "/api/audit?limit=200", headers: auth(ownerToken) });
    expect(audit.json().audit.some((entry: { action: string }) => entry.action === "auth.logout")).toBe(true);
  });

  it("serves a same-origin SPA and keeps API 404 responses as JSON", async () => {
    const staticApp = buildApp({
      database,
      serveStatic: true,
      staticRoot: resolve(process.cwd(), "tests/fixtures/static"),
    });
    await staticApp.ready();
    const home = await staticApp.inject({ method: "GET", url: "/" });
    const fallback = await staticApp.inject({ method: "GET", url: "/orders/example" });
    const missingApi = await staticApp.inject({ method: "GET", url: "/api/not-real" });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain("同源前端测试");
    expect(home.headers["cache-control"]).not.toBe("no-store");
    expect(home.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(fallback.statusCode).toBe(200);
    expect(fallback.headers["content-type"]).toContain("text/html");
    expect(fallback.headers["cache-control"]).not.toBe("no-store");
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json().error.code).toBe("NOT_FOUND");
    expect(missingApi.headers["cache-control"]).toBe("no-store");
    await staticApp.close();
  });

  it("marks successful and failed API responses as no-store", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers: auth(ownerToken) });
    const unauthorized = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(health.statusCode).toBe(200);
    expect(bootstrap.statusCode).toBe(200);
    expect(unauthorized.statusCode).toBe(401);
    for (const response of [health, bootstrap, unauthorized]) {
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("normalizes Unicode phone whitespace before applying the login limit", async () => {
    const rateApp = buildApp({ database, loginRateLimitMax: 1, publicOrigin: PUBLIC_ORIGIN });
    await rateApp.ready();
    const first = await rateApp.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: "13800000000", password: "wrong-password" },
    });
    const whitespaceVariant = await rateApp.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: "\u300013800000000\u00a0", password: "wrong-password" },
    });
    expect(first.statusCode).toBe(401);
    expect(whitespaceVariant.statusCode).toBe(429);
    expect(whitespaceVariant.json().error.code).toBe("LOGIN_RATE_LIMITED");
    await rateApp.close();
  });

  it("trusts forwarded client IPs only from a loopback reverse proxy", async () => {
    const loopbackProxyApp = buildApp({ database, loginRateLimitMax: 1, publicOrigin: PUBLIC_ORIGIN });
    await loopbackProxyApp.ready();
    const throughLoopback = async (forwardedFor: string) => loopbackProxyApp.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": forwardedFor },
      payload: { phone: "13500000000", password: "wrong-password" },
    });
    const clientOne = await throughLoopback("198.51.100.1");
    const clientTwo = await throughLoopback("198.51.100.2");
    const clientOneAgain = await throughLoopback("198.51.100.1");
    expect([clientOne.statusCode, clientTwo.statusCode, clientOneAgain.statusCode]).toEqual([401, 401, 429]);
    await loopbackProxyApp.close();

    const directApp = buildApp({ database, loginRateLimitMax: 1, publicOrigin: PUBLIC_ORIGIN });
    await directApp.ready();
    const directRequest = async (forwardedFor: string) => directApp.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "203.0.113.10",
      headers: { "x-forwarded-for": forwardedFor },
      payload: { phone: "13400000000", password: "wrong-password" },
    });
    const forgedOne = await directRequest("198.51.100.10");
    const forgedTwo = await directRequest("198.51.100.11");
    expect([forgedOne.statusCode, forgedTwo.statusCode]).toEqual([401, 429]);
    await directApp.close();
  });

  it("sets Secure cookies in production and limits repeated login attempts", async () => {
    const productionApp = buildApp({
      database,
      isProduction: true,
      loginRateLimitMax: 2,
      publicOrigin: "https://123.56.254.236:666",
    });
    await productionApp.ready();
    const login = await productionApp.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: "13800000000", password: "demo1234" },
    });
    expect(login.headers["set-cookie"]).toContain("Secure");

    const attempts = [];
    for (let index = 0; index < 3; index += 1) {
      attempts.push(await productionApp.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { phone: "13699999999", password: "wrong-password" },
      }));
    }
    expect(attempts.map((response) => response.statusCode)).toEqual([401, 401, 429]);
    await productionApp.close();
  });

  it("rejects request bodies over the configured limit", async () => {
    const limitedApp = buildApp({ database, bodyLimitBytes: 256 });
    await limitedApp.ready();
    const response = await limitedApp.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ phone: "1".repeat(400), password: "demo1234" }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(response.headers["cache-control"]).toBe("no-store");
    await limitedApp.close();
  });

  it("changes the password, preserves the current session, and revokes every other session", async () => {
    const shortPassword = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: auth(ownerToken),
      payload: { currentPassword: "demo1234", newPassword: "too-short" },
    });
    expect(shortPassword.statusCode).toBe(400);

    const wrongCurrent = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: auth(ownerToken),
      payload: { currentPassword: "not-the-current-password", newPassword: "new-demo-password-2026" },
    });
    expect(wrongCurrent.statusCode).toBe(401);
    expect(wrongCurrent.json().error.code).toBe("INVALID_CURRENT_PASSWORD");

    queryTrace.length = 0;
    const changed = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: auth(ownerToken),
      payload: { currentPassword: "demo1234", newPassword: "new-demo-password-2026" },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().success).toBe(true);
    expect(changed.json().revokedSessions).toBeGreaterThanOrEqual(1);

    const lockedUserRead = queryTrace.findIndex((entry) =>
      entry.sql.includes("u.password_hash") && entry.sql.includes("FOR UPDATE OF u"));
    const passwordUpdate = queryTrace.findIndex((entry) => entry.sql.includes("UPDATE users SET password_hash"));
    const sessionRevocation = queryTrace.findIndex((entry) => entry.sql.includes("UPDATE sessions SET revoked_at"));
    expect(lockedUserRead).toBeGreaterThanOrEqual(0);
    expect(passwordUpdate).toBeGreaterThan(lockedUserRead);
    expect(sessionRevocation).toBeGreaterThan(passwordUpdate);
    expect(queryTrace[lockedUserRead]?.scope).toBe("transaction");
    expect(queryTrace[passwordUpdate]?.scope).toBe("transaction");
    expect(queryTrace[sessionRevocation]?.scope).toBe("transaction");
    expect(queryTrace.some((entry) => entry.scope === "outside" && entry.sql.includes("password_hash"))).toBe(false);

    const activeSessions = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions WHERE user_id = $1 AND revoked_at IS NULL",
      [DEMO_IDS.user],
    );
    expect(Number(activeSessions.rows[0]?.count)).toBe(1);
    const currentSession = await app.inject({ method: "GET", url: "/api/bootstrap", headers: auth(ownerToken) });
    expect(currentSession.statusCode).toBe(200);

    const oldPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: "13800000000", password: "demo1234" },
    });
    expect(oldPassword.statusCode).toBe(401);
    const newPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: "13800000000", password: "new-demo-password-2026" },
    });
    expect(newPassword.statusCode).toBe(200);

    const audit = await app.inject({ method: "GET", url: "/api/audit?limit=200", headers: auth(ownerToken) });
    expect(audit.json().audit.some((entry: { action: string }) => entry.action === "auth.password_changed")).toBe(true);
  });
});
