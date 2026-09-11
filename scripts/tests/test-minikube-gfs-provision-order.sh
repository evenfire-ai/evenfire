#!/usr/bin/env bash
# Executable contract for the composed GFS pre-gate recovery sequence.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PRE_GATE="$ROOT/scripts/minikube/pre-gate-sync.sh"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

fake_project="$tmp/project"
mkdir -p "$fake_project/scripts/minikube" "$fake_project/deploy/scripts" \
  "$fake_project/scripts/minikube/gfs-rollout-shim"
order_file="$tmp/order.log"

cat >"$fake_project/scripts/minikube/sync-auth-key.sh" <<'STUB'
#!/usr/bin/env bash
set -eu
case " $* " in
  *' --require-gfs '*) printf 'sync\n' >>"${ORDER_FILE:?}" ;;
  *) printf 'unexpected-sync-args:%s\n' "$*" >>"${ORDER_FILE:?}"; exit 1 ;;
esac
STUB
cat >"$fake_project/scripts/minikube/settle-gfs-reader-rollout.sh" <<'STUB'
#!/usr/bin/env bash
set -eu
printf 'settle\n' >>"${ORDER_FILE:?}"
STUB
cat >"$fake_project/deploy/scripts/reconcile-gfs-deploy-credentials.sh" <<'STUB'
#!/usr/bin/env bash
set -eu
case ":${PATH}:" in
  *":${T2_PROJECT_DIR}/scripts/minikube/gfs-rollout-shim:"*) ;;
  *) printf 'reconcile-missing-shim-path\n' >>"${ORDER_FILE:?}"; exit 1 ;;
esac
printf 'reconcile\n' >>"${ORDER_FILE:?}"
STUB
chmod +x "$fake_project/scripts/minikube/sync-auth-key.sh" \
  "$fake_project/scripts/minikube/settle-gfs-reader-rollout.sh" \
  "$fake_project/deploy/scripts/reconcile-gfs-deploy-credentials.sh"

cat >"$tmp/kubectl" <<'STUB'
#!/usr/bin/env bash
set -eu
if [[ "${FAKE_KC_MODE:-present}" == reader-absent && "$*" == *'get deployment gfsc-reader -n gfs'* ]]; then
  printf 'Error from server (NotFound): deployments.apps "gfsc-reader" not found\n' >&2
  exit 1
fi
if [[ "${FAKE_KC_MODE:-present}" == reader-ready-read-error && "$*" == *'get deployment gfsc-reader -n gfs -o jsonpath='* ]]; then
  printf 'simulated jsonpath read failure\n' >&2
  exit 1
fi
exit 0
STUB
chmod +x "$tmp/kubectl"

export PRE_GATE_SYNC_CONFIG_ONLY=true
export MINIKUBE_PROFILE=gfs-order-test
export IMAGE_SOURCE=local
# shellcheck source=/dev/null
source "$PRE_GATE" >/dev/null

PROJECT_DIR="$fake_project"
T2_PROJECT_DIR="$fake_project"
T2_PROFILE=gfs-order-test
T2_CONTEXT=gfs-order-test
T2_LOCK_TOKEN=test-lock
T2_PROFILE_ROOT="$tmp/profile"
T2_PROFILE_ENV="$tmp/profile.env"
T2_PORTS_ENV="$tmp/ports.env"
PROFILE=gfs-order-test
KC="$tmp/kubectl"
GATE_NAME=minikube-t2
ORDER_FILE="$order_file"
export PROJECT_DIR T2_PROJECT_DIR T2_PROFILE T2_CONTEXT T2_LOCK_TOKEN \
  T2_PROFILE_ROOT T2_PROFILE_ENV T2_PORTS_ENV PROFILE KC GATE_NAME ORDER_FILE

# Keep the final convergence observable without touching a real cluster; the
# three wrappers above remain the production implementations under test.
production_converge="$(declare -f converge_gfs_reader_after_restore)"
converge_gfs_reader_after_restore() {
  printf 'converge\n' >>"${ORDER_FILE:?}"
}
sync_mcp_host_auth_key() {
  printf 'mcp\n' >>"${ORDER_FILE:?}"
}

provision_gfs_serving
expected=$'sync\nsettle\nreconcile\nsync\nconverge'
actual="$(cat "$order_file")"
[ "$actual" = "$expected" ] || {
  printf 'expected:\n%s\nactual:\n%s\n' "$expected" "$actual" >&2
  fail 'T2 GFS recovery order or shim PATH contract changed'
}

: >"$order_file"
GATE_NAME=security-gate-2
provision_gfs_serving
actual="$(cat "$order_file")"
[ "$actual" = 'mcp' ] || fail 'non-T2 pre-gate mutated the GFS recovery sequence'

: >"$order_file"
FAKE_KC_MODE=reader-absent
export FAKE_KC_MODE
GATE_NAME=minikube-t2
provision_gfs_serving
actual="$(cat "$order_file")"
[ "$actual" = 'mcp' ] || fail 'GFS recovery did not skip all GFS mutations when gfsc-reader is absent'

FAKE_KC_MODE=reader-ready-read-error
eval "$production_converge"
if converge_gfs_reader_after_restore; then
  fail 'GFS reader convergence accepted an unreadable replica status'
fi

printf 'PASS: composed GFS pre-gate order and gate scope\n'
