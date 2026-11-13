#!/usr/bin/env bash
# Stubbed contract for scripts/minikube/gfs-rollout-shim/kubectl and
# scripts/minikube/wait-gfs-reader-ready.sh: the shim passes every ordinary
# kubectl invocation through unchanged and replaces only the gfsc-reader
# `rollout status` wait with a poll that proves the current revision is fully
# rolled out: the controller observed the restart, every replica belongs to the
# newest ReplicaSet, and no live reader pod is unready.
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
# Snapshot fields: generation|observedGeneration|spec.replicas|status.replicas|
# updatedReplicas|readyReplicas. Status fields are omitempty on the API server,
# so tests pass an explicitly empty value for the real "field absent" case.
desired="${FAKE_DESIRED:-1}"
snapshot="${FAKE_GENERATION-5}|${FAKE_OBSERVED-5}|${desired}|${FAKE_REPLICAS-$desired}|${FAKE_UPDATED-$desired}|${FAKE_READY-1}"
pod_rows="${FAKE_POD_ROWS-True|\n}"
# FAKE_SEQUENCE names a file with one `snapshot;pod rows` line per poll. Every
# read of the Deployment advances one line; the last line repeats.
if [ -n "${FAKE_SEQUENCE:-}" ]; then
  poll="$(cat "${FAKE_SEQUENCE}.polls" 2>/dev/null || printf 0)"
  case " $* " in
    *' get deployment gfsc-reader '*'.spec.replicas'*)
      poll=$((poll + 1))
      printf '%s' "$poll" >"${FAKE_SEQUENCE}.polls"
      ;;
  esac
  line="$(sed -n "${poll}p" "$FAKE_SEQUENCE")"
  [ -n "$line" ] || line="$(tail -n 1 "$FAKE_SEQUENCE")"
  snapshot="${line%%;*}"
  pod_rows="${line#*;}"
fi
# Render the requested jsonpath from named fields, as the API server would, so
# a wrong field or field order in the wait returns wrong values here too.
render_deployment_jsonpath() {
  local rest="$1" token generation observed spec_replicas replicas updated ready
  IFS='|' read -r generation observed spec_replicas replicas updated ready <<<"$snapshot"
  while [ -n "$rest" ]; do
    case "$rest" in
      '{'*) ;;
      *) printf 'unexpected jsonpath literal: %s\n' "$rest" >&2; exit 98 ;;
    esac
    token="${rest%%\}*}"
    token="${token#\{}"
    rest="${rest#*\}}"
    case "$token" in
      '"|"') printf '|' ;;
      .metadata.generation) printf '%s' "$generation" ;;
      .status.observedGeneration) printf '%s' "$observed" ;;
      .spec.replicas) printf '%s' "$spec_replicas" ;;
      .status.replicas) printf '%s' "$replicas" ;;
      .status.updatedReplicas) printf '%s' "$updated" ;;
      .status.readyReplicas) printf '%s' "$ready" ;;
      *) printf 'unexpected jsonpath field: %s\n' "$token" >&2; exit 98 ;;
    esac
  done
}
case " $* " in
  *' get deployment gfsc-reader '*)
    if [ "${FAKE_FAIL_READ:-}" = deployment ]; then
      printf 'simulated API error\n' >&2
      exit 1
    fi
    for arg in "$@"; do
      case "$arg" in
        jsonpath=*) render_deployment_jsonpath "${arg#jsonpath=}"; exit 0 ;;
      esac
    done
    printf 'wait read the Deployment without a jsonpath: %s\n' "$*" >&2
    exit 98
    ;;
  *' get pods -l '*)
    if [ "${FAKE_FAIL_READ:-}" = pods ]; then
      printf 'simulated API error\n' >&2
      exit 1
    fi
    printf '%b' "$pod_rows"; exit 0 ;;
esac
exit 0
STUB
chmod +x "$tmp/realbin/kubectl"

export FAKE_KUBECTL_LOG="$tmp/kubectl.log"
shim_path="$(dirname "$SHIM"):$tmp/realbin:/usr/bin:/bin"

