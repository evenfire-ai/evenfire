#!/usr/bin/env bash
# Targeted GFSC rollout transitions after a credential is committed.
# shellcheck disable=SC2034

deployment_uses_secret() {
  local deployment="$1" secret="$2" refs error
  if ! refs="$(kc -n "$GFS_NS" get deployment "$deployment" -o \
    'jsonpath={range .spec.template.spec.containers[*].env[*]}{.valueFrom.secretKeyRef.name}{"\n"}{end}' 2>&1)"; then
    error="$refs"
    grep -qiE 'not ?found' <<<"$error" && return 1
    die "cannot inspect ${GFS_NS}/${deployment} Secret references"
  fi
  grep -Fxq "$secret" <<<"$refs"
}

deployment_exists() {
  local deployment="$1" error
  if error="$(kc -n "$GFS_NS" get deployment "$deployment" -o name 2>&1)"; then
    return 0
  fi
  grep -qiE 'not ?found' <<<"$error" && return 1
  die "cannot determine whether ${GFS_NS}/${deployment} exists"
}

credential_rollout_pending() {
  local deployment="$1" secret="$2" rotated rows
  # A failed annotation read must not masquerade as "never rotated": that
  # would silently skip a stale-pod rollout the rotation still requires.
  # stderr is captured separately so a success-path kubectl warning can never
  # pollute the timestamp the awk gate below compares against.
  local rotated_err_file rotated_err
  rotated_err_file="$(mktemp)"
  if ! rotated="$(gfs_secret_rotated_at "$secret" 2>"$rotated_err_file")"; then
    rotated_err="$(cat "$rotated_err_file")"
    rm -f "$rotated_err_file"
    die "cannot read ${GFS_NS}/${secret} rotation annotation: ${rotated_err}"
  fi
  rm -f "$rotated_err_file"
  [ -n "$rotated" ] || return 1
  if ! rows="$(kc -n "$GFS_NS" get pods -l 'app=gfs-controller' -o \
    'jsonpath={range .items[*]}{.metadata.ownerReferences[0].name}{"|"}{.metadata.creationTimestamp}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"|"}{.metadata.deletionTimestamp}{"\n"}{end}' 2>&1)"; then
    die "cannot list ${GFS_NS} GFS controller pods"
  fi
  printf '%s\n' "$rows" | awk -F'|' -v prefix="${deployment}-" -v rotated="$rotated" \
    '$1 ~ "^" prefix && $4 == "" { seen=1; if ($2 < rotated || $3 != "True") found=1 } END { exit !(found || !seen) }'
}

credential_rollout_required() {
  local deployment="$1" secret="$2" state="$3"
  case "$state" in
    rollout-pending|rollout-running)
      # A pre-overlay retry must not restart an old template and mark the
      # lifecycle ready before HCC has wired the dedicated Secret.
      deployment_uses_secret "$deployment" "$secret"
      ;;
    *)
      credential_rollout_pending "$deployment" "$secret"
      ;;
  esac
}

credential_adoption_timestamp() {
  local deployment="$1" selector="$2" expected_dsn="$3" rows live oldest="" pod created ready
  if ! deployment_exists "$deployment"; then
    GFS_ROLLOUT_PROOF_KIND='deployment-absent'
    GFS_ROLLOUT_PROOF_RESOURCE_VERSION=""
    GFS_ROLLOUT_PROOF_TEMPLATE_REVISION='future-pod'
    GFS_ROLLOUT_PROOF_POD_COUNT=0
    GFS_ROLLOUT_PROOF_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    date -u '+%Y-%m-%dT%H:%M:%SZ'
    return 0
  fi
  rows="$(kc -n "$GFS_NS" get pods -l "$selector" -o \
    'jsonpath={range .items[*]}{.metadata.name}{"|"}{.metadata.creationTimestamp}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"|"}{.metadata.deletionTimestamp}{"\n"}{end}')" \
    || die "cannot inspect ${deployment} pods for legacy credential adoption"
  live="$(printf '%s\n' "$rows" | awk -F'|' 'NF >= 3 && $4 == "" {print}')"
  [ -n "$live" ] || die "cannot adopt legacy credential without a live ${deployment} pod"
  while IFS='|' read -r pod created ready _deleting; do
    [ "$ready" = True ] || die "cannot adopt legacy credential while ${pod} is not Ready"
    printf '%s' "$expected_dsn" | kc -n "$GFS_NS" exec -i "$pod" -- node -e '
let input=""; process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => process.exit(input === process.env.GFS_PG_CONNECTION_STRING ? 0 : 1));' \
      >/dev/null 2>&1 || die "${pod} does not consume the legacy writer credential being adopted"
    [ -z "$oldest" ] || [ "$created" ">" "$oldest" ] || oldest="$created"
    [ -n "$oldest" ] || oldest="$created"
  done <<<"$live"
  printf '%s' "$oldest"
}

