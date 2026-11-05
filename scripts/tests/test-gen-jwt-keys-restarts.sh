#!/usr/bin/env bash
set -euo pipefail

# Tests that deploy/scripts/gen-jwt-keys.sh and scripts/minikube/generate-keys.sh
# restart every deployed consumer of the keys they write, after writing them,
# against fake kubectl and openssl binaries.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="${TMPDIR:-/tmp}/gen-jwt-keys-restarts-test.$$"
mkdir -p "$TMP/bin"
trap 'rm -rf "$TMP"' EXIT

# Runs must not inherit overrides from the caller's environment.
unset CONTEXT MINIKUBE_PROFILE FORCE_REGEN ADMIN_PASSWORD ADMIN_BOOTSTRAP_PASSWORD_HASH \
  CONTROL_UI_PUBLIC_TOKEN_CSRF_SECRET

SCRIPT="$ROOT/deploy/scripts/gen-jwt-keys.sh"

KEY_CONSUMERS=(
  control-plane/control-api
  control-plane/control-ui
  rpc-proxy/rpc-proxy
  profiles/external-rest-api
  control-plane/workflow-recipes
  control-plane/host-context-controller
  control-plane/codex-llm-proxy
  control-plane/grok-llm-proxy
)

cat > "$TMP/bin/openssl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
out=""
for ((i=1; i<=$#; i++)); do
  if [[ "${!i}" == "-out" ]]; then
    j=$((i + 1))
    out="${!j}"
  fi
done
case "${1:-}" in
  genpkey) printf 'FAKE-PRIVATE-KEY-MATERIAL\n' > "$out" ;;
  rsa) printf -- '-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----\n' > "$out" ;;
  rand) printf '%064x\n' 42 ;;
  *) echo "unexpected openssl invocation: $*" >&2; exit 1 ;;
esac
SH

# One fake for both scripts. Every call must carry the expected context, as
# `--context X` (gen-jwt-keys.sh) or `--context=X` (generate-keys.sh). Writes
# (apply, patch) and restarts are appended to EVENT_LOG in call order.
cat > "$TMP/bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
expected="${EXPECTED_CONTEXT:?}"
if [[ "${1:-}" == "--context" && "${2:-}" == "$expected" ]]; then
  shift 2
elif [[ "${1:-}" == "--context=$expected" ]]; then
  shift
else
  echo "fake kubectl: expected context $expected, got: $*" >&2
  exit 9
fi
ns=""
rest=()
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -n) ns="$2"; shift 2 ;;
    *) rest+=("$1"); shift ;;
  esac
done
has_arg() {
  local a
  for a in "${rest[@]}"; do [[ "$a" == "$1" ]] && return 0; done
  return 1
}
# KUBE_FLAKY lists "<op>:<ns>/<name>" that fail on their first attempt only.
flaky_once() {
  local marker
  if [[ " ${KUBE_FLAKY:-} " == *" $1:$2 "* ]]; then
    marker="${FLAKY_STATE:?}/$1-${2//\//_}"
    if [[ ! -e "$marker" ]]; then
      : > "$marker"
      echo "fake kubectl: transient $1 failure for $2" >&2
      exit 1
    fi
  fi
}
case "${rest[0]:-}" in
  create)
    printf 'kind: %s\n' "${rest[1]}"
    ;;
  apply)
    # Read stdin only for `-f -`, as kubectl does.
    if has_arg -; then cat > /dev/null; fi
    echo "write apply" >> "${EVENT_LOG:?}"
    ;;
  patch)
    echo "write patch ${rest[2]:-}" >> "${EVENT_LOG:?}"
    ;;
  get)
    case "${rest[1]:-}" in
      secret)
        # generate-keys.sh probes control-api-secrets with `-o name`, its
        # prompt-history key with a go-template, and control-ui-secrets by name.
        if [[ "${rest[2]:-}" == "control-api-secrets" ]] && has_arg name; then
          [[ "${EXISTING_KEYS:-}" == "1" ]] && echo "secret/control-api-secrets"
          exit 0
        fi
        if [[ "${rest[2]:-}" == "control-api-secrets" && " ${rest[*]} " == *" go-template="* ]]; then
          [[ "${EXISTING_KEYS:-}" == "1" ]] && printf 'present'
          exit 0
        fi
        if [[ "${rest[2]:-}" == "control-ui-secrets" && "${EXISTING_KEYS:-}" == "1" ]]; then
          exit 0
        fi
        exit 1
        ;;
      configmap)
        # gen-jwt-keys.sh: mcp-host-config exists; minimal object for the patch.
        has_arg json && printf '%s\n' '{"data":{},"metadata":{}}'
        exit 0
        ;;
      cm)
        printf -- '-----BEGIN PUBLIC KEY-----'
        ;;
      deploy)
        dep="${rest[2]:?}"
        if [[ " ${KUBE_GET_DEPLOY_FAIL:-} " == *" $ns/$dep "* ]]; then
          echo "fake kubectl: connection refused" >&2
          exit 1
        fi
        flaky_once get "$ns/$dep"
        if [[ " ${KUBE_DEPLOYS:-} " == *" $ns/$dep "* ]]; then
          if has_arg name; then
            printf 'deployment.apps/%s\n' "$dep"
          fi
          exit 0
        fi
        # Like kubectl: NotFound fails unless --ignore-not-found is given.
        has_arg --ignore-not-found && exit 0
        echo "Error from server (NotFound): deployments.apps \"$dep\" not found" >&2
        exit 1
        ;;
      *) echo "fake kubectl: unsupported get ${rest[*]}" >&2; exit 2 ;;
    esac
    ;;
  rollout)
    if [[ "${rest[1]:-}" == "restart" ]]; then
      target="$ns/${rest[3]:-*}"
      if [[ " ${KUBE_ROLLOUT_FAIL:-} " == *" $target "* ]]; then
        echo "fake kubectl: rollout restart failed for $target" >&2
        exit 1
      fi
      flaky_once rollout "$target"
      printf '%s\n' "$target" >> "${ROLLOUT_LOG:?}"
      echo "restart $target" >> "${EVENT_LOG:?}"
    fi
    ;;
  *) echo "fake kubectl: unsupported ${rest[*]}" >&2; exit 2 ;;
