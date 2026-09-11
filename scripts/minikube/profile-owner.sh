#!/usr/bin/env bash
# Read-only resolver for branch-owned Minikube profile metadata.
#
# This file never creates, renames, adopts, or rewrites a profile. The ignored
# branch-profile helper owns those mutations. This public boundary only derives
# stable owner identity and validates/selects persisted metadata fail-closed.

PROFILE_OWNER_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=t2-worktree-id.sh
. "${PROFILE_OWNER_SCRIPT_DIR}/t2-worktree-id.sh"

PROFILE_OWNER_ERROR_CODE=""
PROFILE_OWNER_ERROR_MESSAGE=""

profile_owner_error() {
  PROFILE_OWNER_ERROR_CODE="$1"
  PROFILE_OWNER_ERROR_MESSAGE="$2"
  return 1
}

profile_owner_print_error() {
  printf '%s: %s\n' "${PROFILE_OWNER_ERROR_CODE:-PROFILE_OWNER_ERROR}" \
    "${PROFILE_OWNER_ERROR_MESSAGE:-profile ownership validation failed}" >&2
}

profile_owner_canonical_path() {
  local canonical_path
  canonical_path="$(t2_canonical_worktree_path "${1:-}")" || return 1
  [[ "${canonical_path}" != *$'\n'* && "${canonical_path}" != *$'\r'* && "${canonical_path}" != *$'\t'* ]] || return 1
  printf '%s\n' "${canonical_path}"
}

profile_owner_slugify() {
  printf '%s' "$1" |
    LC_ALL=C tr '[:upper:]' '[:lower:]' |
    LC_ALL=C sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g' |
    LC_ALL=C cut -c1-47
}

profile_owner_stable_profile() {
  local repo_dir="${1:-}" branch="${2:-}" owner_id branch_slug
  owner_id="$(t2_profile_owner_id "${repo_dir}" "${branch}")" || return 1
  branch_slug="$(profile_owner_slugify "${branch}")"
  [[ -n "${branch_slug}" ]] || branch_slug=branch
  printf 'clerum-%s-%s\n' "${branch_slug}" "${owner_id:0:8}"
}

profile_owner_value() {
  local file="$1" key="$2"
  awk -F= -v wanted="${key}" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' \
    "${file}" 2>/dev/null || true
}

profile_owner_validate_record_syntax() {
  local file="${1:-}" label="${2:-metadata}"
  if [[ ! -f "${file}" || ! -r "${file}" || -L "${file}" ]]; then
    profile_owner_error PROFILE_METADATA_MISSING "${label} is missing, unreadable, or a symlink: ${file}"
    return 1
  fi

  local validation_error
  validation_error="$(awk '
    /^$/ { next }
    {
      if ($0 !~ /^[A-Z][A-Z0-9_]*=/) {
        printf "line %d is not KEY=value", NR
        exit 1
      }
      key = $0
      sub(/=.*/, "", key)
      if (seen[key]++) {
        printf "duplicate key %s", key
        exit 1
      }
      value = substr($0, index($0, "=") + 1)
      if (value ~ /[\r\t]/) {
        printf "key %s contains a control character", key
        exit 1
      }
    }
  ' "${file}" 2>&1)" || {
    profile_owner_error PROFILE_METADATA_INVALID "${label} is malformed (${validation_error}): ${file}"
    return 1
  }
}

profile_owner_validate_branch() {
  local branch="${1:-}"
  if [[ -z "${branch}" || "${branch}" == *$'\n'* || "${branch}" == *$'\r'* || "${branch}" == *$'\t'* ]]; then
    profile_owner_error PROFILE_OWNERSHIP_MISMATCH 'branch is empty or malformed'
    return 1
  fi
}

