#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 022

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
readonly REPOSITORY_ROOT

[[ $# -eq 3 ]] || die "usage: $0 OUTPUT_DIR 40_CHAR_GIT_SHA SOURCE_DATE_EPOCH"
output_dir="$1"
release_id="$2"
source_date_epoch="$3"

[[ "${release_id}" =~ ^[0-9a-f]{40}$ ]] || die "release ID must be a lowercase 40-character Git SHA"
[[ "${source_date_epoch}" =~ ^[0-9]+$ ]] || die "SOURCE_DATE_EPOCH must be a non-negative integer"

for command_name in cmp cp find gzip install mktemp mv npm node rm sha256sum sort tar uname xargs; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command not found: ${command_name}"
done

[[ "$(uname -s)" == "Linux" ]] || die "release artifacts must be built on Linux"
[[ "$(node -p 'process.versions.node')" == "24.18.0" ]] || die "release artifacts require Node.js 24.18.0"
[[ "$(npm --version)" == "11.16.0" ]] || die "release artifacts require npm 11.16.0"
tar_version="$(tar --version)"
[[ "${tar_version%%$'\n'*}" == "tar (GNU tar)"* ]] || die "release artifacts require GNU tar"

for required_path in dist/src/server.js dist/src/worker.js dist/src/cli/migrate.js public/index.html migrations deploy package.json package-lock.json; do
  [[ -e "${REPOSITORY_ROOT}/${required_path}" ]] || die "required release input is missing: ${required_path}"
done

install -d -m 0755 "${output_dir}"
output_dir="$(cd -- "${output_dir}" && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/siyan-release-build.XXXXXX")"

cleanup() {
  if [[ -n "${archive_temp:-}" ]]; then
    rm -f -- "${archive_temp}"
  fi
  if [[ -n "${checksum_temp:-}" ]]; then
    rm -f -- "${checksum_temp}"
  fi
  rm -rf -- "${work_dir}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

release_root="${work_dir}/release"
install -d -m 0755 "${release_root}"
install -m 0644 "${REPOSITORY_ROOT}/package.json" "${REPOSITORY_ROOT}/package-lock.json" "${release_root}/"

npm_config_audit=false npm_config_fund=false npm ci --omit=dev --prefix "${release_root}"
cp -a "${REPOSITORY_ROOT}/dist" "${REPOSITORY_ROOT}/public" \
  "${REPOSITORY_ROOT}/migrations" "${REPOSITORY_ROOT}/deploy" "${release_root}/"

for required_path in dist/src/server.js dist/src/worker.js dist/src/cli/migrate.js public/index.html \
  deploy/scripts/siyan-settlement-666-postgres-backup.sh \
  deploy/scripts/siyan-settlement-666-preflight.sh \
  deploy/scripts/siyan-settlement-666-activate-release.sh \
  deploy/scripts/siyan-settlement-666-restore-drill.sh \
  deploy/scripts/siyan-settlement-666-health-check.sh \
  deploy/scripts/siyan-settlement-666-reminder-worker-health-check.sh \
  deploy/scripts/siyan-settlement-666-tls-check.sh \
  deploy/scripts/siyan-settlement-666-alert.sh \
  deploy/scripts/parse-postgres-database-url.mjs \
  deploy/scripts/validate-ops-database-roles.mjs \
  deploy/scripts/validate-restore-target.mjs \
  node_modules/fastify; do
  [[ -e "${release_root}/${required_path}" ]] || die "release output is missing: ${required_path}"
done
for executable_path in \
  deploy/scripts/siyan-settlement-666-postgres-backup.sh \
  deploy/scripts/siyan-settlement-666-preflight.sh \
  deploy/scripts/siyan-settlement-666-activate-release.sh \
  deploy/scripts/siyan-settlement-666-restore-drill.sh \
  deploy/scripts/siyan-settlement-666-health-check.sh \
  deploy/scripts/siyan-settlement-666-reminder-worker-health-check.sh \
  deploy/scripts/siyan-settlement-666-tls-check.sh \
  deploy/scripts/siyan-settlement-666-alert.sh; do
  [[ -x "${release_root}/${executable_path}" ]] \
    || die "release script is not executable: ${executable_path}"
done

manifest_temp="${work_dir}/SHA256SUMS"
(
  cd -- "${release_root}"
  LC_ALL=C find . -type f -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum
) > "${manifest_temp}"
install -m 0644 "${manifest_temp}" "${release_root}/SHA256SUMS"
(
  cd -- "${release_root}"
  sha256sum -c SHA256SUMS >/dev/null
)

archive_name="siyan-settlement-${release_id}.tar.gz"
first_archive="${work_dir}/${archive_name}.first"
second_archive="${work_dir}/${archive_name}.second"

create_archive() {
  local destination="$1"
  tar --sort=name --format=gnu --mtime="@${source_date_epoch}" \
    --owner=0 --group=0 --numeric-owner \
    -C "${release_root}" -cf - . \
    | gzip -n -9 > "${destination}"
}

create_archive "${first_archive}"
create_archive "${second_archive}"
cmp --silent "${first_archive}" "${second_archive}" || die "release archive is not reproducible"

archive_temp="${output_dir}/.${archive_name}.tmp.$$"
checksum_temp="${output_dir}/.${archive_name}.sha256.tmp.$$"
install -m 0644 "${first_archive}" "${archive_temp}"
archive_digest="$(sha256sum "${first_archive}")"
archive_digest="${archive_digest%% *}"
printf '%s  %s\n' "${archive_digest}" "${archive_name}" > "${checksum_temp}"
mv -f -- "${archive_temp}" "${output_dir}/${archive_name}"
archive_temp=""
mv -f -- "${checksum_temp}" "${output_dir}/${archive_name}.sha256"
checksum_temp=""

printf '%s\n' "${output_dir}/${archive_name}" "${output_dir}/${archive_name}.sha256"