esac
SH

chmod +x "$TMP/bin/openssl" "$TMP/bin/kubectl"

fail() {
  echo "FAIL: $*" >&2
  echo "--- output of the last run ---" >&2
  cat "$TMP/out" >&2 || true
  exit 1
}

reset_logs() {
  : > "$TMP/rollout.log"
  : > "$TMP/events.log"
  rm -rf "$TMP/flaky"
  mkdir -p "$TMP/flaky"
}

run_gen_keys() {
  reset_logs
  ROLLOUT_LOG="$TMP/rollout.log" EVENT_LOG="$TMP/events.log" FLAKY_STATE="$TMP/flaky" \
    PATH="$TMP/bin:$PATH" JWT_KEY_RESTART_RETRY_SECONDS=0 \
    CONTEXT=gke-dev EXPECTED_CONTEXT=gke-dev "$@" \
    bash "$SCRIPT" > "$TMP/out" 2>&1 </dev/null
}

# A run that left restarts pending: the walk went on, the validation ran, the
# script failed before Done and printed one runnable command per pending one.
assert_key_restarts_pending() {
  local kubectl_prefix="$1" item
  shift
  grep -q '^=== Done ===$' "$TMP/out" && fail "a run with pending restarts must stop before Done"
  grep -qF 'these restarts are pending' "$TMP/out" || fail "missing pending-restarts error"
  grep -qF 'Do not re-run the key script' "$TMP/out" || fail "missing do-not-rerun notice"
  for item in "$@"; do
    grep -qF "    $kubectl_prefix -n ${item%%/*} rollout restart deploy ${item#*/}" "$TMP/out" \
      || fail "missing restart command for $item"
  done
}

# KEY_CONSUMERS without the given ones.
consumers_except() {
  local c skip keep
  for c in "${KEY_CONSUMERS[@]}"; do
    keep=true
    for skip in "$@"; do [[ "$c" == "$skip" ]] && keep=false; done
    [[ "$keep" == "true" ]] && printf '%s\n' "$c"
  done
}

assert_restarted_exactly() {
  local expected actual
  expected="$(printf '%s\n' "$@" | sed '/^$/d' | sort)"
  actual="$(sort "$TMP/rollout.log")"
  [[ "$expected" == "$actual" ]] || fail "restarted deployments differ
expected:
${expected:-<none>}
actual:
${actual:-<none>}"
}

