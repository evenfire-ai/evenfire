#!/bin/bash
# Apply registry client credentials as K8s Secrets.
# Run this in each cluster (clerum, example-dev) BEFORE `kubectl apply -k`.
#
# Usage:
#   CONTEXT=gke_${GCP_PROJECT}_us-central1-a_clerum \
#   CLIENT_ID=example-prod-control-api \
#   CLIENT_SECRET=<secret> \
#   CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY_FILE=/path/to/voucher.key \
#   CONTROL_API_REGISTRY_VOUCHER_KID=<registry-key-id> \
#   ./scripts/apply-registry-secrets.sh
#
# Security note: CLIENT_SECRET is passed via a tempfile (mode 600) and
# `kubectl create secret --from-file`, NOT via `--from-literal`. The
# difference matters because `--from-literal=client-secret=$VAR` puts the
# secret value on kubectl's argv, where any user/process on the host can
# read it via `ps` or `/proc/<pid>/cmdline`. `--from-file` only exposes
# the path, and we restrict file mode to 600 + delete on exit.
#
# Voucher v2 material is optional for legacy callers of this helper, but gcp
# managed deployments require both CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY and
# CONTROL_API_REGISTRY_VOUCHER_KID to boot. Prefer passing the private key via
# CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY_FILE so the PEM is never placed on
# kubectl argv.
set -euo pipefail

CONTEXT="${CONTEXT:?Must set CONTEXT to one of: gke_${GCP_PROJECT}_us-central1-a_clerum, gke_${GCP_PROJECT}_us-central1-a_example-dev, clerum-test}"
CLIENT_ID="${CLIENT_ID:?Must set CLIENT_ID (e.g. example-prod-control-api)}"
CLIENT_SECRET="${CLIENT_SECRET:?Must set CLIENT_SECRET}"
NAMESPACE="${NAMESPACE:-control-plane}"
VOUCHER_PRIVATE_KEY_FILE="${CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY_FILE:-}"
VOUCHER_PRIVATE_KEY="${CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY:-}"
VOUCHER_KID="${CONTROL_API_REGISTRY_VOUCHER_KID:-}"

# Safety check: reject contexts not in the approved Clerum list.
case "$CONTEXT" in
  gke_${GCP_PROJECT}_us-central1-a_clerum|\
  gke_${GCP_PROJECT}_us-central1-a_example-dev|\
  clerum-test)
    ;;
  *)
    echo "ERROR: CONTEXT '$CONTEXT' is not an approved Clerum cluster." >&2
    echo "Allowed: gke_${GCP_PROJECT}_us-central1-a_clerum, gke_${GCP_PROJECT}_us-central1-a_example-dev, clerum-test" >&2
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

if [[ -n "$VOUCHER_PRIVATE_KEY_FILE" && -n "$VOUCHER_PRIVATE_KEY" ]]; then
  echo "ERROR: set only one of CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY_FILE or CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY" >&2
  exit 1
fi

if [[ -n "$VOUCHER_PRIVATE_KEY_FILE" && ! -f "$VOUCHER_PRIVATE_KEY_FILE" ]]; then
  echo "ERROR: CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY_FILE does not exist: $VOUCHER_PRIVATE_KEY_FILE" >&2
  exit 1
fi

if [[ -n "$VOUCHER_PRIVATE_KEY_FILE" || -n "$VOUCHER_PRIVATE_KEY" || -n "$VOUCHER_KID" ]]; then
  if [[ -z "$VOUCHER_KID" ]]; then
    echo "ERROR: CONTROL_API_REGISTRY_VOUCHER_KID is required with voucher private key material" >&2
    exit 1
  fi
  if [[ -z "$VOUCHER_PRIVATE_KEY_FILE" && -z "$VOUCHER_PRIVATE_KEY" ]]; then
    echo "ERROR: CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY_FILE is required with CONTROL_API_REGISTRY_VOUCHER_KID" >&2
    exit 1
  fi
fi

kubectl --context="$CONTEXT" create secret generic registry-client-credentials \
  --from-file=client-id="$TMPDIR_REGISTRY/client-id" \
  --from-file=client-secret="$TMPDIR_REGISTRY/client-secret" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml \
  | kubectl --context="$CONTEXT" apply -f -

echo "Applied registry-client-credentials to context=$CONTEXT namespace=$NAMESPACE"

if [[ -n "$VOUCHER_KID" ]]; then
  if [[ -n "$VOUCHER_PRIVATE_KEY_FILE" ]]; then
    cp "$VOUCHER_PRIVATE_KEY_FILE" "$TMPDIR_REGISTRY/voucher-private-key"
  else
    printf '%s' "$VOUCHER_PRIVATE_KEY" > "$TMPDIR_REGISTRY/voucher-private-key"
  fi
  printf '%s' "$VOUCHER_KID" > "$TMPDIR_REGISTRY/voucher-kid"
  chmod 600 "$TMPDIR_REGISTRY/voucher-private-key" "$TMPDIR_REGISTRY/voucher-kid"

  jq -n \
    --rawfile key "$TMPDIR_REGISTRY/voucher-private-key" \
    --rawfile kid "$TMPDIR_REGISTRY/voucher-kid" \
    '{
      stringData: {
        CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY: $key,
        CONTROL_API_REGISTRY_VOUCHER_KID: $kid,
      },
    }' >"$TMPDIR_REGISTRY/control-api-voucher-patch.json"
  chmod 600 "$TMPDIR_REGISTRY/control-api-voucher-patch.json"

  kubectl --context="$CONTEXT" patch secret control-api-secrets \
    --namespace="$NAMESPACE" \
    --type=merge \
    --patch-file="$TMPDIR_REGISTRY/control-api-voucher-patch.json"

  echo "Applied control-api registry voucher material to context=$CONTEXT namespace=$NAMESPACE"
fi
