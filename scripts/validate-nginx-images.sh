#!/usr/bin/env bash
# Validate platform-owned NGINX runtime images stay on the fixed security
# baseline: stable 1.30.6, which fixes CVE-2026-15176, CVE-2026-93479,
# CVE-2026-95101, CVE-2026-97629 and CVE-2026-97205 (and the older
# CVE-2026-42945). User-authored arbitrary workload image tests are
# intentionally out of scope; this guard covers manifests, generated proxy
# defaults, deploy helpers, shipped recipe samples, and E2E fixtures that
# install platform-owned NGINX surfaces.
#
# Every nginx / nginxinc/nginx-unprivileged reference in the scanned paths must
# carry a full x.y.z tag at or above the fixed release of its line (1.30.6,
# 1.31.7, or any 1.32+). Floating, untagged and variable tags are rejected. A
# digest is accepted only next to such a tag; scripts/verify-nginx-image-digests.sh
# checks in CI that each pinned digest really is that NGINX version.
#
#   --list-digest-pins   print every tag@digest reference and exit
#                        (input for verify-nginx-image-digests.sh)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

FIXED_NGINX_IMAGE="nginx:1.30.6-alpine"
FIXED_NGINX_IMAGE_DIGEST="sha256:c59d1f8b1e0e42da75be973424cd72e23f7f8adfb54e982f4d1cd0216a5a5576"
EGRESS_PROXY_IMAGE="clerum/nginx-egress-proxy:0.1.0"
BASELINE_TEXT="1.30.6 (1.30 line), 1.31.7 (1.31 line) or 1.32+"

# An NGINX image reference: the repository name, then a tag and/or digest. The
# leading group keeps clerum/nginx-egress-proxy and foo-nginx:1 out and lets a
# registry prefix (docker.io/library/nginx:...) match after its '/'. '$', '{',
# '}' and '*' are captured so variable and glob tags are seen.
# shellcheck disable=SC2016 # literal '$', '{' and '}' in a regular expression
NGINX_REF_REGEX='(^|[^[:alnum:]_.-])(nginx|nginxinc/nginx-unprivileged)[:@][[:alnum:]_.:@${}*-]*'
# An untagged NGINX image in an image field: image: nginx, "image": "nginx",
# --image=nginx, IMAGE=docker.io/library/nginx (implicitly :latest).
NGINX_UNTAGGED_REGEX='image["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?([[:alnum:]_.-]+(:[0-9]+)?/)*(nginx|nginxinc/nginx-unprivileged)["'"'"']?[[:space:]]*,?[[:space:]]*$'

# Every path must exist: a renamed or deleted path is an error, never a
# silent skip. deploy/ covers base, components and every overlay, including
# the GCP overlays when the infra repository assembles this tree.
scan_paths=(
  "deploy"
  "host-context-controller/src/config.ts"
  "host-context-controller/src/__tests__/reconciler.remote.test.ts"
  "host-context-controller/src/__tests__/reconciler.sanitize.test.ts"
  "control-api/src/routes/admin/registry.ts"
  "control-api/src/routes/admin/remoteMcp.ts"
  "nginx-egress-proxy/Dockerfile"
  "control-ui/e2e/registry-install.spec.ts"
  "control-ui/e2e/qa-recorder-recipe-scope-copy.spec.ts"
  "control-ui/components/__tests__/RegistryCatalog.test.tsx"
  "desktop-app/test/e2e-playwright/sandbox-ui-apps-catalog-authz.test.ts"
  "scripts/minikube/build-images.sh"
  "scripts/bootstrap-cluster.sh"
  "scripts/e2e"
  "docs/deploy/workflow-recipes-guide.md"
  "docs/agents/CLERUM_WORKFLOW_RECIPE_GUIDE.md"
  "workflow-recipes/samples"
  "workflow-recipes/src"
  "tests/e2e/integration/control-api-k8s.test.ts"
  "tests/e2e/playwright/control-ui/recipes.spec.ts"
  "tests/e2e/playwright/control-ui/workflow-recipe-egressbindings.spec.ts"
  "workflow-recipes/tests/e2e"
  "workflow-recipes/tests/fixtures/workflow/invalid-scheduling-no-steps.yaml"
)