# Two active worktrees can each prepend their own copy of the development
# shim. Both copies must skip the other harness directory and reach kubectl.
second_shim_dir="$tmp/second-worktree/scripts/minikube/gfs-rollout-shim"
mkdir -p "$second_shim_dir"
cp "$SHIM" "$second_shim_dir/kubectl"
chmod +x "$second_shim_dir/kubectl"
chain_shim_path="$second_shim_dir:$(dirname "$SHIM"):$tmp/realbin:/usr/bin:/bin"

: >"$FAKE_KUBECTL_LOG"
PATH="$chain_shim_path" kubectl --context=fake -n gfs get secret chain-check >/dev/null
grep -q -- '--context=fake -n gfs get secret chain-check' "$FAKE_KUBECTL_LOG" \
  || fail 'two shim copies did not reach the real kubectl binary'

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

for duration in 2m30s 500ms; do
  PATH="$shim_path" FAKE_DESIRED=1 FAKE_READY=1 FAKE_POD_ROWS='True|\n' \
    GFS_READER_WAIT_POLL_SECONDS=0 \
    kubectl --context=fake rollout status deployment/gfsc-reader -n gfs --timeout="$duration" >/dev/null 2>&1 \
    || fail "shim rejected valid Go duration ${duration}"
done

# 4. A live unready reader pod blocks the wait until timeout (fail-loud).
# The explicit 1s caller timeout is honored; the shim must not silently floor
# it to an unrelated minimum.
: >"$FAKE_KUBECTL_LOG"
if out="$(PATH="$shim_path" FAKE_DESIRED=1 FAKE_READY=1 FAKE_POD_ROWS='True|\nFalse|\n' \
  GFS_READER_WAIT_POLL_SECONDS=0 \
  kubectl --context=fake rollout status deployment/gfsc-reader -n gfs --timeout=1s 2>&1)"; then
  fail 'shim readiness wait went green with a live unready reader pod'
fi
grep -q 'timed out after' <<<"$out" || fail "live unready pod blocked for the wrong reason: $out"

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

# A terminating Ready pod must not satisfy the desired live-reader count. It
# is already leaving the service and cannot be used as readiness evidence.
if out="$(PATH="$shim_path" FAKE_DESIRED=1 FAKE_READY=1 \
  FAKE_POD_ROWS='True|2026-01-01T00:00:00Z\n' \
  GFS_READER_WAIT_POLL_SECONDS=0 \
  kubectl --context=fake rollout status deployment/gfsc-reader -n gfs --timeout=1s 2>&1)"; then
  fail 'shim readiness wait went green with only a terminating Ready reader pod'
fi
grep -q 'timed out after' <<<"$out" || fail "terminating pod blocked for the wrong reason: $out"

# 6. A rollout passes only when it has finished. These states follow a restart
# of a two-replica reader whose old pods stay Ready throughout:
#   poll 1: restart written, controller has not observed it
#   poll 2: controller observed it, newest ReplicaSet has no pod yet, so the API
#           omits updatedReplicas (the state behind the dev deploy failure)
#   poll 3: first new pod exists and is unready
#   poll 4: both new pods Ready, one old pod not scaled down yet
#   poll 5: rollout finished
sequence="$tmp/rollout.sequence"
cat >"$sequence" <<'SEQ'
6|5|2|2|2|2;True|\nTrue|\n
6|6|2|2||2;True|\nTrue|\n
6|6|2|3|1|2;True|\nTrue|\nFalse|\n
6|6|2|3|2|3;True|\nTrue|\nTrue|\n
6|6|2|2|2|2;True|\nTrue|\n
SEQ
: >"$FAKE_KUBECTL_LOG"
out="$(PATH="$shim_path" FAKE_SEQUENCE="$sequence" GFS_READER_WAIT_POLL_SECONDS=0 \
  kubectl --context=fake rollout status deployment/gfsc-reader -n gfs --timeout=30s 2>&1)" \
  || fail "wait did not pass on the finished rollout: $out"
polls="$(cat "${sequence}.polls")"
[ "$polls" -eq 5 ] || fail "wait passed at poll ${polls} of 5, before the rollout finished"
grep -q 'is Ready' <<<"$out" || fail "wait exited 0 without its Ready verdict: $out"

