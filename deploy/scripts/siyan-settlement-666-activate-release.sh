#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly INSTALL_ROOT="/opt/siyan-settlement-666"
readonly RELEASES_ROOT="${INSTALL_ROOT}/releases"
readonly CURRENT_LINK="${INSTALL_ROOT}/current"
readonly SYSTEMD_UNIT_DIR="/etc/systemd/system"
readonly DEPLOY_LOCK="/run/lock/siyan-settlement-666-deploy.lock"
readonly APP_UNIT="siyan-settlement-666.service"
readonly WORKER_UNIT="siyan-settlement-666-reminder-worker.service"
readonly WORKER_HEARTBEAT_SERVICE="siyan-settlement-666-reminder-worker-health-check.service"
readonly WORKER_HEARTBEAT_TIMER="siyan-settlement-666-reminder-worker-health-check.timer"
readonly HEALTH_CHECK_RELATIVE="deploy/scripts/siyan-settlement-666-health-check.sh"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
usage:
  siyan-settlement-666-activate-release.sh --release-dir \
    /opt/siyan-settlement-666/releases/<40-char-git-sha>
  siyan-settlement-666-activate-release.sh --validate-units-only \
    --release-dir <absolute-path> [--installed-unit-dir <absolute-path>]

The normal mode atomically activates a verified release and restarts the
application and any previously enabled reminder worker. It never rolls back
the current link after a database migration; a failed post-switch release is
left in place for a forward fix or a coordinated database restore.
USAGE
}

