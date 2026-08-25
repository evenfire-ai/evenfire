#!/usr/bin/env bash
# Canonical T0 checks beyond the structural contract suite.
set -euo pipefail
set +x

PROJECT_DIR="${T0_PROJECT_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
ORIGIN_DEV="${T0_ORIGIN_DEV:-origin/dev}"
HEAD="${T0_HEAD:-HEAD}"

shell_files=()
package_dirs=()
e2e_spec_files=()
e2e_typecheck_files=()
e2e_audit_changed=0
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

  case "$path" in
    tests/e2e/*|desktop-app/test/e2e-playwright/*)
      case "$path" in
        *.test.ts|*.spec.ts)
          if [ -f "$absolute_path" ]; then
            e2e_spec_files+=("$absolute_path")
          fi
          ;;
      esac
      case "$path" in
        tests/e2e/integration/*.ts)
          if [ -f "$absolute_path" ]; then
            e2e_typecheck_files+=("${path#tests/e2e/}")
          fi
          ;;
      esac
      ;;
  esac

  case "$path" in
    tools/e2e_static_audit.py|tools/test_e2e_static_audit.py)
      e2e_audit_changed=1
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

if [ "${#e2e_spec_files[@]}" -gt 0 ]; then
  python3 "$PROJECT_DIR/tools/e2e_static_audit.py" "${e2e_spec_files[@]}"
fi
if [ "$e2e_audit_changed" -eq 1 ]; then
  python3 "$PROJECT_DIR/tools/test_e2e_static_audit.py"
fi

if [ "${#package_dirs[@]}" -gt 0 ]; then
  for package in "${package_dirs[@]}"; do
    if [ "$package" = "tests/e2e" ]; then
      if [ "${#e2e_typecheck_files[@]}" -eq 0 ]; then
        printf '[minikube-t0] affected package: %s typecheck NOT_APPLICABLE (no changed integration TypeScript)\n' "$package"
      elif [ ! -x "$PROJECT_DIR/$package/node_modules/.bin/tsc" ]; then
        printf 'LOCAL_DEPENDENCY_MISSING: TypeScript is not installed for %s\n' "$package" >&2
        printf 'next: run npm ci in %s, then re-run T0\n' "$package" >&2
        exit 1
      else
        printf '[minikube-t0] affected package: %s focused typecheck (%s files)\n' \
          "$package" "${#e2e_typecheck_files[@]}"
        (
          cd "$PROJECT_DIR/$package" &&
          ./node_modules/.bin/tsc --noEmit --target ES2022 --module Node16 \
            --moduleResolution Node16 --strict --esModuleInterop --skipLibCheck \
            --types node,vitest/globals "${e2e_typecheck_files[@]}"
        )
      fi
      printf '[minikube-t0] affected package: %s runtime tests NOT_APPLICABLE (dedicated E2E lane)\n' "$package"
      continue
    fi
    if (
      cd "$PROJECT_DIR/$package" &&
      node -e "const scripts = require('./package.json').scripts ?? {}; process.exit(typeof scripts.test === 'string' && scripts.test.trim() ? 0 : 1)"
    ); then
      printf '[minikube-t0] affected package: %s test\n' "$package"
      (cd "$PROJECT_DIR/$package" && npm test)
    else
      printf '[minikube-t0] affected package: %s test NOT_APPLICABLE (no scripts.test)\n' "$package"
    fi
    if (
      cd "$PROJECT_DIR/$package" &&
      node -e "const scripts = require('./package.json').scripts ?? {}; process.exit(typeof scripts.build === 'string' && scripts.build.trim() ? 0 : 1)"
    ); then
      printf '[minikube-t0] affected package: %s build/typecheck\n' "$package"
      (cd "$PROJECT_DIR/$package" && npm run build)
    else
      printf '[minikube-t0] affected package: %s build/typecheck NOT_APPLICABLE (no scripts.build)\n' "$package"
    fi
  done
fi

printf 'T0_AFFECTED_PACKAGES=%s\n' "${package_dirs[*]:-none}"
printf 'T0_AFFECTED_CHECKS=PASS\n'
