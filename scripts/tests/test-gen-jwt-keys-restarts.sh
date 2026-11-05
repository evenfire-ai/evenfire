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
# Deployments the fake lists in the mcp-host namespace by default.
MCP_DEPLOYS=(mcp-host/mcp-host mcp-host/workspace-files-controller-h1)

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
# `--context X` (gen-jwt-keys.sh) or `--context=X` (generate-keys.sh); with
# EXPECTED_CONTEXT=__none__ every call must carry no context at all. Writes
# (apply, patch) and restarts are appended to EVENT_LOG in call order.
# mcp-host: KUBE_MCP_CM=present|absent|fail drives mcp-host-config,
# KUBE_MCP_APPLY_FAIL=1 fails its apply, KUBE_MCP_DEPLOYS lists the namespace's
# Deployments. annotate calls are appended to ANNOTATE_LOG.
cat > "$TMP/bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
expected="${EXPECTED_CONTEXT:?}"
if [[ "$expected" == "__none__" ]]; then
  for a in "$@"; do
    if [[ "$a" == --context* ]]; then
      echo "fake kubectl: expected no context, got: $*" >&2
      exit 9
    fi
  done
elif [[ "${1:-}" == "--context" && "${2:-}" == "$expected" ]]; then
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
    manifest=""
    if has_arg -; then manifest="$(cat)"; fi
    # The mcp-host-config patch is the only JSON manifest these scripts apply.
    if [[ "$manifest" == "{"* && "${KUBE_MCP_APPLY_FAIL:-}" == "1" ]]; then
      echo "fake kubectl: apply of mcp-host-config failed" >&2
      exit 1
    fi
    echo "write apply" >> "${EVENT_LOG:?}"
    ;;
  annotate)
    target="$ns/${rest[2]:?}"
    if [[ " ${KUBE_ANNOTATE_FAIL:-} " == *" $target "* ]]; then
      echo "fake kubectl: annotate failed for $target" >&2
      exit 1
    fi
    printf '%s %s\n' "$target" "${rest[${#rest[@]}-1]}" >> "${ANNOTATE_LOG:?}"
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
        # gen-jwt-keys.sh: mcp-host-config, by name (`-o name`, existence
        # probe) and as a minimal object for the patch (`-o json`).
        case "${KUBE_MCP_CM:-present}" in
          fail) echo "fake kubectl: connection refused" >&2; exit 1 ;;
          absent) has_arg --ignore-not-found && exit 0; exit 1 ;;
        esac
        has_arg name && echo "configmap/mcp-host-config"
        has_arg json && printf '%s\n' '{"data":{},"metadata":{}}'
        exit 0
        ;;
      cm)
        # KUBE_WRC_CM=empty makes the clerum-wrc-public-key read empty.
        [[ "${KUBE_WRC_CM:-}" == "empty" ]] || printf -- '-----BEGIN PUBLIC KEY-----'
        ;;
      deploy)
        dep="${rest[2]:?}"
        if [[ "$dep" == -* ]]; then
          # Namespace listing (`get deploy -o name`), used for mcp-host.
          if [[ " ${KUBE_GET_DEPLOY_FAIL:-} " == *" $ns/* "* ]]; then
            echo "fake kubectl: connection refused" >&2
            exit 1
          fi
          if [[ "$ns" == "mcp-host" ]]; then
            for d in ${KUBE_MCP_DEPLOYS:-}; do printf 'deployment.apps/%s\n' "$d"; done
          fi
          exit 0
        fi
        if [[ "$ns" == "mcp-host" && " ${KUBE_MCP_DEPLOYS:-} " == *" $dep "* ]]; then
          flaky_once get "$ns/$dep"
          has_arg name && printf 'deployment.apps/%s\n' "$dep"
          exit 0
        fi
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
  : > "$TMP/annotate.log"
  rm -rf "$TMP/flaky"
  mkdir -p "$TMP/flaky"
}

run_gen_keys() {
  local rc=0
  reset_logs
  ROLLOUT_LOG="$TMP/rollout.log" EVENT_LOG="$TMP/events.log" FLAKY_STATE="$TMP/flaky" \
    ANNOTATE_LOG="$TMP/annotate.log" PATH="$TMP/bin:$PATH" JWT_KEY_RESTART_RETRY_SECONDS=0 \
    KUBE_MCP_DEPLOYS="mcp-host workspace-files-controller-h1" \
    CONTEXT=gke-dev EXPECTED_CONTEXT=gke-dev "$@" \
    bash "$SCRIPT" > "$TMP/out" 2>&1 </dev/null || rc=$?
  assert_no_key_material
  return "$rc"
}

