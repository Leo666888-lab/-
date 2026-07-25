#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly BACKUP_DIR="/var/backups/siyan-settlement-666"
readonly BACKUP_STATE_DIR="/var/lib/siyan-settlement-666-backup"
readonly RECIPIENT_FILE="/etc/siyan-settlement-666/backup/backup.age-recipient"
readonly RCLONE_CONFIG_FILE="/etc/siyan-settlement-666/backup/rclone.conf"
readonly LOCK_FILE="${BACKUP_DIR}/.backup.lock"
readonly BACKUP_PREFIX="siyan-settlement-666"
readonly SUCCESS_STAMP="${BACKUP_STATE_DIR}/last-success"
readonly NODE_BIN="/opt/siyan-settlement-666/runtime/node/bin/node"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
readonly DATABASE_URL_PARSER="${SCRIPT_DIR}/parse-postgres-database-url.mjs"

log() {
  printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

for command_name in age flock pg_dump rclone sha256sum; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command not found: ${command_name}"
done
[[ -x "${NODE_BIN}" ]] || die "isolated Node.js executable is not available: ${NODE_BIN}"
[[ -r "${DATABASE_URL_PARSER}" ]] || die "database URL parser is not readable: ${DATABASE_URL_PARSER}"

[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL is not set"
[[ -n "${BACKUP_REMOTE:-}" ]] || die "BACKUP_REMOTE is not set"
[[ "${BACKUP_REMOTE}" =~ ^[A-Za-z0-9._-]+:.+ ]] || die "BACKUP_REMOTE must be an rclone remote path"
[[ -d "${BACKUP_DIR}" ]] || die "backup directory does not exist: ${BACKUP_DIR}"
[[ -w "${BACKUP_DIR}" ]] || die "backup directory is not writable: ${BACKUP_DIR}"
[[ -d "${BACKUP_STATE_DIR}" ]] || die "backup state directory does not exist: ${BACKUP_STATE_DIR}"
[[ -w "${BACKUP_STATE_DIR}" ]] || die "backup state directory is not writable: ${BACKUP_STATE_DIR}"
[[ -r "${RECIPIENT_FILE}" ]] || die "age recipient file is not readable: ${RECIPIENT_FILE}"
[[ -r "${RCLONE_CONFIG_FILE}" ]] || die "rclone configuration is not readable: ${RCLONE_CONFIG_FILE}"

connection_env_path=""
partial_path=""
checksum_partial=""
stamp_partial=""

cleanup() {
  if [[ -n "${connection_env_path:-}" && -e "${connection_env_path}" ]]; then
    rm -f -- "${connection_env_path}"
  fi
  if [[ -n "${partial_path:-}" && -e "${partial_path}" ]]; then
    rm -f -- "${partial_path}"
  fi
  if [[ -n "${checksum_partial:-}" && -e "${checksum_partial}" ]]; then
    rm -f -- "${checksum_partial}"
  fi
  if [[ -n "${stamp_partial:-}" && -e "${stamp_partial}" ]]; then
    rm -f -- "${stamp_partial}"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

connection_env_path="$(mktemp "${BACKUP_DIR}/.${BACKUP_PREFIX}.connection.XXXXXX")"
parse_status=0
"${NODE_BIN}" "${DATABASE_URL_PARSER}" > "${connection_env_path}" || parse_status=$?
unset DATABASE_URL
(( parse_status == 0 )) || die "DATABASE_URL could not be parsed"

exec 8<"${connection_env_path}"
connection_keys=()
for expected_key in PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE; do
  IFS= read -r -d '' connection_key <&8 || die "database URL parser returned incomplete output"
  IFS= read -r -d '' connection_value <&8 || die "database URL parser returned incomplete output"
  [[ "${connection_key}" == "${expected_key}" ]] || die "database URL parser returned unexpected output"
  printf -v "${connection_key}" '%s' "${connection_value}"
  export "${connection_key?}"
  connection_keys+=("${connection_key}")
done

while :; do
  connection_key=""
  if ! IFS= read -r -d '' connection_key <&8; then
    [[ -z "${connection_key}" ]] || die "database URL parser returned incomplete output"
    break
  fi
  IFS= read -r -d '' connection_value <&8 || die "database URL parser returned incomplete output"
  case "${connection_key}" in
    PGSSLMODE|PGSSLCERT|PGSSLKEY|PGSSLROOTCERT|PGSSLCRL|PGSSLCRLDIR|PGSSLSNI|PGSSLPASSWORD|PGREQUIREPEER|PGCONNECT_TIMEOUT|PGTARGETSESSIONATTRS|PGCHANNELBINDING|PGOPTIONS) ;;
    *) die "database URL parser returned an unsupported connection option" ;;
  esac
  for existing_key in "${connection_keys[@]}"; do
    [[ "${existing_key}" != "${connection_key}" ]] || die "database URL parser returned a duplicate connection option"
  done
  printf -v "${connection_key}" '%s' "${connection_value}"
  export "${connection_key?}"
  connection_keys+=("${connection_key}")
done
exec 8<&-
rm -f -- "${connection_env_path}"
connection_env_path=""
unset connection_key connection_value expected_key existing_key

retention_days="${BACKUP_RETENTION_DAYS:-30}"
[[ "${retention_days}" =~ ^[0-9]+$ ]] || die "BACKUP_RETENTION_DAYS must be an integer"
(( retention_days >= 7 && retention_days <= 3650 )) || die "BACKUP_RETENTION_DAYS must be between 7 and 3650"

age_recipient="$(tr -d '[:space:]' < "${RECIPIENT_FILE}")"
[[ "${age_recipient}" == age1* ]] || die "backup.age-recipient does not contain an age public recipient"

exec 9>"${LOCK_FILE}"
flock -n 9 || die "another backup is already running"

timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
final_path="${BACKUP_DIR}/${BACKUP_PREFIX}-${timestamp}.dump.age"
checksum_path="${final_path}.sha256"
[[ ! -e "${final_path}" && ! -e "${checksum_path}" ]] || die "backup name collision: ${timestamp}"

partial_path="$(mktemp "${BACKUP_DIR}/.${BACKUP_PREFIX}-${timestamp}.XXXXXX.partial")"
checksum_partial="$(mktemp "${BACKUP_DIR}/.${BACKUP_PREFIX}-${timestamp}.XXXXXX.sha256.partial")"
export PGAPPNAME="siyan-settlement-666-backup"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}"

