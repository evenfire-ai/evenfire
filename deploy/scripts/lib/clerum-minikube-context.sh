#!/usr/bin/env bash
# Shared Clerum local minikube context detection.
#
# Local validation profiles include clerum-test, branch-scoped profiles such as
# clerum-cursor-<branch>-<sha>, and generated gates like clerum-codex-* /
# clerum-detached-*. GKE/live contexts (gke_*) must never use minikube-only
# secret fallbacks.

is_clerum_minikube_context() {
  case "${CONTEXT:-}" in
    gke_*|docker-desktop|kind-*) return 1 ;;
  esac
  case "${CONTEXT:-}" in
    clerum-*|*minikube*) return 0 ;;
  esac
  return 1
}
