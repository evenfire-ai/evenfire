#!/usr/bin/env bash
# Executable, cluster-free guard tests for scripts/e2e/e2e-hcc-rollout-readiness.sh
# (the evenfire#391 / PR #382 D1b gate).
#
# The sibling contract test (test-hcc-rollout-readiness-gate.sh) is grep-based:
# it proves the guard TEXT exists in the gate, not that the guards RUN. This
# suite actually EXECUTES the gate under a fully isolated environment (env -i)
# and asserts each fail-closed guard fires: exit != 0 AND the guard's own
# stable die/echo text on stderr/stdout. A refactor that keeps the strings but
# reorders or dead-codes the guards fails HERE.
#
# Every case below exits inside the guard block (gate lines before the first
# `kctl get nodes`) or against a PATH-stubbed fake kubectl — no case ever
# contacts a real cluster or the developer's kubeconfig.
set -u
FAIL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="${ROOT}/scripts/e2e/e2e-hcc-rollout-readiness.sh"
BASH_BIN="$(command -v bash)"
pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  FAIL=1
}

command -v jq >/dev/null 2>&1 || {
  echo "FAIL: this harness itself requires jq on PATH (the gate's happy path needs it)" >&2
  exit 1
}

# Branch-shaped fake context: passes is_branch_scoped_e2e_context
# (^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$) so each case reaches the guard
# under test instead of dying on the context-shape guard.
BRANCH_CTX="clerum-feat-issue-391-deadbeef"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/hcc-rollout-guards.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT
# Point KUBECONFIG at an empty throwaway file in every case: even a bug that
# slipped past PATH isolation must never read or mutate the developer's
# kubeconfig.
FAKE_KUBECONFIG="${WORKDIR}/empty-kubeconfig"
: >"$FAKE_KUBECONFIG"

# run_gate_expecting <description> <needle> [VAR=value ...]
# Runs the gate under `env -i` (nothing leaks from the developer shell) with
# exactly the provided variables, expecting: non-zero exit, the guard's stable
# needle in the combined output, and NO evidence the gate got past its guard
# block into cluster mutation.
run_gate_expecting() {
  local desc="$1" needle="$2"
  shift 2
  local out rc
  out="$(env -i HOME="$HOME" TMPDIR="${WORKDIR}" KUBECONFIG="$FAKE_KUBECONFIG" "$@" \
    "$BASH_BIN" "$GATE" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    fail "${desc} — gate exited 0 instead of refusing"
    return
  fi
  if ! grep -Fq "$needle" <<<"$out"; then
    fail "${desc} — exit ${rc} but guard text '${needle}' missing; got: $(head -c 400 <<<"$out")"
    return
  fi
  # Positive shape: the refusal must come from the guard block, before any
  # cluster mutation phase starts.
  if grep -Fq 'Creating synthetic fleet' <<<"$out" || grep -Fq 'Baseline: sampling' <<<"$out"; then
    fail "${desc} — guard fired but the gate still progressed past the guard block"
    return
  fi
  pass "$desc"
}

# 1. Missing KUBECONTEXT / E2E_K8S_CONTEXT: the very first guard must refuse.
run_gate_expecting \
  "refuses when neither KUBECONTEXT nor E2E_K8S_CONTEXT is set" \
  "KUBECONTEXT/E2E_K8S_CONTEXT must select a branch-scoped minikube context." \
  PATH="$PATH"

# 2a. Non-branch context: the shared `minikube` context is not branch-scoped.
run_gate_expecting \
  "refuses fault injection on the shared 'minikube' context" \
  "Refusing rollout fault injection on non-branch context 'minikube'." \
  PATH="$PATH" KUBECONTEXT=minikube

# 2b. Prod-shaped context: is_branch_scoped_e2e_context hard-rejects *prod*
#     even when the rest of the name is branch-shaped.
run_gate_expecting \
  "refuses fault injection on a *prod* context" \
  "Refusing rollout fault injection on non-branch context 'clerum-prod-deadbeef'." \
  PATH="$PATH" KUBECONTEXT=clerum-prod-deadbeef

# 3. Missing fault-injection acknowledgement: a branch-scoped context alone is
#    not consent to roll (and possibly break) the HCC deployment.
run_gate_expecting \
  "refuses without E2E_HCC_ROLLOUT_FAULT_INJECTION=1" \
  "Set E2E_HCC_ROLLOUT_FAULT_INJECTION=1 to acknowledge that this gate rolls" \
  PATH="$PATH" KUBECONTEXT="$BRANCH_CTX"

# 4. EXPECT_STUCK=1 and EXPECT_RECOVERY=1 are exclusive modes: the D1b outage
#    reproduction and the evenfire#391 undo evidence must never be conflated
#    into one run.
run_gate_expecting \
  "refuses EXPECT_STUCK=1 together with EXPECT_RECOVERY=1" \
  "EXPECT_STUCK=1 and EXPECT_RECOVERY=1 are exclusive." \
  PATH="$PATH" KUBECONTEXT="$BRANCH_CTX" E2E_HCC_ROLLOUT_FAULT_INJECTION=1 \
  EXPECT_STUCK=1 EXPECT_RECOVERY=1

