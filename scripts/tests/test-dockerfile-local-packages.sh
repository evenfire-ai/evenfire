#!/usr/bin/env bash
set -euo pipefail

# Contract for Docker builds that consume workspace packages through
# `file:../packages/*`.  A package must be in the build context before the
# npm install that resolves it.  Next.js builds additionally require a real
# node_modules copy because its bundler does not reliably follow workspace
# symlinks.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
failures=0

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

line_of_first() {
  local file="$1"
  local pattern="$2"
  awk -v pattern="$pattern" 'index($0, pattern) { print NR; exit }' "$file"
}

line_of_last() {
  local file="$1"
  local pattern="$2"
  awk -v pattern="$pattern" 'index($0, pattern) { line=NR } END { if (line) print line }' "$file"
}

assert_copy_before_first_ci() {
  local file="$1"
  local package="$2"
  local copy_line ci_line
  copy_line="$(line_of_first "$REPO_ROOT/$file" "COPY packages/$package")"
  ci_line="$(line_of_first "$REPO_ROOT/$file" "RUN npm ci")"
  if [[ -z "$copy_line" || -z "$ci_line" || "$copy_line" -ge "$ci_line" ]]; then
    fail "$file must COPY packages/$package before its first npm ci"
  fi
}

assert_copy_before_every_ci() {
  local file="$1"
  local packages=(${@:2})
  local current_stage=0
  local copied=""
  local line_no=0
  local line package

  while IFS= read -r line; do
    line_no=$((line_no + 1))
    if [[ "$line" == FROM\ * ]]; then
      current_stage=$((current_stage + 1))
      copied=""
      continue
    fi
    for package in "${packages[@]}"; do
      if [[ "$line" == "COPY packages/$package"* ]]; then
        copied="$copied|$package|"
      fi
    done
    if [[ "$line" == "RUN npm ci"* ]]; then
      for package in "${packages[@]}"; do
        if [[ "$copied" != *"|$package|"* ]]; then
          fail "$file stage $current_stage must COPY packages/$package before npm ci at line $line_no"
        fi
      done
    fi
  done < "$REPO_ROOT/$file"
}

assert_copy_before_last_ci() {
  local file="$1"
  local package="$2"
  local copy_line ci_line
  copy_line="$(line_of_last "$REPO_ROOT/$file" "COPY packages/$package")"
  ci_line="$(line_of_last "$REPO_ROOT/$file" "RUN npm ci")"
  if [[ -z "$copy_line" || -z "$ci_line" || "$copy_line" -ge "$ci_line" ]]; then
    fail "$file must COPY packages/$package before its last npm ci"
  fi
}

assert_materialized() {
  local file="$1"
  local package="$2"
  local expected="cp -R ../packages/$package node_modules/@clerum/$package"
  if ! grep -Fq "$expected" "$REPO_ROOT/$file"; then
    fail "$file must materialize @clerum/$package in node_modules"
  fi
}

assert_dockerignore_allows() {
  local file="$1"
  local package="$2"
  local ignore="$REPO_ROOT/$file"
  if ! grep -Fq "!packages/$package/" "$ignore" || \
     ! grep -Fq "!packages/$package/**" "$ignore"; then
    fail "$file must explicitly allow packages/$package in its Docker context"
  fi
}

