#!/usr/bin/env bash
set -euo pipefail
set +x

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
T1="$ROOT/scripts/e2e/minikube-real-postgres.sh"
PREFLIGHT="$ROOT/scripts/e2e/real-postgres-local-preflight.sh"
TMP_ROOT="${TMPDIR:-/tmp}"
TEST_DIR="$(mktemp -d "$TMP_ROOT/evenfire-t1-docker.XXXXXX")"
trap 'rm -rf -- "$TEST_DIR"' EXIT

# shellcheck source=scripts/e2e/minikube-real-postgres.sh
source "$T1"
trap 'rm -rf -- "$TEST_DIR"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

CALLS="$TEST_DIR/calls"
docker_cli_run_public() {
  printf '%s\n' "$@" >"$CALLS"
}

# Consumed by the sourced production helper; ShellCheck cannot follow that
# cross-file function body.
# shellcheck disable=SC2034
T1_DOCKER_ENV_PREPARED=true
# shellcheck disable=SC2034
T1_DOCKER_REMOVE_TIMEOUT_SECONDS=17
ISOLATED_CONTAINER=evenfire-test-postgres
stop_isolated_postgres || fail 'bounded isolated-container cleanup failed'
[[ -z "$ISOLATED_CONTAINER" ]] || fail 'successful cleanup retained the container identity'
python3 - "$CALLS" <<'PY'
from pathlib import Path
import sys

assert Path(sys.argv[1]).read_text().splitlines() == [
    "t1-postgres-remove",
    "17",
    "docker",
    "rm",
    "-f",
    "evenfire-test-postgres",
]
PY

grep -Fq 'bash "$REAL_PG_DOCKER_HELPER" --check-info' "$PREFLIGHT"
grep -Fq 'docker_cli_env_prepare false' "$T1"
grep -Fq 'docker_cli_run_public t1-postgres-run' "$T1"
grep -Fq 'docker_cli_run_public t1-postgres-ready-probe' "$T1"
grep -Fq 'docker_cli_run_public t1-postgres-remove' "$T1"

awk '
  /^[[:space:]]*docker (run|exec|rm) / {
    if (previous !~ /docker_cli_run_public/ && before_previous !~ /docker_cli_run_public/) {
      exit 1
    }
  }
  { before_previous = previous; previous = $0 }
' "$T1" || fail 'T1 still runs an ambient or unbounded Docker operation'

printf 'PASS: T1 Docker operations are isolated, bounded, and fail-loud\n'