# Same, with CONTEXT unset: every kubectl call must carry no context.
run_gen_keys_no_context() {
  local rc=0
  reset_logs
  ROLLOUT_LOG="$TMP/rollout.log" EVENT_LOG="$TMP/events.log" FLAKY_STATE="$TMP/flaky" \
    ANNOTATE_LOG="$TMP/annotate.log" PATH="$TMP/bin:$PATH" JWT_KEY_RESTART_RETRY_SECONDS=0 \
    KUBE_MCP_DEPLOYS="mcp-host workspace-files-controller-h1" \
    EXPECTED_CONTEXT=__none__ "$@" \
    bash "$SCRIPT" > "$TMP/out" 2>&1 </dev/null || rc=$?
  assert_no_key_material
  return "$rc"
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
  first_restart="$(grep -n '^restart ' "$TMP/events.log" | head -1 | cut -d: -f1)"
  [[ -n "$last_write" ]] || fail "no key write was recorded"
  [[ -n "$first_restart" ]] || fail "no consumer restart was recorded"
  [[ "$first_restart" -gt "$last_write" ]] \
    || fail "a consumer restarted (event $first_restart) before the last key write (event $last_write)"
}

# Fails when the last run's output holds key material or a generated secret:
# the fake private key, or any 64-hex string (the fake `openssl rand` prints
# printf '%064x' 42; real `openssl rand -hex 32` values have the same shape).
assert_no_key_material() {
  if grep -qE 'FAKE-PRIVATE-KEY-MATERIAL|[0-9a-f]{64}' "$TMP/out"; then
    fail "secret material leaked into the output"
  fi
  return 0
}
# Liveness of the pattern: it must match the fake openssl rand value.
printf '%064x\n' 42 | grep -qE '[0-9a-f]{64}' || { echo "FAIL: leak pattern misses the fake rand value" >&2; exit 1; }

# --- deploy/scripts/gen-jwt-keys.sh ---

# Every consumer deployed: each one restarts after the writes, plus mcp-host.
run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" || fail "gen-jwt-keys.sh exited non-zero"
assert_restarted_exactly "${KEY_CONSUMERS[@]}" "${MCP_DEPLOYS[@]}"
assert_restarts_after_writes
for consumer in "${KEY_CONSUMERS[@]}"; do
  grep -qF "  $consumer restarted." "$TMP/out" || fail "missing restart line for $consumer"
done
grep -q '^=== Done ===$' "$TMP/out" || fail "script did not reach Done"
grep -qF 'GFSC KEY SYNC REQUIRED' "$TMP/out" || fail "missing the gfsc sync notice"
if grep -qF 'JWT public key synced' "$TMP/out"; then fail "the success line must not claim a key sync"; fi

# Keys generated before the first deploy: nothing to restart, each skip is logged.
run_gen_keys env KUBE_DEPLOYS="" || fail "gen-jwt-keys.sh exited non-zero with no consumers deployed"
assert_restarted_exactly "${MCP_DEPLOYS[@]}"
for consumer in "${KEY_CONSUMERS[@]}"; do
  grep -qF "  $consumer not deployed yet; skipped." "$TMP/out" || fail "missing skip line for $consumer"
done
grep -q '^=== Done ===$' "$TMP/out" || fail "script did not reach Done"
grep -qF 'GFSC KEY SYNC REQUIRED' "$TMP/out" || fail "missing the gfsc sync notice"
if grep -qF 'JWT public key synced' "$TMP/out"; then fail "the success line must not claim a key sync"; fi

# Only some consumers deployed: exactly those restart.
run_gen_keys env KUBE_DEPLOYS="control-plane/control-api rpc-proxy/rpc-proxy" \
  || fail "gen-jwt-keys.sh exited non-zero with a partial deployment"
assert_restarted_exactly control-plane/control-api rpc-proxy/rpc-proxy "${MCP_DEPLOYS[@]}"

# A failed deployment read: every other consumer still restarts, the validation
# runs, and the script fails with the command that restarts the unread one.
if run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" KUBE_GET_DEPLOY_FAIL="profiles/external-rest-api"; then
  fail "a failed deployment read must fail the script"
fi
grep -qF 'ERROR: cannot read deployment profiles/external-rest-api' "$TMP/out" \
  || fail "missing error line for the failed deployment read"
