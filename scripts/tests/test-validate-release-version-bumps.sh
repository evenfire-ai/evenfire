#!/usr/bin/env bash
# validate-release-version-bumps.mjs on real merges in a throwaway repository, its
# service list against the roots the pre-commit hook bumps, and its required CI steps.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

TESTS_RUN=0
TESTS_FAILED=0
pass() { TESTS_RUN=$((TESTS_RUN + 1)); }
fail() {
  TESTS_RUN=$((TESTS_RUN + 1))
  TESTS_FAILED=$((TESTS_FAILED + 1))
  echo "FAIL: $1" >&2
}

git_q() { git -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null -c core.excludesFile=/dev/null "$@"; }

write_package() { # <root> <version>
  mkdir -p "$1"
  printf '{ "name": "%s", "version": "%s" }\n' "$(basename "$1")" "$2" >"$1/package.json"
}

commit_all() { # <message>
  git_q add -A
  git_q commit -q -m "$1"
}

expect_run() { # <name> <want-exit> <want-output> <args...>
  local name="$1" want_exit="$2" want_output="$3" exit_code=0 output
  shift 3
  output="$(node scripts/release/validate-release-version-bumps.mjs "$@" 2>&1)" || exit_code=$?
  if [ "$exit_code" -ne "$want_exit" ]; then
    fail "$name: exit $exit_code, want $want_exit: $output"
  elif ! printf '%s' "$output" | grep -qF -- "$want_output"; then
    fail "$name: output lacks '$want_output': $output"
  else
    pass
  fi
}

mkdir -p "$WORK/repo/scripts/release"
cd "$WORK/repo"
git_q init -q -b dev
cp "$REPO_ROOT/scripts/release/validate-release-version-bumps.mjs" scripts/release/
for root in control-api control-ui workflow-recipes; do write_package "$root" 0.1.1; done
mkdir -p control-api/src control-ui/app workflow-recipes/tests/e2e
echo one >control-api/src/config.ts
echo one >control-ui/app/page.tsx
echo one >control-api/README.md
echo one >workflow-recipes/tests/e2e/flow.ts
commit_all 'base'

# Two branches reach the same next version with different code; the merge is clean.
git_q checkout -q -b feature
echo feature >control-api/src/config.ts
write_package control-api 0.1.2
commit_all 'feature'
git_q checkout -q dev
echo other >control-api/src/other.ts
write_package control-api 0.1.2
commit_all 'dev moves too'
dev_tip="$(git rev-parse HEAD)"
git_q merge -q --no-edit feature
[ "$(git rev-parse HEAD^1)" = "$dev_tip" ] || { echo "FAIL: fixture merge is not a merge commit" >&2; exit 1; }
git_q tag collision

expect_run 'a clean version collision fails with --all-services' 1 \
  'control-api code changed but control-api/package.json stayed at 0.1.2' --previous HEAD^1 --all-services
# The push leg's mode covers only the release packages, so it stays green on the same merge.
expect_run 'the default mode does not check the other services' 0 'are valid' --previous HEAD^1

# The same merge with a version of its own passes.
write_package control-api 0.1.3
commit_all 'bump'
expect_run 'a version above the base passes' 0 'are valid' --previous "$dev_tip" --all-services

# Directories that differ per service, and files that are not shipped code.
checkpoint="$(git rev-parse HEAD)"
echo two >control-ui/app/page.tsx
commit_all 'ui change'
expect_run 'a UI service without src/ is covered' 1 \
  'control-ui code changed but control-ui/package.json stayed at 0.1.1' --previous "$checkpoint" --all-services

checkpoint="$(git rev-parse HEAD)"
echo two >control-api/README.md
echo two >workflow-recipes/tests/e2e/flow.ts
commit_all 'not shipped code'
expect_run 'files outside the shipped code need no bump' 0 'are valid' --previous "$checkpoint" --all-services

# Fail loud: a service without a package.json cannot pass as unchanged.
checkpoint="$(git rev-parse HEAD)"
mv control-api/package.json control-api/package.json.moved
echo three >control-api/src/config.ts
commit_all 'code without a package'
expect_run 'a missing package.json fails instead of passing' 1 \
  '::error::control-api/package.json is missing at HEAD' --previous "$checkpoint" --all-services

