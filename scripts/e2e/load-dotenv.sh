#!/usr/bin/env bash
# Literal dotenv loader shared by the E2E wrappers.
#
# This file is executable shell code; the dotenv files passed to it are data.
# Values already present in the process keep precedence, including an explicit
# empty value. No dotenv line is ever sourced, eval'd, or command-substituted.

dotenv_load_file() {
  local env_file="${1:?dotenv file path is required}"
  [[ -f "${env_file}" ]] || return 0

  local raw_line line key value quote line_number=0
  while IFS= read -r raw_line || [[ -n "${raw_line}" ]]; do
    line_number=$((line_number + 1))
    line="${raw_line#"${raw_line%%[![:space:]]*}"}"
    case "${line}" in
      ''|'#'*) continue ;;
    esac
    if [[ "${line}" == export[[:space:]]* ]]; then
      line="${line#export}"
      line="${line#"${line%%[![:space:]]*}"}"
    fi
    if [[ "${line}" != *=* ]]; then
      printf 'Invalid dotenv line %s in %s (expected KEY=value)\n' "${line_number}" "${env_file}" >&2
      return 1
    fi
    key="${line%%=*}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    if [[ ! "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      printf 'Invalid dotenv key on line %s in %s\n' "${line_number}" "${env_file}" >&2
      return 1
    fi
    # Presence, rather than truthiness, preserves an explicit process value.
    if [[ "${!key+x}" == x ]]; then continue; fi
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "${value}" == \"*\" || "${value}" == \'*\' ]]; then
      quote="${value:0:1}"
      if [[ "${value: -1}" != "${quote}" ]]; then
        printf 'Unterminated dotenv quote on line %s in %s\n' "${line_number}" "${env_file}" >&2
        return 1
      fi
      value="${value:1:${#value}-2}"
    fi
    printf -v "${key}" '%s' "${value}"
    export "${key}"
  done < "${env_file}"
}

dotenv_canonical_root() {
  local repo_root="${1:?repository root is required}"
  local common_dir main_repo_dir
  if [[ -f "${repo_root}/.env" ]]; then
    printf '%s\n' "${repo_root}/.env"
    return 0
  fi
  common_dir="$(git -C "${repo_root}" rev-parse --git-common-dir 2>/dev/null || true)"
  if [[ -z "${common_dir}" ]]; then return 0; fi
  case "${common_dir}" in
    /*) main_repo_dir="$(cd "${common_dir}/.." && pwd)" ;;
    *) main_repo_dir="$(cd "${repo_root}/${common_dir}/.." && pwd)" ;;
  esac
  [[ -f "${main_repo_dir}/.env" ]] && printf '%s\n' "${main_repo_dir}/.env"
}

dotenv_load_canonical_root() {
  local repo_root="${1:?repository root is required}" env_file
  env_file="$(dotenv_canonical_root "${repo_root}")"
  [[ -n "${env_file}" ]] && dotenv_load_file "${env_file}"
}