# Every consumer restart comes after the last key write.
assert_restarts_after_writes() {
  local last_write first_restart
  last_write="$(grep -n '^write' "$TMP/events.log" | tail -1 | cut -d: -f1)"
  first_restart="$(grep -n '^restart ' "$TMP/events.log" | grep -v 'mcp-host/\*' | head -1 | cut -d: -f1)"
  [[ -n "$last_write" ]] || fail "no key write was recorded"
  [[ -n "$first_restart" ]] || fail "no consumer restart was recorded"
  [[ "$first_restart" -gt "$last_write" ]] \
    || fail "a consumer restarted (event $first_restart) before the last key write (event $last_write)"
}

assert_no_key_material() {
  if grep -q 'FAKE-PRIVATE-KEY-MATERIAL' "$TMP/out"; then
    fail "private key material leaked into the output"
  fi
}

# --- deploy/scripts/gen-jwt-keys.sh ---

# Every consumer deployed: each one restarts after the writes, plus mcp-host.
run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" || fail "gen-jwt-keys.sh exited non-zero"
assert_restarted_exactly "${KEY_CONSUMERS[@]}" 'mcp-host/*'
assert_restarts_after_writes
for consumer in "${KEY_CONSUMERS[@]}"; do
  grep -qF "  $consumer restarted." "$TMP/out" || fail "missing restart line for $consumer"
done
grep -q '^=== Done ===$' "$TMP/out" || fail "script did not reach Done"
assert_no_key_material

# Keys generated before the first deploy: nothing to restart, each skip is logged.
run_gen_keys env KUBE_DEPLOYS="" || fail "gen-jwt-keys.sh exited non-zero with no consumers deployed"
assert_restarted_exactly 'mcp-host/*'
for consumer in "${KEY_CONSUMERS[@]}"; do
  grep -qF "  $consumer not deployed yet; skipped." "$TMP/out" || fail "missing skip line for $consumer"
done
grep -q '^=== Done ===$' "$TMP/out" || fail "script did not reach Done"
assert_no_key_material

# Only some consumers deployed: exactly those restart.
run_gen_keys env KUBE_DEPLOYS="control-plane/control-api rpc-proxy/rpc-proxy" \
  || fail "gen-jwt-keys.sh exited non-zero with a partial deployment"
assert_restarted_exactly control-plane/control-api rpc-proxy/rpc-proxy 'mcp-host/*'
assert_no_key_material

# A failed deployment read: every other consumer still restarts, the validation
# runs, and the script fails with the command that restarts the unread one.
if run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" KUBE_GET_DEPLOY_FAIL="profiles/external-rest-api"; then
  fail "a failed deployment read must fail the script"
fi
grep -qF 'ERROR: cannot read deployment profiles/external-rest-api' "$TMP/out" \
  || fail "missing error line for the failed deployment read"
mapfile -t restarted_others < <(consumers_except profiles/external-rest-api)
assert_restarted_exactly "${restarted_others[@]}" 'mcp-host/*'
grep -q '^=== Post-deploy validation ===$' "$TMP/out" || fail "validation must run after a pending restart"
grep -qF 'RESTARTS PENDING' "$TMP/out" || fail "missing RESTARTS PENDING line"
assert_key_restarts_pending "kubectl --context gke-dev" profiles/external-rest-api
assert_no_key_material

# A failed restart (every attempt): same, for the consumer that failed.
if run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" KUBE_ROLLOUT_FAIL="rpc-proxy/rpc-proxy"; then
  fail "a failed rollout restart must fail the script"
fi
grep -qF 'rollout restart failed for rpc-proxy/rpc-proxy' "$TMP/out" \
  || fail "the failed rollout was not reached"
mapfile -t restarted_others < <(consumers_except rpc-proxy/rpc-proxy)
assert_restarted_exactly "${restarted_others[@]}" 'mcp-host/*'
assert_key_restarts_pending "kubectl --context gke-dev" rpc-proxy/rpc-proxy
assert_no_key_material

# Failures on the first attempt only are retried: every consumer restarts.
run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" \
  KUBE_FLAKY="get:control-plane/control-ui rollout:control-plane/workflow-recipes" \
  || fail "transient failures must be absorbed by the retries"
assert_restarted_exactly "${KEY_CONSUMERS[@]}" 'mcp-host/*'
[[ -e "$TMP/flaky/rollout-control-plane_workflow-recipes" ]] || fail "the transient rollout failure was never injected"
grep -q '^=== Done ===$' "$TMP/out" || fail "script did not reach Done after transient failures"
assert_no_key_material

# --- scripts/minikube/generate-keys.sh (minikube profiles) ---
# Every --apply that writes new keys restarts the deployed consumers after the
# apply; consumers not deployed yet are skipped. Without --apply nothing is
# written or restarted.

