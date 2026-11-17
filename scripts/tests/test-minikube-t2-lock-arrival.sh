#!/usr/bin/env bash
# Exercise arrivals while a stale profile lock is being reclaimed.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd -P)"
TMP_DIR="$(mktemp -d)"
LOCK_ROOT="$TMP_DIR/locks"
LOCK_DIR="$LOCK_ROOT/race-profile.lock"
CLAIM_DIR="$LOCK_ROOT/race-profile.reclaim"
PIDS=()

cleanup() {
  # Let only this fixture's workers exit before removing their temporary files.
  : >"$TMP_DIR/continue-stale"
  for role in stale new normal orphan symlink broken-claim fresh-a fresh-b; do : >"$TMP_DIR/release-$role"; done
  if [[ "${PIDS+x}" == x ]]; then
    for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  fi
  rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT
mkdir -p "$LOCK_ROOT"

cat >"$TMP_DIR/worker.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source "$TEST_COMMON"
T2_PROJECT_DIR="$TEST_ROOT"
T2_BRANCH=feat/lock-arrival
T2_HEAD=1111111111111111111111111111111111111111
T2_ORIGIN_DEV=2222222222222222222222222222222222222222
T2_PROFILE=race-profile
T2_CONTEXT=race-profile
T2_WORKTREE_ID=lock-arrival-worktree
T2_LOCK_ROOT="$TEST_LOCK_ROOT"

t2_lock_process_matches() {
  [[ "$1" != 999999 ]] && kill -0 "$1" 2>/dev/null
}

if [[ "$TEST_ROLE" == stale ]]; then
  rm() {
    command rm "$@"
    if [[ "${*: -1}" == "$T2_LOCK_DIR" && ! -e "$TEST_DIR/stale-removed" ]]; then
      : >"$TEST_DIR/stale-removed"
      deadline=$((SECONDS + 10))
      while [[ ! -e "$TEST_DIR/continue-stale" ]]; do
        (( SECONDS < deadline )) || return 70
        sleep 0.02
      done
    fi
  }
fi

# Simulate a non-recursive mkdir that reports success when a concurrent
# creator wins. Only the fixture's lock and claim paths receive this behavior.
if [[ "$TEST_ROLE" == broken-claim || "$TEST_ROLE" == fresh-a || "$TEST_ROLE" == fresh-b ]]; then
  mkdir() {
    if [[ "$TEST_ROLE" == broken-claim && $# -eq 1 && "$1" == "$T2_LOCK_ROOT/race-profile.reclaim" ]]; then
      return 0
    fi
    if [[ "$TEST_ROLE" == fresh-* && $# -eq 1 && "$1" == "$T2_LOCK_ROOT/race-profile.lock" ]]; then
      : >"$TEST_DIR/ready-$TEST_ROLE"
      local deadline=$((SECONDS + 10))
      while [[ ! -e "$TEST_DIR/ready-fresh-a" || ! -e "$TEST_DIR/ready-fresh-b" ]]; do
        (( SECONDS < deadline )) || return 70
        sleep 0.02
      done
      command mkdir "$@" 2>/dev/null || [[ -d "$1" ]]
      return
    fi
    command mkdir "$@"
  }
fi

publish_result() {
  printf '%s\n' "$1" >"$TEST_DIR/result-$TEST_ROLE.tmp"
  mv "$TEST_DIR/result-$TEST_ROLE.tmp" "$TEST_DIR/result-$TEST_ROLE"
}

if t2_lock_acquire; then
  publish_result acquired
  deadline=$((SECONDS + 10))
  while [[ ! -e "$TEST_DIR/release-$TEST_ROLE" ]]; do
    (( SECONDS < deadline )) || exit 71
    sleep 0.02
  done
  t2_lock_release 0
  exit 0
fi
publish_result rejected
exit 1
SH

start_worker() {
  local role="$1"
  env -i HOME="$TMP_DIR" PATH="$PATH" TMPDIR="$TMP_DIR" \
    TEST_ROOT="$ROOT" TEST_COMMON="$ROOT/scripts/minikube/t2-common.sh" \
    TEST_DIR="$TMP_DIR" TEST_LOCK_ROOT="$LOCK_ROOT" TEST_ROLE="$role" \
    bash "$TMP_DIR/worker.sh" >"$TMP_DIR/$role.log" 2>&1 &
  WORKER_PID=$!
  PIDS+=("$WORKER_PID")
}

wait_for_file() {
  local file="$1" pid="$2" deadline=$((SECONDS + 10))
  while [[ ! -e "$file" ]]; do
    if ! kill -0 "$pid" 2>/dev/null || (( SECONDS >= deadline )); then
      [[ -e "$file" ]] && return 0
      printf 'FAIL: fixture did not reach %s\n' "${file##*/}" >&2
      return 1
    fi
    sleep 0.02
  done
}

mkdir "$LOCK_DIR"
printf 'PID=999999\nTOKEN=stale-token\nPROCESS_START=stale-start\n' >"$LOCK_DIR/owner.env"
start_worker stale
stale_pid="$WORKER_PID"
wait_for_file "$TMP_DIR/stale-removed" "$stale_pid"
[[ -d "$CLAIM_DIR" && ! -e "$LOCK_DIR" ]] || {
  printf 'FAIL: stale reclaimer did not expose the protected arrival window\n' >&2
  exit 1
}
start_worker new
new_pid="$WORKER_PID"
wait_for_file "$TMP_DIR/result-new" "$new_pid"
new_result="$(cat "$TMP_DIR/result-new")"
: >"$TMP_DIR/continue-stale"
if [[ "$new_result" != rejected ]]; then
  # Keep the newcomer inside its critical section while the reclaimer resumes.
  wait "$stale_pid" 2>/dev/null || true
  : >"$TMP_DIR/release-new"
  wait "$new_pid" 2>/dev/null || true
  printf 'FAIL: a new arrival entered while the stale reclaim claim was held\n' >&2
  exit 1
fi
if wait "$new_pid"; then
  printf 'FAIL: rejected arrival returned success\n' >&2
  exit 1
fi
wait_for_file "$TMP_DIR/result-stale" "$stale_pid"
[[ "$(cat "$TMP_DIR/result-stale")" == acquired && -d "$CLAIM_DIR" ]] || {
  printf 'FAIL: stale reclaimer failed to acquire and retain its claim\n' >&2
  exit 1
}
: >"$TMP_DIR/release-stale"
wait "$stale_pid"
[[ ! -e "$LOCK_DIR" && ! -e "$CLAIM_DIR" ]] || {
  printf 'FAIL: stale reclaimer did not release its lock and claim\n' >&2
  exit 1
}

start_worker normal
normal_pid="$WORKER_PID"
wait_for_file "$TMP_DIR/result-normal" "$normal_pid"
[[ "$(cat "$TMP_DIR/result-normal")" == acquired && ! -e "$CLAIM_DIR" ]] || {
  printf 'FAIL: ordinary acquisition did not retain its existing behavior\n' >&2
  exit 1
}
mkdir "$CLAIM_DIR"
: >"$TMP_DIR/release-normal"
wait "$normal_pid"
[[ -d "$CLAIM_DIR" && ! -e "$LOCK_DIR" ]] || {
  printf 'FAIL: ordinary owner removed another claimant\x27s recovery claim\n' >&2
  exit 1
}
rmdir "$CLAIM_DIR"

mkdir "$CLAIM_DIR"
start_worker orphan
orphan_pid="$WORKER_PID"
wait_for_file "$TMP_DIR/result-orphan" "$orphan_pid"
[[ "$(cat "$TMP_DIR/result-orphan")" == rejected ]] && ! wait "$orphan_pid" &&
  [[ -d "$CLAIM_DIR" && ! -e "$LOCK_DIR" ]] || {
    printf 'FAIL: orphaned recovery claim was not preserved\n' >&2
    exit 1
  }
rmdir "$CLAIM_DIR"

ln -s "$TMP_DIR/missing-claim" "$CLAIM_DIR"
start_worker symlink
symlink_pid="$WORKER_PID"
wait_for_file "$TMP_DIR/result-symlink" "$symlink_pid"
[[ "$(cat "$TMP_DIR/result-symlink")" == rejected ]] && ! wait "$symlink_pid" &&
  [[ -L "$CLAIM_DIR" && ! -e "$LOCK_DIR" ]] || {
    printf 'FAIL: dangling recovery claim was not preserved\n' >&2
    exit 1
  }
rm -- "$CLAIM_DIR"

mkdir "$LOCK_DIR" "$CLAIM_DIR"
printf 'PID=999999\nTOKEN=stale-token\nPROCESS_START=stale-start\n' >"$LOCK_DIR/owner.env"
start_worker broken-claim
broken_claim_pid="$WORKER_PID"
wait_for_file "$TMP_DIR/result-broken-claim" "$broken_claim_pid"
[[ "$(cat "$TMP_DIR/result-broken-claim")" == rejected ]] && ! wait "$broken_claim_pid" &&
  [[ -d "$CLAIM_DIR" && "$(sed -n 's/^PID=//p' "$LOCK_DIR/owner.env")" == 999999 ]] || {
    printf 'FAIL: a falsely successful mkdir bypassed the existing reclaim claim\n' >&2
    exit 1
  }
rm -rf -- "$LOCK_DIR"
rmdir "$CLAIM_DIR"

start_worker fresh-a
fresh_a_pid="$WORKER_PID"
start_worker fresh-b
fresh_b_pid="$WORKER_PID"
wait_for_file "$TMP_DIR/result-fresh-a" "$fresh_a_pid"
wait_for_file "$TMP_DIR/result-fresh-b" "$fresh_b_pid"
fresh_results="$(cat "$TMP_DIR/result-fresh-a")/$(cat "$TMP_DIR/result-fresh-b")"
[[ "$fresh_results" == acquired/rejected || "$fresh_results" == rejected/acquired ]] || {
  printf 'FAIL: falsely successful mkdir admitted multiple fresh owners (%s)\n' "$fresh_results" >&2
  exit 1
}
: >"$TMP_DIR/release-fresh-a"
: >"$TMP_DIR/release-fresh-b"
set +e
wait "$fresh_a_pid"; fresh_a_rc=$?
wait "$fresh_b_pid"; fresh_b_rc=$?
set -e
if ! { [[ "$fresh_a_rc" -eq 0 && "$fresh_b_rc" -ne 0 ]] || [[ "$fresh_b_rc" -eq 0 && "$fresh_a_rc" -ne 0 ]]; }; then
  printf 'FAIL: fresh owners did not exit with one success and one rejection\n' >&2
  exit 1
fi
[[ ! -e "$LOCK_DIR" && ! -e "$CLAIM_DIR" ]] || {
  printf 'FAIL: fresh owner did not release its lock\n' >&2
  exit 1
}

printf 'PASS: new arrivals respect reclaim ownership and orphaned claims\n'
printf 'PASS: exclusive lock and reclaim creation reject a falsely successful mkdir\n'
