#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly APP_USER="siyan-settlement-666"
readonly BACKUP_USER="siyan-settlement-666-backup"
readonly MONITOR_USER="siyan-settlement-666-monitor"
readonly RELEASE_GROUP="siyan-settlement-666-release"
readonly CONFIG_ROOT="/etc/siyan-settlement-666"
readonly APP_ENV="${CONFIG_ROOT}/app/app.env"
readonly BACKUP_ENV="${CONFIG_ROOT}/backup/backup.env"
readonly BACKUP_RECIPIENT="${CONFIG_ROOT}/backup/backup.age-recipient"
readonly RCLONE_CONFIG="${CONFIG_ROOT}/backup/rclone.conf"
readonly MONITOR_ENV="${CONFIG_ROOT}/monitor/monitor.env"
readonly APP_STATE_DIR="/var/lib/siyan-settlement-666"
readonly BACKUP_DIR="/var/backups/siyan-settlement-666"
readonly BACKUP_STATE_DIR="/var/lib/siyan-settlement-666-backup"
readonly MONITOR_STATE_DIR="/var/lib/siyan-settlement-666-monitor"
readonly TLS_STATE_DIR="/var/lib/siyan-settlement-666-tls"
readonly BACKUP_STAMP="/var/lib/siyan-settlement-666-backup/last-success"
readonly TLS_STAMP="/var/lib/siyan-settlement-666-tls/renewal-last-success"
readonly NODE_BIN="/opt/siyan-settlement-666/runtime/node/bin/node"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'usage: %s --mode first-install|upgrade --release-dir ABSOLUTE_PATH [--confirm-empty-database]\n' "$0"
}

