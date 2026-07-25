#!/usr/bin/env node

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

if (process.argv.length !== 2) {
  fail("database URLs must be provided through the environment only");
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
  if (!username || !password || !host || !database) {
    fail(`${label} must include a host, username, password, and database name`);
  }
  return {
    host,
    port: parsed.port || "5432",
    database,
    username,
    password,
  };
};

const app = parseDatabaseUrl(process.env.APP_DATABASE_URL, "APP_DATABASE_URL");
const backup = parseDatabaseUrl(process.env.BACKUP_DATABASE_URL, "BACKUP_DATABASE_URL");

if (app.username === backup.username) {
  fail("application and backup database users must be different");
}
if (app.password === backup.password) {
  fail("application and backup database passwords must be different");
}
if (app.host !== backup.host || app.port !== backup.port || app.database !== backup.database) {
  fail("application and backup users must target the same database");
}
