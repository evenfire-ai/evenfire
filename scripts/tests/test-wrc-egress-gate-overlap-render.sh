#!/usr/bin/env bash
# The WRC egress degradation E2E (make test-e2e-wrc-egress-degradation) runs on
# a minikube branch profile and bounds its autonomous-recovery wait by the
# stored DNS window, TTL + WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS. Above
# maxSupportedExternalEgressOverlapSeconds() (scripts/e2e/_lib/wrc-egress-gate.cjs)
# the gate refuses with DNS_WINDOW_EXCEEDS_GATE_RECOVERY_BUDGET, so every
# shipped minikube overlay must pin the WRC overlap at or below that bound.
# deploy/base uses 3600 s, which is above it; the minikube overlay pins 300 s
# (deploy/overlays/minikube/patches/wrc-external-egress-overlap.yaml).
#
# usage: test-wrc-egress-gate-overlap-render.sh <overlay>=<rendered-yaml> ...
# The deploy-manifest-check job renders the four overlays and passes them here.
#
# For the control-plane/workflow-recipes Deployment it asserts:
#   - the container workflow-recipes exists (the render really contains WRC);
#   - WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS is a literal integer (absent or
#     valueFrom is "not pinned": the value would come from somewhere else);
#   - the value is <= the bound the gate module exports.
# A negative control sets 3600 in the first render and requires the same check
# to reject it, so the check cannot pass vacuously.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GATE="$ROOT/scripts/e2e/_lib/wrc-egress-gate.cjs"
EXPECTED_OVERLAYS="minikube minikube-ghcr minikube-no-uis minikube-no-uis-ghcr"
FAIL=0
CHECKED=0
OVERLAY_PASSES=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

command -v ruby >/dev/null 2>&1 || { echo "FAIL: ruby is required to parse the renders"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "FAIL: node is required to read the gate bound"; exit 1; }

# shellcheck disable=SC2016 # JavaScript source; the template literal is not shell.
if ! BOUND="$(node -e '
  const gate = require(process.argv[1])
  const bound = gate.maxSupportedExternalEgressOverlapSeconds()
  if (!Number.isInteger(bound) || bound <= 0) throw new Error(`bad bound ${bound}`)
  console.log(bound)
' "$GATE" 2>&1)"; then
  echo "FAIL: cannot read maxSupportedExternalEgressOverlapSeconds() from $GATE: $BOUND"
  exit 1
fi
echo "gate bound: WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS <= $BOUND"

# wrc_overlap <rendered-yaml> [inject-value]
# Prints the pinned overlap in seconds, or exits 1 with the reason.
wrc_overlap() {
  RUBYOPT=--disable=gems ruby -ryaml -e '
    docs = YAML.load_stream(File.read(ARGV.fetch(0), encoding: "UTF-8")).select { |d| d.is_a?(Hash) }
    dep = docs.find do |d|
      d["kind"] == "Deployment" &&
        d.dig("metadata", "name") == "workflow-recipes" &&
        d.dig("metadata", "namespace") == "control-plane"
    end
    abort("missing control-plane/Deployment/workflow-recipes") unless dep
    containers = dep.dig("spec", "template", "spec", "containers") || []
    c = containers.find { |x| x["name"] == "workflow-recipes" }
    abort("missing container workflow-recipes") unless c
    env = (c["env"] ||= [])
    if ARGV[1]
      env.reject! { |e| e["name"] == "WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS" }
      env << { "name" => "WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS", "value" => ARGV[1] }
    end
    entries = env.select { |e| e["name"] == "WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS" }
    abort("WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS is set more than once") if entries.size > 1
    abort("WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS is not pinned (absent)") if entries.empty?
    abort("WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS is not pinned (valueFrom)") if entries[0].key?("valueFrom")
    value = entries[0]["value"].to_s
    abort("WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS=#{value.inspect} is not a literal integer") unless value.match?(/\A[0-9]+\z/)
    puts value
  ' "$@"
}

# within_bound <rendered-yaml> [inject-value]: 0 when pinned at or below BOUND.
within_bound() {
  local value
  if ! value="$(wrc_overlap "$@" 2>&1)"; then
    REASON="$value"
    return 1
  fi
  if [ "$value" -gt "$BOUND" ]; then
    REASON="WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS=$value exceeds the gate bound $BOUND"
    return 1
  fi
  REASON="WRC_EXTERNAL_EGRESS_OVERLAP_SECONDS=$value <= $BOUND"
  return 0
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
  CHECKED=$((CHECKED + 1))
  [ -n "$first_render" ] || first_render="$rendered"
  if within_bound "$rendered"; then
    pass "$overlay renders WRC with $REASON"
    OVERLAY_PASSES=$((OVERLAY_PASSES + 1))
  else
    fail "$overlay: $REASON"
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
elif within_bound "$first_render" 3600; then
  fail "negative control accepted 3600 s ($REASON); the check would not catch the deploy/base window"
else
  pass "negative control: a render pinning 3600 s is rejected ($REASON)"
fi

expected_count=$(echo "$EXPECTED_OVERLAYS" | wc -w | tr -d " ")
if [ "$OVERLAY_PASSES" -ne "$expected_count" ]; then
  fail "$OVERLAY_PASSES of $expected_count overlays passed"
fi

echo "OVERLAYS_CHECKED=$CHECKED OVERLAYS_PASSED=$OVERLAY_PASSES"
exit "$FAIL"
