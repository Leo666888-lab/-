#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly WORKER_SERVICE="siyan-settlement-666-reminder-worker.service"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

for command_name in awk mktemp psql rm systemctl; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command not found: ${command_name}"
done

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly NODE_BIN="/opt/siyan-settlement-666/runtime/node/bin/node"
readonly DATABASE_URL_PARSER="${SCRIPT_DIR}/parse-postgres-database-url.mjs"
[[ -x "${NODE_BIN}" ]] || die "isolated Node.js executable is unavailable"
[[ -r "${DATABASE_URL_PARSER}" ]] || die "database URL parser is unavailable"

[[ "${NODE_ENV:-}" == "production" ]] || die "worker health check requires NODE_ENV=production"
[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL is required"
[[ "${RELEASE_ID:-}" =~ ^[0-9a-f]{40}$ ]] || die "RELEASE_ID must be the deployed 40-character Git SHA"
[[ "${NOTIFICATION_WORKER_NAME:-}" =~ ^[A-Za-z0-9_.:-]{1,100}$ ]] \
  || die "NOTIFICATION_WORKER_NAME is invalid"
[[ "${NOTIFICATION_POLL_INTERVAL_MS:-}" =~ ^[0-9]+$ ]] \
  || die "NOTIFICATION_POLL_INTERVAL_MS must be a positive integer"
(( NOTIFICATION_POLL_INTERVAL_MS >= 250 && NOTIFICATION_POLL_INTERVAL_MS <= 300000 )) \
  || die "NOTIFICATION_POLL_INTERVAL_MS is outside the supported health-check range"

systemctl is-active --quiet "${WORKER_SERVICE}" || die "reminder worker service is not active"

poll_seconds=$(( (NOTIFICATION_POLL_INTERVAL_MS + 999) / 1000 ))
max_age_seconds=$(( poll_seconds * 3 + 30 ))
connection_env_path="$(mktemp "${TMPDIR:-/tmp}/siyan-settlement-666-worker-pg.XXXXXX")"
cleanup() {
  if [[ -n "${connection_env_path:-}" && -e "${connection_env_path}" ]]; then
    rm -f -- "${connection_env_path}"
  fi
}
trap cleanup EXIT
parse_status=0
DATABASE_URL="${DATABASE_URL}" "${NODE_BIN}" "${DATABASE_URL_PARSER}" > "${connection_env_path}" || parse_status=$?
unset DATABASE_URL
(( parse_status == 0 )) || die "DATABASE_URL could not be parsed"

unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE \
  PGSSLMODE PGSSLCERT PGSSLKEY PGSSLROOTCERT PGSSLCRL PGSSLCRLDIR \
  PGSSLSNI PGSSLPASSWORD PGREQUIREPEER PGCONNECT_TIMEOUT \
  PGTARGETSESSIONATTRS PGCHANNELBINDING PGOPTIONS
exec 8<"${connection_env_path}"
connection_key=""
connection_value=""
connection_keys=()
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
rm -f -- "${connection_env_path}"
connection_env_path=""
for expected_key in PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE; do
  [[ -n "${!expected_key:-}" ]] || die "database URL parser returned incomplete connection details"
done

heartbeat_state="$(
  psql \
    --no-psqlrc --no-password --tuples-only --no-align --quiet --set ON_ERROR_STOP=1 \
    --set worker_name="${NOTIFICATION_WORKER_NAME}" --set release_id="${RELEASE_ID}" \
    --set max_age_seconds="${max_age_seconds}" <<'SQL'
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM notification_worker_heartbeats
  WHERE worker_name = :'worker_name'
    AND release_id = :'release_id'
    AND provider <> 'fake'
    AND last_seen_at >= clock_timestamp() - make_interval(secs => :'max_age_seconds'::integer)
    AND (
      last_error_at IS NULL
      OR last_error_at < clock_timestamp() - make_interval(secs => :'max_age_seconds'::integer)
    )
) THEN 'ok' ELSE 'stale' END;
SQL
)" || die "worker heartbeat query failed"
heartbeat_state="$(printf '%s\n' "${heartbeat_state}" | awk '/^(ok|stale)$/ { print; exit }')"
[[ "${heartbeat_state}" == "ok" ]] || die "current release has no fresh, error-free production worker heartbeat"

printf 'reminder worker heartbeat is healthy\n'