profile_owner_validate_profile_name() {
  local profile="${1:-}" normalized_profile
  if [[ ${#profile} -gt 63 || ! "${profile}" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
    profile_owner_error PROFILE_METADATA_INVALID 'profile name is not a safe local Minikube identifier'
    return 1
  fi
  normalized_profile="$(printf '%s' "${profile}" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
  case "${normalized_profile}" in
    *gke*|*prod*|*staging*|clerum-test|default|minikube)
      profile_owner_error PROFILE_METADATA_INVALID "profile is shared or protected: ${profile}"
      return 1 ;;
  esac
}

profile_owner_validate_ports() {
  local ports_env="${1:-}"
  local require_complete="${2:-false}"
  if [[ ! -f "${ports_env}" || ! -r "${ports_env}" || -L "${ports_env}" ]]; then
    profile_owner_error PROFILE_PORTS_MISSING "persisted ports are missing, unreadable, or a symlink: ${ports_env}"
    return 1
  fi
  if ! profile_owner_validate_record_syntax "${ports_env}" 'ports.env'; then
    PROFILE_OWNER_ERROR_CODE=PROFILE_PORTS_INVALID
    return 1
  fi

  local validation_error
  validation_error="$(awk -F= -v require_complete="${require_complete}" '
    function fail(message) { print message; exit 1 }
    {
      key = $1
      value = substr($0, index($0, "=") + 1)
      values[key] = value
    }
    END {
      if (!("PORT_BASE" in values) || values["PORT_BASE"] !~ /^[0-9]+$/)
        fail("PORT_BASE is missing or non-numeric")
      if (values["PORT_BASE"] < 20000 || values["PORT_BASE"] > 38999)
        fail("PORT_BASE is outside the branch-profile allocation range")

      if (require_complete == "true") {
        port_specs = "CONTROL_UI_PORT:0 PROFILE_UI_PORT:1 MCP_HOST_PORT:80 REGISTRY_API_PORT:85 CONTROL_API_PORT:90 EXTERNAL_REST_API_PORT:91 MEMBER_REGISTRATION_SERVICE_PORT:92 RPC_PROXY_PORT:94 WORKFLOW_APPROVAL_READER_PORT:98"
        port_count = split(port_specs, ports, " ")
        for (port_index = 1; port_index <= port_count; port_index++) {
          split(ports[port_index], spec, ":")
          key = spec[1]
          if (!(key in values))
            fail(key " is required for schema-v2 branch-profile ports")
          expected_port = values["PORT_BASE"] + spec[2]
          if (values[key] != expected_port)
            fail(key " does not match PORT_BASE + " spec[2])
        }

        url_specs = "CONTROL_UI_URL:CONTROL_UI_PORT PROFILE_UI_URL:PROFILE_UI_PORT PROFILE_UI_BASE_URL:PROFILE_UI_PORT CONTROL_API_URL:CONTROL_API_PORT EXTERNAL_REST_API_URL:EXTERNAL_REST_API_PORT MEMBER_REGISTRATION_SERVICE_URL:MEMBER_REGISTRATION_SERVICE_PORT RPC_PROXY_URL:RPC_PROXY_PORT REGISTRY_API_URL:REGISTRY_API_PORT WORKFLOW_APPROVAL_READER_URL:WORKFLOW_APPROVAL_READER_PORT MCP_HOST_URL:MCP_HOST_PORT"
        url_count = split(url_specs, urls, " ")
        for (url_index = 1; url_index <= url_count; url_index++) {
          split(urls[url_index], spec, ":")
          key = spec[1]
          port_key = spec[2]
          expected_url = "http://127.0.0.1:" values[port_key]
          if (!(key in values))
            fail(key " is required for schema-v2 branch-profile ports")
          if (values[key] != expected_url && values[key] != expected_url "/")
            fail(key " does not match " port_key " and the loopback host")
        }

        allowed["PORT_BASE"] = 1
        for (port_index = 1; port_index <= port_count; port_index++) {
          split(ports[port_index], spec, ":")
          allowed[spec[1]] = 1
        }
        for (url_index = 1; url_index <= url_count; url_index++) {
          split(urls[url_index], spec, ":")
          allowed[spec[1]] = 1
        }
        for (key in values) {
          if (!(key in allowed))
            fail(key " is not allowed in schema-v2 branch-profile ports")
        }
      }

      for (key in values) {
        value = values[key]
        if (key ~ /_PORT$/) {
          if (value !~ /^[0-9]+$/ || value < 1024 || value > 65535)
            fail(key " is not a valid local port")
          if (port_owner[value] != "" && port_owner[value] != key)
            fail(key " duplicates " port_owner[value])
          port_owner[value] = key
        }
        if (key ~ /(_URL|_BASE_URL)$/) {
          if (value !~ /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):[0-9]+\/?$/)
            fail(key " is not a loopback HTTP URL")
          url_port = value
          sub(/^.*:/, "", url_port)
          sub(/\/$/, "", url_port)
          if (url_port < 1024 || url_port > 65535)
            fail(key " uses an invalid local port")
          port_key = key
          sub(/_BASE_URL$/, "_PORT", port_key)
          sub(/_URL$/, "_PORT", port_key)
          if (!(port_key in values))
            fail(key " has no matching " port_key)
          if (values[port_key] != url_port)
            fail(key " does not match " port_key)
        }
      }
    }
  ' "${ports_env}" 2>&1)" || {
    profile_owner_error PROFILE_PORTS_INVALID "persisted ports are invalid (${validation_error}): ${ports_env}"
    return 1
  }
}

