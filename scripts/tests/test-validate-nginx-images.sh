#!/usr/bin/env bash
# Contract for scripts/validate-nginx-images.sh: it passes the current tree,
# rejects every vulnerable, floating, untagged or variable platform NGINX
# reference in both image families and names the file and line that carry it,
# accepts the fixed releases (with or without a digest), checks kustomize
# images: entries, enforces the pinned egress-proxy FROM line, fails on a
# missing scan path, and reports a failed scan.
#
# The validator runs on a copy of the files it reads, so injected cases never
# touch the checkout. Every injected case writes into a path the validator
# scans. Every rejection must name that path; every accepted injection must
# raise the validator's reference count by one, which proves the injected
# reference was read rather than skipped.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALIDATOR_REL="scripts/validate-nginx-images.sh"
WORK="$(mktemp -d)"
trap 'chmod -R u+rwX "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT
COPY="$WORK/repo"
OUT="$WORK/out"
failures=0
cases=0
baseline_refs=""

# The scan list the validator must carry. A path dropped from, or added to,
# the validator fails here until this list is updated with it.
EXPECTED_SCAN_PATHS="deploy
host-context-controller/src/config.ts
host-context-controller/src/__tests__/reconciler.remote.test.ts
host-context-controller/src/__tests__/reconciler.sanitize.test.ts
control-api/src/routes/admin/registry.ts
control-api/src/routes/admin/remoteMcp.ts
nginx-egress-proxy/Dockerfile
control-ui/e2e/registry-install.spec.ts
control-ui/e2e/qa-recorder-recipe-scope-copy.spec.ts
control-ui/components/__tests__/RegistryCatalog.test.tsx
desktop-app/test/e2e-playwright/sandbox-ui-apps-catalog-authz.test.ts
scripts/minikube/build-images.sh
scripts/bootstrap-cluster.sh
scripts/e2e
docs/deploy/workflow-recipes-guide.md
docs/agents/CLERUM_WORKFLOW_RECIPE_GUIDE.md
workflow-recipes/samples
workflow-recipes/src
tests/e2e/integration/control-api-k8s.test.ts
tests/e2e/playwright/control-ui/recipes.spec.ts
tests/e2e/playwright/control-ui/workflow-recipe-egressbindings.spec.ts
workflow-recipes/tests/e2e
workflow-recipes/tests/fixtures/workflow/invalid-scheduling-no-steps.yaml"

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

validator_scan_paths() {
  sed -n '/^scan_paths=(/,/^)/p' "$REPO_ROOT/$VALIDATOR_REL" | sed -n 's/^[[:space:]]*"\([^"]*\)"$/\1/p'
}

# Copy the validator and every path it scans or requires, read from the
# validator itself so the copy cannot drift from what it checks.
copy_inputs() {
  local paths p
  paths="$(
    validator_scan_paths
    sed -n 's/^require_[a-z_]* "\([^"]*\)".*/\1/p' "$REPO_ROOT/$VALIDATOR_REL"
  )"
  if [ -z "$paths" ]; then
    echo "FAIL: could not read scan or required paths from $VALIDATOR_REL" >&2
    exit 1
  fi
  mkdir -p "$COPY/scripts"
  cp "$REPO_ROOT/$VALIDATOR_REL" "$COPY/$VALIDATOR_REL"
  while IFS= read -r p; do
    if [ ! -e "$REPO_ROOT/$p" ]; then
      echo "FAIL: $VALIDATOR_REL names $p, which does not exist in the repository" >&2
      exit 1
    fi
    mkdir -p "$COPY/$(dirname "$p")"
    cp -R "$REPO_ROOT/$p" "$COPY/$(dirname "$p")/"
  done <<<"$paths"
}

run_validator() {
  PATH="$1" bash "$COPY/$VALIDATOR_REL" "${@:2}" >"$OUT" 2>&1
}

reported_refs() {
  sed -n 's/^OK -- .*(\([0-9][0-9]*\) references checked)$/\1/p' "$OUT"
}

