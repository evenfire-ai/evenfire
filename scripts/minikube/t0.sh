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
  case "$path" in
    *.sh|*.bash) shell_files+=("$PROJECT_DIR/$path") ;;
  esac
  top="${path%%/*}"
  if [ "$top" != "$path" ] && [ -f "$PROJECT_DIR/$top/package.json" ] && [[ "$seen_packages" != *"|$top|"* ]]; then
    seen_packages="${seen_packages}${top}|"
    package_dirs+=("$top")
  fi
done < <(git -C "$PROJECT_DIR" diff --name-only "$ORIGIN_DEV...$HEAD")

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

for package in "${package_dirs[@]}"; do
  printf '[minikube-t0] affected package: %s test\n' "$package"
  (cd "$PROJECT_DIR/$package" && npm test)
  printf '[minikube-t0] affected package: %s build/typecheck\n' "$package"
  (cd "$PROJECT_DIR/$package" && npm run build)
done

printf 'T0_AFFECTED_PACKAGES=%s\n' "${package_dirs[*]:-none}"
printf 'T0_AFFECTED_CHECKS=PASS\n'
