#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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
  ALLOWED_CONTEXTS=clerum-dev-test PATH="$TMP/bin:$PATH" /bin/bash "$ROOT/deploy/scripts/provision-gfs-runtime.sh" \
    --context clerum-dev-test \
    --overlay "$TMP/overlay" \
    --skip-auth-sync >/dev/null
done
PATH="$TMP/bin:$PATH" /bin/bash "$ROOT/deploy/scripts/provision-gfs-runtime.sh" \
  --context gke-prod-test \
  --overlay "$TMP/overlay" \
  --allow-prod \
  --skip-auth-sync \
  --skip-instances >/dev/null

reconcile="$ROOT/deploy/scripts/reconcile-gfs-deploy-credentials.sh"
[ "$(grep -Fc "bash $reconcile" "$CALL_LOG")" -eq 3 ] || {
  echo 'FAIL: post-overlay credential reconciliation did not run once per deploy' >&2
  exit 1
}
[ "$(grep -Fc 'rollout status deployment/host-context-controller --timeout=240s' "$CALL_LOG")" -eq 3 ] || {
  echo 'FAIL: HCC was not awaited before every post-overlay reconciliation' >&2
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