# expect_pass PATH NAME [EXTRA_REFS]: the validator passes, prints the OK line,
# and reports the baseline reference count plus EXTRA_REFS.
expect_pass() {
  local scanner_path="$1" name="$2" extra="${3:-0}" got
  cases=$((cases + 1))
  if ! run_validator "$scanner_path"; then
    fail "$name should pass: $(cat "$OUT")"
    return
  fi
  got="$(reported_refs)"
  if [ -z "$got" ]; then
    fail "$name passed without the OK line: $(cat "$OUT")"
  elif [ -n "$baseline_refs" ] && [ "$got" -ne $((baseline_refs + extra)) ]; then
    fail "$name checked $got references, expected $((baseline_refs + extra)): $(cat "$OUT")"
  fi
}

expect_fail_naming() {
  local scanner_path="$1" name="$2" expected
  shift 2
  cases=$((cases + 1))
  if run_validator "$scanner_path"; then
    fail "$name should fail: $(cat "$OUT")"
    return
  fi
  for expected in "$@"; do
    if ! grep -qF -- "$expected" "$OUT"; then
      fail "$name should name '$expected': $(cat "$OUT")"
    fi
  done
}

# Scanned by the validator only since the October 2026 baseline: the whole
# recipe samples directory, scripts/e2e, all of deploy/ and the deploying
# E2E specs.
SAMPLE_REL="workflow-recipes/samples/zz-injected-nginx.yaml"
E2E_REL="scripts/e2e/zz-injected-nginx.sh"
REMOTE_MCP_REL="control-api/src/routes/admin/remoteMcp.ts"
DOCKERFILE_REL="nginx-egress-proxy/Dockerfile"
KUSTOMIZE_REL="deploy/overlays/zz-injected/kustomization.yaml"
FIXED_DIGEST="sha256:c59d1f8b1e0e42da75be973424cd72e23f7f8adfb54e982f4d1cd0216a5a5576"
OLD_DIGEST="sha256:c819f83c54b0361f5557601bf5eb4943d09360e7a7fdf426afc466570f45874d"
BELOW="is below 1.30.6"
NOT_FIXED="is not a fixed x.y.z release"
UNTAGGED="untagged NGINX image (implicit :latest)"

inject() {
  local rel="$1" image="$2"
  mkdir -p "$COPY/$(dirname "$rel")"
  printf '        image: %s\n' "$image" >"$COPY/$rel"
}

inject_kustomize() {
  mkdir -p "$COPY/$(dirname "$KUSTOMIZE_REL")"
  printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n%s\n' "$1" >"$COPY/$KUSTOMIZE_REL"
}

