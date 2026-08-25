#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TMP_DIR"' EXIT

BIN_DIR="$TMP_DIR/bin"
FIXTURE="$TMP_DIR/repo"
RUNTIME_TMP="$TMP_DIR/runtime-tmp"
LOCK_ROOT="$TMP_DIR/locks"
MINIKUBE_LOG="$TMP_DIR/minikube.log"
KUBECTL_LOG="$TMP_DIR/kubectl.log"
DOCKER_LOG="$TMP_DIR/docker.log"
DESCENDANT_PID_FILE="$TMP_DIR/descendant.pid"
PROFILE=hardening-profile
LEASE_VALUE=fixture-value
LEASE_ENV_KEY=T2_LOCK_TOKEN
FAIL=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=1; }

mkdir -p "$BIN_DIR" "$RUNTIME_TMP" "$TMP_DIR/home"

cat >"$BIN_DIR/fake-runtime-lib.sh" <<'STUB'
fake_run_mode() {
  local mode="$1" operation="$2" descendant
  case "$mode" in
    success) return 0 ;;
    hang)
      (
        trap '' TERM INT
        while true; do sleep 1; done
      ) &
      descendant=$!
      printf '%s:%s\n' "$operation" "$descendant" >"${DESCENDANT_PID_FILE:?}"
      wait "$descendant"
      ;;
    death)
      kill -TERM "$BASHPID"
      sleep 5
      ;;
    exit-*) exit "${mode#exit-}" ;;
    *) printf 'unknown fake mode: %s\n' "$mode" >&2; exit 98 ;;
  esac
}
STUB

cat >"$BIN_DIR/minikube" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/dev/null
source "${FAKE_RUNTIME_LIB:?}"
printf '%s\n' "$*" >>"${MINIKUBE_LOG:?}"

case "$*" in
  *" status")
    fake_run_mode "${FAKE_MINIKUBE_STATUS_MODE:-success}" minikube-status
    ;;
  *" docker-env"*)
    fake_run_mode "${FAKE_MINIKUBE_DOCKER_ENV_MODE:-success}" minikube-docker-env
    printf 'export DOCKER_HOST="tcp://127.0.0.1:2376"\n'
    printf 'export MINIKUBE_ACTIVE_DOCKERD="fixture"\n'
    ;;
  *" ip")
    printf '127.0.0.1\n'
    ;;
  *" image ls"*)
    fake_run_mode "${FAKE_MINIKUBE_INVENTORY_MODE:-success}" minikube-image-inventory
    printf '%s' "${FAKE_MINIKUBE_INVENTORY_JSON:-[]}"
    ;;
  *" image load"*)
    fake_run_mode "${FAKE_MINIKUBE_LOAD_MODE:-success}" minikube-image-load
    ;;
esac
STUB

cat >"$BIN_DIR/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/dev/null
source "${FAKE_RUNTIME_LIB:?}"
printf '%s\n' "$*" >>"${KUBECTL_LOG:?}"
if [[ "$*" == *"get nodes"* ]]; then
  fake_run_mode "${FAKE_KUBECTL_NODES_MODE:-success}" kubectl-get-nodes
  printf 'fixture-node Ready control-plane 1d v1.30.0\n'
fi
STUB

cat >"$BIN_DIR/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${DOCKER_LOG:?}"

if [[ "${1:-}" == context && "${2:-}" == inspect ]]; then
  effective_host="${DOCKER_HOST:-unix:///tmp/evenfire-fake-docker.sock}"
  if [[ "$*" == *TLSMaterial* ]]; then
    printf '%s\tfalse\t{}\n' "$effective_host"
  else
    printf '%s\n' "$effective_host"
  fi
  exit 0
fi
if [[ "${1:-}" == buildx && "${2:-}" == version ]]; then
  printf 'github.com/docker/buildx fake\n'
  exit 0
fi
if [[ "${1:-}" == info ]]; then
  exit 0
