#!/usr/bin/env bash

replace_one_literal() {            # file from to; exactly one occurrence or exit 1
  local file="$1" from="$2" to="$3" content rest n=0
  [ -n "$from" ] || { echo "FAIL: empty pattern" >&2; exit 1; }
  content="$(cat "$file"; printf x)"; content="${content%x}"
  rest="$content"
  while [[ "$rest" == *"$from"* ]]; do rest="${rest#*"$from"}"; n=$((n + 1)); done
  [ "$n" = 1 ] || { echo "FAIL: expected one '$from' in $file, found $n" >&2; exit 1; }
  printf '%s%s%s' "${content%%"$from"*}" "$to" "${content#*"$from"}" >"$file"
}
