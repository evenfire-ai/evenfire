#!/usr/bin/env bash
# Per-tag registry stub and git fixtures for the release test harnesses
# (test-resolve-release-images.sh, test-promote-release-images.sh). Source it;
# every helper takes the test's temp dir first, and everything it writes lives
# under that dir. Runs under macOS /bin/bash 3.2 as well as bash 5, so no
# mapfile, associative arrays or other bash-4-only syntax.
#
# The fake `crane` answers from "$d/registry.tsv", one row per line:
#
#   <ref>\t<kind>\t<payload>
#
#   kind digest    `crane digest <ref>` prints <payload> on stdout, exits 0
#   kind manifest  `crane manifest <ref>` prints <payload> on stdout, exits 0
#   kind error     either subcommand on <ref> prints <payload> on stderr, exits 1
#
# The LAST row matching the ref and subcommand wins, so a later row overrides
# an earlier one: `stub_image` then `stub_error` on the same ref makes that ref
# fail. A ref with no matching row fails the way real crane does for a missing
# tag (`MANIFEST_UNKNOWN`), so "not in the table" means "not in the registry".
#
# Every call is appended to "$d/crane-calls" ("$*", one line per call), and
# `crane copy <src> <dst>` appends "<src> <dst>" to "$d/copy-log".

RELEASE_STUB_REGISTRY='ghcr.io/evenfire-ai'

# stub_install <d>
stub_install() {
  local d=$1
  mkdir -p "$d/bin"
  : > "$d/registry.tsv"
  : > "$d/crane-calls"
  : > "$d/copy-log"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'state=%q\n' "$d"
    cat <<'CRANE'
printf '%s\n' "$*" >> "$state/crane-calls"
case "${1:-}" in
  digest|manifest)
    cmd=$1 ref=${2:-}
    row="$(awk -v ref="$ref" -v cmd="$cmd" '
      BEGIN { FS = "\t" }
      $1 == ref && ($2 == cmd || $2 == "error") {
        kind = $2; payload = substr($0, length($1) + length($2) + 3); found = 1
      }
      END { if (found) printf "%s\t%s", kind, payload }
    ' "$state/registry.tsv")"
    if [ -z "$row" ]; then
      printf 'Error: GET https://%s: MANIFEST_UNKNOWN: manifest unknown\n' "$ref" >&2
      exit 1
    fi
    kind=${row%%$'\t'*} payload=${row#*$'\t'}
    if [ "$kind" = error ]; then
      printf '%s\n' "$payload" >&2
      exit 1
    fi
    printf '%s\n' "$payload"
    ;;
  copy)
    printf '%s %s\n' "${2:-}" "${3:-}" >> "$state/copy-log"
    ;;
  *)
    printf 'crane stub: unsupported command: %s\n' "$*" >&2
    exit 1
    ;;
esac
CRANE
  } > "$d/bin/crane"
  chmod +x "$d/bin/crane"
}

# stub_image <d> <name> <tag> <digest> <revision|-> [archs]
# <name>:<tag> resolves to <digest>, and <name>@<digest> is an index carrying
# the revision annotation (none when <revision> is "-") and one manifests[]
# entry per comma-separated arch (default amd64,arm64).
stub_image() {
  local d=$1 name=$2 tag=$3 digest=$4 revision=$5 archs=${6:-amd64,arm64}
  local arch manifests='' annotations=''
  local old_ifs=$IFS
  IFS=,
  for arch in $archs; do
    manifests="${manifests:+$manifests,}{\"platform\":{\"architecture\":\"$arch\",\"os\":\"linux\"}}"
  done
  IFS=$old_ifs
  if [ "$revision" != - ]; then
    annotations=",\"annotations\":{\"org.opencontainers.image.revision\":\"$revision\"}"
  fi
  printf '%s\t%s\t%s\n' "$RELEASE_STUB_REGISTRY/$name:$tag" digest "$digest" >> "$d/registry.tsv"
  printf '%s\t%s\t%s\n' "$RELEASE_STUB_REGISTRY/$name@$digest" manifest \
    "{\"schemaVersion\":2,\"mediaType\":\"application/vnd.oci.image.index.v1+json\",\"manifests\":[$manifests]$annotations}" \
    >> "$d/registry.tsv"
}

# stub_error <d> <ref> <text>
# Both `crane digest <ref>` and `crane manifest <ref>` print <text> on stderr
# and exit 1. <ref> is the full reference, e.g. ghcr.io/evenfire-ai/x:latest.
stub_error() {
  printf '%s\t%s\t%s\n' "$2" error "$3" >> "$1/registry.tsv"
}

# stub_manifest <d> <ref> <payload>
# `crane manifest <ref>` prints <payload> (a single line) and exits 0. Added
# after stub_image, it replaces that image's index, e.g. with text that is not
# JSON, or JSON that is not an object.
stub_manifest() {
  printf '%s\t%s\t%s\n' "$2" manifest "$3" >> "$1/registry.tsv"
}

