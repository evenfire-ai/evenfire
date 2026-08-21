#!/usr/bin/env bash
# Stubbed contract for scripts/minikube/settle-gfs-reader-rollout.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/minikube/settle-gfs-reader-rollout.sh"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

bash -n "$SCRIPT"
grep -Fq 'if [ "${#scaled_rs_names[@]}" -gt 0 ]; then' "$SCRIPT" ||
  fail 'settle must guard empty ReplicaSet arrays under Bash 3.2 set -u'
grep -Fq 'if [ -n "${ALLOWED_CONTEXTS:-}" ]; then' "$SCRIPT" ||
  fail 'settle must guard empty authorization-context arrays under Bash 3.2 set -u'
grep -Fq 'unable to inspect ${GFS_NS} ReplicaSets before reader settlement' "$SCRIPT" ||
  fail 'settle must report ReplicaSet inspection failures instead of swallowing kubectl stderr'
grep -Fq 'unable to inspect ${GFS_NS} reader pods before crash-loop cleanup' "$SCRIPT" ||
  fail 'settle must report reader-pod inspection failures instead of swallowing kubectl stderr'

run_settle() {
  local fake_dir repo profile sha
  fake_dir="$(mktemp -d)"
  repo="$fake_dir/repo"
  profile='clerum-settle-gfs-reader'
  mkdir -p "$repo" "$fake_dir/profiles/$profile" "$fake_dir/locks" "$fake_dir/evidence"
  repo="$(cd "$repo" && pwd -P)"
  git init -q -b dev "$repo" >/dev/null
  git -C "$repo" config user.email test@example.invalid
  git -C "$repo" config user.name settle-test
  printf 'settle fixture\n' >"$repo/README"
  git -C "$repo" add README >/dev/null
  git -C "$repo" commit -q -m fixture >/dev/null
  git -C "$repo" remote add origin https://github.com/evenfire-ai/evenfire.git
  git -C "$repo" switch -c feat/settle-gfs-reader >/dev/null
  git -C "$repo" update-ref refs/remotes/origin/dev HEAD
  sha="$(git -C "$repo" rev-parse --short HEAD)"
  cat >"$fake_dir/profiles/$profile/profile.env" <<EOF
PROFILE=$profile
REPO_DIR=$repo
BRANCH=feat/settle-gfs-reader
SHA_SHORT=$sha
DIRTY=false
EOF
  printf 'PORT_BASE=23457\n' >"$fake_dir/profiles/$profile/ports.env"
  cat >"$fake_dir/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE_KUBECTL_LOG:?}"
case " $* " in
  *' config get-contexts -o name'*)
    printf '%s' "${T2_CONTEXT:?}"; exit 0 ;;
  *' config view '* )
    printf 'https://%s:6443' '127.0.0.1'; exit 0 ;;
  *' get deployment gfsc-reader '*'-o jsonpath={.spec.replicas}'*)
    printf '%s' "${FAKE_DESIRED:-1}"; exit 0 ;;
  *' get deployment gfsc-reader '*'-o jsonpath={.status.readyReplicas}'*)
    printf '%s' "${FAKE_READY:-1}"; exit 0 ;;
  *' get deployment gfsc-reader '*gfs-template-hash*)
    printf '%s' 'template-42'; exit 0 ;;
  *' get deployment gfsc-reader '*jsonpath={.metadata.generation}*)
    printf '%s' '2'; exit 0 ;;
  *' get deployment gfsc-reader '*jsonpath={.status.observedGeneration}*)
    printf '%s' '2'; exit 0 ;;
  *' get deployment gfsc-reader '*jsonpath={range*)
    printf '%s\n' 'gfs-controller-reader-db'; exit 0 ;;
  *' get deployment gfsc-reader '*revision*)
    printf '%s' "${FAKE_REVISION:-19}"; exit 0 ;;
  *' get deployment gfsc-reader'*)
    [ "${FAKE_DEPLOY_EXISTS:-1}" = 1 ] || exit 1
    exit 0 ;;
  *' get rs -l '*)
    printf '%b' "${FAKE_RS_ROWS:-}"; exit 0 ;;
  *' get rs gfsc-reader-stale '*'.spec.replicas'*)
    [ -s "${FAKE_SCALE_FILE:?}" ] && printf '0' || printf '1'; exit 0 ;;
  *' get rs gfsc-reader-proof-rs '*revision*)
    printf '%s' "${FAKE_REVISION:-19}"; exit 0 ;;
  *' scale rs '*)
    printf '%s' "${4:-gfsc-reader-stale}" >"${FAKE_SCALE_FILE:?}"
    exit 0 ;;
  *' get pods -l '*gfs-template-hash*)
    printf '%b' "${FAKE_PROOF_POD_ROWS:-gfsc-reader-proof|2026-01-02T00:00:01Z|True||gfsc-reader-proof-rs|}"; exit 0 ;;
  *' get pods -l '*)
    printf '%b' "${FAKE_POD_ROWS:-}"; exit 0 ;;
  *' delete pod '*)
    exit 0 ;;
  *' get secret gfs-controller-reader-db '*gfs-dsn-state*)
    printf '%s' "${FAKE_STATE:-rollout-running}"; exit 0 ;;
  *' get secret gfs-controller-reader-db '*gfs-dsn-rotated-at*)
    printf '%s' "${FAKE_ROTATED:-2026-01-01T00:00:00Z}"; exit 0 ;;
  *' get secret gfs-controller-reader-db '*jsonpath={.metadata.resourceVersion}*)
    printf '%s' '42'; exit 0 ;;
  *' get secret gfs-controller-reader-db '*'-o json'*)
    python3 - <<'PY'
