import pg from "pg";
import { describe, expect, it } from "vitest";
import { createDatabase, isPostgresConnectionString } from "../src/db/index.js";

describe("database production guards", () => {
  it("keeps PostgreSQL DATE values as calendar strings", () => {
    const parseDate = pg.types.getTypeParser(1082, "text");
    expect(parseDate("2026-07-25")).toBe("2026-07-25");
  });

  it("recognizes both supported PostgreSQL URL schemes", () => {
    expect(isPostgresConnectionString("postgres://localhost/db")).toBe(true);
    expect(isPostgresConnectionString("postgresql://localhost/db")).toBe(true);
    expect(isPostgresConnectionString("pglite://local/db")).toBe(false);
  });

  it("refuses PGlite or a missing URL in production", async () => {
    await expect(createDatabase({ isProduction: true })).rejects.toThrow(/Production database/);
    await expect(createDatabase({ isProduction: true, databaseUrl: "pglite://local/db" })).rejects.toThrow(/Production database/);
  });

  it("requires one explicit PostgreSQL SSL mode in production", async () => {
    await expect(createDatabase({
      isProduction: true,
      databaseUrl: "postgresql://worker:test@database.test/settlement",
    })).rejects.toThrow(/exactly one sslmode=require, verify-ca, or verify-full/);
  });
});
