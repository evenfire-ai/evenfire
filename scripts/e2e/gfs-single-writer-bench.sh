#!/usr/bin/env bash
# gfs single-writer write-ceiling benchmark (plan P5-S04).
#
# Drives a sustained write load against ONE gfsc writer on standard-rwo and
# records the measured envelope (writes/sec, MiB/s, audit-commit rate) — the
# documented trigger for subtree-sharding / failover. The envelope math lives in
# gfs-controller/bench/singleWriter.ts (unit-tested); this script feeds it real
# samples from a live writer and writes the report.
#
# NOT a CI test — needs a live cluster + a Ready gfsc writer. Fail-loud: a
# not-Ready writer or a failed write aborts with the concrete reason.
#
# Usage: CONTEXT=clerum-codex-gfs-<sha> scripts/e2e/gfs-single-writer-bench.sh
set -euo pipefail

CONTEXT="${CONTEXT:?set CONTEXT to an allowed branch/clerum-test profile}"
GFS_NS="${GFS_NS:-gfs}"
DURATION_S="${DURATION_S:-30}"
REPORT="${REPORT:-.local-notes/gfs/single-writer-bench.txt}"

kc() { kubectl --context="$CONTEXT" "$@"; }

case "$CONTEXT" in
  clerum-test | clerum-codex-* | clerum-detached-*) : ;;
  *) echo "FATAL: CONTEXT '$CONTEXT' is not an allowed local/branch profile" >&2; exit 1 ;;
esac

echo "== gfs single-writer benchmark (context=$CONTEXT, ${DURATION_S}s) =="

# The gfsc writer must be Ready before a meaningful ceiling can be measured.
ready="$(kc -n "$GFS_NS" get pods -l 'app=gfs-controller,clerum.io/gfsc-role=writer' \
  -o 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
if ! echo "$ready" | grep -q 'True'; then
  echo "FATAL: gfsc writer is not Ready in ns $GFS_NS — cannot benchmark" >&2
  kc -n "$GFS_NS" get pods -o wide >&2 || true
  exit 1
fi

mkdir -p "$(dirname "$REPORT")"
# The write-load loop + sample collection (feeding singleWriter.ts
# summarizeBench/renderReport) is NOT yet wired (needs a minted host token + the
# write API). Fail loud: a benchmark that performs no writes must not claim an
# envelope. This is RED until the load client is implemented.
echo "FATAL: write-load loop not wired — benchmark is RED until implemented (no envelope produced)" >&2
exit 1
