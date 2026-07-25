#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly PROJECT_HOST_MARKER="/etc/siyan-settlement-666/RESTORE_DRILL_HOST"
readonly PRODUCTION_APP_ENV="/etc/siyan-settlement-666/app/app.env"
readonly PRODUCTION_CURRENT="/opt/siyan-settlement-666/current"
readonly NODE_BIN="/opt/siyan-settlement-666/runtime/node/bin/node"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'usage: %s --backup ABSOLUTE_PATH --identity ABSOLUTE_PATH --target-env ABSOLUTE_PATH --release-dir ABSOLUTE_PATH\n' "$0"
}

backup_path=""
identity_path=""
target_env=""
release_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup|--identity|--target-env|--release-dir)
      [[ $# -ge 2 ]] || die "$1 requires a value"
      case "$1" in
        --backup) backup_path="$2" ;;
        --identity) identity_path="$2" ;;
        --target-env) target_env="$2" ;;
        --release-dir) release_dir="$2" ;;
      esac
      shift 2
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

for path_value in "${backup_path}" "${identity_path}" "${target_env}" "${release_dir}"; do
  [[ "${path_value}" == /* ]] || die "all paths must be absolute"
done
[[ ${EUID} -ne 0 ]] || die "restore drill refuses to run as root"
for command_name in age basename dirname find mktemp pg_restore psql readlink rm sha256sum stat; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command not found: ${command_name}"
done
[[ -r "${PROJECT_HOST_MARKER}" ]] || die "isolated restore host marker is missing"
[[ "$(<"${PROJECT_HOST_MARKER}")" == "THIS_HOST_IS_ISOLATED_AND_DISPOSABLE" ]] \
  || die "isolated restore host marker is invalid"
[[ "$(stat -c %u "${PROJECT_HOST_MARKER}")" == "0" ]] \
  || die "isolated restore host marker must be owned by root"
marker_mode="$(stat -c %a "${PROJECT_HOST_MARKER}")"
(( (8#${marker_mode} & 022) == 0 )) || die "isolated restore host marker must not be writable by non-root users"
[[ ! -e "${PRODUCTION_APP_ENV}" && ! -L "${PRODUCTION_APP_ENV}" ]] \
  || die "restore drill refuses to run on an application host"
[[ ! -e "${PRODUCTION_CURRENT}" && ! -L "${PRODUCTION_CURRENT}" ]] \
  || die "restore drill refuses to run where a production current link exists"
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet siyan-settlement-666.service; then
  die "restore drill refuses to run while the production application service is active"
fi
if command -v ss >/dev/null 2>&1 \
    && ss -lntH | awk '$4 ~ /:(666|16666)$/ { found=1 } END { exit !found }'; then
  die "restore drill refuses to run on a host using production ports"
fi

[[ -x "${NODE_BIN}" ]] || die "isolated Node.js executable is unavailable"
node_real_path="$(readlink -f -- "${NODE_BIN}")" || die "isolated Node.js path cannot be resolved"
[[ "${node_real_path}" == /opt/siyan-settlement-666/runtime/* ]] \
  || die "Node.js executable resolves outside the isolated project runtime"
[[ "$("${NODE_BIN}" -p 'process.versions.node')" == "24.18.0" ]] \
  || die "isolated Node.js version must be 24.18.0"
unset node_real_path
[[ -f "${backup_path}" && ! -L "${backup_path}" ]] || die "backup must be a regular file"
[[ -f "${identity_path}" && ! -L "${identity_path}" ]] || die "age identity must be a regular file"
[[ -f "${target_env}" && ! -L "${target_env}" ]] || die "target environment must be a regular file"
[[ -d "${release_dir}" && ! -L "${release_dir}" ]] || die "release directory is invalid"
unsafe_release_path="$(find "${release_dir}" -xdev \( -type f -o -type d \) \
  \( ! -user root -o -perm /022 \) -print -quit)"
[[ -z "${unsafe_release_path}" ]] \
  || die "release files must be root-owned and not writable by group or others"
unset unsafe_release_path
[[ -r "${release_dir}/SHA256SUMS" ]] || die "release manifest is missing"
(
  cd -- "${release_dir}"
  sha256sum -c SHA256SUMS >/dev/null
) || die "release manifest verification failed"
[[ -r "${release_dir}/dist/src/cli/migrate.js" ]] || die "release migration CLI is missing"
[[ -r "${release_dir}/deploy/scripts/parse-postgres-database-url.mjs" ]] || die "database URL parser is missing"
[[ -r "${release_dir}/deploy/scripts/validate-restore-target.mjs" ]] || die "restore target validator is missing"

for private_path in "${backup_path}" "${identity_path}" "${target_env}"; do
  [[ "$(stat -c %u "${private_path}")" == "${EUID}" ]] || die "private drill input must be owned by the drill user"
  mode_value="$(stat -c %a "${private_path}")"
  (( (8#${mode_value} & 077) == 0 )) || die "private drill input must not be accessible by group or others"
done

backup_name="$(basename -- "${backup_path}")"
[[ "${backup_name}" =~ ^siyan-settlement-666-[0-9]{8}T[0-9]{6}Z\.dump\.age$ ]] \
  || die "backup filename does not match the project backup format"
checksum_path="${backup_path}.sha256"
[[ -f "${checksum_path}" && ! -L "${checksum_path}" ]] || die "backup checksum file is missing"
expected_checksum_line="$(<"${checksum_path}")"
[[ "${expected_checksum_line}" =~ ^[0-9a-f]{64}[[:space:]][[:space:]]${backup_name}$ ]] \
  || die "checksum file must contain exactly the selected backup filename"
(
  cd -- "$(dirname -- "${backup_path}")"
  sha256sum -c -- "$(basename -- "${checksum_path}")"
) >/dev/null || die "encrypted backup checksum verification failed"

target_database_url=""
target_count=0
while IFS= read -r line || [[ -n "${line}" ]]; do
  [[ -z "${line}" || "${line}" == \#* ]] && continue
  if [[ "${line}" == DATABASE_URL=* ]]; then
    target_database_url="${line#DATABASE_URL=}"
    target_count=$((target_count + 1))
  else
    die "target environment may only contain DATABASE_URL"
  fi
done < "${target_env}"
(( target_count == 1 )) || die "target environment must contain exactly one DATABASE_URL"
[[ -n "${target_database_url}" ]] || die "restore DATABASE_URL is empty"
RESTORE_DATABASE_URL="${target_database_url}" \
  "${NODE_BIN}" "${release_dir}/deploy/scripts/validate-restore-target.mjs"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/siyan-restore-drill.XXXXXX")"
connection_env_path="${work_dir}/connection.env"
cleanup() {
  unset DATABASE_URL RESTORE_DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGOPTIONS
  rm -rf -- "${work_dir}"
}
trap cleanup EXIT

DATABASE_URL="${target_database_url}" \
  "${NODE_BIN}" "${release_dir}/deploy/scripts/parse-postgres-database-url.mjs" > "${connection_env_path}"
unset DATABASE_URL
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
if IFS= read -r -d '' _ <&8; then
  die "restore DATABASE_URL must not contain connection options"
fi
exec 8<&-
rm -f -- "${connection_env_path}"

role_and_table_state="$(
  PGOPTIONS='-c default_transaction_read_only=on' \
    psql --no-psqlrc --no-password --tuples-only --no-align --set ON_ERROR_STOP=1 <<'SQL'
SELECT concat_ws('|', current_database(), current_user, role.rolsuper, role.rolcreatedb,
  role.rolcreaterole, role.rolreplication, role.rolbypassrls,
  (SELECT count(*) FROM pg_class item
   JOIN pg_namespace namespace ON namespace.oid = item.relnamespace
   WHERE namespace.nspname NOT LIKE 'pg_%'
     AND namespace.nspname <> 'information_schema'
     AND item.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')))
FROM pg_roles role
WHERE role.rolname = current_user;
SQL
)" || die "restore target safety query failed"
expected_state="${PGDATABASE}|${PGUSER}|f|f|f|f|f|0"
[[ "${role_and_table_state}" == "${expected_state}" ]] \
  || die "restore target must be empty and use a non-privileged dedicated role"

age --decrypt -i "${identity_path}" "${backup_path}" | pg_restore --list >/dev/null \
  || die "encrypted backup cannot be decrypted or parsed"
age --decrypt -i "${identity_path}" "${backup_path}" \
  | pg_restore --exit-on-error --single-transaction --no-owner --no-privileges \
      --dbname "${PGDATABASE}" \
  || die "restore failed"

DATABASE_URL="${target_database_url}" NODE_ENV=production HOST=127.0.0.1 PORT=17666 \
  PUBLIC_ORIGIN=https://127.0.0.1:17666 SEED_DEMO=false \
  "${NODE_BIN}" "${release_dir}/dist/src/cli/migrate.js"
unset DATABASE_URL

PGOPTIONS='-c default_transaction_read_only=on' \
  psql --no-psqlrc --no-password --set ON_ERROR_STOP=1 <<'SQL'
SELECT current_database() AS restored_database, current_user AS restore_user;
SELECT count(*) AS tenants FROM tenants;
SELECT count(*) AS orders, COALESCE(sum(total_cents), 0) AS order_total_cents FROM orders;
SELECT count(*) AS payments, COALESCE(sum(amount_cents), 0) AS payment_total_cents FROM payments;
SELECT count(*) AS audit_logs FROM audit_logs;
SQL

unset "${connection_keys[@]}"
printf 'restore drill completed; the isolated target database was not dropped or modified outside the restore\n'
