#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly NODE_BIN="/opt/siyan-settlement-666/runtime/node/bin/node"
readonly INTERNAL_URL="http://127.0.0.1:16666/api/health"
readonly PUBLIC_URL="https://123.56.254.236:666/api/health"
readonly PUBLIC_RESOLVE="123.56.254.236:666:127.0.0.1"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

mode="${1:---all}"
[[ $# -le 1 ]] || die "usage: $0 [--all|--internal-only|--tls-only]"
case "${mode}" in
  --all|--internal-only|--tls-only) ;;
  *) die "usage: $0 [--all|--internal-only|--tls-only]" ;;
esac

for command_name in curl mktemp rm; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command not found: ${command_name}"
done
[[ -x "${NODE_BIN}" ]] || die "isolated Node.js executable is not available"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/siyan-health-check.XXXXXX")"
cleanup() {
  rm -rf -- "${work_dir}"
}
trap cleanup EXIT

validate_response() {
  local response_path="$1"
  "${NODE_BIN}" --input-type=module -e '
    import { readFile } from "node:fs/promises";
    const payload = JSON.parse(await readFile(process.argv[1], "utf8"));
    if (payload?.status !== "ok" || Number.isNaN(Date.parse(payload?.time))) process.exit(1);
  ' "${response_path}"
}

check_internal() {
  local response_path="${work_dir}/internal.json"
  curl --fail --silent --show-error --connect-timeout 3 --max-time 10 \
    --max-filesize 65536 --proto '=http' --output "${response_path}" "${INTERNAL_URL}"
  validate_response "${response_path}" || die "internal health response is invalid"
}

check_tls() {
  local response_path="${work_dir}/tls.json"
  curl --fail --silent --show-error --connect-timeout 3 --max-time 10 \
    --max-filesize 65536 --proto '=https' --tlsv1.2 \
    --resolve "${PUBLIC_RESOLVE}" --output "${response_path}" "${PUBLIC_URL}"
  validate_response "${response_path}" || die "TLS health response is invalid"
}

if [[ "${mode}" != "--tls-only" ]]; then
  check_internal
fi
if [[ "${mode}" != "--internal-only" ]]; then
  check_tls
fi

printf 'application health checks passed (%s)\n' "${mode#--}"
