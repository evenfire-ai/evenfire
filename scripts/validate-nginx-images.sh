#!/usr/bin/env bash
# Validate platform-owned NGINX runtime images stay on the fixed security
# baseline defined in scripts/nginx-image-policy.sh. User-authored arbitrary
# workload image tests are intentionally out of scope: this guard scans the
# surfaces that are deployed, pulled or copied by users (manifests, generated
# proxy defaults, deploy helpers, shipped recipe samples and docs, and the E2E
# fixtures that install platform NGINX). Unit tests that never pull an image
# are not scanned.
#
# Every nginx, nginx/nginx-unprivileged, and legacy
# nginxinc/nginx-unprivileged reference in the scanned paths must
# carry a full x.y.z tag at or above the floor of its release line. Floating,
# untagged and variable tags are rejected. A digest is accepted only next to
# such a tag; scripts/verify-nginx-image-digests.sh checks in CI that each
# pinned digest really is that NGINX version. Any image named nginx, under any
# registry path, is treated as upstream NGINX.
#
# This is a static text scan plus a yq parse of kustomization images: entries,
# not a renderer. It reads literal spellings: escape sequences in text files
# are not decoded (yq decodes them only in kustomization images: entries).
# Untagged references are recognised in an image field (YAML, JSON, flow maps,
# --image=, IMAGE=, after an optional YAML anchor or tag), a Dockerfile FROM or
# COPY --from= / --mount=...,from= source, and a shell array element in *.sh
# files; an image: key whose value is not on the same line is rejected. A name
# reached through indirection (a YAML alias, a shell variable) is not resolved.
#
#   --list-digest-pins   print every tag@digest reference and exit
#                        (input for verify-nginx-image-digests.sh)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/nginx-image-policy.sh
source "$SCRIPT_DIR/nginx-image-policy.sh"

FIXED_NGINX_IMAGE="nginx:1.30.6-alpine"
EGRESS_PROXY_IMAGE="clerum/nginx-egress-proxy:0.1.0"

# Pieces of the reference patterns. An optional literal registry[:port]/path/
# prefix may precede the repository name.
NGINX_NAME='(nginx|nginx/nginx-unprivileged|nginxinc/nginx-unprivileged)'
REGISTRY_PREFIX='([[:alnum:]_.-]+(:[0-9]+)?/)*'
# After an untagged name: anything that cannot continue a reference ('}' ends it).
# shellcheck disable=SC2016 # literal '$' and '{' in a regular expression
UNTAGGED_END='([^[:alnum:]_.:@/${-]|$)'
QUOTE="[\"']"

# An NGINX image reference: the repository name, then a tag and/or digest. The
# leading group keeps clerum/nginx-egress-proxy and foo-nginx:1 out. '$', '{'
# and '*' are captured so variable and glob tags are seen; '}' ends the token
# so a flow map such as {image: nginx:1.30.6-alpine} yields the reference.
# shellcheck disable=SC2016 # literal '$' and '{' in a regular expression
NGINX_REF_REGEX='(^|[^[:alnum:]_.-])'"$REGISTRY_PREFIX$NGINX_NAME"'[:@][[:alnum:]_.:@${*-]*'
# An untagged NGINX image (implicitly :latest) in an image field (after an
# optional YAML anchor or tag such as &img or !!str), a Dockerfile FROM
# (keywords in any case, optional --flag=value words), or a Dockerfile
# COPY --from= / RUN --mount=...,from= source.
YAML_NODE_PROPERTIES='([&!][^[:space:]]*[[:space:]]+)*'
NGINX_UNTAGGED_REGEX="[Ii][Mm][Aa][Gg][Ee]$QUOTE?[[:space:]]*[:=][[:space:]]*$YAML_NODE_PROPERTIES$QUOTE?$REGISTRY_PREFIX$NGINX_NAME$UNTAGGED_END"
NGINX_UNTAGGED_REGEX="$NGINX_UNTAGGED_REGEX|^[[:space:]]*[Ff][Rr][Oo][Mm][[:space:]]+(--[^[:space:]]+[[:space:]]+)*$REGISTRY_PREFIX$NGINX_NAME$UNTAGGED_END"
NGINX_UNTAGGED_REGEX="$NGINX_UNTAGGED_REGEX|(--|[,=])[Ff][Rr][Oo][Mm]=$QUOTE?$REGISTRY_PREFIX$NGINX_NAME$UNTAGGED_END"
# An untagged NGINX shell-array element, quoted or not: after =( or +=( on the
# same line, or alone on its own line.
NGINX_UNTAGGED_ARRAY_REGEX="=\\(([^)]*[[:space:]])?$QUOTE?$REGISTRY_PREFIX$NGINX_NAME([\"'[:space:])]|\$)"
NGINX_UNTAGGED_ARRAY_REGEX="$NGINX_UNTAGGED_ARRAY_REGEX|^[[:space:]]*$QUOTE?$REGISTRY_PREFIX$NGINX_NAME$QUOTE?[[:space:]]*\\)?[[:space:]]*\$"
# A YAML image key with no value on its line (empty or a block scalar): the
# reference on the following lines cannot be read by the patterns above.
IMAGE_KEY_WITHOUT_VALUE_REGEX="^[[:space:]-]*$QUOTE?image$QUOTE?[[:space:]]*:[[:space:]]*([>|][-+0-9]*)?[[:space:]]*(#.*)?\$"

