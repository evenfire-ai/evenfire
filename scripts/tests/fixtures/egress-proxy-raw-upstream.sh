#!/bin/sh
# BusyBox nc executes one wrapper per accepted connection. Record the request
# line before returning the corresponding prebuilt malformed HTTP response.
set -eu
case "${1:-}" in
  p2|p3|p4) case_id="$1" ;;
  *) exit 2 ;;
esac
IFS= read -r request || exit 1
printf '%s\n' "$request" >>"/fixtures/$case_id.requests"
cat "/fixtures/$case_id.response"
