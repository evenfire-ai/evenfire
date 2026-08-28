#!/usr/bin/env bash
# Atomic Kubernetes Secret transitions for resumable GFSC credential rotation.
# Candidate connection material is accepted only on stdin.
# Snapshot globals are consumed by the provisioning script that sources this file.
# shellcheck disable=SC2034
GFS_ROLLOUT_PROOF_KIND=""
GFS_ROLLOUT_PROOF_RESOURCE_VERSION=""
GFS_ROLLOUT_PROOF_TEMPLATE_REVISION=""
GFS_ROLLOUT_PROOF_POD_COUNT=""
GFS_ROLLOUT_PROOF_AT=""

gfs_secret_state() {
  kc -n "$GFS_NS" get secret "$1" -o 'jsonpath={.metadata.annotations.clerum\.io/gfs-dsn-state}'
}

gfs_secret_rotated_at() {
  kc -n "$GFS_NS" get secret "$1" -o 'jsonpath={.metadata.annotations.clerum\.io/gfs-dsn-rotated-at}'
}

ensure_secret_state() {
  local secret="$1" state rv
  state="$(gfs_secret_state "$secret")"
  [ -n "$state" ] && return 0
  rv="$(secret_resource_version "$secret")"
  python3 -c 'import json, sys
print(json.dumps({"metadata": {"resourceVersion": sys.argv[1], "annotations": {"clerum.io/gfs-dsn-state": "ready"}}}))' "$rv" \
    | kc -n "$GFS_NS" patch secret "$secret" --type=merge --patch-file=/dev/stdin >/dev/null \
    || [ -n "$(gfs_secret_state "$secret")" ]
}

load_secret_snapshot() {
  local secret="$1" encoded rv annotations state rotated active pending
  encoded="$(kc -n "$GFS_NS" get secret "$secret" -o json | python3 -c 'import base64, json, sys
obj = json.load(sys.stdin)
metadata = obj.get("metadata") or {}
annotations = metadata.get("annotations") or {}
data = obj.get("data") or {}
def decode_data(key):
    value = data.get(key, "")
    return base64.b64decode(value, validate=True) if value else b""
values = [
    str(metadata.get("resourceVersion", "")).encode(),
    (b"yes" if annotations else b"no"),
    str(annotations.get("clerum.io/gfs-dsn-state", "")).encode(),
    str(annotations.get("clerum.io/gfs-dsn-rotated-at", "")).encode(),
    decode_data("connection-string"),
    decode_data("pending-connection-string"),
]
print("|".join(base64.b64encode(value).decode() for value in values))')" || return 1
  IFS='|' read -r rv annotations state rotated active pending <<<"$encoded"
  GFS_SNAPSHOT_RV="$(printf '%s' "$rv" | base64 -d)" || return 1
  GFS_SNAPSHOT_ANNOTATIONS="$(printf '%s' "$annotations" | base64 -d)" || return 1
  GFS_SNAPSHOT_STATE="$(printf '%s' "$state" | base64 -d)" || return 1
  GFS_SNAPSHOT_ROTATED_AT="$(printf '%s' "$rotated" | base64 -d)" || return 1
  GFS_SNAPSHOT_ACTIVE="$(printf '%s' "$active" | base64 -d)" || return 1
  GFS_SNAPSHOT_PENDING="$(printf '%s' "$pending" | base64 -d)" || return 1
  [ -n "$GFS_SNAPSHOT_RV" ]
}

adopt_legacy_secret_state() {
  local secret="$1" expected_rv="$2" annotations_exist="$3" existing_stamp="$4" adopted_at="$5"
  python3 -c 'import json, sys
rv, annotations_exist, existing_stamp, adopted_at = sys.argv[1:]
state = {"clerum.io/gfs-dsn-state": "ready"}
if not existing_stamp:
    state["clerum.io/gfs-dsn-rotated-at"] = adopted_at
op = {"op": "add", "path": "/metadata/annotations", "value": state}
if annotations_exist == "yes":
    op = {"op": "add", "path": "/metadata/annotations/clerum.io~1gfs-dsn-state", "value": "ready"}
ops = [{"op": "test", "path": "/metadata/resourceVersion", "value": rv}, op]
if annotations_exist == "yes" and not existing_stamp:
    ops.append({"op": "add", "path": "/metadata/annotations/clerum.io~1gfs-dsn-rotated-at", "value": adopted_at})
print(json.dumps(ops))' "$expected_rv" "$annotations_exist" "$existing_stamp" "$adopted_at" \
    | kc -n "$GFS_NS" patch secret "$secret" --type=json --patch-file=/dev/stdin >/dev/null 2>&1
}

