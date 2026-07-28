#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2030,SC2031
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

test_empty_secret_stage() (
  set -euo pipefail
  GFS_NS=gfs
  secret_resource_version() { printf '17'; }
  kc() {
    case " $* " in
      *' get secret '*' go-template='*) printf 'no' ;;
      *' patch secret '*)
        python3 -c 'import base64, json, sys
ops = json.load(sys.stdin)
assert ops[0] == {"op": "test", "path": "/metadata/resourceVersion", "value": "17"}
assert ops[1]["value"] == "ready"
assert ops[2]["path"] == "/data"
assert ops[2]["value"]["pending-connection-string"] == base64.b64encode(b"candidate").decode()
assert ops[3]["value"] == "pending"'
        ;;
      *) return 1 ;;
    esac
  }
  source "$ROOT/deploy/scripts/lib/gfs-credential-secret.sh"
  printf candidate | stage_secret_candidate empty-secret
) || fail 'empty Secret stage patch is invalid'

test_stage_conflict() (
  set -euo pipefail
  GFS_NS=gfs
  secret_resource_version() { printf '18'; }
  kc() {
    case " $* " in
      *' get secret '*' go-template='*) printf 'yes' ;;
      *' patch secret '*) cat >/dev/null; return 1 ;;
      *) return 1 ;;
    esac
  }
  source "$ROOT/deploy/scripts/lib/gfs-credential-secret.sh"
  ! printf candidate | stage_secret_candidate conflicted-secret
) || fail 'stage conflict was reported as success'

test_legacy_state_adoption() (
  set -euo pipefail
  GFS_NS=gfs
  kc() {
    case " $* " in
      *' get secret '*' go-template='*) printf yes ;;
      *' patch secret '*)
        python3 -c 'import json, sys
ops = json.load(sys.stdin)
assert ops == [
  {"op": "test", "path": "/metadata/resourceVersion", "value": "23"},
  {"op": "add", "path": "/metadata/annotations/clerum.io~1gfs-dsn-state", "value": "ready"},
]'
        ;;
      *) return 1 ;;
    esac
  }
  source "$ROOT/deploy/scripts/lib/gfs-credential-secret.sh"
  adopt_legacy_secret_state writer-secret 23 yes existing-stamp existing-stamp
) || fail 'legacy state adoption is not CAS guarded'

test_legacy_state_adoption_conflict() (
  set -euo pipefail
  GFS_NS=gfs
  live_state=applying
  kc() {
    case " $* " in
      *' patch secret '*) cat >/dev/null; return 1 ;;
      *) return 1 ;;
    esac
  }
  source "$ROOT/deploy/scripts/lib/gfs-credential-secret.sh"
  ! adopt_legacy_secret_state writer-secret stale-rv yes existing-stamp existing-stamp
  [ "$live_state" = applying ]
) || fail 'legacy adoption overwrote a concurrent applying state'

test_deployment_error_boundary() {
  local mode="$1" expected="$2" rc
  set +e
  (
    GFS_NS=gfs
    die() { exit 70; }
    kc() {
      if [ "$mode" = notfound ]; then
        printf 'Error from server (NotFound): deployment not found\n' >&2
      else
        printf 'Error from server (Forbidden): denied\n' >&2
      fi
      return 1
    }
    source "$ROOT/deploy/scripts/lib/gfs-credential-rollout.sh"
    deployment_exists gfsc-reader
  )
  rc=$?
  set -e
  [ "$rc" -eq "$expected" ] || fail "deployment $mode returned $rc, expected $expected"
}
test_deployment_error_boundary notfound 1
test_deployment_error_boundary forbidden 70

test_secret_reference_error() {
  local rc
  set +e
  (
    GFS_NS=gfs
    die() { exit 70; }
    kc() { printf 'connection refused\n' >&2; return 1; }
    source "$ROOT/deploy/scripts/lib/gfs-credential-rollout.sh"
    deployment_uses_secret gfsc-reader reader-secret
  )
  rc=$?
  set -e
  [ "$rc" -eq 70 ] || fail "Secret-reference API failure returned $rc"
}
test_secret_reference_error

test_pod_list_error() {
  local rc
  set +e
  (
    GFS_NS=gfs
    die() { exit 70; }
    gfs_secret_rotated_at() { printf '2026-01-01T00:00:00Z'; }
    kc() { printf 'RBAC denied\n' >&2; return 1; }
    source "$ROOT/deploy/scripts/lib/gfs-credential-rollout.sh"
    credential_rollout_pending gfsc-reader reader-secret
  )
  rc=$?
  set -e
  [ "$rc" -eq 70 ] || fail "pod-list API failure returned $rc"
}
test_pod_list_error

test_terminating_pod_filter() (
  set -euo pipefail
  GFS_NS=gfs
  gfs_secret_rotated_at() { printf '2026-01-02T00:00:00Z'; }
  kc() {
    printf '%s\n' \
      'gfsc-reader-old|2026-01-01T00:00:00Z|False|2026-01-02T00:01:00Z' \
      'gfsc-reader-new|2026-01-02T00:00:01Z|True|'
  }
  source "$ROOT/deploy/scripts/lib/gfs-credential-rollout.sh"
  ! credential_rollout_pending gfsc-reader reader-secret
) || fail 'terminating pod triggered a redundant rollout'

