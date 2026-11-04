#!/usr/bin/env bash
set -euo pipefail

# Tests that deploy/scripts/gen-jwt-keys.sh restarts every deployed consumer of
# the keys it rotates, against fake kubectl and openssl binaries.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="${TMPDIR:-/tmp}/gen-jwt-keys-restarts-test.$$"
mkdir -p "$TMP/bin"
trap 'rm -rf "$TMP"' EXIT

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

cat > "$TMP/bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
# Every call must name the context the script was given, never the current one.
if [[ "${args[0]:-}" != "--context" || "${args[1]:-}" != "${CONTEXT:?}" ]]; then
  echo "fake kubectl: expected --context ${CONTEXT}, got: $*" >&2
  exit 9
fi
args=("${args[@]:2}")
ns=""
rest=()
for ((i=0; i<${#args[@]}; i++)); do
  if [[ "${args[$i]}" == "-n" ]]; then
    ns="${args[$((i+1))]}"
    i=$((i + 1))
  else
    rest+=("${args[$i]}")
  fi
done
case "${rest[0]:-}" in
  create)
    printf 'kind: %s\n' "${rest[1]}"
    ;;
  apply)
    cat > /dev/null
    ;;
  get)
    case "${rest[1]:-}" in
      configmap)
        # mcp-host-config exists; return a minimal object for the patch step.
        [[ " ${rest[*]} " == *" -o json "* ]] && printf '%s\n' '{"data":{},"metadata":{}}'
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
        if [[ " ${KUBE_DEPLOYS:-} " == *" $ns/$dep "* ]]; then
          printf 'deployment.apps/%s\n' "$dep"
        fi
        ;;
      *) echo "fake kubectl: unsupported get ${rest[*]}" >&2; exit 2 ;;
    esac
    ;;
  rollout)
    if [[ "${rest[1]:-}" == "restart" ]]; then
      if [[ -n "${rest[3]:-}" ]]; then
        printf '%s/%s\n' "$ns" "${rest[3]}" >> "${ROLLOUT_LOG:?}"
      else
        printf '%s/*\n' "$ns" >> "${ROLLOUT_LOG:?}"
      fi
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

run_gen_keys() {
  : > "$TMP/rollout.log"
  ROLLOUT_LOG="$TMP/rollout.log" PATH="$TMP/bin:$PATH" CONTEXT=gke-dev "$@" \
    bash "$SCRIPT" > "$TMP/out" 2>&1
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

assert_no_key_material() {
  if grep -q 'FAKE-PRIVATE-KEY-MATERIAL' "$TMP/out"; then
    fail "private key material leaked into the output"
  fi
}

# Every consumer deployed: each one restarts, plus the existing mcp-host restart.
run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" || fail "gen-jwt-keys.sh exited non-zero"
assert_restarted_exactly "${KEY_CONSUMERS[@]}" 'mcp-host/*'
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

# Only some consumers deployed: exactly those restart.
run_gen_keys env KUBE_DEPLOYS="control-plane/control-api rpc-proxy/rpc-proxy" \
  || fail "gen-jwt-keys.sh exited non-zero with a partial deployment"
assert_restarted_exactly control-plane/control-api rpc-proxy/rpc-proxy 'mcp-host/*'

# A failed deployment read stops the script instead of skipping the consumer.
if run_gen_keys env KUBE_DEPLOYS="${KEY_CONSUMERS[*]}" KUBE_GET_DEPLOY_FAIL="profiles/external-rest-api"; then
  fail "a failed deployment read must fail the script"
fi
grep -qF 'ERROR: cannot read deployment profiles/external-rest-api' "$TMP/out" \
  || fail "missing error line for the failed deployment read"
if grep -q '^=== Done ===$' "$TMP/out"; then
  fail "script must stop before Done after a failed deployment read"
fi

# --- scripts/minikube/generate-keys.sh (minikube profiles) ---
# FORCE_REGEN=true --apply over existing keys rotates them in a live profile, so
# the same consumers restart. A first creation (no control-api-secrets yet) and a
# run without --apply restart nothing.

MINIKUBE_SCRIPT="$ROOT/scripts/minikube/generate-keys.sh"
PROJECT="$TMP/project"
mkdir -p "$PROJECT/scripts/minikube" "$PROJECT/deploy/scripts/lib"
cp "$MINIKUBE_SCRIPT" "$PROJECT/scripts/minikube/generate-keys.sh"
cp "$ROOT/deploy/scripts/lib/restart-jwt-key-consumers.sh" "$PROJECT/deploy/scripts/lib/"

cat > "$TMP/bin/minikube-kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != "--context=${MINIKUBE_PROFILE:?}" ]]; then
  echo "fake kubectl: expected --context=${MINIKUBE_PROFILE}, got: $*" >&2
  exit 9
fi
shift
ns=""
rest=()
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -n) ns="$2"; shift 2 ;;
    *) rest+=("$1"); shift ;;
  esac
