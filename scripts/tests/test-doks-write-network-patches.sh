#!/usr/bin/env bash
# Behaviour test for .agents/skills/evenfire-digitalocean-doks/scripts/write-network-patches.sh.
set -uo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
GEN="${ROOT_DIR}/.agents/skills/evenfire-digitalocean-doks/scripts/write-network-patches.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fails=0
fail() { echo "FAIL: $*" >&2; fails=$((fails + 1)); }

[ -x "$GEN" ] || { echo "FAIL: $GEN missing or not executable" >&2; exit 1; }

new_overlay() {
  local d="$work/$1"
  mkdir -p "$d"
  printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n' >"$d/kustomization.yaml"
  printf '%s' "$d"
}
gen() { env API_IPS='10.96.0.1 198.51.100.10' DNS_IP='10.96.0.10' STORAGE_CLASS='do-block-storage' \
  API_ENDPOINT_PORT=443 "$@" bash "$GEN" >/dev/null 2>"$work/stderr"; }

# --- controller mode -------------------------------------------------------------
o="$(new_overlay controller)"
gen OVERLAY_DIR="$o" INGRESS_MODE=controller INGRESS_NAMESPACE=traefik \
  INGRESS_POD_LABELS='app.kubernetes.io/name=traefik,app.kubernetes.io/instance=traefik-traefik' \
  API_ENDPOINT_PORT=6443 || fail "controller: generator failed: $(cat "$work/stderr")"
for f in k8s-api-ip.yaml hcc-cluster.yaml kube-dns-egress-rule.yaml cilium-api-egress.yaml \
  ingress-controller-control-ui.yaml ingress-controller-profiles.yaml ingress-controller-rpc-proxy.yaml \
  ingress-controller-webhook-proxy.yaml; do
  [ -f "$o/patches/$f" ] || fail "controller: missing patches/$f"
done

ruby -ryaml -e '
  docs = YAML.load_stream(File.read(ARGV[0])).compact
  errs = []
  want = {
    "control-plane"   => [{"matchExpressions"=>[{"key"=>"app","operator"=>"In","values"=>%w[host-context-controller workflow-recipes control-api trace-maintenance-worker]}]}, %w[443 6443]],
    "channels"        => [{"matchLabels"=>{"app"=>"channel-reader"}}, %w[443 6443]],
    "mcp-host"        => [{"matchLabels"=>{"clerum.io/managed-by"=>"host-context-controller"}}, %w[443 6443 8443]],
    "mcp-server"      => [{"matchLabels"=>{"clerum.io/k8s-api-egress"=>"true"}}, %w[443 6443]],
    "sandbox-recipes" => [{"matchLabels"=>{"clerum.io/k8s-api-egress"=>"true"}}, %w[443 6443]],
    "rpc-proxy"       => [{"matchLabels"=>{"clerum.io/k8s-api-egress"=>"true"}}, %w[443 6443]],
  }
  errs << "want 6 CiliumNetworkPolicies, got #{docs.size}" unless docs.size == 6
  docs.each do |d|
    ns = d.dig("metadata", "namespace")
    errs << "#{ns}: kind #{d["kind"]}" unless d["kind"] == "CiliumNetworkPolicy" && d["apiVersion"] == "cilium.io/v2"
    errs << "#{ns}: name #{d.dig("metadata","name")}" unless d.dig("metadata", "name") == "allow-k8s-api-egress-cilium-#{ns}"
    errs << "#{ns}: carries clerum.io/managed-by label" if (d.dig("metadata", "labels") || {}).key?("clerum.io/managed-by")
    sel, ports = want.delete(ns) || (errs << "unexpected namespace #{ns}"; next)
    errs << "#{ns}: selector #{d.dig("spec","endpointSelector")}" unless d.dig("spec", "endpointSelector") == sel
    eg = Array(d.dig("spec", "egress"))
    errs << "#{ns}: want one egress rule" unless eg.size == 1
    r = eg.first || {}
    errs << "#{ns}: toEntities #{r["toEntities"]}" unless r["toEntities"] == ["kube-apiserver"]
    got = Array(r["toPorts"]).flat_map { |t| Array(t["ports"]).map { |p| p["port"].to_s } }.sort
    errs << "#{ns}: ports #{got}" unless got == ports.sort
  end
  errs << "missing namespaces #{want.keys}" unless want.empty?
  if errs.empty? then exit 0 else warn errs.join("\n"); exit 1 end
' "$o/patches/cilium-api-egress.yaml" 2>"$work/cnp.err" || fail "controller: cilium-api-egress.yaml: $(cat "$work/cnp.err")"