# Every path must exist: a renamed or deleted path is an error, never a
# silent skip. deploy/ covers base, components and every overlay, including
# the GCP overlays when the infra repository assembles this tree.
scan_paths=(
  "deploy"
  "host-context-controller/src/config.ts"
  "control-api/src/routes/admin/registry.ts"
  "control-api/src/routes/admin/remoteMcp.ts"
  "nginx-egress-proxy/Dockerfile"
  "control-ui/e2e/registry-install.spec.ts"
  "control-ui/e2e/qa-recorder-recipe-scope-copy.spec.ts"
  "desktop-app/test/e2e-playwright/sandbox-ui-apps-catalog-authz.test.ts"
  "scripts/minikube/build-images.sh"
  "scripts/bootstrap-cluster.sh"
  "scripts/e2e"
  "docs/deploy/workflow-recipes-guide.md"
  "docs/agents/CLERUM_WORKFLOW_RECIPE_GUIDE.md"
  "workflow-recipes/samples"
  "tests/e2e/integration/control-api-k8s.test.ts"
  "tests/e2e/playwright/control-ui/recipes.spec.ts"
  "tests/e2e/playwright/control-ui/recipe-scope-copy.spec.ts"
  "tests/e2e/playwright/control-ui/workflow-recipe-egressbindings.spec.ts"
  "workflow-recipes/tests/e2e"
)

cd "$PROJECT_DIR"

failed=0
for _p in "${scan_paths[@]}"; do
  if [ ! -e "$_p" ]; then
    echo "ERROR: scan path $_p does not exist; update scan_paths" >&2
    failed=1
  fi
done
if [ "$failed" -ne 0 ]; then
  exit 1
fi

# scan_or_fail STAGE GREP_ARGS...: runs grep and prints its output. Status 1
# means "no match"; above 1 is a scan error (an unreadable file, a bad
# pattern), which fails the guard naming the stage instead of reading as
# "nothing found". Hidden and gitignored files are read like any other.
scan_or_fail() {
  local stage="$1" out status=0
  shift
  out="$(grep "$@")" || status=$?
  if [ "$status" -gt 1 ]; then
    echo "ERROR: platform NGINX image scan ($stage) failed with status $status." >&2
    return 1
  fi
  printf '%s' "$out"
}

# Files that mention nginx at all; the pattern scans read only these.
candidate_list="$(scan_or_fail candidates -RlF -e nginx -- "${scan_paths[@]}")" || exit 1
if [ -z "$candidate_list" ]; then
  echo "ERROR: platform NGINX image scan (candidates) found no file mentioning nginx; check scan_paths." >&2
  exit 1
fi
candidates=()
shell_candidates=()
while IFS= read -r _f; do
  candidates+=("$_f")
  case "$_f" in *.sh) shell_candidates+=("$_f") ;; esac
done <<<"$candidate_list"

# Kustomizations by file name, not content: a YAML escape such as "ngin\x78"
# carries no literal "nginx" but kustomize decodes it to nginx.
kustomization_list="$(scan_or_fail kustomizations -Rl --include=kustomization.yaml \
  --include=kustomization.yml --include=Kustomization -e '' -- "${scan_paths[@]}")" || exit 1

ref_hits="$(scan_or_fail tagged -HnoE "$NGINX_REF_REGEX" -- "${candidates[@]}")" || failed=1
untagged_hits="$(scan_or_fail untagged -HnE "$NGINX_UNTAGGED_REGEX" -- "${candidates[@]}")" || failed=1
if [ "${#shell_candidates[@]}" -gt 0 ]; then
  array_hits="$(scan_or_fail shell-array -HnE "$NGINX_UNTAGGED_ARRAY_REGEX" -- "${shell_candidates[@]}")" || failed=1
