#!/usr/bin/env bash
# Shared, dependency-free contracts for the self-hosted minimal bootstrap.
# Keep this file Bash 3.2-compatible: it is sourced by the macOS README path.

clerum_canonical_email() {
  printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]'
}

clerum_initial_setup_link_is_active() {
  [ "${1:-}" = "active" ] &&
    [ "${2:-}" = "initial_setup" ] &&
    [ -n "${3:-}" ] &&
    [ "${4:-}" = "true" ]
}
