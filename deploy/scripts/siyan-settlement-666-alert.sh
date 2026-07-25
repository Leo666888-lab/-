#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly STATE_DIR="/var/lib/siyan-settlement-666-monitor"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ $# -eq 1 ]] || die "usage: $0 SYSTEMD_UNIT"
unit_name="$1"
[[ "${unit_name}" =~ ^[A-Za-z0-9_.@:-]{1,200}$ ]] || die "invalid systemd unit name"

[[ -d "${STATE_DIR}" && -w "${STATE_DIR}" ]] || die "monitor state directory is not writable"
[[ -n "${ALERT_WEBHOOK_URL:-}" ]] || die "ALERT_WEBHOOK_URL is not configured"
[[ "${ALERT_WEBHOOK_URL}" =~ ^https://[^[:space:]\"\\]+$ ]] || die "ALERT_WEBHOOK_URL must be an HTTPS URL"

cooldown_seconds="${ALERT_COOLDOWN_SECONDS:-900}"
[[ "${cooldown_seconds}" =~ ^[0-9]+$ ]] || die "ALERT_COOLDOWN_SECONDS must be an integer"
(( cooldown_seconds >= 60 && cooldown_seconds <= 86400 )) \
  || die "ALERT_COOLDOWN_SECONDS must be between 60 and 86400"

for command_name in curl date flock hostname mv mktemp rm stat; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command not found: ${command_name}"
done

request_config="$(mktemp "${STATE_DIR}/.alert-request.XXXXXX")"
cleanup() {
  if [[ -n "${request_config:-}" && -e "${request_config}" ]]; then
    rm -f -- "${request_config}"
  fi
}
trap cleanup EXIT
printf 'url = "%s"\n' "${ALERT_WEBHOOK_URL}" > "${request_config}"
if [[ -n "${ALERT_WEBHOOK_BEARER_TOKEN:-}" ]]; then
  [[ "${ALERT_WEBHOOK_BEARER_TOKEN}" =~ ^[A-Za-z0-9._~+/=-]+$ ]] \
    || die "ALERT_WEBHOOK_BEARER_TOKEN contains unsupported characters"
  printf 'header = "Authorization: Bearer %s"\n' \
    "${ALERT_WEBHOOK_BEARER_TOKEN}" >> "${request_config}"
fi

safe_name="${unit_name//[^A-Za-z0-9_.@-]/_}"
stamp_path="${STATE_DIR}/${safe_name}.last-alert"
lock_path="${STATE_DIR}/${safe_name}.alert.lock"
exec 9>"${lock_path}"
flock -x 9

now_epoch="$(date +%s)"
if [[ -f "${stamp_path}" ]]; then
  stamp_epoch="$(stat -c %Y "${stamp_path}")"
  if (( now_epoch >= stamp_epoch && now_epoch - stamp_epoch < cooldown_seconds )); then
    printf 'alert suppressed by cooldown for %s\n' "${unit_name}"
    exit 0
  fi
fi

host_name="$(hostname -f 2>/dev/null || hostname)"
occurred_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
curl_arguments=(
  --fail
  --silent
  --show-error
  --output /dev/null
  --connect-timeout 5
  --max-time 15
  --retry 2
  --retry-all-errors
  --proto '=https'
  --request POST
  --header 'Content-Type: application/x-www-form-urlencoded'
  --data-urlencode 'project=siyan-settlement-666'
  --data-urlencode "unit=${unit_name}"
  --data-urlencode "host=${host_name}"
  --data-urlencode "occurred_at=${occurred_at}"
  --data-urlencode 'message=systemd unit failed; inspect the unit journal immediately'
)
curl "${curl_arguments[@]}" --config "${request_config}"
rm -f -- "${request_config}"
request_config=""
stamp_temp="$(mktemp "${STATE_DIR}/.${safe_name}.last-alert.XXXXXX")"
printf '%s\n' "${occurred_at}" > "${stamp_temp}"
mv -- "${stamp_temp}" "${stamp_path}"
printf 'alert delivered for %s\n' "${unit_name}"
