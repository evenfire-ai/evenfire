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
mode=capabilities
if [[ "${1:-}" == --desktop-startup ]]; then
  mode=desktop-startup
  shift
  [[ "$#" -le 1 ]] || { printf 'DESKTOP_STARTUP_ARGUMENT_INVALID\n' >&2; exit 1; }
fi
images=("$@")
for image in "${images[@]}"; do
  [[ "${#image}" -le 2048 && "$image" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]*$ ]] || {
    printf 'IMAGE_REF_INVALID\n' >&2
    exit 1
  }
done
if [[ "$mode" == desktop-startup && ${#images[@]} -eq 0 ]]; then
  images=(clerum/mcp-host-desktop:test)
elif [[ ${#images[@]} -eq 0 ]]; then
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
      if [[ "$mode" == desktop-startup ]]; then
        # Remove only anonymous volumes attached to this verified probe. Desktop
        # base images may declare VOLUME /config; do not retain private logs.
        owned_docker 20 docker container rm --force --volumes "$id" >/dev/null 2>&1 || cleanup_status=1
      else
        owned_docker 20 docker container rm --force "$id" >/dev/null 2>&1 || cleanup_status=1
      fi
    done <<<"$container_ids"
  fi
  return "$cleanup_status"
}
probe_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
cleanup() {
  local status=$?
  trap - EXIT
  local cleanup_status=0
  if [[ "$mode" == desktop-startup ]]; then
    cleanup_probe_containers 2>/dev/null || cleanup_status=1
  else
    cleanup_probe_containers || cleanup_status=1
  fi
  docker_cli_env_cleanup || cleanup_status=1
  if [[ "$mode" == desktop-startup ]]; then
    if [[ "$cleanup_status" -ne 0 ]]; then
      printf 'DESKTOP_STARTUP_TERMINAL status=Failed category=CleanupFailed\n'
    else
      printf 'DESKTOP_STARTUP_TERMINAL %s cleanup=ok\n' "${desktop_terminal:-status=Failed category=ProbeIncomplete}"
    fi
  fi
  [[ "$cleanup_status" -eq 0 ]] || status=1
  rm -rf -- "$task"
  exit "$status"
}
trap cleanup EXIT
docker_cli_env_prepare false
if [[ "$mode" == desktop-startup ]]; then
  # Docker's implicit VOLUME semantics differ from Kubernetes. This proves
  # only the actual image entrypoint under the HCC main-container policy.
  printf 'DESKTOP_STARTUP status=Pending scope=image-entrypoint-policy-only\n'
  desktop_terminal='status=Failed category=DaemonTransportFailed'
  owned_docker 20 docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || exit 1
  image="${images[0]}"
  desktop_terminal='status=Failed category=ImageMissing'
  image_id="$(owned_docker 20 docker image inspect --format '{{.Id}}' "$image" 2>/dev/null)" || exit 1
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
  printf 'IMAGE_ID %s %s\n' "$image" "$image_id"
  desktop_terminal='status=Failed category=UnknownLaunchFailure'
  helper="$ROOT/scripts/conversation-store/desktop-startup-observation.mjs"
  launch_pipeline_status=(0 0)
  # No /run mount or entrypoint/command override: preserve the baseline s6
  # failure if the HCC UID1001/drop-ALL/NoNewPrivileges policy cannot start it.
  # Match the owned development daemon's verified default json-file logger.
  # The local-driver fixture failed during logging setup before entrypoint
  # evidence; its exact cause remains unknown. Keep this explicit choice bounded.
  owned_docker 20 docker run --detach --pull=never --network=none --user 1001:1001 \
    --cap-drop=ALL --security-opt=no-new-privileges:true --memory=1g --memory-swap=1g --cpus=1 --pids-limit=256 \
    --stop-timeout=5 --log-driver=json-file --log-opt=max-size=256k --log-opt=max-file=1 \
    --label "clerum.io/conversation-store-probe=$probe_id" \
    --tmpfs /tmp:rw,size=64m,uid=1001,gid=1001,mode=1777 \
    --tmpfs /config/workspace:rw,size=64m,uid=1001,gid=1001,mode=0700 \
    "$image_id" 2>&1 | node "$helper" --launch-output \
    >"$task/launch-report" 2>/dev/null || launch_pipeline_status=("${PIPESTATUS[@]}")
  launch_status="${launch_pipeline_status[0]}"
  # minikube's PTY can merge remote stderr into stdout. Classify both streams
  # synchronously: the pipeline is reaped before reading its sanitized report.
  # launchExit is the owned Docker/SSH status, separate from container exit.
  desktop_terminal="status=Failed category=LaunchDiagnosticUnavailable launchExit=$launch_status transportTimedOut=false"
  [[ "${launch_pipeline_status[1]}" -eq 0 ]] || exit 1
  { IFS= read -r container_id; IFS= read -r launch_category; } <"$task/launch-report"
  desktop_terminal="status=Failed category=$launch_category launchExit=$launch_status transportTimedOut=false"
  if [[ "$launch_status" -eq 124 ]]; then
    desktop_terminal="status=Failed category=LaunchTransportTimeout launchExit=124 transportTimedOut=true"
  fi
  if [[ "$launch_status" -ne 0 ]]; then exit "$launch_status"; fi
  [[ "$launch_category" == UnknownLaunchFailure && "$container_id" =~ ^[0-9a-f]{64}$ ]] || exit 1
  desktop_terminal='status=Failed category=ContainerOwnershipUnknown'
  label="$(owned_docker 10 docker container inspect \
    --format '{{index .Config.Labels "clerum.io/conversation-store-probe"}}' "$container_id" 2>/dev/null)" || exit 1
  [[ "$label" == "$probe_id" ]] || exit 1
  snapshot_source="$(node "$helper" --remote-source)"
  observation_status=0
  # The in-container observer uses a 30s monotonic deadline. The inherited
  # runner bounds transport too; every subsequent operation has its own cap.
  owned_docker 35 docker exec --user 1001:1001 "$container_id" \
    node --input-type=module -e "$snapshot_source" \
    >"$task/startup-proof.json" 2>/dev/null || observation_status=$?
  desktop_terminal='status=Failed category=ContainerStateUnknown'
  state_format='{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}'
  owned_docker 10 docker container inspect --format "$state_format" "$container_id" \
    >"$task/observed-state" 2>/dev/null || exit 1
  termination=already-exited
  if [[ "$(cat "$task/observed-state")" == running\ * ]]; then
    termination=probe-stop
    desktop_terminal='status=Failed category=ContainerStopFailed'
    owned_docker 10 docker container stop --time 5 "$container_id" >/dev/null 2>&1 || exit 1
  fi
  owned_docker 10 docker container inspect --format "$state_format" "$container_id" \
    >"$task/final-state" 2>/dev/null || exit 1
  desktop_terminal='status=Failed category=LogObservationFailed'
  # Raw lines are streamed through the fixed-category classifier and discarded.
  # The bounded local log driver is removed with this exact-label container.
  owned_docker 10 docker logs --tail 80 "$container_id" 2>&1 | \
    node "$helper" --logs >"$task/categories.json" || exit 1
  result_status=0
  desktop_terminal="$(node "$helper" --summarize "$task/startup-proof.json" \
    "$task/observed-state" "$task/final-state" "$task/categories.json" \
    "$observation_status" "$termination")" || result_status=$?
  desktop_terminal+=" launchExit=$launch_status"
  exit "$result_status"
fi
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
