#!/usr/bin/env bash
# Hermetic contract for the reserved minikube-t2 pre-gate delegation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
COMMON="$ROOT/scripts/minikube/t2-common.sh"
PRE_GATE="$ROOT/scripts/minikube/pre-gate-sync.sh"
FAIL=0
TMP_ROOT="${TMPDIR:-/tmp}"
TEST_TMP="$(mktemp -d "$TMP_ROOT/evenfire-canonical-entrypoint.XXXXXX")"
trap 'rm -rf "$TEST_TMP"' EXIT

pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; FAIL=1; }

# The source checkout remains the Makefile/script root. Git identity and lease
# metadata live only in the helper-owned fixture repository.
MINIKUBE_TEST_PROFILE=canonical-entrypoint-test
MINIKUBE_TEST_CONTEXT="$MINIKUBE_TEST_PROFILE"
export MINIKUBE_TEST_PROFILE MINIKUBE_TEST_CONTEXT
# shellcheck source=scripts/tests/lib/minikube-fixture-repo.sh
source "$ROOT/scripts/tests/lib/minikube-fixture-repo.sh"
minikube_test_fixture_repo_init "$ROOT" "$TEST_TMP/fixture"
minikube_test_assert_host_unchanged

if output="$(make --no-print-directory -C "$ROOT" minikube-pre-gate-sync GATE=minikube-t2 2>&1)"; then
  fail 'standalone Make target accepted the reserved minikube-t2 gate'
else
  grep -Fq 'T2_CANONICAL_ENTRYPOINT_REQUIRED' <<<"$output" \
    && pass 'standalone Make target rejects the reserved minikube-t2 gate' \
    || fail 'standalone Make target emitted no canonical-entrypoint error'
  grep -Fq 'make minikube-t2' <<<"$output" \
    && pass 'standalone Make target points to the canonical orchestrator' \
    || fail 'standalone Make target gave no canonical next command'
fi

if PRE_GATE_SYNC_CONFIG_ONLY=true make --no-print-directory -C "$ROOT" \
  minikube-pre-gate-sync GATE= >/dev/null 2>&1; then
  pass 'empty GATE preserves the manual non-T2 default'
else
  fail 'empty GATE no longer preserves the manual non-T2 default'
fi

# Poison every runtime capable of Docker/cluster/package mutation. The direct
# guard must reject before any one of them is executed.
poison_bin="$TEST_TMP/poison-bin"
mutation_sentinel="$TEST_TMP/unexpected-mutation"
mkdir -p "$poison_bin"
for command_name in docker kubectl minikube npm npx pnpm ruby; do
  cat >"$poison_bin/$command_name" <<'EOF_POISON'
#!/usr/bin/env bash
: >"${CANONICAL_MUTATION_SENTINEL:?}"
printf 'unexpected mutating runtime: %s\n' "$0" >&2
exit 97
EOF_POISON
  chmod +x "$poison_bin/$command_name"
done

if output="$(CANONICAL_MUTATION_SENTINEL="$mutation_sentinel" \
  PATH="$poison_bin:$PATH" PRE_GATE_SYNC_CONFIG_ONLY=true \
  bash "$PRE_GATE" --gate minikube-t2 2>&1)"; then
  fail 'direct pre-gate script accepted the reserved gate without delegation'
else
  grep -Fq 'T2_CANONICAL_ENTRYPOINT_REQUIRED' <<<"$output" \
    && pass 'direct pre-gate script rejects before runtime inspection' \
    || fail 'direct pre-gate script emitted no canonical-entrypoint error'
  [[ ! -e "$mutation_sentinel" ]] \
    || fail 'standalone rejection reached a mutating runtime'
fi

lease_env_name=T2_LOCK_""TOKEN
lease_value=fixture-lease
if PRE_GATE_SYNC_CONFIG_ONLY=true T2_CANONICAL_ORCHESTRATOR=true \
  T2_SKIP_LOCK=true T2_RUN_ID=fixture-run \
  env "$lease_env_name=$lease_value" bash "$PRE_GATE" \
    --gate minikube-t2 >/dev/null 2>&1; then
  pass 'internal marker and lease metadata pass the early entrypoint guard'
else
  fail 'internal delegation was rejected before the config-only seam'
fi

