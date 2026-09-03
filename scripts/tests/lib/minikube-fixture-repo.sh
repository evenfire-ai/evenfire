#!/usr/bin/env bash

# Shared fixture repository boundary for Minikube shell tests. Tests may source
# this file from a checked-out worktree, but all Git operations performed by the
# fixture live under the caller-provided temporary directory.

minikube_test_fixture_repo_init() {
  local host_root="$1"
  local fixture_root="$2"
  local repo="${fixture_root}/repo"

  MINIKUBE_TEST_HOST_ROOT="$(cd -- "${host_root}" && pwd -P)"
  MINIKUBE_TEST_HOST_HEAD="$(git -C "${MINIKUBE_TEST_HOST_ROOT}" rev-parse --verify HEAD)"
  MINIKUBE_TEST_HOST_BRANCH="$(git -C "${MINIKUBE_TEST_HOST_ROOT}" branch --show-current)"
  MINIKUBE_TEST_HOST_STATUS_HASH="$({ git -C "${MINIKUBE_TEST_HOST_ROOT}" status --porcelain=v1 || true; } | shasum -a 256 | awk '{print $1}')"

  mkdir -p "${repo}"
  git init -q "${repo}"
  git -C "${repo}" config user.email fixture@example.invalid
  git -C "${repo}" config user.name minikube-fixture
  printf 'fixture\n' >"${repo}/README.md"
  git -C "${repo}" add README.md
  git -C "${repo}" commit -qm fixture
  git -C "${repo}" branch -M test/minikube-fixture
  git -C "${repo}" remote add origin https://github.com/evenfire-ai/evenfire.git
  git -C "${repo}" update-ref refs/remotes/origin/dev HEAD

  MINIKUBE_TEST_PROJECT_DIR="$(cd -- "${repo}" && pwd -P)"
  MINIKUBE_TEST_BRANCH="$(git -C "${MINIKUBE_TEST_PROJECT_DIR}" branch --show-current)"
  MINIKUBE_TEST_HEAD="$(git -C "${MINIKUBE_TEST_PROJECT_DIR}" rev-parse --verify HEAD)"
  MINIKUBE_TEST_WORKTREE_ID="$(printf '%s' "${MINIKUBE_TEST_PROJECT_DIR}" | shasum | awk '{print $1}')"
  MINIKUBE_TEST_LOCK_KEY="$(printf '%s\0%s\0%s\0%s\0%s' \
    "${MINIKUBE_TEST_PROJECT_DIR}" "${MINIKUBE_TEST_BRANCH}" \
    "${MINIKUBE_TEST_HEAD}" "${MINIKUBE_TEST_PROFILE:-fake}" \
    "${MINIKUBE_TEST_CONTEXT:-${MINIKUBE_TEST_PROFILE:-fake}}" |
    shasum | awk '{print $1}')"

  export MINIKUBE_TEST_HOST_ROOT MINIKUBE_TEST_HOST_HEAD
  export MINIKUBE_TEST_HOST_BRANCH MINIKUBE_TEST_HOST_STATUS_HASH
  export MINIKUBE_TEST_PROJECT_DIR MINIKUBE_TEST_BRANCH MINIKUBE_TEST_HEAD
  export MINIKUBE_TEST_WORKTREE_ID MINIKUBE_TEST_LOCK_KEY
}

minikube_test_assert_host_unchanged() {
  local current_head current_branch current_status_hash
  current_head="$(git -C "${MINIKUBE_TEST_HOST_ROOT}" rev-parse --verify HEAD)"
  current_branch="$(git -C "${MINIKUBE_TEST_HOST_ROOT}" branch --show-current)"
  current_status_hash="$({ git -C "${MINIKUBE_TEST_HOST_ROOT}" status --porcelain=v1 || true; } | shasum -a 256 | awk '{print $1}')"

  [[ "${current_head}" == "${MINIKUBE_TEST_HOST_HEAD}" ]] || {
    printf 'fixture mutated the host checkout HEAD: %s != %s\n' \
      "${current_head}" "${MINIKUBE_TEST_HOST_HEAD}" >&2
    return 1
  }
  [[ "${current_branch}" == "${MINIKUBE_TEST_HOST_BRANCH}" ]] || {
    printf 'fixture mutated the host checkout branch: %s != %s\n' \
      "${current_branch}" "${MINIKUBE_TEST_HOST_BRANCH}" >&2
    return 1
  }
  [[ "${current_status_hash}" == "${MINIKUBE_TEST_HOST_STATUS_HASH}" ]] || {
    printf 'fixture mutated the host checkout working tree\n' >&2
    return 1
  }
}
