#!/usr/bin/env bash
# Exercise the real LLM Secret helper with only disposable fixture values.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TEST_BASH="${TEST_BASH:-/bin/bash}"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
PRIMARY="$TMP/primary"
WORKTREE="$TMP/worktree"
BIN="$TMP/bin"
BASE64="$(command -v base64)"
mkdir -p "$PRIMARY" "$BIN"
git init -q "$PRIMARY"
git -C "$PRIMARY" -c user.name=Fixture -c user.email=fixture@example.invalid \
  commit --allow-empty -qm fixture
git -C "$PRIMARY" worktree add --quiet --detach "$WORKTREE"
mkdir -p "$WORKTREE/scripts/minikube"
cp "$ROOT/scripts/minikube/apply-llm-secret.sh" \
  "$ROOT/scripts/minikube/host-model.sh" "$ROOT/scripts/minikube/llm-catalog-runs.sh" \
  "$WORKTREE/scripts/minikube/"

cat >"$PRIMARY/.env" <<'ENV'
GROQ_API_KEY=fixture-canonical-value
printf 'sourced\n' > "$FIXTURE_MARKER"
ENV
cat >"$TMP/explicit.env" <<'ENV'
GROQ_API_KEY=fixture-explicit-value
printf 'sourced\n' > "$FIXTURE_MARKER"
ENV

cat >"$BIN/kubectl" <<'STUB'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$@" >> "$FIXTURE_ARGS"
case " $* " in
  *' create secret generic '*) printf '{}\n' ;;
  *' apply -f - '*)
    cat > "$FIXTURE_SECRET"
    [[ "${FIXTURE_APPLY_FAIL:-false}" != true ]] || exit 1
    printf 'secret/chatllm-api-keys configured\n'
    ;;
  *) exit 1 ;;
esac
STUB
cat >"$BIN/base64" <<'STUB'
#!/bin/bash
set -euo pipefail
: >> "$FIXTURE_ENCODER_ARGS"
for argument in "$@"; do printf '%s\n' "$argument" >> "$FIXTURE_ENCODER_ARGS"; done
exec "$FIXTURE_BASE64" "$@"
STUB
chmod +x "$BIN/kubectl" "$BIN/base64"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
run_case() {
  local name="$1"; shift
  CASE_DIR="$TMP/$name"
  mkdir -p "$CASE_DIR"
  env -i HOME="$TMP" PATH="$BIN:$PATH" \
    FIXTURE_MARKER="$CASE_DIR/marker" FIXTURE_ARGS="$CASE_DIR/args" \
    FIXTURE_SECRET="$CASE_DIR/secret.json" FIXTURE_BASE64="$BASE64" \
    FIXTURE_ENCODER_ARGS="$CASE_DIR/encoder-args" "$@" \
    "$TEST_BASH" "$WORKTREE/scripts/minikube/apply-llm-secret.sh" \
    >"$CASE_DIR/output" 2>&1
}

if ! run_case isolated E2E_DISABLE_CANONICAL_DOTENV=true; then
  cat "$CASE_DIR/output" >&2
  fail 'isolated helper failed before the isolation assertion'
fi
[ ! -e "$CASE_DIR/marker" ] || fail 'isolated mode sourced the primary fixture file'
jq -e '.apiVersion == "v1" and .kind == "Secret" and .type == "Opaque" and
  .metadata.name == "chatllm-api-keys" and .metadata.namespace == "mcp-host" and
  ((.data | keys | sort) == ["bailian-api-key", "claude-api-key", "openai-api-key", "zai-api-key"]) and
  ([.data[] | length > 0] | all)' "$CASE_DIR/secret.json" >/dev/null ||
  fail 'isolated mode did not retain the four default slots'
! grep -Fq -- '--from-literal=' "$CASE_DIR/args" || fail 'a Secret value was placed in arguments'
printf 'PASS: isolated mode ignores the primary file and preserves default slots\n'