mode=""
release_dir=""
confirmed_empty=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      [[ $# -ge 2 ]] || die "--mode requires a value"
      mode="$2"
      shift 2
      ;;
    --release-dir)
      [[ $# -ge 2 ]] || die "--release-dir requires a value"
      release_dir="$2"
      shift 2
      ;;
    --confirm-empty-database)
      confirmed_empty=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
done

[[ "${mode}" == "first-install" || "${mode}" == "upgrade" ]] || die "--mode must be first-install or upgrade"
[[ "${release_dir}" == /* ]] || die "--release-dir must be an absolute path"
[[ "${release_dir}" =~ ^/opt/siyan-settlement-666/releases/[0-9a-f]{40}$ ]] \
  || die "release directory must end with a 40-character Git SHA"
[[ ${EUID} -eq 0 ]] || die "preflight must run as root"
if [[ "${mode}" == "first-install" && "${confirmed_empty}" != true ]]; then
  die "first install requires --confirm-empty-database after the read-only database check"
fi
if [[ "${mode}" == "upgrade" && "${confirmed_empty}" == true ]]; then
  die "--confirm-empty-database is only valid for first install"
fi

for command_name in awk date getent grep id mktemp nginx psql readlink redis-cli rm runuser sha256sum ss stat systemctl tr; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command not found: ${command_name}"
done

expect_owner_mode() {
  local path="$1"
  local expected_owner="$2"
  local expected_group="$3"
  local expected_mode="$4"
  [[ -e "${path}" ]] || die "required path is missing: ${path}"
  local actual
  actual="$(stat -c '%U:%G:%a' "${path}")"
  [[ "${actual}" == "${expected_owner}:${expected_group}:${expected_mode}" ]] \
    || die "unsafe owner or mode for ${path}; expected ${expected_owner}:${expected_group}:${expected_mode}"
}

user_in_group() {
  local user_name="$1"
  local group_name="$2"
  id -nG "${user_name}" | tr ' ' '\n' | grep -Fxq "${group_name}"
}

ENV_VALUE=""
read_env_value() {
  local file_path="$1"
  local key="$2"
  local count=0
  local line
  ENV_VALUE=""
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    if [[ "${line}" == "${key}="* ]]; then
      ENV_VALUE="${line#*=}"
      count=$((count + 1))
    fi
  done < "${file_path}"
  (( count == 1 )) || die "${file_path} must contain exactly one ${key} entry"
  [[ -n "${ENV_VALUE}" ]] || die "${key} must not be empty in ${file_path}"
}

read_bounded_integer() {
  local file_path="$1"
  local key="$2"
  local minimum="$3"
  local maximum="$4"
  read_env_value "${file_path}" "${key}"
  [[ "${ENV_VALUE}" =~ ^[0-9]+$ ]] || die "${key} must be an integer"
  local parsed_value=$((10#${ENV_VALUE}))
  (( parsed_value >= minimum && parsed_value <= maximum )) \
    || die "${key} must be between ${minimum} and ${maximum}"
}

# Parse a PostgreSQL URL into libpq environment variables without putting the
# password in argv or in the preflight output. The parser emits NUL-delimited
# pairs so passwords and URL-encoded values cannot be split by shell syntax.
load_postgres_connection() {
  local database_url="$1"
  local parse_status=0
  local connection_key
  local connection_value
  local expected_key
  local -a connection_keys=()
  local parser_path="${release_dir}/deploy/scripts/parse-postgres-database-url.mjs"

  [[ -r "${parser_path}" ]] || die "database URL parser is missing"
  POSTGRES_CONNECTION_ENV_PATH="$(mktemp "${TMPDIR:-/tmp}/siyan-settlement-666-pg.XXXXXX")"
  DATABASE_URL="${database_url}" "${NODE_BIN}" "${parser_path}" > "${POSTGRES_CONNECTION_ENV_PATH}" || parse_status=$?
  unset database_url
  if (( parse_status != 0 )); then
    rm -f -- "${POSTGRES_CONNECTION_ENV_PATH}"
    POSTGRES_CONNECTION_ENV_PATH=""
    die "DATABASE_URL could not be parsed"
  fi

  unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE \
    PGSSLMODE PGSSLCERT PGSSLKEY PGSSLROOTCERT PGSSLCRL PGSSLCRLDIR \
    PGSSLSNI PGSSLPASSWORD PGREQUIREPEER PGCONNECT_TIMEOUT \
    PGTARGETSESSIONATTRS PGCHANNELBINDING PGOPTIONS
  exec 8<"${POSTGRES_CONNECTION_ENV_PATH}"
  while :; do
    connection_key=""
    if ! IFS= read -r -d '' connection_key <&8; then
      [[ -z "${connection_key}" ]] || die "database URL parser returned incomplete output"
      break
    fi
    IFS= read -r -d '' connection_value <&8 || die "database URL parser returned incomplete output"
    case "${connection_key}" in
      PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE|PGSSLMODE|PGSSLCERT|PGSSLKEY|PGSSLROOTCERT|PGSSLCRL|PGSSLCRLDIR|PGSSLSNI|PGSSLPASSWORD|PGREQUIREPEER|PGCONNECT_TIMEOUT|PGTARGETSESSIONATTRS|PGCHANNELBINDING|PGOPTIONS) ;;
      *) die "database URL parser returned an unsupported connection option" ;;
    esac
    for expected_key in "${connection_keys[@]}"; do
      [[ "${expected_key}" != "${connection_key}" ]] || die "database URL parser returned a duplicate connection option"
    done
    printf -v "${connection_key}" '%s' "${connection_value}"
    export "${connection_key}"
    connection_keys+=("${connection_key}")
  done
  exec 8<&-
  rm -f -- "${POSTGRES_CONNECTION_ENV_PATH}"
  POSTGRES_CONNECTION_ENV_PATH=""
  for expected_key in PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE; do
    [[ -n "${!expected_key:-}" ]] || die "database URL parser returned incomplete connection details"
  done
}

POSTGRES_CONNECTION_ENV_PATH=""
cleanup_postgres_connection_file() {
  if [[ -n "${POSTGRES_CONNECTION_ENV_PATH}" && -e "${POSTGRES_CONNECTION_ENV_PATH}" ]]; then
    rm -f -- "${POSTGRES_CONNECTION_ENV_PATH}"
  fi
}
trap cleanup_postgres_connection_file EXIT

unset_postgres_connection() {
  unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE \
    PGSSLMODE PGSSLCERT PGSSLKEY PGSSLROOTCERT PGSSLCRL PGSSLCRLDIR \
    PGSSLSNI PGSSLPASSWORD PGREQUIREPEER PGCONNECT_TIMEOUT \
    PGTARGETSESSIONATTRS PGCHANNELBINDING PGOPTIONS
}

validate_env_keys() {
  local file_path="$1"
  shift
  local allowed_keys=$'\n'
  local key
  for key in "$@"; do
    allowed_keys+="${key}"$'\n'
  done
  local seen_keys=$'\n'
  local line
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    [[ "${line}" =~ ^[A-Z][A-Z0-9_]*= ]] \
      || die "${file_path} contains unsupported environment syntax"
    key="${line%%=*}"
    [[ "${allowed_keys}" == *$'\n'"${key}"$'\n'* ]] \
      || die "${file_path} contains unsupported key: ${key}"
    [[ "${seen_keys}" != *$'\n'"${key}"$'\n'* ]] \
      || die "${file_path} contains duplicate key: ${key}"
    seen_keys+="${key}"$'\n'
  done < "${file_path}"
}

for user_name in "${APP_USER}" "${BACKUP_USER}" "${MONITOR_USER}"; do
  getent passwd "${user_name}" >/dev/null || die "required user is missing: ${user_name}"
done
getent group "${RELEASE_GROUP}" >/dev/null || die "required group is missing: ${RELEASE_GROUP}"
[[ "$(id -u "${APP_USER}")" != "$(id -u "${BACKUP_USER}")" ]] || die "application and backup users must be distinct"
[[ "$(id -u "${APP_USER}")" != "$(id -u "${MONITOR_USER}")" ]] || die "application and monitor users must be distinct"
[[ "$(id -u "${BACKUP_USER}")" != "$(id -u "${MONITOR_USER}")" ]] || die "backup and monitor users must be distinct"
for user_name in "${APP_USER}" "${BACKUP_USER}" "${MONITOR_USER}"; do
  user_in_group "${user_name}" "${RELEASE_GROUP}" || die "${user_name} is not in ${RELEASE_GROUP}"
done
user_in_group "${APP_USER}" "${BACKUP_USER}" && die "application user must not join the backup group"
user_in_group "${BACKUP_USER}" "${APP_USER}" && die "backup user must not join the application group"

expect_owner_mode "${CONFIG_ROOT}" root root 711
expect_owner_mode "${CONFIG_ROOT}/app" root "${APP_USER}" 750
expect_owner_mode "${APP_ENV}" root "${APP_USER}" 640
expect_owner_mode "${CONFIG_ROOT}/backup" root "${BACKUP_USER}" 750
expect_owner_mode "${BACKUP_ENV}" root "${BACKUP_USER}" 640
expect_owner_mode "${BACKUP_RECIPIENT}" root "${BACKUP_USER}" 640
expect_owner_mode "${RCLONE_CONFIG}" root "${BACKUP_USER}" 640
expect_owner_mode "${CONFIG_ROOT}/monitor" root "${MONITOR_USER}" 750
expect_owner_mode "${MONITOR_ENV}" root "${MONITOR_USER}" 640
expect_owner_mode "${APP_STATE_DIR}" "${APP_USER}" "${APP_USER}" 750
expect_owner_mode "${BACKUP_DIR}" "${BACKUP_USER}" "${BACKUP_USER}" 700
expect_owner_mode "${BACKUP_STATE_DIR}" "${BACKUP_USER}" "${BACKUP_USER}" 700
expect_owner_mode "${MONITOR_STATE_DIR}" "${MONITOR_USER}" "${MONITOR_USER}" 700
expect_owner_mode "${TLS_STATE_DIR}" root "${MONITOR_USER}" 750
expect_owner_mode "${TLS_STAMP}" root "${MONITOR_USER}" 640

validate_env_keys "${APP_ENV}" \
  NODE_ENV HOST PORT DATABASE_URL REDIS_URL REDIS_KEY_PREFIX SEED_DEMO PUBLIC_ORIGIN SESSION_TTL_HOURS \
  BODY_LIMIT_BYTES LOGIN_RATE_LIMIT_MAX \
  SMS_ENABLED SMS_CODE_HMAC_KEY SMS_CODE_TTL_SECONDS SMS_RESEND_COOLDOWN_SECONDS \
  SMS_VERIFY_MAX_ATTEMPTS SMS_SEND_RATE_LIMIT_MAX SMS_SEND_RATE_LIMIT_IP_MAX \
  SMS_SEND_RATE_LIMIT_WINDOW_SECONDS ALIYUN_SMS_REGION_ID ALIYUN_SMS_ENDPOINT \
  ALIYUN_SMS_SIGN_NAME ALIYUN_SMS_LOGIN_TEMPLATE_CODE ALIYUN_SMS_DIGEST_TEMPLATE_CODE \
  NOTIFICATION_PROVIDER NOTIFICATION_WORKER_NAME NOTIFICATION_POLL_INTERVAL_MS NOTIFICATION_BATCH_SIZE \
  NOTIFICATION_LEASE_SECONDS NOTIFICATION_MAX_ATTEMPTS RELEASE_ID
validate_env_keys "${BACKUP_ENV}" DATABASE_URL BACKUP_RETENTION_DAYS BACKUP_REMOTE
validate_env_keys "${MONITOR_ENV}" \
  ALERT_WEBHOOK_URL ALERT_WEBHOOK_BEARER_TOKEN ALERT_COOLDOWN_SECONDS \
  TLS_MIN_VALIDITY_SECONDS TLS_RENEWAL_MAX_AGE_SECONDS TLS_RENEWAL_TIMER

if runuser -u "${APP_USER}" -- test -r "${BACKUP_ENV}" \
    || runuser -u "${APP_USER}" -- test -r "${RCLONE_CONFIG}"; then
  die "application user can read backup secrets"
fi
if runuser -u "${BACKUP_USER}" -- test -r "${APP_ENV}"; then
  die "backup user can read application secrets"
fi
if runuser -u "${MONITOR_USER}" -- test -r "${APP_ENV}" \
    || runuser -u "${MONITOR_USER}" -- test -r "${BACKUP_ENV}"; then
  die "monitor user can read database secrets"
fi

[[ -d "${release_dir}" && ! -L "${release_dir}" ]] || die "release directory is missing or is a symbolic link"
expect_owner_mode "${release_dir}" root "${RELEASE_GROUP}" 750
for required_path in \
  SHA256SUMS \
  dist/src/server.js \
  dist/src/worker.js \
  dist/src/cli/migrate.js \
  public/index.html \
  deploy/scripts/parse-postgres-database-url.mjs \
  deploy/scripts/validate-restore-target.mjs \
  deploy/scripts/validate-ops-database-roles.mjs \
  deploy/scripts/siyan-settlement-666-alert.sh \
  deploy/scripts/siyan-settlement-666-activate-release.sh \
  deploy/scripts/siyan-settlement-666-postgres-backup.sh \
  deploy/scripts/siyan-settlement-666-preflight.sh \
  deploy/scripts/siyan-settlement-666-restore-drill.sh \
  deploy/scripts/siyan-settlement-666-health-check.sh \
  deploy/scripts/siyan-settlement-666-reminder-worker-health-check.sh \
  deploy/scripts/siyan-settlement-666-tls-check.sh; do
  [[ -r "${release_dir}/${required_path}" ]] || die "release is missing ${required_path}"
done
for executable_path in \
  deploy/scripts/siyan-settlement-666-alert.sh \
  deploy/scripts/siyan-settlement-666-activate-release.sh \
  deploy/scripts/siyan-settlement-666-postgres-backup.sh \
  deploy/scripts/siyan-settlement-666-preflight.sh \
  deploy/scripts/siyan-settlement-666-restore-drill.sh \
  deploy/scripts/siyan-settlement-666-health-check.sh \
  deploy/scripts/siyan-settlement-666-reminder-worker-health-check.sh \
  deploy/scripts/siyan-settlement-666-tls-check.sh; do
  [[ -x "${release_dir}/${executable_path}" ]] || die "release script is not executable: ${executable_path}"
done
(
  cd -- "${release_dir}"
  sha256sum -c SHA256SUMS >/dev/null
) || die "release manifest verification failed"
"${release_dir}/deploy/scripts/siyan-settlement-666-activate-release.sh" \
  --validate-units-only --release-dir "${release_dir}" \
  --installed-unit-dir /etc/systemd/system || die "installed systemd units do not match the release"
[[ -x "${NODE_BIN}" ]] || die "isolated Node.js executable is unavailable"
node_real_path="$(readlink -f -- "${NODE_BIN}")" || die "isolated Node.js path cannot be resolved"
[[ "${node_real_path}" == /opt/siyan-settlement-666/runtime/* ]] \
  || die "Node.js executable resolves outside the isolated project runtime"
[[ "$("${NODE_BIN}" -p 'process.versions.node')" == "24.18.0" ]] || die "isolated Node.js version must be 24.18.0"
unset node_real_path

read_env_value "${APP_ENV}" DATABASE_URL
app_database_url="${ENV_VALUE}"
read_env_value "${APP_ENV}" REDIS_URL
redis_url="${ENV_VALUE}"
read_env_value "${APP_ENV}" REDIS_KEY_PREFIX
redis_key_prefix="${ENV_VALUE}"
[[ "${redis_key_prefix}" == "siyan-settlement-666:production:" ]] \
  || die "REDIS_KEY_PREFIX must be the dedicated production namespace"
read_env_value "${APP_ENV}" RELEASE_ID
release_id="${ENV_VALUE}"
[[ "${release_id}" == "${release_dir##*/}" ]] \
  || die "RELEASE_ID must match the release directory Git SHA"
read_env_value "${APP_ENV}" SMS_ENABLED
sms_enabled="${ENV_VALUE}"
[[ "${sms_enabled}" == "true" || "${sms_enabled}" == "false" ]] \
  || die "SMS_ENABLED must be true or false"
read_bounded_integer "${APP_ENV}" SMS_CODE_TTL_SECONDS 60 600
read_bounded_integer "${APP_ENV}" SMS_RESEND_COOLDOWN_SECONDS 30 600
read_bounded_integer "${APP_ENV}" SMS_VERIFY_MAX_ATTEMPTS 1 10
read_bounded_integer "${APP_ENV}" SMS_SEND_RATE_LIMIT_MAX 1 100
read_bounded_integer "${APP_ENV}" SMS_SEND_RATE_LIMIT_IP_MAX 1 1000
read_bounded_integer "${APP_ENV}" SMS_SEND_RATE_LIMIT_WINDOW_SECONDS 60 86400
if [[ "${sms_enabled}" == "true" ]]; then
  read_env_value "${APP_ENV}" SMS_CODE_HMAC_KEY
  (( ${#ENV_VALUE} >= 32 )) || die "SMS_CODE_HMAC_KEY must contain at least 32 characters"
  read_env_value "${APP_ENV}" ALIYUN_SMS_REGION_ID
  read_env_value "${APP_ENV}" ALIYUN_SMS_ENDPOINT
  read_env_value "${APP_ENV}" ALIYUN_SMS_SIGN_NAME
  read_env_value "${APP_ENV}" ALIYUN_SMS_LOGIN_TEMPLATE_CODE
  [[ "${ENV_VALUE}" =~ ^SMS_[0-9]+$ ]] \
    || die "ALIYUN_SMS_LOGIN_TEMPLATE_CODE must match the approved SMS template format"
fi
read_env_value "${APP_ENV}" NOTIFICATION_PROVIDER
notification_provider="${ENV_VALUE}"
[[ "${notification_provider}" == "fake" || "${notification_provider}" == "aliyun" ]] \
  || die "NOTIFICATION_PROVIDER must be fake or aliyun"
read_env_value "${APP_ENV}" NOTIFICATION_WORKER_NAME
notification_worker_name="${ENV_VALUE}"
[[ "${notification_worker_name}" =~ ^[A-Za-z0-9_.:-]{1,100}$ ]] \
  || die "NOTIFICATION_WORKER_NAME is invalid"
read_bounded_integer "${APP_ENV}" NOTIFICATION_POLL_INTERVAL_MS 250 300000
read_bounded_integer "${APP_ENV}" NOTIFICATION_BATCH_SIZE 1 100
notification_batch_size=$((10#${ENV_VALUE}))
read_bounded_integer "${APP_ENV}" NOTIFICATION_LEASE_SECONDS 30 3600
notification_lease_seconds=$((10#${ENV_VALUE}))
minimum_notification_lease_seconds=$((notification_batch_size * 15 + 30))
(( notification_lease_seconds >= minimum_notification_lease_seconds )) \
  || die "NOTIFICATION_LEASE_SECONDS must cover NOTIFICATION_BATCH_SIZE * 15 seconds plus 30 seconds"
read_bounded_integer "${APP_ENV}" NOTIFICATION_MAX_ATTEMPTS 1 10
if [[ "${notification_provider}" == "fake" ]]; then
  for notification_unit in \
    siyan-settlement-666-reminder-worker.service \
    siyan-settlement-666-reminder-worker-health-check.timer; do
    if systemctl is-active --quiet "${notification_unit}" \
        || systemctl is-enabled --quiet "${notification_unit}"; then
      die "fake notification worker and heartbeat timer must remain inactive and disabled in production"
    fi
  done
fi
if [[ "${notification_provider}" == "aliyun" ]]; then
  read_env_value "${APP_ENV}" ALIYUN_SMS_SIGN_NAME
  [[ -n "${ENV_VALUE}" ]] || die "ALIYUN_SMS_SIGN_NAME is required for the notification worker"
  read_env_value "${APP_ENV}" ALIYUN_SMS_DIGEST_TEMPLATE_CODE
  [[ "${ENV_VALUE}" =~ ^SMS_[0-9]+$ ]] \
    || die "ALIYUN_SMS_DIGEST_TEMPLATE_CODE must match the approved SMS template format"
fi
read_env_value "${BACKUP_ENV}" DATABASE_URL
backup_database_url="${ENV_VALUE}"
read_env_value "${BACKUP_ENV}" BACKUP_REMOTE
backup_remote="${ENV_VALUE}"
[[ "${backup_remote}" =~ ^[A-Za-z0-9._-]+:.+ ]] || die "BACKUP_REMOTE is invalid"
read_env_value "${MONITOR_ENV}" ALERT_WEBHOOK_URL
alert_webhook_url="${ENV_VALUE}"
[[ "${alert_webhook_url}" =~ ^https://[^[:space:]\"\\]+$ ]] || die "ALERT_WEBHOOK_URL must use HTTPS"
if grep -Eq '^(BACKUP_REMOTE|BACKUP_RETENTION_DAYS)=' "${APP_ENV}"; then
  die "backup settings must not appear in the application environment"
fi
if grep -Eq '^(NODE_ENV|PUBLIC_ORIGIN|SESSION_TTL_HOURS)=' "${BACKUP_ENV}"; then
  die "application settings must not appear in the backup environment"
fi
APP_DATABASE_URL="${app_database_url}" BACKUP_DATABASE_URL="${backup_database_url}" \
  "${NODE_BIN}" "${release_dir}/deploy/scripts/validate-ops-database-roles.mjs"

# Parse the secret URL inside Node and pass only non-secret connection fields on the
# redis-cli command line. REDISCLI_AUTH remains in the child environment and neither
# redis-cli output nor the original URL is written to the deployment log.
REDIS_URL="${redis_url}" \
REDIS_CLI_BIN="$(command -v redis-cli)" \
RUNUSER_BIN="$(command -v runuser)" \
REDIS_APP_USER="${APP_USER}" \
  "${NODE_BIN}" <<'NODE' || die "Redis TLS/ACL connectivity check failed"
import { spawnSync } from "node:child_process";

const fail = () => {
  process.exitCode = 1;
};

try {
  const target = new URL(process.env.REDIS_URL ?? "");
  if (
    target.protocol !== "rediss:"
    || !target.hostname
    || !target.username
    || !target.password
    || target.search
    || target.hash
  ) {
    fail();
  } else {
    const username = decodeURIComponent(target.username);
    const password = decodeURIComponent(target.password);
    const databaseText = target.pathname === "" ? "0" : target.pathname.slice(1);
    const database = Number(databaseText);
    const port = target.port || "6379";
    const redisCli = process.env.REDIS_CLI_BIN ?? "";
    const runuser = process.env.RUNUSER_BIN ?? "";
    const appUser = process.env.REDIS_APP_USER ?? "";

    if (
      !/^[A-Za-z0-9_.:@-]{1,128}$/.test(username)
      || password.length < 16
      || password.includes("\0")
      || !/^[0-9]{1,2}$/.test(databaseText)
      || !Number.isInteger(database)
      || database < 0
      || database > 15
      || !/^[0-9]{1,5}$/.test(port)
      || Number(port) < 1
      || Number(port) > 65535
      || !redisCli
      || !runuser
      || !appUser
    ) {
      fail();
    } else {
      const result = spawnSync(runuser, [
        "-u", appUser, "--", redisCli,
        "--tls", "--sni", target.hostname,
        "-h", target.hostname, "-p", port,
        "--user", username, "-n", databaseText,
        "--no-auth-warning", "--raw", "PING",
      ], {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          REDISCLI_AUTH: password,
        },
      });
      if (result.status !== 0 || result.signal || result.stdout.trim() !== "PONG") fail();
    }
  }
} catch {
  fail();
}
NODE
unset backup_remote alert_webhook_url \
  redis_url redis_key_prefix release_id sms_enabled notification_provider notification_worker_name \
  notification_unit ENV_VALUE

load_postgres_connection "${backup_database_url}"

role_access_state="$(
  psql --no-psqlrc --no-password --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command="BEGIN READ ONLY;
        SELECT concat_ws(':',
          role.rolsuper,
          role.rolcreatedb,
          role.rolcreaterole,
          role.rolreplication,
          has_database_privilege(current_user, current_database(), 'CREATE'),
          (SELECT count(*) FROM pg_namespace namespace
            WHERE namespace.nspname NOT LIKE 'pg_%'
              AND namespace.nspname <> 'information_schema'
              AND NOT has_schema_privilege(current_user, namespace.oid, 'USAGE')),
          (SELECT count(*) FROM pg_namespace namespace
            WHERE namespace.nspname NOT LIKE 'pg_%'
              AND namespace.nspname <> 'information_schema'
              AND has_schema_privilege(current_user, namespace.oid, 'CREATE')),
          (SELECT count(*) FROM pg_class item
            JOIN pg_namespace namespace ON namespace.oid = item.relnamespace
            WHERE namespace.nspname NOT LIKE 'pg_%'
              AND namespace.nspname <> 'information_schema'
              AND item.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND NOT has_table_privilege(current_user, item.oid, 'SELECT')),
          (SELECT count(*) FROM pg_class item
            JOIN pg_namespace namespace ON namespace.oid = item.relnamespace
            WHERE namespace.nspname NOT LIKE 'pg_%'
              AND namespace.nspname <> 'information_schema'
              AND item.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND has_table_privilege(current_user, item.oid,
                'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
          (SELECT count(*) FROM pg_class item
            JOIN pg_namespace namespace ON namespace.oid = item.relnamespace
            WHERE namespace.nspname NOT LIKE 'pg_%'
              AND namespace.nspname <> 'information_schema'
              AND item.relkind = 'S'
              AND NOT has_sequence_privilege(current_user, item.oid, 'SELECT')),
          (SELECT count(*) FROM pg_class item
            JOIN pg_namespace namespace ON namespace.oid = item.relnamespace
            WHERE namespace.nspname NOT LIKE 'pg_%'
              AND namespace.nspname <> 'information_schema'
              AND item.relkind = 'S'
              AND has_sequence_privilege(current_user, item.oid, 'UPDATE')))
        FROM pg_roles role
        WHERE role.rolname = current_user;
        COMMIT;"
)" || die "backup database role safety query failed"
unset_postgres_connection
role_access_state="$(printf '%s\n' "${role_access_state}" \
  | awk -F: '/^[ft]:[ft]:[ft]:[ft]:[ft]:[0-9]+:[0-9]+:[0-9]+:[0-9]+:[0-9]+:[0-9]+$/ { print; exit }')"
[[ "${role_access_state}" == "f:f:f:f:f:0:0:0:0:0:0" ]] \
  || die "backup database role must be read-only and able to read every application table and sequence"
unset ENV_VALUE role_access_state

if [[ "${mode}" == "first-install" ]]; then
  if systemctl is-active --quiet siyan-settlement-666.service; then
    die "application service is already active during first-install preflight"
  fi
  if ss -lntH | awk '$4 ~ /(^|\])127\.0\.0\.1:16666$/ || $4 == "127.0.0.1:16666" { found=1 } END { exit !found }'; then
    die "internal port 16666 is already in use"
  fi
  load_postgres_connection "${app_database_url}"
  table_count="$(
    psql --no-psqlrc --no-password --tuples-only --no-align --set ON_ERROR_STOP=1 \
      --command="BEGIN READ ONLY; SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema'); COMMIT;"
  )" || die "read-only empty database check failed"
  unset_postgres_connection
  table_count="$(printf '%s\n' "${table_count}" | awk '/^[0-9]+$/ { print; exit }')"
  [[ "${table_count}" == "0" ]] || die "first-install target database is not empty"
else
  systemctl is-active --quiet siyan-settlement-666.service || die "application service is not active"
  for timer_name in \
    siyan-settlement-666-postgres-backup.timer \
    siyan-settlement-666-health-check.timer \
    siyan-settlement-666-tls-check.timer; do
    systemctl is-enabled --quiet "${timer_name}" || die "timer is not enabled: ${timer_name}"
    systemctl is-active --quiet "${timer_name}" || die "timer is not active: ${timer_name}"
  done
  [[ -r "${BACKUP_STAMP}" ]] || die "successful backup evidence is missing"
  expect_owner_mode "${BACKUP_STAMP}" "${BACKUP_USER}" "${BACKUP_USER}" 600
  now_epoch="$(date +%s)"
  backup_epoch="$(stat -c %Y "${BACKUP_STAMP}")"
  (( backup_epoch <= now_epoch + 300 )) || die "backup evidence timestamp is in the future"
  (( now_epoch - backup_epoch <= 129600 )) || die "latest verified offsite backup is older than 36 hours"
  "${release_dir}/deploy/scripts/siyan-settlement-666-health-check.sh" --all
fi

unset_postgres_connection
unset app_database_url backup_database_url

nginx -t
nginx_configuration="$(nginx -T 2>&1)" || die "nginx -T failed"
listen_count="$(printf '%s\n' "${nginx_configuration}" | grep -Ec '^[[:space:]]*listen[[:space:]]+666[[:space:]]+ssl;')"
[[ "${listen_count}" == "1" ]] || die "exactly one Nginx TLS listener must own port 666"
if [[ "${mode}" == "first-install" ]]; then
  "${release_dir}/deploy/scripts/siyan-settlement-666-tls-check.sh" --certificate-only
else
  "${release_dir}/deploy/scripts/siyan-settlement-666-tls-check.sh" --live
fi

printf 'deployment preflight passed for %s (%s)\n' "${release_dir}" "${mode}"
