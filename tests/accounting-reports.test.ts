import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  it("rejects malformed periods before querying", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/accounting/trial-balance?period=2026-13",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_ACCOUNTING_PERIOD");
  });

  it("does not expose another tenant's rows", async () => {
    const otherTenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await database.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [otherTenant, "隔离企业"]);
    const response = await app.inject({
      method: "GET",
      url: "/api/accounting/trial-balance?period=2026-07",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().accounts.every((account: { id: string }) => account.id !== otherTenant)).toBe(true);
    expect(DEMO_IDS.tenant).not.toBe(otherTenant);
  });
});
