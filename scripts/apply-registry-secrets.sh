#!/bin/bash
# Apply registry client credentials as K8s Secrets.
# Run this in each cluster (clerum, clerum-dev) BEFORE `kubectl apply -k`.
#
# Usage:
#   CONTEXT=gke_${GCP_PROJECT}_us-central1-a_clerum \
#   CLIENT_ID=clerum-prod-control-api \
#   CLIENT_SECRET=<secret> \
#   ./scripts/apply-registry-secrets.sh
#
# Security note: CLIENT_SECRET is passed via a tempfile (mode 600) and
# `kubectl create secret --from-file`, NOT via `--from-literal`. The
# difference matters because `--from-literal=client-secret=$VAR` puts the
# secret value on kubectl's argv, where any user/process on the host can
# read it via `ps` or `/proc/<pid>/cmdline`. `--from-file` only exposes
# the path, and we restrict file mode to 600 + delete on exit.
set -euo pipefail

CONTEXT="${CONTEXT:?Must set CONTEXT to one of: gke_${GCP_PROJECT}_us-central1-a_clerum, gke_${GCP_PROJECT}_us-central1-a_clerum-dev, clerum-test}"
CLIENT_ID="${CLIENT_ID:?Must set CLIENT_ID (e.g. clerum-prod-control-api)}"
CLIENT_SECRET="${CLIENT_SECRET:?Must set CLIENT_SECRET}"
NAMESPACE="${NAMESPACE:-control-plane}"

# Safety check: reject contexts not in the approved Clerum list.
case "$CONTEXT" in
  gke_${GCP_PROJECT}_us-central1-a_clerum|\
  gke_${GCP_PROJECT}_us-central1-a_clerum-dev|\
  clerum-test)
    ;;
  *)
    echo "ERROR: CONTEXT '$CONTEXT' is not an approved Clerum cluster." >&2
    echo "Allowed: gke_${GCP_PROJECT}_us-central1-a_clerum, gke_${GCP_PROJECT}_us-central1-a_clerum-dev, clerum-test" >&2
    exit 1
    ;;
esac

# Stage secret values in a tempdir with mode 600. Cleaned up on exit
# (including on error / signal — `set -e` plus the trap covers both paths).
TMPDIR_REGISTRY="$(mktemp -d)"
chmod 700 "$TMPDIR_REGISTRY"
trap 'rm -rf "$TMPDIR_REGISTRY"' EXIT

# `printf %s` avoids appending a trailing newline that would otherwise be
# embedded in the Secret value (kubectl --from-file uses file bytes verbatim).
printf '%s' "$CLIENT_ID" > "$TMPDIR_REGISTRY/client-id"
printf '%s' "$CLIENT_SECRET" > "$TMPDIR_REGISTRY/client-secret"
chmod 600 "$TMPDIR_REGISTRY/client-id" "$TMPDIR_REGISTRY/client-secret"

kubectl --context="$CONTEXT" create secret generic registry-client-credentials \
  --from-file=client-id="$TMPDIR_REGISTRY/client-id" \
  --from-file=client-secret="$TMPDIR_REGISTRY/client-secret" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml \
  | kubectl --context="$CONTEXT" apply -f -

echo "Applied registry-client-credentials to context=$CONTEXT namespace=$NAMESPACE"
