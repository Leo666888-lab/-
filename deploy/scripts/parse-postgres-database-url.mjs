#!/usr/bin/env node

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

if (process.argv.length !== 2) {
  fail("DATABASE_URL must be provided through the environment only");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  fail("DATABASE_URL is not set");
}

let parsedUrl;
try {
  parsedUrl = new URL(databaseUrl);
} catch {
  fail("DATABASE_URL must be a valid PostgreSQL connection URL");
}

if (parsedUrl.protocol !== "postgres:" && parsedUrl.protocol !== "postgresql:") {
  fail("DATABASE_URL must use the postgres or postgresql protocol");
}
if (parsedUrl.hash) {
  fail("DATABASE_URL fragments are not supported by the backup service");
}

const decodeComponent = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    fail("DATABASE_URL contains invalid percent encoding");
  }
};

const decodedHostname = decodeComponent(parsedUrl.hostname);
const hostname = decodedHostname.startsWith("[") && decodedHostname.endsWith("]")
  ? decodedHostname.slice(1, -1)
  : decodedHostname;
const port = parsedUrl.port || "5432";
const username = decodeComponent(parsedUrl.username);
const password = decodeComponent(parsedUrl.password);
const database = decodeComponent(parsedUrl.pathname.slice(1));

if (!hostname || !username || !password || !database) {
  fail("DATABASE_URL must include a host, username, password, and database name");
}
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  fail("DATABASE_URL contains an invalid port");
}

const connectionVariables = [
  ["PGHOST", hostname],
  ["PGPORT", port],
  ["PGUSER", username],
  ["PGPASSWORD", password],
  ["PGDATABASE", database],
];

const optionEnvironmentNames = new Map([
  ["sslmode", "PGSSLMODE"],
  ["sslcert", "PGSSLCERT"],
  ["sslkey", "PGSSLKEY"],
  ["sslrootcert", "PGSSLROOTCERT"],
  ["sslcrl", "PGSSLCRL"],
  ["sslcrldir", "PGSSLCRLDIR"],
  ["sslsni", "PGSSLSNI"],
  ["sslpassword", "PGSSLPASSWORD"],
  ["requirepeer", "PGREQUIREPEER"],
  ["connect_timeout", "PGCONNECT_TIMEOUT"],
  ["target_session_attrs", "PGTARGETSESSIONATTRS"],
  ["channel_binding", "PGCHANNELBINDING"],
  ["options", "PGOPTIONS"],
]);
const sslModes = new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]);
const emittedEnvironmentNames = new Set(connectionVariables.map(([name]) => name));

for (const [optionName, rawValue] of parsedUrl.searchParams) {
  let environmentName = optionEnvironmentNames.get(optionName);
  let value = rawValue;
  if (optionName === "ssl") {
    environmentName = "PGSSLMODE";
    if (rawValue === "true" || rawValue === "1") value = "require";
    else if (rawValue === "false" || rawValue === "0") value = "disable";
    else fail("DATABASE_URL contains an invalid ssl option");
  }
  if (!environmentName) fail("DATABASE_URL contains an unsupported connection option");
  if (!value || emittedEnvironmentNames.has(environmentName)) {
    fail("DATABASE_URL contains an empty or duplicate connection option");
  }
  if (environmentName === "PGSSLMODE" && !sslModes.has(value)) {
    fail("DATABASE_URL contains an invalid sslmode option");
  }
  if (environmentName === "PGCONNECT_TIMEOUT" && (!/^\d+$/.test(value) || Number(value) < 1)) {
    fail("DATABASE_URL contains an invalid connect_timeout option");
  }
  emittedEnvironmentNames.add(environmentName);
  connectionVariables.push([environmentName, value]);
}

if (connectionVariables.some(([, value]) => value.includes("\0"))) {
  fail("DATABASE_URL contains a forbidden NUL byte");
}

for (const [name, value] of connectionVariables) {
  process.stdout.write(`${name}\0${value}\0`);
}
