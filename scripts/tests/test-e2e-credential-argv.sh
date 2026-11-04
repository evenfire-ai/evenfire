#!/usr/bin/env bash
# Credentials of the RPC gateway Host-path journey never reach argv, where any
# local user can read them with ps.
#   Static: the journey, its HTTP helper and the #825 reference helper put no
#   password, token or secret variable into jq --arg, a curl Authorization
#   header, curl data options or curl --user, in any spelling ($VAR or ${VAR},
#   short or long option, space or `=`).
#   Behaviour: http_call sends the body on stdin and the bearer on fd 3, starts
#   curl with -q, and sets HTTP_STATUS and HTTP_BODY in the caller's shell.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
HELPER="$ROOT/scripts/e2e/e2e-rpc-http-lib.sh"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# ─── Static ────────────────────────────────────────────────────────────
files=(
  "$ROOT/scripts/e2e/e2e-rpc-gateway-host-paths.sh"
  "$HELPER"
  "$ROOT/scripts/e2e/e2e-825-lib.sh"
)
secret_var='\$\{?[A-Za-z_][A-Za-z0-9_]*(PASSWORD|TOKEN|SECRET)'
rules=(
  "--arg[[:space:]]+[^[:space:]]+[[:space:]]+\"?\\\$\\{?[A-Za-z_][A-Za-z0-9_]*PASSWORD"
  '(-H|--header)([[:space:]]+|=)"?Authorization:[[:space:]]*Bearer[[:space:]]+\$'
  "(-d|--data|--data-raw|--data-binary|--data-ascii|--data-urlencode|--json)([[:space:]]+|=)(\"[^\"]*|[^[:space:]]*)${secret_var}"
  '--user([[:space:]]+|=)[^[:space:]]*\$'
)
grep_rules=()
for rule in "${rules[@]}"; do grep_rules+=(-e "$rule"); done
scanned=0
violations=0
for file in "${files[@]}"; do
  [ -f "$file" ] || fail "scanned file is missing: $file"
  # Liveness witness: every scanned file sends its data through an approved
  # transport (or the helper that does), so an empty or unrelated file cannot
  # pass the scan.
  grep -Eq -e '--data-binary @-' -e '-H "@' -e '-H @/dev/fd/3' -e 'e2e-rpc-http-lib\.sh"' "$file" \
    || fail "no stdin body or header-file transport in $file"
  while IFS= read -r hit; do
    printf 'CREDENTIAL_ARGV_VIOLATION %s:%s\n' "${file#"$ROOT"/}" "$hit" >&2
    violations=$((violations + 1))
  done < <(grep -nE "${grep_rules[@]}" "$file" | cut -d: -f1)
  scanned=$((scanned + 1))
done
[ "$scanned" -eq 3 ] || fail "expected 3 scanned files, scanned $scanned"
[ "$violations" -eq 0 ] || fail "$violations credential argv line(s) found"
echo "STATIC_PASS files=$scanned rules=${#rules[@]} violations=0"

# ─── Behaviour ─────────────────────────────────────────────────────────
tmp="$(mktemp -d "${TMPDIR:-/tmp}/e2e-credential-argv.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
mkdir -p "$tmp/bin" "$tmp/stub"
cat >"$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
calls=0
[ ! -f "$STUB_DIR/calls" ] || calls="$(cat "$STUB_DIR/calls")"
calls=$((calls + 1))
printf '%s' "$calls" >"$STUB_DIR/calls"
printf '%s\n' "$@" >"$STUB_DIR/argv.$calls"
for arg in "$@"; do
  if [ "$arg" = '@/dev/fd/3' ]; then cat /dev/fd/3 >"$STUB_DIR/header.$calls"; fi
done
cat >"$STUB_DIR/stdin.$calls"
case "$calls" in
  1) printf '{"call":1}\n200' ;;
  *) printf '{"call":2}\n503' ;;
esac
EOF
chmod 0755 "$tmp/bin/curl"

body1='{"email":"user@example.invalid","password":"synthetic-first-body"}'
body2='{"content":"synthetic-second-body"}'
bearer2='synthetic-bearer-two'
if ! PATH="$tmp/bin:$PATH" STUB_DIR="$tmp/stub" BODY1="$body1" BODY2="$body2" BEARER2="$bearer2" bash -c '
  set -euo pipefail
  call_budget() { printf "%s\n" "$1"; }
  source "$1"
  HTTP_STATUS=before HTTP_BODY=before
  http_call first 10 "$BODY1" "" -X POST http://stub.invalid/first
  printf "status1=%s\nbody1=%s\n" "$HTTP_STATUS" "$HTTP_BODY"
  http_call second 10 "$BODY2" "$BEARER2" -X POST http://stub.invalid/second
  printf "status2=%s\nbody2=%s\n" "$HTTP_STATUS" "$HTTP_BODY"
' bash "$HELPER" >"$tmp/behaviour.out" 2>"$tmp/behaviour.err"; then
  cat "$tmp/behaviour.err" >&2
  fail 'http_call failed against the curl stub'
fi
curl_calls="$(cat "$tmp/stub/calls" 2>/dev/null || printf 0)"
# Liveness witness: the stub ran once per call.
[ "$curl_calls" = 2 ] || fail "expected 2 curl invocations, got $curl_calls"
grep -Fxq 'status1=200' "$tmp/behaviour.out" || fail "first call left HTTP_STATUS: $(cat "$tmp/behaviour.out")"
grep -Fxq 'body1={"call":1}' "$tmp/behaviour.out" || fail 'first call left a stale HTTP_BODY'
grep -Fxq 'status2=503' "$tmp/behaviour.out" || fail "second call left HTTP_STATUS: $(cat "$tmp/behaviour.out")"
grep -Fxq 'body2={"call":2}' "$tmp/behaviour.out" || fail 'second call left a stale HTTP_BODY'
[ "$(cat "$tmp/stub/stdin.1")" = "$body1" ] || fail 'first body did not arrive on stdin'
[ "$(cat "$tmp/stub/stdin.2")" = "$body2" ] || fail 'second body did not arrive on stdin'
[ "$(cat "$tmp/stub/header.2" 2>/dev/null)" = "Authorization: Bearer $bearer2" ] \
  || fail 'the bearer did not arrive as a header on fd 3'
[ ! -e "$tmp/stub/header.1" ] || fail 'a call without a bearer sent an Authorization header'
for n in 1 2; do
  [ "$(head -n1 "$tmp/stub/argv.$n")" = '-q' ] || fail "call $n did not start curl with -q (curlrc would load)"
  grep -Fxq -- '--data-binary' "$tmp/stub/argv.$n" || fail "call $n did not read its body from stdin"
  if grep -Fq 'synthetic-' "$tmp/stub/argv.$n"; then
    fail "call $n carried its body or bearer in argv"
  fi
done
echo "BEHAVIOR_PASS status1=200 status2=503 bearer_on_fd3=1 curl_calls=$curl_calls"