# A schema-v2 profile represents the current ownership contract. The complete
# ports record is synthetic, loopback-only, and never opened.
fixture_repo="$MINIKUBE_TEST_PROJECT_DIR"
fixture_branch="$MINIKUBE_TEST_BRANCH"
fixture_head="$MINIKUBE_TEST_HEAD"
fixture_worktree_id="$MINIKUBE_TEST_WORKTREE_ID"
fixture_owner_id="$(bash -c 'source "$1"; t2_profile_owner_id "$2" "$3"' bash \
  "$ROOT/scripts/minikube/t2-worktree-id.sh" "$fixture_repo" "$fixture_branch")"
profile_dir="$TEST_TMP/profiles/$MINIKUBE_TEST_PROFILE"
lock_root="$TEST_TMP/locks"
lock_dir="$lock_root/$MINIKUBE_TEST_PROFILE.lock"
mkdir -p "$profile_dir" "$lock_dir"
cat >"$profile_dir/profile.env" <<EOF_PROFILE
PROFILE_SCHEMA_VERSION=2
WORKTREE_ID=$fixture_worktree_id
OWNER_ID=$fixture_owner_id
CREATED_HEAD=$fixture_head
PROFILE=$MINIKUBE_TEST_PROFILE
REPO_DIR=$fixture_repo
BRANCH=$fixture_branch
EOF_PROFILE
loopback_url() { printf 'http://%s:%s' 127.0.0.1 "$1"; }
cat >"$profile_dir/ports.env" <<EOF_PORTS
PORT_BASE=25000
CONTROL_UI_PORT=25000
PROFILE_UI_PORT=25001
MCP_HOST_PORT=25080
REGISTRY_API_PORT=25085
CONTROL_API_PORT=25090
EXTERNAL_REST_API_PORT=25091
MEMBER_REGISTRATION_SERVICE_PORT=25092
RPC_PROXY_PORT=25094
WORKFLOW_APPROVAL_READER_PORT=25098
CONTROL_UI_URL=$(loopback_url 25000)
PROFILE_UI_URL=$(loopback_url 25001)
PROFILE_UI_BASE_URL=$(loopback_url 25001)
CONTROL_API_URL=$(loopback_url 25090)
EXTERNAL_REST_API_URL=$(loopback_url 25091)
MEMBER_REGISTRATION_SERVICE_URL=$(loopback_url 25092)
RPC_PROXY_URL=$(loopback_url 25094)
REGISTRY_API_URL=$(loopback_url 25085)
WORKFLOW_APPROVAL_READER_URL=$(loopback_url 25098)
MCP_HOST_URL=$(loopback_url 25080)
EOF_PORTS

lock_key="$(printf '%s\0%s\0%s\0%s\0%s' \
  "$fixture_repo" "$fixture_branch" "$fixture_head" \
  "$MINIKUBE_TEST_PROFILE" "$MINIKUBE_TEST_CONTEXT" | shasum | awk '{print $1}')"
process_start="$(ps -p $$ -o lstart= 2>/dev/null | sed 's/^ *//' || true)"
[[ -n "$process_start" ]] || process_start=unavailable
owner_lease_key=TO""KEN
{
  printf 'REPOSITORY=%s\n' "$fixture_repo"
  printf 'BRANCH=%s\nHEAD=%s\nPROFILE=%s\nCONTEXT=%s\n' \
    "$fixture_branch" "$fixture_head" "$MINIKUBE_TEST_PROFILE" "$MINIKUBE_TEST_CONTEXT"
  printf 'WORKTREE_ID=%s\nLOCK_KEY=%s\n' "$fixture_worktree_id" "$lock_key"
  printf '%s=%s\nPID=%s\nPROCESS_START=%s\n' \
    "$owner_lease_key" "$lease_value" "$$" "$process_start"
} >"$lock_dir/owner.env"

lease_env=(
  T2_PROJECT_DIR="$fixture_repo"
  MINIKUBE_PROFILE="$MINIKUBE_TEST_PROFILE"
  T2_PROFILE="$MINIKUBE_TEST_PROFILE"
  T2_CONTEXT="$MINIKUBE_TEST_CONTEXT"
  CONTROL_API_REAL_PG_CONTEXT="$MINIKUBE_TEST_CONTEXT"
  T2_BRANCH="$fixture_branch"
  T2_HEAD="$fixture_head"
  T2_WORKTREE_ID="$fixture_worktree_id"
  FIXTURE_BRANCH="$fixture_branch"
  FIXTURE_HEAD="$fixture_head"
  FIXTURE_WORKTREE_ID="$fixture_worktree_id"
  T2_PROFILE_ROOT="$TEST_TMP/profiles"
  T2_PROFILE_ENV="$profile_dir/profile.env"
  T2_PORTS_ENV="$profile_dir/ports.env"
  T2_LOCK_ROOT="$lock_root"
  T2_EVIDENCE_ROOT="$TEST_TMP/evidence"
  T2_SKIP_LOCK=true
)

