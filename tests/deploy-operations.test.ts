import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryFile = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const readRepositoryFile = (path: string) => readFileSync(repositoryFile(path), "utf8");
const restoreValidator = repositoryFile("deploy/scripts/validate-restore-target.mjs");
const roleValidator = repositoryFile("deploy/scripts/validate-ops-database-roles.mjs");
const activateRelease = repositoryFile("deploy/scripts/siyan-settlement-666-activate-release.sh");

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
      APP_DATABASE_URL: "postgresql://siyan_app:app-secret@db.test/settlement?sslmode=require",
      BACKUP_DATABASE_URL: "postgresql://siyan_backup:backup-secret@db.test/settlement?sslmode=require",
    });
    expect(valid.status).toBe(0);

    const plaintext = runValidator(roleValidator, {
      APP_DATABASE_URL: "postgresql://siyan_app:app-secret@db.test/settlement",
      BACKUP_DATABASE_URL: "postgresql://siyan_backup:backup-secret@db.test/settlement?sslmode=require",
    });
    expect(plaintext.status).not.toBe(0);
    expect(plaintext.stderr).toMatch(/require PostgreSQL SSL/);

    const disabledTls = runValidator(roleValidator, {
      APP_DATABASE_URL: "postgresql://siyan_app:app-secret@db.test/settlement?sslmode=disable",
      BACKUP_DATABASE_URL: "postgresql://siyan_backup:backup-secret@db.test/settlement?sslmode=require",
    });
    expect(disabledTls.status).not.toBe(0);

    const ambiguousTls = runValidator(roleValidator, {
      APP_DATABASE_URL: "postgresql://siyan_app:app-secret@db.test/settlement?sslmode=require&sslmode=disable",
      BACKUP_DATABASE_URL: "postgresql://siyan_backup:backup-secret@db.test/settlement?sslmode=require",
    });
    expect(ambiguousTls.status).not.toBe(0);

    const sharedUser = runValidator(roleValidator, {
      APP_DATABASE_URL: "postgresql://shared:app-secret@db.test/settlement?sslmode=require",
      BACKUP_DATABASE_URL: "postgresql://shared:backup-secret@db.test/settlement?sslmode=require",
    });
    expect(sharedUser.status).not.toBe(0);

    const secret = "never-echo-this-database-secret";
    const sharedPassword = runValidator(roleValidator, {
      APP_DATABASE_URL: `postgresql://siyan_app:${secret}@db.test/settlement?sslmode=require`,
      BACKUP_DATABASE_URL: `postgresql://siyan_backup:${secret}@db.test/settlement?sslmode=require`,
    });
    expect(sharedPassword.status).not.toBe(0);
    expect(sharedPassword.stderr).not.toContain(secret);
    expect(sharedPassword.stdout).not.toContain(secret);

    const differentDatabase = runValidator(roleValidator, {
      APP_DATABASE_URL: "postgresql://siyan_app:app-secret@db.test/settlement?sslmode=require",
      BACKUP_DATABASE_URL: "postgresql://siyan_backup:backup-secret@db.test/other?sslmode=require",
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
    expect(preflight).toContain("SMS_ENABLED SMS_CODE_HMAC_KEY SMS_CODE_TTL_SECONDS");
    expect(preflight).toContain("ALIYUN_SMS_SIGN_NAME ALIYUN_SMS_LOGIN_TEMPLATE_CODE");
    expect(preflight).toContain("ALIYUN_SMS_DIGEST_TEMPLATE_CODE");
    expect(preflight).toContain("NOTIFICATION_PROVIDER NOTIFICATION_WORKER_NAME NOTIFICATION_POLL_INTERVAL_MS");
    expect(preflight).toContain('read_bounded_integer "${APP_ENV}" SMS_CODE_TTL_SECONDS 60 600');
    expect(preflight).toContain('read_bounded_integer "${APP_ENV}" NOTIFICATION_LEASE_SECONDS 30 3600');
    expect(preflight).toContain("minimum_notification_lease_seconds=$((notification_batch_size * 15 + 30))");
    expect(preflight).toContain("NOTIFICATION_LEASE_SECONDS must cover NOTIFICATION_BATCH_SIZE * 15 seconds plus 30 seconds");
    expect(preflight).toContain("NOTIFICATION_PROVIDER must be fake or aliyun");
    expect(preflight).toContain('read_env_value "${APP_ENV}" RELEASE_ID');
    expect(preflight).toMatch(
      /notification_unit in[\s\S]*siyan-settlement-666-reminder-worker\.service[\s\S]*siyan-settlement-666-reminder-worker-health-check\.timer/,
    );
    expect(preflight).toContain("fake notification worker and heartbeat timer must remain inactive and disabled in production");
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

describe("release activation", () => {
  it("keeps production migrations in the explicit release CLI", () => {
    const server = readRepositoryFile("src/server.ts");
    const deploymentGuide = readRepositoryFile("deploy/README.md");
    expect(server).toContain('if (config.NODE_ENV !== "production")');
    expect(server).toContain("await migrate(database);");
    expect(server).toContain("Production migrations run in the release's isolated CLI");
    expect(deploymentGuide).toContain("不会把旧代码自动切回数据库已经迁移过的结构");
    expect(deploymentGuide).not.toContain("previous_release=");
    expect(deploymentGuide).not.toContain("rollback_link=");
  });

  it("exposes a root-only activation command and a read-only unit validation mode", () => {
    const script = readRepositoryFile("deploy/scripts/siyan-settlement-666-activate-release.sh");
    const help = spawnSync(activateRelease, ["--help"], { encoding: "utf8" });

    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--validate-units-only");
    expect(script).toContain("flock -n 9");
    expect(script).toContain("sha256sum -c SHA256SUMS");
    expect(script).toContain('systemctl restart "${WORKER_UNIT}"');
    expect(script).toContain("assert_unit_uses_release");
    expect(script).toContain("current remains");
    expect(script).toContain("forward fix or coordinate a database restore");
    expect(script).not.toContain("previous_release");
    expect(script).not.toContain("rollback_link");
  });

  it("requires an exact bidirectional match between release and installed units", () => {
    const directory = mkdtempSync(join(tmpdir(), "siyan-unit-validation-"));
    const releaseDir = join(directory, "release");
    const releaseSystemd = join(releaseDir, "deploy", "systemd");
    const installedDir = join(directory, "installed");
    const serviceName = "siyan-settlement-666.service";
    const timerName = "siyan-settlement-666-health-check.timer";
    const serviceText = "[Unit]\nDescription=test app\n[Service]\nExecStart=/bin/true\n";
    const timerText = "[Unit]\nDescription=test timer\n[Timer]\nOnBootSec=1m\n";
    try {
      mkdirSync(releaseSystemd, { recursive: true });
      mkdirSync(installedDir, { recursive: true });
      writeFileSync(join(releaseSystemd, serviceName), serviceText, { mode: 0o644 });
      writeFileSync(join(releaseSystemd, timerName), timerText, { mode: 0o644 });
      writeFileSync(join(installedDir, serviceName), serviceText, { mode: 0o644 });
      writeFileSync(join(installedDir, timerName), timerText, { mode: 0o644 });

      const args = ["--validate-units-only", "--release-dir", releaseDir, "--installed-unit-dir", installedDir];
      const valid = spawnSync(activateRelease, args, { encoding: "utf8" });
      expect(valid.status).toBe(0);

      writeFileSync(join(installedDir, serviceName), `${serviceText}# changed\n`);
      const changed = spawnSync(activateRelease, args, { encoding: "utf8" });
      expect(changed.status).not.toBe(0);
      expect(changed.stderr).toContain("differs from release");

      writeFileSync(join(installedDir, serviceName), serviceText);
      rmSync(join(installedDir, timerName));
      const missing = spawnSync(activateRelease, args, { encoding: "utf8" });
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain("unit is missing");

      writeFileSync(join(installedDir, timerName), timerText);
      writeFileSync(join(installedDir, "siyan-settlement-666-stale.service"), serviceText);
      const stale = spawnSync(activateRelease, args, { encoding: "utf8" });
      expect(stale.status).not.toBe(0);
      expect(stale.stderr).toContain("not present in release");

      rmSync(join(installedDir, "siyan-settlement-666-stale.service"));
      mkdirSync(join(installedDir, `${serviceName}.d`));
      const dropIn = spawnSync(activateRelease, args, { encoding: "utf8" });
      expect(dropIn.status).not.toBe(0);
      expect(dropIn.stderr).toContain("override or wants link");
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

  it("ships a disabled-by-default reminder worker with current-release heartbeat monitoring", () => {
    const worker = readRepositoryFile("deploy/systemd/siyan-settlement-666-reminder-worker.service");
    const heartbeatService = readRepositoryFile("deploy/systemd/siyan-settlement-666-reminder-worker-health-check.service");
    const heartbeatTimer = readRepositoryFile("deploy/systemd/siyan-settlement-666-reminder-worker-health-check.timer");
    const heartbeatScript = readRepositoryFile("deploy/scripts/siyan-settlement-666-reminder-worker-health-check.sh");

    expect(worker).toContain("User=siyan-settlement-666\n");
    expect(worker).toContain("EnvironmentFile=/etc/siyan-settlement-666/app/app.env");
    expect(worker).toContain("dist/src/worker.js");
    expect(worker).toContain("OnFailure=siyan-settlement-666-alert@%n.service");
    expect(worker).toContain("ProtectSystem=strict");
    expect(heartbeatService).toContain("User=siyan-settlement-666\n");
    expect(heartbeatService).toContain("OnFailure=siyan-settlement-666-alert@%n.service");
    expect(heartbeatTimer).toContain("OnUnitActiveSec=1m");
    expect(heartbeatScript).toContain("notification_worker_heartbeats");
    expect(heartbeatScript).toContain("worker_name = :'worker_name'");
    expect(heartbeatScript).toContain("release_id = :'release_id'");
    expect(heartbeatScript).toContain("provider <> 'fake'");
    expect(heartbeatScript).toContain("last_error_at < clock_timestamp()");
    expect(heartbeatScript).not.toMatch(/(?:printf|echo)[^\n]*(?:DATABASE_URL|password)/i);
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
