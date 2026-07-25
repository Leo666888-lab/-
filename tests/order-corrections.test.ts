import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPgliteDatabase, type Database } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { DEMO_IDS, seedDemo } from "../src/seed.js";

const SALES_USER_ID = "a1000000-0000-4000-8000-000000000001";

describe("controlled order corrections", () => {
  let database: Database;
  let app: ReturnType<typeof buildApp>;
  let ownerToken = "";
  let salesToken = "";
  let order: Record<string, any>;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const correctionPayload = (current: Record<string, any>, overrides: Record<string, unknown> = {}) => ({
    version: current.version,
    reason: "录单后与纸质原单复核",
    partnerId: current.partnerId,
    orderNo: current.orderNo,
    direction: current.direction,
    orderDate: current.orderDate,
    plannedDeliveryDate: current.plannedDeliveryDate,
    fulfilledAt: current.fulfilledAt,
    settlementDays: current.settlementDays,
    settlementMonths: current.settlementMonths,
    currency: current.currency,
    notes: current.notes,
    items: current.items.map((item: Record<string, unknown>) => ({
      description: item.description,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
    })),
    ...overrides,
  });

  beforeAll(async () => {
    database = await createPgliteDatabase(":memory:");
    await migrate(database);
    await seedDemo(database);
    const passwordHash = await bcrypt.hash("demo1234", 4);
    await database.query(
      "INSERT INTO users (id, phone, display_name, password_hash) VALUES ($1, '13600000999', '更正测试业务员', $2)",
      [SALES_USER_ID, passwordHash],
    );
    await database.query(
      "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'sales')",
      [DEMO_IDS.tenant, SALES_USER_ID],
    );
    app = buildApp({ database, publicOrigin: "http://127.0.0.1:666" });
    await app.ready();

    const [ownerLogin, salesLogin] = await Promise.all([
      app.inject({ method: "POST", url: "/api/auth/login", payload: { phone: "13800000000", password: "demo1234" } }),
      app.inject({ method: "POST", url: "/api/auth/login", payload: { phone: "13600000999", password: "demo1234" } }),
    ]);
    ownerToken = ownerLogin.json().token;
    salesToken = salesLogin.json().token;
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("records immutable before/after history and rejects stale versions", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: auth(ownerToken),
      payload: {
        partnerId: DEMO_IDS.customer,
        orderNo: "CORRECTION-001",
        direction: "receivable",
        orderDate: "2026-07-20",
        plannedDeliveryDate: "2026-07-24",
        settlementDays: 7,
        settlementMonths: 0,
        currency: "CNY",
        notes: "初始记录",
        items: [{ description: "袜子", quantity: 10, unitPriceCents: 1000 }],
      },
    });
    expect(created.statusCode).toBe(201);
    order = created.json().order;
    expect(order.version).toBe(1);

    const corrected = await app.inject({
      method: "PATCH",
      url: `/api/orders/${order.id}`,
      headers: auth(ownerToken),
      payload: correctionPayload(order, {
        reason: "数量由 10 箱更正为 12 箱",
        notes: "已与纸单复核",
        items: [{ description: "袜子", quantity: 12, unitPriceCents: 1000 }],
      }),
    });
    expect(corrected.statusCode).toBe(200);
    order = corrected.json().order;
    expect(order.version).toBe(2);
    expect(order.totalCents).toBe(12_000);
    expect(order.corrections).toHaveLength(1);
    expect(order.corrections[0]).toMatchObject({
      reason: "数量由 10 箱更正为 12 箱",
      fromVersion: 1,
      toVersion: 2,
    });
    expect(order.corrections[0].changedFields).toEqual(expect.arrayContaining(["totalCents", "notes", "items"]));

    const unchanged = await app.inject({
      method: "PATCH",
      url: `/api/orders/${order.id}`,
      headers: auth(ownerToken),
      payload: correctionPayload(order),
    });
    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.json().idempotentReplay).toBe(true);
    expect(unchanged.json().order.corrections).toHaveLength(1);

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/orders/${order.id}`,
      headers: auth(ownerToken),
      payload: { ...correctionPayload(order), version: 1, notes: "过期页面覆盖" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("ORDER_VERSION_CONFLICT");

    const correctionId = order.corrections[0].id;
    await expect(database.query(
      "UPDATE order_corrections SET reason = 'tampered' WHERE id = $1",
      [correctionId],
    )).rejects.toThrow(/append-only/);
    await expect(database.query("DELETE FROM order_corrections WHERE id = $1", [correctionId])).rejects.toThrow(/append-only/);
  });

  it("protects paid identity and amount while allowing finance-grade fulfilled corrections", async () => {
    const fulfilled = await app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/fulfill`,
      headers: auth(ownerToken),
      payload: { fulfilledAt: new Date().toISOString() },
    });
    expect(fulfilled.statusCode).toBe(200);
    order = fulfilled.json().order;

    const payment = await app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/payments`,
      headers: { ...auth(ownerToken), "idempotency-key": "correction-partial-payment" },
      payload: { amountCents: 5_000, method: "bank_transfer" },
    });
    expect(payment.statusCode).toBe(201);
    order = payment.json().order;

    const salesAttempt = await app.inject({
      method: "PATCH",
      url: `/api/orders/${order.id}`,
      headers: auth(salesToken),
      payload: correctionPayload(order, { notes: "业务员不能改已交货订单" }),
    });
    expect(salesAttempt.statusCode).toBe(403);
    expect(salesAttempt.json().error.code).toBe("FULFILLED_ORDER_CORRECTION_FORBIDDEN");

    const currencyAttempt = await app.inject({
      method: "PATCH",
      url: `/api/orders/${order.id}`,
      headers: auth(ownerToken),
      payload: correctionPayload(order, { currency: "USD" }),
    });
    expect(currencyAttempt.statusCode).toBe(409);
    expect(currencyAttempt.json().error.code).toBe("SETTLED_IDENTITY_LOCKED");

    const belowPaid = await app.inject({
      method: "PATCH",
      url: `/api/orders/${order.id}`,
      headers: auth(ownerToken),
      payload: correctionPayload(order, {
        items: [{ description: "袜子", quantity: 4, unitPriceCents: 1000 }],
      }),
    });
    expect(belowPaid.statusCode).toBe(409);
    expect(belowPaid.json().error.code).toBe("TOTAL_BELOW_PAID");

    const corrected = await app.inject({
      method: "PATCH",
      url: `/api/orders/${order.id}`,
      headers: auth(ownerToken),
      payload: correctionPayload(order, {
        reason: "补录漏掉的三箱并调整为 30 天账期",
        settlementDays: 30,
        items: [{ description: "袜子", quantity: 15, unitPriceCents: 1000 }],
      }),
    });
    expect(corrected.statusCode).toBe(200);
    order = corrected.json().order;
    expect(order.totalCents).toBe(15_000);
    expect(order.paidCents).toBe(5_000);
    expect(order.outstandingCents).toBe(10_000);
    expect(order.corrections).toHaveLength(2);

    const reminder = await database.query<{ due_at: Date | string }>(
      "SELECT due_at FROM reminders WHERE tenant_id = $1 AND order_id = $2 AND status <> 'closed'",
      [DEMO_IDS.tenant, order.id],
    );
    expect(reminder.rowCount).toBe(1);
    expect(new Date(reminder.rows[0]!.due_at).toISOString()).toBe(order.dueAt);
  });

  it("reopens a settled reminder when a correction increases the total and closes it at equality", async () => {
    const settlement = await app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/payments`,
      headers: { ...auth(ownerToken), "idempotency-key": "correction-final-payment" },
      payload: { amountCents: 10_000, method: "bank_transfer" },
    });
    expect(settlement.statusCode).toBe(201);
    order = settlement.json().order;
    expect(order.outstandingCents).toBe(0);

    const increased = await app.inject({
      method: "PATCH",
      url: `/api/orders/${order.id}`,
      headers: auth(ownerToken),
      payload: correctionPayload(order, {
        reason: "发现漏记五箱",
        items: [{ description: "袜子", quantity: 20, unitPriceCents: 1000 }],
      }),
    });
    expect(increased.statusCode).toBe(200);
    order = increased.json().order;
    expect(order.outstandingCents).toBe(5_000);
    const reopened = await database.query(
      "SELECT id FROM reminders WHERE tenant_id = $1 AND order_id = $2 AND status = 'open'",
      [DEMO_IDS.tenant, order.id],
    );
    expect(reopened.rowCount).toBe(1);

    const reducedToPaid = await app.inject({
      method: "PATCH",
      url: `/api/orders/${order.id}`,
      headers: auth(ownerToken),
      payload: correctionPayload(order, {
        reason: "确认实际数量为十五箱",
        items: [{ description: "袜子", quantity: 15, unitPriceCents: 1000 }],
      }),
    });
    expect(reducedToPaid.statusCode).toBe(200);
    order = reducedToPaid.json().order;
    expect(order.outstandingCents).toBe(0);
    const stillOpen = await database.query(
      "SELECT id FROM reminders WHERE tenant_id = $1 AND order_id = $2 AND status <> 'closed'",
      [DEMO_IDS.tenant, order.id],
    );
    expect(stillOpen.rowCount).toBe(0);

    const audit = await app.inject({ method: "GET", url: "/api/audit?limit=200", headers: auth(ownerToken) });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().audit.filter((entry: { action: string; entityId: string }) =>
      entry.action === "order.corrected" && entry.entityId === order.id)).toHaveLength(4);
  });
});
