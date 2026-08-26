#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
T2="$ROOT/scripts/minikube/t2.sh"

# shellcheck source=scripts/minikube/t2.sh
source "$T2"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

T2_EVIDENCE_STATUS=''
t2_evidence_write() {
  T2_EVIDENCE_STATUS="$2"
}

T2_PLAN_STATE=targeted-sync
T2_HEALTHCHECK_COMMAND=''
T2_HEALTHCHECK_TIMEOUT_SECONDS=5
if validate_healthcheck_contract >/dev/null 2>&1; then
  fail 'targeted sync accepted a missing user-facing health command'
fi
[[ "$T2_ERROR_CODE" == PROFILE_UNHEALTHY ]] || \
  fail "missing targeted health returned ${T2_ERROR_CODE:-<empty>}"

T2_PLAN_STATE=already-synced
T2_HEALTHCHECK_COMMAND=''
validate_healthcheck_contract
run_healthcheck_if_requested
[[ "$T2_HEALTHCHECK_REQUIRED" == false && "$T2_HEALTH_STATUS" == NOT_RUN && \
  "$T2_EVIDENCE_STATUS" == NOT_RUN ]] || \
  fail 'an optional absent health check was not recorded as NOT_RUN'

T2_PLAN_STATE=already-synced
T2_HEALTHCHECK_PENDING=true
T2_HEALTHCHECK_COMMAND=''
if validate_healthcheck_contract >/dev/null 2>&1; then
  fail 'a pending targeted-sync health obligation was not preserved on retry'
fi
[[ "$T2_ERROR_CODE" == PROFILE_UNHEALTHY ]] || \
  fail "pending targeted health returned ${T2_ERROR_CODE:-<empty>}"
T2_HEALTHCHECK_COMMAND='printf "health-retry-ok\\n" >/dev/null'
validate_healthcheck_contract
run_healthcheck_if_requested
[[ "$T2_HEALTHCHECK_PENDING" == false && "$T2_HEALTH_STATUS" == PASS ]] || \
  fail 'a successful retry did not clear the targeted-sync health obligation'

T2_PLAN_STATE=targeted-sync
T2_HEALTHCHECK_COMMAND='printf "health-ok\\n" >/dev/null'
T2_HEALTHCHECK_TIMEOUT_SECONDS=5
validate_healthcheck_contract
run_healthcheck_if_requested
[[ "$T2_HEALTHCHECK_REQUIRED" == true && "$T2_HEALTH_STATUS" == PASS ]] || \
  fail 'a bounded targeted health check did not pass'

T2_PLAN_STATE=targeted-sync
T2_HEALTHCHECK_COMMAND='sleep 10'
T2_HEALTHCHECK_TIMEOUT_SECONDS=1
validate_healthcheck_contract
started="$SECONDS"
if run_healthcheck_if_requested >/dev/null 2>&1; then
  fail 'timed-out targeted health check unexpectedly passed'
fi
elapsed=$((SECONDS - started))
[[ "$T2_ERROR_CODE" == PROFILE_UNHEALTHY && "$T2_HEALTH_STATUS" == FAIL ]] || \
  fail 'timed-out targeted health check did not fail closed'
(( elapsed < 8 )) || fail "targeted health deadline took ${elapsed}s"

T2_HEALTHCHECK_TIMEOUT_SECONDS=0
if validate_healthcheck_contract >/dev/null 2>&1; then
  fail 'invalid health timeout was accepted'
fi
[[ "$T2_ERROR_CODE" == DEVELOPMENT_SCOPE_REQUIRED ]] || \
  fail 'invalid health timeout returned the wrong stable code'

evidence_root="$(mktemp -d)"
cleanup() {
  rm -rf -- "$evidence_root"
}
trap cleanup EXIT

T2_EVIDENCE_ROOT="$evidence_root"
T2_PROJECT_DIR="$ROOT"
T2_BRANCH='chore/targeted-health-fixture'
T2_HEAD='1111111111111111111111111111111111111111'
T2_WORKTREE_ID='targeted-health-fixture-worktree'
T2_PROFILE='targeted-health-fixture-profile'
T2_CONTEXT="$T2_PROFILE"
T2_GATE_ID='minikube-t2'

write_evidence_fixture() {
  local run_id="$1" pending="$2" phases_json="$3" mtime_ns="$4"
  local evidence_dir="$evidence_root/$run_id"
  mkdir -p "$evidence_dir"
  EVIDENCE_FILE="$evidence_dir/evidence.json" \
    EVIDENCE_REPOSITORY="$T2_PROJECT_DIR" EVIDENCE_BRANCH="$T2_BRANCH" \
    EVIDENCE_HEAD="$T2_HEAD" EVIDENCE_WORKTREE_ID="$T2_WORKTREE_ID" \
    EVIDENCE_PROFILE="$T2_PROFILE" EVIDENCE_CONTEXT="$T2_CONTEXT" \
    EVIDENCE_GATE_ID="$T2_GATE_ID" EVIDENCE_PENDING="$pending" \
    EVIDENCE_PHASES="$phases_json" EVIDENCE_MTIME_NS="$mtime_ns" \
    python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["EVIDENCE_FILE"])
