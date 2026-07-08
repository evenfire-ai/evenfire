#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

LOG_FILE="${TMP_DIR}/kubectl.log"
OUT_FILE="${TMP_DIR}/post-deploy-sync.out"

cat >"${TMP_DIR}/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

while [[ "${1:-}" == --context* ]]; do
  if [[ "${1}" == "--context" ]]; then
    shift 2
  else
    shift
  fi
done

printf '%s\n' "$*" >>"${TEST_KUBECTL_LOG}"
args="$*"

if [[ "${1:-}" == "apply" ]]; then
  exit 0
fi

if [[ "${1:-}" == "-n" && "${2:-}" == "gfs" && "${3:-}" == "get" && "${4:-}" == "globalfilesystems.clerum.io" ]]; then
  printf 'gfs\n'
  exit 0
fi

if [[ "${1:-}" == "-n" && "${2:-}" == "gfs" && "${3:-}" == "auth" && "${4:-}" == "can-i" ]]; then
  case "${5:-} ${6:-}" in
    "create poddisruptionbudgets.policy"|"update poddisruptionbudgets.policy")
      printf 'yes\n'
      exit 0
      ;;
  esac
fi

if [[ "${1:-}" == "-n" && "${2:-}" == "gfs" && "${3:-}" == "get" && "${4:-}" == "globalfilesystem" && "${5:-}" == "gfs" ]]; then
  if [[ "$args" == *".spec.readerReplicas"* ]]; then
    printf '2'
    exit 0
  fi
  if [[ "$args" == *".status.phase"* ]]; then
    printf 'Ready'
    exit 0
  fi
fi

if [[ "${1:-}" == "-n" && "${2:-}" == "gfs" && "${3:-}" == "get" && "${4:-}" == "poddisruptionbudget" && "${5:-}" == "gfsc-writer-pdb" ]]; then
  exit 0
fi

if [[ "${1:-}" == "-n" && "${2:-}" == "gfs" && "${3:-}" == "get" && "${4:-}" == "deployment" ]]; then
  case "${5:-}:$args" in
    gfsc-writer:*".spec.replicas"*) printf '1'; exit 0 ;;
    gfsc-writer:*".status.readyReplicas"*) printf '1'; exit 0 ;;
    gfsc-reader:*".spec.replicas"*) printf '2'; exit 0 ;;
    gfsc-reader:*".status.readyReplicas"*) printf '2'; exit 0 ;;
  esac
fi

if [[ "${1:-}" == "-n" && "${2:-}" == "gfs" && "${3:-}" == "get" && "${4:-}" == "pods" ]]; then
  printf 'node-a\nnode-a\nnode-a\n'
  exit 0
fi

echo "unexpected kubectl invocation: $*" >&2
exit 99
STUB

chmod +x "${TMP_DIR}/kubectl"

if ! TEST_KUBECTL_LOG="${LOG_FILE}" PATH="${TMP_DIR}:$PATH" CONTEXT=fake \
  bash "${ROOT}/deploy/scripts/post-deploy-sync.sh" >"${OUT_FILE}" 2>&1; then
  cat "${OUT_FILE}" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

grep -q '\[2/3\] Verifying GFS runtime after RBAC sync' "${OUT_FILE}"
grep -q 'OK — HCC can create/update poddisruptionbudgets.policy in gfs' "${OUT_FILE}"
grep -q 'OK — GlobalFileSystem gfs is Ready' "${OUT_FILE}"
grep -q 'OK — gfsc-writer-pdb exists' "${OUT_FILE}"
grep -q 'OK — gfs/gfsc-writer ready 1/1' "${OUT_FILE}"
grep -q 'OK — gfs/gfsc-reader ready 2/2' "${OUT_FILE}"
grep -q 'OK — gfsc writer/readers are co-located on node-a' "${OUT_FILE}"
grep -q 'auth can-i create poddisruptionbudgets.policy' "${LOG_FILE}"
grep -q 'auth can-i update poddisruptionbudgets.policy' "${LOG_FILE}"

echo "PASS: post-deploy-sync verifies GFS RBAC, reader/writer replicas, and RWO co-location"
