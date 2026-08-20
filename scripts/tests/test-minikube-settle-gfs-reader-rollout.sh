#!/usr/bin/env bash
# Stubbed contract for scripts/minikube/settle-gfs-reader-rollout.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/minikube/settle-gfs-reader-rollout.sh"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

bash -n "$SCRIPT"

run_settle() {
  local fake_dir
  fake_dir="$(mktemp -d)"
  cat >"$fake_dir/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE_KUBECTL_LOG:?}"
case " $* " in
  *' get deployment gfsc-reader '*'-o jsonpath={.spec.replicas}'*)
    printf '%s' "${FAKE_DESIRED:-1}"; exit 0 ;;
  *' get deployment gfsc-reader '*'-o jsonpath={.status.readyReplicas}'*)
    printf '%s' "${FAKE_READY:-1}"; exit 0 ;;
  *' get deployment gfsc-reader'*)
    [ "${FAKE_DEPLOY_EXISTS:-1}" = 1 ] || exit 1
    exit 0 ;;
  *' get secret gfs-controller-reader-db '*gfs-dsn-state*)
    printf '%s' "${FAKE_STATE:-rollout-running}"; exit 0 ;;
  *' get secret gfs-controller-reader-db '*gfs-dsn-rotated-at*)
    printf '%s' "${FAKE_ROTATED:-2026-01-01T00:00:00Z}"; exit 0 ;;
  *' get secret gfs-controller-reader-db'*)
    [ "${FAKE_SECRET_EXISTS:-1}" = 1 ] || exit 1
    exit 0 ;;
  *' patch secret gfs-controller-reader-db'*)
    cat >/dev/null
    [ "${FAKE_PATCH_OK:-1}" = 1 ] || exit 1
    exit 0 ;;
esac
exit 1
STUB
  chmod +x "$fake_dir/kubectl"
  PATH="$fake_dir:$PATH" CONTEXT=fake \
    FAKE_KUBECTL_LOG="$fake_dir/kubectl.log" \
    FAKE_DEPLOY_EXISTS="${1:-1}" \
    FAKE_DESIRED="${2:-1}" \
    FAKE_READY="${3:-1}" \
    FAKE_SECRET_EXISTS="${4:-1}" \
    FAKE_STATE="${5:-rollout-running}" \
    FAKE_ROTATED="${6:-2026-01-01T00:00:00Z}" \
    FAKE_PATCH_OK="${7:-1}" \
    bash "$SCRIPT"
  printf '%s' "$fake_dir"
}

dir="$(run_settle 1 1 1 1 rollout-running '2026-01-01T00:00:00Z' 1)"
grep -q 'patch secret gfs-controller-reader-db' "$dir/kubectl.log" \
  || fail 'Ready leftover claim did not patch the reader Secret to ready'
rm -rf "$dir"

dir="$(run_settle 1 1 0 1 rollout-running '2026-01-01T00:00:00Z' 1)"
grep -q 'patch secret' "$dir/kubectl.log" \
  && fail 'unready reader must not settle the leftover claim'
rm -rf "$dir"

dir="$(run_settle 1 1 1 1 ready '2026-01-01T00:00:00Z' 1)"
grep -q 'patch secret' "$dir/kubectl.log" \
  && fail 'ready Secret state must not be patched again'
rm -rf "$dir"

printf 'PASS: settle-gfs-reader-rollout leftover Ready claim\n'
