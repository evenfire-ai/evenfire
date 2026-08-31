#!/usr/bin/env bash
# Canonical T0 checks beyond the structural contract suite.
set -euo pipefail
set +x

PROJECT_DIR="${T0_PROJECT_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
ORIGIN_DEV="${T0_ORIGIN_DEV:-origin/dev}"
HEAD="${T0_HEAD:-HEAD}"

shell_files=()
package_dirs=()
seen_packages="|"
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

  # Resolve the nearest package.json by walking upward from the changed file.
  # This covers nested packages such as packages/workflow-sdk instead of
  # incorrectly mapping them to packages/package.json.
  candidate="$absolute_path"
  if [ ! -d "$candidate" ]; then
    candidate="$(dirname -- "$candidate")"
  fi
  while [ "$candidate" != "$PROJECT_DIR" ] && [[ "$candidate" == "$PROJECT_DIR"/* ]]; do
    if [ -f "$candidate/package.json" ]; then
      package="${candidate#"$PROJECT_DIR/"}"
      if [[ "$seen_packages" != *"|$package|"* ]]; then
        seen_packages="${seen_packages}${package}|"
        package_dirs+=("$package")
      fi
      break
    fi
    parent="$(dirname -- "$candidate")"
    [ "$parent" != "$candidate" ] || break
    candidate="$parent"
  done
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

if [ "${#package_dirs[@]}" -gt 0 ]; then
  for package in "${package_dirs[@]}"; do
    # Live Vitest/Playwright E2E is the T2 opt-in lane. T0 is unit/build only.
    case "$package" in
      tests/e2e|tests/e2e/*)
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

printf 'T0_AFFECTED_PACKAGES=%s\n' "${package_dirs[*]:-none}"
printf 'T0_AFFECTED_CHECKS=PASS\n'