run_matrix() {
  local scanner="$1" scanner_path="$2" family tag image target rel line

  baseline_refs=""
  expect_pass "$scanner_path" "[$scanner] the current tree"
  baseline_refs="$(reported_refs)"
  if [ -z "$baseline_refs" ] || [ "$baseline_refs" -eq 0 ]; then
    echo "FAIL: [$scanner] the current tree reported no checked references: $(cat "$OUT")" >&2
    exit 1
  fi

  for family in nginx nginxinc/nginx-unprivileged docker.io/library/nginx; do
    for tag in 1.30.0 1.30.1 1.30.2 1.30.3 1.30.4 1.30.5 1.30.5-alpine \
      1.31.0 1.31.1 1.31.2 1.31.3 1.31.4 1.31.5 1.31.6 1.31.6-alpine 1.27.5-alpine 1.29.9; do
      image="$family:$tag"
      inject "$SAMPLE_REL" "$image"
      expect_fail_naming "$scanner_path" "[$scanner] $image in a recipe sample" "$SAMPLE_REL:1: " "$BELOW"
      rm -f "$COPY/$SAMPLE_REL"
    done

    # shellcheck disable=SC2016 # variable tags are injected literally
    for tag in latest alpine stable mainline stable-alpine bookworm trixie alpine-slim \
      1 1-alpine 1.30 1.30-alpine 1.31 1.27-alpine '${NGINX_TAG}' '$NGINX_TAG' '${TAG:-1.30.6}'; do
      image="$family:$tag"
      inject "$SAMPLE_REL" "$image"
      expect_fail_naming "$scanner_path" "[$scanner] $image in a recipe sample" "$SAMPLE_REL:1: " "$NOT_FIXED"
      rm -f "$COPY/$SAMPLE_REL"
    done

    for tag in 1.30.6 1.30.6-alpine 1.30.7 1.31.7 1.31.8 1.31.8-alpine 1.30.50 1.30.60 1.31.60 1.32.0 2.0.0; do
      image="$family:$tag"
      inject "$SAMPLE_REL" "$image"
      expect_pass "$scanner_path" "[$scanner] $image in a recipe sample" 1
      rm -f "$COPY/$SAMPLE_REL"
    done

    # An untagged image field pulls :latest.
    inject "$SAMPLE_REL" "$family"
    expect_fail_naming "$scanner_path" "[$scanner] untagged $family in a recipe sample" "$SAMPLE_REL:1: " "$UNTAGGED"
    rm -f "$COPY/$SAMPLE_REL"
  done

  for line in '"image": "nginx",' '--image=nginx' 'IMAGE=nginx' "image: 'nginx'"; do
    mkdir -p "$COPY/$(dirname "$E2E_REL")"
    printf '%s\n' "$line" >"$COPY/$E2E_REL"
    expect_fail_naming "$scanner_path" "[$scanner] untagged $line in scripts/e2e" "$E2E_REL:1: " "$UNTAGGED"
    rm -f "$COPY/$E2E_REL"
  done

  # Digests: accepted only next to a fixed tag, and only well formed.
  inject "$SAMPLE_REL" "nginx:1.30.6-alpine@$FIXED_DIGEST"
  expect_pass "$scanner_path" "[$scanner] fixed tag with a digest" 1
  inject "$SAMPLE_REL" "nginx@$FIXED_DIGEST"
  expect_fail_naming "$scanner_path" "[$scanner] digest without a tag" "$SAMPLE_REL:1: " "digest without a version tag"
  inject "$SAMPLE_REL" "nginx:1.30.1-alpine@$OLD_DIGEST"
  expect_fail_naming "$scanner_path" "[$scanner] old tag with its digest" "$SAMPLE_REL:1: " "$BELOW"
  inject "$SAMPLE_REL" "nginx:1.30.6-alpine@sha256:c59d1f8b"
  expect_fail_naming "$scanner_path" "[$scanner] malformed digest" "$SAMPLE_REL:1: " "malformed digest"
  rm -f "$COPY/$SAMPLE_REL"

  # Strings that are not image references are left alone; the count shows they
  # were not counted as references either.
  for image in nginx-egress-proxy clerum/nginx-egress-proxy:0.1.0 'nginx:*' 'nginx:'; do
    inject "$SAMPLE_REL" "$image"
    expect_pass "$scanner_path" "[$scanner] non-reference string $image" 0
    rm -f "$COPY/$SAMPLE_REL"
  done

  # Paths that deploy or install platform NGINX.
  for rel in "$E2E_REL" deploy/base/profiles/zz-injected.yaml deploy/components/ghcr-images/zz-injected.yaml \
    deploy/overlays/zz-injected/zz-injected.yaml; do
    inject "$rel" "nginx:1.30.5-alpine"
    expect_fail_naming "$scanner_path" "[$scanner] nginx:1.30.5-alpine in $rel" "$rel:1: " "$BELOW"
    rm -f "$COPY/$rel"
  done
  for rel in "$REMOTE_MCP_REL" tests/e2e/playwright/control-ui/recipes.spec.ts \
    tests/e2e/playwright/control-ui/workflow-recipe-egressbindings.spec.ts \
    tests/e2e/integration/control-api-k8s.test.ts docs/agents/CLERUM_WORKFLOW_RECIPE_GUIDE.md; do
    cp "$COPY/$rel" "$WORK/appended.orig"
    printf '// image: nginx:1.31.6\n' >>"$COPY/$rel"
    expect_fail_naming "$scanner_path" "[$scanner] nginx:1.31.6 appended to $rel" "$rel:" "nginx:1.31.6: release 1.31.6 $BELOW"
    cp "$WORK/appended.orig" "$COPY/$rel"
  done

  # kustomize images: entries rewrite an image without naming its tag inline.
  inject_kustomize $'images:\n- name: nginx\n  newTag: 1.30.1-alpine'
  expect_fail_naming "$scanner_path" "[$scanner] kustomize newTag below the baseline" "$KUSTOMIZE_REL:4: nginx:1.30.1-alpine: " "$BELOW"
  inject_kustomize $'images:\n  - name: clerum/gateway\n    newName: docker.io/library/nginx\n    newTag: "1.31.6"'
  expect_fail_naming "$scanner_path" "[$scanner] kustomize newName to NGINX below the baseline" "$KUSTOMIZE_REL:4: docker.io/library/nginx:1.31.6: " "$BELOW"
  inject_kustomize $'images:\n- name: clerum/gateway\n  newName: nginx'
  expect_fail_naming "$scanner_path" "[$scanner] kustomize newName to NGINX with no newTag" "$KUSTOMIZE_REL:4: nginx:<no newTag>: " "$NOT_FIXED"
  inject_kustomize $'images:\n- name: nginx\n  newTag: stable-alpine'
  expect_fail_naming "$scanner_path" "[$scanner] kustomize floating newTag" "$KUSTOMIZE_REL:4: nginx:stable-alpine: " "$NOT_FIXED"
  inject_kustomize $'images:\n- name: nginx\n  digest: '"$FIXED_DIGEST"
  expect_fail_naming "$scanner_path" "[$scanner] kustomize digest without newTag" "$KUSTOMIZE_REL:4: nginx@$FIXED_DIGEST: " "digest without a version tag"
  inject_kustomize $'images:\n- name: nginx\n  newTag: 1.30.6-alpine # fixed baseline'
  expect_pass "$scanner_path" "[$scanner] kustomize newTag on the baseline" 1
  inject_kustomize $'images:\n- name: clerum/control-api\n  newName: ghcr.io/evenfire-ai/control-api\n  newTag: v0.11.0'
  expect_pass "$scanner_path" "[$scanner] kustomize entry for another image" 0
  rm -rf "${COPY:?}/$(dirname "$KUSTOMIZE_REL")"

  # Scan errors must fail the guard instead of reading as "nothing found".
  target="$COPY/$(dirname "$E2E_REL")/zz-unreadable.sh"
  printf 'echo unreadable\n' >"$target"
  chmod 000 "$target"
  expect_fail_naming "$scanner_path" "[$scanner] unreadable scanned file" "platform NGINX image scan (scan_refs) failed with status"
  chmod 600 "$target"
  rm -f "$target"

  expect_pass "$scanner_path" "[$scanner] the restored tree" 0
}

