#!/usr/bin/env node

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

if (process.argv.length !== 2) {
  fail("restore database URLs must be provided through the environment only");
}

const parseDatabaseUrl = (value, label) => {
  if (!value) fail(`${label} is not set`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be a valid PostgreSQL URL`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    fail(`${label} must use the postgres or postgresql protocol`);
  }
  if ([...parsed.searchParams].length !== 0 || parsed.hash) {
    fail(`${label} must not contain connection options or fragments`);
  }
  let host;
  let username;
  let password;
  let database;
  try {
    host = decodeURIComponent(parsed.hostname).replace(/^\[|\]$/g, "");
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    fail(`${label} contains invalid percent encoding`);
  }
  if (!host || !username || !password || !database) {
    fail(`${label} must include a host, username, password, and database name`);
  }
  return {
    host,
    port: parsed.port || "5432",
    username,
    password,
    database,
  };
};

const target = parseDatabaseUrl(process.env.RESTORE_DATABASE_URL, "RESTORE_DATABASE_URL");
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
const isLocalSocket = target.host === "/run/postgresql" || target.host === "/var/run/postgresql";
if (!loopbackHosts.has(target.host) && !isLocalSocket) {
  fail("restore target must use loopback networking or the local PostgreSQL socket");
}
if (!/^siyan_settlement_666_restore_drill_[a-z0-9_]+$/.test(target.database)) {
  fail("restore database name must start with siyan_settlement_666_restore_drill_");
}
if (!/^siyan_restore_[a-z0-9_]+$/.test(target.username)) {
  fail("restore database user must start with siyan_restore_");
}

if (process.env.PRODUCTION_DATABASE_URL) {
  const production = parseDatabaseUrl(process.env.PRODUCTION_DATABASE_URL, "PRODUCTION_DATABASE_URL");
  const targetLocation = `${target.host}:${target.port}/${target.database}`;
  const productionLocation = `${production.host}:${production.port}/${production.database}`;
  if (targetLocation === productionLocation) {
    fail("restore target must not match the production database");
  }
  if (target.username === production.username) {
    fail("restore and production database users must be different");
  }
}
