#!/usr/bin/env bash
# Shared, dependency-free contracts for the self-hosted minimal bootstrap.
# Keep this file Bash 3.2-compatible: it is sourced by the macOS README path.

clerum_canonical_email() {
  printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]'
}

clerum_minimal_desktop_email() {
  local admin_email="${1:?admin email is required}"
  local requested_email="${2-}"
  local requested_present="${3:-false}"
  admin_email="$(clerum_canonical_email "$admin_email")"
  if [ "$requested_present" != "true" ]; then
    printf '%s' "$admin_email"
  else
    clerum_canonical_email "$requested_email"
  fi
}

clerum_initial_setup_link_is_active() {
  [ "${1:-}" = "active" ] &&
    [ "${2:-}" = "initial_setup" ] &&
    [ -n "${3:-}" ] &&
    [ "${4:-}" = "true" ]
}

clerum_initial_setup_link_matches() {
  [ "${1:-}" = "active" ] &&
    [ "${2:-}" = "initial_setup" ] &&
    [ -n "${3:-}" ] &&
    [ -n "${4:-}" ] &&
    [ -n "${5:-}" ] &&
    [ "${4}" = "${5}" ]
}

clerum_minimal_setup_outcome() {
  case "${1:-}" in
    2[0-9][0-9]) printf '%s' setup_succeeded ;;
    409) printf '%s' setup_already_consumed ;;
    *) printf '%s' setup_failed ;;
  esac
}