run_case isolated-override E2E_DISABLE_CANONICAL_DOTENV=true \
  LLM_SECRET_ENV_FILE="$TMP/explicit.env" || fail 'isolated override case failed'
[ ! -e "$CASE_DIR/marker" ] || fail 'isolated mode sourced an explicit file override'
jq -e '.data | has("groq-api-key") | not' "$CASE_DIR/secret.json" >/dev/null ||
  fail 'isolated mode imported an explicit fixture file'
printf 'PASS: isolated mode ignores an explicit file override\n'

printf -v multiline '%s\n%s\n\n' '{"fixture":"first=value"}' 'second line'
printf '%s' "$multiline" > "$TMP/expected-multiline"
run_case isolated-process E2E_DISABLE_CANONICAL_DOTENV=true \
  OPENAI_API_KEY=fixture-process-value VERTEX_SERVICE_ACCOUNT_JSON="$multiline" ||
  fail 'isolated process values failed'
jq -r '.data["vertex-service-account-json"]' "$CASE_DIR/secret.json" |
  base64 -d > "$CASE_DIR/actual-multiline"
cmp -s "$TMP/expected-multiline" "$CASE_DIR/actual-multiline" ||
  fail 'multiline value or trailing newlines changed'
printf '%s' 'fixture-process-value' > "$TMP/expected-process"
jq -r '.data["openai-api-key"]' "$CASE_DIR/secret.json" | base64 -d > "$CASE_DIR/actual-process"
cmp -s "$TMP/expected-process" "$CASE_DIR/actual-process" || fail 'process value changed'
! grep -Fq 'fixture-process-value' "$CASE_DIR/args" || fail 'process value appeared in arguments'
! grep -Fq -- '--from-literal=' "$CASE_DIR/args" || fail 'encoded value appeared in arguments'
encoded_fixture="$(printf '%s' 'fixture-process-value' | "$BASE64" | tr -d '\n')"
! grep -Fq "$encoded_fixture" "$CASE_DIR/args" || fail 'encoded value appeared in client arguments'
[ ! -s "$CASE_DIR/encoder-args" ] || fail 'a value appeared in encoder arguments'
printf 'PASS: process values are preserved byte-for-byte and stay out of arguments\n'

for mode in absent false; do
  if [ "$mode" = absent ]; then
    run_case "normal-$mode" || fail 'normal canonical resolution failed'
  else
    run_case "normal-$mode" E2E_DISABLE_CANONICAL_DOTENV=false || fail 'false isolation mode failed'
  fi
  [ -e "$CASE_DIR/marker" ] || fail 'normal mode did not source the primary fixture file'
  printf '%s' 'fixture-canonical-value' > "$TMP/expected-canonical"
  jq -r '.data["groq-api-key"]' "$CASE_DIR/secret.json" | base64 -d > "$CASE_DIR/actual"
  cmp -s "$TMP/expected-canonical" "$CASE_DIR/actual" || fail 'canonical value changed'
done
printf 'PASS: normal modes retain canonical worktree resolution\n'

run_case explicit LLM_SECRET_ENV_FILE="$TMP/explicit.env" || fail 'explicit override failed'
[ -e "$CASE_DIR/marker" ] || fail 'normal mode did not source the explicit fixture file'
printf '%s' 'fixture-explicit-value' > "$TMP/expected-explicit"
jq -r '.data["groq-api-key"]' "$CASE_DIR/secret.json" | base64 -d > "$CASE_DIR/actual"
cmp -s "$TMP/expected-explicit" "$CASE_DIR/actual" || fail 'explicit override lost precedence'
printf 'PASS: normal mode retains explicit file precedence\n'

if run_case apply-fails E2E_DISABLE_CANONICAL_DOTENV=true FIXTURE_APPLY_FAIL=true; then
  fail 'a failed Secret apply was reported as successful'
fi
printf 'PASS: a failed Secret apply propagates failure\n'
