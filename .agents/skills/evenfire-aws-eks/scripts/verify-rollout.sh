#!/usr/bin/env bash
# Fail-loud rollout proof for an Evenfire EKS install. Read-only.
#
# Checks every Deployment in the rendered overlay by exact name (a missing or
# unready Deployment fails; an empty label selector cannot pass), then the
# HCC-spawned Deployments, the GlobalFileSystem phase, and container states
# that `status.phase` hides (CrashLoopBackOff pods report phase Running).
#
# Required env:
#   CONTEXT  kube-context
#   RENDER   file produced by `kubectl kustomize deploy/overlays/aws-eks`
set -uo pipefail

: "${CONTEXT:?set CONTEXT}"
: "${RENDER:?set RENDER to the rendered overlay file}"
TIMEOUT="${TIMEOUT:-300s}"
fail=0
k() { kubectl --context "$CONTEXT" "$@"; }
bad() { printf 'FAIL  %s\n' "$*"; fail=1; }

command -v ruby >/dev/null || { echo "verify-rollout: ruby is required" >&2; exit 2; }
[ -s "$RENDER" ] || { echo "verify-rollout: RENDER file is empty or missing" >&2; exit 2; }

rendered="$(ruby -ryaml -e '
  YAML.load_stream(File.read(ARGV[0])).compact.each do |d|
    next unless d["kind"] == "Deployment"
    puts "#{d["metadata"]["namespace"]} #{d["metadata"]["name"]}"
  end' "$RENDER")"
[ -n "$rendered" ] || { echo "verify-rollout: no Deployments found in RENDER" >&2; exit 2; }

echo "[1] Rendered platform Deployments"
while read -r ns name; do
  if k -n "$ns" rollout status "deployment/$name" --timeout="$TIMEOUT" >/dev/null 2>&1; then
    printf 'PASS  %s/%s\n' "$ns" "$name"
  else
    bad "$ns/$name not rolled out (missing, unready, or stuck)"
  fi
done <<<"$rendered"

echo "[2] HCC-managed Deployments (one per Host, GFS writer/reader)"
# HCC names each Host's Deployment after the Host, in the Host's namespace.
hosts="$(k get host -A -o jsonpath='{range .items[*]}{.metadata.namespace} {.metadata.name}{"\n"}{end}' 2>/dev/null || true)"
[ -n "$hosts" ] || bad "no Host objects found (instances not applied?)"
spawned="$(printf '%s\n%s\n%s\n' "$hosts" "gfs gfsc-writer" "gfs gfsc-reader" | awk 'NF')"
while read -r ns name; do
  if k -n "$ns" rollout status "deployment/$name" --timeout="$TIMEOUT" >/dev/null 2>&1; then
    printf 'PASS  %s/%s\n' "$ns" "$name"
  else
    bad "$ns/$name not rolled out (HCC has not reconciled it, or it is unready)"
  fi
done <<<"$spawned"

echo "[3] GlobalFileSystem phase"
phase="$(k -n gfs get globalfilesystem gfs -o jsonpath='{.status.phase}' 2>/dev/null || true)"
if [ "$phase" = Ready ]; then echo "PASS  gfs/gfs phase=Ready"; else bad "gfs/gfs phase=${phase:-<missing>}"; fi

echo "[4] Container states in Evenfire namespaces"
states="$(k get pods -A -o json | ruby -rjson -e '
  nss = %w[channels control-plane gfs ingress llm-hooks mcp-host mcp-server profiles rpc-proxy sandbox-recipes sandbox-ui webhook-ingress]
  badr = %w[CrashLoopBackOff ImagePullBackOff ErrImagePull CreateContainerConfigError CreateContainerError InvalidImageName RunContainerError]
  JSON.parse(STDIN.read)["items"].each do |p|
    next unless nss.include?(p["metadata"]["namespace"])
    Array(p.dig("status", "containerStatuses")).concat(Array(p.dig("status", "initContainerStatuses"))).each do |c|
      reason = c.dig("state", "waiting", "reason")
      if badr.include?(reason) || c["restartCount"].to_i > 5
        puts "#{p["metadata"]["namespace"]}/#{p["metadata"]["name"]} #{c["name"]} reason=#{reason || "-"} restarts=#{c["restartCount"]}"
      end
    end
  end')" || { bad "could not list pods"; states=""; }
if [ -n "$states" ]; then
  while read -r line; do bad "$line"; done <<<"$states"
else
  echo "PASS  no crash-looping, image-pull, or config-error containers"
fi

if [ "$fail" -ne 0 ]; then
  echo "verify-rollout: FAILED" >&2
  exit 1
fi
echo "verify-rollout: OK"