failed=0
for _p in "${scan_paths[@]}"; do
  if [ ! -e "$PROJECT_DIR/$_p" ]; then
    echo "ERROR: scan path $_p does not exist; update scan_paths" >&2
    failed=1
  fi
done
if [ "$failed" -ne 0 ]; then
  exit 1
fi

# Prints why an x.y.z[-suffix] tag is not acceptable; prints nothing if it is.
nginx_tag_problem() {
  local tag="$1" major minor patch
  if ! [[ "$tag" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(-[[:alnum:]_.-]+)?$ ]]; then
    echo "tag '$tag' is not a fixed x.y.z release"
    return
  fi
  major=$((10#${BASH_REMATCH[1]}))
  minor=$((10#${BASH_REMATCH[2]}))
  patch=$((10#${BASH_REMATCH[3]}))
  if [ "$major" -gt 1 ] ||
    { [ "$major" -eq 1 ] && [ "$minor" -ge 32 ]; } ||
    { [ "$major" -eq 1 ] && [ "$minor" -eq 31 ] && [ "$patch" -ge 7 ]; } ||
    { [ "$major" -eq 1 ] && [ "$minor" -eq 30 ] && [ "$patch" -ge 6 ]; }; then
    return
  fi
  echo "release $major.$minor.$patch is below $BASELINE_TEXT"
}

# Splits [registry/]name[:tag][@digest] into the globals ref_tag and ref_digest.
split_ref() {
  local last="${1##*/}" rest
  rest="${last#"${last%%[:@]*}"}"
  ref_tag=""
  ref_digest=""
  case "$rest" in
    :*@*) ref_tag="${rest#:}"; ref_tag="${ref_tag%%@*}"; ref_digest="${rest#*@}" ;;
    :*) ref_tag="${rest#:}" ;;
    @*) ref_digest="${rest#@}" ;;
  esac
}

# Prints why an NGINX reference is not acceptable; prints nothing if it is.
nginx_ref_problem() {
  split_ref "$1"
  if [ -n "$ref_digest" ]; then
    if [ -z "$ref_tag" ]; then
      echo "digest without a version tag (write nginx:<x.y.z>[-suffix]@sha256:...)"
      return
    fi
    if ! [[ "$ref_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      echo "malformed digest '$ref_digest'"
      return
    fi
  fi
  nginx_tag_problem "$ref_tag"
}

is_nginx_name() {
  case "$1" in
    nginx | */nginx | nginxinc/nginx-unprivileged | */nginxinc/nginx-unprivileged) return 0 ;;
  esac
  return 1
}

# path:line:token for every tagged or digested NGINX reference.
scan_refs() {
  cd "$PROJECT_DIR"
  if command -v rg >/dev/null 2>&1; then
    rg --with-filename --line-number --only-matching --no-heading "$NGINX_REF_REGEX" "${scan_paths[@]}"
  else
    grep -RHnoE "$NGINX_REF_REGEX" "${scan_paths[@]}"
  fi
}

scan_untagged() {
  cd "$PROJECT_DIR"
  if command -v rg >/dev/null 2>&1; then
    rg --with-filename --line-number --no-heading --ignore-case "$NGINX_UNTAGGED_REGEX" "${scan_paths[@]}"
  else
    grep -RHniE "$NGINX_UNTAGGED_REGEX" "${scan_paths[@]}"
  fi
}

# path:line:name|newName|newTag|digest for each entry of a top-level images:
# list in every kustomization file under the scanned paths.
scan_kustomize_images() {
  local files
  cd "$PROJECT_DIR"
  files="$(find "${scan_paths[@]}" -type f \( -name kustomization.yaml -o -name kustomization.yml \))"
  [ -n "$files" ] || return 1
  # shellcheck disable=SC2086 # repository paths contain no whitespace
  awk '
    # flush() runs on the first line of the next file too, so the entry keeps
    # the file it was read from.
    function flush() {
      if (entry_line) print entry_file ":" entry_line ":" name "|" newname "|" newtag "|" digest
      entry_line = 0; name = ""; newname = ""; newtag = ""; digest = ""
    }
    function value(line) {
      sub(/^[^:]*:[[:space:]]*/, "", line); sub(/[[:space:]]+#.*$/, "", line)
      gsub(/^["\047]|["\047][[:space:]]*$/, "", line); return line
    }
    FNR == 1 { flush(); in_images = 0 }
    /^images:/ { flush(); in_images = 1; next }
    /^[^[:space:]#-]/ { flush(); in_images = 0 }
    !in_images { next }
    /^[[:space:]]*-[[:space:]]/ { flush(); entry_file = FILENAME; entry_line = FNR; sub(/-[[:space:]]+/, "") }
    /^[[:space:]]*name:/ { name = value($0) }
    /^[[:space:]]*newName:/ { newname = value($0) }
    /^[[:space:]]*newTag:/ { newtag = value($0) }
    /^[[:space:]]*digest:/ { digest = value($0) }
    END { flush() }
  ' $files
}

# Runs a scan and prints its output. Status 1 means "no match"; above 1 is a
# scan error, which must fail the guard instead of reading as "nothing found".
scan_or_fail() {
  local out status=0
  out="$("$1")" || status=$?
  if [ "$status" -gt 1 ]; then
    printf '%s\n' "$out"
    echo "ERROR: platform NGINX image scan ($1) failed with status $status." >&2
    return 1
  fi
  printf '%s' "$out"
}

# Turns scan hits into "path:line<TAB>ref" lines: tagged references as written,
# kustomize images entries composed into newName-or-name[:newTag][@digest].
collect_refs() {
  local hit path rest line token entry name newname newtag digest ref
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    path="${hit%%:*}"; rest="${hit#*:}"; line="${rest%%:*}"; token="${rest#*:}"
    case "$token" in [!A-Za-z0-9_.-]*) token="${token#?}" ;; esac
    split_ref "$token"
    # "nginx:" alone is a YAML key or prose; a '*' tag is a policy glob.
    [ -z "$ref_tag" ] && [ -z "$ref_digest" ] && continue
    case "$ref_tag" in *'*'*) continue ;; esac
    printf '%s:%s\t%s\n' "$path" "$line" "$token"
  done <<<"$ref_hits"
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    path="${entry%%:*}"; rest="${entry#*:}"; line="${rest%%:*}"; rest="${rest#*:}"
    IFS='|' read -r name newname newtag digest <<<"$rest"
    is_nginx_name "$name" || is_nginx_name "$newname" || continue
    ref="${newname:-$name}"
    if [ -z "$newtag" ] && [ -z "$digest" ]; then
      if ! is_nginx_name "$name"; then
        printf '%s:%s\t%s\n' "$path" "$line" "$ref:<no newTag>"
      fi
      continue
    fi
    [ -n "$newtag" ] && ref="$ref:$newtag"
    [ -n "$digest" ] && ref="$ref@$digest"
    printf '%s:%s\t%s\n' "$path" "$line" "$ref"
  done <<<"$kustomize_hits"
}

if ! ref_hits="$(scan_or_fail scan_refs)"; then failed=1; fi
if ! untagged_hits="$(scan_or_fail scan_untagged)"; then failed=1; fi
if ! kustomize_hits="$(scan_or_fail scan_kustomize_images)"; then failed=1; fi
if [ "$failed" -ne 0 ]; then
  exit 1
fi
refs="$(collect_refs)"

if [ "${1:-}" = "--list-digest-pins" ]; then
  pins=""
  while IFS=$'\t' read -r where ref; do
    [ -n "$ref" ] || continue
    split_ref "$ref"
    if [ -n "$ref_digest" ] && [ -z "$(nginx_ref_problem "$ref")" ]; then
      pins="$pins$ref"$'\n'
    fi
  done <<<"$refs"
  printf '%s' "$pins" | sort -u
  exit 0
fi

bad=0
while IFS=$'\t' read -r where ref; do
  [ -n "$ref" ] || continue
  problem="$(nginx_ref_problem "$ref")"
  if [ -n "$problem" ]; then
    echo "ERROR: $where: $ref: $problem" >&2
    bad=1
  fi
done <<<"$refs"
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  echo "ERROR: ${hit%%:*}:$(printf '%s' "${hit#*:}" | cut -d: -f1): untagged NGINX image (implicit :latest)" >&2
  bad=1
done <<<"$untagged_hits"
if [ "$bad" -ne 0 ]; then
  echo "ERROR: vulnerable or floating platform NGINX image reference found; use $BASELINE_TEXT." >&2
  failed=1
fi

require_text() {
  local path="$1"
  local text="$2"
  if ! grep -Fq -- "$text" "$PROJECT_DIR/$path"; then
    echo "ERROR: expected '$text' in $path" >&2
    return 1
  fi
}

# The egress proxy Dockerfile must have exactly one FROM instruction (Dockerfile
# instructions are case-insensitive), equal to the fixed image pinned by its
# multi-arch index digest.
require_single_from() {
  local path="$1"
  local expected="$2"
  local from_lines
  from_lines="$(grep -iE '^[[:space:]]*FROM[[:space:]]' "$PROJECT_DIR/$path" || true)"
  if [ "$from_lines" != "$expected" ]; then
    echo "ERROR: $path must have exactly one FROM line, '$expected'; found: ${from_lines:-<none>}" >&2
    return 1
  fi
}

require_text "deploy/base/control-plane/control-api-rpc-gateway.yaml" "$FIXED_NGINX_IMAGE" || failed=1
require_text "deploy/base/control-plane/host-context-controller-api-gateway.yaml" "$FIXED_NGINX_IMAGE" || failed=1
require_text "deploy/base/control-plane/nginx-workflow-approval-gateway.yaml" "$FIXED_NGINX_IMAGE" || failed=1
require_text "deploy/base/profiles/profile-control-funnel.yaml" "$FIXED_NGINX_IMAGE" || failed=1
require_text "deploy/base/profiles/profile-control-funnel.yaml" "allowPrivilegeEscalation: false" || failed=1
require_text "deploy/base/profiles/profile-control-funnel.yaml" "runAsNonRoot: true" || failed=1
require_text "deploy/base/profiles/profile-control-funnel.yaml" "runAsUser: 101" || failed=1
require_text "deploy/base/profiles/profile-control-funnel.yaml" "drop:" || failed=1
require_text "deploy/base/profiles/profile-control-funnel.yaml" "- ALL" || failed=1
require_text "deploy/base/control-plane/control-api.yaml" "$EGRESS_PROXY_IMAGE" || failed=1
require_text "deploy/base/control-plane/host-context-controller.yaml" "$EGRESS_PROXY_IMAGE" || failed=1
require_text "host-context-controller/src/config.ts" "$EGRESS_PROXY_IMAGE" || failed=1
require_text "control-api/src/routes/admin/registry.ts" "$EGRESS_PROXY_IMAGE" || failed=1
require_text "control-api/src/routes/admin/remoteMcp.ts" "$EGRESS_PROXY_IMAGE" || failed=1
require_single_from "nginx-egress-proxy/Dockerfile" "FROM ${FIXED_NGINX_IMAGE}@${FIXED_NGINX_IMAGE_DIGEST}" || failed=1

if [ "$failed" -ne 0 ]; then
  exit 1
fi

checked="$(printf '%s\n' "$refs" | grep -c . || true)"
echo "OK -- platform NGINX images use fixed ${FIXED_NGINX_IMAGE} security baseline ($checked references checked)"
