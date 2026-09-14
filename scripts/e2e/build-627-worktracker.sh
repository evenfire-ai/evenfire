#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
source_dir="${WORKTRACKER_SOURCE_DIR:?Provide the reviewed local Worktracker checkout}"
revision=2b2dbd403d817fcfc20b0051a6d8ef637ee072c5
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
for service in api mcp ui; do
  image="clerum/issue627-worktracker-$service:${revision:0:12}"
  cd "$source_dir/$service"
  node "$root/scripts/minikube/run-with-deadline.mjs" \
    --timeout-seconds 900 --kill-grace-seconds 5 --label "worktracker-$service-build" -- \
    minikube --profile "${MINIKUBE_PROFILE:?}" image build \
    --tag "$image" .
  node "$root/scripts/minikube/run-with-deadline.mjs" \
    --timeout-seconds 30 --kill-grace-seconds 5 --label "worktracker-$service-verify" -- \
    minikube --profile "$MINIKUBE_PROFILE" image ls | grep -Fx "$image"
done
