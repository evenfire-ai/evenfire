#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

write_policy() {
  local path="$1"
  local body="$2"
  cat >"${path}" <<YAML
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: test-policy
  namespace: test-ns
spec:
  podSelector:
    matchLabels:
      app: test
  policyTypes:
    - Egress
  egress:
${body}
YAML
}

write_ingress_policy() {
  local path="$1"
  local body="$2"
  cat >"${path}" <<YAML
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: test-ingress-policy
  namespace: test-ns
spec:
  podSelector:
    matchLabels:
      app: test
  policyTypes:
    - Ingress
  ingress:
${body}
YAML
}

run_lint() {
  bash "${ROOT}/deploy/scripts/lint-networkpolicies.sh" --rendered "$1" --no-standalone
}

public_except_block() {
  RUBYOPT=--disable=gems ruby -ryaml -e '
    ranges = YAML.load_file(ARGV.fetch(0)).dig("spec", "ranges")
    abort("public egress exception ranges missing") unless ranges.is_a?(Array) && !ranges.empty?
    puts ranges.map { |cidr| "              - #{cidr}" }.join("\n")
  ' "${ROOT}/deploy/base/public-egress-exceptions.yaml"
}

write_policy "${TMP_DIR}/safe-specific.yaml" '    - ports:
        - port: 443
          protocol: TCP
      to:
        - ipBlock:
            cidr: 198.51.100.10/32'
run_lint "${TMP_DIR}/safe-specific.yaml" >/dev/null
echo "PASS: lint-networkpolicies allows explicit port plus specific destination"

write_policy "${TMP_DIR}/dns-infra-specific.yaml" '    - ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
      to:
        - ipBlock:
            cidr: 203.0.113.10/32'
run_lint "${TMP_DIR}/dns-infra-specific.yaml" >/dev/null
echo "PASS: lint-networkpolicies allows kube-dns ClusterIP only for DNS ports"

write_policy "${TMP_DIR}/dns-infra-wrong-port.yaml" '    - ports:
        - port: 443
          protocol: TCP
      to:
        - ipBlock:
            cidr: 203.0.113.10/32'
if run_lint "${TMP_DIR}/dns-infra-wrong-port.yaml" >/tmp/lint-netpol-dns-infra-wrong-port.out 2>&1; then
  echo "FAIL: kube-dns ClusterIP on a non-DNS port should fail" >&2
  exit 1
fi
grep -q "DNS infrastructure CIDR" /tmp/lint-netpol-dns-infra-wrong-port.out
echo "PASS: lint-networkpolicies rejects kube-dns ClusterIP outside DNS ports"

write_policy "${TMP_DIR}/ports-no-to.yaml" '    - ports:
        - port: 443
          protocol: TCP'
if run_lint "${TMP_DIR}/ports-no-to.yaml" >/tmp/lint-netpol-ports-no-to.out 2>&1; then
  echo "FAIL: ports without to should fail" >&2
  exit 1
fi
grep -q "ports but no to" /tmp/lint-netpol-ports-no-to.out
echo "PASS: lint-networkpolicies rejects egress ports without destination"

write_ingress_policy "${TMP_DIR}/ingress-ports-no-from.yaml" '    - ports:
        - port: 8080
          protocol: TCP'
if run_lint "${TMP_DIR}/ingress-ports-no-from.yaml" >/tmp/lint-netpol-ingress-ports-no-from.out 2>&1; then
  echo "FAIL: ingress ports without from should fail" >&2
  exit 1
fi
grep -q "ports but no from" /tmp/lint-netpol-ingress-ports-no-from.out
echo "PASS: lint-networkpolicies rejects ingress ports without source"

write_policy "${TMP_DIR}/public-no-excepts.yaml" '    - ports:
        - port: 443
          protocol: TCP
      to:
        - ipBlock:
            cidr: 0.0.0.0/0'
if run_lint "${TMP_DIR}/public-no-excepts.yaml" >/tmp/lint-netpol-public-no-excepts.out 2>&1; then
  echo "FAIL: public CIDR without exceptions should fail" >&2
  exit 1
fi
grep -q "without public-only exceptions" /tmp/lint-netpol-public-no-excepts.out
echo "PASS: lint-networkpolicies rejects 0.0.0.0/0 without public-only exceptions"