fi
if [[ "${1:-}" == images && "${2:-}" == -q ]]; then
  if [[ -z "${FAKE_DOCKER_QUERY_MATCH:-}" || "$*" == *"$FAKE_DOCKER_QUERY_MATCH"* ]]; then
    query_status="${FAKE_DOCKER_QUERY_STATUS:-0}"
    [[ "$query_status" -eq 0 ]] || exit "$query_status"
    printf '%s' "${FAKE_DOCKER_QUERY_OUTPUT:-}"
  else
    printf '%s' "${FAKE_DOCKER_DEFAULT_QUERY_OUTPUT:-}"
  fi
  exit 0
fi
if [[ "${1:-}" == pull ]]; then
  exit "${FAKE_DOCKER_PULL_STATUS:-0}"
fi
if [[ "${1:-}" == image && "${2:-}" == inspect ]]; then
  printf 'legacy image inspect must not determine absence\n' >&2
  exit 88
fi
if [[ "${1:-}" == inspect ]]; then
  printf 'sha256:deadbeef0000cafedeadbeef0000cafedeadbeef\n'
  exit 0
fi
exit 0
STUB

cat >"$BIN_DIR/docker-buildx" <<'STUB'
#!/usr/bin/env bash
printf 'github.com/docker/buildx fake\n'
STUB

chmod +x "$BIN_DIR/minikube" "$BIN_DIR/kubectl" "$BIN_DIR/docker" \
  "$BIN_DIR/docker-buildx"

prepare_fixture() {
  mkdir -p "$FIXTURE/scripts/minikube" "$FIXTURE/scripts/release" \
    "$FIXTURE/deploy/minikube" "$FIXTURE/control-api"
  cp \
    "$ROOT/scripts/minikube/build-images.sh" \
    "$ROOT/scripts/minikube/docker-cli-env.sh" \
    "$ROOT/scripts/minikube/image-mode.sh" \
    "$ROOT/scripts/minikube/port-forward-owner.sh" \
    "$ROOT/scripts/minikube/profile-owner.sh" \
    "$ROOT/scripts/minikube/profile-readiness.sh" \
    "$ROOT/scripts/minikube/require-t2-mutation-lock.sh" \
    "$ROOT/scripts/minikube/run-with-deadline.mjs" \
    "$ROOT/scripts/minikube/t2-common.sh" \
    "$ROOT/scripts/minikube/t2-worktree-id.sh" \
    "$FIXTURE/scripts/minikube/"
  cp "$ROOT/scripts/release/images-manifest.mjs" "$FIXTURE/scripts/release/"
  cp "$ROOT/deploy/images.json" "$FIXTURE/deploy/images.json"
  printf 'FROM scratch\n' >"$FIXTURE/control-api/Dockerfile"
  chmod +x "$FIXTURE/scripts/minikube/build-images.sh" \
    "$FIXTURE/scripts/minikube/require-t2-mutation-lock.sh" \
    "$FIXTURE/scripts/minikube/run-with-deadline.mjs"

  git -C "$FIXTURE" init -q
  git -C "$FIXTURE" config user.email hardening-test@example.invalid
  git -C "$FIXTURE" config user.name hardening-test
  git -C "$FIXTURE" add .
  git -C "$FIXTURE" commit -qm fixture
}

prepare_lease() {
  local branch head worktree_id lock_key lock_dir
  branch="$(git -C "$FIXTURE" branch --show-current)"
  head="$(git -C "$FIXTURE" rev-parse --verify HEAD)"
  worktree_id="$(printf '%s' "$FIXTURE" | shasum | awk '{print $1}')"
  lock_key="$(printf '%s\0%s\0%s\0%s\0%s' \
    "$FIXTURE" "$branch" "$head" "$PROFILE" "$PROFILE" | shasum | awk '{print $1}')"
  lock_dir="$LOCK_ROOT/$PROFILE.lock"
  mkdir -p "$lock_dir"
  {
    printf 'REPOSITORY=%s\n' "$FIXTURE"
    printf 'BRANCH=%s\n' "$branch"
    printf 'HEAD=%s\n' "$head"
    printf 'PROFILE=%s\n' "$PROFILE"
    printf 'CONTEXT=%s\n' "$PROFILE"
    printf 'WORKTREE_ID=%s\n' "$worktree_id"
    printf 'LOCK_KEY=%s\n' "$lock_key"
    printf '%s=%s\n' TOKEN "$LEASE_VALUE"
    printf 'PID=%s\n' "$$"
    printf 'PROCESS_START=unavailable\n'
  } >"$lock_dir/owner.env"
}