test_consecutive_pre_overlay_stage_preserves_pending() (
  set -euo pipefail
  GFS_NS=gfs
  deployment_uses_secret() { return 1; }
  credential_rollout_pending() { fail 'pending lifecycle must be gated by the deployment Secret reference'; }
  source "$ROOT/deploy/scripts/lib/gfs-credential-rollout.sh"
  ! credential_rollout_required gfsc-reader reader-secret rollout-pending
) || fail 'a consecutive pre-overlay reader stage could complete rollout-pending prematurely'

test_post_overlay_stage_completes_pending() (
  set -euo pipefail
  GFS_NS=gfs
  deployment_uses_secret() { [ "$1" = gfsc-reader ] && [ "$2" = reader-secret ]; }
  credential_rollout_pending() { fail 'pending lifecycle must use the explicit Secret-reference gate'; }
  source "$ROOT/deploy/scripts/lib/gfs-credential-rollout.sh"
  credential_rollout_required gfsc-reader reader-secret rollout-pending
) || fail 'post-overlay reader stage did not release rollout-pending'

test_idempotent_ready_stage_needs_no_rollout() (
  set -euo pipefail
  GFS_NS=gfs
  deployment_uses_secret() { fail 'ready lifecycle must not use the cutover gate'; }
  credential_rollout_pending() { return 1; }
  source "$ROOT/deploy/scripts/lib/gfs-credential-rollout.sh"
  ! credential_rollout_required gfsc-reader reader-secret ready
) || fail 'an idempotent reader stage requested a redundant rollout'

test_rollout_status_rc2() {
  local marker rc
  marker="$(mktemp)"
  set +e
  (
    GFS_NS=gfs
    ROLLOUT_TIMEOUT=1s
    GFS_RECOVER_ABANDONED_STATE=false
    die() { exit 70; }
    log() { :; }
    gfs_secret_rotated_at() { printf '2026-01-01T00:00:00Z'; }
    gfs_secret_state() { printf 'rollout-pending'; }
    claim_secret_rollout() { return 0; }
    mark_secret_rollout_ready() { printf marked >"$marker"; }
    kc() {
      case " $* " in
        *' get deployment '*) printf 'deployment.apps/gfsc-reader'; return 0 ;;
        *' rollout restart '*) return 0 ;;
        *' rollout status '*) return 2 ;;
      esac
      return 1
    }
    source "$ROOT/deploy/scripts/lib/gfs-credential-rollout.sh"
    complete_rollout reader-secret gfsc-reader
  )
  rc=$?
  set -e
  [ "$rc" -eq 2 ] || fail "rollout status rc=2 became $rc"
  [ ! -s "$marker" ] || fail 'failed rollout was marked ready'
  rm -f "$marker"
}
test_rollout_status_rc2

test_claimed_rollout_requires_confirmation() {
  local rc
  set +e
  (
    GFS_NS=gfs
    GFS_RECOVER_ABANDONED_STATE=false
    die() { exit 70; }
    gfs_secret_rotated_at() { printf '2026-01-01T00:00:00Z'; }
    gfs_secret_state() { printf 'rollout-running'; }
    source "$ROOT/deploy/scripts/lib/gfs-credential-rollout.sh"
    complete_rollout reader-secret gfsc-reader
  )
  rc=$?
  set -e
  [ "$rc" -eq 70 ] || fail "claimed rollout was adopted with rc=$rc"
}
test_claimed_rollout_requires_confirmation

test_fresh_applying_nologin_recovery() (
  set -euo pipefail
  GFS_NS=gfs
  GFS_RECOVER_ABANDONED_STATE=true
  released="$(mktemp)"
  trap 'rm -f "$released"' EXIT
  die() { exit 70; }
  log() { :; }
  dsn_has_role() { [ "$1" = candidate ] && [ "$2" = gfs_controller_reader ]; }
  dsn_authenticates_as() { return 1; }
  role_can_login() { printf f; }
  release_abandoned_candidate() { cat >"$released"; }
  source "$ROOT/deploy/scripts/lib/gfs-credential-recovery.sh"
  result="$(recover_abandoned_applying gfs_controller_reader reader-secret '' candidate)"
  [ "$result" = pending ] || fail "fresh NOLOGIN recovery returned $result"
  [ "$(cat "$released")" = candidate ] || fail 'fresh NOLOGIN recovery released the wrong candidate'
) || fail 'fresh NOLOGIN applying state was not safely resumable'

test_fresh_applying_login_fails_closed() {
  local rc
  set +e
  (
    set -euo pipefail
    GFS_NS=gfs
    GFS_RECOVER_ABANDONED_STATE=true
    die() { exit 70; }
    log() { :; }
    dsn_has_role() { return 0; }
    dsn_authenticates_as() { return 1; }
    role_can_login() { printf t; }
    release_abandoned_candidate() { fail 'LOGIN role candidate must not be released automatically'; }
    source "$ROOT/deploy/scripts/lib/gfs-credential-recovery.sh"
    recover_abandoned_applying gfs_controller_reader reader-secret '' candidate
  ) >/dev/null 2>&1
  rc=$?
  set -e
  [ "$rc" -eq 70 ] || fail "fresh LOGIN recovery returned $rc instead of failing closed"
}
test_fresh_applying_login_fails_closed