# git_shim_install <d> <code>
# "$d/bin/git" exits <code> for `git merge-base --is-ancestor ...` and execs
# the real git (resolved now, before "$d/bin" is on PATH) for everything else.
git_shim_install() {
  local d=$1 code=$2 real
  real="$(command -v git)"
  if [ -z "$real" ] || [ "$real" = "$d/bin/git" ]; then
    echo "git_shim_install: cannot find the real git outside $d/bin" >&2
    return 1
  fi
  mkdir -p "$d/bin"
  {
    printf '#!/usr/bin/env bash\n'
    # shellcheck disable=SC2016 # the shim expands $1/$2 at run time, not here
    printf 'if [ "${1:-}" = merge-base ] && [ "${2:-}" = --is-ancestor ]; then exit %d; fi\n' "$code"
    printf 'exec %q "$@"\n' "$real"
  } > "$d/bin/git"
  chmod +x "$d/bin/git"
}

# git_shim_fail_on <d> <code> <glob>
# "$d/bin/git" prints a line on stderr and exits <code> when its arguments
# ("$*") match the shell glob <glob>, and execs the real git (resolved now,
# before "$d/bin" is on PATH) for everything else. Unlike git_shim_install,
# it can fail one call and not its neighbours: one direction of
# `merge-base --is-ancestor`, or one revision's `git diff`.
#   git_shim_fail_on "$d" 128 "merge-base --is-ancestor $T $D3"   # reverse check only
#   git_shim_fail_on "$d" 128 "diff --name-only $M1 *"
git_shim_fail_on() {
  local d=$1 code=$2 glob=$3 real
  real="$(command -v git)"
  if [ -z "$real" ] || [ "$real" = "$d/bin/git" ]; then
    echo "git_shim_fail_on: cannot find the real git outside $d/bin" >&2
    return 1
  fi
  mkdir -p "$d/bin"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'glob=%q\n' "$glob"
    # An unquoted $glob in a case pattern is matched as a pattern, so its
    # `*` stays a wildcard while the spaces in it stay literal.
    # shellcheck disable=SC2016 # the shim expands $glob and $* at run time, not here
    printf 'case "$*" in $glob) echo "git shim: exit %d for: $*" >&2; exit %d ;; esac\n' "$code" "$code"
    printf 'exec %q "$@"\n' "$real"
  } > "$d/bin/git"
  chmod +x "$d/bin/git"
}

# make_release_repo <d>
# A git repo in <d> shaped like a release line, with its SHAs written to
# "$d/shas.env" (C0 D1 M1 D3 F1 H1 T). No tags; each test adds its own.
#
#   main:  C0 ── M1 ── H1 ── T          T touches prep/x only
#           \   /     /
#   dev:     D1      F1(hotfix branch, widget/a.ts=fix)
#            \
#             D3  (dev after M1, never merged; :latest revisions point here)
#
# C0 creates widget/a.ts and other/a.ts; D1 and D3 change widget/a.ts. M1 and
# H1 are `git merge --no-ff` of D1 and F1. HEAD is left on main at T. Only the
# fixture paths are committed, so the stub's files in <d> stay untracked.
make_release_repo() {
  local d=$1 c0 d1 m1 d3 f1 h1 t
  mkdir -p "$d/widget" "$d/other" "$d/prep"
  git init -q -b main "$d" || return 1
  echo base > "$d/widget/a.ts"; echo base > "$d/other/a.ts"
  _release_stub_commit "$d" C0 widget other || return 1; c0=$(git -C "$d" rev-parse HEAD)
  git -C "$d" checkout -q -b dev
  echo dev-1 > "$d/widget/a.ts"
  _release_stub_commit "$d" D1 widget || return 1; d1=$(git -C "$d" rev-parse HEAD)
  git -C "$d" checkout -q main
  _release_stub_git "$d" merge -q --no-ff --no-edit -m M1 dev || return 1; m1=$(git -C "$d" rev-parse HEAD)
  git -C "$d" checkout -q -b hotfix
  echo fix > "$d/widget/a.ts"
  _release_stub_commit "$d" F1 widget || return 1; f1=$(git -C "$d" rev-parse HEAD)
  git -C "$d" checkout -q main
  _release_stub_git "$d" merge -q --no-ff --no-edit -m H1 hotfix || return 1; h1=$(git -C "$d" rev-parse HEAD)
  echo x > "$d/prep/x"
  _release_stub_commit "$d" T prep || return 1; t=$(git -C "$d" rev-parse HEAD)
  git -C "$d" checkout -q dev
  echo dev-3 > "$d/widget/a.ts"
  _release_stub_commit "$d" D3 widget || return 1; d3=$(git -C "$d" rev-parse HEAD)
  git -C "$d" checkout -q main
  printf 'C0=%s\nD1=%s\nM1=%s\nD3=%s\nF1=%s\nH1=%s\nT=%s\n' \
    "$c0" "$d1" "$m1" "$d3" "$f1" "$h1" "$t" > "$d/shas.env"
}

# git in <d> with a throwaway identity and no signing, whatever the host's
# global config says.
_release_stub_git() {
  local d=$1; shift
  git -C "$d" -c user.email=t@t -c user.name=t -c commit.gpgsign=false "$@"
}

# _release_stub_commit <d> <message> <path>...
_release_stub_commit() {
  local d=$1 message=$2; shift 2
  _release_stub_git "$d" add -- "$@" && _release_stub_git "$d" commit -qm "$message"
}
