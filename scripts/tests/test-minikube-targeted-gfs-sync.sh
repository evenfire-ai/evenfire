#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
LOG_FILE="${TMP_DIR}/calls.log"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

cat >"${TMP_DIR}/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
while [[ "${1:-}" == --context* ]]; do
  if [[ "${1}" == --context ]]; then shift 2; else shift; fi
done
while [[ "${1:-}" == -n || "${1:-}" == --namespace ]]; do shift 2; done
printf '%s\n' "$*" >>"${TEST_CALL_LOG}"
case "$*" in
  get\ deployment\ gfsc-writer\ -n\ gfs|get\ deployment\ gfsc-reader\ -n\ gfs) exit 0 ;;
  rollout\ restart\ deployment/gfsc-writer\ -n\ gfs|rollout\ restart\ deployment/gfsc-reader\ -n\ gfs) exit 0 ;;
  get\ deployment\ gfsc-reader\ -o*spec.replicas*) printf '1'; exit 0 ;;
  get\ deployment\ gfsc-reader\ -o*status.readyReplicas*) printf '1'; exit 0 ;;
  get\ pods\ -l*gfsc-role=reader*) printf 'True|\n'; exit 0 ;;
  *) echo "unexpected kubectl call: $*" >&2; exit 90 ;;
esac
SH
chmod +x "${TMP_DIR}/kubectl"

PROJECT_DIR="${ROOT}"
PROFILE=fake
KC="kubectl --context=fake"
FORCE_CLUSTER_SYNC=false
FORCE_RESTART=false
IMAGE_SOURCE=local
IMAGE_TAG=test
IMAGES_GENERATED_AT=test
log() { :; }
rollout_if_present() { printf 'wait %s/%s\n' "$1" "$2" >>"${LOG_FILE}"; }
export TEST_CALL_LOG="${LOG_FILE}"
export PATH="${TMP_DIR}:${PATH}"

# shellcheck source=/dev/null
source "${ROOT}/scripts/minikube/pre-gate-incremental.sh"
incremental_classify_path gfs-controller/src/index.ts

expected_targets=$'gfs-controller|gfs|gfsc-writer\ngfs-controller|gfs|gfsc-reader'
actual_targets="$(printf '%s\n' "${INCREMENTAL_TARGETS[@]}")"
[[ "${actual_targets}" == "${expected_targets}" ]] || \
  fail "GFS source mapped to the wrong consumers: ${actual_targets}"

# Two deployments consume one image selector; the image must be built once.
bash() { printf 'build %s\n' "$*" >>"${LOG_FILE}"; }
incremental_build_images
[[ "$(grep -c '^build .*--only=gfs-controller$' "${LOG_FILE}")" -eq 1 ]] || \
  fail 'gfs-controller image was not built exactly once for writer+reader'

incremental_restart_targets
grep -q '^rollout restart deployment/gfsc-writer -n gfs$' "${LOG_FILE}" || \
  fail 'targeted GFS sync did not restart gfsc-writer'
grep -q '^rollout restart deployment/gfsc-reader -n gfs$' "${LOG_FILE}" || \
  fail 'targeted GFS sync did not restart gfsc-reader'
grep -q '^wait gfs/gfsc-writer$' "${LOG_FILE}" || fail 'gfsc-writer readiness was not awaited'
grep -q '^get deployment gfsc-reader -o jsonpath={.status.readyReplicas}$' "${LOG_FILE}" || \
  fail 'gfsc-reader did not use the HCC-safe readiness wait'
if grep -q '^wait gfs/gfsc-reader$' "${LOG_FILE}"; then
  fail 'gfsc-reader used the generation-based generic rollout wait'
fi

if grep -Eq 'deployment/gfs-controller|control-plane/host-context-controller' "${LOG_FILE}"; then
  fail 'targeted GFS sync used the obsolete controller deployment path'
fi
if grep -Fq 'MINIKUBE_DEPLOYMENT=gfs-controller' "${ROOT}/scripts/minikube/t2.sh"; then
  fail 'T2 still directly targets nonexistent deployment/gfs-controller'
fi
grep -Fq 'targeted mutation delegated to canonical pre-gate-sync' "${ROOT}/scripts/minikube/t2.sh" || \
  fail 'T2 targeted transition does not delegate to canonical pre-gate-sync'

printf 'PASS: targeted GFS sync builds once and restarts gfsc-writer/gfsc-reader only\n'
