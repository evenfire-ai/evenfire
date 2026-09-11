#!/usr/bin/env bash
# Fast, secret-safe local prerequisites for the Real PostgreSQL T1 lanes.
# Source this file and call real_pg_local_preflight before any expensive T0 or
# Minikube work. The helper never installs dependencies or mutates a cluster.

REAL_PG_PREFLIGHT_ERROR_CODE=""
REAL_PG_PREFLIGHT_ERROR_MESSAGE=""
REAL_PG_PREFLIGHT_DURATION_SECONDS=0
REAL_PG_PREFLIGHT_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REAL_PG_DOCKER_HELPER="$REAL_PG_PREFLIGHT_SCRIPT_DIR/../minikube/docker-cli-env.sh"

real_pg_preflight_fail() {
  REAL_PG_PREFLIGHT_ERROR_CODE="$1"
  REAL_PG_PREFLIGHT_ERROR_MESSAGE="$2"
  return 1
}

real_pg_local_preflight() {
  local project_dir="${1:-}"
  local require_docker="${2:-true}"
  local started_seconds="${SECONDS:-0}"
  local command_name node_major package package_dir docker_timeout docker_kill_grace

  REAL_PG_PREFLIGHT_ERROR_CODE=""
  REAL_PG_PREFLIGHT_ERROR_MESSAGE=""
  REAL_PG_PREFLIGHT_DURATION_SECONDS=0

  if [[ -z "$project_dir" || ! -d "$project_dir" ]]; then
    real_pg_preflight_fail LOCAL_DEPENDENCY_MISSING \
      'Real PostgreSQL preflight requires the repository root'
    return 1
  fi

  for command_name in node npm python3; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      real_pg_preflight_fail LOCAL_DEPENDENCY_MISSING \
        "required local dependency is unavailable: $command_name"
      return 1
    fi
  done

  node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
  if ! [[ "$node_major" =~ ^[0-9]+$ ]] || (( node_major < 24 )); then
    real_pg_preflight_fail LOCAL_DEPENDENCY_MISSING \
      "Node.js >=24 is required for T1; found ${node_major:-unknown}"
    return 1
  fi

  if [[ -n "${VITEST_MAX_WORKERS:-}" && "${VITEST_MAX_WORKERS}" != 1 ]]; then
    real_pg_preflight_fail UNSUPPORTED_T1_CONCURRENCY \
      "T1 is serial by contract; VITEST_MAX_WORKERS=${VITEST_MAX_WORKERS} is unsupported"
    return 1
  fi
  export VITEST_MAX_WORKERS=1

  for package in control-api gfs-controller; do
    package_dir="$project_dir/$package"
    if [[ ! -f "$package_dir/package.json" || ! -x "$package_dir/node_modules/.bin/vitest" ]]; then
      real_pg_preflight_fail LOCAL_DEPENDENCY_MISSING \
        "$package local dependencies are missing; run the repository-approved install before T1"
      return 1
    fi
    if ! (cd "$package_dir" && node -e 'require.resolve("vitest"); require.resolve("pg")') >/dev/null 2>&1; then
      real_pg_preflight_fail LOCAL_DEPENDENCY_MISSING \
        "$package cannot resolve its local vitest and pg dependencies"
      return 1
    fi
  done

  if [[ "$require_docker" == true ]]; then
    if ! command -v docker >/dev/null 2>&1; then
      real_pg_preflight_fail LOCAL_DEPENDENCY_MISSING \
        'required local dependency is unavailable: docker'
      return 1
    fi
    docker_timeout="${REAL_PG_DOCKER_INFO_TIMEOUT_SECONDS:-15}"
    if ! [[ "$docker_timeout" =~ ^[1-9][0-9]*$ ]] || (( docker_timeout > 120 )); then
      real_pg_preflight_fail LOCAL_DEPENDENCY_MISSING \
        'REAL_PG_DOCKER_INFO_TIMEOUT_SECONDS must be an integer from 1 to 120'
      return 1
    fi
    docker_kill_grace="${REAL_PG_DOCKER_KILL_GRACE_SECONDS:-1}"
    if ! [[ "$docker_kill_grace" =~ ^[1-9][0-9]*$ ]] || (( docker_kill_grace > 10 )); then
      real_pg_preflight_fail LOCAL_DEPENDENCY_MISSING \
        'REAL_PG_DOCKER_KILL_GRACE_SECONDS must be an integer from 1 to 10'
      return 1
    fi
    if [[ ! -f "$REAL_PG_DOCKER_HELPER" ]]; then
      real_pg_preflight_fail LOCAL_DEPENDENCY_MISSING \
        'the repository Docker isolation/deadline helper is missing'
      return 1
    fi
    if ! MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS="$docker_timeout" \
      MINIKUBE_DOCKER_START_PROBE_TIMEOUT_SECONDS="$docker_timeout" \
      MINIKUBE_DOCKER_KILL_GRACE_SECONDS="$docker_kill_grace" \
      bash "$REAL_PG_DOCKER_HELPER" --check-info >/dev/null 2>&1; then
      real_pg_preflight_fail LOCAL_DEPENDENCY_MISSING \
        "Docker is unavailable or did not answer within ${docker_timeout}s"
      return 1
    fi
  elif [[ "$require_docker" != false ]]; then
    real_pg_preflight_fail LOCAL_DEPENDENCY_MISSING \
      'Real PostgreSQL preflight require_docker must be true or false'
    return 1
  fi

  REAL_PG_PREFLIGHT_DURATION_SECONDS=$(( ${SECONDS:-0} - started_seconds ))
  printf '[real-pg-preflight] PASS node=%s workers=1 packages=2 docker=%s duration=%ss\n' \
    "$node_major" "$require_docker" "$REAL_PG_PREFLIGHT_DURATION_SECONDS"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if ! real_pg_local_preflight "${1:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)}" true; then
    printf '%s: %s\n' "$REAL_PG_PREFLIGHT_ERROR_CODE" "$REAL_PG_PREFLIGHT_ERROR_MESSAGE" >&2
    exit 1
  fi
fi
