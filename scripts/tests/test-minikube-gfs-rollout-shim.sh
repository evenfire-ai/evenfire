#!/usr/bin/env bash
# Stubbed contract for scripts/minikube/gfs-rollout-shim/kubectl and
# scripts/minikube/wait-gfs-reader-ready.sh: the shim passes every ordinary
# kubectl invocation through unchanged and replaces only the gfsc-reader
# `rollout status` wait with a readiness poll that ignores the template
# generation HCC's gfsReconciler keeps rewriting.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHIM="$ROOT/scripts/minikube/gfs-rollout-shim/kubectl"
WAIT="$ROOT/scripts/minikube/wait-gfs-reader-ready.sh"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

bash -n "$SHIM"
bash -n "$WAIT"

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

# Fake "real" kubectl the shim must fall through to.
mkdir -p "$tmp/realbin"
cat >"$tmp/realbin/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE_KUBECTL_LOG:?}"
case " $* " in
  *' get deployment gfsc-reader '*'-o jsonpath={.spec.replicas}'*)
    printf '%s' "${FAKE_DESIRED:-1}"; exit 0 ;;
  *' get deployment gfsc-reader '*'-o jsonpath={.status.readyReplicas}'*)
    printf '%s' "${FAKE_READY:-1}"; exit 0 ;;
  *' get pods -l '*)
    printf '%b' "${FAKE_POD_ROWS:-True|\n}"; exit 0 ;;
esac
exit 0
STUB
chmod +x "$tmp/realbin/kubectl"

export FAKE_KUBECTL_LOG="$tmp/kubectl.log"
shim_path="$(dirname "$SHIM"):$tmp/realbin:/usr/bin:/bin"

# 1. Ordinary invocations pass through to the real kubectl unchanged.
: >"$FAKE_KUBECTL_LOG"
PATH="$shim_path" kubectl --context=fake -n gfs get secret whatever >/dev/null
grep -q -- '--context=fake -n gfs get secret whatever' "$FAKE_KUBECTL_LOG" \
  || fail 'shim did not pass an ordinary invocation through to the real kubectl'

# 2. A rollout status on another deployment also passes through.
: >"$FAKE_KUBECTL_LOG"
PATH="$shim_path" kubectl --context=fake -n gfs rollout status deployment/gfsc-writer --timeout=1s >/dev/null
grep -q 'rollout status deployment/gfsc-writer' "$FAKE_KUBECTL_LOG" \
  || fail 'shim intercepted a non-reader rollout status'

# 3. The reader rollout status is intercepted and succeeds on readiness
# without calling the real `rollout status` at all.
: >"$FAKE_KUBECTL_LOG"
out="$(PATH="$shim_path" FAKE_DESIRED=1 FAKE_READY=1 FAKE_POD_ROWS='True|\n' \
  GFS_READER_WAIT_POLL_SECONDS=0 \
  kubectl --context=fake rollout status deployment/gfsc-reader -n gfs --timeout=240s 2>&1)" \
  || fail 'shim readiness wait failed on a Ready reader'
grep -q 'gfs-rollout-shim' <<<"$out" || fail 'shim did not announce the readiness wait'
grep -q 'rollout status deployment/gfsc-reader' "$FAKE_KUBECTL_LOG" \
  && fail 'shim leaked the generation-based rollout status to the real kubectl'

# 4. A live unready reader pod blocks the wait until timeout (fail-loud).
: >"$FAKE_KUBECTL_LOG"
if PATH="$shim_path" FAKE_DESIRED=1 FAKE_READY=1 FAKE_POD_ROWS='True|\nFalse|\n' \
  GFS_ROLLOUT_SHIM_MIN_TIMEOUT_SECONDS=1 GFS_READER_WAIT_POLL_SECONDS=0 \
  kubectl --context=fake rollout status deployment/gfsc-reader -n gfs --timeout=1s 2>/dev/null; then
  fail 'shim readiness wait went green with a live unready reader pod'
fi

# Timeout input is untrusted process input; it must be parsed as data rather
# than reaching Bash arithmetic evaluation.
malicious_timeout="1; touch $tmp/timeout-pwned"
if PATH="$shim_path" FAKE_DESIRED=1 FAKE_READY=1 FAKE_POD_ROWS='True|\n' \
  GFS_READER_WAIT_POLL_SECONDS=0 \
  kubectl --context=fake rollout status deployment/gfsc-reader -n gfs --timeout="$malicious_timeout" >/dev/null 2>&1; then
  fail 'shim accepted a malformed rollout timeout'
fi
[ ! -e "$tmp/timeout-pwned" ] || fail 'malformed rollout timeout executed shell input'
if PATH="$shim_path" CONTEXT=fake GFS_READER_WAIT_TIMEOUT_SECONDS="$malicious_timeout" \
  bash "$WAIT" >/dev/null 2>&1; then
  fail 'direct readiness helper accepted a malformed timeout'
fi

# 5. A terminating unready pod does not block the wait.
: >"$FAKE_KUBECTL_LOG"
PATH="$shim_path" FAKE_DESIRED=1 FAKE_READY=1 \
  FAKE_POD_ROWS='True|\nFalse|2026-01-01T00:00:00Z\n' \
  GFS_READER_WAIT_POLL_SECONDS=0 \
  kubectl --context=fake rollout status deployment/gfsc-reader -n gfs --timeout=240s >/dev/null 2>&1 \
  || fail 'shim readiness wait blocked on a terminating pod'

printf 'PASS: gfs-rollout-shim readiness interception contract\n'
