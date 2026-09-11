#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCANNER="${ROOT}/scripts/security/scan-np08-evidence.sh"
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/np08-scan-test.XXXXXX")"
trap 'rm -rf "${tmpdir}"' EXIT
BASH_BIN="$(command -v bash)"

if PATH="${tmpdir}/missing-tools" "${BASH_BIN}" "${SCANNER}" \
  --stdin-kind api </dev/null >/dev/null 2>&1; then
  echo 'FAIL: scanner passed without grep' >&2
  exit 1
fi

if (
  # Invoked indirectly by the scanner's child Bash process.
  # shellcheck disable=SC2329
  grep() { return 2; }
  export -f grep
  printf '%s\n' '{"Authorization":"Bearer abc.def.ghi"}' |
    bash "${SCANNER}" --stdin-kind api >/dev/null 2>&1
); then
  echo 'FAIL: scanner passed when grep returned an execution error' >&2
  exit 1
fi

if ! printf '%s\n' '{"error":"authorization_unavailable"}' | bash "${SCANNER}" --stdin-kind api >/dev/null; then
  echo 'FAIL: sanitized authorization error was treated as a credential leak' >&2
  exit 1
fi

if printf '%s\n' '{"Authorization":"Bearer abc.def.ghi"}' | bash "${SCANNER}" --stdin-kind api >/dev/null 2>&1; then
  echo 'FAIL: bearer header was not rejected' >&2
  exit 1
fi

if printf '%s\n' '{"token":"credential-value"}' | bash "${SCANNER}" --stdin-kind api >/dev/null 2>&1; then
  echo 'FAIL: credential field was not rejected' >&2
  exit 1
fi

printf '%s\n' 'env: secretRef: runtime-token' >"${tmpdir}/rendered.yaml"
bash "${SCANNER}" --manifest "${tmpdir}/rendered.yaml" >/dev/null

if printf '%s\n' '-----BEGIN PRIVATE KEY-----' | bash "${SCANNER}" --stdin-kind manifest >/dev/null 2>&1; then
  echo 'FAIL: private key material was not rejected' >&2
  exit 1
fi

echo 'PASS: NP-08 evidence scanner fixtures'
