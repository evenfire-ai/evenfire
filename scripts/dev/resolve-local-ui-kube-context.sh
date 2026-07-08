#!/usr/bin/env bash
set -euo pipefail

profile="${MINIKUBE_PROFILE:-clerum-test}"
gcp_dev_context="${GCP_DEV_CONTEXT:-gke_${GCP_PROJECT}_us-central1-a_example-dev}"
gcp_prod_context="${GCP_PROD_CONTEXT:-gke_${GCP_PROJECT}_us-central1-a_clerum}"

context_exists() {
  local context="$1"
  kubectl config get-contexts -o name 2>/dev/null | grep -Fxq "$context"
}

minikube_is_running() {
  command -v minikube >/dev/null 2>&1 || return 1

  local status
  status="$(
    minikube -p "$profile" status \
      --format='{{.Host}} {{.Kubelet}} {{.APIServer}}' 2>/dev/null || true
  )"
  [ "$status" = "Running Running Running" ]
}

if minikube_is_running; then
  printf '%s\n' "$profile"
  exit 0
fi

current_context="$(kubectl config current-context 2>/dev/null || true)"
case "$current_context" in
  "$gcp_dev_context"|"$gcp_prod_context")
    printf '%s\n' "$current_context"
    exit 0
    ;;
esac

if context_exists "$gcp_dev_context"; then
  printf '%s\n' "$gcp_dev_context"
  exit 0
fi

if context_exists "$gcp_prod_context"; then
  printf '%s\n' "$gcp_prod_context"
  exit 0
fi

cat >&2 <<MSG
ERROR: no usable Kubernetes context found for local UI port-forwards.

Start minikube, or fetch a GKE context first:
  gcloud container clusters get-credentials example-dev --zone=us-central1-a --project=${GCP_PROJECT}
  gcloud container clusters get-credentials clerum --zone=us-central1-a --project=${GCP_PROJECT}
MSG
exit 1
