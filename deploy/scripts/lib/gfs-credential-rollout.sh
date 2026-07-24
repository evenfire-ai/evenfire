#!/usr/bin/env bash
# Targeted GFSC rollout transitions after a credential is committed.

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
    mark_secret_rollout_ready "$secret" "$rotated" rollout-running \
      || die "staged credential state was superseded; refusing a stale completion"
    return 0
  fi
  if rollout_exact "$deployment"; then
    mark_secret_rollout_ready "$secret" "$rotated" rollout-running \
      || die "${deployment} rolled out but credential state was superseded; refusing a stale completion"
    return 0
  else rc=$?
  fi
  return "$rc"
}
