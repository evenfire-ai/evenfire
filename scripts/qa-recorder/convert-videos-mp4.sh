#!/usr/bin/env bash
# Convert QA-recorder journey videos from Playwright's native WebM to MP4
# (H.264 + faststart) so evidence can be attached anywhere without codec
# questions. Screenshots are already PNG and need no conversion.
#
# Usage:
#   scripts/qa-recorder/convert-videos-mp4.sh [--replace] [root]
#
#   --replace   delete the source .webm after a successful conversion
#   root        recorder root (default: <repo>/.local-notes/qa-recorder;
#               honored from $QA_RECORDER_ROOT like the playwright config)
set -euo pipefail

replace=0
root="${QA_RECORDER_ROOT:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --replace) replace=1 ;;
    -h|--help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      if [ -n "$root" ]; then
        echo "unexpected argument: $1" >&2
        exit 2
      fi
      root="$1"
      ;;
  esac
  shift
done

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
root="${root:-$repo_root/.local-notes/qa-recorder}"
runs_dir="$root/runs"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required for MP4 conversion but was not found on PATH." >&2
  echo "Install ffmpeg (e.g. apt install ffmpeg) or keep the WebM originals." >&2
  exit 1
fi

if [ ! -d "$runs_dir" ]; then
  echo "No recorder runs found under $runs_dir — run a journey first:"
  echo "  cd control-ui && npm run qa:recorder:<journey>"
  exit 0
fi

count=0
failed=0
while IFS= read -r -d '' webm; do
  mp4="${webm%.webm}.mp4"
  if ffmpeg -y -hide_banner -loglevel error -i "$webm" \
      -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$mp4"; then
    echo "[mp4] $mp4"
    count=$((count + 1))
    if [ "$replace" -eq 1 ]; then
      rm -- "$webm"
    fi
  else
    echo "[fail] $webm" >&2
    failed=$((failed + 1))
  fi
done < <(find "$runs_dir" -type f -name '*.webm' -print0)

echo "converted $count video(s)$([ "$replace" -eq 1 ] && echo ', sources removed' || echo '')"
[ "$failed" -eq 0 ] || exit 1
