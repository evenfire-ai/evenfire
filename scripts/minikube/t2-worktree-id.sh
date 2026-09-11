#!/usr/bin/env bash
# Shared deterministic worktree identity for the local T2 mutation contract.

t2_canonical_worktree_path() {
  [[ -n "${1:-}" && -d "$1" ]] || return 1
  (cd -- "$1" && pwd -P)
}

t2_worktree_id() {
  local canonical_path
  canonical_path="$(t2_canonical_worktree_path "${1:-}")" || return 1
  printf '%s' "${canonical_path}" | shasum | awk '{print $1}'
}

# Profile ownership is deliberately branch-scoped and HEAD-independent. The
# NUL separator prevents ambiguous path/branch concatenations while preserving
# the historical path-only worktree ID used by exact-head runtime markers.
t2_profile_owner_id() {
  local canonical_path branch="${2:-}"
  canonical_path="$(t2_canonical_worktree_path "${1:-}")" || return 1
  [[ -n "${branch}" && "${branch}" != *$'\n'* && "${branch}" != *$'\r'* && "${branch}" != *$'\t'* ]] || return 1
  printf '%s\0%s' "${canonical_path}" "${branch}" | shasum | awk '{print $1}'
}
