import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPgliteDatabase, type Database } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { DEMO_IDS, seedDemo } from "../src/seed.js";

describe.sequential("automatic accounting books", () => {
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
      method: "POST", url: "/api/auth/login",
      payload: { phone: "13800000000", password: "demo1234" },
    });
    ownerToken = login.json().token;
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("seeds an auditable fulfillment and payment journal", async () => {
    const response = await app.inject({
      method: "GET", url: "/api/accounting/journals?limit=20",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(response.statusCode).toBe(200);
    const journals = response.json().journals;
    expect(journals).toHaveLength(2);
    expect(journals.every((journal: any) => journal.lines.length === 2)).toBe(true);
    expect(journals.map((journal: any) => journal.sourceType)).toEqual(expect.arrayContaining([
      "order.fulfillment", "payment",
    ]));
    for (const journal of journals) {
      const debit = journal.lines.reduce((sum: number, line: any) => sum + Number(line.debitCents), 0);
      const credit = journal.lines.reduce((sum: number, line: any) => sum + Number(line.creditCents), 0);
      expect(debit).toBeGreaterThan(0);
      expect(debit).toBe(credit);
    }
  });

  it("exposes tenant-scoped ledger and bank journal rows", async () => {
    const headers = { authorization: `Bearer ${ownerToken}` };
    const [ledger, bank] = await Promise.all([
      app.inject({ method: "GET", url: "/api/accounting/ledger?accountCode=1122", headers }),
      app.inject({ method: "GET", url: "/api/accounting/bank-journal", headers }),
    ]);
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json().ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountCode: "1122", debitCents: 1280000 }),
      expect.objectContaining({ accountCode: "1122", creditCents: 300000 }),
    ]));
    expect(bank.statusCode).toBe(200);
    expect(bank.json().bankJournal).toEqual(expect.arrayContaining([
      expect.objectContaining({ debitCents: 300000, bankAccountName: "默认银行账户" }),
    ]));
  });

  it("keeps the default account template tenant-scoped", async () => {
    const accounts = await database.query<{ code: string; tenant_id: string }>(
      "SELECT code, tenant_id FROM accounting_accounts WHERE tenant_id = $1 ORDER BY code",
      [DEMO_IDS.tenant],
    );
    expect(accounts.rows.map((row) => row.code)).toEqual(expect.arrayContaining(["1002", "1122", "2202", "5001"]));
    expect(accounts.rows.every((row) => row.tenant_id === DEMO_IDS.tenant)).toBe(true);
  });
});