gfs_candidate_patch() {
  local transition="$1"
  python3 -c 'import base64, datetime, json, sys
transition = sys.argv[1]
candidate = base64.b64encode(sys.stdin.buffer.read()).decode()
state_path = "/metadata/annotations/clerum.io~1gfs-dsn-state"
pending_path = "/data/pending-connection-string"
ops = []
if transition == "claim":
    ops = [
        {"op": "test", "path": state_path, "value": "pending"},
        {"op": "test", "path": pending_path, "value": candidate},
        {"op": "replace", "path": state_path, "value": "applying"},
    ]
elif transition == "promote":
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    ops = [
        {"op": "test", "path": state_path, "value": "applying"},
        {"op": "test", "path": pending_path, "value": candidate},
        {"op": "add", "path": "/data/connection-string", "value": candidate},
        {"op": "remove", "path": pending_path},
        {"op": "replace", "path": state_path, "value": "rollout-pending"},
        {"op": "add", "path": "/metadata/annotations/clerum.io~1gfs-dsn-rotated-at", "value": stamp},
    ]
elif transition == "rollback":
    ops = [
        {"op": "test", "path": state_path, "value": "applying"},
        {"op": "test", "path": pending_path, "value": candidate},
        {"op": "remove", "path": pending_path},
        {"op": "replace", "path": state_path, "value": "ready"},
    ]
elif transition == "release":
    ops = [
        {"op": "test", "path": state_path, "value": "applying"},
        {"op": "test", "path": pending_path, "value": candidate},
        {"op": "replace", "path": state_path, "value": "pending"},
    ]
else:
    raise SystemExit(2)
print(json.dumps(ops))' "$transition"
}

stage_secret_candidate() {
  local secret="$1" candidate rv data_exists staging_err
  staging_err="$(mktemp)"
  candidate="$(cat)"
  rv="$(secret_resource_version "$secret")" || { rm -f "$staging_err"; return 1; }
  data_exists="$(kc -n "$GFS_NS" get secret "$secret" \
    -o 'go-template={{if .data}}yes{{else}}no{{end}}')" || { rm -f "$staging_err"; return 1; }
  if printf '%s' "$candidate" | python3 -c 'import base64, json, sys
rv, data_exists = sys.argv[1:]
candidate = base64.b64encode(sys.stdin.buffer.read()).decode()
state_path = "/metadata/annotations/clerum.io~1gfs-dsn-state"
data_op = {"op": "add", "path": "/data/pending-connection-string", "value": candidate}
if data_exists == "no":
    data_op = {"op": "add", "path": "/data", "value": {"pending-connection-string": candidate}}
print(json.dumps([
  {"op": "test", "path": "/metadata/resourceVersion", "value": rv},
  {"op": "test", "path": state_path, "value": "ready"},
  data_op,
  {"op": "replace", "path": state_path, "value": "pending"},
]))' "$rv" "$data_exists" \
    | kc -n "$GFS_NS" patch secret "$secret" --type=json --patch-file=/dev/stdin 2>"$staging_err" >/dev/null; then
    rm -f "$staging_err"
    unset candidate
    return 0
  fi
  if [ -s "$staging_err" ]; then
    printf '[gfs-credential-secret] staging candidate on %s/%s failed: %s\n' \
      "$GFS_NS" "$secret" "$(cat "$staging_err")" >&2
  fi
  rm -f "$staging_err"
  unset candidate
  return 1
}