rollout_exact() {
  local deployment="$1"
  kc -n "$GFS_NS" rollout restart "deployment/${deployment}" >/dev/null
  kc -n "$GFS_NS" rollout status "deployment/${deployment}" --timeout="$ROLLOUT_TIMEOUT"
}

credential_rollout_proof() {
  local secret="$1" deployment="$2" rotated_at="$3"
  local secret_json secret_rv active_dsn template_revision generation observed_revision
  local selector rows pod_name pod_created pod_ready pod_deleting pod_owner
  local owner_revision owner_revision_status
  local pod_count=0 current_rv
  if ! deployment_uses_secret "$deployment" "$secret"; then
    die "$GFS_NS/$deployment does not reference $GFS_NS/$secret; refusing to certify credential consumption"
  fi
  if ! secret_json="$(kc -n "$GFS_NS" get secret "$secret" -o json)"; then
    die "cannot snapshot $GFS_NS/$secret for rollout proof"
  fi
  if ! IFS=$'\t' read -r secret_rv active_dsn < <(printf '%s' "$secret_json" | python3 -c 'import base64, json, sys
obj = json.load(sys.stdin)
metadata = obj.get("metadata") or {}
encoded = (obj.get("data") or {}).get("connection-string") or ""
if not encoded:
    raise SystemExit(1)
try:
    dsn = base64.b64decode(encoded, validate=True).decode()
except (ValueError, UnicodeDecodeError):
    raise SystemExit(1)
print(str(metadata.get("resourceVersion", "")) + "\t" + dsn)'); then
    die "cannot decode the committed $GFS_NS/$secret credential for rollout proof"
  fi
  [ -n "$secret_rv" ] || die "the $GFS_NS/$secret rollout proof has no resourceVersion"
  # The standard Deployment revision is the portable template identity. A
  # custom annotation is not guaranteed to be copied to Pods by Kubernetes or
  # by HCC's reconciler, so it cannot be the sole rollout proof.
  template_revision="$(kc -n "$GFS_NS" get deployment "$deployment" \
    -o 'jsonpath={.metadata.annotations.deployment\.kubernetes\.io/revision}' 2>/dev/null || true)"
  generation="$(kc -n "$GFS_NS" get deployment "$deployment" \
    -o 'jsonpath={.metadata.generation}' 2>/dev/null || true)"
  observed_revision="$(kc -n "$GFS_NS" get deployment "$deployment" \
    -o 'jsonpath={.status.observedGeneration}' 2>/dev/null || true)"
  if [[ ! "$generation" =~ ^[1-9][0-9]*$ ]] ||
     [[ ! "$observed_revision" =~ ^[1-9][0-9]*$ ]] ||
     [ "$generation" != "$observed_revision" ]; then
    die "$GFS_NS/$deployment generation is not observed; refusing a pre-rollout credential proof"
  fi
  [ -n "$template_revision" ] ||
    die "$GFS_NS/$deployment has no observed Deployment revision; refusing an unverifiable credential proof"
  case "$deployment" in
    gfsc-reader) selector='app=gfs-controller,clerum.io/gfsc-role=reader' ;;
    gfsc-writer) selector='app=gfs-controller,clerum.io/gfsc-role=writer' ;;
    *) die "unsupported GFSC deployment for credential proof: $deployment" ;;
  esac
  if ! rows="$(kc -n "$GFS_NS" get pods -l "$selector" -o \
    'jsonpath={range .items[*]}{.metadata.name}{"|"}{.metadata.creationTimestamp}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"|"}{.metadata.deletionTimestamp}{"|"}{.metadata.ownerReferences[0].name}{"\n"}{end}')"; then
    die "cannot list $GFS_NS/$deployment pods for credential proof"
  fi
  while IFS='|' read -r pod_name pod_created pod_ready pod_deleting pod_owner; do
    [ -n "$pod_name" ] || continue
    [ -z "$pod_deleting" ] || continue
    if ! python3 - "$pod_created" "$rotated_at" <<'PY'