prepare_fixture
FIXTURE="$(cd "$FIXTURE" && pwd -P)"
BUILD_SCRIPT="$FIXTURE/scripts/minikube/build-images.sh"
prepare_lease

clear_runtime_state() {
  : >"$MINIKUBE_LOG"
  : >"$KUBECTL_LOG"
  : >"$DOCKER_LOG"
  rm -f -- "$DESCENDANT_PID_FILE"
}

runtime_logs_are_empty() {
  [[ ! -s "$MINIKUBE_LOG" && ! -s "$KUBECTL_LOG" && ! -s "$DOCKER_LOG" ]]
}

run_build() {
  local output="$1" lease_mode="$2"
  shift 2
  local -a lease_env=()
  case "$lease_mode" in
    valid)
      lease_env=(
        "T2_PROJECT_DIR=$FIXTURE"
        "T2_PROFILE=$PROFILE"
        "T2_CONTEXT=$PROFILE"
        "${LEASE_ENV_KEY}=$LEASE_VALUE"
      )
      ;;
    wrong-value)
      lease_env=(
        "T2_PROJECT_DIR=$FIXTURE"
        "T2_PROFILE=$PROFILE"
        "T2_CONTEXT=$PROFILE"
        "${LEASE_ENV_KEY}=wrong-value"
      )
      ;;
    wrong-context)
      lease_env=(
        "T2_PROJECT_DIR=$FIXTURE"
        "T2_PROFILE=$PROFILE"
        T2_CONTEXT=foreign-context
        "${LEASE_ENV_KEY}=$LEASE_VALUE"
      )
      ;;
    missing|verify) ;;
    *) printf 'unknown lease mode: %s\n' "$lease_mode" >&2; return 99 ;;
  esac

  /usr/bin/env -i \
    "HOME=$TMP_DIR/home" \
    "PATH=$BIN_DIR:$PATH" \
    "TMPDIR=$RUNTIME_TMP" \
    LC_ALL=C \
    "MINIKUBE_PROFILE=$PROFILE" \
    "CONTROL_API_REAL_PG_CONTEXT=$PROFILE" \
    "T2_LOCK_ROOT=$LOCK_ROOT" \
    "MINIKUBE_LOG=$MINIKUBE_LOG" \
    "KUBECTL_LOG=$KUBECTL_LOG" \
    "DOCKER_LOG=$DOCKER_LOG" \
    "DESCENDANT_PID_FILE=$DESCENDANT_PID_FILE" \
    "FAKE_RUNTIME_LIB=$BIN_DIR/fake-runtime-lib.sh" \
    "MINIKUBE_DOCKER_BUILDX_PLUGIN=$BIN_DIR/docker-buildx" \
    MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS=1 \
    MINIKUBE_DOCKER_PULL_TIMEOUT_SECONDS=2 \
    MINIKUBE_DOCKER_BUILD_TIMEOUT_SECONDS=2 \
    MINIKUBE_DOCKER_HEARTBEAT_SECONDS=1 \
    MINIKUBE_DOCKER_KILL_GRACE_SECONDS=1 \
    MINIKUBE_STATUS_TIMEOUT_SECONDS=1 \
    MINIKUBE_DOCKER_ENV_TIMEOUT_SECONDS=1 \
    MINIKUBE_KUBECTL_TIMEOUT_SECONDS=1 \
    MINIKUBE_KUBECTL_REQUEST_TIMEOUT_SECONDS=1 \
    MINIKUBE_IMAGE_INVENTORY_TIMEOUT_SECONDS=1 \
    MINIKUBE_BASE_IMAGE_PULL_RETRIES=1 \
    MINIKUBE_BASE_IMAGE_PULL_DELAY_SECS=0 \
    MINIKUBE_PRELOAD_BASE_IMAGES=false \
    IMAGE_SOURCE=local \
    "${lease_env[@]}" \
    "$@" >"$output" 2>&1
}

