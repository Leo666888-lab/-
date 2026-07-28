import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postPaymentJournal, postPaymentReversalJournal } from "../src/accounting.js";
import { buildApp } from "../src/app.js";
import { createPgliteDatabase, type Database } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { DEMO_IDS, seedDemo } from "../src/seed.js";

describe.sequential("accounting result reports", () => {
  let database: Database;
  let app: ReturnType<typeof buildApp>;
  let ownerToken = "";

  beforeAll(async () => {
    database = await createPgliteDatabase(":memory:");
    await migrate(database);
    await seedDemo(database);
    app = buildApp({ database, publicOrigin: "http://127.0.0.1:666" });
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: "13800000000", password: "demo1234" },
    });
    ownerToken = login.json().token;
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("returns a balanced tenant-scoped trial balance", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/accounting/trial-balance?period=2026-07",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(response.statusCode).toBe(200);
    const report = response.json();
    expect(report.period).toBe("2026-07");
    expect(report.balanced).toBe(true);
    expect(report.totals.differenceCents).toBe(0);
    expect(report.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "1122", endingBalanceCents: 980000 }),
      expect.objectContaining({ code: "5001", endingBalanceCents: 1280000 }),
    ]));
  });

  it("returns income, balance-sheet, and aging results", async () => {
    const headers = { authorization: `Bearer ${ownerToken}` };
    const [income, balance, aging] = await Promise.all([
      app.inject({ method: "GET", url: "/api/accounting/income-statement?period=2026-07", headers }),
      app.inject({ method: "GET", url: "/api/accounting/balance-sheet?period=2026-07", headers }),
      app.inject({ method: "GET", url: "/api/accounting/aging?period=2026-07", headers }),
    ]);
    expect(income.statusCode).toBe(200);
    expect(income.json().totals).toEqual(expect.objectContaining({
      revenueCents: 1280000,
      costCents: 0,
      expenseCents: 0,
      profitCents: 1280000,
    }));
    expect(balance.statusCode).toBe(200);
    expect(balance.json().balanced).toBe(true);
    expect(balance.json().totals).toEqual(expect.objectContaining({
      assetCents: 1280000,
      liabilitiesAndEquityCents: 1280000,
      differenceCents: 0,
    }));
    expect(aging.statusCode).toBe(200);
    expect(aging.json().totalCents).toBe(980000);
    expect(aging.json().buckets["0_30"]).toBe(980000);
    expect(aging.json().orders).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orderNo: "SY-20260724-001",
        direction: "receivable",
        outstandingCents: 980000,
      }),
    ]));
  });

  it("returns a reconciled direct cash flow statement from posted bank journals", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/accounting/cash-flow-statement?period=2026-07",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(response.statusCode).toBe(200);
    const report = response.json();
    expect(report).toEqual(expect.objectContaining({
      period: "2026-07",
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      reconciled: true,
    }));
    expect(report.currencies).toEqual([
      expect.objectContaining({
        currency: "CNY",
        operating: { inflowCents: 300000, outflowCents: 0, netCents: 300000 },
        unclassified: { inflowCents: 0, outflowCents: 0, netCents: 0 },
        cash: { openingBalanceCents: 0, endingBalanceCents: 300000, differenceCents: 300000 },
        reconciliationDifferenceCents: 0,
        reconciled: true,
      }),
    ]);
  });

  it("treats posted payment reversals as the opposite operating cash flow", async () => {
    await database.transaction(async (tx) => {
      await postPaymentReversalJournal(tx, {
        tenantId: DEMO_IDS.tenant,
        reversalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        paymentId: DEMO_IDS.payment,
        direction: "receivable",
        amountCents: 300000,
        postedAt: "2026-07-20T03:00:00Z",
        createdBy: DEMO_IDS.user,
        currency: "CNY",
      });
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/accounting/cash-flow-statement?period=2026-07",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().currencies[0]).toEqual(expect.objectContaining({
      operating: { inflowCents: 300000, outflowCents: 300000, netCents: 0 },
      cash: { openingBalanceCents: 0, endingBalanceCents: 0, differenceCents: 0 },
      reconciliationDifferenceCents: 0,
      reconciled: true,
    }));
  });

  it("rejects malformed periods before querying", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/accounting/trial-balance?period=2026-13",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_ACCOUNTING_PERIOD");

    const cashFlow = await app.inject({
      method: "GET",
      url: "/api/accounting/cash-flow-statement?period=2026-13",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(cashFlow.statusCode).toBe(400);
    expect(cashFlow.json().error.code).toBe("INVALID_ACCOUNTING_PERIOD");
  });

  it("does not expose another tenant's rows", async () => {
    const otherTenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await database.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [otherTenant, "隔离企业"]);
    await database.query(
      "UPDATE bank_accounts SET opening_balance_cents = 99000000 WHERE tenant_id = $1",
      [otherTenant],
    );
    await database.transaction(async (tx) => {
      await postPaymentJournal(tx, {
        tenantId: otherTenant,
        paymentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
        direction: "receivable",
        amountCents: 88000000,
        postedAt: "2026-07-21T03:00:00Z",
        createdBy: DEMO_IDS.user,
        currency: "CNY",
      });
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/accounting/trial-balance?period=2026-07",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().accounts.every((account: { id: string }) => account.id !== otherTenant)).toBe(true);
    expect(DEMO_IDS.tenant).not.toBe(otherTenant);

    const cashFlow = await app.inject({
      method: "GET",
      url: "/api/accounting/cash-flow-statement?period=2026-07",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(cashFlow.statusCode).toBe(200);
    expect(cashFlow.json().currencies[0].cash.endingBalanceCents).toBe(0);
  });

  it("rejects cash totals outside JavaScript's safe integer range", async () => {
    await database.query(
      "UPDATE bank_accounts SET opening_balance_cents = 9007199254740992 WHERE tenant_id = $1",
      [DEMO_IDS.tenant],
    );
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/accounting/cash-flow-statement?period=2026-07",
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe("UNSAFE_MONEY_VALUE");
    } finally {
      await database.query(
        "UPDATE bank_accounts SET opening_balance_cents = 0 WHERE tenant_id = $1",
        [DEMO_IDS.tenant],
      );
    }
  });

  it("blocks period close while document, approval, and cost prerequisites are unavailable", async () => {
    const period = await database.query<{ id: string }>(
      "SELECT id FROM accounting_periods WHERE tenant_id = $1 AND period_start = '2026-07-01'::date",
      [DEMO_IDS.tenant],
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/accounting/periods/${period.rows[0]?.id}/close`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toEqual(expect.objectContaining({
      code: "ACCOUNTING_PERIOD_PREREQUISITES_INCOMPLETE",
      details: expect.objectContaining({ period: "2026-07", affectedJournals: 1 }),
    }));
  });

  it("keeps foreign journals in their source currency and blocks unsafe base-currency reports", async () => {
    const beforeBootstrap = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(beforeBootstrap.statusCode).toBe(200);
    const beforeAccounts = beforeBootstrap.json().accounting.accounts;

    const created = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        partnerId: DEMO_IDS.customer,
        orderNo: "SY-USD-CURRENCY-SAFETY-001",
        direction: "receivable",
        orderDate: "2026-07-01",
        settlementDays: 0,
        settlementMonths: 0,
        currency: "USD",
        items: [{ description: "Foreign currency test", quantity: 1, unitPriceCents: 1000 }],
      },
    });
    expect(created.statusCode).toBe(201);
    const orderId = created.json().order.id;
    const fulfilled = await app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/fulfill`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { fulfilledAt: "2026-07-25T03:00:00Z" },
    });
    expect(fulfilled.statusCode).toBe(200);

    const journal = await database.query<{ currency: string }>(
      `SELECT currency FROM journal_entries
       WHERE tenant_id = $1 AND source_type = 'order.fulfillment' AND source_id = $2`,
      [DEMO_IDS.tenant, orderId],
    );
    expect(journal.rows).toEqual([{ currency: "USD" }]);

    const afterBootstrap = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(afterBootstrap.statusCode).toBe(200);
    expect(afterBootstrap.json().accounting.accounts).toEqual(beforeAccounts);

    for (const url of [
      "/api/accounting/trial-balance?period=2026-07",
      "/api/accounting/income-statement?period=2026-07",
      "/api/accounting/balance-sheet?period=2026-07",
      "/api/accounting/aging?period=2026-07",
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("FOREIGN_CURRENCY_REPORT_UNAVAILABLE");
      expect(response.json().error.details.currencyUnsafe).toBe(true);
    }

    const period = await database.query<{ id: string }>(
      "SELECT id FROM accounting_periods WHERE tenant_id = $1 AND period_start = '2026-07-01'::date",
      [DEMO_IDS.tenant],
    );
    const close = await app.inject({
      method: "POST",
      url: `/api/accounting/periods/${period.rows[0]?.id}/close`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(close.statusCode).toBe(409);
    expect(close.json().error.code).toBe("FOREIGN_CURRENCY_REPORT_UNAVAILABLE");

    const payment = await app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/payments`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "idempotency-key": "currency-safety-payment-001",
      },
      payload: { amountCents: 1000, method: "bank_transfer" },
    });
    expect(payment.statusCode).toBe(409);
    expect(payment.json().error.code).toBe("BANK_ACCOUNT_CURRENCY_UNAVAILABLE");

    await database.query(
      `INSERT INTO bank_accounts (
         id, tenant_id, account_id, name, account_type, currency, opening_balance_cents, is_default
       )
       SELECT 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', $1, id,
              'USD test account', 'bank', 'USD', 0, false
         FROM accounting_accounts
        WHERE tenant_id = $1 AND code = '1002'`,
      [DEMO_IDS.tenant],
    );
    const paid = await app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/payments`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "idempotency-key": "currency-safety-payment-002",
      },
      payload: { amountCents: 1000, method: "bank_transfer" },
    });
    expect(paid.statusCode).toBe(201);

    const cashFlow = await app.inject({
      method: "GET",
      url: "/api/accounting/cash-flow-statement?period=2026-07",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(cashFlow.statusCode).toBe(200);
    expect(cashFlow.json().currencies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        currency: "USD",
        operating: { inflowCents: 1000, outflowCents: 0, netCents: 1000 },
      }),
    ]));
  });
});
