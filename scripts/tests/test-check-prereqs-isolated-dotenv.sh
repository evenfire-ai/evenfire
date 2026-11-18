#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
repo="$tmp/repo"
bin="$tmp/bin"
mkdir -p "$repo/scripts/e2e" "$bin"
cp "$root/scripts/check-prereqs.sh" "$root/scripts/check-node-version.cjs" "$repo/scripts/"
cp "$root/scripts/e2e/load-dotenv.sh" "$root/scripts/e2e/admin-credentials.sh" "$repo/scripts/e2e/"
cp "$root/.nvmrc" "$repo/.nvmrc"
git init -q "$repo"

# These values exist only in this disposable fixture. The process-only mode
# must not use the fixture file even though it contains a valid password.
printf '%s\n' 'ADMIN_PASSWORD=fixture-file-password' > "$repo/.env"

cat > "$bin/kubectl" <<'STUB'
#!/bin/bash
printf '{"clientVersion":{"gitVersion":"v1.35.1"}}\n'
STUB
cat > "$bin/minikube" <<'STUB'
#!/bin/bash
printf 'v1.38.1\n'
STUB
cat > "$bin/ruby" <<'STUB'
#!/bin/bash
printf 'ruby 3.3.0\n'
STUB
cat > "$bin/docker" <<'STUB'
#!/bin/bash
case "$*" in
  *MemTotal*) printf '18039439360\n' ;;
  *NCPU*) printf '8\n' ;;
esac
STUB
chmod +x "$bin/kubectl" "$bin/minikube" "$bin/ruby" "$bin/docker"

run_check() {
  env -i HOME="$HOME" PATH="$bin:$PATH" "$@" bash "$repo/scripts/check-prereqs.sh" > "$tmp/output" 2>&1
}

if run_check E2E_DISABLE_CANONICAL_DOTENV=true ADMIN_PASSWORD=fixture-process-password &&
   grep -Fq 'isolated test environment' "$tmp/output" &&
   ! grep -Fq '.env     present' "$tmp/output"; then
  printf 'PASS: isolated prereqs use the process credential without loading .env\n'
else
  cat "$tmp/output" >&2
  printf 'FAIL: isolated prereqs did not use only the process environment\n' >&2
  exit 1
fi

for alias in E2E_ADMIN_PASSWORD TEST_ADMIN_PASSWORD ADMIN_PASS; do
  if run_check E2E_DISABLE_CANONICAL_DOTENV=true "$alias=fixture-process-password" &&
     grep -Fq 'isolated test environment' "$tmp/output"; then
    printf 'PASS: isolated prereqs accept %s\n' "$alias"
  else
    cat "$tmp/output" >&2
    printf 'FAIL: isolated prereqs rejected %s\n' "$alias" >&2
    exit 1
  fi
done

if run_check E2E_DISABLE_CANONICAL_DOTENV=true; then
  printf 'FAIL: isolated prereqs accepted a missing process credential\n' >&2
  exit 1
else
  printf 'PASS: isolated prereqs reject a missing process credential\n'
fi

if run_check && grep -Fq '.env     ADMIN_PASSWORD set' "$tmp/output"; then
  printf 'PASS: default prereqs still use the canonical .env\n'
else
  cat "$tmp/output" >&2
  printf 'FAIL: default prereqs did not use the canonical .env\n' >&2
  exit 1
fi
