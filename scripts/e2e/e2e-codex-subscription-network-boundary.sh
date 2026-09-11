#!/usr/bin/env bash
# T2 network-boundary probe for codex-llm-proxy. Fail closed without a
# verified local owner context. GREEN is captured in Task 23.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../deploy/scripts/lib/clerum-minikube-context.sh
source "${ROOT}/deploy/scripts/lib/clerum-minikube-context.sh"

if [[ -z "${KUBECONTEXT:-}" ]]; then
  echo "codex_proxy_boundary: missing KUBECONTEXT" >&2
  exit 2
fi
export CONTEXT="$KUBECONTEXT"
if ! is_clerum_minikube_context; then
  echo "codex_proxy_boundary: refusing non-local context ${KUBECONTEXT}" >&2
  exit 2
fi

KUBECTL=(kubectl --context "$KUBECONTEXT")

if ! "${KUBECTL[@]}" get ns control-plane >/dev/null 2>&1; then
  echo "codex_proxy_boundary: workload_missing" >&2
  exit 3
fi
if ! "${KUBECTL[@]}" get deploy -n control-plane codex-llm-proxy >/dev/null 2>&1; then
  echo "codex_proxy_boundary: workload_missing" >&2
  exit 3
fi
if ! "${KUBECTL[@]}" get networkpolicy -n control-plane codex-llm-proxy-ingress >/dev/null 2>&1; then
  echo "codex_proxy_boundary: policy_missing" >&2
  exit 3
fi
if ! "${KUBECTL[@]}" get networkpolicy -n control-plane codex-llm-proxy-egress >/dev/null 2>&1; then
  echo "codex_proxy_boundary: policy_missing" >&2
  exit 3
fi

if [[ "${CODEX_NETWORK_BOUNDARY_LIVE:-0}" != "1" ]]; then
  echo "codex_proxy_boundary: workload and policies present (set CODEX_NETWORK_BOUNDARY_LIVE=1 for runtime probes)"
  exit 0
fi

probe_from_proxy() {
  "${KUBECTL[@]}" exec -n control-plane deploy/codex-llm-proxy -- node "$@"
}

probe_from_proxy -e 'require("dns").lookup("kubernetes.default.svc.cluster.local", (err) => { if (err) { console.error(err.code || err.message); process.exit(1); } process.exit(0); });'
echo "codex_proxy_boundary: DNS resolved"

gateway_result="$(probe_from_proxy -e '
const http = require("http");
const req = http.get("http://control-api-rpc-gateway.control-plane.svc.cluster.local:8090/", { timeout: 3000 }, (res) => {
  res.resume();
  process.stdout.write("reachable:" + res.statusCode);
  process.exit(0);
});
req.on("timeout", () => { req.destroy(); process.stdout.write("timeout"); process.exit(2); });
req.on("error", (err) => {
  if (err && err.code === "ECONNREFUSED") { process.stdout.write("reachable:refused"); process.exit(0); }
  process.stdout.write(String((err && err.code) || err.message));
  process.exit(1);
});
')"
if [[ "$gateway_result" != reachable:* ]]; then
  echo "codex_proxy_boundary: rpc-gateway hop blocked (${gateway_result})" >&2
  exit 1
fi
echo "codex_proxy_boundary: rpc-gateway hop reachable"

expect_blocked() {
  local name="$1"
  local url="$2"
  local result
  result="$(probe_from_proxy -e '
const http = require("http");
const https = require("https");
const target = new URL(process.argv[1]);
const lib = target.protocol === "https:" ? https : http;
const req = lib.request(target, { method: "GET", timeout: 3000, rejectUnauthorized: false }, (res) => {
  res.resume();
  process.stdout.write("reachable:" + res.statusCode);
  process.exit(0);
});
req.on("timeout", () => { req.destroy(); process.stdout.write("blocked:timeout"); process.exit(0); });
req.on("error", (err) => {
  const code = (err && err.code) || "";
  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    process.stdout.write("blocked:" + code);
    process.exit(0);
  }
  if (code === "ECONNREFUSED") {
    process.stdout.write("reachable:refused");
    process.exit(0);
  }
  process.stdout.write(String(code || err.message));
  process.exit(1);
});
req.end();
' "$url")"
  if [[ "$result" != blocked:* ]]; then
    echo "codex_proxy_boundary: ${name} should be blocked (${result})" >&2
    exit 1
  fi
  echo "codex_proxy_boundary: ${name} blocked"
}

expect_blocked "direct_control_api" "http://control-api.control-plane.svc.cluster.local:8090/health"
expect_blocked "postgres" "http://control-postgres.control-plane.svc.cluster.local:5432/"
expect_blocked "metadata" "http://169.254.169.254/"
expect_blocked "host_context_controller" "http://host-context-controller.control-plane.svc.cluster.local:8080/"
expect_blocked "workflow_recipes" "http://workflow-recipes.control-plane.svc.cluster.local:8080/"
expect_blocked "kubernetes_api" "https://kubernetes.default.svc.cluster.local/"

if [[ -n "${CODEX_UPSTREAM_FIXTURE_URL:-}" ]]; then
  fixture_result="$(probe_from_proxy -e '
const https = require("https");
const http = require("http");
const target = new URL(process.argv[1]);
const lib = target.protocol === "https:" ? https : http;
const req = lib.request(target, { method: "GET", timeout: 5000, rejectUnauthorized: false }, (res) => {
  res.resume();
  process.stdout.write("reachable:" + res.statusCode);
  process.exit(0);
});
req.on("timeout", () => { req.destroy(); process.stdout.write("timeout"); process.exit(2); });
req.on("error", (err) => {
  if (err && err.code === "ECONNREFUSED") { process.stdout.write("reachable:refused"); process.exit(0); }
  process.stdout.write(String((err && err.code) || err.message));
  process.exit(1);
});
req.end();
' "$CODEX_UPSTREAM_FIXTURE_URL")"
  if [[ "$fixture_result" != reachable:* ]]; then
    echo "codex_proxy_boundary: approved upstream fixture blocked (${fixture_result})" >&2
    exit 1
  fi
  echo "codex_proxy_boundary: approved upstream fixture reachable"
fi

echo "codex_proxy_boundary: live probes passed"
