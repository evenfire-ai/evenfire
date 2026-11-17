#!/bin/sh
# Runs INSIDE the minikube node (copied there with `minikube cp`, run with
# `minikube ssh -- sudo sh <path> <mode> <timeout-sec>`).
#
# Sends SIGKILL to the host-context-controller container's main process. That
# is the same abrupt end as the watchdog's process.exit(1): no graceful
# shutdown, no drain. kubelet then restarts the container inside the same pod
# (restartCount + 1), exactly what happens after the hard-limit exit.
#
# Modes:
#   idle      kill at once.
#   mid-pass  arm a watcher on the container's own log file and kill the moment
#             the controller logs `networkpolicy-pass-start`. The caller starts
#             a pass only after this script prints ARMED. The byte the watcher
#             reads from is fixed before ARMED is printed, so a line written
#             between ARMED and the watcher opening the file is still read, and
#             a line already in the log before the script started is not. A
#             pass on a small fleet takes tens of milliseconds, so the watcher
#             runs on the node, next to the log, instead of polling through the
#             API server.
#
# Output lines (parsed by the caller):
#   ARMED log=<path>          watcher start position fixed (mid-pass only)
#   KILLED pid=<pid> container=<id>
#   KILL_ERROR <reason>       exit 2: container lookup failed, or the watcher
#                             ended before its bound
#   NO_PASS_START             exit 3: no pass started within the timeout
set -eu

mode=${1:?mode required (idle|mid-pass)}
wait_sec=${2:-60}

ids=$(crictl ps --name '^host-context-controller$' --state running -q)
count=$(printf '%s\n' "$ids" | grep -c . || true)
if [ "$count" != 1 ]; then
  echo "KILL_ERROR running host-context-controller containers=${count}"
  exit 2
fi
id=$ids
pid=$(crictl inspect --output go-template --template '{{.info.pid}}' "$id")
log=$(crictl inspect --output go-template --template '{{.status.logPath}}' "$id")
case "$pid" in
  ''|*[!0-9]*) echo "KILL_ERROR pid=${pid}"; exit 2 ;;
esac
[ "$pid" -gt 1 ] || { echo "KILL_ERROR pid=${pid}"; exit 2; }

case "$mode" in
  idle)
    kill -KILL "$pid"
    echo "KILLED pid=${pid} container=${id}"
    exit 0
    ;;
  mid-pass)
    [ -r "$log" ] || { echo "KILL_ERROR unreadable log=${log}"; exit 2; }
    start=$(($(wc -c <"$log") + 1))
    echo "ARMED log=${log}"
    # `timeout` bounds the watcher; the loop kills the controller, then the
    # tail that feeds it, so the pipeline ends instead of waiting for a line
    # the dead container will never write. pkill -f reads its pattern as an
    # extended regular expression, where a bare `+` is a quantifier: `[+]`
    # matches the literal `+` of the tail arguments.
    watch_started=$(date +%s)
    if timeout "$wait_sec" tail -c "+${start}" -F "$log" 2>/dev/null | while IFS= read -r line; do
      case "$line" in
        *networkpolicy-pass-start*)
          kill -KILL "$pid"
          echo "KILLED pid=${pid} container=${id}"
          pkill -f "tail -c [+]${start} -F ${log}" || true
          exit 0
          ;;
      esac
    done; then
      :
    fi
    if kill -0 "$pid" 2>/dev/null; then
      # A watcher that ended before its bound did not watch for the whole
      # window (timeout or tail missing or failing): that is not a pass that
      # never started.
      elapsed=$(($(date +%s) - watch_started))
      if [ "$elapsed" -lt "$wait_sec" ]; then
        echo "KILL_ERROR watcher ended after ${elapsed}s of ${wait_sec}s without a pass start"
        exit 2
      fi
      echo "NO_PASS_START"
      exit 3
    fi
    exit 0
    ;;
  *)
    echo "KILL_ERROR unknown mode=${mode}"
    exit 2
    ;;
esac
