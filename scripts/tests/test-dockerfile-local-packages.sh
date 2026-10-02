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

assert_jwt_policy_runtime_context() {
  local service="$1" ignore="$REPO_ROOT/$1/Dockerfile.dockerignore"
  local actual expected
  expected="$(printf '%s\n' \
    '!packages/jwt-key-policy/' \
    '!packages/jwt-key-policy/package.json' \
    '!packages/jwt-key-policy/index.cjs' \
    '!packages/jwt-key-policy/index.d.ts' \
    '!packages/jwt-key-policy/dev-store.cjs' \
    '!packages/jwt-key-policy/dev-store.d.ts')"
  actual="$(awk 'index($0, "!packages/jwt-key-policy/") == 1 { print }' "$ignore")"
  if [[ "$actual" != "$expected" ]]; then
    fail "$service context must allow only the policy runtime files and types"
  fi
  assert_copy_before_first_ci "$service/Dockerfile" jwt-key-policy
  if ! grep -Fq '/app/packages' "$REPO_ROOT/$service/Dockerfile" || \
     ! grep -Fq "WORKDIR /app/$service" "$REPO_ROOT/$service/Dockerfile"; then
    fail "$service must preserve the runtime package/service file-link layout"
  fi
}

for service in control-api rpc-proxy external-rest-api; do
  assert_jwt_policy_runtime_context "$service"
done

assert_control_api_runtime_prune_after_builds() {
  local file="$REPO_ROOT/control-api/Dockerfile" final_build prune runtime
  final_build="$(line_of_last "$file" 'RUN npm run build')"
  prune="$(line_of_first "$file" 'RUN npm --prefix /app/packages/workflow-runtime-core prune --omit=dev')"
  runtime="$(awk '/^FROM / { count++; if (count == 2) { print NR; exit } }' "$file")"
  if [[ -z "$final_build" || -z "$prune" || -z "$runtime" || \
        "$prune" -le "$final_build" || "$prune" -ge "$runtime" ]]; then
    fail 'Control API must prune workflow-runtime-core dev dependencies after all builds, before runtime COPY'
  fi
}

assert_service_make_root_context() {
  local service="$1" target="${2:-docker-build}" from_root from_service expected
  if [[ "$target" == docker-push-cross ]]; then
    expected="docker buildx build --platform linux/amd64 -f \"$REPO_ROOT/$service/Dockerfile\" -t example.invalid/evenfire/$service:fixture --push \"$REPO_ROOT\""
  else
    expected="docker build -f \"$REPO_ROOT/$service/Dockerfile\" -t example.invalid/evenfire/$service:fixture \"$REPO_ROOT\""
  fi
  from_root="$(cd "$REPO_ROOT" && make -n -f "$service/Makefile" "$target" REGISTRY=example.invalid/evenfire TAG=fixture)"
  from_service="$(cd "$REPO_ROOT/$service" && make -n "$target" REGISTRY=example.invalid/evenfire TAG=fixture)"
  if [[ "$from_root" != "$expected" || "$from_service" != "$expected" ]]; then
    fail "$service Make $target must use its explicit Dockerfile and root context from either supported cwd"
  fi
}

assert_service_secret_exclusions_after_allowlist() {
  local service="$1" ignore="$REPO_ROOT/$1/Dockerfile.dockerignore"
  local last_allow exclude_line pattern
  last_allow="$(awk '/^!/ { line=NR } END { print line+0 }' "$ignore")"
  for pattern in '**/.dev-keys/' '**/.env' '**/.env.*' '**/*.pem' '**/*.key'; do
    exclude_line="$(awk -v pattern="$pattern" '$0 == pattern { line=NR } END { print line+0 }' "$ignore")"
    if [[ "$exclude_line" -le "$last_allow" ]]; then
      fail "$service context must exclude $pattern after all allow rules, including nested src files"
    fi
  done
}

assert_control_api_runtime_prune_after_builds
for service in control-api rpc-proxy external-rest-api; do
  assert_service_make_root_context "$service"
  assert_service_secret_exclusions_after_allowlist "$service"
done
assert_service_make_root_context rpc-proxy docker-push-cross

