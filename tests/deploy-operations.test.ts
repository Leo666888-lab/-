import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryFile = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const readRepositoryFile = (path: string) => readFileSync(repositoryFile(path), "utf8");
const restoreValidator = repositoryFile("deploy/scripts/validate-restore-target.mjs");
const roleValidator = repositoryFile("deploy/scripts/validate-ops-database-roles.mjs");

const runValidator = (script: string, env: Record<string, string>) => spawnSync(
  process.execPath,
  [script],
  { env, encoding: "utf8" },
);

describe("deployment identity and secret isolation", () => {
  it("uses separate system users, environment files, and inaccessible secret paths", () => {
    const application = readRepositoryFile("deploy/systemd/siyan-settlement-666.service");
    const backup = readRepositoryFile("deploy/systemd/siyan-settlement-666-postgres-backup.service");
    const alert = readRepositoryFile("deploy/systemd/siyan-settlement-666-alert@.service");
    const alertScript = readRepositoryFile("deploy/scripts/siyan-settlement-666-alert.sh");

    expect(application).toContain("User=siyan-settlement-666\n");
    expect(application).toContain("EnvironmentFile=/etc/siyan-settlement-666/app/app.env");
    expect(application).toContain("InaccessiblePaths=/etc/siyan-settlement-666/backup");
    expect(application).toContain("OnFailure=siyan-settlement-666-alert@%n.service");
    expect(application).toContain("Wants=network-online.target");
    expect(application).toContain("After=network-online.target");
    expect(application).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6");

    expect(backup).toContain("User=siyan-settlement-666-backup");
    expect(backup).toContain("EnvironmentFile=/etc/siyan-settlement-666/backup/backup.env");
    expect(backup).toContain("InaccessiblePaths=/etc/siyan-settlement-666/app");
    expect(backup).toContain("StateDirectory=siyan-settlement-666-backup");

    expect(alert).toContain("User=siyan-settlement-666-monitor");
    expect(alert).toContain("EnvironmentFile=/etc/siyan-settlement-666/monitor/monitor.env");
    expect(alert).toContain("InaccessiblePaths=/etc/siyan-settlement-666/app");
    expect(alert).toContain("InaccessiblePaths=/etc/siyan-settlement-666/app /etc/siyan-settlement-666/backup");
    expect(alertScript).toContain('--config "${request_config}"');
    expect(alertScript).not.toContain('curl "${curl_arguments[@]}" "${ALERT_WEBHOOK_URL}"');
  });

  it("requires different application and backup database credentials without echoing them", () => {
    const valid = runValidator(roleValidator, {
      APP_DATABASE_URL: "postgresql://siyan_app:app-secret@db.test/settlement",
      BACKUP_DATABASE_URL: "postgresql://siyan_backup:backup-secret@db.test/settlement",
    });
    expect(valid.status).toBe(0);

    const sharedUser = runValidator(roleValidator, {
      APP_DATABASE_URL: "postgresql://shared:app-secret@db.test/settlement",
      BACKUP_DATABASE_URL: "postgresql://shared:backup-secret@db.test/settlement",
    });
    expect(sharedUser.status).not.toBe(0);

    const secret = "never-echo-this-database-secret";
    const sharedPassword = runValidator(roleValidator, {
      APP_DATABASE_URL: `postgresql://siyan_app:${secret}@db.test/settlement`,
      BACKUP_DATABASE_URL: `postgresql://siyan_backup:${secret}@db.test/settlement`,
    });
    expect(sharedPassword.status).not.toBe(0);
    expect(sharedPassword.stderr).not.toContain(secret);
    expect(sharedPassword.stdout).not.toContain(secret);

    const differentDatabase = runValidator(roleValidator, {
      APP_DATABASE_URL: "postgresql://siyan_app:app-secret@db.test/settlement",
      BACKUP_DATABASE_URL: "postgresql://siyan_backup:backup-secret@db.test/other",
    });
    expect(differentDatabase.status).not.toBe(0);
  });

  it("requires a namespaced Redis TLS/ACL connection without putting its secret on argv", () => {
    const preflight = readRepositoryFile("deploy/scripts/siyan-settlement-666-preflight.sh");

    expect(preflight).toContain("DATABASE_URL REDIS_URL REDIS_KEY_PREFIX");
    expect(preflight).toContain('read_env_value "${APP_ENV}" REDIS_URL');
    expect(preflight).toContain('read_env_value "${APP_ENV}" REDIS_KEY_PREFIX');
    expect(preflight).toContain('siyan-settlement-666:production:');
    expect(preflight).toContain('target.protocol !== "rediss:"');
    expect(preflight).toContain('REDISCLI_AUTH: password');
    expect(preflight).toContain('"--tls", "--sni", target.hostname');
    expect(preflight).toContain('"--user", username');
    expect(preflight).toContain('"--raw", "PING"');
    expect(preflight).not.toMatch(/redis-cli[^\n]*(?:-u|--uri)/);
    expect(preflight).not.toMatch(/(?:printf|echo)[^\n]*(?:redis_url|REDIS_URL|password)/i);
  });

  it("passes Redis credentials through the child environment and rejects plaintext Redis", () => {
    const preflight = readRepositoryFile("deploy/scripts/siyan-settlement-666-preflight.sh");
    const program = preflight.match(
      /"\$\{NODE_BIN\}" <<'NODE' \|\| die "Redis TLS\/ACL connectivity check failed"\n([\s\S]*?)\nNODE/,
    )?.[1];
    expect(program).toBeTruthy();

    const directory = mkdtempSync(join(tmpdir(), "siyan-redis-preflight-"));
    const programPath = join(directory, "redis-preflight.mjs");
    const runnerPath = join(directory, "runuser-check.sh");
    const password = "redis-test-secret-1234";
    try {
      writeFileSync(programPath, program ?? "", { mode: 0o600 });
      writeFileSync(runnerPath, `#!/bin/sh
[ "$REDISCLI_AUTH" = '${password}' ] || exit 41
case "$*" in *'${password}'*) exit 42 ;; esac
printf 'PONG\\n'
`, { mode: 0o700 });
      chmodSync(runnerPath, 0o700);

      const baseEnv = {
        REDIS_CLI_BIN: "/usr/bin/redis-cli",
        RUNUSER_BIN: runnerPath,
        REDIS_APP_USER: "siyan-settlement-666",
      };
      const valid = runValidator(programPath, {
        ...baseEnv,
        REDIS_URL: `rediss://siyan_app:${password}@tair.private.example:6379/0`,
      });
      expect(valid.status).toBe(0);
      expect(valid.stdout).not.toContain(password);
      expect(valid.stderr).not.toContain(password);

      const plaintext = runValidator(programPath, {
        ...baseEnv,
        REDIS_URL: `redis://siyan_app:${password}@tair.private.example:6379/0`,
      });
      expect(plaintext.status).not.toBe(0);
      expect(plaintext.stdout).not.toContain(password);
      expect(plaintext.stderr).not.toContain(password);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("restore drill safety", () => {
  it("accepts only dedicated loopback restore targets", () => {
    const valid = runValidator(restoreValidator, {
      RESTORE_DATABASE_URL: "postgresql://siyan_restore_operator:drill-secret@127.0.0.1/siyan_settlement_666_restore_drill_20260725",
    });
    expect(valid.status).toBe(0);

    const remote = runValidator(restoreValidator, {
      RESTORE_DATABASE_URL: "postgresql://siyan_restore_operator:drill-secret@db.example.test/siyan_settlement_666_restore_drill_20260725",
    });
    expect(remote.status).not.toBe(0);

    const unsafeName = runValidator(restoreValidator, {
      RESTORE_DATABASE_URL: "postgresql://siyan_restore_operator:drill-secret@127.0.0.1/settlement",
    });
    expect(unsafeName.status).not.toBe(0);

    const options = runValidator(restoreValidator, {
      RESTORE_DATABASE_URL: "postgresql://siyan_restore_operator:drill-secret@127.0.0.1/siyan_settlement_666_restore_drill_20260725?options=-c%20search_path%3Dpublic",
    });
    expect(options.status).not.toBe(0);
  });

  it("rejects production locations and identities without exposing credentials", () => {
    const secret = "production-secret-must-stay-hidden";
    const sameTarget = runValidator(restoreValidator, {
      RESTORE_DATABASE_URL: "postgresql://siyan_restore_operator:drill-secret@127.0.0.1/siyan_settlement_666_restore_drill_20260725",
      PRODUCTION_DATABASE_URL: `postgresql://siyan_app:${secret}@127.0.0.1/siyan_settlement_666_restore_drill_20260725`,
    });
    expect(sameTarget.status).not.toBe(0);
    expect(sameTarget.stderr).not.toContain(secret);

    const sameUser = runValidator(restoreValidator, {
      RESTORE_DATABASE_URL: "postgresql://siyan_restore_operator:drill-secret@127.0.0.1/siyan_settlement_666_restore_drill_20260725",
      PRODUCTION_DATABASE_URL: `postgresql://siyan_restore_operator:${secret}@prod.example.test/settlement`,
    });
    expect(sameUser.status).not.toBe(0);
    expect(sameUser.stderr).not.toContain(secret);
  });

  it("guards the executable restore workflow before any write", () => {
    const restore = readRepositoryFile("deploy/scripts/siyan-settlement-666-restore-drill.sh");
    const markerIndex = restore.indexOf("PROJECT_HOST_MARKER");
    const restoreIndex = restore.indexOf("pg_restore --exit-on-error");

    expect(markerIndex).toBeGreaterThan(-1);
    expect(restore).toContain("restore drill refuses to run as root");
    expect(restore).toContain("restore drill refuses to run on an application host");
    expect(restore).toContain('! -L "${PRODUCTION_CURRENT}"');
    expect(restore).toContain("restore target must be empty and use a non-privileged dedicated role");
    expect(restore).toContain("PGOPTIONS='-c default_transaction_read_only=on'");
    expect(restore).toContain("release files must be root-owned and not writable by group or others");
    expect(restore).toContain("sha256sum -c SHA256SUMS");
    expect(restoreIndex).toBeGreaterThan(markerIndex);
    expect(restore).not.toMatch(/\b(?:createdb|dropdb)\b|\b(?:CREATE|DROP) DATABASE\b/i);
  });
});

describe("health, TLS, and failure alert operations", () => {
  it("schedules active health and TLS checks with failure alerts", () => {
    const healthService = readRepositoryFile("deploy/systemd/siyan-settlement-666-health-check.service");
    const healthTimer = readRepositoryFile("deploy/systemd/siyan-settlement-666-health-check.timer");
    const tlsService = readRepositoryFile("deploy/systemd/siyan-settlement-666-tls-check.service");
    const tlsTimer = readRepositoryFile("deploy/systemd/siyan-settlement-666-tls-check.timer");

    for (const service of [healthService, tlsService]) {
      expect(service).toContain("User=siyan-settlement-666-monitor");
      expect(service).toContain("OnFailure=siyan-settlement-666-alert@%n.service");
      expect(service).toContain("ProtectSystem=strict");
      expect(service).toContain("CapabilityBoundingSet=\n");
    }
    expect(healthTimer).toContain("OnUnitActiveSec=1m");
    expect(tlsTimer).toContain("Persistent=true");
  });

  it("requires live TLS renewal evidence and writes it only after served-certificate verification", () => {
    const check = readRepositoryFile("deploy/scripts/siyan-settlement-666-tls-check.sh");
    const reload = readRepositoryFile("deploy/scripts/siyan-settlement-666-nginx-cert-reload.sh");
    const servedVerification = reload.indexOf("served_fingerprint");
    const evidenceWrite = reload.indexOf("printf 'verified_at=");

    expect(check).toContain("openssl x509 -in \"${CERTIFICATE_FILE}\" -noout -checkend");
    expect(check).toContain("systemctl is-active --quiet \"${renewal_timer}\"");
    expect(check).toContain("successful renewal evidence stamp is missing");
    expect(servedVerification).toBeGreaterThan(-1);
    expect(evidenceWrite).toBeGreaterThan(servedVerification);
  });

  it("records verified offsite backups and makes upgrade preflight read-only", () => {
    const backup = readRepositoryFile("deploy/scripts/siyan-settlement-666-postgres-backup.sh");
    const preflight = readRepositoryFile("deploy/scripts/siyan-settlement-666-preflight.sh");

    expect(backup).toContain('readonly SUCCESS_STAMP="${BACKUP_STATE_DIR}/last-success"');
    expect(backup.indexOf("rclone check")).toBeLessThan(backup.indexOf("printf 'completed_at="));
    expect(preflight).toContain("BEGIN READ ONLY");
    expect(preflight).toContain("has_table_privilege(current_user, item.oid");
    expect(preflight).toContain("has_sequence_privilege(current_user, item.oid");
    expect(preflight).toContain("application user can read backup secrets");
    expect(preflight).toContain("contains unsupported key");
    expect(preflight).toContain("contains duplicate key");
    expect(preflight).toContain("latest verified offsite backup is older than 36 hours");
    expect(preflight).not.toMatch(/\b(?:createdb|dropdb)\b|\b(?:CREATE|DROP|TRUNCATE) DATABASE\b/i);
  });
});
