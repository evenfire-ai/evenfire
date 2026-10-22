#!/usr/bin/env bash
# Issue #825: every shipped minikube overlay must leave the HCC
# workspace-layout-merge flag at its default. Installations upgrading from
# 0.10.x/0.11.x rely on that default to merge split stateless PVC trees; an
# overlay that rendered "false" would start those Hosts on an empty database
# with no error (docs/deploy/host-pvc-layout-upgrade.md).
#
# usage: test-hcc-layout-merge-flag-render.sh <overlay>=<rendered-yaml> ...
# The deploy-manifest-check job renders the four overlays with
# `kubectl kustomize` and passes them here, as for the NP-08 contract.
#
# For the control-plane/host-context-controller Deployment it asserts:
#   - the container host-context-controller exists and sets
#     CONTEXT_MAPPER_HOST_IMAGE (the render really contains HCC);
#   - CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE is absent or exactly "true".
# A negative control adds "false" to the first render and requires the same
# check to reject it, so the check cannot pass vacuously.
set -u

EXPECTED_OVERLAYS="minikube minikube-ghcr minikube-no-uis minikube-no-uis-ghcr"
FAIL=0
CHECKED=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

command -v ruby >/dev/null 2>&1 || { echo "FAIL: ruby is required to parse the renders"; exit 1; }

# hcc_flag <rendered-yaml> [inject-false]
# Prints FLAG=<unset|value|valueFrom> for the HCC Deployment, or exits 1.
hcc_flag() {
  RUBYOPT=--disable=gems ruby -ryaml -e '
    docs = YAML.load_stream(File.read(ARGV.fetch(0))).select { |d| d.is_a?(Hash) }
    dep = docs.find do |d|
      d["kind"] == "Deployment" &&
        d.dig("metadata", "name") == "host-context-controller" &&
        d.dig("metadata", "namespace") == "control-plane"
    end
    abort("missing control-plane/Deployment/host-context-controller") unless dep
    containers = dep.dig("spec", "template", "spec", "containers") || []
    c = containers.find { |x| x["name"] == "host-context-controller" }
    abort("missing container host-context-controller") unless c
    env = (c["env"] ||= [])
    abort("container has no CONTEXT_MAPPER_HOST_IMAGE") unless env.any? { |e| e["name"] == "CONTEXT_MAPPER_HOST_IMAGE" }
    if ARGV[1] == "inject-false"
      env.reject! { |e| e["name"] == "CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE" }
      env << { "name" => "CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE", "value" => "false" }
    end
    flag = env.select { |e| e["name"] == "CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE" }
    abort("CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE is set more than once") if flag.size > 1
    if flag.empty?
      puts "FLAG=unset"
    elsif flag[0].key?("valueFrom")
      puts "FLAG=valueFrom"
    else
      puts "FLAG=#{flag[0]["value"]}"
    end
  ' "$@"
}

flag_is_default() {
  case "$1" in
    FLAG=unset | FLAG=true) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <overlay>=<rendered-yaml> ..." >&2
  exit 2
fi

seen=""
first_render=""
for arg in "$@"; do
  overlay="${arg%%=*}"
  rendered="${arg#*=}"
  if [ "$overlay" = "$arg" ] || [ ! -s "$rendered" ]; then
    fail "argument '$arg' is not <overlay>=<non-empty rendered yaml>"
    continue
  fi
  seen="$seen $overlay"
  if ! flag="$(hcc_flag "$rendered" 2>&1)"; then
    fail "$overlay: $flag"
    continue
  fi
  CHECKED=$((CHECKED + 1))
  [ -n "$first_render" ] || first_render="$rendered"
  if flag_is_default "$flag"; then
    pass "$overlay renders HCC with the merge flag at its default ($flag)"
  else
    fail "$overlay renders HCC with $flag; shipped overlays must leave it unset or \"true\""
  fi
done

for expected in $EXPECTED_OVERLAYS; do
  case " $seen " in
    *" $expected "*) ;;
    *) fail "overlay $expected was not checked" ;;
  esac
done

if [ -z "$first_render" ]; then
  fail "negative control has no render to mutate"
elif ! control="$(hcc_flag "$first_render" inject-false 2>&1)"; then
  fail "negative control: $control"
elif flag_is_default "$control"; then
  fail "negative control read $control; the check would not catch a render that sets \"false\""
else
  pass "negative control: a render setting \"false\" is rejected ($control)"
fi

echo "OVERLAYS_CHECKED=$CHECKED"
exit "$FAIL"
