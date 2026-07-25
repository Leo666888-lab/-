#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

readonly CERTIFICATE_FILE="/etc/letsencrypt/live/123.56.254.236/fullchain.pem"
readonly EXPECTED_IP="123.56.254.236"
readonly EXPECTED_PORT="666"
readonly RENEWAL_HOOK="/etc/letsencrypt/renewal-hooks/deploy/siyan-settlement-666-nginx-cert-reload"
readonly RENEWAL_STAMP="/var/lib/siyan-settlement-666-tls/renewal-last-success"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

mode="${1:---live}"
[[ $# -le 1 ]] || die "usage: $0 [--live|--certificate-only]"
case "${mode}" in
  --live|--certificate-only) ;;
  *) die "usage: $0 [--live|--certificate-only]" ;;
esac

for command_name in date openssl sed sha256sum; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command not found: ${command_name}"
done
[[ -r "${CERTIFICATE_FILE}" ]] || die "certificate is not readable"

minimum_validity="${TLS_MIN_VALIDITY_SECONDS:-1209600}"
[[ "${minimum_validity}" =~ ^[0-9]+$ ]] || die "TLS_MIN_VALIDITY_SECONDS must be an integer"
(( minimum_validity >= 86400 && minimum_validity <= 7776000 )) \
  || die "TLS_MIN_VALIDITY_SECONDS must be between 86400 and 7776000"

openssl x509 -in "${CERTIFICATE_FILE}" -noout -checkend "${minimum_validity}" \
  || die "certificate expires inside the configured safety window"
certificate_details="$(openssl x509 -in "${CERTIFICATE_FILE}" -noout -ext subjectAltName)"
[[ "${certificate_details}" == *"IP Address:${EXPECTED_IP}"* ]] \
  || die "certificate subjectAltName does not contain the expected IP"
expected_fingerprint="$(openssl x509 -in "${CERTIFICATE_FILE}" -noout -fingerprint -sha256)"

if [[ "${mode}" == "--certificate-only" ]]; then
  printf 'certificate validity and IP SAN checks passed\n'
  exit 0
fi

for command_name in stat systemctl timeout; do
  command -v "${command_name}" >/dev/null 2>&1 || die "required command not found: ${command_name}"
done
[[ -x "${RENEWAL_HOOK}" ]] || die "certificate renewal hook is not installed"
[[ -r "${RENEWAL_STAMP}" ]] || die "successful renewal evidence stamp is missing"

stamp_fingerprint="$(sed -n 's/^fingerprint=//p' "${RENEWAL_STAMP}")"
[[ -n "${stamp_fingerprint}" && "${stamp_fingerprint}" == "${expected_fingerprint}" ]] \
  || die "renewal evidence does not match the current certificate"
renewal_max_age="${TLS_RENEWAL_MAX_AGE_SECONDS:-6048000}"
[[ "${renewal_max_age}" =~ ^[0-9]+$ ]] || die "TLS_RENEWAL_MAX_AGE_SECONDS must be an integer"
(( renewal_max_age >= 86400 && renewal_max_age <= 7776000 )) \
  || die "TLS_RENEWAL_MAX_AGE_SECONDS must be between 86400 and 7776000"
now_epoch="$(date +%s)"
stamp_epoch="$(stat -c %Y "${RENEWAL_STAMP}")"
(( stamp_epoch <= now_epoch + 300 )) || die "renewal evidence timestamp is in the future"
(( now_epoch - stamp_epoch <= renewal_max_age )) || die "renewal evidence is too old"

renewal_timer="${TLS_RENEWAL_TIMER:-certbot-ip-renew.timer}"
[[ "${renewal_timer}" =~ ^[A-Za-z0-9_.@-]+\.timer$ ]] || die "TLS_RENEWAL_TIMER is invalid"
systemctl is-enabled --quiet "${renewal_timer}" || die "certificate renewal timer is not enabled"
systemctl is-active --quiet "${renewal_timer}" || die "certificate renewal timer is not active"

served_certificate="$(
  timeout 10 openssl s_client \
    -connect "127.0.0.1:${EXPECTED_PORT}" \
    -servername "${EXPECTED_IP}" </dev/null 2>/dev/null
)" || die "could not read the certificate served by Nginx"
served_fingerprint="$(printf '%s\n' "${served_certificate}" | openssl x509 -noout -fingerprint -sha256)"
[[ "${served_fingerprint}" == "${expected_fingerprint}" ]] \
  || die "Nginx is not serving the certificate from disk"

printf 'live TLS certificate, renewal evidence, and timer checks passed\n'
