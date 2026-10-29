#!/usr/bin/env bash
# Contract for scripts/validate-nginx-images.sh: it passes the current tree,
# rejects every vulnerable, floating, untagged or variable platform NGINX
# reference in both image families and names the file and line that carry it,
# accepts the fixed releases (with or without a digest), checks kustomize
# images: entries, enforces the pinned egress-proxy FROM line, fails on a
# missing scan path or an empty scan scope, and reports a failed scan.
#
# The validator runs on a copy of the files it reads, so injected cases never
# touch the checkout. Every injected case writes into a path the validator
# scans. Every rejection must name that path; every accepted injection must
# raise the validator's reference count by the number of references it adds,
# which proves the injected reference was read rather than skipped.
#
# Tree values (the release floors, the Dockerfile pin) are read from the
# policy file and the Dockerfile, so a routine NGINX bump needs no edit here.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALIDATOR_REL="scripts/validate-nginx-images.sh"
POLICY_REL="scripts/nginx-image-policy.sh"
WORK="$(mktemp -d)"
trap 'chmod -R u+rwX "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT
COPY="$WORK/repo"
OUT="$WORK/out"
failures=0
cases=0
baseline_refs=""

# shellcheck source=scripts/nginx-image-policy.sh
source "$REPO_ROOT/$POLICY_REL"

# The scan list the validator must carry. A path dropped from, or added to,
# the validator fails here until this list is updated with it.
EXPECTED_SCAN_PATHS="deploy
host-context-controller/src/config.ts
control-api/src/routes/admin/registry.ts
control-api/src/routes/admin/remoteMcp.ts
nginx-egress-proxy/Dockerfile
control-ui/e2e/registry-install.spec.ts
control-ui/e2e/qa-recorder-recipe-scope-copy.spec.ts
desktop-app/test/e2e-playwright/sandbox-ui-apps-catalog-authz.test.ts
scripts/minikube/build-images.sh
scripts/bootstrap-cluster.sh
scripts/e2e
docs/deploy/workflow-recipes-guide.md
docs/agents/CLERUM_WORKFLOW_RECIPE_GUIDE.md
workflow-recipes/samples
tests/e2e/integration/control-api-k8s.test.ts
tests/e2e/playwright/control-ui/recipes.spec.ts
tests/e2e/playwright/control-ui/recipe-scope-copy.spec.ts
tests/e2e/playwright/control-ui/workflow-recipe-egressbindings.spec.ts
workflow-recipes/tests/e2e"

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

validator_scan_paths() {
  sed -n '/^scan_paths=(/,/^)/p' "$1" | sed -n 's/^[[:space:]]*"\([^"]*\)"$/\1/p'
}

# Copy the validator, its policy file and every path it scans or requires,
# read from the validator itself so the copy cannot drift from what it checks.
copy_inputs() {
  local paths p
  paths="$(
    validator_scan_paths "$REPO_ROOT/$VALIDATOR_REL"
    sed -n 's/^require_[a-z_]* "\([^"]*\)".*/\1/p' "$REPO_ROOT/$VALIDATOR_REL"
  )"
  if [ -z "$paths" ]; then
    echo "FAIL: could not read scan or required paths from $VALIDATOR_REL" >&2
    exit 1
  fi
  mkdir -p "$COPY/scripts"
  cp "$REPO_ROOT/$VALIDATOR_REL" "$COPY/$VALIDATOR_REL"
  cp "$REPO_ROOT/$POLICY_REL" "$COPY/$POLICY_REL"
  if [ ! -s "$COPY/$POLICY_REL" ]; then
    echo "FAIL: the copy has no $POLICY_REL" >&2
    exit 1
  fi
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
  bash "$COPY/$VALIDATOR_REL" "$@" >"$OUT" 2>&1
}

reported_refs() {
  sed -n 's/^OK -- .*(\([0-9][0-9]*\) references checked)$/\1/p' "$OUT"
}

