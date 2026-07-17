#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHANNEL_FIXTURE="${ROOT_DIR}/deploy/overlays/minikube/instances/communicationchannel.yaml"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

command -v kubectl >/dev/null 2>&1 || fail "kubectl is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"

[ -f "${CHANNEL_FIXTURE}" ] || fail "missing ${CHANNEL_FIXTURE}"

fixture_json="$(
  kubectl create --dry-run=client --validate=false -f "${CHANNEL_FIXTURE}" -o json
)"

kind="$(jq -r '.kind' <<<"${fixture_json}")"
[ "${kind}" = "CommunicationChannel" ] || fail "expected CommunicationChannel fixture, got ${kind}"

telegram_count="$(jq '[.spec.telegram[]?] | length' <<<"${fixture_json}")"
if [ "${telegram_count}" -ne 0 ]; then
  fail "default minikube CommunicationChannel must not start Telegram; placeholder tokens call external Telegram and crash channel-reader"
fi

group_count="$(jq '([.spec.email[]?] + [.spec.slack[]?]) | length' <<<"${fixture_json}")"
if [ "${group_count}" -eq 0 ]; then
  fail "default minikube CommunicationChannel must keep a non-Telegram fixture for UI/resource-list coverage"
fi

echo "Minikube bootstrap fixture validation passed"
