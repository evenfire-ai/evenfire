#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TMP_DIR="$(mktemp -d)"
# Invoked indirectly by the EXIT trap.
# shellcheck disable=SC2329
cleanup_test_tmp() {
  if [[ "${KEEP_MINIKUBE_DOCKER_TEST_TMP:-false}" == true ]]; then
    printf 'Kept test fixtures at %s\n' "$TMP_DIR" >&2
  else
    rm -rf -- "$TMP_DIR"
  fi
}
trap cleanup_test_tmp EXIT

BIN_DIR="$TMP_DIR/bin"
AMBIENT_CONFIG="$TMP_DIR/ambient-docker"
EXPLICIT_CONFIG="$TMP_DIR/explicit-docker"
ROOTLESS_CONFIG="$TMP_DIR/rootless-docker"
DOCKER_LOG="$TMP_DIR/docker.log"
MINIKUBE_LOG="$TMP_DIR/minikube.log"
PLUGIN_LOG="$TMP_DIR/buildx.log"
HELPER_SENTINEL="$TMP_DIR/ambient-helper-called"
UNSAFE_SENTINEL="$TMP_DIR/unsafe-config"
DESCENDANT_PID_FILE="$TMP_DIR/descendant.pid"
TASK_TMP="$TMP_DIR/task-tmp"
SECRET_VALUE="AUTH_SHOULD_NOT_LEAK_8d45d9"
FAIL=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=1; }

mkdir -p "$BIN_DIR" "$AMBIENT_CONFIG" "$EXPLICIT_CONFIG" "$ROOTLESS_CONFIG" "$TASK_TMP"
EXPLICIT_CONFIG="$(cd -- "$EXPLICIT_CONFIG" && pwd -P)"
ROOTLESS_CONFIG="$(cd -- "$ROOTLESS_CONFIG" && pwd -P)"
printf '{"auths":{"registry.invalid":{"auth":"%s"}},"credsStore":"poison","credHelpers":{"registry.invalid":"poison"}}\n' \
  "$SECRET_VALUE" >"$AMBIENT_CONFIG/config.json"
printf '{"auths":{"private.invalid":{"auth":"EXPLICIT_AUTH_NOT_FOR_OUTPUT"}}}\n' \
  >"$EXPLICIT_CONFIG/config.json"
printf '{"currentContext":"rootless-local"}\n' >"$ROOTLESS_CONFIG/config.json"

cat >"$BIN_DIR/docker-credential-poison" <<'STUB'
#!/usr/bin/env bash
printf 'called\n' >"${HELPER_SENTINEL:?}"
exit 97
STUB

cat >"$BIN_DIR/docker-buildx-fixture" <<'STUB'
#!/usr/bin/env bash
printf 'buildx\n' >>"${PLUGIN_LOG:?}"
printf 'github.com/docker/buildx fixture\n'
STUB

cat >"$BIN_DIR/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

config="${DOCKER_CONFIG:-}"
if [[ -z "$config" || ! -f "$config/config.json" ]]; then
  printf 'missing Docker config\n' >"${UNSAFE_SENTINEL:?}"
  exit 90
fi

mode="$(node -e 'const fs=require("node:fs"); process.stdout.write(((fs.statSync(process.argv[1]).mode & 0o777).toString(8)))' "$config")"
printf '%s|%s|host=%s|context=%s|tls=%s|verify=%s|cert=%s\n' \
  "$config" "$*" "${DOCKER_HOST-<unset>}" "${DOCKER_CONTEXT-<unset>}" \
  "${DOCKER_TLS-<unset>}" "${DOCKER_TLS_VERIFY-<unset>}" "${DOCKER_CERT_PATH-<unset>}" \
  >>"${DOCKER_LOG:?}"

if [[ "${1:-}" == context && "${2:-}" == inspect ]]; then
  if [[ "$config" != "${AMBIENT_CONFIG:?}" \
    && "$config" != "${ROOTLESS_CONFIG:?}" \
    && "$config" != "${FAKE_EXPECT_AUTH_CONFIG:-}" \
    && "$mode" != 700 ]]; then
    printf 'unsafe Docker config mode\n' >"${UNSAFE_SENTINEL:?}"
    exit 91
  fi
  if [[ -n "${DOCKER_AUTH_CONFIG+x}" || -n "${DOCKER_CUSTOM_HEADERS+x}" ]]; then
    printf 'ambient Docker auth/header env reached context inspection\n' >"${UNSAFE_SENTINEL:?}"
    exit 94
  fi

  endpoint="${DOCKER_HOST:-}"
  if [[ -z "$endpoint" ]]; then
    context_name="${DOCKER_CONTEXT:-}"
    if [[ -z "$context_name" ]]; then
      context_name="$(node -e '
        const fs = require("node:fs")
        const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
        process.stdout.write(value.currentContext || "default")
      ' "$config/config.json")"
    fi
    case "$context_name" in
      default) endpoint="unix:///var/run/docker.sock" ;;
      rootless-local) endpoint="unix:///run/user/1000/docker.sock" ;;
      hostile-remote) endpoint="ssh://prod.invalid/var/run/docker.sock" ;;
      *) exit 96 ;;
    esac
  fi

  if [[ "$*" == *'TLSMaterial'* ]]; then
    printf '%s\tfalse\t{}\n' "$endpoint"
  else
    if [[ -n "${FAKE_DOCKER_EFFECTIVE_HOST_OVERRIDE:-}" ]]; then
      endpoint="$FAKE_DOCKER_EFFECTIVE_HOST_OVERRIDE"
    fi
    printf '%s\n' "$endpoint"
  fi
  exit 0
fi

if [[ "$config" != "${FAKE_EXPECT_AUTH_CONFIG:-}" && "$mode" != 700 ]]; then
  printf 'unsafe Docker config mode\n' >"${UNSAFE_SENTINEL:?}"
  exit 91
fi

if [[ -n "${DOCKER_CONTEXT+x}" || -n "${DOCKER_AUTH_CONFIG+x}" \
  || -n "${DOCKER_CUSTOM_HEADERS+x}" ]]; then
  printf 'ambient Docker endpoint/auth env reached isolated operation\n' >"${UNSAFE_SENTINEL:?}"
  exit 94
fi

if grep -Eq '"(credsStore|credHelpers)"[[:space:]]*:' "$config/config.json"; then
  docker-credential-poison get </dev/null