if env "${lease_env[@]}" \
  bash -c 'set -euo pipefail; source "$1"; T2_BRANCH="$FIXTURE_BRANCH"; t2_profile_scope' \
  bash "$COMMON"; then
  pass 'schema-v2 fixture satisfies the current profile ownership contract'
else
  fail 'schema-v2 fixture was rejected by profile ownership validation'
fi

post_lease_sentinel="$TEST_TMP/post-lease-valid"
if env "${lease_env[@]}" "$lease_env_name=$lease_value" \
  POST_LEASE_SENTINEL="$post_lease_sentinel" \
  bash -c 'set -euo pipefail; source "$1"; T2_BRANCH="$FIXTURE_BRANCH"; T2_HEAD="$FIXTURE_HEAD"; T2_WORKTREE_ID="$FIXTURE_WORKTREE_ID"; t2_mutation_lock; : >"$POST_LEASE_SENTINEL"' \
  bash "$COMMON"; then
  [[ -e "$post_lease_sentinel" ]] \
    && pass 'matching inherited lease crosses the mutation-lock boundary' \
    || fail 'matching inherited lease did not reach the post-lease sentinel'
else
  fail 'matching inherited lease was rejected'
fi

wrong_lease_sentinel="$TEST_TMP/post-lease-wrong"
if output="$(env "${lease_env[@]}" "$lease_env_name=wrong-lease" \
  POST_LEASE_SENTINEL="$wrong_lease_sentinel" \
  bash -c 'set -euo pipefail; source "$1"; T2_BRANCH="$FIXTURE_BRANCH"; T2_HEAD="$FIXTURE_HEAD"; T2_WORKTREE_ID="$FIXTURE_WORKTREE_ID"; t2_mutation_lock; : >"$POST_LEASE_SENTINEL"' \
  bash "$COMMON" 2>&1)"; then
  fail 'mismatched inherited lease crossed the mutation-lock boundary'
else
  grep -Fq 'PROFILE_LOCK_REQUIRED' <<<"$output" \
    && pass 'mismatched inherited lease fails closed' \
    || fail 'mismatched inherited lease emitted no PROFILE_LOCK_REQUIRED error'
  [[ ! -e "$wrong_lease_sentinel" ]] \
    || fail 'mismatched inherited lease reached post-lease work'
fi

# Link the unit-proven lease boundary to the executable pre-gate ordering.
python3 - "$PRE_GATE" "$ROOT/Makefile" <<'PY'
from pathlib import Path
import sys

script = Path(sys.argv[1]).read_text()
makefile = Path(sys.argv[2]).read_text()
guard = script.index('if [ "$GATE_NAME" = "minikube-t2" ]; then')
dependency_check = script.index('  t2_require_commands', guard)
lease_check = script.index('  t2_mutation_lock', dependency_check)
post_lease = script.index('preflight_host_lifecycle_probe', lease_check)
assert guard < dependency_check < lease_check < post_lease
make_guard = makefile.index('T2_CANONICAL_ENTRYPOINT_REQUIRED')
make_delegate = makefile.index('scripts/minikube/pre-gate-sync.sh', make_guard)
assert make_guard < make_delegate
PY
pass 'entrypoint guard precedes dependency checks, lease validation, and post-lease work'

grep -Fq 'T2_CANONICAL_ORCHESTRATOR=true' "$ROOT/scripts/minikube/t2.sh" \
  && pass 'canonical orchestrator marks its private delegation' \
  || fail 'canonical orchestrator omits its private marker'
grep -Fq 'T2_SKIP_LOCK=true' "$ROOT/scripts/minikube/t2.sh" \
  && grep -Fq "$lease_env_name=\"\$$lease_env_name\"" "$ROOT/scripts/minikube/t2.sh" \
  && pass 'canonical orchestrator forwards its inherited lease' \
  || fail 'canonical orchestrator omits its inherited lease'
grep -Fq 'T2_RUN_ID="$T2_RUN_ID" T2_SETUP_HANDOFF_EXPECTED=' "$ROOT/scripts/minikube/t2.sh" \
  && pass 'canonical orchestrator forwards its run identity' \
  || fail 'canonical orchestrator omits its run identity'

minikube_test_assert_host_unchanged \
  && pass 'canonical-entrypoint fixture leaves the host checkout unchanged' \
  || fail 'canonical-entrypoint fixture mutated the host checkout'

exit "$FAIL"
