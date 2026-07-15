#!/usr/bin/env bash
# RBAC drift gate for the ingress namespace (spec §13, HIGH-2).
# Fails if cloudflared-config-editor gains a RoleBinding, or if any bound
# ClusterRole grants cluster-wide configmap patch.
#
# Usage: CONTEXT=<kube-context> scripts/e2e/e2e-cluster-ingress-rbac.sh
set -euo pipefail

if [ -z "${CONTEXT:-}" ]; then
  echo "ERROR: CONTEXT must be set (kube-context to target)." >&2
  exit 2
fi
case "$CONTEXT" in
  clerum-test|gke_your-gcp-project_us-central1-a_example-dev|gke_your-gcp-project_us-central1-a_clerum) ;;
  *) echo "ERROR: CONTEXT '$CONTEXT' is not an allowed Clerum context." >&2; exit 2 ;;
esac

K() { kubectl --context="$CONTEXT" "$@"; }

# Namespace guard: if ingress is absent, fail with a clear message rather than
# letting set -e abort on a raw kubectl error.
if ! K get ns ingress >/dev/null 2>&1; then
  echo "FAIL: namespace 'ingress' not found on $CONTEXT — deploy the ingress slice first" >&2
  exit 1
fi

fail=0

# 1. No RoleBinding in the ingress namespace BINDS cloudflared-config-editor.
# Match by roleRef.name only (NOT metadata.name — a RoleBinding's metadata.name
# may coincidentally equal the Role name without actually binding it).
bindings=$(K -n ingress get rolebindings -o json | python3 -c '
import json, sys
data = json.load(sys.stdin)
for rb in data.get("items", []):
    if (rb.get("roleRef") or {}).get("name") == "cloudflared-config-editor":
        print(rb["metadata"]["name"])
')
if [ -n "$bindings" ]; then
  echo "FAIL: a RoleBinding binds cloudflared-config-editor in ns/ingress" >&2
  echo "  binding RoleBindings: $bindings" >&2
  K -n ingress get rolebindings -o wide >&2
  fail=1
else
  echo "PASS: cloudflared-config-editor is unbound"
fi

# 2. No bound NON-BASELINE ClusterRole grants patch on configmaps cluster-wide.
# `cluster-admin` and `system:*` are k8s/GKE control-plane baselines (garbage
# collector, root-ca-cert-publisher, gke-controller, ...). They legitimately
# have broad configmap access; flagging them is noise. The gate's intent is to
# catch a NEW broad ClusterRole an operator or controller added, not the
# day-0 baseline. If a new managed-K8s vendor ships another baseline name,
# extend the allowlist below.
offenders=$(K get clusterroles -o json | python3 -c '
import json, sys
data = json.load(sys.stdin)
for cr in data.get("items", []):
    name = cr["metadata"]["name"]
    if name == "cluster-admin" or name.startswith("system:"):
        continue
    for rule in cr.get("rules", []) or []:
        groups = rule.get("apiGroups", [])
        res = rule.get("resources", [])
        verbs = rule.get("verbs", [])
        cm = ("configmaps" in res) or ("*" in res)
        grp = ("" in groups) or ("*" in groups)
        vb = ("patch" in verbs) or ("update" in verbs) or ("*" in verbs)
        if cm and grp and vb and not rule.get("resourceNames"):
            print(name); break
')
drift=0
while IFS= read -r cr; do
  [ -z "$cr" ] && continue
  # Match roleRef.name only — see Check 1 comment for why.
  if K get clusterrolebindings -o json | python3 -c '
import json, sys
data = json.load(sys.stdin)
target = sys.argv[1]
hit = any(((crb.get("roleRef") or {}).get("name") == target) for crb in data.get("items", []))
sys.exit(0 if hit else 1)
' "$cr"; then
    echo "FAIL: bound ClusterRole '$cr' grants cluster-wide configmap patch" >&2
    drift=1
  fi
done <<< "$offenders"
if [ "$drift" -eq 0 ]; then
  echo "PASS: no bound ClusterRole grants cluster-wide configmap patch"
else
  fail=1
fi

if [ "$fail" -eq 0 ]; then echo "ingress RBAC gate passed"; fi
exit "$fail"
