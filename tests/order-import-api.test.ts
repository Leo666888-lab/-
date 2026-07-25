import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPgliteDatabase, type Database } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { DEMO_IDS, seedDemo } from "../src/seed.js";

const PUBLIC_ORIGIN = "http://localhost";
const SECOND_TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_OWNER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FINANCE_USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SALES_USER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VIEWER_USER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TEST_PASSWORD = "import-test-password";

const CSV_HEADERS = [
  "往来单位",
  "订单号",
  "方向",
  "订货日期",
  "计划交货日期",
  "账期（月）",
  "币种",
  "商品名称",
  "数量",
  "单价",
].join(",");

interface Fixture {
  app: FastifyInstance;
  database: Database;
  tokens: {
    owner: string;
    finance: string;
    sales: string;
    viewer: string;
    secondOwner: string;
  };
}

function filePayload(rows: string[], fileName = "orders.csv") {
  return {
    fileName,
    contentBase64: Buffer.from([CSV_HEADERS, ...rows].join("\n"), "utf8").toString("base64"),
  };
}

function validRow(input: {
  partnerName?: string;
  orderNo: string;
  direction?: "应收" | "应付";
  orderDate?: string;
  plannedDeliveryDate?: string;
  settlementMonths?: number;
  currency?: string;
  itemDescription?: string;
  quantity?: number;
  unitPrice?: string;
}) {
  return [
    input.partnerName ?? "义乌测试客商",
    input.orderNo,
    input.direction ?? "应收",
    input.orderDate ?? "2026-07-25",
    input.plannedDeliveryDate ?? "2026-08-01",
    String(input.settlementMonths ?? 3),
    input.currency ?? "CNY",
    input.itemDescription ?? "测试商品",
    String(input.quantity ?? 2),
    input.unitPrice ?? "88.50",
  ].join(",");
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function login(app: FastifyInstance, phone: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { phone, password },
  });
  if (response.statusCode !== 200) throw new Error(`fixture login failed for ${phone}`);
  return response.json().token;
}

async function createFixture(): Promise<Fixture> {
  const database = await createPgliteDatabase(":memory:");
  await migrate(database);
  await seedDemo(database);
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
  await database.transaction(async (tx) => {
    await tx.query("INSERT INTO tenants (id, name) VALUES ($1, '第二家导入企业')", [SECOND_TENANT_ID]);
    await tx.query(
      "INSERT INTO users (id, phone, display_name, password_hash) VALUES ($1, '13900000001', '第二企业负责人', $2)",
      [SECOND_OWNER_ID, passwordHash],
    );
    await tx.query(
      "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')",
      [SECOND_TENANT_ID, SECOND_OWNER_ID],
    );
    await tx.query(
      "INSERT INTO users (id, phone, display_name, password_hash) VALUES ($1, '13900000002', '导入财务', $2)",
      [FINANCE_USER_ID, passwordHash],
    );
    await tx.query(
      "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'finance')",
      [DEMO_IDS.tenant, FINANCE_USER_ID],
    );
    await tx.query(
      "INSERT INTO users (id, phone, display_name, password_hash) VALUES ($1, '13900000003', '导入销售', $2)",
      [SALES_USER_ID, passwordHash],
    );
    await tx.query(
      "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'sales')",
      [DEMO_IDS.tenant, SALES_USER_ID],
    );
    await tx.query(
      "INSERT INTO users (id, phone, display_name, password_hash) VALUES ($1, '13900000004', '导入只读', $2)",
      [VIEWER_USER_ID, passwordHash],
    );
    await tx.query(
      "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'viewer')",
      [DEMO_IDS.tenant, VIEWER_USER_ID],
    );
  });
  const app = buildApp({ database, closeDatabase: true, publicOrigin: PUBLIC_ORIGIN });
  await app.ready();
  const [owner, finance, sales, viewer, secondOwner] = await Promise.all([
    login(app, "13800000000", "demo1234"),
    login(app, "13900000002", TEST_PASSWORD),
    login(app, "13900000003", TEST_PASSWORD),
    login(app, "13900000004", TEST_PASSWORD),
    login(app, "13900000001", TEST_PASSWORD),
  ]);
  return { app, database, tokens: { owner, finance, sales, viewer, secondOwner } };
}

