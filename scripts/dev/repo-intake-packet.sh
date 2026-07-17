#!/usr/bin/env bash
set -euo pipefail

BASE_REF="${REPO_INTAKE_BASE_REF:-origin/dev}"
BLOCKERS=()
WARNINGS=()
TOUCHED_AREAS=()

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
section() { printf '\n== %s ==\n' "$1"; }
kv() { printf '%-30s %s\n' "$1:" "$2"; }
join() { if (( $# )); then local IFS=", "; printf '%s' "$*"; else printf 'none'; fi; }
join_touched() { if (( ${#TOUCHED_AREAS[@]} )); then join "${TOUCHED_AREAS[@]}"; else printf 'none'; fi; }
join_blockers() { if (( ${#BLOCKERS[@]} )); then join "${BLOCKERS[@]}"; else printf 'none'; fi; }
join_warnings() { if (( ${#WARNINGS[@]} )); then join "${WARNINGS[@]}"; else printf 'none'; fi; }

abs_dir() {
  [[ -d "${1:-}" ]] || return 1
  (cd "$1" && pwd -P)
}

resolve_ref() {
  git rev-parse --verify --quiet "$1^{commit}" 2>/dev/null ||
    git rev-parse --verify --quiet "refs/remotes/$1^{commit}" 2>/dev/null ||
    true
}

short_ref() { git rev-parse --short=8 "$1" 2>/dev/null || printf 'unknown'; }
ahead_behind() { git rev-list --left-right --count "$1...$2" 2>/dev/null || printf 'n/a n/a\n'; }

slugify() {
  printf '%s' "$1" |
    tr '[:upper:]' '[:lower:]' |
    sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g' |
    cut -c1-47
}

area_for_path() {
  case "$1" in
    control-api/*) printf 'control-api' ;;
    external-rest-api/*) printf 'external-rest-api' ;;
    rpc-proxy/*) printf 'rpc-proxy' ;;
    mcp-host/*) printf 'mcp-host' ;;
    host-context-controller/*) printf 'host-context-controller' ;;
    workflow-recipes/*) printf 'workflow-recipes' ;;
    packages/workflow-sdk/*) printf 'packages/workflow-sdk' ;;
    workflow-approval-request-reader/*) printf 'workflow-approval-request-reader' ;;
    control-ui/*) printf 'control-ui' ;;
    desktop-app/*) printf 'desktop-app' ;;
    profile-ui/*) printf 'profile-ui' ;;
    mcp-servers/*) printf 'mcp-servers' ;;
    tests/e2e/*) printf 'tests/e2e' ;;
    scripts/minikube/*) printf 'scripts/minikube' ;;
    scripts/e2e/*) printf 'scripts/e2e' ;;
    scripts/dev/*) printf 'scripts/dev' ;;
    scripts/tests/*) printf 'scripts/tests' ;;
    deploy/*) printf 'deploy' ;;
    charts/*) printf 'charts' ;;
    docs/*) printf 'docs' ;;
    AGENTS.md|CLAUDE.md|Makefile) printf 'repo-rules' ;;
    package.json|package-lock.json) printf 'repo-package' ;;
    *) printf '' ;;
  esac
}

add_area() {
  local area="$1" existing
  [[ -n "${area}" ]] || return 0
  if (( ${#TOUCHED_AREAS[@]} == 0 )); then
    TOUCHED_AREAS+=("${area}")
    return
  fi
  for existing in "${TOUCHED_AREAS[@]}"; do
    [[ "${existing}" == "${area}" ]] && return
  done
  TOUCHED_AREAS+=("${area}")
}

collect_touched_areas() {
  local path area
  while IFS= read -r path; do
    [[ -n "${path}" ]] || continue
    area="$(area_for_path "${path}")"
    add_area "${area}"
  done < <(
    {
      git diff --name-only HEAD 2>/dev/null || true
      git ls-files --others --exclude-standard 2>/dev/null || true
    } | sort -u
  )
}

count_status() {
  local line xy x y
  STATUS_TOTAL=0
  STATUS_STAGED=0
  STATUS_UNSTAGED=0
  STATUS_UNTRACKED=0
  STATUS_CONFLICTS=0

  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    STATUS_TOTAL=$((STATUS_TOTAL + 1))
    xy="${line:0:2}"
    if [[ "${xy}" == "??" ]]; then
      STATUS_UNTRACKED=$((STATUS_UNTRACKED + 1))
      continue
    fi

    x="${line:0:1}"
    y="${line:1:1}"
    [[ "${x}" != " " ]] && STATUS_STAGED=$((STATUS_STAGED + 1))
    [[ "${y}" != " " ]] && STATUS_UNSTAGED=$((STATUS_UNSTAGED + 1))
    case "${xy}" in
      DD|AU|UD|UA|DU|AA|UU) STATUS_CONFLICTS=$((STATUS_CONFLICTS + 1)) ;;
    esac
  done < <(git status --porcelain=v1 -uall 2>/dev/null || true)
}

resolve_primary_checkout() {
  local configured="${REPO_INTAKE_PRIMARY_CHECKOUT:-${CLERUM_PRIMARY_CHECKOUT:-}}"
  local common_dir common_abs=""

  if [[ -n "${configured}" ]]; then
    if abs_dir "${configured}" >/dev/null; then
      abs_dir "${configured}"
      return
    fi
    WARNINGS+=("configured_primary_checkout_missing")
  fi

  common_dir="$(git rev-parse --git-common-dir 2>/dev/null || true)"
  if [[ "${common_dir}" = /* ]]; then
    common_abs="${common_dir}"
  elif [[ -d "${common_dir}" ]]; then
    common_abs="$(cd "${common_dir}" && pwd -P)"
  fi

  if [[ -n "${common_abs}" && "${common_abs}" == */.git ]]; then
    printf '%s\n' "${common_abs%/.git}"
  else
    printf '%s\n' "${REPO_ROOT}"
  fi
}

profile_value() {
  awk -F= -v wanted="$2" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$1" 2>/dev/null || true
}

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "${REPO_ROOT}" ]] || die "not inside a git repository"
REPO_ROOT="$(cd "${REPO_ROOT}" && pwd -P)"
cd "${REPO_ROOT}"

BRANCH="$(git branch --show-current 2>/dev/null || true)"
DETACHED="no"
PROFILE_BRANCH="${BRANCH}"
if [[ -z "${PROFILE_BRANCH}" ]]; then
  DETACHED="yes"
  PROFILE_BRANCH="detached-$(short_ref HEAD)"
fi

HEAD_FULL="$(git rev-parse --verify HEAD 2>/dev/null || true)"
[[ -n "${HEAD_FULL}" ]] || die "unable to resolve HEAD"
HEAD_SHORT="$(short_ref HEAD)"
BRANCH_SLUG="$(slugify "${PROFILE_BRANCH}")"
[[ -n "${BRANCH_SLUG}" ]] || BRANCH_SLUG="detached-${HEAD_SHORT}"
EXPECTED_PROFILE="clerum-${BRANCH_SLUG}-${HEAD_SHORT}"

UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
[[ -n "${UPSTREAM}" ]] || UPSTREAM="none"

BASE_COMMIT="$(resolve_ref "${BASE_REF}")"
BASE_PRESENT="no"
BASE_SHORT="missing"
BASE_AHEAD="n/a"
BASE_BEHIND="n/a"
BASE_STATUS="missing"
if [[ -n "${BASE_COMMIT}" ]]; then
  BASE_PRESENT="yes"
  BASE_SHORT="$(short_ref "${BASE_COMMIT}")"
  read -r BASE_AHEAD BASE_BEHIND <<<"$(ahead_behind HEAD "${BASE_COMMIT}")"
  if [[ "${BASE_BEHIND}" != "n/a" && "${BASE_BEHIND}" -gt 0 ]]; then
    BASE_STATUS="stale_missing_${BASE_BEHIND}_base_commits"
    BLOCKERS+=("branch_missing_${BASE_REF}_commits")
  elif [[ "${BASE_AHEAD}" != "n/a" && "${BASE_AHEAD}" -gt 0 ]]; then
    BASE_STATUS="contains_base_with_${BASE_AHEAD}_local_commits"
  else
    BASE_STATUS="at_base"
  fi
else
  BLOCKERS+=("missing_${BASE_REF}")
fi

UPSTREAM_AHEAD="n/a"
UPSTREAM_BEHIND="n/a"
if [[ "${UPSTREAM}" != "none" ]]; then
  read -r UPSTREAM_AHEAD UPSTREAM_BEHIND <<<"$(ahead_behind HEAD "${UPSTREAM}")"
fi

count_status
if (( STATUS_CONFLICTS > 0 )); then
  BLOCKERS+=("unresolved_conflicts")
elif (( STATUS_TOTAL > 0 )); then
  WARNINGS+=("dirty_worktree_review_required")
fi
collect_touched_areas

WORKTREE_PORCELAIN="$(git worktree list --porcelain --expire now 2>/dev/null || true)"
WORKTREE_COUNT="$(printf '%s\n' "${WORKTREE_PORCELAIN}" | grep -c '^worktree ' || true)"
PRUNABLE_COUNT="$(printf '%s\n' "${WORKTREE_PORCELAIN}" | grep -c '^prunable' || true)"

PRIMARY_CHECKOUT="$(resolve_primary_checkout)"
LOCAL_PROFILE_HELPER="${REPO_ROOT}/.local-notes/minikube-profiles/branch.mk"
PRIMARY_PROFILE_HELPER="${PRIMARY_CHECKOUT}/.local-notes/minikube-profiles/branch.mk"
LOCAL_HELPER_EXISTS="no"
PRIMARY_HELPER_EXISTS="no"
PROFILE_HELPER_EXISTS="no"
PROFILE_HELPER_COMMAND="unavailable"

[[ -f "${LOCAL_PROFILE_HELPER}" ]] && LOCAL_HELPER_EXISTS="yes"
if [[ -f "${PRIMARY_PROFILE_HELPER}" ]]; then
  PRIMARY_HELPER_EXISTS="yes"
  PROFILE_HELPER_EXISTS="yes"
  PROFILE_HELPER_COMMAND="make -f ${PRIMARY_PROFILE_HELPER} branch-profile-info"
elif [[ "${LOCAL_HELPER_EXISTS}" == "yes" ]]; then
  PROFILE_HELPER_EXISTS="yes"
  PROFILE_HELPER_COMMAND="make -f ${LOCAL_PROFILE_HELPER} branch-profile-info"
else
  BLOCKERS+=("missing_branch_profile_helper")
fi

PROFILE_ENV="${HOME}/.cache/clerum/minikube-profiles/${EXPECTED_PROFILE}/profile.env"
PROFILE_CACHE_STATE="absent"
PROFILE_CACHE_REPO_MATCH="n/a"
PROFILE_CACHE_SHA_MATCH="n/a"
if [[ -f "${PROFILE_ENV}" ]]; then
  PROFILE_CACHE_STATE="present"
  PROFILE_CACHE_REPO="$(profile_value "${PROFILE_ENV}" REPO_DIR)"
  PROFILE_CACHE_SHA="$(profile_value "${PROFILE_ENV}" SHA_SHORT)"

  if [[ -n "${PROFILE_CACHE_REPO}" ]]; then
    if [[ "${PROFILE_CACHE_REPO}" == "${REPO_ROOT}" ]]; then
      PROFILE_CACHE_REPO_MATCH="yes"
    else
      PROFILE_CACHE_REPO_MATCH="no"
      BLOCKERS+=("profile_cache_belongs_to_other_worktree")
    fi
  fi

  if [[ -n "${PROFILE_CACHE_SHA}" ]]; then
    if [[ "${PROFILE_CACHE_SHA}" == "${HEAD_SHORT}" ]]; then
      PROFILE_CACHE_SHA_MATCH="yes"
    else
      PROFILE_CACHE_SHA_MATCH="no"
      BLOCKERS+=("profile_cache_sha_mismatch")
    fi
  fi
else
  WARNINGS+=("profile_cache_not_initialized")
fi

[[ "${DETACHED}" == "yes" ]] && WARNINGS+=("detached_worktree_confirm_scope")
if [[ "${PROFILE_HELPER_EXISTS}" == "yes" && "${PROFILE_CACHE_STATE}" == "absent" ]]; then
  WARNINGS+=("run_branch_profile_helper_before_t2")
fi

READINESS="ready"
if (( ${#BLOCKERS[@]} > 0 )); then
  READINESS="blocked"
elif (( ${#WARNINGS[@]} > 0 )); then
  READINESS="caution"
fi

section "Repo"
for row in \
  "repo_root|${REPO_ROOT}" \
  "primary_checkout|${PRIMARY_CHECKOUT}" \
  "branch|${BRANCH:-detached}" \
  "detached|${DETACHED}" \
  "head|${HEAD_SHORT}" \
  "upstream|${UPSTREAM}" \
  "upstream_ahead_behind|${UPSTREAM_AHEAD}/${UPSTREAM_BEHIND}" \
  "expected_base|${BASE_REF}" \
  "base_present|${BASE_PRESENT}" \
  "base_head|${BASE_SHORT}" \
  "base_ahead_behind|${BASE_AHEAD}/${BASE_BEHIND}" \
  "base_status|${BASE_STATUS}"; do
  kv "${row%%|*}" "${row#*|}"
done

section "Working Tree"
kv "dirty_summary" "total=${STATUS_TOTAL} staged=${STATUS_STAGED} unstaged=${STATUS_UNSTAGED} untracked=${STATUS_UNTRACKED} conflicts=${STATUS_CONFLICTS}"
kv "touched_areas" "$(join_touched)"
kv "worktree_count" "${WORKTREE_COUNT}"
kv "prunable_count" "${PRUNABLE_COUNT}"

section "Branch Profile"
for row in \
  "profile_helper_local|${LOCAL_HELPER_EXISTS}" \
  "profile_helper_primary|${PRIMARY_HELPER_EXISTS}" \
  "profile_helper_exists|${PROFILE_HELPER_EXISTS}" \
  "profile_helper_command|${PROFILE_HELPER_COMMAND}" \
  "expected_profile|${EXPECTED_PROFILE}" \
  "profile_cache_state|${PROFILE_CACHE_STATE}" \
  "profile_cache_repo_match|${PROFILE_CACHE_REPO_MATCH}" \
  "profile_cache_sha_match|${PROFILE_CACHE_SHA_MATCH}"; do
  kv "${row%%|*}" "${row#*|}"
done

section "Validation Tiers"
kv "T0_intake" "complete: repo packet generated"
if (( ${#TOUCHED_AREAS[@]} > 0 )); then
  kv "T1_focus" "run focused checks for: $(join_touched)"
else
  kv "T1_focus" "choose package-scoped checks after edits"
fi
if [[ "${READINESS}" == "blocked" ]]; then
  kv "T2_local_runtime" "blocked until blockers are resolved"
else
  kv "T2_local_runtime" "allowed only after T1 passes and profile ownership is confirmed"
fi
kv "T3_live_dev_prod" "requires explicit user authorization and target context"

section "Gate Decision"
kv "t2_readiness" "${READINESS}"
kv "blockers" "$(join_blockers)"
kv "warnings" "$(join_warnings)"
kv "profile_ports_command" "${PROFILE_HELPER_COMMAND}"
kv "trust_boundary_check" "required before accepting E2E evidence"

[[ "${READINESS}" == "blocked" ]] && exit 2
exit 0