# expect_pass NAME [EXTRA_REFS]: the validator passes, prints the OK line, and
# reports the baseline reference count plus EXTRA_REFS.
expect_pass() {
  local name="$1" extra="${2:-0}" got
  cases=$((cases + 1))
  if ! run_validator; then
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

# expect_fail_naming NAME EXPECTED...: the validator fails and its output holds
# every EXPECTED string.
expect_fail_naming() {
  local name="$1" expected
  shift
  cases=$((cases + 1))
  if run_validator; then
    fail "$name should fail: $(cat "$OUT")"
    return
  fi
  for expected in "$@"; do
    if ! grep -qF -- "$expected" "$OUT"; then
      fail "$name should name '$expected': $(cat "$OUT")"
    fi
  done
}

SAMPLE_REL="workflow-recipes/samples/zz-injected-nginx.yaml"
E2E_REL="scripts/e2e/zz-injected-nginx.sh"
E2E_DOCKERFILE_REL="scripts/e2e/zz-injected-nginx.Dockerfile"
HIDDEN_REL="deploy/.zz-injected-hidden.yaml"
REMOTE_MCP_REL="control-api/src/routes/admin/remoteMcp.ts"
DOCKERFILE_REL="nginx-egress-proxy/Dockerfile"
KUSTOMIZE_DIR="deploy/overlays/zz-injected"
KUSTOMIZE_REL="$KUSTOMIZE_DIR/kustomization.yaml"
FIXED_PIN="$(sed -n 's/^FROM //p' "$REPO_ROOT/$DOCKERFILE_REL")"
FIXED_DIGEST="${FIXED_PIN#*@}"
# Published digest of nginx:1.30.1-alpine; a negative fixture only.
OLD_DIGEST="sha256:c819f83c54b0361f5557601bf5eb4943d09360e7a7fdf426afc466570f45874d"
BELOW="is below $BASELINE_TEXT"
NOT_FIXED="is not a fixed x.y.z release"
UNTAGGED="untagged NGINX image (implicit :latest)"
SAME_LINE="write the image reference on the same line as image:"
EMPTY_DIGEST="'@' without a digest"

if ! [[ "$FIXED_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "FAIL: could not read the pinned digest from $DOCKERFILE_REL: '$FIXED_PIN'" >&2
  exit 1
fi

# inject REL IMAGE: one YAML image field.
inject() {
  local rel="$1" image="$2"
  mkdir -p "$COPY/$(dirname "$rel")"
  printf '        image: %s\n' "$image" >"$COPY/$rel"
}

# inject_text REL TEXT: the file holds TEXT exactly.
inject_text() {
  local rel="$1"
  mkdir -p "$COPY/$(dirname "$rel")"
  printf '%s\n' "$2" >"$COPY/$rel"
}

inject_kustomize() {
  inject_text "${2:-$KUSTOMIZE_REL}" $'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n'"$1"
}

if [ "$(validator_scan_paths "$REPO_ROOT/$VALIDATOR_REL")" != "$EXPECTED_SCAN_PATHS" ]; then
  echo "FAIL: $VALIDATOR_REL scan_paths differ from this test's list:" >&2
  diff <(printf '%s\n' "$EXPECTED_SCAN_PATHS") <(validator_scan_paths "$REPO_ROOT/$VALIDATOR_REL") >&2 || true
  exit 1
fi

copy_inputs

if [ "$(id -u)" -eq 0 ]; then
  echo "FAIL: run as a non-root user; root reads chmod 000 files and the scan-error case cannot fail" >&2
  exit 1
fi

expect_pass "the current tree"
baseline_refs="$(reported_refs)"
if [ -z "$baseline_refs" ] || [ "$baseline_refs" -eq 0 ]; then
  echo "FAIL: the current tree reported no checked references: $(cat "$OUT")" >&2
  exit 1
fi

for family in nginx nginxinc/nginx-unprivileged docker.io/library/nginx; do
  for tag in 1.30.0 1.30.1 1.30.2 1.30.3 1.30.4 1.30.5 1.30.5-alpine \
    1.31.0 1.31.1 1.31.2 1.31.3 1.31.4 1.31.5 1.31.6 1.31.6-alpine 1.27.5-alpine 1.29.9; do
    image="$family:$tag"
    inject "$SAMPLE_REL" "$image"
    expect_fail_naming "$image in a recipe sample" "$SAMPLE_REL:1: " "$BELOW"
    rm -f "$COPY/$SAMPLE_REL"
  done

  # shellcheck disable=SC2016 # variable tags are injected literally
  for tag in latest alpine stable mainline stable-alpine bookworm trixie alpine-slim \
    1 1-alpine 1.30 1.30-alpine 1.31 1.27-alpine '${NGINX_TAG}' '$NGINX_TAG' '${TAG:-1.30.6}'; do
    image="$family:$tag"
    inject "$SAMPLE_REL" "$image"
    expect_fail_naming "$image in a recipe sample" "$SAMPLE_REL:1: " "$NOT_FIXED"
    rm -f "$COPY/$SAMPLE_REL"
  done

  for tag in 1.30.6 1.30.6-alpine 1.30.7 1.31.7 1.31.8 1.31.8-alpine 1.30.50 1.30.60 1.31.60 1.32.0 2.0.0; do
    image="$family:$tag"
    inject "$SAMPLE_REL" "$image"
    expect_pass "$image in a recipe sample" 1
    rm -f "$COPY/$SAMPLE_REL"
  done

  # An untagged image field pulls :latest.
  inject "$SAMPLE_REL" "$family"
  expect_fail_naming "untagged $family in a recipe sample" "$SAMPLE_REL:1: " "$UNTAGGED"
  rm -f "$COPY/$SAMPLE_REL"
done

# Untagged references in every recognised position.
# shellcheck disable=SC2016 # $P is injected literally
for line in 'image: nginx # x' '"image": "nginx"' '- {name: gw, image: nginx}' 'image: nginx}' \
  '"image": "nginx",' '--image=nginx' 'IMAGE=nginx' "image: 'nginx'" 'image: &web_image nginx' \
  'image: !!str nginx' 'image: !!str &web "nginx"'; do
  inject_text "$SAMPLE_REL" "$line"
  expect_fail_naming "untagged $line" "$SAMPLE_REL:1: " "$UNTAGGED"
  rm -f "$COPY/$SAMPLE_REL"
done
# shellcheck disable=SC2016 # $P is injected literally
for line in 'FROM nginx' 'from nginx AS b' 'FROM --platform=$P nginx' 'COPY --from=nginx /usr/sbin/nginx /x' \
  'copy --from="nginx" /a /b' 'RUN --mount=type=bind,from=nginx,target=/n true' 'RUN --mount=from=nginx,target=/n true'; do
  inject_text "$E2E_DOCKERFILE_REL" "$line"
  expect_fail_naming "untagged $line" "$E2E_DOCKERFILE_REL:1: " "$UNTAGGED"
  rm -f "$COPY/$E2E_DOCKERFILE_REL"
done
for line in 'PUBLIC_IMAGES=("nginx")' 'PUBLIC_IMAGES=(nginx)' 'PUBLIC_IMAGES+=("busybox:1.36" nginx)'; do
  inject_text "$E2E_REL" "$line"
  expect_fail_naming "untagged $line in a shell script" "$E2E_REL:1: " "$UNTAGGED"
  rm -f "$COPY/$E2E_REL"
done
for element in '  nginx' '  "nginx"'; do
  inject_text "$E2E_REL" $'PUBLIC_IMAGES=(\n  "busybox:1.36"\n'"$element"$'\n)'
  expect_fail_naming "untagged array line '$element' in a shell script" "$E2E_REL:3: " "$UNTAGGED"
  rm -f "$COPY/$E2E_REL"
done

# An image: key whose value is on the next lines cannot be read by the scan.
for text in $'image: >-\n  nginx' $'image:\n  nginx'; do
  inject_text "$SAMPLE_REL" "$text"
  expect_fail_naming "image: with its value on the next line" "$SAMPLE_REL:1: " "$SAME_LINE"
  rm -f "$COPY/$SAMPLE_REL"
done

# Digests: accepted only next to a fixed tag, and only well formed.
inject "$SAMPLE_REL" "nginx:1.30.6-alpine@$FIXED_DIGEST"
expect_pass "fixed tag with a digest" 1
inject "$SAMPLE_REL" "nginx@$FIXED_DIGEST"
expect_fail_naming "digest without a tag" "$SAMPLE_REL:1: " "digest without a version tag"
inject "$SAMPLE_REL" "nginx:1.30.1-alpine@$OLD_DIGEST"
expect_fail_naming "old tag with its digest" "$SAMPLE_REL:1: " "$BELOW"
inject "$SAMPLE_REL" "nginx:1.30.6-alpine@sha256:c59d1f8b"
expect_fail_naming "malformed digest" "$SAMPLE_REL:1: " "malformed digest"
inject "$SAMPLE_REL" "nginx:1.30.6-alpine@"
expect_fail_naming "fixed tag with an empty digest" "$SAMPLE_REL:1: " "$EMPTY_DIGEST"
inject "$SAMPLE_REL" "nginx@"
expect_fail_naming "untagged name with an empty digest" "$SAMPLE_REL:1: " "$EMPTY_DIGEST"
rm -f "$COPY/$SAMPLE_REL"

# Strings that are not image references are left alone; the count shows they
# were not counted as references either.
for image in nginx-egress-proxy clerum/nginx-egress-proxy:0.1.0 'nginx:'; do
  inject "$SAMPLE_REL" "$image"
  expect_pass "non-reference string $image" 0
  rm -f "$COPY/$SAMPLE_REL"
done
# A '*' tag is a glob, never a fixed release, wherever it is written.
inject "$SAMPLE_REL" 'nginx:*'
expect_fail_naming "glob tag nginx:* in a recipe sample" "$SAMPLE_REL:1: " "$NOT_FIXED"
rm -f "$COPY/$SAMPLE_REL"
# shellcheck disable=SC2016 # the variable is injected literally
inject_text "$E2E_REL" 'PUBLIC_IMAGES=("nginx:${NGINX_TAG:-1.30.*}")'
expect_fail_naming "variable tag with a glob default in a shell script" "$E2E_REL:1: " "$NOT_FIXED"
rm -f "$COPY/$E2E_REL"
for line in "id: 'nginx'" "if name == 'nginx'"; do
  inject_text "$SAMPLE_REL" "$line"
  expect_pass "non-reference line $line" 0
  rm -f "$COPY/$SAMPLE_REL"
done
inject_text "$E2E_REL" $'NAMES=("nginx-egress-proxy")\nNAMES=(\n  nginx-egress-proxy\n)'
expect_pass "nginx-egress-proxy shell-array elements" 0
rm -f "$COPY/$E2E_REL"
inject_text "$SAMPLE_REL" '- {name: gw, image: nginx:1.30.6-alpine}'
expect_pass "fixed tag in a flow map" 1
rm -f "$COPY/$SAMPLE_REL"

# Paths that deploy or install platform NGINX, hidden files included.
for rel in "$E2E_REL" deploy/base/profiles/zz-injected.yaml deploy/components/ghcr-images/zz-injected.yaml \
  deploy/overlays/zz-injected/zz-injected.yaml "$HIDDEN_REL"; do
  inject "$rel" "nginx:1.30.5-alpine"
  expect_fail_naming "nginx:1.30.5-alpine in $rel" "$rel:1: " "$BELOW"
  rm -f "$COPY/$rel"
done
for rel in "$REMOTE_MCP_REL" tests/e2e/playwright/control-ui/recipes.spec.ts \
  tests/e2e/playwright/control-ui/recipe-scope-copy.spec.ts \
  tests/e2e/playwright/control-ui/workflow-recipe-egressbindings.spec.ts \
  tests/e2e/integration/control-api-k8s.test.ts docs/agents/CLERUM_WORKFLOW_RECIPE_GUIDE.md; do
  cp "$COPY/$rel" "$WORK/appended.orig"
  printf '// image: nginx:1.31.6\n' >>"$COPY/$rel"
  expect_fail_naming "nginx:1.31.6 appended to $rel" "$rel:" "nginx:1.31.6: release 1.31.6 $BELOW"
  cp "$WORK/appended.orig" "$COPY/$rel"
done

# kustomize images: entries rewrite an image without naming its tag inline.
inject_kustomize $'images:\n- name: nginx\n  newTag: 1.30.1-alpine'
expect_fail_naming "kustomize newTag below the baseline" "$KUSTOMIZE_REL:4: nginx:1.30.1-alpine: " "$BELOW"
inject_kustomize $'images: [{name: nginx, newTag: 1.30.1-alpine}]'
expect_fail_naming "kustomize flow list below the baseline" "$KUSTOMIZE_REL:3: nginx:1.30.1-alpine: " "$BELOW"
inject_kustomize $'images:\n- {name: nginx, newTag: 1.30.1-alpine}'
expect_fail_naming "kustomize flow map item below the baseline" "$KUSTOMIZE_REL:4: nginx:1.30.1-alpine: " "$BELOW"
inject_text "$KUSTOMIZE_REL" '{"apiVersion": "kustomize.config.k8s.io/v1beta1", "kind": "Kustomization", "images": [{"name": "nginx", "newTag": "1.30.1-alpine"}]}'
expect_fail_naming "kustomize JSON body below the baseline" "$KUSTOMIZE_REL:" "nginx:1.30.1-alpine: " "$BELOW"
rm -f "$COPY/$KUSTOMIZE_REL"
inject_kustomize $'images:\n- name: nginx\n  newTag: 1.30.1-alpine' "$KUSTOMIZE_DIR/Kustomization"
expect_fail_naming "Kustomization file name below the baseline" "$KUSTOMIZE_DIR/Kustomization:4: nginx:1.30.1-alpine: " "$BELOW"
rm -f "$COPY/$KUSTOMIZE_DIR/Kustomization"
inject_kustomize $'images:\n- name: "ngin\\u0078"\n  newTag: 1.30.1-alpine'
expect_fail_naming "kustomize escaped name below the baseline" "$KUSTOMIZE_REL:4: nginx:1.30.1-alpine: " "$BELOW"
inject_kustomize $'images:\n- name: nginx\n  newTag: "null"'
expect_fail_naming "kustomize newTag \"null\"" "$KUSTOMIZE_REL:4: nginx:null: " "$NOT_FIXED"
inject_kustomize $'images: [unclosed'
expect_fail_naming "unparsable kustomization" "yq could not read the images: entries of $KUSTOMIZE_REL"
inject_kustomize $'images:\n  - name: clerum/gateway\n    newName: docker.io/library/nginx\n    newTag: "1.31.6"'
expect_fail_naming "kustomize newName to NGINX below the baseline" "$KUSTOMIZE_REL:4: docker.io/library/nginx:1.31.6: " "$BELOW"
inject_kustomize $'images:\n- name: clerum/gateway\n  newName: nginx'
expect_fail_naming "kustomize newName to NGINX with no newTag" "$KUSTOMIZE_REL:4: nginx:<no newTag>: " "$NOT_FIXED"
inject_kustomize $'images:\n- name: example/web\n  newName: "ngin\\u0078:1.30.5-alpine"'
expect_fail_naming "kustomize escaped newName carrying a tag below the baseline" "$KUSTOMIZE_REL:4: nginx:1.30.5-alpine: " "$BELOW"
inject_kustomize $'images:\n- name: nginx\n  newName: nginx:1.30.5-alpine'
expect_fail_naming "kustomize newName carrying a tag below the baseline" "$KUSTOMIZE_REL:4: nginx:1.30.5-alpine: " "$BELOW"
inject_kustomize $'images:\n- name: example/web\n  newName: nginx:1.30.5-alpine\n  newTag: 1.30.6-alpine'
expect_fail_naming "kustomize tagged newName plus newTag" "$KUSTOMIZE_REL:4: nginx:1.30.5-alpine:1.30.6-alpine: " "$NOT_FIXED"
inject_kustomize $'images:\n- name: nginx\n  newTag: stable-alpine'
expect_fail_naming "kustomize floating newTag" "$KUSTOMIZE_REL:4: nginx:stable-alpine: " "$NOT_FIXED"
inject_kustomize $'images:\n- name: nginx\n  digest: '"$FIXED_DIGEST"
expect_fail_naming "kustomize digest without newTag" "$KUSTOMIZE_REL:4: nginx@$FIXED_DIGEST: " "digest without a version tag"
inject_kustomize $'images:\n- name: nginx\n  newTag: 1.30.6-alpine # fixed baseline'
expect_pass "kustomize newTag on the baseline" 1
inject_kustomize $'images:\n- name: nginx\n  newTag: 1.30.6-alpine  '
expect_pass "kustomize unquoted newTag with trailing spaces" 1
inject_kustomize $'images:\n- name: example/web\n  newName: "ngin\\u0078:1.30.6-alpine"'
expect_pass "kustomize escaped newName carrying the baseline tag" 1
inject_kustomize $'images:\n- name: nginx\n  newName: clerum/nginx-egress-proxy\n  newTag: 0.1.0'
expect_pass "kustomize rewrite of nginx to another image" 0
inject_kustomize $'images:\n- name: clerum/control-api\n  newName: ghcr.io/evenfire-ai/control-api\n  newTag: v0.11.0'
expect_pass "kustomize entry for another image" 0
rm -rf "${COPY:?}/$KUSTOMIZE_DIR"

# Scan errors must fail the guard instead of reading as "nothing found".
target="$COPY/$(dirname "$E2E_REL")/zz-unreadable.sh"
printf 'echo unreadable\n' >"$target"
chmod 000 "$target"
expect_fail_naming "unreadable scanned file" "platform NGINX image scan (candidates) failed with status"
chmod 600 "$target"
rm -f "$target"

expect_pass "the restored tree" 0

# A scan path that no longer exists is an error, never a silent skip.
moved="tests/e2e/integration/control-api-k8s.test.ts"
mv "$COPY/$moved" "$WORK/moved.orig"
expect_fail_naming "missing scan path" "scan path $moved does not exist"
mv "$WORK/moved.orig" "$COPY/$moved"

# A scope that holds no NGINX file is an error, never a pass over nothing.
cp "$COPY/$VALIDATOR_REL" "$WORK/validator.orig"
mkdir -p "$COPY/zz-empty"
awk '
  /^scan_paths=\(/ { print; print "  \"zz-empty\""; skip = 1; replaced++; next }
  skip && /^\)/ { skip = 0 }
  !skip { print }
  END { if (replaced != 1) exit 1 }
' "$WORK/validator.orig" >"$COPY/$VALIDATOR_REL"
if [ "$(validator_scan_paths "$COPY/$VALIDATOR_REL")" != "zz-empty" ]; then
  echo "FAIL: could not point the copied validator at an empty scan scope" >&2
  exit 1
fi
expect_fail_naming "empty scan scope" "platform NGINX image scan (candidates) found no file"
cp "$WORK/validator.orig" "$COPY/$VALIDATOR_REL"

# Dockerfile FROM contract.
expected_from="$(grep -E '^FROM ' "$COPY/$DOCKERFILE_REL")"
cp "$COPY/$DOCKERFILE_REL" "$WORK/Dockerfile.orig"

sed 's/@sha256:[0-9a-f]*/@sha256:'"$(printf '%063d' 0)"'/' "$WORK/Dockerfile.orig" >"$COPY/$DOCKERFILE_REL"
expect_fail_naming "Dockerfile with a malformed digest" "$DOCKERFILE_REL must have exactly one FROM line"

sed 's/@sha256:[0-9a-f]*//' "$WORK/Dockerfile.orig" >"$COPY/$DOCKERFILE_REL"
expect_fail_naming "Dockerfile pinned by tag only" "$DOCKERFILE_REL must have exactly one FROM line"

{ cat "$WORK/Dockerfile.orig"; echo "$expected_from AS second"; } >"$COPY/$DOCKERFILE_REL"
expect_fail_naming "Dockerfile with a second FROM" "$DOCKERFILE_REL must have exactly one FROM line"

# Dockerfile instructions are case-insensitive; a lowercase stage still runs.
{ cat "$WORK/Dockerfile.orig"; echo "from busybox:1.36 AS second"; } >"$COPY/$DOCKERFILE_REL"
expect_fail_naming "Dockerfile with a lowercase second from" "$DOCKERFILE_REL must have exactly one FROM line" "from busybox:1.36"

cp "$WORK/Dockerfile.orig" "$COPY/$DOCKERFILE_REL"
expect_pass "Dockerfile restored" 0

# --list-digest-pins feeds verify-nginx-image-digests.sh: every valid tag@digest
# once, with its registry path, nothing else.
inject "$SAMPLE_REL" "$FIXED_PIN"
registry_pin="registry.internal:5000/mirror/$FIXED_PIN"
inject_text "$E2E_REL" "IMAGE=$registry_pin"
cases=$((cases + 1))
if ! run_validator --list-digest-pins; then
  fail "--list-digest-pins failed: $(cat "$OUT")"
elif [ "$(cat "$OUT")" != "$(printf '%s\n' "$FIXED_PIN" "$registry_pin" | sort -u)" ]; then
  fail "--list-digest-pins should print '$FIXED_PIN' and '$registry_pin' once each: $(cat "$OUT")"
fi
rm -f "$COPY/$SAMPLE_REL" "$COPY/$E2E_REL"

echo "cases=$cases failures=$failures"
if [ "$cases" -eq 0 ]; then
  echo "FAIL: no cases ran" >&2
  exit 1
fi
if [ "$failures" -ne 0 ]; then
  exit 1
fi
echo "OK -- validate-nginx-images contract ($cases cases)"
