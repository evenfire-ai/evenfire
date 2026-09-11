#!/usr/bin/env bash

# Validate the complete pre-gate marker tuple. The marker JSON is passed as an
# argument so callers can keep kubectl's response in memory without persisting
# it or printing it.

# Read the marker without ever converting an API/read error into an empty
# payload. The caller supplies the existing `kctl` function; only the JSON
# document is returned, never kubectl diagnostics or object contents on error.
np08_read_sync_marker() {
  local namespace="$1"
  local name="$2"
  local marker

  if ! marker="$(kctl -n "${namespace}" get configmap "${name}" -o json 2>/dev/null)"; then
    return 1
  fi
  [[ -n "${marker}" ]] || return 1
  printf '%s' "${marker}"
}

np08_verify_sync_marker() {
  local expected_worktree="$1"
  local expected_head="$2"
  local expected_cluster="$3"
  local expected_infra="$4"
  local expected_image_source="$5"
  local expected_image_tag="$6"
  local expected_images_generated_at="$7"
  local marker_json="$8"

  python3 - "${expected_worktree}" "${expected_head}" \
    "${expected_cluster}" "${expected_infra}" \
    "${expected_image_source}" "${expected_image_tag}" \
    "${expected_images_generated_at}" "${marker_json}" <<'PY'
import json
import sys

(
    expected_worktree,
    expected_head,
    expected_cluster,
    expected_infra,
    expected_image_source,
    expected_image_tag,
    expected_images_generated_at,
    marker_json,
) = sys.argv[1:]

if not expected_cluster or not expected_infra:
    raise SystemExit("FAIL: current pre-gate fingerprints are unavailable")
if not expected_worktree or not expected_head or not expected_image_source:
    raise SystemExit("FAIL: current pre-gate identity is incomplete")
if not expected_images_generated_at:
    raise SystemExit("FAIL: current image acquisition timestamp is unavailable")
if expected_image_source != "local" or expected_image_tag:
    raise SystemExit("FAIL: NP-08 E2E requires the branch-owned local image coordinate")

try:
    payload = json.loads(marker_json)
except (TypeError, json.JSONDecodeError) as exc:
    raise SystemExit(f"FAIL: pre-gate marker is not valid JSON: {exc}") from exc
if not isinstance(payload, dict) or not isinstance(payload.get("data"), dict):
    raise SystemExit("FAIL: pre-gate marker has no data object")
data = payload["data"]

expected = {
    "worktreeId": expected_worktree,
    "gitHead": expected_head,
    "clusterFingerprint": expected_cluster,
    "infraFingerprint": expected_infra,
    "imageSource": expected_image_source,
    "imageTag": expected_image_tag,
    "imagesGeneratedAt": expected_images_generated_at,
}

for key, value in expected.items():
    if data.get(key) != value:
        raise SystemExit(f"FAIL: pre-gate marker field mismatch: {key}")
PY
}