assert_dockerignore_excludes_generated_dependencies() {
  local file="$1"
  local package="$2"
  local ignore="$file"
  local allow_line exclude_line
  if [[ "$ignore" != /* ]]; then
    ignore="$REPO_ROOT/$file"
  fi
  allow_line="$(
    awk -v pattern="!packages/$package/" \
      '$0 == pattern { line=NR } END { if (line) print line }' "$ignore"
  )"
  exclude_line="$(
    awk -v pattern="packages/$package/node_modules/" \
      '$0 == pattern { line=NR } END { if (line) print line }' "$ignore"
  )"
  if [[ -z "$allow_line" || -z "$exclude_line" || "$exclude_line" -le "$allow_line" ]]; then
    fail "$file must exclude packages/$package/node_modules from its Docker context"
  fi
}

assert_dockerignore_narrow_package() {
  local file="$1"
  local package="$2"
  local ignore="$file"
  local expected actual
  if [[ "$ignore" != /* ]]; then
    ignore="$REPO_ROOT/$file"
  fi
  expected="$(printf '%s\n' \
    "!packages/$package/" \
    "!packages/$package/package.json" \
    "!packages/$package/src/" \
    "!packages/$package/src/index.tsx" \
    "!packages/$package/styles.css")"
  actual="$(awk -v prefix="!packages/$package/" 'index($0, prefix) == 1 { print }' "$ignore")"
  if [[ "$actual" != "$expected" ]]; then
    fail "$file must allow exactly the tracked packages/$package build files"
  fi
}

assert_dockerignore_mutations_rejected() {
  local fixture_dir negated_node_modules extra_secret
  fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/evenfire-dockerignore-contract.XXXXXX")"
  negated_node_modules="$fixture_dir/negated-node-modules"
  extra_secret="$fixture_dir/extra-secret"

  printf '%s\n' \
    '!packages/frontend-components/' \
    '!packages/frontend-components/package.json' \
    '!packages/frontend-components/src/' \
    '!packages/frontend-components/src/index.tsx' \
    '!packages/frontend-components/styles.css' \
    '!packages/frontend-components/node_modules/' > "$negated_node_modules"
  local before="$failures"
  assert_dockerignore_excludes_generated_dependencies \
    "$negated_node_modules" frontend-components 2>/dev/null
  if [[ "$failures" -eq "$before" ]]; then
    fail 'Docker context contract must reject a negated node_modules rule'
  else
    failures="$before"
  fi

  printf '%s\n' \
    '!packages/frontend-components/' \
    '!packages/frontend-components/package.json' \
    '!packages/frontend-components/src/' \
    '!packages/frontend-components/src/index.tsx' \
    '!packages/frontend-components/styles.css' \
    '!packages/frontend-components/.env' \
    'packages/frontend-components/node_modules/' > "$extra_secret"
  before="$failures"
  assert_dockerignore_narrow_package "$extra_secret" frontend-components 2>/dev/null
  if [[ "$failures" -eq "$before" ]]; then
    fail 'Docker context contract must reject an extra package-scoped allow rule'
  else
    failures="$before"
  fi

  rm -rf -- "$fixture_dir"
}

# Direct consumers.  The first four are Node services; profile-ui and
# control-ui are Next.js consumers and therefore also require materialization.
assert_copy_before_every_ci control-api/Dockerfile \
  display-field image-policy llm-providers workflow-recipe-capability-policy workflow-runtime-core
assert_copy_before_every_ci control-ui/Dockerfile \
  display-field frontend-components llm-providers workflow-recipe-capability-policy
assert_copy_before_every_ci profile-ui/Dockerfile desktop-app-links frontend-components
assert_copy_before_every_ci host-context-controller/Dockerfile \
  image-policy llm-providers network-policy-core workflow-recipe-capability-policy
assert_copy_before_every_ci mcp-host/Dockerfile llm-providers
assert_copy_before_every_ci mcp-host/Dockerfile.desktop llm-providers
assert_copy_before_every_ci mcp-host/Dockerfile.full llm-providers
assert_copy_before_every_ci mcp-host/Dockerfile.slim llm-providers

# workflow-runtime-core is built in a separate stage before workflow-recipes;
# these are the packages needed by that stage, while the application install
# also needs the recipe and image policy packages in its final stage.
assert_copy_before_every_ci workflow-recipes/Dockerfile llm-providers network-policy-core workflow-runtime-core
assert_copy_before_every_ci workflow-recipes/Dockerfile.coordinator llm-providers network-policy-core workflow-runtime-core
assert_copy_before_last_ci workflow-recipes/Dockerfile workflow-recipe-capability-policy
assert_copy_before_last_ci workflow-recipes/Dockerfile image-policy
assert_copy_before_last_ci workflow-recipes/Dockerfile.coordinator workflow-recipe-capability-policy
assert_copy_before_last_ci workflow-recipes/Dockerfile.coordinator image-policy

assert_materialized control-ui/Dockerfile display-field
assert_materialized control-ui/Dockerfile frontend-components
assert_materialized control-ui/Dockerfile llm-providers
assert_materialized control-ui/Dockerfile workflow-recipe-capability-policy
assert_materialized profile-ui/Dockerfile desktop-app-links
assert_materialized profile-ui/Dockerfile frontend-components

assert_dockerignore_allows control-api/Dockerfile.dockerignore display-field
assert_dockerignore_allows control-api/Dockerfile.dockerignore llm-providers
assert_dockerignore_allows control-ui/Dockerfile.dockerignore display-field
assert_dockerignore_allows control-ui/Dockerfile.dockerignore llm-providers
assert_dockerignore_narrow_package control-ui/Dockerfile.dockerignore frontend-components
assert_dockerignore_excludes_generated_dependencies \
  control-ui/Dockerfile.dockerignore frontend-components
assert_dockerignore_mutations_rejected

if (( failures > 0 )); then
  echo "$failures Docker local-package contract failure(s)" >&2
  exit 1
fi

echo "PASS: Docker local-package COPY/npm ci/materialization contract"