profile_owner_validate_selection() {
  local profile_env="${1:-}" ports_env="${2:-}" expected_repo="${3:-}"
  local expected_branch="${4:-}" expected_profile="${5:-}"
  local canonical_repo metadata_repo metadata_canonical schema profile branch
  local worktree_id owner_id created_head sha_short dirty actual_worktree actual_owner

  canonical_repo="$(profile_owner_canonical_path "${expected_repo}")" || {
    profile_owner_error PROFILE_OWNERSHIP_MISMATCH "expected worktree is missing: ${expected_repo}"
    return 1
  }
  profile_owner_validate_branch "${expected_branch}" || return 1
  profile_owner_validate_record_syntax "${profile_env}" 'profile.env' || return 1

  schema="$(profile_owner_value "${profile_env}" PROFILE_SCHEMA_VERSION)"
  [[ -n "${schema}" ]] || schema=1
  profile="$(profile_owner_value "${profile_env}" PROFILE)"
  metadata_repo="$(profile_owner_value "${profile_env}" REPO_DIR)"
  branch="$(profile_owner_value "${profile_env}" BRANCH)"
  dirty="$(profile_owner_value "${profile_env}" DIRTY)"

  [[ "${schema}" == 1 || "${schema}" == 2 ]] || {
    profile_owner_error PROFILE_METADATA_INVALID "unsupported PROFILE_SCHEMA_VERSION=${schema}"
    return 1
  }
  [[ -n "${profile}" && -n "${metadata_repo}" && -n "${branch}" ]] || {
    profile_owner_error PROFILE_METADATA_INVALID 'profile metadata omits PROFILE, REPO_DIR, or BRANCH'
    return 1
  }
  profile_owner_validate_profile_name "${profile}" || return 1
  if [[ -n "${expected_profile}" && "${profile}" != "${expected_profile}" ]]; then
    profile_owner_error PROFILE_OWNERSHIP_MISMATCH 'profile metadata names a different profile'
    return 1
  fi
  metadata_canonical="$(profile_owner_canonical_path "${metadata_repo}")" || {
    profile_owner_error PROFILE_OWNERSHIP_MISMATCH "profile worktree is missing: ${metadata_repo}"
    return 1
  }
  [[ "${metadata_canonical}" == "${canonical_repo}" ]] || {
    profile_owner_error PROFILE_OWNERSHIP_MISMATCH 'profile metadata belongs to another worktree'
    return 1
  }
  [[ "${branch}" == "${expected_branch}" ]] || {
    profile_owner_error PROFILE_OWNERSHIP_MISMATCH 'profile metadata belongs to another branch'
    return 1
  }
  [[ -z "${dirty}" || "${dirty}" == false ]] || {
    profile_owner_error PROFILE_METADATA_INVALID 'profile metadata records a dirty worktree'
    return 1
  }

  actual_worktree="$(t2_worktree_id "${canonical_repo}")" || {
    profile_owner_error PROFILE_OWNERSHIP_MISMATCH 'unable to derive worktree identity'
    return 1
  }
  actual_owner="$(t2_profile_owner_id "${canonical_repo}" "${branch}")" || {
    profile_owner_error PROFILE_OWNERSHIP_MISMATCH 'unable to derive profile owner identity'
    return 1
  }

  if [[ "${schema}" == 1 ]]; then
    sha_short="$(profile_owner_value "${profile_env}" SHA_SHORT)"
    [[ "${sha_short}" =~ ^[0-9a-fA-F]{7,40}$ ]] || {
      profile_owner_error PROFILE_METADATA_INVALID 'schema-v1 metadata requires a hexadecimal SHA_SHORT'
      return 1
    }
    [[ "${dirty}" == false ]] || {
      profile_owner_error PROFILE_METADATA_INVALID 'schema-v1 metadata requires DIRTY=false'
      return 1
    }
    worktree_id="${actual_worktree}"
    owner_id="${actual_owner}"
    created_head="$(printf '%s' "${sha_short}" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
  else
    worktree_id="$(profile_owner_value "${profile_env}" WORKTREE_ID)"
    owner_id="$(profile_owner_value "${profile_env}" OWNER_ID)"
    created_head="$(profile_owner_value "${profile_env}" CREATED_HEAD)"
    [[ "${worktree_id}" =~ ^[0-9a-f]{40}$ && "${owner_id}" =~ ^[0-9a-f]{40}$ ]] || {
      profile_owner_error PROFILE_METADATA_INVALID 'schema-v2 metadata requires full lowercase WORKTREE_ID and OWNER_ID'
      return 1
    }
    [[ "${created_head}" =~ ^[0-9a-f]{40}$ ]] || {
      profile_owner_error PROFILE_METADATA_INVALID 'schema-v2 metadata requires a full lowercase CREATED_HEAD'
      return 1
    }
    [[ "${worktree_id}" == "${actual_worktree}" && "${owner_id}" == "${actual_owner}" ]] || {
      profile_owner_error PROFILE_OWNERSHIP_MISMATCH 'schema-v2 owner identity does not match the current worktree and branch'
      return 1
    }
    sha_short="$(profile_owner_value "${profile_env}" SHA_SHORT)"
    if [[ -n "${sha_short}" && "${created_head}" != "${sha_short}"* ]]; then
      profile_owner_error PROFILE_METADATA_INVALID 'legacy SHA_SHORT does not prefix CREATED_HEAD'
      return 1
    fi
  fi

  if [[ "${schema}" == 2 ]]; then
    profile_owner_validate_ports "${ports_env}" true || return 1
  else
    profile_owner_validate_ports "${ports_env}" false || return 1
  fi

  PROFILE_OWNER_SCHEMA_VERSION="${schema}"
  PROFILE_OWNER_WORKTREE_ID="${worktree_id}"
  PROFILE_OWNER_ID="${owner_id}"
  PROFILE_OWNER_CREATED_HEAD="${created_head}"
  PROFILE_OWNER_PROFILE="${profile}"
  PROFILE_OWNER_REPO_DIR="${canonical_repo}"
  PROFILE_OWNER_BRANCH="${branch}"
  PROFILE_OWNER_PROFILE_ENV="${profile_env}"
  PROFILE_OWNER_PORTS_ENV="${ports_env}"
}

