#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PREFLIGHT="$ROOT/scripts/e2e/real-postgres-local-preflight.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

project="$tmp/project"
fake_bin="$tmp/bin"
real_node="$(command -v node)"
mkdir -p "$fake_bin"
for package in control-api gfs-controller; do
  mkdir -p "$project/$package/node_modules/.bin"
  printf '{"name":"%s"}\n' "$package" >"$project/$package/package.json"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$project/$package/node_modules/.bin/vitest"
  chmod +x "$project/$package/node_modules/.bin/vitest"
done

printf '%s\n' '#!/usr/bin/env bash' \
  'if [[ "${1:-}" == -p ]]; then printf "%s\n" "${FAKE_NODE_MAJOR:-24}"; exit 0; fi' \
  'if [[ "${1:-}" == -e ]]; then exit 0; fi' \
  'exec "$REAL_NODE" "$@"' >"$fake_bin/node"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$fake_bin/npm"
printf '%s\n' '#!/usr/bin/env bash' \
  'if [[ "${1:-}" == context && "${2:-}" == inspect ]]; then' \
  '  if [[ "$*" == *"TLSMaterial"* ]]; then' \
  '    printf "unix:///private/tmp/evenfire-test-docker.sock\\tfalse\\t{}\\n"' \
  '  else' \
  '    printf "unix:///private/tmp/evenfire-test-docker.sock\\n"' \
  '  fi' \
  '  exit 0' \
  'fi' \
  'if [[ "${1:-}" == info ]]; then exit 0; fi' \
  'exit 1' >"$fake_bin/docker"
chmod +x "$fake_bin/node" "$fake_bin/npm" "$fake_bin/docker"

# shellcheck source=scripts/e2e/real-postgres-local-preflight.sh
source "$PREFLIGHT"

PATH="$fake_bin:$PATH"
REAL_NODE="$real_node"
export PATH REAL_NODE
unset VITEST_MAX_WORKERS
real_pg_local_preflight "$project" true >/dev/null
[[ "$VITEST_MAX_WORKERS" == 1 ]] || {
  echo 'FAIL: preflight did not pin T1 to one worker' >&2
  exit 1
}

VITEST_MAX_WORKERS=4
if real_pg_local_preflight "$project" true >"$tmp/workers.out" 2>&1; then
  echo 'FAIL: preflight accepted an unsafe T1 worker count' >&2
  exit 1
fi
[[ "$REAL_PG_PREFLIGHT_ERROR_CODE" == UNSUPPORTED_T1_CONCURRENCY ]]

VITEST_MAX_WORKERS=1 FAKE_NODE_MAJOR=23
export VITEST_MAX_WORKERS FAKE_NODE_MAJOR
if real_pg_local_preflight "$project" true >"$tmp/node.out" 2>&1; then
  echo 'FAIL: preflight accepted Node.js below the package contract' >&2
  exit 1
fi
[[ "$REAL_PG_PREFLIGHT_ERROR_CODE" == LOCAL_DEPENDENCY_MISSING ]]
unset FAKE_NODE_MAJOR

chmod -x "$project/gfs-controller/node_modules/.bin/vitest"
if real_pg_local_preflight "$project" true >"$tmp/deps.out" 2>&1; then
  echo 'FAIL: preflight accepted missing package-local dependencies' >&2
  exit 1
fi
[[ "$REAL_PG_PREFLIGHT_ERROR_CODE" == LOCAL_DEPENDENCY_MISSING ]]
chmod +x "$project/gfs-controller/node_modules/.bin/vitest"

printf '%s\n' '#!/usr/bin/env bash' 'exec sleep 5' >"$fake_bin/docker"
chmod +x "$fake_bin/docker"
REAL_PG_DOCKER_INFO_TIMEOUT_SECONDS=1
export REAL_PG_DOCKER_INFO_TIMEOUT_SECONDS
started="$SECONDS"
if real_pg_local_preflight "$project" true >"$tmp/docker.out" 2>&1; then
  echo 'FAIL: preflight accepted a Docker daemon timeout' >&2
  exit 1
fi
elapsed=$((SECONDS - started))
[[ "$REAL_PG_PREFLIGHT_ERROR_CODE" == LOCAL_DEPENDENCY_MISSING ]]
(( elapsed < 4 )) || {
  echo 'FAIL: Docker preflight timeout was not bounded' >&2
  exit 1
}

printf 'PASS: Real PostgreSQL local preflight is early, serial, and bounded\n'
