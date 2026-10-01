#!/usr/bin/env bash
# Development-only child of Make/T2. No acquisition and no direct image builds.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
bash "$ROOT/scripts/minikube/require-t2-mutation-lock.sh"
source "$ROOT/scripts/minikube/docker-cli-env.sh"
images=("$@")
if [[ ${#images[@]} -eq 0 ]]; then
  images=(clerum/mcp-host:test clerum/mcp-host:test-slim clerum/mcp-host:test-full clerum/mcp-host-desktop:test)
fi
task="$(mktemp -d "${TMPDIR:-/tmp}/conversation-store-images.XXXXXX")"
chmod 700 "$task"
deadline() { docker_cli_run_public conversation-store-image "$1" "${@:2}"; }
container_id=''
probe_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$container_id" ]]; then
    if [[ "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
      owner="$(deadline 20 docker container inspect --format '{{ index .Config.Labels "clerum.io/conversation-store-probe" }}' "$container_id" 2>/dev/null || true)"
      if [[ "$owner" == "$probe_id" ]]; then deadline 20 docker container rm --force "$container_id" >/dev/null 2>&1 || status=1; fi
    else status=1; fi
  fi
  docker_cli_env_cleanup || status=1
  rm -rf -- "$task"
  exit "$status"
}
trap cleanup EXIT
docker_cli_env_prepare false
deadline 20 docker version --format '{{.Server.Version}}'
count=0
for image in "${images[@]}"; do
  [[ -n "$image" && "$image" != -* ]] || { printf 'IMAGE_MISSING\n' >&2;exit 1;}
  deadline 20 docker image inspect --format '{{.Id}}' "$image" > "$task/image-id" || { printf 'IMAGE_MISSING\n' >&2;exit 1;}
  image_id="$(cat "$task/image-id")"
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || { printf 'IMAGE_MISSING\n' >&2;exit 1;}
  cid="$task/cid-$count"
  run_status=0
  deadline 150 docker run --rm --pull=never --network=none --user 1001:1001 --cidfile "$cid" --label "clerum.io/conversation-store-probe=$probe_id" \
    --tmpfs /inspect-root:rw,size=512m,uid=1001,gid=1001,mode=0700 --entrypoint node \
    "$image_id" /app/mcp-host/ops/image-probe.mjs > "$task/proof-$count.json" || run_status=$?
  if [[ -s "$cid" ]]; then container_id="$(cat "$cid")"; fi
  if [[ "$run_status" -ne 0 ]]; then printf 'IMAGE_CAPABILITY_FAILED\n' >&2;exit "$run_status"; fi
  container_id=''
  node "$ROOT/scripts/conversation-store/verify-image-output.mjs" "$task/proof-$count.json"
  count=$((count+1))
done
[[ "$count" -gt 0 ]] || { printf 'NO_IMAGES_VERIFIED\n' >&2;exit 1;}
printf 'CONVERSATION_STORE_IMAGES_PASS images=%s\n' "$count"
