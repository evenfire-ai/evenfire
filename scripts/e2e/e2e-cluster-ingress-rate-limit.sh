#!/usr/bin/env bash
# Optional rate-limit gate (spec §8.5.2 / MEDIUM-4). Fires a burst at the
# rate-limited /api/v1/auth/* path and asserts the edge returns at least one
# 429. Run post-deploy only; requires the Cloudflare rate-limit rule to be live.
#
# Usage: scripts/e2e/e2e-cluster-ingress-rate-limit.sh [dev|prod]   (default: dev)
set -euo pipefail

ENV="${1:-dev}"
case "$ENV" in
  dev)  S="example.com" ;;
  prod) S="example.com" ;;
  *) echo "usage: $0 [dev|prod]" >&2; exit 2 ;;
esac

url="https://api.$S/api/v1/auth/__ratelimit-probe-404"
echo "== rate-limit gate ($ENV): 30 requests at $url =="
saw_429=0
for i in $(seq 1 30); do
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" || echo 000)
  echo "  req $i -> $c"
  if [ "$c" = "429" ]; then saw_429=1; fi
done

if [ "$saw_429" -eq 1 ]; then
  echo "PASS: edge returned at least one 429"
else
  echo "FAIL: no 429 in 30 requests — rate-limit rule not enforcing" >&2
  exit 1
fi
