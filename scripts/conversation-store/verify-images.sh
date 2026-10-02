#!/usr/bin/env bash
# Development-only child of Make/T2. No acquisition and no direct image builds.
set -euo pipefail
ROOT="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
bash "$ROOT/scripts/minikube/require-t2-mutation-lock.sh"
source "$ROOT/scripts/minikube/docker-cli-env.sh"
[[ "${MINIKUBE_PROFILE:-}" =~ ^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$ ]] &&
  [[ "${#MINIKUBE_PROFILE}" -le 63 ]] || {
  printf 'CONVERSATION_STORE_PROFILE_INVALID\n' >&2
  exit 1
}
images=("$@")
for image in "${images[@]}"; do
  [[ "${#image}" -le 2048 && "$image" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]*$ ]] || {
    printf 'IMAGE_REF_INVALID\n' >&2
    exit 1
  }
done
if [[ ${#images[@]} -eq 0 ]]; then
  images=(
    clerum/mcp-host:test
    clerum/mcp-host-slim:test
    clerum/mcp-host-full:test
    clerum/mcp-host-desktop:test
  )
fi
task="$(mktemp -d "${TMPDIR:-/tmp}/conversation-store-images.XXXXXX")"
chmod 700 "$task"
quote_remote_arg() {
  local value="$1" quoted="'" index char
  for ((index = 0; index < ${#value}; index++)); do
    char="${value:index:1}"
    if [[ "$char" == "'" ]]; then
      quoted+="'\\''"
    else
      quoted+="$char"
    fi
  done
  quoted+="'"
  printf '%s' "$quoted"
}
owned_docker() {
  local timeout_seconds="$1" arg quoted_arg remote_command=""
  shift
  for arg in "$@"; do
    quoted_arg="$(quote_remote_arg "$arg")"
    remote_command+="${remote_command:+ }${quoted_arg}"
  done
  # The SSH PTY emits CRLF; remove only the terminal CR on each output line.
  # pipefail preserves failed transport exits through the normalizer.
  node "$DOCKER_CLI_DEADLINE_RUNNER" \
    --timeout-seconds "$timeout_seconds" \
    --heartbeat-seconds "$MINIKUBE_DOCKER_HEARTBEAT_SECONDS" \
    --kill-grace-seconds "$MINIKUBE_DOCKER_KILL_GRACE_SECONDS" \
    --label conversation-store-image -- \
    minikube -p "$MINIKUBE_PROFILE" ssh -- "$remote_command" | awk '{ sub(/\r$/, ""); print }'
}
cleanup_probe_containers() {
  local container_ids cleanup_status=0 id label
  container_ids="$(owned_docker 20 \
    docker container ls --all \
    --no-trunc \
    --filter "label=clerum.io/conversation-store-probe=$probe_id" \
    --format '{{.ID}}' 2>/dev/null)" || return 1
  if [[ -n "$container_ids" ]]; then
    while IFS= read -r id; do
      [[ "$id" =~ ^[0-9a-f]{64}$ ]] || return 1
      label="$(owned_docker 20 \
        docker container inspect \
        --format '{{index .Config.Labels "clerum.io/conversation-store-probe"}}' \
        "$id")" || return 1
      [[ "$label" == "$probe_id" ]] || continue
      owned_docker 20 docker container rm --force "$id" >/dev/null 2>&1 || cleanup_status=1
    done <<<"$container_ids"
  fi
  return "$cleanup_status"
}
probe_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
cleanup() {
  local status=$?
  trap - EXIT
  cleanup_probe_containers || status=1
  docker_cli_env_cleanup || status=1
  rm -rf -- "$task"
  exit "$status"
}
trap cleanup EXIT
docker_cli_env_prepare false
owned_docker 20 docker version --format '{{.Server.Version}}'
count=0
for image in "${images[@]}"; do
  [[ -n "$image" && "$image" != -* ]] || { printf 'IMAGE_MISSING\n' >&2;exit 1;}
  owned_docker 20 docker image inspect --format '{{.Id}}' "$image" > "$task/image-id" || { printf 'IMAGE_MISSING\n' >&2;exit 1;}
  image_id="$(cat "$task/image-id")"
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || { printf 'IMAGE_MISSING\n' >&2;exit 1;}
  printf 'IMAGE_ID %s %s\n' "$image" "$image_id"
  run_status=0
  owned_docker 150 docker run --rm --pull=never --network=none --user 1001:1001 --label "clerum.io/conversation-store-probe=$probe_id" \
    --tmpfs /inspect-root:rw,size=512m,uid=1001,gid=1001,mode=0700 --entrypoint node \
    "$image_id" /app/mcp-host/ops/image-probe.mjs > "$task/proof-$count.json" || run_status=$?
  if [[ "$run_status" -ne 0 ]]; then printf 'IMAGE_CAPABILITY_FAILED\n' >&2;exit "$run_status"; fi
  node "$ROOT/scripts/conversation-store/verify-image-output.mjs" "$task/proof-$count.json"
  count=$((count+1))
done
[[ "$count" -gt 0 ]] || { printf 'NO_IMAGES_VERIFIED\n' >&2;exit 1;}
printf 'CONVERSATION_STORE_IMAGES_PASS images=%s\n' "$count"