fi
if [[ "$config" != "${FAKE_EXPECT_AUTH_CONFIG:-}" ]] \
  && grep -Eq '"auths"[[:space:]]*:' "$config/config.json"; then
  printf 'ambient auth reached isolated Docker config\n' >"${UNSAFE_SENTINEL:?}"
  exit 92
fi

if [[ "${1:-}" == buildx && "${2:-}" == version ]]; then
  plugin="$config/cli-plugins/docker-buildx"
  [[ -x "$plugin" ]] || exit 93
  "$plugin" version
  exit 0
fi

operation_mode=success
if [[ -z "${FAKE_DOCKER_MATCH:-}" || "$*" == *"${FAKE_DOCKER_MATCH}"* ]]; then
  operation_mode="${FAKE_DOCKER_MODE:-success}"
fi
case "$operation_mode" in
  exit)
    exit "${FAKE_DOCKER_EXIT_CODE:-37}"
    ;;
  hang)
    (
      trap '' HUP QUIT TERM INT
      while true; do sleep 1; done
    ) &
    descendant=$!
    printf '%s\n' "$descendant" >"${DESCENDANT_PID_FILE:?}"
    wait "$descendant"
    ;;
esac

case "${1:-}" in
  images)
    if [[ -n "${FAKE_DOCKER_IMAGES_PRESENT_MATCH:-}" \
      && "$*" == *"${FAKE_DOCKER_IMAGES_PRESENT_MATCH}"* ]]; then
      printf 'sha256:present\n'
    fi
    exit 0
    ;;
  image)
    [[ "${2:-}" == inspect ]] && exit 1
    ;;
  inspect)
    printf 'sha256:deadbeef0000cafedeadbeef0000cafedeadbeef\n'
    ;;
esac
exit 0
STUB

cat >"$BIN_DIR/minikube" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${MINIKUBE_LOG:?}"
if { [[ "${FAKE_MINIKUBE_MODE:-}" == hang-inventory && "$*" == *"image ls"*"--format=json"* ]] \
  || [[ "${FAKE_MINIKUBE_MODE:-}" == hang-load && "$*" == *"image load"* && "$*" != *"--pull"* ]]; }; then
  (
    trap '' HUP QUIT TERM INT
    while true; do sleep 1; done
  ) &
  descendant=$!
  printf '%s\n' "$descendant" >"${DESCENDANT_PID_FILE:?}"
  wait "$descendant"
fi
case "$*" in
  *status*) exit 0 ;;
  *docker-env*) printf 'export DOCKER_HOST="tcp://127.0.0.1:2376"\n'; exit 0 ;;
  *"image ls"*) exit 0 ;;
esac
exit 0
STUB

cat >"$BIN_DIR/kubectl" <<'STUB'
#!/usr/bin/env bash
if [[ "$*" == *"get nodes"* ]]; then
  printf 'fixture-node Ready control-plane 1d v1.30.0\n'
  if [[ "${FAKE_NODE_COUNT:-1}" -gt 1 ]]; then
    printf 'fixture-node-2 Ready worker 1d v1.30.0\n'
  fi
fi
exit 0
STUB

chmod +x "$BIN_DIR/docker-credential-poison" "$BIN_DIR/docker-buildx-fixture" \
  "$BIN_DIR/docker" "$BIN_DIR/minikube" "$BIN_DIR/kubectl"

export PATH="$BIN_DIR:$PATH"
export TMPDIR="$TASK_TMP"
export AMBIENT_CONFIG ROOTLESS_CONFIG DOCKER_LOG MINIKUBE_LOG PLUGIN_LOG
export HELPER_SENTINEL UNSAFE_SENTINEL DESCENDANT_PID_FILE
export MINIKUBE_DOCKER_BUILDX_PLUGIN="$BIN_DIR/docker-buildx-fixture"
export MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS=3
export MINIKUBE_DOCKER_PULL_TIMEOUT_SECONDS=3
export MINIKUBE_DOCKER_BUILD_TIMEOUT_SECONDS=3
export MINIKUBE_DOCKER_HEARTBEAT_SECONDS=1
export MINIKUBE_DOCKER_KILL_GRACE_SECONDS=1
export MINIKUBE_DOCKER_START_PROBE_TIMEOUT_SECONDS=2
export MINIKUBE_DOCKER_START_TIMEOUT_SECONDS=2
export MINIKUBE_DOCKER_START_POLL_SECONDS=1
export MINIKUBE_IMAGE_INVENTORY_TIMEOUT_SECONDS=2
export DOCKER_CONFIG="$AMBIENT_CONFIG"
unset DOCKER_AUTH_CONFIG DOCKER_CONTEXT DOCKER_HOST DOCKER_TLS DOCKER_TLS_VERIFY
unset DOCKER_CERT_PATH DOCKER_CUSTOM_HEADERS DOCKER_API_VERSION MINIKUBE_ACTIVE_DOCKERD
unset MINIKUBE_DOCKER_AUTH_CONFIG FAKE_EXPECT_AUTH_CONFIG

