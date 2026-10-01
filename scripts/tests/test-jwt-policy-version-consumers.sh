#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$REPO_ROOT/scripts/tests/lib/minikube-fixture-repo.sh"
fixture_root="$(mktemp -d)"
minikube_test_fixture_repo_init "$REPO_ROOT" "$fixture_root"
fixture_repo="$MINIKUBE_TEST_PROJECT_DIR"
cleanup() {
  local status=$?
  trap - EXIT
  minikube_test_assert_host_unchanged || status=1
  rm -rf -- "$fixture_root"
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$fixture_repo/scripts/precommit" "$fixture_repo/scripts/prettier" \
  "$fixture_repo/scripts/release" "$fixture_repo/packages/jwt-key-policy"
cp "$REPO_ROOT/scripts/precommit/bump-staged-package-versions.mjs" "$fixture_repo/scripts/precommit/"
cp "$REPO_ROOT/scripts/prettier/paths.mjs" "$fixture_repo/scripts/prettier/"
cp "$REPO_ROOT/scripts/release/"{release-coordinates,update-desktop-release-manifest,validate-release-version-bumps}.mjs \
  "$fixture_repo/scripts/release/"
cp "$REPO_ROOT/packages/jwt-key-policy/package.json" "$fixture_repo/packages/jwt-key-policy/"
for service in control-api rpc-proxy external-rest-api desktop-app; do
  mkdir -p "$fixture_repo/$service"
  cp "$REPO_ROOT/$service/package.json" "$fixture_repo/$service/"
done
mkdir -p "$fixture_repo/external-rest-api/src"
cp "$REPO_ROOT/external-rest-api/src/releaseManifest.ts" "$fixture_repo/external-rest-api/src/"
printf 'module.exports = { revision: 1 }\n' >"$fixture_repo/packages/jwt-key-policy/index.cjs"
git -C "$fixture_repo" add .
git -C "$fixture_repo" commit -qm baseline
baseline="$(git -C "$fixture_repo" rev-parse HEAD)"
printf 'module.exports = { revision: 2 }\n' >"$fixture_repo/packages/jwt-key-policy/index.cjs"
git -C "$fixture_repo" add packages/jwt-key-policy/index.cjs

(cd "$fixture_repo" && node scripts/precommit/bump-staged-package-versions.mjs >/dev/null)
node --input-type=module - "$fixture_repo" "$baseline" <<'NODE'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const [root, baseline] = process.argv.slice(2)
for (const service of ['control-api', 'rpc-proxy', 'external-rest-api']) {
  const before = JSON.parse(execFileSync('git', ['-C', root, 'show', `${baseline}:${service}/package.json`], { encoding: 'utf8' }))
  const after = JSON.parse(readFileSync(join(root, service, 'package.json'), 'utf8'))
  const parts = before.version.split('.').map(Number)
  parts[2]++
  assert.equal(after.version, parts.join('.'), `${service} must bump for a shared runtime change`)
}
NODE
git -C "$fixture_repo" commit -qm policy
(cd "$fixture_repo" && node scripts/release/validate-release-version-bumps.mjs --previous "$baseline" --current HEAD)
printf 'PASS: a package-only JWT policy change bumps all consumers and validates release counters\n'