async function commitImport(
  fixture: Fixture,
  payload: ReturnType<typeof filePayload> & { rowNumbers?: number[] },
  key: string,
  token = fixture.tokens.owner,
) {
  return fixture.app.inject({
    method: "POST",
    url: "/api/order-imports/commit",
    headers: { ...auth(token), "idempotency-key": key },
    payload,
  });
}

describe.sequential("order import API", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await fixture.app.close();
  });

  it("previews valid rows and returns row-level errors without writing business data", async () => {
    const before = await fixture.database.query<{ orders: string; partners: string; batches: string }>(
      `SELECT
         (SELECT COUNT(*) FROM orders WHERE tenant_id = $1)::text AS orders,
         (SELECT COUNT(*) FROM partners WHERE tenant_id = $1)::text AS partners,
         (SELECT COUNT(*) FROM order_import_batches WHERE tenant_id = $1)::text AS batches`,
      [DEMO_IDS.tenant],
    );
    const payload = filePayload([
      validRow({ orderNo: "PREVIEW-VALID-001", partnerName: "预览客户", unitPrice: "123.45" }),
      ",PREVIEW-BROKEN-001,未知,2026-02-30,2026-02-01,abc,INVALID,坏商品,0,10.001",
    ], "preview-errors.csv");
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/order-imports/preview",
      headers: auth(fixture.tokens.owner),
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().preview).toMatchObject({
      format: "csv",
      encoding: "utf-8",
      validRowCount: 1,
      invalidRowCount: 1,
      mapping: {
        partnerName: 1,
        orderNo: 2,
        direction: 3,
        orderDate: 4,
        itemDescription: 8,
        quantity: 9,
        unitPrice: 10,
      },
    });
    const rows = response.json().preview.rows;
    expect(rows[0]).toMatchObject({
      rowNumber: 2,
      valid: true,
      values: { orderNo: "PREVIEW-VALID-001", unitPriceCents: 12_345, lineTotalCents: 24_690 },
    });
    expect(rows[1].rowNumber).toBe(3);
    expect(rows[1].valid).toBe(false);
    expect(rows[1].errors.map((error: { code: string }) => error.code)).toEqual(expect.arrayContaining([
      "REQUIRED",
      "INVALID_DIRECTION",
      "INVALID_DATE",
      "INVALID_INTEGER",
      "INVALID_CURRENCY",
      "AMOUNT_PRECISION",
    ]));

    const after = await fixture.database.query<{ orders: string; partners: string; batches: string }>(
      `SELECT
         (SELECT COUNT(*) FROM orders WHERE tenant_id = $1)::text AS orders,
         (SELECT COUNT(*) FROM partners WHERE tenant_id = $1)::text AS partners,
         (SELECT COUNT(*) FROM order_import_batches WHERE tenant_id = $1)::text AS batches`,
      [DEMO_IDS.tenant],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("returns non-standard headers for manual mapping, then strictly previews the explicit mapping", async () => {
    const payload = {
      fileName: "merchant-format.csv",
      contentBase64: Buffer.from([
        "商家,流水,收付,日期,货物,件,价格",
        "义乌自定义客户,CUSTOM-MAPPED-001,应收,2026-07-25,餐椅,2,99.50",
      ].join("\n"), "utf8").toString("base64"),
    };
    const initial = await fixture.app.inject({
      method: "POST",
      url: "/api/order-imports/preview",
      headers: auth(fixture.tokens.owner),
      payload,
    });

    expect(initial.statusCode).toBe(200);
    expect(initial.json().preview).toMatchObject({
      headers: ["商家", "流水", "收付", "日期", "货物", "件", "价格"],
      mapping: {},
      suggestions: [],
      missingFields: ["partnerName", "orderNo", "orderDate", "itemDescription", "quantity", "unitPrice"],
      rows: [],
      validRowCount: 0,
      invalidRowCount: 0,
    });

    const mapped = await fixture.app.inject({
      method: "POST",
      url: "/api/order-imports/preview",
      headers: auth(fixture.tokens.owner),
      payload: {
        ...payload,
        mapping: {
          partnerName: 1,
          orderNo: 2,
          direction: 3,
          orderDate: 4,
          itemDescription: 5,
          quantity: 6,
          unitPrice: 7,
        },
      },
    });

    expect(mapped.statusCode).toBe(200);
    expect(mapped.json().preview).toMatchObject({
      mapping: {
        partnerName: 1,
        orderNo: 2,
        direction: 3,
        orderDate: 4,
        itemDescription: 5,
        quantity: 6,
        unitPrice: 7,
      },
      missingFields: [],
      validRowCount: 1,
      invalidRowCount: 0,
      rows: [expect.objectContaining({
        rowNumber: 2,
        valid: true,
        values: expect.objectContaining({
          partnerName: "义乌自定义客户",
          orderNo: "CUSTOM-MAPPED-001",
          lineTotalCents: 19_900,
        }),
      })],
    });
  });

  it("rejects commit when the effective mapping is incomplete", async () => {
    const payload = {
      fileName: "incomplete-mapping.csv",
      contentBase64: Buffer.from([
        "商家,流水,日期,货物,件,价格",
        "不能写入的客户,INCOMPLETE-001,2026-07-25,餐椅,2,99.50",
      ].join("\n"), "utf8").toString("base64"),
      mapping: { partnerName: 1, orderNo: 2 },
    };
    const response = await commitImport(fixture, payload, "incomplete-mapping-commit");

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: "MISSING_REQUIRED_COLUMNS",
      details: { fields: ["orderDate", "itemDescription", "quantity", "unitPrice"] },
    });
    const writes = await fixture.database.query<{ orders: string; batches: string }>(
      `SELECT
         (SELECT COUNT(*) FROM orders WHERE tenant_id = $1 AND order_no = 'INCOMPLETE-001')::text AS orders,
         (SELECT COUNT(*) FROM order_import_batches WHERE tenant_id = $1
          AND idempotency_key = 'incomplete-mapping-commit')::text AS batches`,
      [DEMO_IDS.tenant],
    );
    expect(writes.rows[0]).toEqual({ orders: "0", batches: "0" });
  });

  it("commits valid rows and creates a scoped partner, planned order, item, batch, and audit trail", async () => {
    const payload = filePayload([
      validRow({
        partnerName: "新导入供应商",
        orderNo: "IMPORT-COMMIT-001",
        direction: "应付",
        settlementMonths: 3,
        currency: "USD",
        itemDescription: "出口包装箱",
        quantity: 4,
        unitPrice: "25.50",
      }),
    ], "supplier-orders.csv");
    const response = await commitImport(fixture, payload, "import-success-001");

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      idempotentReplay: false,
      skippedInvalidCount: 0,
      batch: {
        fileName: "supplier-orders.csv",
        selectedRows: [2],
        importedCount: 1,
        orders: [expect.objectContaining({ orderNo: "IMPORT-COMMIT-001" })],
      },
    });
    const batchId = response.json().batch.id;
    const order = await fixture.database.query<{
      id: string;
      partner_name: string;
      partner_kind: string;
      direction: string;
      fulfillment_status: string;
      settlement_months: number;
      currency: string;
      total_cents: string;
      import_batch_id: string;
      description: string;
      quantity: number;
      unit_price_cents: string;
    }>(
      `SELECT o.id, p.name AS partner_name, p.kind AS partner_kind, o.direction,
              o.fulfillment_status, o.settlement_months, o.currency,
              o.total_cents::text, o.import_batch_id,
              item.description, item.quantity, item.unit_price_cents::text
       FROM orders o
       JOIN partners p ON p.tenant_id = o.tenant_id AND p.id = o.partner_id
       JOIN order_items item ON item.tenant_id = o.tenant_id AND item.order_id = o.id
       WHERE o.tenant_id = $1 AND o.order_no = 'IMPORT-COMMIT-001'`,
      [DEMO_IDS.tenant],
    );
    expect(order.rows[0]).toMatchObject({
      partner_name: "新导入供应商",
      partner_kind: "supplier",
      direction: "payable",
      fulfillment_status: "planned",
      settlement_months: 3,
      currency: "USD",
      total_cents: "10200",
      import_batch_id: batchId,
      description: "出口包装箱",
      quantity: 4,
      unit_price_cents: "2550",
    });
    const audit = await fixture.database.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_logs
       WHERE tenant_id = $1 AND (
         metadata->>'importBatchId' = $2 OR entity_id = $2::uuid
       ) ORDER BY created_at, id`,
      [DEMO_IDS.tenant, batchId],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      "partner.created",
      "order.imported",
      "import.completed",
    ]));
  });

  it("reports duplicate order numbers and refuses an explicitly selected invalid duplicate row", async () => {
    const payload = filePayload([
      validRow({ partnerName: "重复客户", orderNo: "IMPORT-DUPLICATE-001" }),
    ]);
    expect((await commitImport(fixture, payload, "duplicate-seed")).statusCode).toBe(201);

    const preview = await fixture.app.inject({
      method: "POST",
      url: "/api/order-imports/preview",
      headers: auth(fixture.tokens.owner),
      payload,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().preview).toMatchObject({ validRowCount: 0, invalidRowCount: 1 });
    expect(preview.json().preview.rows[0].errors).toContainEqual(expect.objectContaining({
      code: "ORDER_NO_ALREADY_EXISTS",
      field: "orderNo",
    }));

    const rejected = await commitImport(fixture, { ...payload, rowNumbers: [2] }, "duplicate-reject");
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe("INVALID_IMPORT_ROWS");
    expect(rejected.json().error.details.rows[0].errors).toContainEqual(expect.objectContaining({
      code: "ORDER_NO_ALREADY_EXISTS",
    }));

    const withinFile = filePayload([
      validRow({ partnerName: "同文件客户", orderNo: "IMPORT-DUP-IN-FILE" }),
      validRow({ partnerName: "同文件客户", orderNo: "IMPORT-DUP-IN-FILE" }),
    ]);
    const withinFilePreview = await fixture.app.inject({
      method: "POST",
      url: "/api/order-imports/preview",
      headers: auth(fixture.tokens.owner),
      payload: withinFile,
    });
    expect(withinFilePreview.statusCode).toBe(200);
    expect(withinFilePreview.json().preview.rows[1].errors).toContainEqual(expect.objectContaining({
      code: "DUPLICATE_ORDER_NO",
    }));

    const counts = await fixture.database.query<{ orders: string; batches: string }>(
      `SELECT
         (SELECT COUNT(*) FROM orders WHERE tenant_id = $1 AND order_no = 'IMPORT-DUPLICATE-001')::text AS orders,
         (SELECT COUNT(*) FROM order_import_batches WHERE tenant_id = $1)::text AS batches`,
      [DEMO_IDS.tenant],
    );
    expect(counts.rows[0]).toEqual({ orders: "1", batches: "1" });
  });

  it("replays an identical Idempotency-Key request and rejects key reuse for different content", async () => {
    const payload = filePayload([
      validRow({ partnerName: "幂等客户", orderNo: "IMPORT-IDEMPOTENT-001" }),
    ], "idempotent.csv");
    const first = await commitImport(fixture, payload, "same-import-key");
    expect(first.statusCode).toBe(201);
    const replay = await commitImport(fixture, payload, "same-import-key");
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      idempotentReplay: true,
      batch: { id: first.json().batch.id, importedCount: 1 },
    });

    const conflictPayload = filePayload([
      validRow({ partnerName: "幂等客户", orderNo: "IMPORT-IDEMPOTENT-CHANGED" }),
    ], "idempotent.csv");
    const conflict = await commitImport(fixture, conflictPayload, "same-import-key");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const counts = await fixture.database.query<{ orders: string; batches: string; audits: string }>(
      `SELECT
         (SELECT COUNT(*) FROM orders WHERE tenant_id = $1 AND import_batch_id = $2)::text AS orders,
         (SELECT COUNT(*) FROM order_import_batches WHERE tenant_id = $1 AND idempotency_key = 'same-import-key')::text AS batches,
         (SELECT COUNT(*) FROM audit_logs WHERE tenant_id = $1 AND action = 'import.completed' AND entity_id = $2)::text AS audits`,
      [DEMO_IDS.tenant, first.json().batch.id],
    );
    expect(counts.rows[0]).toEqual({ orders: "1", batches: "1", audits: "1" });
  });

  it("scopes order numbers, partners, batches, and idempotency keys to each tenant", async () => {
    const payload = filePayload([
      validRow({ partnerName: "同名跨企业客户", orderNo: "TENANT-IMPORT-SAME-001" }),
    ], "tenant-scope.csv");
    const firstTenant = await commitImport(fixture, payload, "tenant-shared-key", fixture.tokens.owner);
    const secondTenant = await commitImport(fixture, payload, "tenant-shared-key", fixture.tokens.secondOwner);
    expect(firstTenant.statusCode).toBe(201);
    expect(secondTenant.statusCode).toBe(201);
    expect(firstTenant.json().batch.id).not.toBe(secondTenant.json().batch.id);

    const records = await fixture.database.query<{
      tenant_id: string;
      batch_count: string;
      order_count: string;
      partner_count: string;
    }>(
      `SELECT tenant.id AS tenant_id,
              (SELECT COUNT(*) FROM order_import_batches batch
               WHERE batch.tenant_id = tenant.id AND batch.idempotency_key = 'tenant-shared-key')::text AS batch_count,
              (SELECT COUNT(*) FROM orders o
               WHERE o.tenant_id = tenant.id AND o.order_no = 'TENANT-IMPORT-SAME-001')::text AS order_count,
              (SELECT COUNT(*) FROM partners p
               WHERE p.tenant_id = tenant.id AND p.name = '同名跨企业客户')::text AS partner_count
       FROM tenants tenant WHERE tenant.id = ANY($1::uuid[]) ORDER BY tenant.id`,
      [[DEMO_IDS.tenant, SECOND_TENANT_ID]],
    );
    expect(records.rows).toHaveLength(2);
    expect(records.rows.every((row) => row.batch_count === "1"
      && row.order_count === "1" && row.partner_count === "1")).toBe(true);

    const firstOrders = await fixture.app.inject({
      method: "GET",
      url: "/api/orders",
      headers: auth(fixture.tokens.owner),
    });
    const secondOrders = await fixture.app.inject({
      method: "GET",
      url: "/api/orders",
      headers: auth(fixture.tokens.secondOwner),
    });
    expect(firstOrders.json().orders.filter((order: { orderNo: string }) => order.orderNo === "TENANT-IMPORT-SAME-001")).toHaveLength(1);
    expect(secondOrders.json().orders.filter((order: { orderNo: string }) => order.orderNo === "TENANT-IMPORT-SAME-001")).toHaveLength(1);
  });

  it("allows owner, finance, and sales while rejecting viewer and unauthenticated requests", async () => {
    const previewPayload = filePayload([
      validRow({ orderNo: "IMPORT-PERMISSION-PREVIEW" }),
    ]);
    const [ownerPreview, financePreview, salesPreview, viewerPreview, anonymousPreview] = await Promise.all([
      fixture.app.inject({ method: "POST", url: "/api/order-imports/preview", headers: auth(fixture.tokens.owner), payload: previewPayload }),
      fixture.app.inject({ method: "POST", url: "/api/order-imports/preview", headers: auth(fixture.tokens.finance), payload: previewPayload }),
      fixture.app.inject({ method: "POST", url: "/api/order-imports/preview", headers: auth(fixture.tokens.sales), payload: previewPayload }),
      fixture.app.inject({ method: "POST", url: "/api/order-imports/preview", headers: auth(fixture.tokens.viewer), payload: previewPayload }),
      fixture.app.inject({ method: "POST", url: "/api/order-imports/preview", payload: previewPayload }),
    ]);
    expect([ownerPreview.statusCode, financePreview.statusCode, salesPreview.statusCode]).toEqual([200, 200, 200]);
    expect(viewerPreview.statusCode).toBe(403);
    expect(anonymousPreview.statusCode).toBe(401);

    const financeCommit = await commitImport(fixture, filePayload([
      validRow({ partnerName: "财务导入客户", orderNo: "IMPORT-BY-FINANCE" }),
    ]), "finance-import", fixture.tokens.finance);
    const salesCommit = await commitImport(fixture, filePayload([
      validRow({ partnerName: "销售导入客户", orderNo: "IMPORT-BY-SALES" }),
    ]), "sales-import", fixture.tokens.sales);
    const viewerCommit = await commitImport(fixture, filePayload([
      validRow({ partnerName: "只读越权客户", orderNo: "IMPORT-BY-VIEWER" }),
    ]), "viewer-import", fixture.tokens.viewer);
    expect([financeCommit.statusCode, salesCommit.statusCode, viewerCommit.statusCode]).toEqual([201, 201, 403]);
    const viewerWrites = await fixture.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM orders
       WHERE tenant_id = $1 AND order_no = 'IMPORT-BY-VIEWER'`,
      [DEMO_IDS.tenant],
    );
    expect(viewerWrites.rows[0]?.count).toBe("0");
  });
});
