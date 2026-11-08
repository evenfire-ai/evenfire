#!/usr/bin/env bash
# Canonical T0 checks beyond the structural contract suite.
set -euo pipefail
set +x

SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PROJECT_DIR="${T0_PROJECT_DIR:-$SCRIPT_ROOT}"
ORIGIN_DEV="${T0_ORIGIN_DEV:-origin/dev}"
HEAD="${T0_HEAD:-HEAD}"

shell_files=()
package_dirs=()
package_list="$(node "$SCRIPT_ROOT/scripts/ci/certification-inputs.mjs" list-affected --root "$PROJECT_DIR" --base "$ORIGIN_DEV" --head "$HEAD")"
while IFS= read -r package; do
  if [ -n "$package" ]; then package_dirs+=("$package"); fi
done <<< "$package_list"
if [ "${1:-}" = '--list-packages' ] && [ "$#" -eq 1 ]; then
  if [ -n "$package_list" ]; then printf '%s\n' "$package_list"; fi
  exit 0
fi
if [ "$#" -ne 0 ]; then
  printf 'usage: t0.sh [--list-packages]\n' >&2
  exit 2
fi
while IFS= read -r path; do
  [ -n "$path" ] || continue
  absolute_path="$PROJECT_DIR/$path"
  case "$path" in
    *.sh|*.bash)
      # Deleted scripts are part of the diff but cannot be parsed. Every
      # surviving shell script gets a syntax check even when shellcheck is not
      # installed; shellcheck is an additional lint lane, not the syntax gate.
      if [ -f "$absolute_path" ]; then
        bash -n "$absolute_path"
        shell_files+=("$absolute_path")
      fi
      ;;
  esac

done < <(git -C "$PROJECT_DIR" diff --name-only --diff-filter=ACMRTUXB "$ORIGIN_DEV...$HEAD")

if [ "${#shell_files[@]}" -gt 0 ]; then
  if command -v shellcheck >/dev/null 2>&1; then
    shellcheck --severity=error "${shell_files[@]}"
    printf 'T0_SHELLCHECK=PASS\n'
  else
    printf 'T0_SHELLCHECK=NOT_AVAILABLE\n'
  fi
else
  printf 'T0_SHELLCHECK=NOT_APPLICABLE\n'
fi

has_npm_script() {
  local package_dir="$1"
  local script_name="$2"
  node -e 'const p=require(process.argv[1]); process.exit(p.scripts && p.scripts[process.argv[2]] ? 0 : 1)' \
    "$package_dir/package.json" "$script_name"
}

# Tracked files that `next build` regenerates (#733). dev tracks the `next dev`
# form; the build below rewrites only the two distDir imports
# (next/dist/lib/typescript/writeAppTypeDeclarations.js:52-56). T0 restores
# what it generated so the tree stays byte-identical to HEAD.
generated_next_env_paths=(control-ui/next-env.d.ts profile-ui/next-env.d.ts)
generated_next_env_clean=()

# Prints the `next build` form of <path> derived from HEAD's `next dev` form.
next_env_build_form() {
  local path="$1" blob dev_imports
  blob="$(git -C "$PROJECT_DIR" rev-parse --verify --quiet "HEAD:$path")" || return 1
  dev_imports="$(git -C "$PROJECT_DIR" cat-file blob "$blob" | grep -c '^import "\./\.next/dev/types/')" || return 1
  [ "$dev_imports" = 2 ] || return 1
  git -C "$PROJECT_DIR" cat-file blob "$blob" |
    sed 's#^import "\./\.next/dev/types/#import "./.next/types/#'
}

next_env_is_build_form() {
  local path="$1" file="$PROJECT_DIR/$1"
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  [ "$(git -C "$PROJECT_DIR" diff-files --raw -- "$path" | cut -c1-14)" = ':100644 100644' ] || return 1
  next_env_build_form "$path" >/dev/null || return 1
  cmp -s <(next_env_build_form "$path") "$file"
}

record_clean_generated_next_env() {
  local path status_line
  for path in "${generated_next_env_paths[@]}"; do
    git -C "$PROJECT_DIR" cat-file -e "HEAD:$path" 2>/dev/null || continue
    if ! status_line="$(git -C "$PROJECT_DIR" status --porcelain=v1 -- "$path")"; then
      printf 'T0_GENERATED_NEXT_ENV=FAIL path=%s reason=git-status-failed\n' "$path" >&2
      return 1
    fi
    [ -n "$status_line" ] || generated_next_env_clean+=("$path")
  done
}

restore_generated_next_env() {
  local path status_line rc=0
  for path in ${generated_next_env_clean[@]+"${generated_next_env_clean[@]}"}; do
    if ! status_line="$(git -C "$PROJECT_DIR" status --porcelain=v1 -- "$path")"; then
      printf 'T0_GENERATED_NEXT_ENV=FAIL path=%s reason=git-status-failed\n' "$path" >&2
      rc=1
    elif [ -z "$status_line" ]; then
      printf 'T0_GENERATED_NEXT_ENV path=%s action=unchanged\n' "$path"
    elif [ "$status_line" = " M $path" ] && next_env_is_build_form "$path" &&
         git -C "$PROJECT_DIR" restore --source=HEAD --worktree -- "$path" &&
         git -C "$PROJECT_DIR" diff --quiet HEAD -- "$path"; then
      printf 'T0_GENERATED_NEXT_ENV path=%s action=restored\n' "$path"
    else
      printf 'T0_GENERATED_NEXT_ENV=FAIL path=%s reason=unrecognized-change (not the next build form of HEAD; see #733)\n' "$path" >&2
      rc=1
    fi
  done
  return "$rc"
}

on_t0_exit() {
  local status=$?
  trap - EXIT
  restore_generated_next_env || { [ "$status" -ne 0 ] || status=1; }
  exit "$status"
}

# The EXIT trap restores on every failure path, including SIGTERM. A SIGTERM
# delivered only to this bash (not to its process group) while `next build`
# runs leaves an orphaned build that can rewrite the file after the restore;
# the tree is then dirty and the next gate refuses it loudly
# (t2_repo_metadata). A process-group kill has no such race.
record_clean_generated_next_env
trap on_t0_exit EXIT

if [ -n "$package_list" ]; then
  for package in "${package_dirs[@]}"; do
    # Live Vitest/Playwright E2E is the T2 opt-in lane. T0 is unit/build only.
    case "$package" in
      tests/e2e|tests/e2e/*|*/tests/e2e|*/tests/e2e/*)
        printf '[minikube-t0] affected package: %s skipped (live E2E is T2)\n' "$package"
        continue
        ;;
    esac
    if has_npm_script "$PROJECT_DIR/$package" test; then
      printf '[minikube-t0] affected package: %s test\n' "$package"
      (cd "$PROJECT_DIR/$package" && npm test)
    else
      printf '[minikube-t0] affected package: %s test skipped (no test script)\n' "$package"
    fi
    if has_npm_script "$PROJECT_DIR/$package" build; then
      printf '[minikube-t0] affected package: %s build/typecheck\n' "$package"
      (cd "$PROJECT_DIR/$package" && npm run build)
    else
      printf '[minikube-t0] affected package: %s build/typecheck skipped (no build script)\n' "$package"
    fi
  done
fi

# Restore before PASS is printed, so a failed restore never follows a PASS
# line. The EXIT trap stays armed only for the failure paths above.
if ! restore_generated_next_env; then
  trap - EXIT
  exit 1
fi
trap - EXIT

printf 'T0_AFFECTED_PACKAGES=%s\n' "${package_dirs[*]:-none}"
printf 'T0_AFFECTED_CHECKS=PASS\n'
