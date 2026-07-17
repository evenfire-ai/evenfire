#!/usr/bin/env bash
# ======================================================================
# Verify Secret Keys — pre-rollout sanity check
# ======================================================================
#
# After `kubectl apply`, Deployments reference Secrets via secretKeyRef
# and envFrom.secretRef. If the referenced keys don't exist, pods enter
# CreateContainerConfigError or CrashLoopBackOff — and the only signal
# is a 120s rollout timeout.
#
# This script inspects every Deployment across the target namespaces,
# extracts Secret references, and verifies each key exists on the
# cluster. Runs in ~5s and gives an actionable error message.
#
# Usage:
#   ./deploy/scripts/verify-secrets.sh [NAMESPACE...]
#   CONTEXT=gke_... ./deploy/scripts/verify-secrets.sh
#
# If no namespaces are given, defaults to the standard Clerum set.
# ======================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

kctl() {
  if [ -n "${CONTEXT:-}" ]; then
    kubectl --context "$CONTEXT" "$@"
  else
    kubectl "$@"
  fi
}

DEFAULT_NAMESPACES="channels control-plane mcp-host mcp-server profiles registry rpc-proxy sandbox-recipes"
NAMESPACES="${*:-$DEFAULT_NAMESPACES}"

missing=0
checked=0

echo -e "${CYAN}[verify-secrets]${NC} Checking Secret references in Deployments..."
echo ""

for ns in $NAMESPACES; do
  # Get all Deployments in this namespace as JSON
  deploys_json=$(kctl get deploy -n "$ns" -o json 2>/dev/null || echo '{"items":[]}')
  deploy_count=$(echo "$deploys_json" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('items',[])))" 2>/dev/null || echo "0")

  if [[ "$deploy_count" == "0" ]]; then
    continue
  fi

  # Extract all secretKeyRef entries: (deployName, secretName, key)
  # and all envFrom.secretRef entries: (deployName, secretName)
  refs=$(echo "$deploys_json" | python3 -c "
import json, sys

data = json.load(sys.stdin)
refs = []

for deploy in data.get('items', []):
    dname = deploy['metadata']['name']
    for container in deploy['spec']['template']['spec'].get('containers', []):
        # envFrom → secretRef (all keys in the secret are loaded)
        for ef in container.get('envFrom', []):
            sr = ef.get('secretRef')
            if sr:
                optional = ef.get('optional', sr.get('optional', False))
                refs.append(('secretRef', dname, sr['name'], '*', str(optional)))

        # env → valueFrom → secretKeyRef (specific key)
        for env in container.get('env', []):
            vf = env.get('valueFrom', {})
            skr = vf.get('secretKeyRef')
            if skr:
                optional = skr.get('optional', False)
                refs.append(('secretKeyRef', dname, skr['name'], skr['key'], str(optional)))

for r in refs:
    print('|'.join(r))
" 2>/dev/null || true)

  if [[ -z "$refs" ]]; then
    continue
  fi

  ns_header_shown=false

  while IFS='|' read -r ref_type deploy_name secret_name key_name optional; do
    [[ -z "$ref_type" ]] && continue

    # Skip optional refs — K8s won't block the pod if they're missing
    if [[ "$optional" == "True" ]]; then
      continue
    fi

    checked=$((checked + 1))

    if [[ "$ref_type" == "secretRef" ]]; then
      # Check the Secret itself exists
      if ! kctl get secret "$secret_name" -n "$ns" >/dev/null 2>&1; then
        if [[ "$ns_header_shown" == false ]]; then
          echo -e "${BOLD}── $ns ──${NC}"
          ns_header_shown=true
        fi
        echo -e "  ${RED}MISSING${NC}  Secret ${BOLD}$secret_name${NC} (used by deploy/$deploy_name via envFrom.secretRef)"
        missing=$((missing + 1))
      fi
    else
      # secretKeyRef — check specific key
      val=$(kctl get secret "$secret_name" -n "$ns" -o jsonpath="{.data.${key_name}}" 2>/dev/null || echo "")
      if [[ -z "$val" ]]; then
        if [[ "$ns_header_shown" == false ]]; then
          echo -e "${BOLD}── $ns ──${NC}"
          ns_header_shown=true
        fi
        # Distinguish "secret missing" from "key missing"
        if ! kctl get secret "$secret_name" -n "$ns" >/dev/null 2>&1; then
          echo -e "  ${RED}MISSING${NC}  Secret ${BOLD}$secret_name${NC} (used by deploy/$deploy_name)"
        else
          echo -e "  ${RED}MISSING${NC}  Key ${BOLD}$key_name${NC} in Secret ${BOLD}$secret_name${NC} (used by deploy/$deploy_name)"
        fi
        missing=$((missing + 1))
      fi
    fi
  done <<< "$refs"
done

echo ""
if [[ $missing -gt 0 ]]; then
  echo -e "${RED}${BOLD}FAILED${NC}: $missing Secret reference(s) missing out of $checked checked."
  echo ""
  echo -e "${YELLOW}To fix:${NC}"
  echo "  • For dev cluster:  make gcp-dev-gen-keys   (regenerates all secrets including desktop tokens)"
  echo "  • For prod cluster: CONFIRM=yes make gcp-prod-gen-keys"
  echo "  • For minikube:     make minikube-gen-keys"
  echo ""
  echo "Then re-run the deploy. Pods referencing missing Secrets will enter"
  echo "CreateContainerConfigError or CrashLoopBackOff until the keys are seeded."
  exit 1
else
  echo -e "${GREEN}${BOLD}OK${NC}: All $checked Secret reference(s) verified."
fi