import base64
import json
import os
print(json.dumps({
    "metadata": {"resourceVersion": "42"},
    "data": {"connection-string": base64.b64encode(os.environ["FAKE_DSN"].encode()).decode()},
}))
PY
    exit 0 ;;
  *' get secret gfs-controller-reader-db'*)
    [ "${FAKE_SECRET_EXISTS:-1}" = 1 ] || exit 1
    exit 0 ;;
  *' exec '*)
    input="$(cat)"
    [ "$input" = "${FAKE_DSN:?}" ] || exit 1
    exit 0 ;;
  *' patch secret gfs-controller-reader-db'*)
    cat >"${FAKE_PATCH_LOG:?}"
    [ "${FAKE_PATCH_OK:-1}" = 1 ] || exit 1
    exit 0 ;;
esac
exit 1
STUB
  chmod +x "$fake_dir/kubectl"
  local status=0
  : >"$fake_dir/scaled-rs"
  PATH="$fake_dir:$PATH" CONTEXT="$profile" \
    T2_LOCK_TOKEN=settle-test-token \
    T2_PROJECT_DIR="$repo" T2_PROFILE="$profile" T2_CONTEXT="$profile" \
    MINIKUBE_PROFILE="$profile" CONTROL_API_REAL_PG_CONTEXT="$profile" \
    T2_PROFILE_ROOT="$fake_dir/profiles" T2_PROFILE_ENV="$fake_dir/profiles/$profile/profile.env" \
    T2_PORTS_ENV="$fake_dir/profiles/$profile/ports.env" \
    T2_LOCK_ROOT="$fake_dir/locks" T2_EVIDENCE_ROOT="$fake_dir/evidence" \
    T2_GATE_ID=settle-gfs-reader-test T2_RUN_ID=settle-test-run \
    FAKE_KUBECTL_LOG="$fake_dir/kubectl.log" \
    FAKE_PATCH_LOG="$fake_dir/patch.json" FAKE_DSN=dsn-value \
    FAKE_SCALE_FILE="$fake_dir/scaled-rs" \
    FAKE_DEPLOY_EXISTS="${1:-1}" \
    FAKE_DESIRED="${2:-1}" \
    FAKE_READY="${3:-1}" \
    FAKE_SECRET_EXISTS="${4:-1}" \
    FAKE_STATE="${5:-rollout-running}" \
    FAKE_ROTATED="${6:-2026-01-01T00:00:00Z}" \
    FAKE_PATCH_OK="${7:-1}" \
    FAKE_RS_ROWS="${8:-}" \
    FAKE_POD_ROWS="${9:-}" \
    FAKE_REVISION="${10:-19}" \
    FAKE_PROOF_POD_ROWS="${11:-}" \
    bash "$SCRIPT" || status=$?
  printf '%s' "$fake_dir"
  return "$status"
}

