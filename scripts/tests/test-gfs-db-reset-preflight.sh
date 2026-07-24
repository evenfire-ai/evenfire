#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAKE_BIN="$TMP/bin"
LOG="$TMP/kubectl.log"
mkdir -p "$FAKE_BIN"

cat >"$FAKE_BIN/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_KUBECTL_LOG"

if [[ "$*" == *"apply set-last-applied"* ]] && [ "${FAKE_APPLY_FAILURE:-false}" = true ]; then
  exit 1
fi
if [[ "$*" == *"apply set-last-applied"* ]] || [[ "$*" == *" apply -f "* ]]; then
  exit 0
fi

if [[ "$*" == *"get secret gfs-controller-db -o name"* ]]; then
  printf 'secret/gfs-controller-db\n'
  exit 0
fi

if [[ "$*" == *"get secret"*"-o json"* ]]; then
  if [ "${FAKE_API_FAILURE:-false}" = true ]; then
    exit 1
  fi

  if [[ "$*" == *"gfs-controller-reader-db"* ]]; then
    role=gfs_controller_reader
    state="${FAKE_READER_STATE-ready}"
    pending="${FAKE_READER_PENDING:-}"
    active="${FAKE_READER_DSN-postgresql://gfs_controller_reader:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@control-postgres.control-plane.svc.cluster.local:5432/profiles}"
  else
    role=gfs_controller
    state="${FAKE_WRITER_STATE-ready}"
    pending="${FAKE_WRITER_PENDING:-}"
    active="${FAKE_WRITER_DSN-postgresql://gfs_controller:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@control-postgres.control-plane.svc.cluster.local:5432/profiles}"
  fi

  if [ "${FAKE_MALFORMED_B64:-false}" = true ]; then
    printf '{"metadata":{"resourceVersion":"42","annotations":{"clerum.io/gfs-dsn-state":"ready"}},"data":{"connection-string":"%%%"}}\n'
    exit 0
  fi

  ROLE="$role" STATE="$state" PENDING="$pending" ACTIVE="$active" python3 - <<'PY'
import base64
import json
import os

def encoded(value: str) -> str:
    return base64.b64encode(value.encode()).decode()

data = {}
if os.environ["ACTIVE"]:
    data["connection-string"] = encoded(os.environ["ACTIVE"])
if os.environ["PENDING"]:
    data["pending-connection-string"] = encoded(os.environ["PENDING"])
print(json.dumps({
    "metadata": {
        "resourceVersion": "42",
        "annotations": {
            "clerum.io/gfs-dsn-state": os.environ["STATE"],
            "clerum.io/gfs-dsn-rotated-at": "2026-07-18T00:00:00Z",
        },
    },
    "data": data,
}))
PY
  exit 0
fi

printf 'unexpected kubectl invocation: %s\n' "$*" >&2
exit 1
EOF
chmod +x "$FAKE_BIN/kubectl"

run_preflight() {
  env PATH="$FAKE_BIN:$PATH" FAKE_KUBECTL_LOG="$LOG" CONTEXT=test-context "$@" \
    bash "$ROOT/deploy/scripts/preflight-gfs-db-reset.sh"
}

: >"$LOG"
output="$(run_preflight 2>&1)"
[[ "$output" != *"postgresql://"* ]] || { echo 'FAIL: preflight leaked a DSN' >&2; exit 1; }
[[ "$output" != *"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"* ]] || { echo 'FAIL: preflight leaked writer password' >&2; exit 1; }
[[ "$output" != *"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"* ]] || { echo 'FAIL: preflight leaked reader password' >&2; exit 1; }
! grep -Eq 'exec|psql' "$LOG" || { echo 'FAIL: metadata preflight contacted PostgreSQL' >&2; exit 1; }
[[ "$(grep -c 'get secret gfs-controller-db -o json' "$LOG")" -eq 1 ]] || { echo 'FAIL: writer was not read as one snapshot' >&2; exit 1; }
[[ "$(grep -c 'get secret gfs-controller-reader-db -o json' "$LOG")" -eq 1 ]] || { echo 'FAIL: reader was not read as one snapshot' >&2; exit 1; }

if run_preflight FAKE_WRITER_STATE=pending >/dev/null 2>&1; then
  echo 'FAIL: non-ready writer was accepted' >&2
  exit 1
fi
if run_preflight FAKE_WRITER_STATE= >/dev/null 2>&1; then
  echo 'FAIL: writer without lifecycle state was accepted' >&2
  exit 1
fi
if run_preflight FAKE_READER_PENDING=candidate >/dev/null 2>&1; then
  echo 'FAIL: pending reader credential was accepted' >&2
  exit 1
fi
if run_preflight FAKE_WRITER_DSN='postgresql://gfs_controller_reader:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@control-postgres.control-plane.svc.cluster.local:5432/profiles' >/dev/null 2>&1; then
  echo 'FAIL: wrong writer role was accepted' >&2
  exit 1
fi
if run_preflight FAKE_MALFORMED_B64=true >/dev/null 2>&1; then
  echo 'FAIL: malformed Secret base64 was accepted' >&2
  exit 1
fi
if run_preflight FAKE_WRITER_DSN='postgresql://gfs_controller:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@wrong-host:5432/profiles' >/dev/null 2>&1; then
  echo 'FAIL: invalid writer endpoint was accepted' >&2
  exit 1
fi
if run_preflight FAKE_READER_DSN= >/dev/null 2>&1; then
  echo 'FAIL: missing reader credential was accepted' >&2
  exit 1
fi
if run_preflight FAKE_API_FAILURE=true >/dev/null 2>&1; then
  echo 'FAIL: Kubernetes API failure was accepted' >&2
  exit 1
fi
if run_preflight FAKE_APPLY_FAILURE=true >/dev/null 2>&1; then
  echo 'FAIL: writer ownership migration failure was accepted' >&2
  exit 1
fi

echo 'PASS: GFS DB reset preflight'