check_ingress() { # file ports...
  local f="$o/patches/$1"; shift
  ruby -ryaml -e '
    ops = YAML.load(File.read(ARGV[0]))
    want_ports = ARGV[1..].map(&:to_i).sort
    ok = ops.is_a?(Array) && ops.size == 1 && ops[0]["op"] == "add" && ops[0]["path"] == "/spec/ingress/-"
    v = ok ? ops[0]["value"] : {}
    from = Array(v["from"])
    ok &&= from.size == 1 && from[0]["ipBlock"].nil?
    ok &&= from[0].dig("namespaceSelector", "matchLabels") == {"kubernetes.io/metadata.name" => "traefik"}
    ok &&= from[0].dig("podSelector", "matchLabels") == {"app.kubernetes.io/name" => "traefik", "app.kubernetes.io/instance" => "traefik-traefik"}
    ok &&= Array(v["ports"]).map { |p| p["port"] }.sort == want_ports
    ok &&= Array(v["ports"]).all? { |p| p["protocol"] == "TCP" }
    exit(ok ? 0 : 1)
  ' "$f" "$@" || fail "controller: $(basename "$f") has the wrong shape or ports"
}
check_ingress ingress-controller-control-ui.yaml 3000
check_ingress ingress-controller-profiles.yaml 3001 8091
check_ingress ingress-controller-rpc-proxy.yaml 8094
check_ingress ingress-controller-webhook-proxy.yaml 8095

grep -q 'cidr: 10.96.0.1/32' "$o/patches/k8s-api-ip.yaml" || fail "controller: k8s-api-ip.yaml lacks the ClusterIP /32"
grep -q 'cidr: 198.51.100.10/32' "$o/patches/k8s-api-ip.yaml" || fail "controller: k8s-api-ip.yaml lacks the endpoint /32"
[ "$(grep -c '^kind: NetworkPolicy' "$o/patches/k8s-api-ip.yaml")" -eq 3 ] || fail "controller: k8s-api-ip.yaml should patch 3 policies"
grep -q 'value: "10.96.0.1/32,198.51.100.10/32"' "$o/patches/hcc-cluster.yaml" || fail "controller: HCC API CIDRs wrong"
grep -q 'value: "do-block-storage"' "$o/patches/hcc-cluster.yaml" || fail "controller: HCC storage class wrong"
grep -q 'cidr: 10.96.0.10/32' "$o/patches/kube-dns-egress-rule.yaml" || fail "controller: kube-dns rule wrong"

# --- tunnel mode removes ingress-controller patches -------------------------------------
gen OVERLAY_DIR="$o" INGRESS_MODE=tunnel || fail "tunnel: generator failed: $(cat "$work/stderr")"
ls "$o"/patches/ingress-controller-*.yaml >/dev/null 2>&1 && fail "tunnel: ingress-controller patches left behind"
[ -f "$o/patches/cilium-api-egress.yaml" ] || fail "tunnel: cilium-api-egress.yaml missing"
grep -q '"443"' "$o/patches/cilium-api-egress.yaml" || fail "tunnel: CNP lacks port 443"
grep -q '"6443"' "$o/patches/cilium-api-egress.yaml" && fail "tunnel: stale 6443 port from previous run"

# --- fail-closed inputs ----------------------------------------------------
o="$(new_overlay bad)"
if gen OVERLAY_DIR="$o" INGRESS_MODE=tunnel API_IPS='fd00::1'; then fail "IPv6 API_IPS accepted"; fi
grep -q 'STOP' "$work/stderr" || fail "IPv6: no STOP message"
if gen OVERLAY_DIR="$o" INGRESS_MODE=controller INGRESS_NAMESPACE=traefik; then
  fail "controller without INGRESS_POD_LABELS accepted"
fi
if gen OVERLAY_DIR="$o" INGRESS_MODE=gateway; then fail "unknown INGRESS_MODE accepted"; fi
if gen OVERLAY_DIR="$o" INGRESS_MODE=tunnel API_ENDPOINT_PORT=abc; then fail "non-numeric API_ENDPOINT_PORT accepted"; fi
if env -u API_ENDPOINT_PORT OVERLAY_DIR="$o" INGRESS_MODE=tunnel API_IPS=10.96.0.1 DNS_IP=10.96.0.10 \
  STORAGE_CLASS=x bash "$GEN" >/dev/null 2>&1; then fail "missing API_ENDPOINT_PORT accepted"; fi
if gen OVERLAY_DIR="$work/nope" INGRESS_MODE=tunnel; then fail "missing overlay accepted"; fi

if [ "$fails" -ne 0 ]; then
  echo "test-doks-write-network-patches: $fails failure(s)" >&2
  exit 1
fi
echo "test-doks-write-network-patches: OK"