profile_owner_print_selection() {
  printf 'PROFILE_SCHEMA_VERSION=%s\n' "${PROFILE_OWNER_SCHEMA_VERSION}"
  printf 'WORKTREE_ID=%s\n' "${PROFILE_OWNER_WORKTREE_ID}"
  printf 'OWNER_ID=%s\n' "${PROFILE_OWNER_ID}"
  printf 'CREATED_HEAD=%s\n' "${PROFILE_OWNER_CREATED_HEAD}"
  printf 'PROFILE=%s\n' "${PROFILE_OWNER_PROFILE}"
  printf 'REPO_DIR=%s\n' "${PROFILE_OWNER_REPO_DIR}"
  printf 'BRANCH=%s\n' "${PROFILE_OWNER_BRANCH}"
  printf 'PROFILE_ENV=%s\n' "${PROFILE_OWNER_PROFILE_ENV}"
  printf 'PORTS_ENV=%s\n' "${PROFILE_OWNER_PORTS_ENV}"
}

profile_owner_candidate_targets() {
  local profile_env="$1" expected_repo="$2" expected_branch="$3"
  local candidate_repo candidate_branch candidate_canonical
  candidate_repo="$(profile_owner_value "${profile_env}" REPO_DIR)"
  candidate_branch="$(profile_owner_value "${profile_env}" BRANCH)"
  [[ -n "${candidate_repo}" && "${candidate_branch}" == "${expected_branch}" ]] || return 1
  candidate_canonical="$(profile_owner_canonical_path "${candidate_repo}")" || return 1
  [[ "${candidate_canonical}" == "${expected_repo}" ]]
}