restarted_others=()
while IFS= read -r consumer; do restarted_others+=("$consumer"); done < <(consumers_except profiles/external-rest-api)
assert_restarted_exactly "${restarted_others[@]}" "${MCP_DEPLOYS[@]}"
grep -q '^=== Post-deploy validation ===$' "$TMP/out" || fail "validation must run after a pending restart"
grep -qF 'RESTARTS PENDING' "$TMP/out" || fail "missing RESTARTS PENDING line"
assert_key_restarts_pending "kubectl --context gke-dev" profiles/external-rest-api

# A failed restart (every attempt): same, for the consumer that failed.
if run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" KUBE_ROLLOUT_FAIL="rpc-proxy/rpc-proxy"; then
  fail "a failed rollout restart must fail the script"
fi
grep -qF 'rollout restart failed for rpc-proxy/rpc-proxy' "$TMP/out" \
  || fail "the failed rollout was not reached"
restarted_others=()
while IFS= read -r consumer; do restarted_others+=("$consumer"); done < <(consumers_except rpc-proxy/rpc-proxy)
assert_restarted_exactly "${restarted_others[@]}" "${MCP_DEPLOYS[@]}"
assert_key_restarts_pending "kubectl --context gke-dev" rpc-proxy/rpc-proxy

# Failures on the first attempt only are retried: every consumer restarts.
run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" \
  KUBE_FLAKY="get:control-plane/control-ui rollout:control-plane/workflow-recipes" \
  || fail "transient failures must be absorbed by the retries"
assert_restarted_exactly "${KEY_CONSUMERS[@]}" "${MCP_DEPLOYS[@]}"
[[ -e "$TMP/flaky/rollout-control-plane_workflow-recipes" ]] || fail "the transient rollout failure was never injected"
grep -q '^=== Done ===$' "$TMP/out" || fail "script did not reach Done after transient failures"

# --- mcp-host: synced and restarted under the same retry / pending / exit-1 contract as the other consumers ---
# Every Deployment in the namespace restarts after its ConfigMap is written.
run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" || fail "gen-jwt-keys.sh exited non-zero"
for dep in "${MCP_DEPLOYS[@]}"; do
  grep -qF "  $dep restarted." "$TMP/out" || fail "missing restart line for $dep"
done
grep -qF 'mcp-host-config patched with new RPC public key.' "$TMP/out" || fail "mcp-host-config was not patched"

# A failed mcp-host restart is no longer swallowed: the rest still restarts,
# validation runs, the run fails with the exact command, and no token-stamp
# mark is written for mcp-host (its next-deploy healer is sync-auth-key.sh).
if run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" KUBE_ROLLOUT_FAIL="mcp-host/mcp-host"; then
  fail "a failed mcp-host restart must fail the script"
fi
grep -qF 'rollout restart failed for mcp-host/mcp-host' "$TMP/out" || fail "the mcp-host failure was not reached"
assert_restarted_exactly "${KEY_CONSUMERS[@]}" mcp-host/workspace-files-controller-h1
grep -q '^=== Post-deploy validation ===$' "$TMP/out" || fail "validation must run after a pending mcp-host restart"
assert_key_restarts_pending "kubectl --context gke-dev" mcp-host/mcp-host
if grep -q 'mcp-host/' "$TMP/annotate.log"; then fail "mcp-host must not get a token-stamp mark"; fi