PUBLIC_EXCEPT_BLOCK="$(public_except_block)"
write_policy "${TMP_DIR}/public-with-excepts.yaml" "    - ports:
        - port: 443
          protocol: TCP
      to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
${PUBLIC_EXCEPT_BLOCK}"
run_lint "${TMP_DIR}/public-with-excepts.yaml" >/dev/null
echo "PASS: lint-networkpolicies allows public-only exception set with explicit ports"

# The minikube overlay references patches/k8s-api-ip.yaml, which is rendered
# from a gitignored template at setup time (deploy/scripts/minikube-detect-k8s-api-ip.sh)
# and absent on a fresh checkout — so `kubectl kustomize` would abort with a
# "no such file" evalsymlink error before ever reaching a lint verdict. Render
# it inline here from the template with a placeholder CIDR, exactly as the
# single-writer CI step does (.github/workflows/ci-public.yml), so this test
# exercises the real rendered overlay instead of failing on a missing env file.
MINIKUBE_API_IP_TEMPLATE="${ROOT}/deploy/overlays/minikube/patches/k8s-api-ip.yaml.template"
MINIKUBE_API_IP_PATCH="${ROOT}/deploy/overlays/minikube/patches/k8s-api-ip.yaml"
if [[ ! -f "${MINIKUBE_API_IP_TEMPLATE}" ]]; then
  echo "FAIL: missing ${MINIKUBE_API_IP_TEMPLATE}; cannot render the minikube k8s-api-ip patch" >&2
  exit 1
fi
sed 's#__K8S_API_IP__#10.96.0.1#g' "${MINIKUBE_API_IP_TEMPLATE}" >"${MINIKUBE_API_IP_PATCH}"

MINIKUBE_RENDERED="${TMP_DIR}/minikube-rendered.yaml"
kubectl kustomize "${ROOT}/deploy/overlays/minikube" >"${MINIKUBE_RENDERED}"
RUBYOPT=--disable=gems ruby -ryaml -e '
  forbidden = %w[allow-dns-egress-sandbox-ui deny-all-sandbox-ui]
  required = %w[sandbox-ui-static-deny-all sandbox-ui-static-dns-egress]
  found = []
  names = []
  YAML.load_stream(File.read(ARGV.fetch(0))) do |doc|
    next unless doc.is_a?(Hash) && doc["kind"] == "NetworkPolicy"
    next unless doc.dig("metadata", "namespace") == "sandbox-ui"

    name = doc.dig("metadata", "name")
    names << name
    found << name if forbidden.include?(name)
    if name == "sandbox-ui-static-dns-egress"
      saw_dns_peer = false
      Array(doc.dig("spec", "egress")).each_with_index do |rule, rule_idx|
        ports = Array(rule["ports"]).map { |port| [port.fetch("protocol", "TCP"), port["port"]] }.sort
        expected_ports = [["TCP", 53], ["UDP", 53]]
        unless ports == expected_ports
          abort("sandbox-ui static DNS egress rule #{rule_idx} must only allow TCP/UDP 53")
        end

        peers = Array(rule["to"])
        abort("sandbox-ui static DNS egress rule #{rule_idx} must declare explicit peers") if peers.empty?
        peers.each_with_index do |peer, peer_idx|
          ns_name = peer.dig("namespaceSelector", "matchLabels", "kubernetes.io/metadata.name")
          dns_selector = peer.dig("podSelector", "matchLabels", "k8s-app")

          if ns_name == "kube-system" && dns_selector == "kube-dns"
            saw_dns_peer = true
            next
          end

          abort("sandbox-ui static DNS egress peer #{rule_idx}/#{peer_idx} must stay scoped to kube-system kube-dns pods")
        end
      end
      abort("sandbox-ui static DNS egress must include a kube-system kube-dns peer") unless saw_dns_peer
    end
  end
  abort("sandbox-ui static slice must not render HCC-owned policies: #{found.join(", ")}") unless found.empty?
  missing = required - names
  abort("sandbox-ui static slice must render renamed baseline policies: #{missing.join(", ")}") unless missing.empty?
' "${MINIKUBE_RENDERED}"
echo "PASS: minikube sandbox-ui static policies do not take HCC-owned deny-all/DNS ownership and retain kube-dns-only DNS egress"