release_dir=""
validate_units_only=false
installed_unit_dir="${SYSTEMD_UNIT_DIR}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release-dir)
      [[ $# -ge 2 ]] || die "--release-dir requires a value"
      release_dir="$2"
      shift 2
      ;;
    --installed-unit-dir)
      [[ $# -ge 2 ]] || die "--installed-unit-dir requires a value"
      installed_unit_dir="$2"
      shift 2
      ;;
    --validate-units-only)
      validate_units_only=true
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

[[ -n "${release_dir}" ]] || {
  usage >&2
  die "--release-dir is required"
}
[[ "${release_dir}" == /* ]] || die "--release-dir must be an absolute path"
[[ "${installed_unit_dir}" == /* ]] || die "--installed-unit-dir must be an absolute path"
if [[ "${validate_units_only}" != true ]]; then
  [[ "${release_dir}" =~ ^${RELEASES_ROOT}/[0-9a-f]{40}$ ]] \
    || die "release directory must be /opt/siyan-settlement-666/releases/<40-char-lowercase-git-sha>"
  [[ "${installed_unit_dir}" == "${SYSTEMD_UNIT_DIR}" ]] \
    || die "--installed-unit-dir is only available with --validate-units-only"
  [[ ${EUID} -eq 0 ]] || die "release activation must run as root"
else
  [[ -d "${release_dir}" && ! -L "${release_dir}" ]] \
    || die "release directory is missing or is a symbolic link"
fi

for command_name in cmp find sort; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command not found: ${command_name}"
done

validate_units() {
  local release_systemd_dir="${release_dir}/deploy/systemd"
  [[ -d "${release_systemd_dir}" && ! -L "${release_systemd_dir}" ]] \
    || die "release systemd directory is missing"
  [[ -d "${installed_unit_dir}" && ! -L "${installed_unit_dir}" ]] \
    || die "installed systemd unit directory is missing"

  local -a release_units=()
  local -a installed_units=()
  local unit_path unit_name
  while IFS= read -r unit_path; do
    release_units+=("${unit_path##*/}")
  done < <(
    find "${release_systemd_dir}" -maxdepth 1 -type f \
      \( -name 'siyan-settlement-666*.service' -o -name 'siyan-settlement-666*.timer' \) \
      -print | LC_ALL=C sort
  )
  ((${#release_units[@]} > 0)) || die "release contains no project systemd service or timer units"

  while IFS= read -r unit_path; do
    installed_units+=("${unit_path##*/}")
  done < <(
    find "${installed_unit_dir}" -maxdepth 1 \( -type f -o -type l \) \
      \( -name 'siyan-settlement-666*.service' -o -name 'siyan-settlement-666*.timer' \) \
      -print | LC_ALL=C sort
  )

  while IFS= read -r unit_path; do
    die "installed systemd override or wants link is not allowed: ${unit_path}"
  done < <(
    find "${installed_unit_dir}" -maxdepth 1 -type d \
      \( -name 'siyan-settlement-666*.service.d' -o -name 'siyan-settlement-666*.timer.d' \
         -o -name 'siyan-settlement-666*.service.wants' -o -name 'siyan-settlement-666*.timer.wants' \) \
      -print | LC_ALL=C sort
  )

  unit_in_release() {
    local candidate="$1"
    local expected
    for expected in "${release_units[@]}"; do
      [[ "${expected}" == "${candidate}" ]] && return 0
    done
    return 1
  }

  for unit_name in "${release_units[@]}"; do
    [[ "${unit_name}" =~ ^siyan-settlement-666[A-Za-z0-9_.@:-]*\.(service|timer)$ ]] \
      || die "release contains an invalid project unit name: ${unit_name}"
    unit_path="${installed_unit_dir}/${unit_name}"
    [[ -e "${unit_path}" ]] || die "installed systemd unit is missing: ${unit_name}"
    [[ -f "${unit_path}" && ! -L "${unit_path}" ]] \
      || die "installed systemd unit must be a regular file: ${unit_name}"
    cmp --silent "${release_systemd_dir}/${unit_name}" "${unit_path}" \
      || die "installed systemd unit differs from release: ${unit_name}"
  done

  for unit_name in "${installed_units[@]}"; do
    unit_in_release "${unit_name}" \
      || die "installed project systemd unit is not present in release: ${unit_name}"
  done
  printf 'systemd unit files match release (%s)\n' "${release_dir}"
}

validate_units
[[ "${validate_units_only}" == true ]] && exit 0

for command_name in flock ln mv readlink rm sha256sum stat systemctl; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command not found: ${command_name}"
done
[[ -d "${RELEASES_ROOT}" && ! -L "${RELEASES_ROOT}" ]] || die "release root is missing"
[[ -d "${release_dir}" && ! -L "${release_dir}" ]] || die "release directory is missing or is a symbolic link"
[[ -r "${release_dir}/SHA256SUMS" ]] || die "release checksum manifest is missing"
(
  cd -- "${release_dir}"
  sha256sum -c SHA256SUMS >/dev/null
) || die "release manifest verification failed"
[[ -r "${release_dir}/${HEALTH_CHECK_RELATIVE}" ]] \
  || die "release health check script is missing"
[[ -x "${release_dir}/${HEALTH_CHECK_RELATIVE}" ]] \
  || die "release health check script is not executable"

[[ -d "$(dirname -- "${DEPLOY_LOCK}")" ]] || die "deployment lock directory is missing"
exec 9>"${DEPLOY_LOCK}"
flock -n 9 || die "another release activation is already running"

current_target=""
if [[ -e "${CURRENT_LINK}" || -L "${CURRENT_LINK}" ]]; then
  [[ -L "${CURRENT_LINK}" ]] || die "current must be absent or a symbolic link"
  current_target="$(readlink -f -- "${CURRENT_LINK}" 2>/dev/null || true)"
  [[ "${current_target}" == "${RELEASES_ROOT}"/* ]] \
    || die "current points outside the isolated releases directory"
fi

worker_was_enabled=false
worker_was_active=false
heartbeat_timer_was_enabled=false
heartbeat_timer_was_active=false
heartbeat_service_was_active=false
stopped_worker=false
stopped_heartbeat_timer=false
stopped_heartbeat_service=false
switched=false
next_link="${INSTALL_ROOT}/.current-${release_dir##*/}.$$"

is_enabled() { systemctl is-enabled --quiet "$1"; }
is_active() { systemctl is-active --quiet "$1"; }

assert_unit_uses_release() {
  local unit_name="$1"
  local main_pid
  local process_cwd
  main_pid="$(systemctl show -p MainPID --value "${unit_name}")"
  [[ "${main_pid}" =~ ^[1-9][0-9]*$ ]] || die "${unit_name} has no running MainPID"
  [[ -r "/proc/${main_pid}/cwd" ]] || die "cannot inspect ${unit_name} process cwd"
  process_cwd="$(readlink -f -- "/proc/${main_pid}/cwd" 2>/dev/null || true)"
  [[ "${process_cwd}" == "${release_dir}" ]] \
    || die "${unit_name} is not running from the activated release"
}

if is_enabled "${WORKER_UNIT}"; then worker_was_enabled=true; fi
if is_active "${WORKER_UNIT}"; then worker_was_active=true; fi
if is_enabled "${WORKER_HEARTBEAT_TIMER}"; then heartbeat_timer_was_enabled=true; fi
if is_active "${WORKER_HEARTBEAT_TIMER}"; then heartbeat_timer_was_active=true; fi
if is_active "${WORKER_HEARTBEAT_SERVICE}"; then heartbeat_service_was_active=true; fi

on_exit() {
  local exit_code=$?
  trap - EXIT
  rm -f -- "${next_link}" 2>/dev/null || true
  if ((exit_code != 0)); then
    set +e
    if [[ "${switched}" != true ]]; then
      if [[ "${stopped_heartbeat_service}" == true ]]; then
        systemctl start "${WORKER_HEARTBEAT_SERVICE}" >/dev/null 2>&1 || true
      fi
      if [[ "${stopped_heartbeat_timer}" == true ]]; then
        systemctl start "${WORKER_HEARTBEAT_TIMER}" >/dev/null 2>&1 || true
      fi
      if [[ "${stopped_worker}" == true ]]; then
        systemctl start "${WORKER_UNIT}" >/dev/null 2>&1 || true
      fi
      printf 'ERROR: activation failed before switching current; previously active services were restored where possible\n' >&2
    else
      systemctl stop "${WORKER_HEARTBEAT_SERVICE}" >/dev/null 2>&1 || true
      systemctl stop "${WORKER_HEARTBEAT_TIMER}" >/dev/null 2>&1 || true
      systemctl stop "${WORKER_UNIT}" >/dev/null 2>&1 || true
      systemctl stop "${APP_UNIT}" >/dev/null 2>&1 || true
      printf 'ERROR: post-switch health failed; current remains %s\n' "${release_dir}" >&2
      printf 'ERROR: do not switch back automatically after migrations; apply a forward fix or coordinate a database restore plus a schema-compatible code rollback\n' >&2
    fi
  fi
  exit "${exit_code}"
}
trap on_exit EXIT

systemctl daemon-reload

while IFS= read -r unit_path; do
  unit_name="${unit_path##*/}"
  fragment_path="$(systemctl show -p FragmentPath --value "${unit_name}")"
  [[ "${fragment_path}" == "${SYSTEMD_UNIT_DIR}/${unit_name}" ]] \
    || die "systemd loaded an unexpected fragment for ${unit_name}"
  dropin_paths="$(systemctl show -p DropInPaths --value "${unit_name}")"
  [[ -z "${dropin_paths}" ]] || die "systemd loaded a drop-in for ${unit_name}"
  installed_metadata="$(stat -c '%U:%G:%a' "${SYSTEMD_UNIT_DIR}/${unit_name}")"
  [[ "${installed_metadata}" == "root:root:644" ]] \
    || die "unsafe owner or mode for installed systemd unit: ${unit_name}"
done < <(
  find "${release_dir}/deploy/systemd" -maxdepth 1 -type f \
    \( -name 'siyan-settlement-666*.service' -o -name 'siyan-settlement-666*.timer' \) \
    -print | LC_ALL=C sort
)

if [[ "${heartbeat_service_was_active}" == true ]]; then
  stopped_heartbeat_service=true
  systemctl stop "${WORKER_HEARTBEAT_SERVICE}"
fi
if [[ "${heartbeat_timer_was_active}" == true ]]; then
  stopped_heartbeat_timer=true
  systemctl stop "${WORKER_HEARTBEAT_TIMER}"
fi
if [[ "${worker_was_active}" == true ]]; then
  stopped_worker=true
  systemctl stop "${WORKER_UNIT}"
fi

[[ ! -e "${next_link}" && ! -L "${next_link}" ]] || die "temporary current link already exists"
ln -s -- "${release_dir}" "${next_link}"
mv -Tf -- "${next_link}" "${CURRENT_LINK}"
switched=true

systemctl enable "${APP_UNIT}"
systemctl restart "${APP_UNIT}"
"${release_dir}/${HEALTH_CHECK_RELATIVE}" --all
is_active "${APP_UNIT}" || die "application service is not active after health check"
assert_unit_uses_release "${APP_UNIT}"

if [[ "${worker_was_enabled}" == true || "${worker_was_active}" == true ]]; then
  systemctl restart "${WORKER_UNIT}"
  is_active "${WORKER_UNIT}" || die "reminder worker is not active after restart"
  assert_unit_uses_release "${WORKER_UNIT}"
fi
if [[ "${heartbeat_timer_was_enabled}" == true || "${heartbeat_timer_was_active}" == true ]]; then
  systemctl restart "${WORKER_HEARTBEAT_TIMER}"
  is_active "${WORKER_HEARTBEAT_TIMER}" || die "reminder worker heartbeat timer is not active after restart"
fi

printf 'release activated: %s\n' "${release_dir}"