new_fixture() { # <dir> <root...>: a repository with the validator and these packages at 0.1.9
  local dir="$WORK/$1" root
  shift
  mkdir -p "$dir/scripts/release"
  cd "$dir"
  git_q init -q -b dev
  cp "$REPO_ROOT/scripts/release/validate-release-version-bumps.mjs" scripts/release/
  for root in "$@"; do
    write_package "$root" 0.1.9
    mkdir -p "$root/src"
    echo one >"$root/src/code.ts"
  done
  commit_all 'base'
}

# Versions are ordered numerically: 0.1.10 is above 0.1.9, a lower one reissues numbers.
new_fixture order control-api rpc-proxy
checkpoint="$(git rev-parse HEAD)"
echo two >control-api/src/code.ts
write_package control-api 0.1.10
commit_all 'bump past nine'
expect_run 'a version above the base passes in numeric order' 0 'are valid' --previous "$checkpoint" --all-services

checkpoint="$(git rev-parse HEAD)"
echo three >control-api/src/code.ts
write_package control-api 0.1.9
commit_all 'code and a lower version'
expect_run 'a version below the base fails' 1 \
  'control-api/package.json went down from 0.1.10 to 0.1.9' --previous "$checkpoint" --all-services

checkpoint="$(git rev-parse HEAD)"
write_package rpc-proxy 0.1.8
commit_all 'only a lower version'
expect_run 'a lower version with no code change fails' 1 \
  'rpc-proxy/package.json went down from 0.1.9 to 0.1.8' --previous "$checkpoint" --all-services
# The push leg's mode compares for equality only: it has no branch left to fix.
checkpoint="$(git rev-parse HEAD)"
echo two >rpc-proxy/src/code.ts
write_package rpc-proxy 0.1.7
commit_all 'code and a lower version on a release package'
expect_run 'the default mode does not order versions' 0 'are valid' --previous "$checkpoint"

# A version this check cannot order is refused with an annotation. The patterns are anchored on
# both ends, so neither form reads as the x.y.z inside it.
new_fixture unorderable control-api
for version in 0.2.0-rc.1 v0.2.0; do
  checkpoint="$(git rev-parse HEAD)"
  echo "$version" >control-api/src/code.ts
  write_package control-api "$version"
  commit_all "move to $version"
  expect_run "$version is refused" 1 \
    "::error::cannot order control-api/package.json" --previous "$checkpoint" --all-services
done
# A version that did not move needs no ordering: a change beside it asks for a bump, as for any other.
checkpoint="$(git rev-parse HEAD)"
echo three >control-api/src/code.ts
commit_all 'code at a version this check cannot order'
expect_run 'an unorderable version that did not move is an ordinary missing bump' 1 \
  '::error::control-api code changed but control-api/package.json stayed at v0.2.0' --previous "$checkpoint" --all-services
# The base's version can be the one this check cannot order.
checkpoint="$(git rev-parse HEAD)"
echo four >control-api/src/code.ts
write_package control-api 0.2.1
commit_all 'move off a version this check cannot order'
expect_run 'a version moving off an unorderable one is refused' 1 \
  '::error::cannot order control-api/package.json: v0.2.0 to 0.2.1' --previous "$checkpoint" --all-services

# A service the base does not have has no version to collide with, so one pull request can add
# it and list it. mcp-proxy stands for the new root: the validator's copy lists it.
new_fixture new-service control-api
checkpoint="$(git rev-parse HEAD)"
write_package mcp-proxy 0.1.1
mkdir -p mcp-proxy/src
echo one >mcp-proxy/src/code.ts
commit_all 'a new listed service'
expect_run 'a listed service the base does not have passes' 0 'are valid' --previous "$checkpoint" --all-services
# Witness: that diff was read, and a service the base has is still checked beside the new one.
echo two >control-api/src/code.ts
commit_all 'code in a service the base has'
expect_run 'a service the base has is still checked beside a new one' 1 \
  'control-api code changed but control-api/package.json stayed at 0.1.9' --previous "$checkpoint" --all-services
# A rename with the list left as it was fails: the list would silently stop covering the service.
checkpoint="$(git rev-parse HEAD)"
git_q mv mcp-proxy mcp-gateway
commit_all 'rename a listed service'
expect_run 'renaming a listed service without editing the list fails' 1 \
  '::error::mcp-proxy/package.json is missing at HEAD' --previous "$checkpoint" --all-services