assert_rejected_before_runtime() {
  local name="$1" pattern="$2"
  shift 2
  local output="$TMP_DIR/${name}.out" status=0
  clear_runtime_state
  run_build "$output" missing bash "$BUILD_SCRIPT" "$@" || status=$?
  if [[ "$status" -eq 2 ]] && grep -Fq -- "$pattern" "$output" \
    && runtime_logs_are_empty; then
    pass "$name fails before any Docker, Minikube, or kubectl call"
  else
    fail "$name did not fail pre-runtime (status=$status)"
  fi
}

assert_rejected_before_runtime empty-selector 'selector must not be empty' --only=
assert_rejected_before_runtime unknown-selector 'Unknown --only selector' --only=not-a-real-image

assert_invalid_knob() {
  local name="$1" assignment="$2"
  local output="$TMP_DIR/${name}.out" status=0
  clear_runtime_state
  run_build "$output" valid "$assignment" bash "$BUILD_SCRIPT" --only=control-api || status=$?
  if [[ "$status" -eq 2 ]] && grep -Fq 'DOCKER_DEADLINE_INVALID' "$output" \
    && runtime_logs_are_empty; then
    pass "$name is rejected with a finite range before runtime"
  else
    fail "$name was accepted or reached runtime (status=$status)"
  fi
}

assert_invalid_knob retry-zero MINIKUBE_BASE_IMAGE_PULL_RETRIES=0
assert_invalid_knob retry-over-max MINIKUBE_BASE_IMAGE_PULL_RETRIES=11
assert_invalid_knob delay-over-max MINIKUBE_BASE_IMAGE_PULL_DELAY_SECS=301
assert_invalid_knob delay-not-numeric MINIKUBE_BASE_IMAGE_PULL_DELAY_SECS=forever

assert_lease_failure() {
  local mode="$1" name="$2" status=0
  local output="$TMP_DIR/lease-${mode}.out"
  clear_runtime_state
  run_build "$output" "$mode" bash "$BUILD_SCRIPT" --only=control-api || status=$?
  if [[ "$status" -ne 0 ]] && grep -Fq 'PROFILE_LOCK_REQUIRED' "$output" \
    && runtime_logs_are_empty; then
    pass "$name fails before Docker, Minikube, and kubectl invocation"
  else
    fail "$name escaped the inherited lease boundary (status=$status)"
  fi
}

assert_lease_failure missing 'a missing mutation lease'
assert_lease_failure wrong-value 'a wrong mutation lease value'
assert_lease_failure wrong-context 'a wrong mutation target context'

clear_runtime_state
valid_output="$TMP_DIR/lease-valid.out"
valid_status=0
run_build "$valid_output" valid FAKE_MINIKUBE_STATUS_MODE=exit-47 \
  bash "$BUILD_SCRIPT" --only=control-api || valid_status=$?
if [[ "$valid_status" -eq 47 ]] \
  && grep -Fq -- "-p $PROFILE status" "$MINIKUBE_LOG" \
  && grep -Fq 'label=minikube-status event=exit' "$valid_output"; then
  pass 'the exact canonical inherited lease reaches the bounded profile status probe'
else
  fail "the valid inherited lease was rejected (status=$valid_status)"
fi

clear_runtime_state
verify_output="$TMP_DIR/verify-only.out"
verify_status=0
run_build "$verify_output" verify bash "$BUILD_SCRIPT" --verify-only || verify_status=$?
if [[ "$verify_status" -eq 1 ]] \
  && ! grep -Fq 'PROFILE_LOCK_REQUIRED' "$verify_output" \
  && grep -Fq -- "-p $PROFILE status" "$MINIKUBE_LOG" \
  && grep -Fq -- "-p $PROFILE image ls --format=json" "$MINIKUBE_LOG" \
  && grep -Fq -- "--context=$PROFILE get nodes --request-timeout=1s --no-headers" "$KUBECTL_LOG" \
  && [[ ! -s "$DOCKER_LOG" ]]; then
  pass 'verify-only is lease-exempt while retaining bounded explicit runtime reads'
else
  fail "verify-only did not preserve its read-only lease exemption (status=$verify_status)"
fi

clear_runtime_state
inventory_failure_output="$TMP_DIR/inventory-failure.out"
inventory_failure_status=0
run_build "$inventory_failure_output" verify \
  FAKE_MINIKUBE_INVENTORY_MODE=exit-1 \
  bash "$BUILD_SCRIPT" --verify-only || inventory_failure_status=$?