# The CAS patches lose races by design, but a non-CAS failure (RBAC, API
# server) must not read as contention: surface the captured error text so
# callers' "another operation won" diagnostics stay truthful.
candidate_patch_apply() {
  local op="$1" secret="$2" out
  if out="$(gfs_candidate_patch "$op" \
    | kc -n "$GFS_NS" patch secret "$secret" --type=json --patch-file=/dev/stdin 2>&1 >/dev/null)"; then
    return 0
  fi
  printf '[gfs-credential-secret] %s candidate patch on %s/%s failed: %s\n' \
    "$op" "$GFS_NS" "$secret" "$out" >&2
  return 1
}

claim_secret_candidate() {
  candidate_patch_apply claim "$1"
}

promote_secret_candidate() {
  candidate_patch_apply promote "$1"
}

clear_secret_candidate() {
  candidate_patch_apply rollback "$1"
}

release_abandoned_candidate() {
  candidate_patch_apply release "$1"
}

claim_secret_rollout() {
  local secret="$1" expected_rotated_at="$2" expected_state="$3"
  python3 -c 'import json, sys
state, stamp = sys.argv[1:]
print(json.dumps([
  {"op": "test", "path": "/metadata/annotations/clerum.io~1gfs-dsn-state", "value": state},
  {"op": "test", "path": "/metadata/annotations/clerum.io~1gfs-dsn-rotated-at", "value": stamp},
  {"op": "replace", "path": "/metadata/annotations/clerum.io~1gfs-dsn-state", "value": "rollout-running"},
]))' "$expected_state" "$expected_rotated_at" \
    | kc -n "$GFS_NS" patch secret "$secret" --type=json --patch-file=/dev/stdin >/dev/null
}

mark_secret_rollout_ready() {
  local secret="$1" expected_rotated_at="$2" expected_state="$3"
  local proof_kind proof_resource_version proof_template_revision proof_pod_count proof_at
  proof_kind="$GFS_ROLLOUT_PROOF_KIND"
  proof_resource_version="$GFS_ROLLOUT_PROOF_RESOURCE_VERSION"
  proof_template_revision="$GFS_ROLLOUT_PROOF_TEMPLATE_REVISION"
  proof_pod_count="$GFS_ROLLOUT_PROOF_POD_COUNT"
  proof_at="$GFS_ROLLOUT_PROOF_AT"
  python3 -c 'import json, sys
state, stamp, proof_kind, proof_resource_version, proof_template_revision, proof_pod_count, proof_at = sys.argv[1:]
ops = [
  {"op": "test", "path": "/metadata/annotations/clerum.io~1gfs-dsn-state", "value": state},
  {"op": "test", "path": "/metadata/annotations/clerum.io~1gfs-dsn-rotated-at", "value": stamp},
  {"op": "replace", "path": "/metadata/annotations/clerum.io~1gfs-dsn-state", "value": "ready"},
]
if proof_kind:
    if proof_resource_version:
        ops.insert(2, {"op": "test", "path": "/metadata/resourceVersion", "value": proof_resource_version})
    values = {
        "clerum.io/gfs-dsn-proof-kind": proof_kind,
        "clerum.io/gfs-dsn-proof-resource-version": proof_resource_version,
        "clerum.io/gfs-dsn-proof-template-revision": proof_template_revision,
        "clerum.io/gfs-dsn-proof-pod-count": proof_pod_count,
        "clerum.io/gfs-dsn-proof-at": proof_at,
    }
    for key, value in values.items():
        ops.append({"op": "add", "path": "/metadata/annotations/" + key.replace("/", "~1"), "value": value})
print(json.dumps(ops))' "$expected_state" "$expected_rotated_at" \
    "$proof_kind" "$proof_resource_version" "$proof_template_revision" "$proof_pod_count" "$proof_at" \
    | kc -n "$GFS_NS" patch secret "$secret" --type=json --patch-file=/dev/stdin >/dev/null
  GFS_ROLLOUT_PROOF_KIND=""
  GFS_ROLLOUT_PROOF_RESOURCE_VERSION=""
  GFS_ROLLOUT_PROOF_TEMPLATE_REVISION=""
  GFS_ROLLOUT_PROOF_POD_COUNT=""
  GFS_ROLLOUT_PROOF_AT=""
}