# A rename counts on both sides.
new_fixture renames control-api
echo one >control-api/src/renamed.ts
echo other >control-api/src/moved.ts
commit_all 'files to rename'
checkpoint="$(git rev-parse HEAD)"
git_q mv control-api/src/renamed.ts control-api/src/renamed.test.ts
commit_all 'a source file becomes a test name'
expect_run 'a source file renamed to a test name needs a bump' 1 \
  'control-api code changed but control-api/package.json stayed at 0.1.9' --previous "$checkpoint" --all-services
checkpoint="$(git rev-parse HEAD)"
mkdir -p packages/moved
git_q mv control-api/src/moved.ts packages/moved/moved.ts
commit_all 'a source file leaves the service'
expect_run 'a file moved out of a service needs a bump' 1 \
  'control-api code changed but control-api/package.json stayed at 0.1.9' --previous "$checkpoint" --all-services

# git quotes a path with a non-ASCII character or a double quote; the check reads it as it is.
new_fixture quoted-paths control-api
for name in 'café.ts' 'a"b.ts'; do
  echo one >"control-api/src/$name"
  commit_all "add control-api/src/$name"
  expect_run "control-api/src/$name needs a bump" 1 \
    'control-api code changed but control-api/package.json stayed at 0.1.9' --previous HEAD^ --all-services
done

# Test files beside the code need no bump; the code beside them does.
new_fixture tests-beside control-api control-ui workflow-recipes
mkdir -p control-ui/components/__tests__/fixtures
echo one >control-ui/components/__tests__/fixtures/card.ts
commit_all 'a fixture'
checkpoint="$(git rev-parse HEAD)"
mkdir -p control-api/test control-ui/e2e
echo two >control-api/src/code.test.ts
echo two >control-api/src/code.spec.tsx
echo two >control-api/test/route.ts
echo two >control-ui/components/__tests__/fixtures/card.ts
echo two >control-ui/e2e/flow.ts
echo two >workflow-recipes/src/run.testFixtures.ts
commit_all 'test files only'
expect_run 'test files under a service directory need no bump' 0 'are valid' --previous "$checkpoint" --all-services
# Witness: the same directory's code still fails, so the run above read these paths.
echo two >control-api/src/code.ts
commit_all 'the code beside them'
expect_run 'code beside those test files still needs a bump' 1 \
  'control-api code changed but control-api/package.json stayed at 0.1.9' --previous "$checkpoint" --all-services
# The test names apply at the service's root, not to a directory that ships.
new_fixture test-named-source control-api
mkdir -p control-api/src/test
echo one >control-api/src/test/helper.ts
commit_all 'a helper under src'
checkpoint="$(git rev-parse HEAD)"
echo two >control-api/src/test/helper.ts
commit_all 'change the helper'
expect_run 'a directory named test under src still counts' 1 \
  'control-api code changed but control-api/package.json stayed at 0.1.9' --previous "$checkpoint" --all-services
# A package.json edit that leaves the version alone changes what npm installs in the image.
checkpoint="$(git rev-parse HEAD)"
printf '{ "name": "control-api", "version": "0.1.9", "dependencies": {} }\n' >control-api/package.json
commit_all 'a dependency line at the same version'
expect_run 'a package.json change at the same version needs a bump' 1 \
  'control-api code changed but control-api/package.json stayed at 0.1.9' --previous "$checkpoint" --all-services

# Dev-only files at a service's root need no bump. Each red row is the witness for the green row
# before it, in the same fixture: the same name one directory down still needs a bump. A root with
# a slash in it is here too, because the exclusion reads the path relative to the root.
new_fixture dev-only control-api channel-reader control-ui host-context-controller mcp-host \
  mcp-servers/doc-generator profile-ui workflow-recipes