profile_owner_resolve() {
  local repo_dir="$1" branch="$2" profile_root="$3" explicit_profile="${4:-}"
  local explicit_profile_env="${5:-}" explicit_ports_env="${6:-}"
  local canonical_repo profile_env ports_env candidate
  local stable_profile stable_profile_dir
  local -a matches=()

  canonical_repo="$(profile_owner_canonical_path "${repo_dir}")" || {
    profile_owner_error PROFILE_OWNERSHIP_MISMATCH "worktree is missing: ${repo_dir}"
    return 1
  }
  profile_owner_validate_branch "${branch}" || return 1

  if [[ -n "${explicit_ports_env}" && -z "${explicit_profile_env}" && -z "${explicit_profile}" ]]; then
    explicit_profile_env="$(dirname -- "${explicit_ports_env}")/profile.env"
  fi
  if [[ -n "${explicit_profile_env}" || -n "${explicit_profile}" ]]; then
    if [[ -z "${explicit_profile_env}" ]]; then
      profile_env="${profile_root}/${explicit_profile}/profile.env"
    else
      profile_env="${explicit_profile_env}"
    fi
    if [[ -z "${explicit_ports_env}" ]]; then
      ports_env="$(dirname -- "${profile_env}")/ports.env"
    else
      ports_env="${explicit_ports_env}"
    fi
    profile_owner_validate_selection "${profile_env}" "${ports_env}" \
      "${canonical_repo}" "${branch}" "${explicit_profile}" || return 1
    profile_owner_print_selection
    return 0
  fi

  [[ -d "${profile_root}" ]] || {
    profile_owner_error PROFILE_NOT_FOUND "profile root is not initialized: ${profile_root}"
    return 3
  }
  profile_root="$(profile_owner_canonical_path "${profile_root}")" || {
    profile_owner_error PROFILE_METADATA_INVALID 'profile root cannot be canonicalized safely'
    return 1
  }
  if ! find "${profile_root}" -mindepth 2 -maxdepth 2 -type f -name profile.env -print >/dev/null 2>&1; then
    profile_owner_error PROFILE_METADATA_INVALID "profile root cannot be inspected completely: ${profile_root}"
    return 1
  fi

  stable_profile="$(profile_owner_stable_profile "${canonical_repo}" "${branch}")" || {
    profile_owner_error PROFILE_OWNERSHIP_MISMATCH 'unable to derive the stable profile identity'
    return 1
  }
  stable_profile_dir="${profile_root}/${stable_profile}"
  if [[ -d "${stable_profile_dir}" && ! -f "${stable_profile_dir}/profile.env" ]]; then
    profile_owner_error PROFILE_METADATA_MISSING \
      "stable profile directory exists without profile.env: ${stable_profile_dir}"
    return 1
  fi

  while IFS= read -r -d '' candidate; do
    if profile_owner_candidate_targets "${candidate}" "${canonical_repo}" "${branch}"; then
      matches+=("${candidate}")
    fi
  done < <(find "${profile_root}" -mindepth 2 -maxdepth 2 -type f -name profile.env -print0 2>/dev/null)

  if (( ${#matches[@]} == 0 )); then
    profile_owner_error PROFILE_NOT_FOUND 'no persisted profile matches this worktree and branch'
    return 3
  fi
  if (( ${#matches[@]} > 1 )); then
    profile_owner_error PROFILE_SELECTION_AMBIGUOUS \
      "multiple persisted profiles match this worktree and branch (${#matches[@]})"
    return 4
  fi

  profile_env="${matches[0]}"
  ports_env="$(dirname -- "${profile_env}")/ports.env"
  profile_owner_validate_selection "${profile_env}" "${ports_env}" \
    "${canonical_repo}" "${branch}" '' || return 1
  profile_owner_print_selection
}

profile_owner_usage() {
  cat >&2 <<'EOF_USAGE'
usage:
  profile-owner.sh identity --repo-dir DIR --branch BRANCH [--created-head SHA]
  profile-owner.sh validate --repo-dir DIR --branch BRANCH --profile-env FILE --ports-env FILE [--profile NAME]
  profile-owner.sh resolve --repo-dir DIR --branch BRANCH --profile-root DIR [--profile NAME] [--profile-env FILE] [--ports-env FILE]
EOF_USAGE
}

profile_owner_main() {
  local action="${1:-}" repo_dir='' branch='' created_head=''
  local profile_root='' profile='' profile_env='' ports_env=''
  [[ -n "${action}" ]] || { profile_owner_usage; return 2; }
  shift
  while (( $# > 0 )); do
    case "$1" in
      --repo-dir|--branch|--created-head|--profile-root|--profile|--profile-env|--ports-env)
        (( $# >= 2 )) || { profile_owner_usage; return 2; }
        case "$1" in
          --repo-dir) repo_dir="$2" ;;
          --branch) branch="$2" ;;
          --created-head) created_head="$2" ;;
          --profile-root) profile_root="$2" ;;
          --profile) profile="$2" ;;
          --profile-env) profile_env="$2" ;;
          --ports-env) ports_env="$2" ;;
        esac
        shift 2 ;;
      *) profile_owner_usage; return 2 ;;
    esac
  done

  [[ -n "${repo_dir}" && -n "${branch}" ]] || { profile_owner_usage; return 2; }
  case "${action}" in
    identity)
      local canonical_repo worktree_id owner_id stable_profile
      canonical_repo="$(profile_owner_canonical_path "${repo_dir}")" || {
        profile_owner_error PROFILE_OWNERSHIP_MISMATCH "worktree is missing: ${repo_dir}"
        profile_owner_print_error
        return 1
      }
      if ! profile_owner_validate_branch "${branch}"; then
        profile_owner_print_error
        return 1
      fi
      worktree_id="$(t2_worktree_id "${canonical_repo}")"
      owner_id="$(t2_profile_owner_id "${canonical_repo}" "${branch}")"
      stable_profile="$(profile_owner_stable_profile "${canonical_repo}" "${branch}")"
      if [[ -n "${created_head}" && ! "${created_head}" =~ ^[0-9a-f]{40}$ ]]; then
        profile_owner_error PROFILE_METADATA_INVALID 'CREATED_HEAD must be a full lowercase Git SHA'
        profile_owner_print_error
        return 1
      fi
      printf 'PROFILE_SCHEMA_VERSION=2\nWORKTREE_ID=%s\nOWNER_ID=%s\n' "${worktree_id}" "${owner_id}"
      [[ -z "${created_head}" ]] || printf 'CREATED_HEAD=%s\n' "${created_head}"
      printf 'PROFILE=%s\nREPO_DIR=%s\nBRANCH=%s\n' "${stable_profile}" "${canonical_repo}" "${branch}"
      ;;
    validate)
      [[ -n "${profile_env}" && -n "${ports_env}" ]] || { profile_owner_usage; return 2; }
      if ! profile_owner_validate_selection "${profile_env}" "${ports_env}" \
        "${repo_dir}" "${branch}" "${profile}"; then
        profile_owner_print_error
        return 1
      fi
      profile_owner_print_selection
      ;;
    resolve)
      [[ -n "${profile_root}" || -n "${profile_env}" ]] || { profile_owner_usage; return 2; }
      local status=0
      profile_owner_resolve "${repo_dir}" "${branch}" "${profile_root}" \
        "${profile}" "${profile_env}" "${ports_env}" || status=$?
      if (( status != 0 )); then
        profile_owner_print_error
        return "${status}"
      fi
      ;;
    *) profile_owner_usage; return 2 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  profile_owner_main "$@"
fi