from datetime import datetime, timezone
import sys
created, rotated = sys.argv[1:]
def parse(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
try:
    ok = parse(created) >= parse(rotated)
except ValueError:
    ok = False
raise SystemExit(0 if ok else 1)
PY
    then
      die "$GFS_NS/$deployment Ready pod predates the committed credential rotation"
    fi
    [ "$pod_ready" = True ] || die "$GFS_NS/$deployment has a live pod that is not Ready"
    [ -n "$pod_owner" ] || die "$GFS_NS/$deployment Ready pod has no owning ReplicaSet"
    owner_revision_status=0
    owner_revision="$(kc -n "$GFS_NS" get rs "$pod_owner" \
      -o 'jsonpath={.metadata.annotations.deployment\.kubernetes\.io/revision}' 2>/dev/null)" || owner_revision_status=$?
    if [ "$owner_revision_status" -ne 0 ] || [ -z "$owner_revision" ]; then
      die "$GFS_NS/$deployment Ready pod owner ReplicaSet could not be verified"
    fi
    [ "$owner_revision" = "$template_revision" ] ||
      die "$GFS_NS/$deployment Ready pod is not on the observed template revision"
    if ! printf '%s' "$active_dsn" |
      kc -n "$GFS_NS" exec -i "$pod_name" -c gfsc -- node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => process.exit(input === process.env.GFS_PG_CONNECTION_STRING ? 0 : 1));' \
      >/dev/null 2>&1; then
      die "$GFS_NS/$deployment Ready pod did not consume the committed credential"
    fi
    pod_count=$((pod_count + 1))
  done <<<"$rows"
  [ "$pod_count" -gt 0 ] || die "no live $GFS_NS/$deployment pod exists for credential proof"
  current_rv="$(kc -n "$GFS_NS" get secret "$secret" -o \
    'jsonpath={.metadata.resourceVersion}' 2>/dev/null || true)"
  [ "$current_rv" = "$secret_rv" ] ||
    die "$GFS_NS/$secret changed during rollout proof; refusing stale readiness"
  GFS_ROLLOUT_PROOF_KIND='pod-env'
  GFS_ROLLOUT_PROOF_RESOURCE_VERSION="$secret_rv"
  GFS_ROLLOUT_PROOF_TEMPLATE_REVISION="$template_revision"
  GFS_ROLLOUT_PROOF_POD_COUNT="$pod_count"
  GFS_ROLLOUT_PROOF_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

complete_rollout() {
  local secret="$1" deployment="$2" rotated state rc
  rotated="$(gfs_secret_rotated_at "$secret")"
  state="$(gfs_secret_state "$secret")"
  case "$state" in
    rollout-pending|ready)
      claim_secret_rollout "$secret" "$rotated" "$state" \
        || die "credential rollout state was superseded before ${deployment} could claim it"
      ;;
    rollout-running)
      [ "${GFS_RECOVER_ABANDONED_STATE:-false}" = true ] \
        || die "${deployment} rollout is already claimed; confirm the prior process ended, then retry with GFS_RECOVER_ABANDONED_STATE=true"
      log "Recovering an explicitly confirmed interrupted ${deployment} rollout"
      ;;
    *) die "cannot rollout ${deployment} from credential state ${state}" ;;
  esac
  if ! deployment_exists "$deployment"; then
    log "${GFS_NS}/${deployment} is not present; credential is staged for its future pod"
    GFS_ROLLOUT_PROOF_KIND='deployment-absent'
    GFS_ROLLOUT_PROOF_RESOURCE_VERSION=""
    GFS_ROLLOUT_PROOF_TEMPLATE_REVISION='future-pod'
    GFS_ROLLOUT_PROOF_POD_COUNT=0
    GFS_ROLLOUT_PROOF_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    mark_secret_rollout_ready "$secret" "$rotated" rollout-running \
      || die "staged credential state was superseded; refusing a stale completion"
    return 0
  fi
  if rollout_exact "$deployment"; then
    credential_rollout_proof "$secret" "$deployment" "$rotated"
    mark_secret_rollout_ready "$secret" "$rotated" rollout-running \
      || die "${deployment} rolled out but credential state was superseded; refusing a stale completion"
    return 0
  else rc=$?
  fi
  return "$rc"
}