else
  array_hits=""
fi
image_key_hits="$(scan_or_fail image-key -HnE "$IMAGE_KEY_WITHOUT_VALUE_REGEX" -- "${candidates[@]}")" || failed=1
if [ "$failed" -ne 0 ]; then
  exit 1
fi

# line|name|newName|newTag|digest for each entry of a top-level images: list.
# yq's join writes an absent or null field as an empty string.
kustomize_hits=""
if [ -n "$kustomization_list" ]; then
  if ! command -v yq >/dev/null 2>&1; then
    echo "ERROR: yq is required to read kustomization images: entries (first file: ${kustomization_list%%$'\n'*})" >&2
    exit 1
  fi
  while IFS= read -r _f; do
    if ! _entries="$(yq '(.images // [])[] | [line, .name, .newName, .newTag, .digest] | join("|")' "$_f")"; then
      echo "ERROR: yq could not read the images: entries of $_f" >&2
      failed=1
      continue
    fi
    while IFS= read -r _e; do
      if [ -n "$_e" ]; then
        kustomize_hits="$kustomize_hits$_f|$_e"$'\n'
      fi
    done <<<"$_entries"
  done <<<"$kustomization_list"
  if [ "$failed" -ne 0 ]; then
    exit 1
  fi
fi

# Turns scan hits into "path:line<TAB>ref" lines: tagged references as written,
# kustomize images entries composed into newName-or-name[:newTag][@digest].
collect_refs() {
  local hit path rest line token name newname newtag digest ref last repo
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    path="${hit%%:*}"; rest="${hit#*:}"; line="${rest%%:*}"; token="${rest#*:}"
    case "$token" in [!A-Za-z0-9_.-]*) token="${token#?}" ;; esac
    split_ref "$token"
    # "nginx@" has an empty digest: report it before the skip below drops it.
    if [ "$ref_at" -eq 1 ] && [ -z "$ref_digest" ]; then
      printf '%s:%s\t%s\n' "$path" "$line" "$token"
      continue
    fi
    # "nginx:" alone is a YAML key or prose.
    [ -z "$ref_tag" ] && [ -z "$ref_digest" ] && continue
    printf '%s:%s\t%s\n' "$path" "$line" "$token"
  done <<<"$ref_hits"
  while IFS='|' read -r path line name newname newtag digest; do
    [ -n "$path" ] || continue
    ref="${newname:-$name}"
    # newName may carry its own tag or digest; classify the repository part.
    last="${ref##*/}"
    repo="${ref%"$last"}${last%%[:@]*}"
    is_nginx_name "$repo" || continue
    if [ "$ref" = "$repo" ] && [ -z "$newtag" ] && [ -z "$digest" ]; then
      # A plain name entry leaves the source tag to the text scan; a rewrite
      # of another image to NGINX without a tag pulls :latest.
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
done <<<"$untagged_hits"$'\n'"$array_hits"
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  echo "ERROR: ${hit%%:*}:$(printf '%s' "${hit#*:}" | cut -d: -f1): write the image reference on the same line as image:" >&2
  bad=1
done <<<"$image_key_hits"
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
# instructions are case-insensitive): the fixed image pinned by a multi-arch
# index digest. verify-nginx-image-digests.sh proves the digest is that release.
require_single_from() {
  local path="$1"
  local from_lines digest
  from_lines="$(grep -iE '^[[:space:]]*FROM[[:space:]]' "$PROJECT_DIR/$path" || true)"
  digest="${from_lines#"FROM $FIXED_NGINX_IMAGE@"}"
  if [ "$digest" = "$from_lines" ] || ! [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "ERROR: $path must have exactly one FROM line, 'FROM $FIXED_NGINX_IMAGE@sha256:<64 hex>'; found: ${from_lines:-<none>}" >&2
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
require_single_from "nginx-egress-proxy/Dockerfile" || failed=1

checked="$(printf '%s\n' "$refs" | grep -c . || true)"
if [ "$checked" -eq 0 ]; then
  echo "ERROR: no platform NGINX image reference was checked; the scan read nothing." >&2
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "OK -- platform NGINX images use fixed ${FIXED_NGINX_IMAGE} security baseline ($checked references checked)"