if [[ "$inventory_failure_status" -eq 2 ]] \
  && grep -Fq 'Minikube image inventory failed or exceeded its deadline' "$inventory_failure_output" \
  && ! grep -Fq 'MISSING:' "$inventory_failure_output" \
  && [[ ! -s "$DOCKER_LOG" ]]; then
  pass 'a Minikube inventory failure is not misclassified as a missing image'
else
  fail "a Minikube inventory failure was treated as an image miss (status=$inventory_failure_status)"
fi

clear_runtime_state
mutation_inventory_failure_output="$TMP_DIR/mutation-inventory-failure.out"
mutation_inventory_failure_status=0
run_build "$mutation_inventory_failure_output" valid \
  MINIKUBE_PRELOAD_BASE_IMAGES=true \
  FAKE_MINIKUBE_INVENTORY_MODE=exit-1 \
  bash "$BUILD_SCRIPT" --only=control-api || mutation_inventory_failure_status=$?
if [[ "$mutation_inventory_failure_status" -eq 2 ]] \
  && grep -Fq 'Could not inspect' "$mutation_inventory_failure_output" \
  && ! grep -Fq 'image load' "$MINIKUBE_LOG" \
  && ! grep -Fq ' pull ' "$DOCKER_LOG"; then
  pass 'a failed Minikube inventory blocks mutation before pull or load'
else
  fail "a failed Minikube inventory reached image mutation (status=$mutation_inventory_failure_status)"
fi

descendant_is_dead() {
  local record descendant
  [[ -f "$DESCENDANT_PID_FILE" ]] || return 1
  record="$(<"$DESCENDANT_PID_FILE")"
  descendant="${record#*:}"
  [[ "$descendant" =~ ^[1-9][0-9]*$ ]] || return 1
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if ! kill -0 "$descendant" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

assert_bounded_operation() {
  local operation="$1" status=0 label
  local output="$TMP_DIR/timeout-${operation}.out"
  local -a mode_env=()
  case "$operation" in
    status)
      label=minikube-status
      mode_env=(FAKE_MINIKUBE_STATUS_MODE=hang)
      ;;
    nodes)
      label=minikube-get-nodes
      mode_env=(FAKE_KUBECTL_NODES_MODE=hang)
      ;;
    docker-env)
      label=minikube-docker-env
      mode_env=(FAKE_MINIKUBE_DOCKER_ENV_MODE=hang)
      ;;
  esac
  clear_runtime_state
  run_build "$output" valid "${mode_env[@]}" \
    bash "$BUILD_SCRIPT" --only=control-api || status=$?
  if [[ "$status" -eq 124 ]] \
    && grep -Fq "label=$label event=timeout" "$output" \
    && grep -Fq "label=$label event=terminated" "$output" \
    && descendant_is_dead; then
    pass "$operation has a finite deadline, returns 124, and kills descendants"
  else
    fail "$operation deadline contract failed (status=$status)"
    tail -20 "$output" >&2 || true
  fi
}

assert_bounded_operation status
assert_bounded_operation nodes
assert_bounded_operation docker-env

if grep -Fq -- "--context=$PROFILE get nodes --request-timeout=1s --no-headers" "$KUBECTL_LOG" \
  && grep -Fq -- "-p $PROFILE docker-env --shell bash" "$MINIKUBE_LOG"; then
  pass 'node and docker-env probes carry the explicit profile/context and request timeout'
else
  fail 'bounded probes omitted an explicit profile, context, or kubectl request timeout'
fi

assert_child_death_status() {
  local operation="$1" status=0 label
  local output="$TMP_DIR/death-${operation}.out"
  local -a mode_env=()
  case "$operation" in
    status)
      label=minikube-status
      mode_env=(FAKE_MINIKUBE_STATUS_MODE=death)
      ;;
    nodes)
      label=minikube-get-nodes
      mode_env=(FAKE_KUBECTL_NODES_MODE=death)
      ;;
    docker-env)
      label=minikube-docker-env
      mode_env=(FAKE_MINIKUBE_DOCKER_ENV_MODE=death)
      ;;
  esac
  clear_runtime_state
  run_build "$output" valid "${mode_env[@]}" \
    bash "$BUILD_SCRIPT" --only=control-api || status=$?
  if [[ "$status" -eq 143 ]] \
    && grep -Fq "label=$label event=exit" "$output" \
    && grep -Fq 'signal=SIGTERM exitCode=143' "$output"; then
    pass "$operation preserves deterministic child-death status 143"
  else
    fail "$operation changed or hid child-death status (status=$status)"
    tail -20 "$output" >&2 || true
  fi
}