# The mcp-host listing fails: the namespace-wide command is printed.
if run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" KUBE_GET_DEPLOY_FAIL="mcp-host/*"; then
  fail "a failed mcp-host listing must fail the script"
fi
grep -qF 'ERROR: cannot list deployments in mcp-host' "$TMP/out" || fail "missing mcp-host listing error"
grep -qx '    kubectl --context gke-dev -n mcp-host rollout restart deploy' "$TMP/out" \
  || fail "missing the namespace-wide mcp-host restart command"
assert_restarted_exactly "${KEY_CONSUMERS[@]}"

# No Deployment in mcp-host yet: logged, not a failure.
run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" KUBE_MCP_DEPLOYS="" \
  || fail "an empty mcp-host namespace must not fail the script"
grep -qF 'no deployment in mcp-host yet; skipped.' "$TMP/out" || fail "missing empty-namespace line"
assert_restarted_exactly "${KEY_CONSUMERS[@]}"

# mcp-host-config cannot be read: no mcp-host restart (it would reload the old
# key), the consumers still restart, and the run fails naming the sync path.
if run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" KUBE_MCP_CM=fail; then
  fail "an unreadable mcp-host-config must fail the script"
fi
grep -qF 'ERROR: cannot read mcp-host/mcp-host-config' "$TMP/out" || fail "missing mcp-host-config read error"
assert_restarted_exactly "${KEY_CONSUMERS[@]}"
grep -qF 'MCP-HOST SYNC PENDING' "$TMP/out" || fail "missing MCP-HOST SYNC PENDING line"
grep -qF 'sync-auth-key.sh' "$TMP/out" || fail "the pending sync must name sync-auth-key.sh"
grep -q '^=== Done ===$' "$TMP/out" && fail "a pending mcp-host sync must stop before Done"

# mcp-host-config cannot be written: same outcome.
if run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" KUBE_MCP_APPLY_FAIL=1; then
  fail "a failed mcp-host-config write must fail the script"
fi
grep -qF 'ERROR: cannot write the new RPC public key to mcp-host-config' "$TMP/out" \
  || fail "missing mcp-host-config write error"
assert_restarted_exactly "${KEY_CONSUMERS[@]}"
grep -qF 'MCP-HOST SYNC PENDING' "$TMP/out" || fail "missing MCP-HOST SYNC PENDING line"

# mcp-host not deployed (no ConfigMap): warning, exit 0, consumers restart.
run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" KUBE_MCP_CM=absent \
  || fail "a missing mcp-host-config must keep the existing warning path"
grep -qF 'WARNING: mcp-host-config ConfigMap not found' "$TMP/out" || fail "missing mcp-host-config warning"
assert_restarted_exactly "${KEY_CONSUMERS[@]}"

# A transient mcp-host restart failure is absorbed by the retries.
run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" KUBE_FLAKY="rollout:mcp-host/mcp-host" \
  || fail "a transient mcp-host failure must be absorbed"
[[ -e "$TMP/flaky/rollout-mcp-host_mcp-host" ]] || fail "the transient mcp-host failure was never injected"
assert_restarted_exactly "${KEY_CONSUMERS[@]}" "${MCP_DEPLOYS[@]}"

# A failed validation still prints every pending summary before exiting 1.
if run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" KUBE_ROLLOUT_FAIL="rpc-proxy/rpc-proxy" \
     KUBE_MCP_CM=fail KUBE_WRC_CM=empty; then
  fail "a failed validation must fail the script"
fi
grep -qF 'VALIDATION FAILED' "$TMP/out" || fail "missing validation failure"
grep -qF 'MCP-HOST SYNC PENDING' "$TMP/out" || fail "MCP-HOST SYNC PENDING not printed on a failed validation"
grep -qF 'RESTARTS PENDING' "$TMP/out" || fail "RESTARTS PENDING not printed on a failed validation"
grep -qF 'GFSC KEY SYNC REQUIRED' "$TMP/out" || fail "the gfsc notice not printed on a failed validation"

# --- A pending key-consumer restart is handed to the next token step ---
# rpc-proxy is also reconciled by apply-inter-service-tokens.sh, so it gets the
# restart-pending token stamp; control-ui is not, so it keeps only its command.
if run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" \
     KUBE_ROLLOUT_FAIL="rpc-proxy/rpc-proxy control-plane/control-ui"; then
  fail "failed restarts must fail the script"
fi
assert_key_restarts_pending "kubectl --context gke-dev" rpc-proxy/rpc-proxy control-plane/control-ui
grep -qx 'rpc-proxy/rpc-proxy clerum.io/inter-service-tokens-sha256=restart-pending' "$TMP/annotate.log" \
  || fail "rpc-proxy was not marked restart-pending"
grep -qF 'rpc-proxy/rpc-proxy marked restart-pending' "$TMP/out" || fail "missing mark line for rpc-proxy"
if grep -q '^control-plane/control-ui ' "$TMP/annotate.log"; then fail "control-ui must not be marked"; fi
[[ "$(wc -l < "$TMP/annotate.log" | tr -d ' ')" == "1" ]] || fail "only the pending token consumer may be marked"

# The mark itself fails: the run says so and the command stays the recovery.
if run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" KUBE_ROLLOUT_FAIL="rpc-proxy/rpc-proxy" \
     KUBE_ANNOTATE_FAIL="rpc-proxy/rpc-proxy"; then
  fail "a failed restart must fail the script"
fi
grep -qF 'ERROR: cannot mark rpc-proxy/rpc-proxy restart-pending' "$TMP/out" || fail "missing mark failure line"
assert_key_restarts_pending "kubectl --context gke-dev" rpc-proxy/rpc-proxy

# --- CONTEXT unset: plain kubectl, and the printed commands carry no context ---
run_gen_keys_no_context env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" \
  || fail "gen-jwt-keys.sh without CONTEXT exited non-zero"
assert_restarted_exactly "${KEY_CONSUMERS[@]}" "${MCP_DEPLOYS[@]}"
if run_gen_keys_no_context env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" KUBE_ROLLOUT_FAIL="rpc-proxy/rpc-proxy"; then
  fail "a failed restart without CONTEXT must fail the script"
fi
grep -qx '    kubectl -n rpc-proxy rollout restart deploy rpc-proxy' "$TMP/out" \
  || fail "missing context-free recovery command"

# --- scripts/minikube/generate-keys.sh (minikube profiles) ---
# Every --apply that writes new keys restarts the deployed consumers after the
# apply; consumers not deployed yet are skipped. Without --apply nothing is
# written or restarted.

PROJECT="$TMP/project"
mkdir -p "$PROJECT/scripts/minikube" "$PROJECT/deploy/scripts/lib"
cp "$ROOT/scripts/minikube/generate-keys.sh" "$PROJECT/scripts/minikube/generate-keys.sh"
cp "$ROOT/deploy/scripts/lib/restart-jwt-key-consumers.sh" "$PROJECT/deploy/scripts/lib/"
cp "$ROOT/deploy/scripts/lib/token-consumer-stamp.sh" "$PROJECT/deploy/scripts/lib/"

run_minikube_keys() {
  local rc=0
  reset_logs
  ROLLOUT_LOG="$TMP/rollout.log" EVENT_LOG="$TMP/events.log" FLAKY_STATE="$TMP/flaky" \
    ANNOTATE_LOG="$TMP/annotate.log" PATH="$TMP/bin:$PATH" JWT_KEY_RESTART_RETRY_SECONDS=0 \
    MINIKUBE_PROFILE=clerum-test EXPECTED_CONTEXT=clerum-test "$@" \
    bash "$PROJECT/scripts/minikube/generate-keys.sh" ${GEN_ARGS[@]+"${GEN_ARGS[@]}"} > "$TMP/out" 2>&1 </dev/null || rc=$?
  assert_no_key_material
  return "$rc"
}

GEN_ARGS=(--apply)
# Rotation over existing keys in a live profile.
run_minikube_keys env EXISTING_KEYS=1 FORCE_REGEN=true KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" \
  || fail "generate-keys.sh --apply rotation exited non-zero"
assert_restarted_exactly "${KEY_CONSUMERS[@]}"
assert_restarts_after_writes
grep -qF 'Restarting consumers of the new keys' "$TMP/out" || fail "missing restart log line"

# Keys missing while the consumers still run (Secret deleted out of band): the
# regenerated keys are new to the running pods, so they restart too.
run_minikube_keys env EXISTING_KEYS=0 KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" \
  || fail "generate-keys.sh regeneration with running consumers exited non-zero"
assert_restarted_exactly "${KEY_CONSUMERS[@]}"
assert_restarts_after_writes

# Fresh profile: keys applied, no consumer deployed yet, each skip logged.
run_minikube_keys env EXISTING_KEYS=0 KUBE_DEPLOYS="" \
  || fail "generate-keys.sh first creation exited non-zero"
assert_restarted_exactly
grep -q '^write apply$' "$TMP/events.log" || fail "first creation did not apply the keys"
for consumer in "${KEY_CONSUMERS[@]}"; do
  grep -qF "  $consumer not deployed yet; skipped." "$TMP/out" || fail "missing skip line for $consumer"
done

# Keys already present and no FORCE_REGEN (the common full-setup.sh path): no
# key is regenerated, nothing is applied, nothing restarts.
run_minikube_keys env EXISTING_KEYS=1 KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" \
  || fail "generate-keys.sh --apply with existing keys exited non-zero"
assert_restarted_exactly
grep -qF 'Using existing keys (no regeneration)' "$TMP/out" || fail "the existing-keys path was not taken"
if grep -q '^write' "$TMP/events.log"; then
  fail "generate-keys.sh must not write keys when they already exist"
fi

# A failed deployment read: the other consumers restart, then the script fails
# with the command that restarts the unread one.
if run_minikube_keys env EXISTING_KEYS=1 FORCE_REGEN=true KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" \
     KUBE_GET_DEPLOY_FAIL="control-plane/control-ui"; then
  fail "generate-keys.sh must fail on a failed deployment read"
fi
grep -qF 'ERROR: cannot read deployment control-plane/control-ui' "$TMP/out" \
  || fail "missing error line for the failed deployment read"
restarted_others=()
while IFS= read -r consumer; do restarted_others+=("$consumer"); done < <(consumers_except control-plane/control-ui)
assert_restarted_exactly "${restarted_others[@]}"
assert_key_restarts_pending "kubectl --context=clerum-test" control-plane/control-ui

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
