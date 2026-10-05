#!/usr/bin/env bash
# Stub kubectl for scripts/tests/test-doks-discover.sh. Logs argv to
# $STUB_DIR/kubectl.log; answers the read-only calls doks-discover.sh makes with
# values shaped like a DOKS 1.36 cluster, overridable per test case.
set -uo pipefail
: "${STUB_DIR:?set STUB_DIR}"
printf '%s\n' "$*" >>"$STUB_DIR/kubectl.log"
j=" $* "
case "$j" in
  *" get service kubernetes "*) printf '%s' "${STUB_API_CLUSTERIP:-10.96.0.1}" ;;
  *" get endpointslices "*ports*) printf '%s' "${STUB_API_PORT:-443}" ;;
  *" get endpointslices "*) printf '%s' "${STUB_API_EP:-10.10.0.2}" ;;
  *" get service kube-dns "*) printf '%s' "${STUB_DNS_IP:-10.96.0.10}" ;;
  *" get daemonset node-local-dns "*) exit "${STUB_NODELOCAL_RC:-1}" ;;
  *" get storageclass "*)
    if [ "${STUB_NO_DEFAULT_SC:-0}" = 1 ]; then d='"false"'; else d='"true"'; fi
    cat <<EOF
{"items":[
 {"metadata":{"name":"do-block-storage","annotations":{"storageclass.kubernetes.io/is-default-class":${d}}},"reclaimPolicy":"Delete"},
 {"metadata":{"name":"do-block-storage-retain"},"reclaimPolicy":"Retain"}]}
EOF
    ;;
  *" get crd ciliumnetworkpolicies.cilium.io "*) exit "${STUB_CRD_RC:-0}" ;;
  *" get configmap cilium-config "*)
    printf '{"data":{"policy-cidr-match-mode":"%s","kube-proxy-replacement":"true","enable-ipv6":"%s"}}' \
      "${STUB_CIDR_MATCH:-}" "${STUB_IPV6:-false}" ;;
  *" get daemonset cilium "*)
    printf 'nrr-status-patcher=ghcr.io/digitalocean-packages/node-readiness-reporter:v0.3.0\ncilium-agent=ghcr.io/digitalocean-packages/cilium:v1.19.3\n' ;;
  *" get ciliumclusterwidenetworkpolicies "*) printf 'deny-imds-egress' ;;
  *) echo "doks-stub-kubectl-discover: unexpected call: $*" >&2; exit 99 ;;
esac