log "starting encrypted PostgreSQL backup"
backup_status=0
pg_dump --format=custom --compress=9 --no-owner --no-privileges --no-password \
  | age --encrypt --recipient "${age_recipient}" > "${partial_path}" || backup_status=$?
unset "${connection_keys[@]}" PGAPPNAME PGCONNECT_TIMEOUT
unset connection_keys
(( backup_status == 0 )) || die "pg_dump or age encryption failed"

[[ -s "${partial_path}" ]] || die "backup output is empty"
chmod 0600 "${partial_path}"

digest="$(sha256sum "${partial_path}")"
digest="${digest%% *}"
printf '%s  %s\n' "${digest}" "$(basename "${final_path}")" > "${checksum_partial}"
chmod 0600 "${checksum_partial}"

mv -- "${partial_path}" "${final_path}"
partial_path=""
mv -- "${checksum_partial}" "${checksum_path}"
checksum_partial=""

# Copy every locally retained encrypted backup so a previous transient upload
# failure is retried automatically. Remote deletion is controlled separately
# by the object store's immutable retention policy.
log "syncing encrypted backups to offsite storage"
rclone copy "${BACKUP_DIR}" "${BACKUP_REMOTE}" \
  --config "${RCLONE_CONFIG_FILE}" \
  --cache-dir "${BACKUP_DIR}/.rclone-cache" \
  --include "${BACKUP_PREFIX}-*.dump.age" \
  --include "${BACKUP_PREFIX}-*.dump.age.sha256" \
  --immutable \
  --transfers 2 \
  --checkers 4 \
  --retries 5 \
  --low-level-retries 10

log "verifying newest offsite backup by downloading and comparing encrypted bytes"
rclone check "${BACKUP_DIR}" "${BACKUP_REMOTE}" \
  --config "${RCLONE_CONFIG_FILE}" \
  --cache-dir "${BACKUP_DIR}/.rclone-cache" \
  --include "$(basename "${final_path}")" \
  --include "$(basename "${checksum_path}")" \
  --one-way \
  --download \
  --checkers 2 \
  --retries 5 \
  --low-level-retries 10

find "${BACKUP_DIR}" -xdev -type f \
  \( -name "${BACKUP_PREFIX}-*.dump.age" -o -name "${BACKUP_PREFIX}-*.dump.age.sha256" \) \
  -mtime "+${retention_days}" -delete

stamp_partial="$(mktemp "${BACKUP_STATE_DIR}/.last-success.XXXXXX")"
printf 'completed_at=%s\nbackup=%s\nfingerprint=%s\n' \
  "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$(basename "${final_path}")" "${digest}" \
  > "${stamp_partial}"
chmod 0600 "${stamp_partial}"
mv -- "${stamp_partial}" "${SUCCESS_STAMP}"
stamp_partial=""

log "backup completed: $(basename "${final_path}")"
