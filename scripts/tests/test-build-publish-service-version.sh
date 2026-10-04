#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESOLVER="$ROOT/scripts/ci/resolve-package-version.cjs"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf -- "$WORK_DIR"' EXIT

workflow_block="$(sed -n '/id: buildargs/,/^[[:space:]]*id: build$/p' \
  "$ROOT/.github/workflows/build-publish.yml")"
if ! grep -Fq 'node scripts/ci/resolve-package-version.cjs "$MATRIX_PATH/package.json"' \
  <<< "$workflow_block"; then
  echo 'build-publish does not use the checked package-file version resolver' >&2
  exit 1
fi
grep -Fq 'service_version=unknown' <<< "$workflow_block"
grep -Fq 'echo "service-version=$service_version" >> "$GITHUB_OUTPUT"' \
  <<< "$workflow_block"

resolver_line="$(grep -nF 'node scripts/ci/resolve-package-version.cjs' <<< "$workflow_block" | cut -d: -f1)"
output_line="$(grep -nF '>> "$GITHUB_OUTPUT"' <<< "$workflow_block" | head -n1 | cut -d: -f1)"
[[ -n "$resolver_line" && -n "$output_line" && "$resolver_line" -lt "$output_line" ]]

fixture_root="$WORK_DIR/service fixture"
mkdir -p "$fixture_root/mcp-host"
printf '{"name":"mcp-host","version":"1.2.3-beta.1+build.5"}\n' \
  > "$fixture_root/mcp-host/package.json"
actual="$(cd "$fixture_root" && node "$RESOLVER" 'mcp-host/package.json')"
[[ "$actual" == '1.2.3-beta.1+build.5' ]]

repo_version="$(node "$RESOLVER" control-api/package.json)"
expected_version="$(node -p "require('$ROOT/control-api/package.json').version")"
[[ "$repo_version" == "$expected_version" ]]

output_file="$WORK_DIR/github-output"

run_version_output() {
  local package_path=$1
  local service_version=unknown

  if [ -f "$fixture_root/$package_path" ]; then
    if ! service_version="$(cd "$fixture_root" && node "$RESOLVER" "$package_path" 2>/dev/null)"; then
      return 1
    fi
  fi

  printf 'service-version=%s\n' "$service_version" >> "$output_file"
}

expect_invalid_package_to_fail_without_output() {
  local input=$1
  printf 'prior=preserved\n' > "$output_file"

  if run_version_output "$input"; then
    echo "workflow accepted invalid package input: $input" >&2
    return 1
  fi
  [[ "$(cat "$output_file")" == 'prior=preserved' ]]
}

printf '{"name":"missing-version"}\n' > "$fixture_root/mcp-host/package.json"
expect_invalid_package_to_fail_without_output mcp-host/package.json

printf '{"name":"empty-version","version":"  "}\n' > "$fixture_root/mcp-host/package.json"
expect_invalid_package_to_fail_without_output mcp-host/package.json

printf '{"name":"invalid-version","version":"1.2"}\n' > "$fixture_root/mcp-host/package.json"
expect_invalid_package_to_fail_without_output mcp-host/package.json

printf '{not-json}\n' > "$fixture_root/mcp-host/package.json"
expect_invalid_package_to_fail_without_output mcp-host/package.json

printf '{"name":"unreadable","version":"1.2.3"}\n' \
  > "$fixture_root/mcp-host/package.json"
chmod 000 "$fixture_root/mcp-host/package.json"
expect_invalid_package_to_fail_without_output mcp-host/package.json
chmod 600 "$fixture_root/mcp-host/package.json"

mkdir -p "$fixture_root/mcp-host/not-a-file"
if (cd "$fixture_root" && node "$RESOLVER" mcp-host/not-a-file >/dev/null 2>&1); then
  echo 'resolver accepted a non-file package path' >&2
  exit 1
fi

printf 'prior=preserved\n' > "$output_file"
grep -Fq 'path: nginx-egress-proxy' "$ROOT/.github/workflows/build-publish.yml"
[[ ! -f "$ROOT/nginx-egress-proxy/package.json" ]]
service_version=unknown
if [ -f "$ROOT/nginx-egress-proxy/package.json" ]; then
  service_version="$(node "$RESOLVER" nginx-egress-proxy/package.json)"
fi
printf 'service-version=%s\n' "$service_version" >> "$output_file"
grep -Fxq 'prior=preserved' "$output_file"
grep -Fxq 'service-version=unknown' "$output_file"

echo 'build-publish service-version checks passed'