done
case "${rest[0]:-}" in
  get)
    case "${rest[1]:-}" in
      secret)
        # `-o name` probe for control-api-secrets: present only when asked to be.
        if [[ "${rest[2]:-}" == "control-api-secrets" && " ${rest[*]} " == *" -o name "* ]]; then
          [[ "${EXISTING_KEYS:-}" == "1" ]] && echo "secret/control-api-secrets"
          exit 0
        fi
        exit 1
        ;;
      deploy)
        printf 'deployment.apps/%s\n' "${rest[2]:?}"
        ;;
      *) echo "fake kubectl: unsupported get ${rest[*]}" >&2; exit 2 ;;
    esac
    ;;
  apply) cat > /dev/null ;;
  create) printf 'kind: %s\n' "${rest[1]}" ;;
  patch) ;;
  rollout)
    [[ "${rest[1]:-}" == "restart" ]] && printf '%s/%s\n' "$ns" "${rest[3]:?}" >> "${ROLLOUT_LOG:?}"
    ;;
  *) echo "fake kubectl: unsupported ${rest[*]}" >&2; exit 2 ;;
esac
SH
mkdir -p "$TMP/minikube-bin"
cp "$TMP/bin/minikube-kubectl" "$TMP/minikube-bin/kubectl"
chmod +x "$TMP/minikube-bin/kubectl"

run_minikube_keys() {
  : > "$TMP/rollout.log"
  ROLLOUT_LOG="$TMP/rollout.log" PATH="$TMP/minikube-bin:$PATH" MINIKUBE_PROFILE=clerum-test "$@" \
    bash "$PROJECT/scripts/minikube/generate-keys.sh" ${GEN_ARGS[@]+"${GEN_ARGS[@]}"} > "$TMP/out" 2>&1
}

GEN_ARGS=(--apply)
run_minikube_keys env EXISTING_KEYS=1 FORCE_REGEN=true || fail "generate-keys.sh --apply rotation exited non-zero"
assert_restarted_exactly "${KEY_CONSUMERS[@]}"
grep -qF 'Restarting consumers of the rotated keys' "$TMP/out" || fail "missing rotation restart log line"

run_minikube_keys env EXISTING_KEYS=0 FORCE_REGEN=true || fail "generate-keys.sh first creation exited non-zero"
assert_restarted_exactly
grep -qF 'Secrets applied to cluster' "$TMP/out" || fail "first creation did not apply the keys"

GEN_ARGS=()
run_minikube_keys env EXISTING_KEYS=1 FORCE_REGEN=true || fail "generate-keys.sh without --apply exited non-zero"
assert_restarted_exactly
grep -qF 'jwt-signing-keys.yaml written' "$TMP/out" || fail "regeneration without --apply did not write the manifest"

echo "gen-jwt-keys consumer restart tests passed"
