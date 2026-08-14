#!/usr/bin/env bash
# Shared admin-credential resolution for local and E2E harnesses.
#
# Resolution is deliberately layer-first rather than variable-first:
#   1. canonical repository .env
#   2. explicit process environment
#   3. caller-supplied local fallback
#
# This prevents a stale inherited E2E_ADMIN_PASSWORD from shadowing the
# password that actually seeded the branch-owned cluster from the primary
# checkout. Values are returned to the caller only; this helper never logs or
# persists credential material.

if ! declare -F dotenv_canonical_root >/dev/null 2>&1 ||
   ! declare -F dotenv_load_file >/dev/null 2>&1; then
  printf '%s\n' 'admin-credentials.sh requires scripts/e2e/load-dotenv.sh to be sourced first' >&2
  return 1
fi

e2e_first_nonempty_admin_value() {
  local key
  for key in "$@"; do
    if [[ -n "${!key:-}" ]]; then
      printf '%s' "${!key}"
      return 0
    fi
  done
  return 1
}

e2e_admin_password_from_dotenv() {
  local env_file="${1:?dotenv file path is required}"
  (
    unset E2E_ADMIN_PASSWORD ADMIN_PASSWORD TEST_ADMIN_PASSWORD ADMIN_PASS
    dotenv_load_file "${env_file}" || exit 2
    # ADMIN_PASSWORD is the bootstrap source of truth in the canonical repo;
    # TEST/E2E aliases remain accepted for older local configurations.
    e2e_first_nonempty_admin_value \
      ADMIN_PASSWORD TEST_ADMIN_PASSWORD E2E_ADMIN_PASSWORD ADMIN_PASS
  )
}

e2e_resolve_admin_password() {
  local repo_root="${1:?repository root is required}"
  local fallback="${2:-}"
  local env_file value

  env_file="$(dotenv_canonical_root "${repo_root}")"
  if [[ -n "${env_file}" ]]; then
    if value="$(e2e_admin_password_from_dotenv "${env_file}")"; then
      printf '%s' "${value}"
      return 0
    else
      case "$?" in
        1) : ;;
        *) return 1 ;;
      esac
    fi
  fi

  # Without a canonical value, the test-specific process override is the most
  # precise caller intent, followed by the bootstrap and compatibility names.
  if value="$(e2e_first_nonempty_admin_value \
    E2E_ADMIN_PASSWORD ADMIN_PASSWORD TEST_ADMIN_PASSWORD ADMIN_PASS)"; then
    printf '%s' "${value}"
    return 0
  fi

  if [[ -n "${fallback}" ]]; then
    printf '%s' "${fallback}"
    return 0
  fi
  return 1
}

# Write credentials as two NUL-delimited fields for a stdin consumer. Keeping
# this byte-level contract in one helper prevents shell escape typos (for
# example, an octal escape followed by an identifier) from corrupting login
# input while keeping both values out of argv.
e2e_write_nul_credentials() {
  local username="${1-}" password="${2-}"
  printf '%s\0%s' "${username}" "${password}"
}
