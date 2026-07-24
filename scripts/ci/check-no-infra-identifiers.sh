#!/usr/bin/env bash
#
# CI guard: fail if any internal infrastructure identifier leaked into the
# public tree. The public repo (evenfire-ai/evenfire) must never carry the
# private GCP project, GKE cluster/context names, or non-sanctioned
# *.evenfire.ai hostnames — those live only in keyper-labs/evenfire-infra and
# are supplied by the infra overlays at assemble time.
#
# Sanctioned public hostnames (shared services that genericized public config
# legitimately references): registry / registration / brain .evenfire.ai.
#
# This checker necessarily names the forbidden patterns, so it excludes itself
# from the scan. Lockfiles are excluded — transitive registry URLs in a
# package-lock are not our identifiers.
#
# Scans the git-tracked tree only (what CI checks out). Exit 1 on any hit.

set -uo pipefail

EXCLUDES=(
  ':(exclude)scripts/ci/check-no-infra-identifiers.sh'
  ':(exclude)**/package-lock.json'
  ':(exclude)**/*.lock'
)

fail=0

flag() { # <label> <extended-regex>
  local label="$1" pattern="$2" hits
  hits="$(git grep -nIE "$pattern" -- "${EXCLUDES[@]}" 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    echo "::error::${label} must not appear in the public tree:"
    echo "$hits"
    fail=1
  fi
}

# 1. GCP project id + project number.
flag "GCP project id (eventfire-491421)" 'eventfire-491421'
flag "GCP project number (1043065809701)" '1043065809701'

# 2. Fully-qualified GKE context / cluster names (gke_<project>_<zone>_<cluster>).
flag "GKE context/cluster name (gke_eventfire-)" 'gke_eventfire-'

# 3. Non-sanctioned *.evenfire.ai hostnames.
#    Allow only the shared public services: registry / registration / brain.
bad="$(
  git grep -nIE '[A-Za-z0-9_.-]+\.evenfire\.ai' -- "${EXCLUDES[@]}" 2>/dev/null \
    | grep -oE '[A-Za-z0-9_.-]+\.evenfire\.ai' \
    | grep -vE '^(registry|registration|brain)\.evenfire\.ai$' \
    | sort -u \
    || true
)"
if [ -n "$bad" ]; then
  echo "::error::Non-sanctioned *.evenfire.ai hostname(s) in the public tree (allow: registry/registration/brain):"
  echo "$bad" | sed 's/^/  /'
  echo "--- locations ---"
  while IFS= read -r host; do
    git grep -nIF "$host" -- "${EXCLUDES[@]}" 2>/dev/null || true
  done <<< "$bad"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "These identifiers belong in keyper-labs/evenfire-infra, not the public repo."
  echo "If a hostname is a NEW sanctioned shared service, extend the allowlist in"
  echo "scripts/ci/check-no-infra-identifiers.sh."
  exit 1
fi

echo "infra-identifier check: clean (no private GCP project / GKE context / non-sanctioned *.evenfire.ai)."