dir="$(run_settle 1 1 1 1 rollout-running '2026-01-01T00:00:00Z' 1)"
grep -q 'patch secret gfs-controller-reader-db' "$dir/kubectl.log" \
  || fail 'Ready leftover claim did not patch the reader Secret to ready'
grep -q 'gfs-dsn-proof-kind' "$dir/patch.json" \
  || fail 'Ready leftover claim did not persist credential-consumption proof'
rm -rf "$dir"

if dir="$(run_settle 1 1 1 1 rollout-running '2026-01-01T00:00:00Z' 1 '' '' 19 'gfsc-reader-old|2025-12-31T23:59:59Z|True||gfsc-reader-old-rs|')"; then
  fail 'a pre-rotation Ready reader incorrectly certified the rollout'
fi
grep -q 'patch secret' "$dir/kubectl.log" \
  && fail 'a pre-rotation Ready reader must not be marked ready'
rm -rf "$dir"

dir="$(run_settle 1 1 0 1 rollout-running '2026-01-01T00:00:00Z' 1)"
grep -q 'patch secret' "$dir/kubectl.log" \
  && fail 'unready reader must not settle the leftover claim'
grep -Eq 'scale rs|delete pod' "$dir/kubectl.log" \
  && fail 'unready reader must not scale ReplicaSets or delete pods'
rm -rf "$dir"

dir="$(run_settle 1 1 1 1 ready '2026-01-01T00:00:00Z' 1)"
grep -q 'patch secret' "$dir/kubectl.log" \
  && fail 'ready Secret state must not be patched again'
rm -rf "$dir"

# A leftover non-current ReplicaSet with live unready pods keeps
# credential_rollout_pending true forever; it must be scaled to 0 while the
# current-revision ReplicaSet is never touched.
rs_rows='gfsc-reader-stale|gfsc-reader|1|0|12\ngfsc-reader-current|gfsc-reader|1|0|19\ngfsc-reader-old-empty|gfsc-reader|0||11\n'
dir="$(run_settle 1 1 1 1 ready '2026-01-01T00:00:00Z' 1 "$rs_rows" '' 19)"
grep -q 'scale rs gfsc-reader-stale --replicas=0' "$dir/kubectl.log" \
  || fail 'leftover non-current unready ReplicaSet was not scaled to 0'
grep -q 'scale rs gfsc-reader-current' "$dir/kubectl.log" \
  && fail 'the current-revision ReplicaSet must never be scaled by settle'
grep -q 'scale rs gfsc-reader-old-empty' "$dir/kubectl.log" \
  && fail 'an already-empty ReplicaSet must not be scaled'
rm -rf "$dir"

# CrashLoopBackOff pods must be deleted (to reset kubelet backoff and re-read
# the Secret); Ready and terminating pods must be left alone.
pod_rows='gfsc-reader-a-crash|False||CrashLoopBackOff\ngfsc-reader-b-ready|True||\ngfsc-reader-c-term|False|2026-01-01T00:00:00Z|CrashLoopBackOff\n'
dir="$(run_settle 1 1 1 1 ready '2026-01-01T00:00:00Z' 1 '' "$pod_rows" 19)"
grep -q 'delete pod gfsc-reader-a-crash' "$dir/kubectl.log" \
  || fail 'CrashLoopBackOff reader pod was not deleted'
grep -q 'delete pod gfsc-reader-b-ready' "$dir/kubectl.log" \
  && fail 'a Ready reader pod must never be deleted'
grep -q 'delete pod gfsc-reader-c-term' "$dir/kubectl.log" \
  && fail 'a terminating reader pod must not be deleted again'
rm -rf "$dir"

printf 'PASS: settle-gfs-reader-rollout leftover Ready claim and stale leftovers\n'
