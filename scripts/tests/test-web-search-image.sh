#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$ROOT"
source scripts/minikube/docker-cli-env.sh
docker_cli_env_prepare
trap docker_cli_env_cleanup EXIT
revision="$(git rev-parse HEAD)"
image="evenfire-web-search-test:${revision}"
node scripts/minikube/run-with-deadline.mjs --timeout-seconds 300 --heartbeat-seconds 20 --kill-grace-seconds 5 --label web-search-image-build -- \
  docker build --pull=false --label "org.opencontainers.image.revision=${revision}" -t "$image" mcp-servers/web-search
image_id="$(node scripts/minikube/run-with-deadline.mjs --timeout-seconds 10 --heartbeat-seconds 5 --kill-grace-seconds 5 --label web-search-image-inspect -- \
  docker image inspect "$image" --format '{{.Id}}')"
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid local image identity' >&2; exit 1; }
printf 'WEB_SEARCH_TEST_REVISION=%s\nWEB_SEARCH_TEST_IMAGE=%s\n' "$revision" "$image_id"
node scripts/minikube/run-with-deadline.mjs --timeout-seconds 120 --heartbeat-seconds 20 --kill-grace-seconds 5 --label web-search-image-test -- \
  node mcp-servers/web-search/test/run-network.mjs --image "$image_id"