# 7. Each unfinished state alone blocks until the deadline. The timeout message
# is the witness that the poll loop ran and judged the state.
assert_blocks() {
  local label="$1" generation="$2" observed="$3" replicas="$4" updated="$5" ready="$6" rows="$7" state_out
  if state_out="$(PATH="$shim_path" FAKE_DESIRED=2 FAKE_GENERATION="$generation" \
    FAKE_OBSERVED="$observed" FAKE_REPLICAS="$replicas" FAKE_UPDATED="$updated" FAKE_READY="$ready" \
    FAKE_POD_ROWS="$rows" GFS_READER_WAIT_POLL_SECONDS=0 \
    kubectl --context=fake rollout status deployment/gfsc-reader -n gfs --timeout=1s 2>&1)"; then
    fail "wait went green on ${label}"
  fi
  grep -q 'timed out after' <<<"$state_out" || fail "${label} blocked for the wrong reason: ${state_out}"
}
assert_blocks 'an unobserved restart' 6 5 2 2 2 'True|\nTrue|\n'
assert_blocks 'an unobserved restart with no observedGeneration' 6 '' 2 2 2 'True|\nTrue|\n'
assert_blocks 'a rollout whose new pod does not exist yet' 6 6 2 '' 2 'True|\nTrue|\n'
assert_blocks 'a partial rollout' 6 6 2 1 2 'True|\nTrue|\n'
assert_blocks 'a live old replica' 6 6 3 2 3 'True|\nTrue|\nTrue|\n'
assert_blocks 'a reader whose pods all crash, with status counts omitted' 6 6 '' 2 '' 'False|\nFalse|\n'
assert_blocks 'a reader with every status count omitted' 6 6 '' '' '' ''

# A suspended reader has nothing to prove and must not pass as "Ready (0/0)".
if out="$(PATH="$shim_path" FAKE_DESIRED=0 FAKE_READY=0 FAKE_POD_ROWS='' GFS_READER_WAIT_POLL_SECONDS=0 \
  kubectl --context=fake rollout status deployment/gfsc-reader -n gfs --timeout=1s 2>&1)"; then
  fail 'wait went green on a reader with zero desired replicas'
fi
grep -q 'timed out after' <<<"$out" || fail "zero desired replicas blocked for the wrong reason: $out"

# A failed read stops the wait. It must never count as a passed rollout.
if out="$(PATH="$shim_path" FAKE_FAIL_READ=deployment GFS_READER_WAIT_POLL_SECONDS=0 \
  kubectl --context=fake rollout status deployment/gfsc-reader -n gfs --timeout=30s 2>&1)"; then
  fail 'wait went green when the Deployment read failed'
fi
grep -q 'unable to read rollout status' <<<"$out" || fail "Deployment read failure not reported: $out"
if out="$(PATH="$shim_path" FAKE_FAIL_READ=pods GFS_READER_WAIT_POLL_SECONDS=0 \
  kubectl --context=fake rollout status deployment/gfsc-reader -n gfs --timeout=30s 2>&1)"; then
  fail 'wait went green when the pod listing failed'
fi
grep -q 'unable to inspect reader pods' <<<"$out" || fail "pod listing failure not reported: $out"

# 8. A malformed snapshot fails at once instead of being read as "not ready".
malformed_seq="$tmp/malformed.sequence"
for malformed in 'x|6|2|2|2|2' '|6|2|2|2|2' '6|x|2|2|2|2' '6|6||2|2|2' '6|6|2|x|2|2' '6|6|2|2|x|2' '6|6|2|2|2|x'; do
  printf '0' >"${malformed_seq}.polls"
  printf '%s;True|\\nTrue|\\n\n' "$malformed" >"$malformed_seq"
  if out="$(PATH="$shim_path" FAKE_SEQUENCE="$malformed_seq" GFS_READER_WAIT_POLL_SECONDS=0 \
    kubectl --context=fake rollout status deployment/gfsc-reader -n gfs --timeout=30s 2>&1)"; then
    fail "wait accepted the malformed snapshot ${malformed}"
  fi
  grep -q 'not numeric' <<<"$out" || fail "malformed snapshot ${malformed} failed for the wrong reason: $out"
done

printf 'PASS: gfs-rollout-shim readiness interception contract\n'
