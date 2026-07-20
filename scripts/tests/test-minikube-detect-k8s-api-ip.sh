#!/usr/bin/env bash
set -u
FAIL=0

# Focused test for deploy/scripts/minikube-detect-k8s-api-ip.sh.
#
# That script has two paths:
#   (a) TEMPLATE branch — when <PATCH_FILE>.template exists it RENDERS the
#       template into the (gitignored) PATCH_FILE, leaving the .template intact.
#   (b) legacy in-place rewrite — exercised by the gcp variant in
#       scripts/tests/test-gcp-scripts.sh (assert_detect_k8s_api_ip).
#
# The legacy path had coverage; this file covers the previously-untested
# TEMPLATE branch. As in the neighbor test, kubectl is stubbed on PATH so the
# endpoint IP is provided without a running cluster.

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

assert_detect_renders_template_branch() {
  local tmp overlay_dir template rendered ip
  tmp="$(mktemp -d)"
  ip="192.168.58.2"

  # Stub kubectl — always returns the endpoint IP (no cluster needed).
  cat > "$tmp/kubectl" <<STUB
#!/usr/bin/env bash
echo "$ip"
STUB
  chmod +x "$tmp/kubectl"

  overlay_dir="$tmp/overlay"
  mkdir -p "$overlay_dir/patches"
  template="$overlay_dir/patches/k8s-api-ip.yaml.template"
  rendered="$overlay_dir/patches/k8s-api-ip.yaml"

  # Fixture: a couple of `cidr: __K8S_API_IP__/32` sentinels, NO rendered file.
  cat > "$template" <<'YAML'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-k8s-api-egress-control-plane
  namespace: control-plane
spec:
  egress:
    - to:
        - ipBlock:
            cidr: __K8S_API_IP__/32
      ports:
        - port: 443
          protocol: TCP
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-k8s-api-egress-mcp-host
  namespace: mcp-host
spec:
  egress:
    - to:
        - ipBlock:
            cidr: __K8S_API_IP__/32
      ports:
        - port: 443
          protocol: TCP
YAML

  # Snapshot the template to prove the render leaves it byte-unchanged.
  cp "$template" "$tmp/template.orig"

  PATH="$tmp:$PATH" OVERLAY_DIR="$overlay_dir" CONTEXT=fake-context \
    bash deploy/scripts/minikube-detect-k8s-api-ip.sh >/dev/null 2>&1

  if [ ! -f "$rendered" ]; then
    fail "template branch did not create the rendered patch file"
    rm -rf "$tmp"
    return
  fi

  local total matched leftover
  total="$(grep -c 'cidr:' "$rendered" || true)"
  matched="$(grep -c "cidr: $ip/32" "$rendered" || true)"
  leftover="$(grep -c '__K8S_API_IP__' "$rendered" || true)"

  if [ "$total" -ge 2 ] && [ "$matched" -eq "$total" ] && [ "$leftover" -eq 0 ] \
     && cmp -s "$template" "$tmp/template.orig"; then
    pass "detect-k8s-api-ip renders template into gitignored patch, leaving .template intact"
  else
    fail "detect-k8s-api-ip template branch did not render correctly"
    echo "total=$total matched=$matched leftover=$leftover"
    echo "--- rendered ---"; cat "$rendered"
    echo "--- template diff vs orig ---"; cmp "$template" "$tmp/template.orig" || true
  fi

  rm -rf "$tmp"
}

assert_detect_renders_template_branch

exit $FAIL