# Direct consumers.  The first four are Node services; profile-ui and
# control-ui are Next.js consumers and therefore also require materialization.
assert_copy_before_every_ci control-api/Dockerfile \
  display-field grok-provider-attempt-contract image-policy llm-provider-attempt-contract \
  llm-providers workflow-recipe-capability-policy workflow-runtime-core
assert_copy_before_every_ci control-ui/Dockerfile \
  display-field frontend-components gfs-interaction-policy llm-providers workflow-recipe-capability-policy
assert_copy_before_every_ci profile-ui/Dockerfile desktop-app-links frontend-components
assert_copy_before_every_ci host-context-controller/Dockerfile \
  image-policy llm-providers network-policy-core workflow-recipe-capability-policy
assert_copy_before_every_ci mcp-host/Dockerfile \
  gfs-interaction-policy grok-provider-attempt-contract llm-provider-attempt-contract llm-providers
assert_copy_before_every_ci mcp-host/Dockerfile.desktop \
  gfs-interaction-policy grok-provider-attempt-contract llm-provider-attempt-contract llm-providers
assert_copy_before_every_ci mcp-host/Dockerfile.full \
  gfs-interaction-policy grok-provider-attempt-contract llm-provider-attempt-contract llm-providers
assert_copy_before_every_ci mcp-host/Dockerfile.slim \
  gfs-interaction-policy grok-provider-attempt-contract llm-provider-attempt-contract llm-providers

# workflow-runtime-core is built in a separate stage before workflow-recipes;
# these are the packages needed by that stage, while the application install
# also needs the recipe and image policy packages in its final stage.
assert_copy_before_every_ci workflow-recipes/Dockerfile \
  grok-provider-attempt-contract llm-provider-attempt-contract llm-providers \
  network-policy-core workflow-runtime-core
assert_copy_before_every_ci workflow-recipes/Dockerfile.coordinator \
  grok-provider-attempt-contract llm-provider-attempt-contract llm-providers \
  network-policy-core workflow-runtime-core
assert_copy_before_last_ci workflow-recipes/Dockerfile workflow-recipe-capability-policy
assert_copy_before_last_ci workflow-recipes/Dockerfile image-policy
assert_copy_before_last_ci workflow-recipes/Dockerfile.coordinator workflow-recipe-capability-policy
assert_copy_before_last_ci workflow-recipes/Dockerfile.coordinator image-policy

assert_materialized control-ui/Dockerfile display-field
assert_materialized control-ui/Dockerfile frontend-components
assert_materialized control-ui/Dockerfile gfs-interaction-policy
assert_materialized control-ui/Dockerfile llm-providers
assert_materialized control-ui/Dockerfile workflow-recipe-capability-policy
assert_materialized profile-ui/Dockerfile desktop-app-links
assert_materialized profile-ui/Dockerfile frontend-components

assert_dockerignore_allows control-api/Dockerfile.dockerignore display-field
assert_dockerignore_allows control-api/Dockerfile.dockerignore grok-provider-attempt-contract
assert_dockerignore_allows control-api/Dockerfile.dockerignore llm-provider-attempt-contract
assert_dockerignore_allows control-api/Dockerfile.dockerignore llm-providers
assert_dockerignore_allows workflow-recipes/Dockerfile.dockerignore grok-provider-attempt-contract
assert_dockerignore_allows workflow-recipes/Dockerfile.coordinator.dockerignore grok-provider-attempt-contract
assert_dockerignore_allows control-ui/Dockerfile.dockerignore display-field
assert_dockerignore_allows control-ui/Dockerfile.dockerignore gfs-interaction-policy
assert_dockerignore_allows control-ui/Dockerfile.dockerignore llm-providers
assert_dockerignore_excludes_generated_dependencies \
  control-ui/Dockerfile.dockerignore gfs-interaction-policy
assert_dockerignore_narrow_package control-ui/Dockerfile.dockerignore frontend-components
assert_dockerignore_excludes_generated_dependencies \
  control-ui/Dockerfile.dockerignore frontend-components
assert_dockerignore_mutations_rejected

if (( failures > 0 )); then
  echo "$failures Docker local-package contract failure(s)" >&2
  exit 1
fi

echo "PASS: Docker local-package COPY/npm ci/materialization contract"