test_applied_candidate_recovery() (
  set -euo pipefail
  GFS_NS=gfs
  GFS_RECOVER_ABANDONED_STATE=true
  die() { exit 70; }
  log() { :; }
  dsn_has_role() { return 0; }
  dsn_authenticates_as() { [ "$1" = candidate ]; }
  role_can_login() { fail 'role state must not be queried after candidate authentication'; }
  release_abandoned_candidate() { fail 'applied candidate must not be released'; }
  source "$ROOT/deploy/scripts/lib/gfs-credential-recovery.sh"
  [ "$(recover_abandoned_applying gfs_controller_reader reader-secret active candidate)" = applied ]
) || fail 'applied candidate was not resumed without mutation'

test_active_candidate_release() (
  set -euo pipefail
  GFS_NS=gfs
  GFS_RECOVER_ABANDONED_STATE=true
  released="$(mktemp)"
  trap 'rm -f "$released"' EXIT
  die() { exit 70; }
  log() { :; }
  dsn_has_role() { return 0; }
  dsn_authenticates_as() { [ "$1" = active ]; }
  role_can_login() { fail 'role state must not be queried with a valid active credential'; }
  release_abandoned_candidate() { cat >"$released"; }
  source "$ROOT/deploy/scripts/lib/gfs-credential-recovery.sh"
  [ "$(recover_abandoned_applying gfs_controller_reader reader-secret active candidate)" = pending ]
  [ "$(cat "$released")" = candidate ]
) || fail 'valid active credential did not release the abandoned candidate'

test_release_cas_loss_fails_closed() {
  local rc
  set +e
  (
    set -euo pipefail
    GFS_NS=gfs
    GFS_RECOVER_ABANDONED_STATE=true
    die() { exit 70; }
    log() { :; }
    dsn_has_role() { return 0; }
    dsn_authenticates_as() { [ "$1" = active ]; }
    role_can_login() { return 1; }
    release_abandoned_candidate() { cat >/dev/null; return 1; }
    source "$ROOT/deploy/scripts/lib/gfs-credential-recovery.sh"
    recover_abandoned_applying gfs_controller_reader reader-secret active candidate
  ) >/dev/null 2>&1
  rc=$?
  set -e
  [ "$rc" -eq 70 ] || fail "lost recovery CAS returned $rc instead of failing closed"
}
test_release_cas_loss_fails_closed

test_verifier_lifecycle_gate() {
  local state="$1" pending="$2" fake_dir rc
  fake_dir="$(mktemp -d)"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case " $* " in' \
    '  *" get crd globalfilesystems.clerum.io "*) echo globalfilesystems.clerum.io ;;' \
    '  *" get globalfilesystem gfs "*) echo globalfilesystem.clerum.io/gfs ;;' \
    '  *" get configmap gfs-config "*) echo configmap/gfs-config ;;' \
    '  *" get secret "*"jsonpath={.metadata.annotations.clerum\\.io/gfs-dsn-state}"*) printf "%s" "$FAKE_STATE" ;;' \
    '  *" get secret "*"go-template="*) printf "%s" "$FAKE_PENDING" ;;' \
    '  *) exit 1 ;;' \
    'esac' >"$fake_dir/kubectl"
  chmod +x "$fake_dir/kubectl"
  set +e
  PATH="$fake_dir:$PATH" FAKE_STATE="$state" FAKE_PENDING="$pending" CONTEXT=fake \
    bash "$ROOT/scripts/minikube/verify-gfs.sh" >/dev/null 2>&1
  rc=$?
  set -e
  rm -rf "$fake_dir"
  [ "$rc" -ne 0 ] || fail "verifier accepted state=$state pending=$pending"
}
test_verifier_lifecycle_gate applying no
test_verifier_lifecycle_gate ready yes

test_verifier_crd_gate() {
  local mode="$1" expected="$2" fake_dir rc
  fake_dir="$(mktemp -d)"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$FAKE_CRD_MODE" = notfound ]; then echo "Error from server (NotFound): CRD not found" >&2; else echo "Error from server (Forbidden): denied" >&2; fi' \
    'exit 1' >"$fake_dir/kubectl"
  chmod +x "$fake_dir/kubectl"
  set +e
  PATH="$fake_dir:$PATH" FAKE_CRD_MODE="$mode" CONTEXT=fake \
    bash "$ROOT/scripts/minikube/verify-gfs.sh" >/dev/null 2>&1
  rc=$?
  set -e
  rm -rf "$fake_dir"
  [ "$rc" -eq "$expected" ] || fail "verifier CRD $mode returned $rc, expected $expected"
}
test_verifier_crd_gate notfound 0
test_verifier_crd_gate forbidden 1

printf 'PASS: GFS credential lifecycle fail-closed contract\n'
