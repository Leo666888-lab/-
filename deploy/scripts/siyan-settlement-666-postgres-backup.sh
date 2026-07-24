#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly BACKUP_DIR="/var/backups/siyan-settlement-666"
readonly RECIPIENT_FILE="/etc/siyan-settlement-666/backup.age-recipient"
readonly RCLONE_CONFIG_FILE="/etc/siyan-settlement-666/rclone.conf"
readonly LOCK_FILE="${BACKUP_DIR}/.backup.lock"
readonly BACKUP_PREFIX="siyan-settlement-666"

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

[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL is not set"
[[ -n "${BACKUP_REMOTE:-}" ]] || die "BACKUP_REMOTE is not set"
[[ "${BACKUP_REMOTE}" =~ ^[A-Za-z0-9._-]+:.+ ]] || die "BACKUP_REMOTE must be an rclone remote path"
[[ -d "${BACKUP_DIR}" ]] || die "backup directory does not exist: ${BACKUP_DIR}"
[[ -w "${BACKUP_DIR}" ]] || die "backup directory is not writable: ${BACKUP_DIR}"
[[ -r "${RECIPIENT_FILE}" ]] || die "age recipient file is not readable: ${RECIPIENT_FILE}"
[[ -r "${RCLONE_CONFIG_FILE}" ]] || die "rclone configuration is not readable: ${RCLONE_CONFIG_FILE}"

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

cleanup() {
  if [[ -n "${partial_path:-}" && -e "${partial_path}" ]]; then
    rm -f -- "${partial_path}"
  fi
  if [[ -n "${checksum_partial:-}" && -e "${checksum_partial}" ]]; then
    rm -f -- "${checksum_partial}"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# libpq accepts a connection URI in PGDATABASE. Keeping it out of argv avoids
# exposing database credentials in the process command line.
export PGDATABASE="${DATABASE_URL}"
export PGAPPNAME="siyan-settlement-666-backup"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}"
unset DATABASE_URL

log "starting encrypted PostgreSQL backup"
if ! pg_dump --format=custom --compress=9 --no-owner --no-privileges --no-password \
  | age --encrypt --recipient "${age_recipient}" > "${partial_path}"; then
  die "pg_dump or age encryption failed"
fi

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

log "backup completed: $(basename "${final_path}")"