PROJECT="$TMP/project"
mkdir -p "$PROJECT/scripts/minikube" "$PROJECT/deploy/scripts/lib"
cp "$ROOT/scripts/minikube/generate-keys.sh" "$PROJECT/scripts/minikube/generate-keys.sh"
cp "$ROOT/deploy/scripts/lib/restart-jwt-key-consumers.sh" "$PROJECT/deploy/scripts/lib/"

run_minikube_keys() {
  reset_logs
  ROLLOUT_LOG="$TMP/rollout.log" EVENT_LOG="$TMP/events.log" FLAKY_STATE="$TMP/flaky" \
    PATH="$TMP/bin:$PATH" JWT_KEY_RESTART_RETRY_SECONDS=0 \
    MINIKUBE_PROFILE=clerum-test EXPECTED_CONTEXT=clerum-test "$@" \
    bash "$PROJECT/scripts/minikube/generate-keys.sh" ${GEN_ARGS[@]+"${GEN_ARGS[@]}"} > "$TMP/out" 2>&1 </dev/null
}

GEN_ARGS=(--apply)
# Rotation over existing keys in a live profile.
run_minikube_keys env EXISTING_KEYS=1 FORCE_REGEN=true KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" \
  || fail "generate-keys.sh --apply rotation exited non-zero"
assert_restarted_exactly "${KEY_CONSUMERS[@]}"
assert_restarts_after_writes
grep -qF 'Restarting consumers of the new keys' "$TMP/out" || fail "missing restart log line"
assert_no_key_material

# Keys missing while the consumers still run (Secret deleted out of band): the
# regenerated keys are new to the running pods, so they restart too.
run_minikube_keys env EXISTING_KEYS=0 KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" \
  || fail "generate-keys.sh regeneration with running consumers exited non-zero"
assert_restarted_exactly "${KEY_CONSUMERS[@]}"
assert_restarts_after_writes
assert_no_key_material

# Fresh profile: keys applied, no consumer deployed yet, each skip logged.
run_minikube_keys env EXISTING_KEYS=0 KUBE_DEPLOYS="" \
  || fail "generate-keys.sh first creation exited non-zero"
assert_restarted_exactly
grep -q '^write apply$' "$TMP/events.log" || fail "first creation did not apply the keys"
for consumer in "${KEY_CONSUMERS[@]}"; do
  grep -qF "  $consumer not deployed yet; skipped." "$TMP/out" || fail "missing skip line for $consumer"
done
assert_no_key_material

# Keys already present and no FORCE_REGEN (the common full-setup.sh path): no
# key is regenerated, nothing is applied, nothing restarts.
run_minikube_keys env EXISTING_KEYS=1 KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" \
  || fail "generate-keys.sh --apply with existing keys exited non-zero"
assert_restarted_exactly
grep -qF 'Using existing keys (no regeneration)' "$TMP/out" || fail "the existing-keys path was not taken"
if grep -q '^write' "$TMP/events.log"; then
  fail "generate-keys.sh must not write keys when they already exist"
fi
assert_no_key_material

# A failed deployment read: the other consumers restart, then the script fails
# with the command that restarts the unread one.
if run_minikube_keys env EXISTING_KEYS=1 FORCE_REGEN=true KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" \
     KUBE_GET_DEPLOY_FAIL="control-plane/control-ui"; then
  fail "generate-keys.sh must fail on a failed deployment read"
fi
grep -qF 'ERROR: cannot read deployment control-plane/control-ui' "$TMP/out" \
  || fail "missing error line for the failed deployment read"
mapfile -t restarted_others < <(consumers_except control-plane/control-ui)
assert_restarted_exactly "${restarted_others[@]}"
assert_key_restarts_pending "kubectl --context=clerum-test" control-plane/control-ui
assert_no_key_material

GEN_ARGS=()
# Without --apply: the manifest is written, nothing is applied or restarted.
run_minikube_keys env EXISTING_KEYS=1 FORCE_REGEN=true KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" \
  || fail "generate-keys.sh without --apply exited non-zero"
assert_restarted_exactly
grep -qF 'jwt-signing-keys.yaml written' "$TMP/out" || fail "regeneration without --apply did not write the manifest"
if grep -q '^write' "$TMP/events.log"; then
  fail "generate-keys.sh without --apply must not write to the cluster"
fi

echo "key rotation consumer restart tests passed"