expect_dev_only() { # <root> <path under the root>
  local root="$1" path="$2"
  mkdir -p "$(dirname "$root/$path")" "$(dirname "$root/src/$path")"
  echo one >"$root/$path"
  commit_all "add $root/$path"
  expect_run "$root/$path needs no bump" 0 'are valid' --previous HEAD^ --all-services
  echo one >"$root/src/$path"
  commit_all "add $root/src/$path"
  expect_run "$root/src/$path needs a bump" 1 \
    "$root code changed but $root/package.json stayed at 0.1.9" --previous HEAD^ --all-services
}
expect_dev_only control-api Makefile
expect_dev_only channel-reader makefile
expect_dev_only mcp-servers/doc-generator Makefile
expect_dev_only control-api vitest.config.ts
expect_dev_only profile-ui vitest.config.mts
expect_dev_only host-context-controller .env.example
expect_dev_only control-api scripts/tool.mjs
expect_dev_only mcp-host scripts/tool.mjs
expect_dev_only workflow-recipes scripts/tool.sh
# scripts/ counts in a service that does not keep dev tools there.
for root in control-ui profile-ui; do
  mkdir -p "$root/scripts"
  echo one >"$root/scripts/tool.ts"
  commit_all "add $root/scripts/tool.ts"
  expect_run "$root/scripts/tool.ts needs a bump" 1 \
    "$root code changed but $root/package.json stayed at 0.1.9" --previous HEAD^ --all-services
done

# The release script writes this file, so a change to it alone needs no bump. Code beside it does.
new_fixture release-manifest external-rest-api
echo one >external-rest-api/src/releaseManifest.ts
commit_all 'a manifest'
checkpoint="$(git rev-parse HEAD)"
echo two >external-rest-api/src/releaseManifest.ts
commit_all 'the manifest moves'
expect_run 'the release manifest alone needs no bump' 0 'are valid' --previous "$checkpoint" --all-services
echo two >external-rest-api/src/code.ts
commit_all 'code beside the manifest'
expect_run 'code beside the release manifest needs a bump' 1 \
  'external-rest-api code changed but external-rest-api/package.json stayed at 0.1.9' --previous "$checkpoint" --all-services

# A revert merges into a version below the base, and git revert runs no hook. The check refuses
# it until the pull request sets the version above the base: the next hook bump would otherwise
# issue a number that already named the reverted code.
new_fixture revert control-api
git_q checkout -q -b feature
echo two >control-api/src/code.ts
write_package control-api 0.1.10
commit_all 'the change to revert'
git_q checkout -q dev
git_q merge -q --no-ff --no-edit feature
merged="$(git rev-parse HEAD)"
git_q checkout -q -b revert-it
git_q revert --no-edit -m 1 "$merged" >/dev/null
git_q checkout -q dev
git_q merge -q --no-ff --no-edit revert-it
expect_run 'a clean revert fails until the version is above the base' 1 \
  'control-api/package.json went down from 0.1.10 to 0.1.9; set it above the base' --previous HEAD^1 --all-services
write_package control-api 0.1.11
commit_all 'set the version above the base'
expect_run 'a revert with the version above the base passes' 0 'are valid' --previous "$merged" --all-services

# Pinned by behavior: a change to each shipped path of each service must fail, naming that
# service only. This table is separate from the validator's list on purpose. Every service also
# ships COMMON_SHIPPED. The check counts a service's files apart from its exclusions, so a path
# that stops counting here means an exclusion reached something an image needs. A directory is
# probed with a .ts file, so the kinds an exclusion could reach by name are listed as real files
# too: a stylesheet, images, Dockerfile variants the release builds, and build ignore files.
SERVICES='channel-reader src .dockerignore
control-api src Dockerfile.dockerignore
control-ui app components lib public next.config.js app/globals.css public/brand/logo.svg
external-rest-api src
host-context-controller src
mcp-host src 50-mcp-host-service Dockerfile.full
mcp-proxy src
mcp-servers/doc-generator src
mcp-servers/web-search src
profile-ui app lib public next.config.js public/brand/logo.png
rpc-proxy src
stdio-bridge src
workflow-recipes src Dockerfile.coordinator'
COMMON_SHIPPED='Dockerfile package-lock.json tsconfig.json'

# Roots the hook bumps that the check leaves out, each for the reason given.
#   mcp-servers: the root package of airtable, mongodb and playwright, which wrap upstream images.
#   packages/workflow-sdk: a prerelease version this check cannot order.
#   tests/**, workflow-recipes/tests/e2e: test code.
EXCLUDED_ROOTS='mcp-servers
packages/workflow-sdk
tests/e2e
tests/e2e/fixtures
tests/e2e/fixtures/mock-mcp-server
tests/e2e/fixtures/mock-secrets-server
tests/e2e/fixtures/mock-stdio-mcp-server
tests/e2e/playwright
workflow-recipes/tests/e2e'

