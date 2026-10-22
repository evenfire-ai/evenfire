#!/usr/bin/env bash
# Contract for scripts/validate-nginx-images.sh: it passes the current tree,
# rejects every vulnerable or floating platform NGINX tag in both image
# families and names the file that carries it, accepts the fixed releases,
# enforces the pinned egress-proxy FROM line, and reports a failed scan.
#
# The validator runs on a copy of the files it reads, so injected cases never
# touch the checkout. Every injected case writes into a path the validator
# scans, and every rejection must name that path.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALIDATOR_REL="scripts/validate-nginx-images.sh"
WORK="$(mktemp -d)"
trap 'chmod -R u+rwX "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT
COPY="$WORK/repo"
OUT="$WORK/out"
failures=0
cases=0

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

# Copy the validator and every path it scans or requires, read from the
# validator itself so the copy cannot drift from what it checks.
copy_inputs() {
  local paths p
  paths="$(
    sed -n '/^scan_paths=(/,/^)/p' "$REPO_ROOT/$VALIDATOR_REL" | sed -n 's/^[[:space:]]*"\([^"]*\)"$/\1/p'
    sed -n 's/^require_[a-z_]* "\([^"]*\)".*/\1/p' "$REPO_ROOT/$VALIDATOR_REL"
  )"
  if [ -z "$paths" ]; then
    echo "FAIL: could not read scan or required paths from $VALIDATOR_REL" >&2
    exit 1
  fi
  mkdir -p "$COPY/scripts"
  cp "$REPO_ROOT/$VALIDATOR_REL" "$COPY/$VALIDATOR_REL"
  while IFS= read -r p; do
    [ -e "$REPO_ROOT/$p" ] || continue
    mkdir -p "$COPY/$(dirname "$p")"
    cp -R "$REPO_ROOT/$p" "$COPY/$(dirname "$p")/"
  done <<<"$paths"
}

run_validator() {
  PATH="$1" bash "$COPY/$VALIDATOR_REL" >"$OUT" 2>&1
}

expect_pass() {
  local scanner_path="$1" name="$2"
  cases=$((cases + 1))
  if ! run_validator "$scanner_path"; then
    fail "$name should pass: $(cat "$OUT")"
  elif ! grep -q '^OK -- ' "$OUT"; then
    fail "$name passed without the OK line: $(cat "$OUT")"
  fi
}

expect_fail_naming() {
  local scanner_path="$1" name="$2" expected="$3"
  cases=$((cases + 1))
  if run_validator "$scanner_path"; then
    fail "$name should fail: $(cat "$OUT")"
  elif ! grep -qF -- "$expected" "$OUT"; then
    fail "$name should name '$expected': $(cat "$OUT")"
  fi
}

# Scanned by the validator only since the October 2026 baseline: the whole
# recipe samples directory and scripts/e2e.
SAMPLE_REL="workflow-recipes/samples/zz-injected-nginx.yaml"
E2E_REL="scripts/e2e/zz-injected-nginx.sh"
REMOTE_MCP_REL="control-api/src/routes/admin/remoteMcp.ts"
DOCKERFILE_REL="nginx-egress-proxy/Dockerfile"

inject() {
  local rel="$1" image="$2"
  mkdir -p "$COPY/$(dirname "$rel")"
  printf '        image: %s\n' "$image" >"$COPY/$rel"
}

