#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"

# The minikube k8s-api-ip patch is a machine-specific, gitignored file rendered
# at setup time. On a developer box with a live minikube it may already exist;
# this test shadows it with a dummy render below. Save the real one (if any) and
# restore it on EXIT so the test leaves the working tree exactly as it found it.
MINIKUBE_API_IP_PATCH=""
MINIKUBE_API_IP_PATCH_BACKUP=""
MINIKUBE_API_IP_PATCH_PREEXISTING=0
cleanup() {
  if [[ "${MINIKUBE_API_IP_PATCH_PREEXISTING}" -eq 1 ]]; then
    cp "${MINIKUBE_API_IP_PATCH_BACKUP}" "${MINIKUBE_API_IP_PATCH}"
  elif [[ -n "${MINIKUBE_API_IP_PATCH:-}" && -f "${MINIKUBE_API_IP_PATCH}" ]]; then
    rm -f "${MINIKUBE_API_IP_PATCH}"
  fi
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

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
if [[ -f "${MINIKUBE_API_IP_PATCH}" ]]; then
  # A developer's real rendered patch is present — preserve it so the dummy
  # render below doesn't clobber it; the EXIT trap restores it verbatim.
  MINIKUBE_API_IP_PATCH_BACKUP="${TMP_DIR}/k8s-api-ip.yaml.orig"
  cp "${MINIKUBE_API_IP_PATCH}" "${MINIKUBE_API_IP_PATCH_BACKUP}"
  MINIKUBE_API_IP_PATCH_PREEXISTING=1
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

RUBYOPT=--disable=gems ruby -ryaml -e '
  ingress = nil
  egress = nil
  YAML.load_stream(File.read(ARGV.fetch(0))) do |doc|
    next unless doc.is_a?(Hash) && doc["kind"] == "NetworkPolicy"
    next unless doc.dig("metadata", "namespace") == "control-plane"
    case doc.dig("metadata", "name")
    when "codex-llm-proxy-ingress" then ingress = doc
    when "codex-llm-proxy-egress" then egress = doc
    end
  end
  abort("rendered overlay is missing codex-llm-proxy-ingress") unless ingress
  abort("rendered overlay is missing codex-llm-proxy-egress") unless egress

  ingress_ports = Array(ingress.dig("spec", "ingress")).flat_map { |rule| Array(rule["ports"]).map { |port| port["port"] } }
  abort("codex-llm-proxy-ingress must expose 8080/8081/9090") unless ([8080, 8081, 9090] - ingress_ports).empty?

  Array(ingress.dig("spec", "ingress")).each_with_index do |rule, rule_idx|
    abort("codex-llm-proxy-ingress[#{rule_idx}] must declare from") if Array(rule["from"]).empty?
    Array(rule["from"]).each do |peer|
      abort("codex-llm-proxy-ingress must not use a namespace-wide selector") if peer == { "namespaceSelector" => {} } || peer == { "podSelector" => {} }
    end
  end

  forbidden_apps = %w[control-api control-postgres host-context-controller workflow-recipes mcp-host]
  saw_gateway = false
  saw_public = false
  Array(egress.dig("spec", "egress")).each_with_index do |rule, rule_idx|
    Array(rule["to"]).each do |peer|
      app = peer.dig("podSelector", "matchLabels", "app")
      abort("codex-llm-proxy-egress[#{rule_idx}] must not allow #{app}") if forbidden_apps.include?(app)
      saw_gateway = true if app == "control-api-rpc-gateway"
      ip = peer.dig("ipBlock", "cidr")
      next unless ip == "0.0.0.0/0"
      saw_public = true
      excepts = Array(peer.dig("ipBlock", "except"))
      abort("codex-llm-proxy-egress public HTTPS is missing private-range exceptions") if excepts.empty?
      abort("codex-llm-proxy-egress public HTTPS is missing metadata exception") unless excepts.include?("169.254.0.0/16")
    end
  end
  abort("codex-llm-proxy-egress must allow control-api-rpc-gateway") unless saw_gateway
  abort("codex-llm-proxy-egress must allow public HTTPS with exceptions") unless saw_public
' "${MINIKUBE_RENDERED}"
echo "PASS: rendered Codex proxy NetworkPolicies stay narrowly scoped"

BROAD_RENDERED="${TMP_DIR}/minikube-rendered-broad-proxy.yaml"
RUBYOPT=--disable=gems ruby -ryaml -e '
  docs = []
  YAML.load_stream(File.read(ARGV.fetch(0))) do |doc|
    next unless doc.is_a?(Hash)
    if doc["kind"] == "NetworkPolicy" && doc.dig("metadata", "name") == "codex-llm-proxy-egress"
      doc["spec"] ||= {}
      doc["spec"]["egress"] ||= []
      doc["spec"]["egress"] << {
        "ports" => [{ "port" => 443, "protocol" => "TCP" }],
        "to" => [{ "ipBlock" => { "cidr" => "0.0.0.0/0" } }]
      }
    end
    docs << doc
  end
  File.write(ARGV.fetch(1), docs.map { |doc| YAML.dump(doc) }.join("---\n"))
' "${MINIKUBE_RENDERED}" "${BROAD_RENDERED}"
if run_lint "${BROAD_RENDERED}" >/tmp/lint-netpol-codex-broad.out 2>&1; then
  echo "FAIL: Codex proxy broad public egress without exceptions should fail" >&2
  exit 1
fi
grep -q "without public-only exceptions" /tmp/lint-netpol-codex-broad.out
echo "PASS: lint-networkpolicies rejects a broad Codex proxy egress mutation"
