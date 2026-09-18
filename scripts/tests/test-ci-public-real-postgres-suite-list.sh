#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="${CI_PUBLIC_WORKFLOW:-${ROOT_DIR}/.github/workflows/ci-public.yml}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f "${WORKFLOW}" ]] || fail "workflow does not exist: ${WORKFLOW}"

# Parse the YAML document before extracting the shell block. This catches a
# malformed workflow independently of bash's interpretation of the embedded run.
ruby -ryaml -e 'YAML.load_file(ARGV.fetch(0))' "${WORKFLOW}" \
  || fail "ci-public.yml is not valid YAML"

block="$(mktemp)"
trap 'rm -f "${block}"' EXIT

# The step name is the stable boundary for the embedded real-Postgres shell.
# Remove the YAML indentation and retain only the literal `run: |` body.
awk '
  $0 == "      - name: Run control-api real Postgres suites (migration + GFS)" {
    step = 1
    next
  }
  step && /^      - name: / { exit }
  step && /^        run: \|$/ { run = 1; next }
  run {
    sub(/^          /, "")
    print
  }
' "${WORKFLOW}" >"${block}"

[[ -s "${block}" ]] || fail "could not extract the real-Postgres run block"
bash -n "${block}" || fail "real-Postgres run block is not valid shell"

suite_lines="$(awk '
  /^for suite in \\$/ { in_list = 1; next }
  in_list && /^do$/ { exit }
  in_list { print }
' "${block}")"
[[ -n "${suite_lines}" ]] || fail "real-Postgres suite list is empty"

duplicates="$(printf '%s\n' "${suite_lines}" | sed -E 's/[[:space:]]+\\$//' |
  sed -E 's/^[[:space:]]+//' | sort | uniq -d)"
[[ -z "${duplicates}" ]] || fail "real-Postgres suite list contains duplicates: ${duplicates}"

while IFS= read -r suite; do
  [[ -n "${suite}" ]] || continue
  [[ "${suite}" == *.realPostgres.integration ]] ||
    fail "suite is outside the real-Postgres contract: ${suite}"
  find "${ROOT_DIR}/control-api/test" -type f \
    -name "${suite}.test.ts" -print -quit | grep -q . ||
    fail "real-Postgres suite argument has no producer test file: ${suite}"
done < <(printf '%s\n' "${suite_lines}" | sed -E 's/[[:space:]]+\\$//' |
  sed -E 's/^[[:space:]]+//')

if [[ "${CI_PUBLIC_WORKFLOW_MUTATION:-0}" != "1" ]]; then
  mutated="$(mktemp)"
  trap 'rm -f "${block}" "${mutated}"' EXIT
  awk '
    !mutated && /accessCatalogCoordinator\.realPostgres\.integration/ {
      sub(/\\$/, "")
      mutated = 1
    }
    { print }
  ' "${WORKFLOW}" >"${mutated}"
  if CI_PUBLIC_WORKFLOW="${mutated}" CI_PUBLIC_WORKFLOW_MUTATION=1 \
    bash "${BASH_SOURCE[0]}" >/dev/null 2>&1; then
    fail 'removing a suite-list continuation was not detected'
  fi
fi

echo "PASS: ci-public real-Postgres suite list has valid shell continuation and unique arguments"