if [ "$(validator_scan_paths)" != "$EXPECTED_SCAN_PATHS" ]; then
  echo "FAIL: $VALIDATOR_REL scan_paths differ from this test's list:" >&2
  diff <(printf '%s\n' "$EXPECTED_SCAN_PATHS") <(validator_scan_paths) >&2 || true
  exit 1
fi

copy_inputs

if [ "$(id -u)" -eq 0 ]; then
  echo "FAIL: run as a non-root user; root reads chmod 000 files and the scan-error case cannot fail" >&2
  exit 1
fi

# The validator uses rg when it is installed and grep -R otherwise. Run the
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

# A scan path that no longer exists is an error, never a silent skip.
moved="tests/e2e/integration/control-api-k8s.test.ts"
mv "$COPY/$moved" "$WORK/moved.orig"
expect_fail_naming "$PATH" "missing scan path" "scan path $moved does not exist"
mv "$WORK/moved.orig" "$COPY/$moved"

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

# Dockerfile instructions are case-insensitive; a lowercase stage still runs.
{ cat "$WORK/Dockerfile.orig"; echo "from busybox:1.36 AS second"; } >"$COPY/$DOCKERFILE_REL"
expect_fail_naming "$PATH" "Dockerfile with a lowercase second from" "$DOCKERFILE_REL must have exactly one FROM line" "from busybox:1.36"

cp "$WORK/Dockerfile.orig" "$COPY/$DOCKERFILE_REL"
expect_pass "$PATH" "Dockerfile restored" 0

# --list-digest-pins feeds verify-nginx-image-digests.sh: every valid tag@digest
# once, nothing else.
inject "$SAMPLE_REL" "${expected_from#FROM }"
cases=$((cases + 1))
if ! run_validator "$PATH" --list-digest-pins; then
  fail "--list-digest-pins failed: $(cat "$OUT")"
elif [ "$(cat "$OUT")" != "${expected_from#FROM }" ]; then
  fail "--list-digest-pins should print '${expected_from#FROM }' once: $(cat "$OUT")"
fi
rm -f "$COPY/$SAMPLE_REL"

echo "cases=$cases scanners=$scanners failures=$failures"
if [ "$cases" -eq 0 ]; then
  echo "FAIL: no cases ran" >&2
  exit 1
fi
if [ "$failures" -ne 0 ]; then
  exit 1
fi
echo "OK -- validate-nginx-images contract ($cases cases)"