# Every root the hook bumps is in one of the two lists, and neither names anything else.
hook_roots="$(node --input-type=module -e \
  "const { packageRoots } = await import(process.argv[1]); console.log(packageRoots.join('\\n'))" \
  "$REPO_ROOT/scripts/prettier/paths.mjs")"
listed_roots="$( { printf '%s\n' "$SERVICES" | cut -d' ' -f1; printf '%s\n' "$EXCLUDED_ROOTS"; } | LC_ALL=C sort)"
if [ -n "$hook_roots" ] && [ "$(printf '%s\n' "$hook_roots" | LC_ALL=C sort)" = "$listed_roots" ]; then
  pass
else
  fail "the hook's packageRoots differ from this test's lists; in the same change, add the root to SERVICES and the validator, or to EXCLUDED_ROOTS with a reason: $(diff <(printf '%s\n' "$hook_roots" | LC_ALL=C sort) <(printf '%s\n' "$listed_roots") || true)"
fi

while read -r root paths; do
  # The real tree has what the table says: a package with an orderable version, and each path.
  version="$(node -p 'require(process.argv[1]).version' "$REPO_ROOT/$root/package.json")"
  if printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    pass
  else
    fail "$root/package.json has version '$version', which the check cannot order"
  fi
  for path in $paths $COMMON_SHIPPED; do
    if [ -n "$(git -C "$REPO_ROOT" ls-files -- "$root/$path" | head -n 1)" ]; then
      pass
    else
      fail "$root/$path has no tracked files, so this table no longer describes the service"
    fi
  done
done <<<"$SERVICES"

shipped_file() { # <root> <path>: the path itself, or a file inside it when the real tree has a directory there
  if [ -d "$REPO_ROOT/$1/$2" ]; then printf '%s/%s/shipped.ts' "$1" "$2"; else printf '%s/%s' "$1" "$2"; fi
}

mkdir -p "$WORK/pin/scripts/release"
cd "$WORK/pin"
git_q init -q -b dev
cp "$REPO_ROOT/scripts/release/validate-release-version-bumps.mjs" scripts/release/
while read -r root paths; do
  write_package "$root" 0.1.1
  for path in $paths $COMMON_SHIPPED; do
    file="$(shipped_file "$root" "$path")"
    mkdir -p "$(dirname "$file")"
    echo one >"$file"
  done
done <<<"$SERVICES"
commit_all 'base'
while read -r root paths; do
  for path in $paths $COMMON_SHIPPED; do
    file="$(shipped_file "$root" "$path")"
    echo two >"$file"
    commit_all "change $file"
    expect_run "$file is covered" 1 \
      "$root code changed but $root/package.json stayed at 0.1.1" --previous HEAD^ --all-services
    errors="$(node scripts/release/validate-release-version-bumps.mjs --previous HEAD^ --all-services 2>&1 | grep -c '::error::' || true)"
    if [ "$errors" -eq 1 ]; then pass; else fail "$file: $errors errors, want 1"; fi
    echo one >"$file"
    commit_all "restore $file"
  done
done <<<"$SERVICES"

# The hook bumps every service that declares packages/jwt-key-policy, so the check asks for the
# same bumps. The expected list comes from the real package.json files, as the hook reads it.
jwt_consumers="$(while read -r root _; do
  node -e '
    const manifest = require(process.argv[1])
    const declared = Object.values(manifest.dependencies ?? {})
    if (declared.some(spec => /^file:(\.\.\/)+packages\/jwt-key-policy$/.test(spec))) console.log(process.argv[2])
  ' "$REPO_ROOT/$root/package.json" "$root"
done <<<"$SERVICES")"
mkdir -p packages/jwt-key-policy
echo one >packages/jwt-key-policy/index.cjs
commit_all 'the shared package'
echo two >packages/jwt-key-policy/index.cjs
commit_all 'change the shared package'
jwt_output="$(node scripts/release/validate-release-version-bumps.mjs --previous HEAD^ --all-services 2>&1 || true)"
jwt_named="$(printf '%s\n' "$jwt_output" | sed -n 's/^::error::\(.*\) code changed but .*/\1/p' | LC_ALL=C sort)"
if [ -n "$jwt_consumers" ] && [ "$jwt_named" = "$(printf '%s\n' "$jwt_consumers" | LC_ALL=C sort)" ]; then
  pass
