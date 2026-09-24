#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
source_dir="${MCP_COLLECTION_SOURCE_DIR:?Provide the reviewed local MCP collection checkout}"
revision=addf570cfcc8b2270b577f446fdb4c5d9d7b2d28
bash "$root/scripts/minikube/require-t2-mutation-lock.sh"
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$revision" ]]
[[ -z "$(git -C "$source_dir" status --porcelain)" ]]
docker_endpoint="$(node "$root/scripts/minikube/run-with-deadline.mjs" --timeout-seconds 30 --kill-grace-seconds 5 --label docker-endpoint -- docker context inspect --format '{{.Endpoints.docker.Host}}')"
case "$docker_endpoint" in
  unix:///*) [[ -S "${docker_endpoint#unix://}" ]] ;;
  *) echo 'A verified local Docker Unix socket is required' >&2; exit 1 ;;
esac
task_docker_config="$(mktemp -d)"
trap 'rm -rf -- "$task_docker_config"' EXIT
printf '{"auths":{}}\n' > "$task_docker_config/config.json"
export DOCKER_CONFIG="$task_docker_config" DOCKER_HOST="$docker_endpoint" DOCKER_BUILDKIT=1
unset DOCKER_CONTEXT
image="docker.io/clerum/issue627-github:${revision:0:12}"
# This Dockerfile copies package files and src relative to the connector directory.
# Building in the owned profile selects its native architecture without publication.
cd "$source_dir/mcp-github-clerum"
node "$root/scripts/minikube/run-with-deadline.mjs" \
  --timeout-seconds 900 --kill-grace-seconds 5 --label github-build -- \
  minikube --profile "${MINIKUBE_PROFILE:?}" image build --tag "$image" .
node "$root/scripts/minikube/run-with-deadline.mjs" \
  --timeout-seconds 30 --kill-grace-seconds 5 --label github-verify -- \
  minikube --profile "$MINIKUBE_PROFILE" image ls | grep -Fx "$image"