run_matrix() {
  local scanner="$1" scanner_path="$2" family tag image target

  expect_pass "$scanner_path" "[$scanner] the current tree"

  for family in nginx nginxinc/nginx-unprivileged; do
    for tag in 1.30.0 1.30.1 1.30.2 1.30.3 1.30.4 1.30.5 1.30.5-alpine \
      1.31.0 1.31.1 1.31.2 1.31.3 1.31.4 1.31.5 1.31.6 1.31.6-alpine \
      latest alpine stable mainline stable-alpine 1 1-alpine 1.30 1.30-alpine 1.31 \
      1.27-alpine 1.29.9; do
      image="$family:$tag"
      inject "$SAMPLE_REL" "$image"
      expect_fail_naming "$scanner_path" "[$scanner] $image in a recipe sample" "$SAMPLE_REL"
      rm -f "$COPY/$SAMPLE_REL"
    done

    for tag in 1.30.6 1.30.6-alpine 1.30.7 1.31.7 1.31.8 1.31.8-alpine 1.30.50 1.30.60 1.31.60; do
      image="$family:$tag"
      inject "$SAMPLE_REL" "$image"
      expect_pass "$scanner_path" "[$scanner] $image in a recipe sample"
      rm -f "$COPY/$SAMPLE_REL"
    done
  done

  for image in nginx:1.30.5-alpine nginxinc/nginx-unprivileged:1.27-alpine; do
    inject "$E2E_REL" "$image"
    expect_fail_naming "$scanner_path" "[$scanner] $image in scripts/e2e" "$E2E_REL"
    rm -f "$COPY/$E2E_REL"
  done

  cp "$COPY/$REMOTE_MCP_REL" "$WORK/remoteMcp.ts.orig"
  printf '// image: nginx:1.31.6\n' >>"$COPY/$REMOTE_MCP_REL"
  expect_fail_naming "$scanner_path" "[$scanner] nginx:1.31.6 in remoteMcp.ts" "$REMOTE_MCP_REL"
  cp "$WORK/remoteMcp.ts.orig" "$COPY/$REMOTE_MCP_REL"

  for image in nginx-egress-proxy clerum/nginx-egress-proxy:0.1.0; do
    inject "$SAMPLE_REL" "$image"
    expect_pass "$scanner_path" "[$scanner] unrelated string $image"
    rm -f "$COPY/$SAMPLE_REL"
  done

  # Scan errors must fail the guard instead of reading as "nothing found".
  target="$COPY/$(dirname "$E2E_REL")/zz-unreadable.sh"
  printf 'echo unreadable\n' >"$target"
  chmod 000 "$target"
  expect_fail_naming "$scanner_path" "[$scanner] unreadable scanned file" "platform NGINX image scan failed with status"
  chmod 600 "$target"
  rm -f "$target"

  expect_pass "$scanner_path" "[$scanner] the restored tree"
}

copy_inputs

if [ "$(id -u)" -eq 0 ]; then
  echo "FAIL: run as a non-root user; root reads chmod 000 files and the scan-error case cannot fail" >&2
  exit 1
fi

# The validator uses rg when it is installed and grep -RInE otherwise. Run the
# matrix with each scanner that this host can provide.
no_rg_path=""
IFS=: read -r -a path_dirs <<<"$PATH"
for d in "${path_dirs[@]}"; do
  [ -x "$d/rg" ] && continue
  no_rg_path="${no_rg_path:+$no_rg_path:}$d"
done
scanners=0
if command -v rg >/dev/null 2>&1; then
  run_matrix rg "$PATH"
  scanners=$((scanners + 1))
fi
run_matrix grep "$no_rg_path"
scanners=$((scanners + 1))

# Dockerfile FROM contract (independent of the scanner).
expected_from="$(grep -E '^FROM ' "$COPY/$DOCKERFILE_REL")"
cp "$COPY/$DOCKERFILE_REL" "$WORK/Dockerfile.orig"

sed 's/@sha256:[0-9a-f]*/@sha256:0000000000000000000000000000000000000000000000000000000000000000/' \
  "$WORK/Dockerfile.orig" >"$COPY/$DOCKERFILE_REL"
expect_fail_naming "$PATH" "Dockerfile with a wrong digest" "$DOCKERFILE_REL must have exactly one FROM line"

sed 's/@sha256:[0-9a-f]*//' "$WORK/Dockerfile.orig" >"$COPY/$DOCKERFILE_REL"
expect_fail_naming "$PATH" "Dockerfile pinned by tag only" "$DOCKERFILE_REL must have exactly one FROM line"

{ cat "$WORK/Dockerfile.orig"; echo "$expected_from AS second"; } >"$COPY/$DOCKERFILE_REL"
expect_fail_naming "$PATH" "Dockerfile with a second FROM" "$DOCKERFILE_REL must have exactly one FROM line"

cp "$WORK/Dockerfile.orig" "$COPY/$DOCKERFILE_REL"
expect_pass "$PATH" "Dockerfile restored"

echo "cases=$cases scanners=$scanners failures=$failures"
if [ "$cases" -eq 0 ]; then
  echo "FAIL: no cases ran" >&2
  exit 1
fi
if [ "$failures" -ne 0 ]; then
  exit 1
fi
echo "OK -- validate-nginx-images contract ($cases cases)"
