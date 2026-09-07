#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "::error::Usage: fetch-bounded-commits.sh <base-sha> <head-sha>" >&2
  exit 1
fi

labels=(base head)
shas=("$1" "$2")

for index in 0 1; do
  label="${labels[$index]}"
  sha="${shas[$index]}"

  if git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    continue
  fi

  if ! git fetch --no-tags origin "$sha" || ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    echo "::error::Cannot determine a bounded incoming diff: $label commit $sha is unavailable." >&2
    echo "::error::Refusing to fall back to an empty-tree or repository-wide check." >&2
    exit 1
  fi
done