else
  fail "packages/jwt-key-policy: the check names [$jwt_named], the services declaring it are [$jwt_consumers]"
fi

# One rule per service in both modes. The default mode checks fewer services, never other files,
# so for each service it checks, every change gets the same verdict from both modes. The services
# come from the default mode itself: a service added to it is probed here with no edit.
run_mode() { # <args...>: MODE_NAMED, the services the check names; a run it cannot read fails
  local exit_code=0 output errors named
  output="$(node scripts/release/validate-release-version-bumps.mjs --previous HEAD^ "$@" 2>&1)" || exit_code=$?
  MODE_NAMED="$(printf '%s\n' "$output" | sed -n 's/^::error::\(.*\) code changed but .*/\1/p' | LC_ALL=C sort | tr '\n' ' ')"
  errors="$(printf '%s\n' "$output" | grep -c '^::error::' || true)"
  named="$(printf '%s' "$MODE_NAMED" | wc -w)"
  if [ "$exit_code" -eq 0 ] && [ -z "$MODE_NAMED" ] && printf '%s' "$output" | grep -qF 'are valid'; then
    return 0
  elif [ "$exit_code" -eq 1 ] && [ -n "$MODE_NAMED" ] && [ "$errors" -eq $((named)) ]; then
    return 0
  fi
  MODE_NAMED="unreadable run (exit $exit_code): $output"
  return 1
}
while read -r root _; do
  mkdir -p "$root/src"
  echo derive >"$root/src/cross-mode-derive.ts"
done <<<"$SERVICES"
commit_all 'a file in every service'
default_services=''
if run_mode; then default_services="$MODE_NAMED"; fi
if [ "$default_services" = 'external-rest-api rpc-proxy ' ]; then
  pass
else
  fail "the default mode checks [$default_services], want the services releaseManifest.ts publishes"
fi
in_default() { # <services...>: those the default mode checks, in order
  local service
  for service in "$@"; do
    case " $default_services" in *" $service "*) printf '%s ' "$service" ;; esac
  done
}
# Kinds beyond the table's paths and COMMON_SHIPPED: the files each mode used to treat apart.
CROSS_MODE_KINDS='src/cross.ts src/test/helper.ts Dockerfile.dockerignore
tsconfig.jwt-contract-tests.json scripts/tool.mjs test/t.ts tests/t.ts e2e/t.ts
src/x.test.ts src/x.spec.tsx src/__tests__/x.ts src/x.testFixtures.ts README.md src/notes.md
Makefile makefile vitest.config.ts .env.example'
cross_files=''
for root in $default_services; do
  table_paths="$(printf '%s\n' "$SERVICES" | awk -v root="$root" '$1 == root { $1 = ""; print }')"
  for path in $table_paths $COMMON_SHIPPED; do cross_files="$cross_files $(shipped_file "$root" "$path")"; done
  for path in $CROSS_MODE_KINDS; do cross_files="$cross_files $root/$path"; done
  cross_files="$cross_files $root/package.json"
done
cross_files="$cross_files packages/jwt-key-policy/index.cjs external-rest-api/src/releaseManifest.ts"
agreed_red=0
agreed_green=0
probe=0
for file in $cross_files; do
  probe=$((probe + 1))
  mkdir -p "$(dirname "$file")"
  case "$file" in
    */package.json) # A dependency edit at the same version.
      printf '{ "name": "%s", "version": "0.1.1", "dependencies": { "probe": "%s" } }\n' \
        "$(basename "$(dirname "$file")")" "$probe" >"$file" ;;
    *) echo "cross $probe" >"$file" ;;
  esac
  commit_all "cross-mode $file"
  if ! run_mode; then fail "$file, default mode: $MODE_NAMED"; continue; fi
  default_named="$MODE_NAMED"
  if ! run_mode --all-services; then fail "$file, --all-services: $MODE_NAMED"; continue; fi
  # shellcheck disable=SC2086 # One word per service.
  all_named="$(in_default $MODE_NAMED)"
  if [ "$default_named" != "$all_named" ]; then
    fail "$file: the default mode names [$default_named], --all-services names [$all_named] of the services both check"
  else
    pass
    if [ -n "$default_named" ]; then agreed_red=$((agreed_red + 1)); else agreed_green=$((agreed_green + 1)); fi
  fi