docker_log_has_ambient_runtime_operation() {
  awk -F'|' -v config="$AMBIENT_CONFIG" '
    $1 == config && $2 !~ /^context inspect / { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$DOCKER_LOG"
}

prepare_fixture_repo() {
  local fixture="$1"
  mkdir -p "$fixture/scripts/minikube" "$fixture/scripts/release" \
    "$fixture/control-api" "$fixture/deploy/minikube"
  cp "$ROOT/scripts/minikube/build-images.sh" \
    "$ROOT/scripts/minikube/docker-cli-env.sh" \
    "$ROOT/scripts/minikube/run-with-deadline.mjs" \
    "$ROOT/scripts/minikube/image-mode.sh" \
    "$fixture/scripts/minikube/"
  cp "$ROOT/scripts/release/images-manifest.mjs" "$fixture/scripts/release/"
  cp "$ROOT/deploy/images.json" "$fixture/deploy/images.json"
  cat >"$fixture/scripts/minikube/require-t2-mutation-lock.sh" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  printf 'FROM scratch\n' >"$fixture/control-api/Dockerfile"
  chmod +x "$fixture/scripts/minikube/build-images.sh" \
    "$fixture/scripts/minikube/docker-cli-env.sh" \
    "$fixture/scripts/minikube/run-with-deadline.mjs" \
    "$fixture/scripts/minikube/require-t2-mutation-lock.sh"
  export T2_PROJECT_DIR="$fixture"
  export T2_PROFILE=fixture-profile
  export T2_CONTEXT=fixture-profile
  export MINIKUBE_PROFILE=fixture-profile
}

assert_endpoint_resolution_and_context_precedence() {
  local reject_output="$TMP_DIR/hostile-context-reject.out"
  local explicit_output="$TMP_DIR/explicit-host.out"
  local mismatch_output="$TMP_DIR/endpoint-mismatch.out"
  local status=0 cert_dir="$TMP_DIR/client-certs"
  mkdir -p "$cert_dir"

  : >"$DOCKER_LOG"
  DOCKER_CONFIG="$AMBIENT_CONFIG" DOCKER_CONTEXT=hostile-remote \
    bash -c '
      set -euo pipefail
      source "$1"
      trap docker_cli_env_cleanup EXIT
      docker_cli_env_prepare probe
    ' _ "$ROOT/scripts/minikube/docker-cli-env.sh" >"$reject_output" 2>&1 || status=$?
  if [[ "$status" -ne 0 ]] \
    && grep -Fq 'DOCKER_ENDPOINT_UNSAFE' "$reject_output" \
    && [[ ! -e "$HELPER_SENTINEL" && ! -e "$UNSAFE_SENTINEL" ]]; then
    pass "a hostile remote DOCKER_CONTEXT is rejected before task config selection"
  else
    fail "a hostile remote DOCKER_CONTEXT was not rejected (status=$status)"
  fi

  : >"$DOCKER_LOG"
  status=0
  DOCKER_CONFIG="$AMBIENT_CONFIG" DOCKER_CONTEXT=hostile-remote \
    DOCKER_HOST=tcp://127.0.0.1:2376 DOCKER_TLS=1 DOCKER_TLS_VERIFY=0 \
    DOCKER_CERT_PATH="$cert_dir" \
    bash -c '
      set -euo pipefail
      source "$1"
      trap docker_cli_env_cleanup EXIT
      docker_cli_env_prepare probe
      [[ "$DOCKER_HOST" == tcp://127.0.0.1:2376 ]]
      [[ "${DOCKER_CONTEXT+x}" != x ]]
      [[ "$DOCKER_TLS" == 1 && "$DOCKER_TLS_VERIFY" == 0 ]]
      [[ "$DOCKER_CERT_PATH" == "$2" ]]
      docker_cli_run_public explicit-host 2 docker info >/dev/null
      task_config="$DOCKER_CLI_TASK_CONFIG"
      docker_cli_env_cleanup
      [[ "$DOCKER_CONFIG" == "$3" && "$DOCKER_CONTEXT" == hostile-remote ]]
      [[ "$DOCKER_HOST" == tcp://127.0.0.1:2376 ]]
      [[ "$DOCKER_TLS" == 1 && "$DOCKER_TLS_VERIFY" == 0 ]]
      [[ "$DOCKER_CERT_PATH" == "$2" && ! -e "$task_config" ]]
    ' _ "$ROOT/scripts/minikube/docker-cli-env.sh" "$cert_dir" "$AMBIENT_CONFIG" \
      >"$explicit_output" 2>&1 || status=$?
  if [[ "$status" -eq 0 ]] \
    && grep -Fq '|info|host=tcp://127.0.0.1:2376|context=<unset>|tls=1|verify=0' "$DOCKER_LOG" \
    && ! docker_log_has_ambient_runtime_operation; then
    pass "an explicit local DOCKER_HOST wins over hostile context and preserves TLS semantics"
  else
    fail "explicit local Docker host/context precedence failed (status=$status)"
  fi

  : >"$DOCKER_LOG"
  status=0
  DOCKER_CONFIG="$AMBIENT_CONFIG" DOCKER_HOST=unix:///var/run/docker.sock \
    FAKE_DOCKER_EFFECTIVE_HOST_OVERRIDE=unix:///tmp/different.sock \
    bash -c '
      set -euo pipefail
      source "$1"
      trap docker_cli_env_cleanup EXIT
      docker_cli_env_prepare probe
    ' _ "$ROOT/scripts/minikube/docker-cli-env.sh" >"$mismatch_output" 2>&1 || status=$?
  if [[ "$status" -ne 0 ]] && grep -Fq 'DOCKER_ENDPOINT_MISMATCH' "$mismatch_output"; then
    pass "the isolated config verifies the effective pinned endpoint"
  else
    fail "effective Docker endpoint mismatch was not detected (status=$status)"
  fi
}

assert_config_only_rootless_context() {
  local output="$TMP_DIR/rootless-context.out" status=0
  : >"$DOCKER_LOG"
  DOCKER_CONFIG="$ROOTLESS_CONFIG" bash -c '
    set -euo pipefail
    unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH
    source "$1"
    trap docker_cli_env_cleanup EXIT
    docker_cli_env_prepare probe
    [[ "$DOCKER_HOST" == unix:///run/user/1000/docker.sock ]]
    [[ "${DOCKER_CONTEXT+x}" != x && "${DOCKER_TLS+x}" != x ]]
    docker_cli_run_public rootless-info 2 docker info >/dev/null
    task_config="$DOCKER_CLI_TASK_CONFIG"
    docker_cli_env_cleanup
    [[ "$DOCKER_CONFIG" == "$2" && "${DOCKER_HOST+x}" != x ]]
    [[ "${DOCKER_CONTEXT+x}" != x && ! -e "$task_config" ]]
  ' _ "$ROOT/scripts/minikube/docker-cli-env.sh" "$ROOTLESS_CONFIG" >"$output" 2>&1 || status=$?
  if [[ "$status" -eq 0 ]] \
    && grep -Fq "$ROOTLESS_CONFIG|context inspect" "$DOCKER_LOG" \
    && grep -Fq '|info|host=unix:///run/user/1000/docker.sock|context=<unset>' "$DOCKER_LOG" \
    && [[ ! -e "$HELPER_SENTINEL" && ! -e "$UNSAFE_SENTINEL" ]]; then
    pass "a config-only local rootless context is resolved and pinned safely"
  else
    fail "config-only rootless context support failed (status=$status)"
  fi
}

assert_all_original_docker_env_is_restored() {
  local output="$TMP_DIR/env-restore.out" status=0 cert_dir="$TMP_DIR/restore-certs"
  mkdir -p "$cert_dir"
  DOCKER_CONFIG="$AMBIENT_CONFIG" DOCKER_AUTH_CONFIG='{"auths":{}}' \
    DOCKER_CONTEXT=hostile-remote DOCKER_HOST=tcp://127.0.0.1:2376 \
    DOCKER_TLS='' DOCKER_TLS_VERIFY=0 DOCKER_CERT_PATH="$cert_dir" \
    DOCKER_API_VERSION=1.43 DOCKER_CUSTOM_HEADERS='X-Fixture=original' \
    MINIKUBE_ACTIVE_DOCKERD=original-profile \
    bash -c '
      set -euo pipefail
      source "$1"
      trap docker_cli_env_cleanup EXIT
      docker_cli_env_prepare probe
      task_config="$DOCKER_CLI_TASK_CONFIG"
      export DOCKER_CONFIG=/changed DOCKER_AUTH_CONFIG=changed DOCKER_CONTEXT=changed
      export DOCKER_HOST=unix:///changed.sock DOCKER_TLS=changed DOCKER_TLS_VERIFY=changed
      export DOCKER_CERT_PATH=/changed DOCKER_API_VERSION=changed
      export DOCKER_CUSTOM_HEADERS=changed MINIKUBE_ACTIVE_DOCKERD=changed
      docker_cli_env_cleanup
      [[ "$DOCKER_CONFIG" == "$2" && "$DOCKER_AUTH_CONFIG" == "{\"auths\":{}}" ]]
      [[ "$DOCKER_CONTEXT" == hostile-remote && "$DOCKER_HOST" == tcp://127.0.0.1:2376 ]]
      [[ "${DOCKER_TLS+x}" == x && -z "$DOCKER_TLS" && "$DOCKER_TLS_VERIFY" == 0 ]]
      [[ "$DOCKER_CERT_PATH" == "$3" && "$DOCKER_API_VERSION" == 1.43 ]]
      [[ "$DOCKER_CUSTOM_HEADERS" == X-Fixture=original ]]
      [[ "$MINIKUBE_ACTIVE_DOCKERD" == original-profile && ! -e "$task_config" ]]
    ' _ "$ROOT/scripts/minikube/docker-cli-env.sh" "$AMBIENT_CONFIG" "$cert_dir" \
      >"$output" 2>&1 || status=$?
  if [[ "$status" -eq 0 ]]; then
    pass "cleanup restores every original Docker endpoint/config env value exactly"
  else
    fail "Docker environment restoration failed (status=$status)"
  fi
}

assert_real_build_script_isolated() {
  local fixture="$TMP_DIR/repo" output="$TMP_DIR/build.out"
  prepare_fixture_repo "$fixture"
  : >"$DOCKER_LOG"
  if DOCKER_CONFIG="$AMBIENT_CONFIG" MINIKUBE_PRELOAD_BASE_IMAGES=false \
    bash "$fixture/scripts/minikube/build-images.sh" --only=control-api \
      >"$output" 2>&1; then
    if grep -Fq '|build -t clerum/control-api:test' "$DOCKER_LOG" \
      && ! docker_log_has_ambient_runtime_operation \
      && [[ ! -e "$HELPER_SENTINEL" && ! -e "$UNSAFE_SENTINEL" ]] \
      && [[ -s "$PLUGIN_LOG" ]]; then
      pass "targeted build uses the clean task config and discovered buildx plugin"
    else
      fail "targeted build did not preserve Docker isolation"
    fi
  else
    fail "targeted fake-Docker build failed: $(tail -20 "$output")"
  fi

  if ! grep -Fq "$SECRET_VALUE" "$output" \
    && ! grep -Fq "$AMBIENT_CONFIG" "$output" \
    && ! grep -Fq 'credsStore' "$output"; then
    pass "build output contains no ambient config or credential contents"
  else
    fail "build output leaked ambient Docker configuration"
  fi
}

assert_public_pulls_are_isolated() {
  local fixture="$TMP_DIR/public-repo" output="$TMP_DIR/public.out"
  prepare_fixture_repo "$fixture"
  : >"$DOCKER_LOG"
  if DOCKER_CONFIG="$AMBIENT_CONFIG" MINIKUBE_PRELOAD_BASE_IMAGES=false \
    bash "$fixture/scripts/minikube/build-images.sh" --public-only \
      >"$output" 2>&1; then
    if grep -Fq '|pull postgres:16-alpine' "$DOCKER_LOG" \
      && ! docker_log_has_ambient_runtime_operation \
      && [[ ! -e "$HELPER_SENTINEL" && ! -e "$UNSAFE_SENTINEL" ]]; then
      pass "public pulls never inherit the ambient credential helper"
    else
      fail "public pulls escaped the isolated Docker config"
    fi
  else
    fail "public fake-Docker pull run failed: $(tail -20 "$output")"
  fi
}

assert_local_image_operations_preserve_status() {
  local fixture output status

  fixture="$TMP_DIR/base-inspect-failure-repo"
  output="$TMP_DIR/base-inspect-failure.out"
  prepare_fixture_repo "$fixture"
  : >"$DOCKER_LOG"
  status=0
  DOCKER_CONFIG="$AMBIENT_CONFIG" \
    FAKE_DOCKER_MODE=exit FAKE_DOCKER_MATCH='images -q node:24-alpine' \
    FAKE_DOCKER_EXIT_CODE=42 \
    bash "$fixture/scripts/minikube/build-images.sh" --only=control-api \
      >"$output" 2>&1 || status=$?
  if [[ "$status" -eq 42 ]] \
    && grep -Fq 'label=docker-images-query event=exit' "$output" \
    && grep -Fq 'exitCode=42' "$output" \
    && ! grep -Fq '|pull node:24-alpine' "$DOCKER_LOG"; then
    pass "bounded base-image inventory preserves status and never falls through to pull"
  else
    fail "base-image inventory status/fallback contract failed (status=$status)"
  fi

  fixture="$TMP_DIR/public-query-failure-repo"
  output="$TMP_DIR/public-query-failure.out"
  prepare_fixture_repo "$fixture"
  : >"$DOCKER_LOG"
  status=0
  DOCKER_CONFIG="$AMBIENT_CONFIG" MINIKUBE_PRELOAD_BASE_IMAGES=false \
    FAKE_DOCKER_MODE=exit FAKE_DOCKER_MATCH='images -q postgres:16-alpine' \
    FAKE_DOCKER_EXIT_CODE=39 \
    bash "$fixture/scripts/minikube/build-images.sh" --public-only \
      >"$output" 2>&1 || status=$?
  if [[ "$status" -eq 39 ]] \
    && grep -Fq 'label=docker-images-query event=exit' "$output" \
    && grep -Fq 'exitCode=39' "$output" \
    && ! grep -Fq '|pull postgres:16-alpine' "$DOCKER_LOG"; then
    pass "bounded docker images query preserves status and never falls through to pull"
  else
    fail "docker images query status/fallback contract failed (status=$status)"
  fi

  fixture="$TMP_DIR/post-build-inspect-failure-repo"
  output="$TMP_DIR/post-build-inspect-failure.out"
  prepare_fixture_repo "$fixture"
  status=0
  DOCKER_CONFIG="$AMBIENT_CONFIG" MINIKUBE_PRELOAD_BASE_IMAGES=false \
    FAKE_DOCKER_MODE=exit \
    FAKE_DOCKER_MATCH='inspect --format={{.Id}} clerum/control-api:test' \
    FAKE_DOCKER_EXIT_CODE=37 \
    bash "$fixture/scripts/minikube/build-images.sh" --only=control-api \
      >"$output" 2>&1 || status=$?
  if [[ "$status" -eq 37 ]] \
    && grep -Fq 'label=docker-image-id event=exit' "$output" \
    && grep -Fq 'exitCode=37' "$output"; then
    pass "bounded post-build docker inspect preserves its exact status"
  else
    fail "post-build docker inspect status contract failed (status=$status)"
  fi

  fixture="$TMP_DIR/manifest-inspect-failure-repo"
  output="$TMP_DIR/manifest-inspect-failure.out"
  prepare_fixture_repo "$fixture"
  status=0
  DOCKER_CONFIG="$AMBIENT_CONFIG" MINIKUBE_PRELOAD_BASE_IMAGES=false \
    FAKE_DOCKER_MODE=exit \
    FAKE_DOCKER_MATCH='inspect --format={{.Id}} clerum/host-context-controller:test' \
    FAKE_DOCKER_IMAGES_PRESENT_MATCH='clerum/host-context-controller:test' \
    FAKE_DOCKER_EXIT_CODE=41 \
    bash "$fixture/scripts/minikube/build-images.sh" --only=control-api \
      >"$output" 2>&1 || status=$?
  if [[ "$status" -eq 41 ]] \
    && grep -Fq 'Could not inspect clerum/host-context-controller:test while generating the image manifest' "$output" \
    && grep -Fq 'exitCode=41' "$output"; then
    pass "bounded manifest docker inspect preserves non-missing failures"
  else
    fail "manifest docker inspect status contract failed (status=$status)"
  fi

  fixture="$TMP_DIR/tag-failure-repo"
  output="$TMP_DIR/tag-failure.out"
  prepare_fixture_repo "$fixture"
  status=0
  DOCKER_CONFIG="$AMBIENT_CONFIG" MINIKUBE_PRELOAD_BASE_IMAGES=false \
    MINIKUBE_DOCKER_AUTH_CONFIG="$EXPLICIT_CONFIG" \
    FAKE_EXPECT_AUTH_CONFIG="$EXPLICIT_CONFIG" \
    FAKE_DOCKER_MODE=exit FAKE_DOCKER_MATCH='tag ' FAKE_DOCKER_EXIT_CODE=38 \
    bash "$fixture/scripts/minikube/build-images.sh" --only=playwright \
      >"$output" 2>&1 || status=$?
  if [[ "$status" -eq 38 ]] \
    && grep -Fq 'label=docker-image-tag event=exit' "$output" \
    && grep -Fq 'exitCode=38' "$output"; then
    pass "bounded docker tag preserves its exact status"
  else
    fail "docker tag status contract failed (status=$status)"
  fi
}

assert_local_minikube_load_timeout_kills_descendants() {
  local fixture="$TMP_DIR/load-timeout-repo" output="$TMP_DIR/load-timeout.out"
  local status=0 descendant=""
  prepare_fixture_repo "$fixture"
  : >"$MINIKUBE_LOG"
  rm -f -- "$DESCENDANT_PID_FILE"

  DOCKER_CONFIG="$AMBIENT_CONFIG" MINIKUBE_PRELOAD_BASE_IMAGES=false \
    FAKE_NODE_COUNT=2 FAKE_MINIKUBE_MODE=hang-load \
    bash "$fixture/scripts/minikube/build-images.sh" --only=control-api \
      >"$output" 2>&1 || status=$?
  if [[ -f "$DESCENDANT_PID_FILE" ]]; then
    descendant="$(cat "$DESCENDANT_PID_FILE")"
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [[ -z "$descendant" ]] || ! kill -0 "$descendant" 2>/dev/null; then break; fi
    sleep 0.1
  done

  if [[ "$status" -eq 124 && -n "$descendant" ]] \
    && ! kill -0 "$descendant" 2>/dev/null \
    && grep -Fq 'label=minikube-image-load event=timeout' "$output" \
    && grep -Fq 'image load clerum/control-api:test' "$MINIKUBE_LOG"; then
    pass "bounded local minikube image load kills its full process group"
  else
    fail "local minikube image load timeout failed (status=$status descendant=${descendant:-missing})"
  fi
}

assert_startup_probes_are_isolated_and_bounded() {
  local check_output="$TMP_DIR/startup-check.out" wait_output="$TMP_DIR/startup-wait.out"
  local status=0 descendant="" plugin_before plugin_after

  : >"$DOCKER_LOG"
  plugin_before="$(wc -l <"$PLUGIN_LOG" 2>/dev/null || printf 0)"
  if DOCKER_CONFIG="$AMBIENT_CONFIG" \
    MINIKUBE_DOCKER_BUILDX_PLUGIN="$TMP_DIR/not-installed-buildx" \
    "$ROOT/scripts/minikube/docker-cli-env.sh" --check-info \
      >"$check_output" 2>&1; then
    plugin_after="$(wc -l <"$PLUGIN_LOG" 2>/dev/null || printf 0)"
    if grep -Fq '|info|' "$DOCKER_LOG" \
      && ! grep -Fq '|buildx version' "$DOCKER_LOG" \
      && ! docker_log_has_ambient_runtime_operation \
      && [[ "$plugin_before" -eq "$plugin_after" ]] \
      && [[ ! -e "$HELPER_SENTINEL" && ! -e "$UNSAFE_SENTINEL" ]]; then
      pass "startup probe is isolated and does not require buildx"
    else
      fail "startup probe escaped isolation or invoked buildx"
    fi
  else
    fail "bounded startup probe failed: $(tail -20 "$check_output")"
  fi

  rm -f -- "$DESCENDANT_PID_FILE"
  status=0
  DOCKER_CONFIG="$AMBIENT_CONFIG" \
    MINIKUBE_DOCKER_BUILDX_PLUGIN="$TMP_DIR/not-installed-buildx" \
    FAKE_DOCKER_MODE=hang \
    "$ROOT/scripts/minikube/docker-cli-env.sh" --wait-for-info \
      >"$wait_output" 2>&1 || status=$?
  if [[ -f "$DESCENDANT_PID_FILE" ]]; then
    descendant="$(cat "$DESCENDANT_PID_FILE")"
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [[ -z "$descendant" ]] || ! kill -0 "$descendant" 2>/dev/null; then break; fi
    sleep 0.1
  done

  if [[ "$status" -eq 124 && -n "$descendant" ]] \
    && ! kill -0 "$descendant" 2>/dev/null \
    && grep -Fq 'label=docker-info-startup-wait event=timeout' "$wait_output" \
    && ! grep -Fq "$SECRET_VALUE" "$wait_output" \
    && ! grep -Fq "$AMBIENT_CONFIG" "$wait_output"; then
    pass "startup wait has one finite deadline and kills helper descendants"
  else
    fail "startup wait deadline failed (status=$status descendant=${descendant:-missing})"
  fi
}

assert_verify_inventory_is_read_only_and_bounded() {
  local fixture="$TMP_DIR/verify-repo" output="$TMP_DIR/verify-timeout.out"
  local status=0 descendant=""
  prepare_fixture_repo "$fixture"
  rm -f -- "$DESCENDANT_PID_FILE"
  : >"$DOCKER_LOG"

  DOCKER_CONFIG="$AMBIENT_CONFIG" IMAGE_SOURCE=local \
    FAKE_MINIKUBE_MODE=hang-inventory \
    bash "$fixture/scripts/minikube/build-images.sh" --verify-only \
      >"$output" 2>&1 || status=$?
  if [[ -f "$DESCENDANT_PID_FILE" ]]; then
    descendant="$(cat "$DESCENDANT_PID_FILE")"
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [[ -z "$descendant" ]] || ! kill -0 "$descendant" 2>/dev/null; then break; fi
    sleep 0.1
  done

  if [[ "$status" -eq 124 && -n "$descendant" ]] \
    && ! kill -0 "$descendant" 2>/dev/null \
    && grep -Fq 'label=minikube-image-inventory event=timeout' "$output" \
    && [[ ! -s "$DOCKER_LOG" ]] \
    && [[ ! -e "$HELPER_SENTINEL" && ! -e "$UNSAFE_SENTINEL" ]]; then
    pass "verify-only bounds its read-only inventory without invoking Docker"
  else
    fail "verify-only inventory deadline failed (status=$status descendant=${descendant:-missing})"
  fi
}

assert_invalid_deadline_and_explicit_buildx_fail_closed() {
  local deadline_output="$TMP_DIR/invalid-deadline.out"
  local buildx_output="$TMP_DIR/invalid-buildx.out"
  local deadline_status=0 buildx_status=0

  MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS=0 bash -c '
    set -euo pipefail
    source "$1"
    trap docker_cli_env_cleanup EXIT
    docker_cli_env_prepare
  ' _ "$ROOT/scripts/minikube/docker-cli-env.sh" >"$deadline_output" 2>&1 || deadline_status=$?
  if [[ "$deadline_status" -eq 2 ]] && grep -Fq 'DOCKER_DEADLINE_INVALID' "$deadline_output"; then
    pass "invalid Docker deadlines fail before any operation"
  else
    fail "invalid Docker deadline was accepted (status=$deadline_status)"
  fi

  : >"$DOCKER_LOG"
  MINIKUBE_DOCKER_BUILDX_PLUGIN="$TMP_DIR/not-installed-buildx" bash -c '
    set -euo pipefail
    source "$1"
    trap docker_cli_env_cleanup EXIT
    docker_cli_env_prepare
  ' _ "$ROOT/scripts/minikube/docker-cli-env.sh" >"$buildx_output" 2>&1 || buildx_status=$?
  if [[ "$buildx_status" -ne 0 ]] && grep -Fq 'DOCKER_BUILDX_REQUIRED' "$buildx_output" \
    && ! grep -Fq '|buildx version|' "$DOCKER_LOG" \
    && ! docker_log_has_ambient_runtime_operation; then
    pass "an invalid explicit buildx path never falls back or downloads"
  else
    fail "invalid explicit buildx path was not rejected (status=$buildx_status)"
  fi
}

assert_private_registry_requires_explicit_config() {
  local fixture="$TMP_DIR/private-repo" output="$TMP_DIR/private-missing.out" status=0
  prepare_fixture_repo "$fixture"
  : >"$DOCKER_LOG"
  unset MINIKUBE_DOCKER_AUTH_CONFIG FAKE_EXPECT_AUTH_CONFIG
  DOCKER_CONFIG="$AMBIENT_CONFIG" MINIKUBE_PRELOAD_BASE_IMAGES=false \
    bash "$fixture/scripts/minikube/build-images.sh" --only=playwright \
    >"$output" 2>&1 || status=$?
  if [[ "$status" -ne 0 ]] && grep -Fq 'REGISTRY_AUTH_REQUIRED' "$output" &&
    ! grep -Fq '|pull us-central1-docker.pkg.dev/' "$DOCKER_LOG"; then
    pass "private build mode fails loud before its Docker pull without explicit auth"
  else
    fail "private build mode did not enforce REGISTRY_AUTH_REQUIRED (status=$status)"
  fi
}

assert_explicit_private_config_is_used_without_copying_ambient_auth() {
  local output="$TMP_DIR/private-explicit.out"
  : >"$DOCKER_LOG"
  if DOCKER_CONFIG="$AMBIENT_CONFIG" \
    MINIKUBE_DOCKER_AUTH_CONFIG="$EXPLICIT_CONFIG" \
    FAKE_EXPECT_AUTH_CONFIG="$EXPLICIT_CONFIG" \
    bash -c '
      set -euo pipefail
      source "$1"
      trap docker_cli_env_cleanup EXIT
      docker_cli_env_prepare
      docker_cli_run_private private-pull "$MINIKUBE_DOCKER_PULL_TIMEOUT_SECONDS" docker pull private.invalid/image:test
    ' _ "$ROOT/scripts/minikube/docker-cli-env.sh" >"$output" 2>&1; then
    if grep -Fq "$EXPLICIT_CONFIG|pull private.invalid/image:test" "$DOCKER_LOG" \
      && ! docker_log_has_ambient_runtime_operation \
      && [[ ! -e "$HELPER_SENTINEL" && ! -e "$UNSAFE_SENTINEL" ]] \
      && ! grep -Fq 'EXPLICIT_AUTH_NOT_FOR_OUTPUT' "$output"; then
      pass "explicit private config is scoped to the private pull without leaking auth"
    else
      fail "explicit private Docker config was not scoped correctly"
    fi
  else
    fail "explicit private config was rejected: $(tail -20 "$output")"
  fi
}

assert_exit_status_and_process_group_timeout() {
  local exit_output="$TMP_DIR/exit.out" timeout_output="$TMP_DIR/timeout.out"
  local status=0 descendant=""

  FAKE_DOCKER_MODE=exit FAKE_DOCKER_EXIT_CODE=37 \
    bash -c '
      set -euo pipefail
      source "$1"
      trap docker_cli_env_cleanup EXIT
      docker_cli_env_prepare
      set +e
      docker_cli_run_public build-exit 3 docker build fixture
      status=$?
      set -e
      exit "$status"
    ' _ "$ROOT/scripts/minikube/docker-cli-env.sh" >"$exit_output" 2>&1 || status=$?
  if [[ "$status" -eq 37 ]] && grep -Fq 'event=exit' "$exit_output" \
    && grep -Fq 'exitCode=37' "$exit_output" \
    && grep -Fq '[HARNESS_DEADLINE]' "$exit_output" \
    && ! grep -Fq '[DOCKER_DEADLINE]' "$exit_output"; then
    pass "deadline runner preserves the exact Docker exit status"
  else
    fail "deadline runner changed Docker exit status (got $status)"
  fi

  status=0
  FAKE_DOCKER_MODE=hang \
    bash -c '
      set -euo pipefail
      source "$1"
      trap docker_cli_env_cleanup EXIT
      docker_cli_env_prepare
      set +e
      docker_cli_run_public pull-timeout 2 docker pull public.invalid/image:test
      status=$?
      set -e
      exit "$status"
    ' _ "$ROOT/scripts/minikube/docker-cli-env.sh" >"$timeout_output" 2>&1 || status=$?

  if [[ -f "$DESCENDANT_PID_FILE" ]]; then
    descendant="$(cat "$DESCENDANT_PID_FILE")"
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [[ -z "$descendant" ]] || ! kill -0 "$descendant" 2>/dev/null; then break; fi
    sleep 0.1
  done

  if [[ "$status" -eq 124 && -n "$descendant" ]] \
    && ! kill -0 "$descendant" 2>/dev/null \
    && grep -Fq 'event=heartbeat' "$timeout_output" \
    && grep -Fq 'event=timeout' "$timeout_output" \
    && grep -Fq 'event=terminated' "$timeout_output"; then
    pass "timeout kills the fake Docker process group, including descendants"
  else
    fail "timeout contract failed (status=$status descendant=${descendant:-missing})"
  fi

  if ! grep -Fq "$SECRET_VALUE" "$timeout_output" \
    && ! grep -Fq "$AMBIENT_CONFIG" "$timeout_output" \
    && ! grep -Fq 'credsStore' "$timeout_output"; then
    pass "deadline heartbeat and timing output remain credential-safe"
  else
    fail "deadline output leaked Docker configuration"
  fi
}

wait_for_file_content() {
  local file="$1"
  local attempt=0
  while (( attempt < 120 )); do
    [[ -s "$file" ]] && return 0
    sleep 0.05
    attempt=$((attempt + 1))
  done
  return 1
}

wait_for_output_pattern() {
  local file="$1" pattern="$2"
  local attempt=0
  while (( attempt < 120 )); do
    grep -Fq "$pattern" "$file" 2>/dev/null && return 0
    sleep 0.05
    attempt=$((attempt + 1))
  done
  return 1
}

wait_for_process_death() {
  local pid="$1"
  local attempt=0
  while (( attempt < 120 )); do
    ! kill -0 "$pid" 2>/dev/null && return 0
    sleep 0.05
    attempt=$((attempt + 1))
  done
  return 1
}

assert_repeated_signal_escalates_group() {
  local signal="$1" expected_status="$2" label="double-${1}"
  local output="$TMP_DIR/${label}.out" pid_file="$TMP_DIR/${label}.pid"
  local runner_pid status=0 descendant="" descendant_dead=false

  rm -f -- "$pid_file"
  # Positional values and $! belong to the child shell.
  # shellcheck disable=SC2016
  node "$ROOT/scripts/minikube/run-with-deadline.mjs" \
    --timeout-seconds 15 --heartbeat-seconds 1 --kill-grace-seconds 5 \
    --label "$label" -- \
    bash -c '
      trap "" HUP QUIT INT TERM
      (
        trap "" HUP QUIT INT TERM
        while true; do sleep 1; done
      ) &
      printf "%s\n" "$!" >"$1"
      wait
    ' _ "$pid_file" >"$output" 2>&1 &
  runner_pid=$!

  if wait_for_file_content "$pid_file"; then
    descendant="$(cat "$pid_file")"
  fi
  kill -s "$signal" "$runner_pid" 2>/dev/null || true
  wait_for_output_pattern "$output" 'event=interrupted' || true
  kill -s "$signal" "$runner_pid" 2>/dev/null || true
  wait "$runner_pid" || status=$?
  if [[ -n "$descendant" ]] && wait_for_process_death "$descendant"; then
    descendant_dead=true
  fi

  if [[ "$status" -eq "$expected_status" && "$descendant_dead" == true ]] \
    && grep -Fq 'event=signal-escalated' "$output" \
    && grep -Fq 'action=SIGKILL' "$output"; then
    pass "a repeated ${signal} escalates the entire process group and preserves status ${expected_status}"
  else
    fail "repeated ${signal} teardown failed (status=$status descendant=${descendant:-missing})"
    [[ -n "$descendant" ]] && kill -KILL "$descendant" 2>/dev/null || true
  fi
}

assert_bash_main_signal_cleanup() {
  local signal="$1" expected_status="$2" label="bash-main-${1}"
  local output="$TMP_DIR/${label}.out" docker_log="$TMP_DIR/${label}-docker.log"
  local pid_file="$TMP_DIR/${label}-descendant.pid"
  local runner_pid status=0 descendant="" task_config="" descendant_dead=false

  : >"$docker_log"
  rm -f -- "$pid_file"
  DOCKER_LOG="$docker_log" DESCENDANT_PID_FILE="$pid_file" \
    DOCKER_CONFIG="$AMBIENT_CONFIG" FAKE_DOCKER_MODE=hang \
    MINIKUBE_DOCKER_START_TIMEOUT_SECONDS=20 \
    node "$ROOT/scripts/minikube/run-with-deadline.mjs" \
      --timeout-seconds 25 --heartbeat-seconds 1 --kill-grace-seconds 3 \
      --label "$label" -- \
      "$ROOT/scripts/minikube/docker-cli-env.sh" --wait-for-info \
      >"$output" 2>&1 &
  runner_pid=$!

  if wait_for_output_pattern "$docker_log" '|info|'; then
    task_config="$(awk -F'|' '$2 == "info" { print $1; exit }' "$docker_log")"
  fi
  if wait_for_file_content "$pid_file"; then
    descendant="$(cat "$pid_file")"
  fi
  kill -s "$signal" "$runner_pid" 2>/dev/null || true
  wait "$runner_pid" || status=$?
  if [[ -n "$descendant" ]] && wait_for_process_death "$descendant"; then
    descendant_dead=true
  fi

  if [[ "$status" -eq "$expected_status" && -n "$task_config" && ! -e "$task_config" \
    && "$descendant_dead" == true ]] \
    && grep -Fq "signal=SIG${signal}" "$output" \
    && grep -Fq "exitCode=${expected_status}" "$output"; then
    pass "Bash main catches ${signal}, returns ${expected_status}, and removes its task config"
  else
    fail "Bash main ${signal} cleanup failed (status=$status config=${task_config:-missing} descendant=${descendant:-missing})"
    [[ -n "$descendant" ]] && kill -KILL "$descendant" 2>/dev/null || true
  fi
}

assert_normal_exit_reaps_background_descendants() {
  local output="$TMP_DIR/normal-descendant.out" pid_file="$TMP_DIR/normal-descendant.pid"
  local status=0 descendant="" descendant_dead=false
  rm -f -- "$pid_file"

  # Positional values and $! belong to the child shell.
  # shellcheck disable=SC2016
  node "$ROOT/scripts/minikube/run-with-deadline.mjs" \
    --timeout-seconds 5 --heartbeat-seconds 1 --kill-grace-seconds 1 \
    --label normal-descendant -- \
    bash -c '
      (
        trap "" HUP QUIT INT TERM
        while true; do sleep 1; done
      ) &
      printf "%s\n" "$!" >"$1"
      exit 0
    ' _ "$pid_file" >"$output" 2>&1 || status=$?
  if wait_for_file_content "$pid_file"; then
    descendant="$(cat "$pid_file")"
  fi
  if [[ -n "$descendant" ]] && wait_for_process_death "$descendant"; then
    descendant_dead=true
  fi

  if [[ "$status" -eq 0 && "$descendant_dead" == true ]] \
    && grep -Fq 'event=exit' "$output" && grep -Fq 'exitCode=0' "$output"; then
    pass "a normal direct-child exit cannot orphan a background descendant"
  else
    fail "normal-exit descendant cleanup failed (status=$status descendant=${descendant:-missing})"
    [[ -n "$descendant" ]] && kill -KILL "$descendant" 2>/dev/null || true
  fi
}

assert_conventional_spawn_exit_codes() {
  local missing_output="$TMP_DIR/missing-command.out"
  local denied_output="$TMP_DIR/denied-command.out" denied="$TMP_DIR/not-executable"
  local missing_status=0 denied_status=0
  printf '#!/usr/bin/env bash\nexit 0\n' >"$denied"
  chmod 600 "$denied"

  node "$ROOT/scripts/minikube/run-with-deadline.mjs" \
    --timeout-seconds 2 --label missing-command -- definitely-not-a-real-command-evenfire \
    >"$missing_output" 2>&1 || missing_status=$?
  node "$ROOT/scripts/minikube/run-with-deadline.mjs" \
    --timeout-seconds 2 --label denied-command -- "$denied" \
    >"$denied_output" 2>&1 || denied_status=$?

  if [[ "$missing_status" -eq 127 && "$denied_status" -eq 126 ]] \
    && grep -Fq 'exitCode=127' "$missing_output" \
    && grep -Fq 'exitCode=126' "$denied_output"; then
    pass "spawn failures use conventional exact 127/126 exit codes"
  else
    fail "spawn failure exit codes changed (missing=$missing_status denied=$denied_status)"
  fi
}

assert_endpoint_resolution_and_context_precedence
assert_config_only_rootless_context
assert_all_original_docker_env_is_restored
assert_real_build_script_isolated
assert_public_pulls_are_isolated
assert_local_image_operations_preserve_status
assert_local_minikube_load_timeout_kills_descendants
assert_startup_probes_are_isolated_and_bounded
assert_verify_inventory_is_read_only_and_bounded
assert_invalid_deadline_and_explicit_buildx_fail_closed
assert_private_registry_requires_explicit_config
assert_explicit_private_config_is_used_without_copying_ambient_auth
assert_exit_status_and_process_group_timeout
assert_bash_main_signal_cleanup HUP 129
assert_bash_main_signal_cleanup QUIT 131
assert_repeated_signal_escalates_group INT 130
assert_repeated_signal_escalates_group TERM 143
assert_normal_exit_reaps_background_descendants
assert_conventional_spawn_exit_codes

if find "$TASK_TMP" -mindepth 1 -maxdepth 1 -name 'evenfire-minikube-docker.*' -print -quit | grep -q .; then
  fail "a task-local Docker config survived cleanup"
else
  pass "task-local Docker configs are removed after every operation"
fi

exit "$FAIL"
