#!/usr/bin/env bash
# Read a Host runtime's log for a time window, and prove the read is complete
# (issue #1338 L5).
#
# `kubectl logs deployment/<host> --since-time=...` reads the current
# containers of one pod. A container that restarted inside the window lost the
# earlier container's log, a rollout leaves a second pod unread, and an empty
# result looks the same as a quiet Host. A Host logs no line per successful HCC
# poll, so an empty log cannot be told apart from an unread one by its content.
# The witness is therefore coverage: the log read is the complete log of the
# only process that could have logged anything in the window.
#
# read_host_log_window <host> <since_epoch> <out>
#   Succeeds only when the Host Deployment selects exactly one pod, that pod is
#   Running and not terminating, and every container (status.containerStatuses
#   plus native sidecars: init containers with restartPolicy Always) has been
#   running since before <since_epoch>. It then writes that pod's log since
#   <since_epoch> to <out> and prints
#     covered: pod <pod>, containers started <times>, <n> lines
#   Otherwise it returns 1 with the reason on stderr and never exits, so a
#   caller can `die` (a precondition) or `fail` and continue (a verdict check).
#   When a container of the selected pod restarted inside the window, its
#   previous log is saved to EVIDENCE_DIR before returning 1.
#
# Contract (globals owned by the sourcing gate):
#   HOST_NS       namespace of the Host runtimes
#   EVIDENCE_DIR  directory for saved previous-container logs
#   kctl          context-pinned kubectl wrapper (from e2e-lib.sh)

read_host_log_window() {
  local host="$1" since_epoch="$2" out="$3"
  local deployment_json selector pods_json pod_count pod since_iso containers_json
  local late container restarts started_list lines

  if ! deployment_json="$(kctl get "deployment/${host}" -n "$HOST_NS" -o json)"; then
    echo "host-log-window: could not read deployment ${host}" >&2
    return 1
  fi
  if ! selector="$(jq -er '
      (.spec.selector.matchLabels // {}) | to_entries | map("\(.key)=\(.value)") | join(",")
      | select(length > 0)' <<<"$deployment_json")"; then
    echo "host-log-window: deployment ${host} has no matchLabels selector" >&2
    return 1
  fi
  if ! pods_json="$(kctl get pods -n "$HOST_NS" -l "$selector" -o json)"; then
    echo "host-log-window: could not list the pods of ${host}" >&2
    return 1
  fi
  if ! pod_count="$(jq -er '.items | length' <<<"$pods_json")"; then
    echo "host-log-window: the pod list of ${host} is not a list" >&2
    return 1
  fi
  if [ "$pod_count" != 1 ]; then
    echo "host-log-window: ${host} has ${pod_count} pods; one pod's log cannot cover the window" >&2
    return 1
  fi
  if ! jq -e '.items[0] | .metadata.deletionTimestamp == null and .status.phase == "Running"' \
      <<<"$pods_json" >/dev/null; then
    echo "host-log-window: the pod of ${host} is terminating or not Running" >&2
    return 1
  fi
  pod="$(jq -er '.items[0].metadata.name' <<<"$pods_json")" || {
    echo "host-log-window: the pod of ${host} has no name" >&2
    return 1
  }

  # Every container that can log: regular containers plus native sidecars.
  if ! containers_json="$(jq -ec '
      .items[0] as $pod
      | [($pod.spec.initContainers // [])[] | select(.restartPolicy == "Always") | .name] as $sidecars
      | ($pod.status.containerStatuses // [])
        + [($pod.status.initContainerStatuses // [])[] | select(.name as $n | $sidecars | index($n))]
      | select(length > 0)' <<<"$pods_json")"; then
    echo "host-log-window: the pod ${pod} of ${host} reports no container status" >&2
    return 1
  fi

  # The first container not running since before the window, if any.
  late="$(jq -r --argjson since "$since_epoch" '
      [.[] | select((.state.running.startedAt // null) == null
                    or (.state.running.startedAt | fromdateiso8601) > $since)]
      | first // empty | "\(.name) \(.restartCount // 0)"' <<<"$containers_json")" || {
    echo "host-log-window: could not read container start times of ${pod}" >&2
    return 1
  }
  if [ -n "$late" ]; then
    container="${late% *}"
    restarts="${late#* }"
    if [ "$restarts" -gt 0 ]; then
      if ! kctl logs "pod/${pod}" -n "$HOST_NS" -c "$container" --previous \
          >"${EVIDENCE_DIR}/host-${host}-${container}-previous.log"; then
        echo "host-log-window: ${host} container ${container} restarted inside the window and its previous log could not be saved" >&2
        return 1
      fi
      echo "host-log-window: ${host} container ${container} restarted inside the window; its earlier log is not covered (saved to ${EVIDENCE_DIR}/host-${host}-${container}-previous.log)" >&2
      return 1
    fi
    echo "host-log-window: ${host} pod ${pod} container ${container} started inside the window; the log of the process it replaced is not covered" >&2
    return 1
  fi

  since_iso="$(jq -nr --argjson since "$since_epoch" '$since | todate')" || {
    echo "host-log-window: invalid window start ${since_epoch}" >&2
    return 1
  }
  if ! kctl logs "pod/${pod}" -n "$HOST_NS" --all-containers=true --since-time="$since_iso" >"$out"; then
    echo "host-log-window: could not read the log of ${pod} (${host})" >&2
    return 1
  fi
  started_list="$(jq -r 'map("\(.name)=\(.state.running.startedAt)") | join(" ")' <<<"$containers_json")"
  lines="$(wc -l <"$out" | tr -d ' ')"
  echo "covered: pod ${pod}, containers started ${started_list}, ${lines} lines"
}