assert_child_death_status status
assert_child_death_status nodes
assert_child_death_status docker-env

manifest="$FIXTURE/deploy/minikube/.image-manifest.json"
printf 'known-good-manifest\n' >"$manifest"
clear_runtime_state
query_failure_output="$TMP_DIR/query-status-1.out"
query_failure_status=0
run_build "$query_failure_output" valid \
  MINIKUBE_PRELOAD_BASE_IMAGES=true \
  FAKE_DOCKER_QUERY_STATUS=1 \
  bash "$BUILD_SCRIPT" --only=control-api || query_failure_status=$?
if [[ "$query_failure_status" -eq 1 ]] \
  && grep -Fq 'images -q node:24-alpine' "$DOCKER_LOG" \
  && ! grep -Fq 'pull node:24-alpine' "$DOCKER_LOG" \
  && ! grep -Fq 'image inspect node:24-alpine' "$DOCKER_LOG" \
  && ! grep -Fq 'Manifest:' "$query_failure_output" \
  && [[ "$(<"$manifest")" == known-good-manifest ]]; then
  pass 'daemon inventory status 1 hard-fails without pull or manifest success'
else
  fail "daemon inventory status 1 fell through as absence (status=$query_failure_status)"
  tail -20 "$query_failure_output" >&2 || true
fi

printf 'known-good-manifest\n' >"$manifest"
clear_runtime_state
manifest_query_output="$TMP_DIR/manifest-query-status-1.out"
manifest_query_status=0
run_build "$manifest_query_output" valid \
  FAKE_DOCKER_QUERY_MATCH=clerum/host-context-controller:test \
  FAKE_DOCKER_QUERY_STATUS=1 \
  bash "$BUILD_SCRIPT" --only=control-api || manifest_query_status=$?
if [[ "$manifest_query_status" -eq 1 ]] \
  && grep -Fq 'build -t clerum/control-api:test' "$DOCKER_LOG" \
  && grep -Fq 'images -q clerum/host-context-controller:test' "$DOCKER_LOG" \
  && ! grep -Fq 'Manifest:' "$manifest_query_output" \
  && [[ "$(<"$manifest")" == known-good-manifest ]]; then
  pass 'a manifest inventory status 1 preserves the prior manifest and cannot report success'
else
  fail "manifest inventory status 1 produced a false manifest result (status=$manifest_query_status)"
  tail -20 "$manifest_query_output" >&2 || true
fi

printf 'known-good-manifest\n' >"$manifest"
clear_runtime_state
empty_query_output="$TMP_DIR/query-empty.out"
empty_query_status=0
run_build "$empty_query_output" valid \
  MINIKUBE_PRELOAD_BASE_IMAGES=true \
  FAKE_DOCKER_QUERY_STATUS=0 \
  FAKE_DOCKER_QUERY_OUTPUT= \
  FAKE_DOCKER_PULL_STATUS=55 \
  bash "$BUILD_SCRIPT" --only=control-api || empty_query_status=$?
if [[ "$empty_query_status" -eq 55 ]] \
  && grep -Fq 'images -q node:24-alpine' "$DOCKER_LOG" \
  && grep -Fq 'pull node:24-alpine' "$DOCKER_LOG" \
  && ! grep -Fq 'Manifest:' "$empty_query_output" \
  && [[ "$(<"$manifest")" == known-good-manifest ]]; then
  pass 'only a successful empty daemon inventory is treated as image absence'
else
  fail "successful empty inventory did not take the bounded pull path (status=$empty_query_status)"
  tail -20 "$empty_query_output" >&2 || true
fi

if [[ "$FAIL" -eq 0 ]]; then
  printf 'PASS: build-images hardening fake-binary suite\n'
fi
exit "$FAIL"
