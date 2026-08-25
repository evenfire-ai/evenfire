#!/usr/bin/env bash
# Behavioral contract for planner/certification evidence separation.
set -euo pipefail
set +x

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
COMMON="$ROOT/scripts/minikube/t2-common.sh"
TMP_ROOT="${TMPDIR:-/tmp}"
TEST_DIR="$(mktemp -d "$TMP_ROOT/evenfire-t2-evidence.XXXXXX")"
trap 'rm -rf -- "$TEST_DIR"' EXIT

write_evidence() {
  local kind="$1" directory="$2" planner_result="${3:-PASS}"
  T2_EVIDENCE_KIND="$kind" \
  PLANNER_RESULT="$planner_result" \
  T2_EVIDENCE_ROOT="$directory" \
  T2_PROJECT_DIR="$ROOT" \
  T2_PROFILE=clerum-feature-owner \
  T2_CONTEXT=clerum-feature-owner \
  bash -c '
    set -euo pipefail
    source "$1"
    T2_BRANCH=feature/evidence
    T2_HEAD=0123456789abcdef0123456789abcdef01234567
    T2_ORIGIN_DEV=abcdef0123456789abcdef0123456789abcdef01
    T2_MERGE_BASE="$T2_ORIGIN_DEV"
    T2_WORKTREE_ID=worktree-owner
    T2_CLUSTER_FINGERPRINT=cluster-fingerprint
    t2_evidence_init
    if [ "$T2_EVIDENCE_KIND" = planner ]; then
      if [ "$PLANNER_RESULT" = PASS ]; then
        t2_evidence_write preflight PASS "targeted-sync duration=1.25s"
      else
        t2_evidence_write failure FAIL "profile unavailable duration=250ms"
      fi
    else
      t2_evidence_write T0 PASS "typecheck duration=120ms"
      t2_evidence_write complete PASS "all required phases complete durationSeconds=2"
    fi
    printf "%s\n" "$T2_EVIDENCE_FILE"
  ' _ "$COMMON"
}

planner_file="$(write_evidence planner "$TEST_DIR/planner")"
planner_failure_file="$(write_evidence planner "$TEST_DIR/planner-failure" FAIL)"
certification_file="$(write_evidence certification "$TEST_DIR/certification")"

python3 - "$planner_file" "$planner_failure_file" "$certification_file" <<'PY'
import json
import sys
from pathlib import Path

planner = json.loads(Path(sys.argv[1]).read_text())
assert planner["evidenceKind"] == "planner"
assert "certificationVersion" not in planner
assert planner["plannerStatus"] == "PASS"
assert planner["attestationStatus"] == "NOT_APPLICABLE"
assert planner["laneAttestationStatus"] == "NOT_APPLICABLE"
planner_phase = planner["phases"][-1]
assert planner_phase["detail"] == "targeted-sync duration=1.25s"
assert planner_phase["durationSeconds"] == 1.25

planner_failure = json.loads(Path(sys.argv[2]).read_text())
assert planner_failure["plannerStatus"] == "FAIL"
assert planner_failure["attestationStatus"] == "NOT_APPLICABLE"
assert planner_failure["phases"][-1]["durationSeconds"] == 0.25

certification = json.loads(Path(sys.argv[3]).read_text())
assert certification["evidenceKind"] == "certification"
assert certification["certificationVersion"] == 1
assert certification["attestationStatus"] == "PASS"
assert "plannerStatus" not in certification
assert certification["phases"][-2]["durationSeconds"] == 0.12
assert certification["phases"][-1]["durationSeconds"] == 2.0
PY

printf 'PASS: T2 planner and certification evidence have distinct terminal semantics\n'
