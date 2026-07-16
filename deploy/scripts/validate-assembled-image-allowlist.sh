#!/usr/bin/env bash
# Renders the app-vs-config ASSEMBLED tree (public genericized base + private gcp overlay)
# and asserts the image-allowlist envs contain the real AR/registry prefixes and NO
# ${GCP_PROJECT}/example.com placeholders. This is the ONLY render check that catches the
# base-genericization gap — the monorepo (non-genericized) base renders real values either way.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "==> genericize base"
( cd "$ROOT/scripts/oss/snapshot" && npx tsx run.ts "$TMP/dist-public" >/dev/null )
fail=0
for env in gcp-dev gcp-prod; do
  work="$TMP/assembled-$env/deploy"
  mkdir -p "$work/overlays"
  cp -R "$TMP/dist-public/deploy/base" "$work/base"
  cp -R "$ROOT/deploy/overlays/$env" "$work/overlays/$env"
  rendered="$(kubectl kustomize "$work/overlays/$env")"
  # -A1: control-api renders `KEY: value` (one line); the HCC env renders `- name: …` then
  # `value: …` on the NEXT line — capture both.
  prefixes="$(printf '%s\n' "$rendered" | grep -A1 -E 'ALLOWED_IMAGE_PREFIXES' || true)"
  echo "--- $env allowlist lines ---"; printf '%s\n' "$prefixes"
  if ! printf '%s\n' "$prefixes" | grep -q 'us-central1-docker.pkg.dev/your-gcp-project/clerum/'; then
    echo "::error::[$env] allowlist missing real AR prefix"; fail=1
  fi
  if printf '%s\n' "$prefixes" | grep -qE '\$\{GCP_PROJECT\}|example\.com/'; then
    echo "::error::[$env] allowlist contains a genericized placeholder"; fail=1
  fi
done
[ "$fail" -eq 0 ] && echo "OK: assembled allowlist render is real in gcp-dev + gcp-prod"
exit "$fail"
