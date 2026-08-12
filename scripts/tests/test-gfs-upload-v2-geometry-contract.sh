#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }

read_const() {
  local file="$1" name="$2"
  sed -nE "s/^(export )?const ${name} = (.*);?$/\\2/p" "$file" \
    | head -1 \
    | tr -d '[:space:]'
}

gfsc_preferred="$(read_const gfs-controller/src/upload/protocol.ts GFS_UPLOAD_V2_PREFERRED_PART_BYTES)"
gfsc_max="$(read_const gfs-controller/src/upload/protocol.ts GFS_UPLOAD_V2_MAX_PART_BYTES)"
ui_preferred="$(read_const control-ui/app/constants/gfsFileUpload.ts GFS_FILE_UPLOAD_PREFERRED_PART_BYTES)"
ui_max="$(read_const control-ui/app/constants/gfsFileUpload.ts GFS_FILE_UPLOAD_MAX_PART_BYTES)"
desktop_preferred="$(read_const desktop-app/src/gfs/upload.ts GFS_UPLOAD_V2_PREFERRED_PART_BYTES)"
desktop_max="$(read_const desktop-app/src/gfs/upload.ts GFS_UPLOAD_V2_MAX_PART_BYTES)"

[[ -n "$gfsc_preferred" && "$gfsc_preferred" == "$ui_preferred" && "$gfsc_preferred" == "$desktop_preferred" ]] \
  || fail "preferred part geometry diverges between writer, Control UI, and Desktop"
[[ -n "$gfsc_max" && "$gfsc_max" == "$ui_max" && "$gfsc_max" == "$desktop_max" ]] \
  || fail "maximum part geometry diverges between writer, Control UI, and Desktop"

echo "PASS: GFS Upload v2 part geometry is aligned across writer, Control UI, and Desktop"
