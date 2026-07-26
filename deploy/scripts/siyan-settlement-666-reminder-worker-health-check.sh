#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly WORKER_SERVICE="siyan-settlement-666-reminder-worker.service"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

for command_name in awk psql systemctl; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command not found: ${command_name}"
done

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
heartbeat_state="$(
  PGDATABASE="${DATABASE_URL}" psql \
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
