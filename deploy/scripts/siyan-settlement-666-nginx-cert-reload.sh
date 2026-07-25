#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

readonly CERTIFICATE_FILE="/etc/letsencrypt/live/123.56.254.236/fullchain.pem"
readonly PRIVATE_KEY_FILE="/etc/letsencrypt/live/123.56.254.236/privkey.pem"
readonly NGINX_CONFIG_FILE="/etc/nginx/conf.d/siyan-settlement-666.conf"
readonly EXPECTED_IP="123.56.254.236"
readonly EXPECTED_PORT="666"
readonly MINIMUM_VALIDITY_SECONDS="86400"
readonly RENEWAL_STAMP_DIR="/var/lib/siyan-settlement-666-tls"
readonly RENEWAL_STAMP_FILE="${RENEWAL_STAMP_DIR}/renewal-last-success"
readonly MONITOR_GROUP="siyan-settlement-666-monitor"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

mode="${1:-}"
[[ $# -le 1 ]] || die "usage: $0 [--check-only]"
[[ -z "${mode}" || "${mode}" == "--check-only" ]] || die "unknown option: ${mode}"

for command_name in nginx openssl sha256sum; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command not found: ${command_name}"
done
if [[ -z "${mode}" ]]; then
  for command_name in chmod chown date getent install mktemp mv rm systemctl timeout; do
    command -v "${command_name}" >/dev/null 2>&1 || die "required command not found: ${command_name}"
  done
  [[ ${EUID} -eq 0 ]] || die "certificate reload hook must run as root"
fi

[[ -r "${CERTIFICATE_FILE}" ]] || die "certificate is not readable: ${CERTIFICATE_FILE}"
[[ -r "${PRIVATE_KEY_FILE}" ]] || die "private key is not readable: ${PRIVATE_KEY_FILE}"
[[ -r "${NGINX_CONFIG_FILE}" ]] || die "Nginx project configuration is not readable: ${NGINX_CONFIG_FILE}"

openssl x509 -in "${CERTIFICATE_FILE}" -noout -checkend "${MINIMUM_VALIDITY_SECONDS}" \
  || die "certificate expires in less than ${MINIMUM_VALIDITY_SECONDS} seconds"

certificate_details="$(openssl x509 -in "${CERTIFICATE_FILE}" -noout -ext subjectAltName)"
[[ "${certificate_details}" == *"IP Address:${EXPECTED_IP}"* ]] \
  || die "certificate subjectAltName does not contain IP ${EXPECTED_IP}"

certificate_key_digest="$(
  openssl x509 -in "${CERTIFICATE_FILE}" -pubkey -noout \
    | openssl pkey -pubin -outform DER \
    | sha256sum
)"
certificate_key_digest="${certificate_key_digest%% *}"
private_key_digest="$(
  openssl pkey -in "${PRIVATE_KEY_FILE}" -pubout -outform DER \
    | sha256sum
)"
private_key_digest="${private_key_digest%% *}"
[[ "${certificate_key_digest}" == "${private_key_digest}" ]] || die "certificate and private key do not match"

nginx_configuration="$(nginx -T 2>&1)" || die "nginx -T failed"
[[ "${nginx_configuration}" == *"configuration file ${NGINX_CONFIG_FILE}:"* ]] \
  || die "${NGINX_CONFIG_FILE} is not included by the active Nginx configuration"

if [[ "${mode}" == "--check-only" ]]; then
  printf 'certificate and Nginx configuration validation passed\n'
  exit 0
fi

systemctl reload nginx.service
systemctl is-active --quiet nginx.service || die "Nginx is not active after reload"

expected_fingerprint="$(openssl x509 -in "${CERTIFICATE_FILE}" -noout -fingerprint -sha256)"
served_certificate="$(
  timeout 10 openssl s_client \
    -connect "127.0.0.1:${EXPECTED_PORT}" \
    -servername "${EXPECTED_IP}" </dev/null 2>/dev/null
)" || die "could not read the certificate served on 127.0.0.1:${EXPECTED_PORT}"
served_fingerprint="$(printf '%s\n' "${served_certificate}" | openssl x509 -noout -fingerprint -sha256)"
[[ "${served_fingerprint}" == "${expected_fingerprint}" ]] \
  || die "Nginx is not serving the renewed certificate on port ${EXPECTED_PORT}"

getent group "${MONITOR_GROUP}" >/dev/null 2>&1 || die "monitor group does not exist: ${MONITOR_GROUP}"
install -d -o root -g "${MONITOR_GROUP}" -m 0750 "${RENEWAL_STAMP_DIR}"
stamp_temp="$(mktemp "${RENEWAL_STAMP_DIR}/.renewal-last-success.XXXXXX")"
cleanup_stamp() {
  if [[ -n "${stamp_temp:-}" && -e "${stamp_temp}" ]]; then
    rm -f -- "${stamp_temp}"
  fi
}
trap cleanup_stamp EXIT
printf 'verified_at=%s\nfingerprint=%s\n' \
  "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "${expected_fingerprint}" > "${stamp_temp}"
chown root:"${MONITOR_GROUP}" "${stamp_temp}"
chmod 0640 "${stamp_temp}"
mv -- "${stamp_temp}" "${RENEWAL_STAMP_FILE}"
stamp_temp=""

printf 'Nginx reloaded and renewed certificate verified on port %s\n' "${EXPECTED_PORT}"
