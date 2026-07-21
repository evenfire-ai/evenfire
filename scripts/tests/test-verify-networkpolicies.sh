#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

cat >"${TMP_DIR}/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

mode="${FAKE_KUBECTL_MODE:-success}"

if [[ "${1:-}" == "--context" ]]; then
  shift 2
fi

if [[ "${1:-}" == "kustomize" ]]; then
  cidr="203.0.113.10/32"
  if [[ "${mode}" == "forbidden" ]]; then
    cidr="10.109.0.1/32"
  fi
  cat <<YAML
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-test
  namespace: mcp-host
spec:
  egress:
  - ports:
    - port: 443
    to:
    - ipBlock:
        cidr: ${cidr}
  ingress: []
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hardening-fixture
  namespace: mcp-host
spec:
  template:
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: hardening-fixture
        image: example/hardening-fixture:test
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
          readOnlyRootFilesystem: true
          runAsNonRoot: true
YAML
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "networkpolicy" ]]; then
  if [[ "${mode}" == "missing" ]]; then
    printf '{"items":[]}\n'
    exit 0
  fi
  cidr="203.0.113.10/32"
  if [[ "${mode}" == "drift" ]]; then
    cidr="35.199.192.1/32"
  fi
  cat <<JSON
{
  "items": [
    {
      "metadata": {
        "name": "allow-test",
        "namespace": "mcp-host"
      },
      "spec": {
        "egress": [
          {
            "ports": [
              {
                "port": 443,
                "protocol": "TCP"
              }
            ],
            "to": [
              {
                "ipBlock": {
                  "cidr": "${cidr}"
                }
              }
            ]
          }
        ],
        "podSelector": {},
        "policyTypes": [
          "Ingress",
          "Egress"
        ]
      }
    }
  ]
}
JSON
  exit 0
fi

echo "unexpected kubectl invocation: $*" >&2
exit 99
SH
chmod +x "${TMP_DIR}/kubectl"
printf 'exceptions: []\n' >"${TMP_DIR}/workload-hardening-exceptions.yaml"

run_case() {
  local mode="$1"
  PATH="${TMP_DIR}:$PATH" FAKE_KUBECTL_MODE="${mode}" \
    WORKLOAD_HARDENING_EXCEPTIONS="${TMP_DIR}/workload-hardening-exceptions.yaml" \
    bash "${ROOT}/deploy/scripts/verify-networkpolicies.sh" --overlay minikube --context fake
}

run_case success >/dev/null
echo "PASS: verify-networkpolicies succeeds when rendered and live specs match after Kubernetes defaults"

if run_case missing >/tmp/verify-netpol-missing.out 2>&1; then
  echo "FAIL: missing policy should fail" >&2
  exit 1
fi
grep -q "missing rendered NetworkPolicies" /tmp/verify-netpol-missing.out
echo "PASS: verify-networkpolicies fails when rendered policy is missing"

if run_case drift >/tmp/verify-netpol-drift.out 2>&1; then
  echo "FAIL: stale policy spec should fail" >&2
  exit 1
fi
grep -q "specs differ" /tmp/verify-netpol-drift.out
echo "PASS: verify-networkpolicies fails on stale live NetworkPolicy spec"

if run_case forbidden >/tmp/verify-netpol-forbidden.out 2>&1; then
  echo "FAIL: forbidden CIDR should fail" >&2
  exit 1
fi
grep -q "forbidden CIDR" /tmp/verify-netpol-forbidden.out
echo "PASS: verify-networkpolicies fails on forbidden CIDR"