path.write_text(json.dumps({
    "certificationVersion": 1,
    "evidenceKind": "certification",
    "repository": os.environ["EVIDENCE_REPOSITORY"],
    "branch": os.environ["EVIDENCE_BRANCH"],
    "head": os.environ["EVIDENCE_HEAD"],
    "worktreeId": os.environ["EVIDENCE_WORKTREE_ID"],
    "profile": os.environ["EVIDENCE_PROFILE"],
    "context": os.environ["EVIDENCE_CONTEXT"],
    "gateId": os.environ["EVIDENCE_GATE_ID"],
    "targetedHealthPending": os.environ["EVIDENCE_PENDING"] == "true",
    "phases": json.loads(os.environ["EVIDENCE_PHASES"]),
}, indent=2) + "\n")
mtime_ns = int(os.environ["EVIDENCE_MTIME_NS"])
os.utime(path, ns=(mtime_ns, mtime_ns))
PY
}

write_evidence_fixture pending true '[
  {"name":"transition","status":"PASS","detail":"targeted-sync duration=1s","timestamp":"2026-01-01T00:00:01Z"},
  {"name":"T1","status":"FAIL","detail":"fixture failure","timestamp":"2026-01-01T00:00:02Z"}
]' 5000000000
write_evidence_fixture standalone-t1 false '[
  {"name":"T1","status":"PASS","detail":"standalone retry","timestamp":"2026-01-01T00:00:03Z"},
  {"name":"complete","status":"PASS","detail":"T1=PASS","timestamp":"2026-01-01T00:00:04Z"}
]' 9000000000

[[ "$(t2_prior_targeted_health_pending)" == true ]] || \
  fail 'standalone T1 evidence cleared an earlier targeted health obligation'
T2_PLAN_STATE=already-synced
T2_HEALTHCHECK_PENDING="$(t2_prior_targeted_health_pending)"
T2_HEALTHCHECK_COMMAND=''
T2_HEALTHCHECK_TIMEOUT_SECONDS=5
T2_ERROR_CODE=''
if validate_healthcheck_contract >/dev/null 2>&1; then
  fail 'persisted targeted health obligation accepted a missing command'
fi
[[ "$T2_ERROR_CODE" == PROFILE_UNHEALTHY ]] || \
  fail 'persisted targeted health obligation returned the wrong stable code'

write_evidence_fixture health-not-run false '[
  {"name":"Health","status":"NOT_RUN","detail":"no command","timestamp":"2026-01-01T00:00:05Z"}
]' 8000000000
[[ "$(t2_prior_targeted_health_pending)" == true ]] || \
  fail 'Health NOT_RUN cleared a targeted health obligation'

write_evidence_fixture foreign-health false '[
  {"name":"Health","status":"PASS","detail":"foreign tuple","timestamp":"2026-01-01T00:00:06Z"}
]' 7000000000
python3 - "$evidence_root/foreign-health/evidence.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text())
data["profile"] = "another-profile"
path.write_text(json.dumps(data, indent=2) + "\n")
PY
[[ "$(t2_prior_targeted_health_pending)" == true ]] || \
  fail 'Health PASS from another identity cleared a targeted health obligation'

write_evidence_fixture health-pass false '[
  {"name":"Health","status":"PASS","detail":"profile-owned journey passed","timestamp":"2026-01-01T00:00:07Z"}
]' 1000000000
[[ "$(t2_prior_targeted_health_pending)" == false ]] || \
  fail 'a later matching Health PASS did not clear the targeted health obligation'

# Filesystem ordering is not certification ordering. Making the neutral T1
# evidence newest must not undo the later semantic Health PASS.
python3 - "$evidence_root/standalone-t1/evidence.json" <<'PY'
import os
import sys

os.utime(sys.argv[1], ns=(12000000000, 12000000000))
PY
[[ "$(t2_prior_targeted_health_pending)" == false ]] || \
  fail 'a newer neutral file mtime overrode semantic evidence ordering'

write_evidence_fixture persisted-pending-snapshot true '[
  {"name":"failure","status":"FAIL","detail":"persisted pending snapshot","timestamp":"2026-01-01T00:00:08Z"}
]' 500000000
[[ "$(t2_prior_targeted_health_pending)" == true ]] || \
  fail 'a persisted pending snapshot without a transition phase was ignored'

write_evidence_fixture health-pass-after-persisted false '[
  {"name":"Health","status":"PASS","detail":"persisted obligation cleared","timestamp":"2026-01-01T00:00:09Z"}
]' 400000000
[[ "$(t2_prior_targeted_health_pending)" == false ]] || \
  fail 'a matching Health PASS did not clear a persisted pending snapshot'

write_evidence_fixture targeted-reopen true '[
  {"name":"transition","status":"PASS","detail":"targeted-sync duration=1s","timestamp":"2026-01-01T00:00:10Z"}
]' 300000000
[[ "$(t2_prior_targeted_health_pending)" == true ]] || \
  fail 'a later targeted sync did not reopen the health obligation'

printf 'PASS: targeted T2 requires a bounded user-facing health check\n'
