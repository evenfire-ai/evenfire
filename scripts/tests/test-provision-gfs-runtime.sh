#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The HCC post-overlay wait, and the two facts that decide whether it can actually elapse.
# Kept here so the script, the Deployment manifest and this test cannot drift apart.
HCC_ROLLOUT_TIMEOUT_S=900
# Observed head start from apply-inter-service-tokens.sh's `rollout restart` of HCC to this
# script's wait: 160s on clerum-dev 2026-08-05. Rounded up for slower deploys.
HCC_RESTART_HEAD_START_S=300

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/overlay/instances"

cat >"$TMP/bin/bash" <<'MOCK'
#!/bin/bash
printf 'bash %s\n' "$*" >>"$CALL_LOG"
MOCK

cat >"$TMP/bin/kubectl" <<'MOCK'
#!/bin/bash
set -euo pipefail
printf 'kubectl %s\n' "$*" >>"$CALL_LOG"
case " $* " in
  *' get globalfilesystem gfs -o name '*) printf 'globalfilesystem.clerum.io/gfs\n' ;;
  *' get globalfilesystem gfs -o jsonpath={.status.phase} '*) printf 'Ready' ;;
  *' get deployment gfsc-writer '*) printf 'gfs-controller-db\n' ;;
  *' get deployment gfsc-reader '*) printf 'gfs-controller-reader-db\n' ;;
  *) : ;;
esac
MOCK
chmod +x "$TMP/bin/bash" "$TMP/bin/kubectl"

export CALL_LOG="$TMP/calls.log"
# clerum-dev-test is not one of the generic built-in dev patterns
# (*example-dev*, minikube, clerum-test, clerum-codex-*, ...), so authorize it
# through the ALLOWED_CONTEXTS override — the same mechanism a self-hosted dev
# pipeline uses for a GKE dev context that the generic patterns do not name.
for run in first-upgrade idempotent-rerun; do
  : "$run"
  ALLOWED_CONTEXTS=clerum-dev-test PATH="$TMP/bin:$PATH" /bin/bash "$ROOT/deploy/scripts/provision-gfs-runtime.sh" \
    --context clerum-dev-test \
    --overlay "$TMP/overlay" \
    --skip-auth-sync >/dev/null
done
PATH="$TMP/bin:$PATH" /bin/bash "$ROOT/deploy/scripts/provision-gfs-runtime.sh" \
  --context gke_prod_test \
  --overlay "$TMP/overlay" \
  --allow-prod \
  --skip-auth-sync \
  --skip-instances >/dev/null

reconcile="$ROOT/deploy/scripts/reconcile-gfs-deploy-credentials.sh"
[ "$(grep -Fc "bash $reconcile" "$CALL_LOG")" -eq 3 ] || {
  echo 'FAIL: post-overlay credential reconciliation did not run once per deploy' >&2
  exit 1
}
[ "$(grep -Fc "rollout status deployment/host-context-controller --timeout=${HCC_ROLLOUT_TIMEOUT_S}s" "$CALL_LOG")" -eq 3 ] || {
  echo "FAIL: HCC post-overlay rollout did not use its dedicated ${HCC_ROLLOUT_TIMEOUT_S}s timeout" >&2
  exit 1
}

# The timeout above is only ever the REAL budget if the Deployment's own
# progressDeadlineSeconds outlasts it. `kubectl rollout status` aborts the moment the
# Deployment controller sets Progressing=False/ProgressDeadlineExceeded, so a --timeout
# larger than the remaining progress deadline is dead code.
#
# Two things make the margin bigger than it looks. The deadline clock starts when the new
# ReplicaSet is created — that is apply-inter-service-tokens.sh's `rollout restart` of HCC,
# several deploy steps EARLIER — not when this script starts waiting. And the deadline is
# absolute, so the head start is subtracted from the budget this script thinks it has.
#
# On clerum-dev 2026-08-05 the head start was 160s: RS created 10:34:02, this wait began
# 10:36:42, and with progressDeadlineSeconds unset (k8s default 600) the controller
# aborted at 10:44:03 — 39s before the then-480s timeout would have fired. #202 raised
# that timeout and nothing changed, because it could never bind.
hcc_manifest="$ROOT/deploy/base/control-plane/host-context-controller.yaml"
deadline="$(awk '/^  progressDeadlineSeconds:/ { print $2; exit }' "$hcc_manifest")"
[ -n "$deadline" ] || {
  echo "FAIL: $hcc_manifest does not declare progressDeadlineSeconds, so it defaults to 600s" >&2
  echo '      and silently caps the rollout-status timeout above.' >&2
  exit 1
}
[ "$deadline" -ge "$(( HCC_ROLLOUT_TIMEOUT_S + HCC_RESTART_HEAD_START_S ))" ] || {
  echo "FAIL: progressDeadlineSeconds=${deadline}s cannot cover a ${HCC_ROLLOUT_TIMEOUT_S}s wait that" >&2
  echo "      starts ${HCC_RESTART_HEAD_START_S}s after the restart — the deadline would abort first." >&2
  exit 1
}
for deployment in gfsc-writer gfsc-reader; do
  [ "$(grep -Fc "rollout status deployment/$deployment --timeout=240s" "$CALL_LOG")" -eq 3 ] || {
    echo "FAIL: $deployment was not awaited after every reconciliation" >&2
    exit 1
  }
done
[ "$(grep -Fc 'apply -f' "$CALL_LOG")" -eq 2 ] || {
  echo 'FAIL: prod --skip-instances mutated CRD instances' >&2
  exit 1
}
! grep -Fq 'rollout restart' "$CALL_LOG" || {
  echo 'FAIL: runtime finalization introduced an unconditional rollout restart' >&2
  exit 1
}
! grep -Eq 'rotate-(writer|reader)' "$CALL_LOG" || {
  echo 'FAIL: runtime finalization introduced credential rotation' >&2
  exit 1
}

echo 'PASS: post-overlay GFS runtime reconciliation is ordered and rerunnable'