done
# Witness: both verdicts occurred, so the agreement above is not two runs that read nothing.
if [ "$agreed_red" -gt 0 ] && [ "$agreed_green" -gt 0 ]; then
  pass
else
  fail "cross-mode probes: $agreed_red agreed on a missing bump, $agreed_green on none; want both"
fi

# The CI steps: in the job the dev ruleset requires, with no filter that could skip them, exactly
# these commands with no key that softens them, on the merge result, and with history enough to
# read HEAD^1. Depth comes from the workflow, so the clone below proves it. The job's other steps
# are not pinned: one inserted before these can still change what they see.
# shellcheck disable=SC2016 # Ruby source.
if depth="$(RUBYOPT=--disable=gems ruby -ryaml -e '
  doc = YAML.load_file(ARGV.fetch(0))
  # YAML 1.1 reads the bare key `on` as true.
  triggers = doc.fetch(true)
  abort("pull_request has a filter: #{triggers["pull_request"]}") unless triggers.key?("pull_request") && triggers["pull_request"].nil?
  # These two reach every step from the top of the file: a shell or a BASH_ENV could soften them.
  %w[defaults env].each { |key| abort("the workflow sets #{key}: #{doc[key]}") if doc.key?(key) }
  check = "node scripts/release/validate-release-version-bumps.mjs --previous HEAD^1 --all-services"
  own_test = "bash scripts/tests/test-validate-release-version-bumps.sh"
  [check, own_test].each do |command|
    holders = doc.fetch("jobs").select { |_, job| job.fetch("steps", []).any? { |s| s["run"] == command } }.keys
    abort("`#{command}` runs in #{holders}, want only repo-hygiene") unless holders == ["repo-hygiene"]
  end
  job = doc["jobs"]["repo-hygiene"]
  # The ruleset requires this job by this exact name.
  abort("job name changed: #{job["name"]}") unless job["name"] == "Repo hygiene (no internal working artifacts)"
  # Exactly these keys: if, needs, continue-on-error or strategy could skip or soften the job.
  abort("the job has other keys: #{job.keys}") unless job.keys.sort == %w[name runs-on steps]
  steps = job.fetch("steps")
  gate = steps.index { |s| s["run"] == check }
  pin = steps.index { |s| s["run"] == own_test }
  node = steps.index { |s| s["uses"].to_s.start_with?("actions/setup-node@") }
  abort("setup-node must come before both steps") unless node && node < gate && node < pin
  wanted = "github.event_name == \x27pull_request\x27 && github.base_ref == \x27dev\x27"
  [gate, pin, node].each { |i| abort("step #{i} runs on: #{steps[i]["if"]}") unless steps[i]["if"] == wanted }
  # Exactly these keys: continue-on-error, shell, env or working-directory could soften them.
  [gate, pin].each { |i| abort("step #{i} has other keys: #{steps[i].keys}") unless steps[i].keys.sort == %w[if name run] }
  # One checkout, first, setting only the depth: a ref moves HEAD off the merge result, so HEAD^1
  # stops being the base and a collision with it goes green.
  checkouts = steps.select { |s| s["uses"].to_s.start_with?("actions/checkout@") }
  abort("want one checkout, as the first step: #{checkouts}") unless checkouts == [steps.first]
  with = steps.first.fetch("with")
  abort("the checkout sets other keys: #{with.keys}") unless with.keys == ["fetch-depth"]
  depth = with.fetch("fetch-depth")
  abort("fetch-depth #{depth}: the clone below needs a positive integer") unless depth.is_a?(Integer) && depth > 0
  puts depth
' "$REPO_ROOT/.github/workflows/ci-public.yml" 2>&1)"; then
  pass
  git_q -c advice.detachedHead=false clone -q --depth "$depth" --branch collision "file://$WORK/repo" "$WORK/shallow"
  cd "$WORK/shallow"
  expect_run "the job's fetch depth ($depth) is enough to read the merge base" 1 \
    'control-api code changed but control-api/package.json stayed at 0.1.2' --previous HEAD^1 --all-services
else
  fail "ci-public.yml: $depth"
fi

printf 'validate-release-version-bumps: %d checks, %d failed\n' "$TESTS_RUN" "$TESTS_FAILED"
[ "$TESTS_RUN" -eq 317 ] || { echo "FAIL: expected 317 checks, ran $TESTS_RUN" >&2; exit 1; }
[ "$TESTS_FAILED" -eq 0 ]
