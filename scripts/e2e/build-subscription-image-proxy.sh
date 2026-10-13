#!/usr/bin/env bash
# E2E_GUARDIAN_IPC_FLOW: physical build prerequisite only; no browser journey.
# Test-only derived images. The documented Make coordinator owns the same
# mutation lease throughout build, activation, observation and restoration.
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
[[ $# == 7 ]] || { printf 'DERIVED_PROXY_BUILD_ARGUMENTS\n' >&2; exit 2; }
PROFILE="$1"; CONTEXT_DIR="$2"; PROXY_REF="$3"; PROXY_ID="$4"; HOST_ID="$5"; FIXTURE_REF="$6"; HEAD="$7"
[[ "$PROFILE" =~ ^[a-z0-9][a-z0-9-]{0,62}$ && "$PROFILE" != clerum-test &&
   "$PROFILE" == "${MINIKUBE_PROFILE:-}" && "$PROFILE" == "${CONTROL_API_REAL_PG_CONTEXT:-}" &&
   "$PROXY_ID" =~ ^sha256:[a-f0-9]{64}$ && "$HOST_ID" =~ ^sha256:[a-f0-9]{64}$ &&
   "$HEAD" =~ ^[a-f0-9]{40}$ && "$CONTEXT_DIR" == /* &&
   "$PROXY_REF" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/:-]*$ &&
   "$FIXTURE_REF" =~ ^clerum/(grok|codex)-llm-proxy-image-qa:[a-f0-9]{12}$ ]] || {
  printf 'DERIVED_PROXY_BUILD_IDENTITY\n' >&2; exit 2;
}
T2_PROJECT_DIR="$PROJECT_DIR" T2_PROFILE="$PROFILE" T2_CONTEXT="$PROFILE" \
  bash "$PROJECT_DIR/scripts/minikube/require-t2-mutation-lock.sh"
source "$PROJECT_DIR/scripts/minikube/docker-cli-env.sh"
trap docker_cli_env_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker_cli_env_prepare
# The native helper pins an explicit local endpoint before creating its empty
# task Docker config. The profile endpoint must independently pass that gate.
PROFILE_DOCKER_ENV="$(node "$DOCKER_CLI_DEADLINE_RUNNER" --timeout-seconds 30 --heartbeat-seconds 20 \
  --kill-grace-seconds 5 --label qa-minikube-docker-env -- minikube --profile "$PROFILE" docker-env --shell bash)"
[[ -n "$PROFILE_DOCKER_ENV" ]] || { printf 'DERIVED_PROXY_DOCKER_ENV_EMPTY\n' >&2; exit 1; }
PARSED_DOCKER_ENV="$(printf '%s' "$PROFILE_DOCKER_ENV" | node --input-type=module -e '
let raw="";for await(const chunk of process.stdin)raw+=chunk;
const allowed=new Set(["DOCKER_HOST","DOCKER_TLS_VERIFY","DOCKER_CERT_PATH","MINIKUBE_ACTIVE_DOCKERD"]),seen=new Set();
for(const line of raw.split("\n")){if(!line.trim()||line.startsWith("#"))continue;
 const match=/^export ([A-Z_]+)="([^"\\$`\x00-\x1f]*)"$/.exec(line);
 if(!match||!allowed.has(match[1])||seen.has(match[1]))throw Error("DERIVED_PROXY_DOCKER_ENV_SYNTAX");
 seen.add(match[1]);process.stdout.write(match[1]+"\t"+match[2]+"\n");
}if(!seen.has("DOCKER_HOST")||!seen.has("MINIKUBE_ACTIVE_DOCKERD"))throw Error("DERIVED_PROXY_DOCKER_ENV_INCOMPLETE");')"
while IFS=$'\t' read -r name value; do export "$name=$value"; done <<< "$PARSED_DOCKER_ENV"
[[ "$MINIKUBE_ACTIVE_DOCKERD" == "$PROFILE" ]] || { printf 'DERIVED_PROXY_DAEMON_OWNER\n' >&2; exit 1; }
docker_cli_env_validate_local_endpoint "$DOCKER_HOST"
unset DOCKER_API_VERSION
live_proxy="$(docker_cli_run_public qa-proxy-base-id 30 docker image inspect --format '{{.Id}}' "$PROXY_REF")"
live_host="$(docker_cli_run_public qa-host-base-id 30 docker image inspect --format '{{.Id}}' clerum/mcp-host:test)"
[[ "$live_proxy" == "$PROXY_ID" && "$live_host" == "$HOST_ID" ]] || { printf 'DERIVED_PROXY_BASE_IMAGE_CHANGED\n' >&2; exit 1; }
suffix="${FIXTURE_REF##*:}"
proxy_base="${FIXTURE_REF%:*}-base:$suffix"
host_base="clerum/subscription-image-host-base:$suffix"
docker_cli_run_public qa-proxy-base-pin 30 docker image tag "$PROXY_ID" "$proxy_base"
docker_cli_run_public qa-host-base-pin 30 docker image tag "$HOST_ID" "$host_base"
docker_cli_run_public qa-proxy-build 300 docker build --pull=false \
  -f "$CONTEXT_DIR/scripts/e2e/fixtures/subscription-image-proxy.Dockerfile" -t "$FIXTURE_REF" \
  --build-arg "PROXY_BASE_IMAGE=$proxy_base" --build-arg "HOST_BASE_IMAGE=$host_base" \
  --build-arg "SOURCE_HEAD=$HEAD" "$CONTEXT_DIR" >&2
after_proxy="$(docker_cli_run_public qa-proxy-base-after 30 docker image inspect --format '{{.Id}}' "$proxy_base")"
after_host="$(docker_cli_run_public qa-host-base-after 30 docker image inspect --format '{{.Id}}' "$host_base")"
[[ "$after_proxy" == "$PROXY_ID" && "$after_host" == "$HOST_ID" ]] || { printf 'DERIVED_PROXY_BASE_IMAGE_CHANGED\n' >&2; exit 1; }
derived="$(docker_cli_run_public qa-derived-image-id 30 docker image inspect --format '{{.Id}}' "$FIXTURE_REF")"
[[ "$derived" =~ ^sha256:[a-f0-9]{64}$ ]] || { printf 'DERIVED_PROXY_IMAGE_ID_UNKNOWN\n' >&2; exit 1; }
printf '{"imageId":"%s","baseImageId":"%s","hostImageId":"%s","gitHead":"%s"}\n' "$derived" "$PROXY_ID" "$HOST_ID" "$HEAD"