# 5a. EXPECT_STUCK must be 0 or 1 — anything else is a typo, not a mode.
run_gate_expecting \
  "refuses an invalid EXPECT_STUCK value" \
  "EXPECT_STUCK must be 0 (measure a healthy rollout window) or 1" \
  PATH="$PATH" KUBECONTEXT="$BRANCH_CTX" E2E_HCC_ROLLOUT_FAULT_INJECTION=1 \
  EXPECT_STUCK=2

# 5b. EXPECT_RECOVERY must be 0 or 1.
run_gate_expecting \
  "refuses an invalid EXPECT_RECOVERY value" \
  "EXPECT_RECOVERY must be 0 or 1." \
  PATH="$PATH" KUBECONTEXT="$BRANCH_CTX" E2E_HCC_ROLLOUT_FAULT_INJECTION=1 \
  EXPECT_STUCK=0 EXPECT_RECOVERY=yes

# 6. jq missing: build a minimal PATH containing only the external tools the
#    gate needs BEFORE its jq guard (dirname for SCRIPT_DIR, grep for
#    is_branch_scoped_e2e_context) and deliberately no jq. The gate must die
#    on its own jq guard, not on an accidental command-not-found later.
NOJQ_BIN="${WORKDIR}/nojq-bin"
mkdir -p "$NOJQ_BIN"
for tool in dirname grep; do
  ln -s "$(command -v "$tool")" "${NOJQ_BIN}/${tool}"
done
run_gate_expecting \
  "refuses when jq is not on PATH" \
  "jq is required" \
  PATH="$NOJQ_BIN" KUBECONTEXT="$BRANCH_CTX"

# 7. Wrong minikube node: a PATH-stubbed fake kubectl reports a node labelled
#    with a DIFFERENT profile. The stub records every invocation, refuses any
#    mutating verb, and only answers `get nodes` on the explicit --context.
#    That way a guard reorder that mutates the cluster BEFORE the node-label
#    check cannot hide behind a stub that always prints JSON and exits 0.
FAKE_KUBECTL_BIN="${WORKDIR}/fake-kubectl-bin"
FAKE_KUBECTL_LOG="${WORKDIR}/fake-kubectl.log"
mkdir -p "$FAKE_KUBECTL_BIN"
cat >"${FAKE_KUBECTL_BIN}/kubectl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"${FAKE_KUBECTL_LOG}"
ctx=""
args=()
while [ "\$#" -gt 0 ]; do
  case "\$1" in
    --context) ctx="\$2"; shift 2 ;;
    --context=*) ctx="\${1#--context=}"; shift ;;
    *) args+=("\$1"); shift ;;
  esac
done
verb="\${args[0]:-}"
case "\$verb" in
  set|delete|apply|patch|rollout|scale|create|replace|annotate|label|exec|drain|edit|expose|autoscale|cordon|uncordon|taint)
    echo "fake-kubectl: refusing mutating verb \$verb" >&2
    exit 2
    ;;
esac
if [ "\$ctx" != "${BRANCH_CTX}" ] || [ "\$verb" != "get" ] || [ "\${args[1]:-}" != "nodes" ]; then
  echo "fake-kubectl: unexpected invocation ctx=\$ctx argv=\${args[*]}" >&2
  exit 2
fi
echo '{"items":[{"metadata":{"labels":{"minikube.k8s.io/name":"clerum-other-branch-cafebabe"}}}]}'
EOF
chmod +x "${FAKE_KUBECTL_BIN}/kubectl"
run_gate_expecting \
  "refuses when the node label belongs to another minikube profile" \
  "Refusing rollout fault injection: target is not this profile's minikube node." \
  PATH="${FAKE_KUBECTL_BIN}:$PATH" KUBECONTEXT="$BRANCH_CTX" \
  E2E_HCC_ROLLOUT_FAULT_INJECTION=1 EXPECT_STUCK=0 EXPECT_RECOVERY=0
if [ ! -s "$FAKE_KUBECTL_LOG" ]; then
  fail "fake kubectl recorded no invocations — the node-label guard may not have run"
elif ! grep -Fq -- "--context ${BRANCH_CTX} get nodes" "$FAKE_KUBECTL_LOG"; then
  fail "fake kubectl was not asked for get nodes on the explicit context; got: $(tr '\n' '|' <"$FAKE_KUBECTL_LOG")"
elif grep -Eq '(^| )(set|delete|apply|patch|rollout|scale|create|replace|annotate|label)( |$)' "$FAKE_KUBECTL_LOG"; then
  fail "fake kubectl recorded a mutating verb before the node-label guard; got: $(tr '\n' '|' <"$FAKE_KUBECTL_LOG")"
else
  pass "fake kubectl saw only get nodes --context ${BRANCH_CTX} (no mutation)"
fi

exit "$FAIL"
