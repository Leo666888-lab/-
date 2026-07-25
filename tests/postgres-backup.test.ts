import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const parserPath = fileURLToPath(
  new URL("../deploy/scripts/parse-postgres-database-url.mjs", import.meta.url),
);
const backupScriptPath = fileURLToPath(
  new URL("../deploy/scripts/siyan-settlement-666-postgres-backup.sh", import.meta.url),
);
const ciWorkflowPath = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));

const runParser = (databaseUrl: string, args: string[] = []) => spawnSync(
  process.execPath,
  [parserPath, ...args],
  {
    env: { DATABASE_URL: databaseUrl },
    encoding: "buffer",
  },
);

const parseNulPairs = (output: Buffer) => {
  const fields = output.toString("utf8").split("\0");
  expect(fields.pop()).toBe("");
  expect(fields.length % 2).toBe(0);
  return Object.fromEntries(
    Array.from({ length: fields.length / 2 }, (_, index) => [
      fields[index * 2],
      fields[index * 2 + 1],
    ]),
  );
};

describe("PostgreSQL backup connection parsing", () => {
  it("emits decoded libpq variables as NUL-delimited key/value pairs", () => {
    const result = runParser(
      "postgresql://backup%2Buser:p%40ss%3Aword@db.example.test:6432/settlement%20prod",
    );

    expect(result.status).toBe(0);
    expect(result.stderr.toString("utf8")).toBe("");
    expect(parseNulPairs(result.stdout)).toEqual({
      PGHOST: "db.example.test",
      PGPORT: "6432",
      PGUSER: "backup+user",
      PGPASSWORD: "p@ss:word",
      PGDATABASE: "settlement prod",
    });
  });

  it("uses the default PostgreSQL port and removes IPv6 URL brackets", () => {
    const result = runParser("postgres://backup:secret@[2001:db8::8]/settlement");

    expect(result.status).toBe(0);
    expect(parseNulPairs(result.stdout)).toEqual({
      PGHOST: "2001:db8::8",
      PGPORT: "5432",
      PGUSER: "backup",
      PGPASSWORD: "secret",
      PGDATABASE: "settlement",
    });
  });

  it("preserves supported SSL and libpq connection options", () => {
    const result = runParser(
      "postgresql://backup:secret@db.example.test/settlement?sslmode=verify-full&sslrootcert=%2Fetc%2Fpostgresql%2Froot.crt&connect_timeout=15&channel_binding=require",
    );

    expect(result.status).toBe(0);
    expect(parseNulPairs(result.stdout)).toMatchObject({
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "/etc/postgresql/root.crt",
      PGCONNECT_TIMEOUT: "15",
      PGCHANNELBINDING: "require",
    });
  });

  it("decodes Unix socket hosts and keeps simple multi-host lists", () => {
    const socket = runParser("postgresql://backup:secret@%2Fvar%2Frun%2Fpostgresql/settlement");
    const multiHost = runParser("postgresql://backup:secret@db-a.example.test,db-b.example.test/settlement");

    expect(socket.status).toBe(0);
    expect(parseNulPairs(socket.stdout).PGHOST).toBe("/var/run/postgresql");
    expect(multiHost.status).toBe(0);
    expect(parseNulPairs(multiHost.stdout).PGHOST).toBe("db-a.example.test,db-b.example.test");
  });

  it("rejects unsupported, duplicate, and invalid connection options", () => {
    const unsupported = runParser("postgresql://backup:secret@db.example.test/settlement?unknown=value");
    const duplicate = runParser("postgresql://backup:secret@db.example.test/settlement?sslmode=require&ssl=true");
    const invalid = runParser("postgresql://backup:secret@db.example.test/settlement?sslmode=unsafe");

    expect(unsupported.status).not.toBe(0);
    expect(duplicate.status).not.toBe(0);
    expect(invalid.status).not.toBe(0);
  });

  it("rejects invalid input without echoing credentials", () => {
    const secret = "never-print-this-secret";
    const malformed = runParser(`postgresql://backup:${secret}@`);
    const argument = runParser(
      `postgresql://backup:${secret}@db.example.test/settlement`,
      [secret],
    );

    expect(malformed.status).not.toBe(0);
    expect(argument.status).not.toBe(0);
    expect(malformed.stderr.toString("utf8")).not.toContain(secret);
    expect(argument.stderr.toString("utf8")).not.toContain(secret);
    expect(malformed.stdout).toHaveLength(0);
    expect(argument.stdout).toHaveLength(0);
  });

  it("keeps DATABASE_URL out of pg_dump arguments and uses isolated Node", () => {
    const script = readFileSync(backupScriptPath, "utf8");
    const unsetIndex = script.indexOf("unset DATABASE_URL");
    const dumpIndex = script.indexOf("pg_dump --format=custom");

    expect(script).toContain(
      'readonly NODE_BIN="/opt/siyan-settlement-666/runtime/node/bin/node"',
    );
    expect(script).toContain(
      '"${NODE_BIN}" "${DATABASE_URL_PARSER}" > "${connection_env_path}"',
    );
    expect(script).not.toContain('PGDATABASE="${DATABASE_URL}"');
    expect(unsetIndex).toBeGreaterThan(-1);
    expect(unsetIndex).toBeLessThan(dumpIndex);
    expect(script.slice(dumpIndex)).not.toContain("DATABASE_URL");
  });

  it("installs deployment helpers beside the backup script for the isolated backup user", () => {
    const workflow = readFileSync(ciWorkflowPath, "utf8");
    const parserInstallIndex = workflow.indexOf(
      "sudo install -m 0644 deploy/scripts/*.mjs",
    );
    const realBackupIndex = workflow.indexOf(
      "/opt/siyan-settlement-666/current/deploy/scripts/siyan-settlement-666-postgres-backup.sh",
      parserInstallIndex + 1,
    );

    expect(parserInstallIndex).toBeGreaterThan(-1);
    expect(realBackupIndex).toBeGreaterThan(parserInstallIndex);
    expect(workflow).toContain("sudo -u siyan-settlement-666-backup /usr/bin/env");
  });
});
