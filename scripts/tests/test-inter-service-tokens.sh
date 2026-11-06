#!/usr/bin/env bash
set -euo pipefail

# Tests for deploy/scripts/apply-inter-service-tokens.sh and
# deploy/scripts/apply-workflow-approval-bot-secret.sh against a fake kubectl
# that keeps Secrets ($KUBE_STORE/<ns>/<secret>/<key>) and Deployments
# ($KUBE_STORE/_deploy/<ns>/<name>/, with labels and annotations) in a
# directory store. Merge patches, annotations and restarts persist across runs,
# so a later run sees what an earlier run did, as in a cluster. Failures can be
# injected per object, persistent (every attempt) or transient (first attempt).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="${TMPDIR:-/tmp}/inter-service-tokens-test.$$"
mkdir -p "$TMP/bin"
# On an unexpected exit (a script crash under `set -e`), show the last run's
# output before the store is removed.
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "--- last run stdout/stderr (exit $rc) ---" >&2
    cat "$TMP/stdout" "$TMP/stderr" >&2 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap on_exit EXIT

# Runs must not inherit overrides from the caller's environment.
unset FORCE_CONSUMER_RESTART CONTROL_API_INTERNAL_TOKEN_EXT_REST CONTROL_API_INTERNAL_TOKEN_RPC \
  CONTROL_API_INTERNAL_TOKEN_WEBHOOK_PROXY CONTROL_API_INTERNAL_TOKEN_WA_READER \
  CONTROL_API_INTERNAL_TOKEN_CODEX_LLM_PROXY CONTROL_API_INTERNAL_TOKEN_GROK_LLM_PROXY \
  CHANNEL_READER_HANDOFF_TOKEN CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET \
  WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET CONTEXT \
  TOKEN_STAMP_ATTEMPTS TOKEN_STAMP_RETRY_SECONDS

TOKENS_SCRIPT="$ROOT/deploy/scripts/apply-inter-service-tokens.sh"
BOT_SECRET_SCRIPT="$ROOT/deploy/scripts/apply-workflow-approval-bot-secret.sh"
TOKEN_STAMP_KEY="clerum.io/inter-service-tokens-sha256"
BOT_STAMP_KEY="clerum.io/workflow-approval-bot-secret-sha256"

HCC_OLD="aa11bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900"
HCC_NEW="ff00ee11dd22cc33bb44aa5566778899ff00ee11dd22cc33bb44aa5566778899"
WRC_OLD="1111111111111111111111111111111111111111111111111111111111111111"
WRC_NEW="2222222222222222222222222222222222222222222222222222222222222222"
ROTATED="3333333333333333333333333333333333333333333333333333333333333333"
MEMBER_HMAC="test-member-registration-hmac"

# Consumers as <ns>/<deployment>; the last two are HCC-built per-Host
# channel-readers (label app=channel-reader). The first nine are the fixed
# consumers.
ALL_TOKEN_CONSUMERS=(
  control-plane/control-api
  control-plane/codex-llm-proxy
  control-plane/grok-llm-proxy
  control-plane/workflow-recipes
  control-plane/host-context-controller
  profiles/external-rest-api
  rpc-proxy/rpc-proxy
  webhook-ingress/webhook-proxy
  channels/clerum-workflow-approval-request-reader
  channels/channel-reader-stubhost
  channels/channel-reader-stubhost-b
)
TOKEN_SECRETS=(
  control-plane/control-api-internal-tokens
  control-plane/internal-control-jwt-secrets
  control-plane/codex-llm-proxy-secrets
  control-plane/grok-llm-proxy-secrets
  profiles/external-rest-api-secrets
  rpc-proxy/rpc-proxy-secrets
  webhook-ingress/webhook-proxy-secrets
  channels/workflow-approval-request-reader-credentials
)

cat > "$TMP/bin/openssl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "rand" && "${2:-}" == "-hex" ]]; then
  count_file="${OPENSSL_RAND_COUNT_FILE:?}"
  count=0
  if [[ -s "$count_file" ]]; then
    count="$(cat "$count_file")"
  fi
  count=$((count + 1))
  printf '%s' "$count" > "$count_file"
  # Offset by a per-run salt so two runs never generate the same value.
  printf '%064x\n' "$(( ${OPENSSL_RAND_SALT:-0} * 1000 + count ))"
  exit 0
fi
if [[ "${1:-}" == "dgst" && "${2:-}" == "-sha256" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    digest="$(sha256sum | awk '{print $1}')"
  else
    digest="$(shasum -a 256 | awk '{print $1}')"
  fi
  printf 'SHA2-256(stdin)= %s\n' "$digest"
  exit 0
fi
echo "unexpected openssl invocation: $*" >&2
exit 1
SH

cat > "$TMP/bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
store="${KUBE_STORE:?}"
dstore="$store/_deploy"
args=("$@")
# Every call must name the context the script was given, never the current one.
if [[ "${args[0]:-}" != "--context" || "${args[1]:-}" != "${CONTEXT:?}" ]]; then
  echo "fake kubectl: expected --context ${CONTEXT}, got: $*" >&2
  exit 9
fi
args=("${args[@]:2}")
ns=""
if [[ "${args[0]:-}" == "-n" ]]; then
  ns="${args[1]}"
  args=("${args[@]:2}")
fi
has_arg() {
  local a
  for a in "${args[@]}"; do [[ "$a" == "$1" ]] && return 0; done
  return 1
}
# Injected failures: KUBE_<OP>_FAIL (GET_DEPLOY, PATCH, ANNOTATE, STAMP_WRITE,
# ROLLOUT, SECRET_READ) lists "<ns>/<name>" that always fail;
# KUBE_FLAKY lists "<op>:<ns>/<name>" that fail on their first attempt only;
# KUBE_SECRET_READ_FLAKE lists "<ns>/<secret>/<key>#<n>" Secret reads that fail
# on their n-th call.
inject() {
  local op="$1" target="$2" persistent="$3" marker
  if [[ " $persistent " == *" $target "* ]]; then
    echo "fake kubectl: injected $op failure for $target" >&2
    exit 1
  fi
  if [[ " ${KUBE_FLAKY:-} " == *" $op:$target "* ]]; then
    marker="${FLAKY_STATE:?}/$op-${target//\//_}"
    if [[ ! -e "$marker" ]]; then
      : > "$marker"
      echo "fake kubectl: transient $op failure for $target" >&2
      exit 1
    fi
  fi
}
annotation_file() { printf '%s/%s/%s/annotations/%s' "$dstore" "$ns" "$1" "${2//\//__}"; }
case "${args[0]:-}" in
  get)
    case "${args[1]:-}" in
      ns) exit 0 ;;
      secret)
        name="${args[2]:?}"
        output=""
        for ((i=0; i<${#args[@]}; i++)); do
          if [[ "${args[$i]}" == "-o" ]]; then
            output="${args[$((i+1))]:-}"
          fi
        done
        # Secret reads (-o jsonpath) are logged as <ns>/<secret>/<key>, one line
        # per call. KUBE_SECRET_READ_FAIL lists "<ns>/<secret>" whose reads always
        # fail; KUBE_SECRET_READ_FLAKE lists "<ns>/<secret>/<key>#<n>": the n-th read
        # of that key in this run fails. Both are API errors, not NotFound. Each
        # injected failure is recorded as "<ns>/<secret>/<key>#<n>" in
        # $SECRET_READ_LOG.injected, so a test can witness it whatever the
        # script does with kubectl's stderr.
        if [[ "$output" == jsonpath=* ]]; then
          read_key="${output#jsonpath=\{.data.}"
          read_key="${read_key%\}}"
          printf '%s\n' "$ns/$name/$read_key" >> "${SECRET_READ_LOG:?}"
          read_n="$(grep -cxF "$ns/$name/$read_key" "$SECRET_READ_LOG")"
          if [[ " ${KUBE_SECRET_READ_FAIL:-} " == *" $ns/$name "* \
                || " ${KUBE_SECRET_READ_FLAKE:-} " == *" $ns/$name/$read_key#$read_n "* ]]; then
            printf '%s\n' "$ns/$name/$read_key#$read_n" >> "$SECRET_READ_LOG.injected"
            echo "Error from server (InternalError): injected read failure for $ns/$name/$read_key (read $read_n)" >&2
            exit 1
          fi
        fi
        if [[ ! -d "$store/$ns/$name" ]]; then
          has_arg --ignore-not-found && exit 0
          echo "Error from server (NotFound): secrets \"$name\" not found" >&2
          exit 1
        fi
        case "$output" in
          "") exit 0 ;;
          json) printf '%s\n' '{"data":{}}'; exit 0 ;;
          jsonpath=\{.data.*\})
            key="${output#jsonpath=\{.data.}"
            key="${key%\}}"
            if [[ -f "$store/$ns/$name/$key" ]]; then
              base64 < "$store/$ns/$name/$key" | tr -d '\n'
            fi
            exit 0
            ;;
        esac
        echo "fake kubectl: unsupported get secret output '$output'" >&2
        exit 2
        ;;
      deploy|deployment)
        if [[ "${args[2]:-}" == "-l" ]]; then
          label="${args[3]#app=}"
          inject get "$ns/app=$label" "${KUBE_GET_DEPLOY_FAIL:-}"
          # KUBE_LIST_FAIL_FROM=<n>: the label list fails from its n-th call on.
          if [[ -n "${KUBE_LIST_FAIL_FROM:-}" ]]; then
            list_calls=$(( $(cat "${FLAKY_STATE:?}/list-calls" 2>/dev/null || echo 0) + 1 ))
            printf '%s' "$list_calls" > "$FLAKY_STATE/list-calls"
            if (( list_calls >= KUBE_LIST_FAIL_FROM )); then
              echo "fake kubectl: injected list failure for $ns/app=$label" >&2
              exit 1
            fi
          fi
          for dir in "$dstore/$ns"/*/; do
            [[ -d "$dir" ]] || continue
            if [[ "$(cat "$dir/app" 2>/dev/null)" == "$label" ]]; then
              printf '%s\n' "$(basename "$dir")"
            fi
          done
          exit 0
        fi
        name="${args[2]:?}"
        inject get "$ns/$name" "${KUBE_GET_DEPLOY_FAIL:-}"
        if [[ ! -d "$dstore/$ns/$name" ]]; then
          has_arg --ignore-not-found && exit 0
          echo "Error from server (NotFound): deployments.apps \"$name\" not found" >&2
          exit 1
        fi
        output=""
        for ((i=0; i<${#args[@]}; i++)); do
          [[ "${args[$i]}" == "-o" ]] && output="${args[$((i+1))]:-}"
        done
        case "$output" in
          jsonpath=*metadata.annotations.*)
            key="${output##*metadata.annotations.}"
            key="${key%\}}"
            key="${key//\\./.}"
            stamp_file="$(annotation_file "$name" "$key")"
            printf '%s|%s' "$name" "$(cat "$stamp_file" 2>/dev/null || true)"
            ;;
          name) printf 'deployment.apps/%s\n' "$name" ;;
          *) echo "fake kubectl: unsupported get deploy output '$output'" >&2; exit 2 ;;
        esac
        exit 0
        ;;
    esac
    ;;
  create)
    if [[ "${args[1]:-}" == "secret" && "${args[2]:-}" == "generic" ]]; then
      mkdir -p "$store/$ns/${args[3]:?}"
    fi
    exit 0
    ;;
  patch)
    if [[ "${args[1]:-}" == "secret" ]]; then
      name="${args[2]:?}"
      # KUBE_CREATE_DEPLOY_ON_PATCH=<ns>/<deployment>: that Deployment is created
      # at the first Secret patch and loads the Secrets as they are then.
      if [[ -n "${KUBE_CREATE_DEPLOY_ON_PATCH:-}" && ! -d "$dstore/$KUBE_CREATE_DEPLOY_ON_PATCH" ]]; then
        mkdir -p "$dstore/$KUBE_CREATE_DEPLOY_ON_PATCH/annotations"
        fake-snapshot-loaded snapshot "$store" "$KUBE_CREATE_DEPLOY_ON_PATCH"
      fi
      inject patch "$ns/$name" "${KUBE_PATCH_FAIL:-}"
      patch=""
      merge=false
      for ((i=0; i<${#args[@]}; i++)); do
        case "${args[$i]}" in
          -p) patch="${args[$((i+1))]}" ;;
          --type=merge) merge=true ;;
        esac
      done
      if [[ "$merge" == "true" ]]; then
        [[ -d "$store/$ns/$name" ]] || { echo "fake kubectl: secret $ns/$name not found" >&2; exit 1; }
        while IFS=$'\t' read -r key value; do
          printf '%s' "$value" | base64 --decode > "$store/$ns/$name/$key"
        done < <(printf '%s' "$patch" | jq -r '.stringData | to_entries[] | "\(.key)\t\(.value | @base64)"')
        printf '%s/%s\n' "$ns" "$name" >> "${PATCH_LOG:?}"
        if [[ "$ns" == "control-plane" && "$name" == "control-api-internal-tokens" && -n "${CAPTURE_FILE:-}" ]]; then
          printf '%s' "$patch" > "$CAPTURE_FILE"
        fi
      fi
    fi
    exit 0
    ;;
  annotate)
    [[ "${args[1]:-}" == "deploy" ]] || { echo "fake kubectl: unsupported annotate ${args[*]}" >&2; exit 2; }
    name="${args[2]:?}"
    inject annotate "$ns/$name" "${KUBE_ANNOTATE_FAIL:-}"
    [[ -d "$dstore/$ns/$name" ]] || { echo "Error from server (NotFound): deployments.apps \"$name\" not found" >&2; exit 1; }
    has_arg --overwrite || { echo "fake kubectl: annotate without --overwrite" >&2; exit 2; }
    pair="${args[$((${#args[@]} - 1))]}"
    # KUBE_STAMP_WRITE_FAIL fails stamp writes only, never a restart-pending mark.
    [[ "${pair#*=}" == restart-pending ]] || inject stamp "$ns/$name" "${KUBE_STAMP_WRITE_FAIL:-}"
    mkdir -p "$dstore/$ns/$name/annotations"
    printf '%s' "${pair#*=}" > "$(annotation_file "$name" "${pair%%=*}")"
    printf '%s/%s %s\n' "$ns" "$name" "$pair" >> "${ANNOTATE_LOG:?}"
    exit 0
    ;;
  rollout)
    if [[ "${args[1]:-}" == "restart" && "${args[2]:-}" == "deploy" ]]; then
      name="${args[3]:?}"
      # KUBE_KILL_AT_ROLLOUT=<pidfile>: the first restart SIGKILLs the script
      # under test (a run that dies after the Secret patches).
      if [[ -n "${KUBE_KILL_AT_ROLLOUT:-}" ]]; then
        kill -KILL "$(cat "$KUBE_KILL_AT_ROLLOUT")"
        exit 1
      fi
      inject rollout "$ns/$name" "${KUBE_ROLLOUT_FAIL:-}"
      [[ -d "$dstore/$ns/$name" ]] || { echo "Error from server (NotFound): deployments.apps \"$name\" not found" >&2; exit 1; }
      fake-snapshot-loaded snapshot "$store" "$ns/$name"
      printf '%s/%s\n' "$ns" "$name" >> "${ROLLOUT_LOG:?}"
      exit 0
    fi
    echo "fake kubectl: unsupported rollout ${args[*]}" >&2
    exit 2
    ;;
  delete) exit 0 ;;
esac
echo "fake kubectl: unsupported ${args[*]}" >&2
exit 2
SH

cat > "$TMP/bin/fake-snapshot-loaded" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
# The Secret keys each consumer Deployment loads at startup, as
# "<ns>/<deployment> <secret-ns>/<secret>/<key>". Mirrors the stamp inputs of
# apply-inter-service-tokens.sh and apply-workflow-approval-bot-secret.sh.
# Per-Host channel-readers are every Deployment labelled app=channel-reader in
# the store. Argument: the store.
consumer_keys() {
  local store="$1" dir
  cat <<'KEYS'
control-plane/control-api control-plane/control-api-internal-tokens/CONTROL_API_INTERNAL_SERVICE_TOKENS
control-plane/control-api control-plane/control-api-internal-tokens/CONTROL_API_INTERNAL_TOKENS
control-plane/control-api control-plane/control-api-internal-tokens/CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET
control-plane/control-api control-plane/internal-control-jwt-secrets/INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET
control-plane/control-api control-plane/internal-control-jwt-secrets/INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET
control-plane/codex-llm-proxy control-plane/codex-llm-proxy-secrets/CODEX_LLM_PROXY_CONTROL_API_TOKEN
control-plane/grok-llm-proxy control-plane/grok-llm-proxy-secrets/GROK_LLM_PROXY_CONTROL_API_TOKEN
control-plane/workflow-recipes control-plane/internal-control-jwt-secrets/INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET
control-plane/host-context-controller control-plane/internal-control-jwt-secrets/INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET
profiles/external-rest-api profiles/external-rest-api-secrets/EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN
rpc-proxy/rpc-proxy rpc-proxy/rpc-proxy-secrets/RPC_PROXY_CONTROL_API_SERVICE_TOKEN
webhook-ingress/webhook-proxy webhook-ingress/webhook-proxy-secrets/WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN
channels/clerum-workflow-approval-request-reader channels/workflow-approval-request-reader-credentials/control-api-token
channels/clerum-workflow-approval-request-reader channels/workflow-approval-request-reader-credentials/channel-reader-handoff-token
channels/clerum-workflow-approval-request-reader channels/workflow-approval-request-reader-credentials/telegram-webhook-secret
KEYS
  for dir in "$store/_deploy/channels"/*/; do
    [[ "$(cat "$dir/app" 2>/dev/null)" == channel-reader ]] || continue
    printf 'channels/%s channels/workflow-approval-request-reader-credentials/channel-reader-handoff-token\n' "$(basename "$dir")"
  done
}
case "${1:?mode}" in
  list) consumer_keys "${2:?store}" ;;
  snapshot)
    store="${2:?store}" consumer="${3:?consumer}"
    dir="$store/_deploy/$consumer/loaded"
    rm -rf "$dir"
    mkdir -p "$dir"
    consumer_keys "$store" | while read -r owner src; do
      [[ "$owner" == "$consumer" ]] || continue
      if [[ -f "$store/$src" ]]; then cp "$store/$src" "$dir/${src//\//__}"; fi
    done
    ;;
  # settled <store> <consumer> <annotation>: exits 0 when the Deployment exists,
  # its pods run the current value of every key it reads, and it carries a
  # sha256 stamp under <annotation>.
  settled)
    store="${2:?store}" consumer="${3:?consumer}" annotation="${4:?annotation}"
    [[ -d "$store/_deploy/$consumer" ]] || exit 1
    stamp_file="$store/_deploy/$consumer/annotations/${annotation//\//__}"
    [[ -f "$stamp_file" ]] || exit 1
    [[ "$(cat "$stamp_file")" =~ ^[0-9a-f]{64}$ ]] || exit 1
    keys=0
    while read -r owner src; do
      [[ "$owner" == "$consumer" ]] || continue
      keys=$((keys + 1))
      loaded="$store/_deploy/$consumer/loaded/${src//\//__}"
      if [[ -f "$store/$src" ]]; then
        cmp -s "$store/$src" "$loaded" || exit 1
      else
        [[ ! -e "$loaded" ]] || exit 1
      fi
    done < <(consumer_keys "$store")
    [[ "$keys" -gt 0 ]] || { echo "fake-snapshot-loaded: $consumer reads no key" >&2; exit 2; }
    exit 0
    ;;
  # inputs <store> <consumer>: sha256 of the current values of the keys the
  # consumer reads, in consumer_keys order (an absent key counts as "-").
  inputs)
    store="${2:?store}" consumer="${3:?consumer}"
    consumer_keys "$store" | while read -r owner src; do
      [[ "$owner" == "$consumer" ]] || continue
      if [[ -f "$store/$src" ]]; then cat "$store/$src"; else printf -- '-'; fi
      printf '\n'
    done | "$(dirname "$0")/openssl" dgst -sha256 | awk '{print $NF}'
    ;;
  *) echo "fake-snapshot-loaded: unknown mode $1" >&2; exit 2 ;;
esac
SH

chmod +x "$TMP/bin/openssl" "$TMP/bin/kubectl" "$TMP/bin/fake-snapshot-loaded"

mkdir -p "$TMP/sibling/scripts/minikube"
printf '%s\n' 'DEV_HMAC_SECRET="dev-member-registration-hmac-secret"' \
  > "$TMP/sibling/scripts/minikube/deploy-evenfire-member-registration.sh"

fail() {
  echo "FAIL: $*" >&2
  echo "--- stderr of the last run ---" >&2
  cat "$TMP/stderr" >&2 || true
  exit 1
}

# An empty cluster: no Secrets, no Deployments.
new_store() {
  rm -rf "$TMP/store" "$TMP/flaky"
  mkdir -p "$TMP/store" "$TMP/flaky"
}

# An empty cluster with every consumer Deployment deployed (no stamps yet).
new_cluster() {
  local consumer
  new_store
  for consumer in "${ALL_TOKEN_CONSUMERS[@]}"; do
    mkdir -p "$TMP/store/_deploy/$consumer/annotations"
  done
  printf 'channel-reader' > "$TMP/store/_deploy/channels/channel-reader-stubhost/app"
  printf 'channel-reader' > "$TMP/store/_deploy/channels/channel-reader-stubhost-b/app"
  for consumer in "${ALL_TOKEN_CONSUMERS[@]}"; do pod_restart "$consumer"; done
}

store_set() {
  local ns="$1" secret="$2" key="$3" value="$4"
  mkdir -p "$TMP/store/$ns/$secret"
  printf '%s' "$value" > "$TMP/store/$ns/$secret/$key"
}

store_get() {
  cat "$TMP/store/$1/$2/$3"
}

store_delete() {
  rm -f "$TMP/store/$1/$2/$3"
}

# stamp_of <ns>/<deployment> [annotation] — prints the stored stamp, if any.
stamp_of() {
  local key="${2:-$TOKEN_STAMP_KEY}"
  cat "$TMP/store/_deploy/$1/annotations/${key//\//__}" 2>/dev/null || true
}

# A pod of <ns>/<deployment> starts outside the scripts (Deployment created,
# eviction, HPA, node drain) and loads its Secrets as they are now.
pod_restart() {
  "$TMP/bin/fake-snapshot-loaded" snapshot "$TMP/store" "$1"
}

# Model-independent oracle: every deployed consumer runs exactly the values its
# Secrets hold now (loaded at creation or at its last restart). A key absent
# from the Secret must be absent from what the pod loaded.
assert_loaded_matches_secrets() {
  local consumer src loaded pairs checked=0
  pairs="$("$TMP/bin/fake-snapshot-loaded" list "$TMP/store")"
  while read -r consumer src; do
    [[ -d "$TMP/store/_deploy/$consumer" ]] || continue
    loaded="$TMP/store/_deploy/$consumer/loaded/${src//\//__}"
    if [[ -f "$TMP/store/$src" ]]; then
      cmp -s "$TMP/store/$src" "$loaded" || fail "$consumer does not run the current value of $src"
    else
      [[ ! -e "$loaded" ]] || fail "$consumer runs a value of $src that its Secret no longer holds"
    fi
    checked=$((checked + 1))
  done <<<"$pairs"
  [[ "$checked" -gt 0 ]] || fail "the loaded oracle checked no consumer"
}

unstamp() {
  local key="${2:-$TOKEN_STAMP_KEY}"
  rm -f "$TMP/store/_deploy/$1/annotations/${key//\//__}"
}

RUN_SALT=0
RUN_STAMP_KEY=""

# Records, for every deployed consumer, whether it is settled (it runs its
# Secrets' current values and carries a sha256 stamp under RUN_STAMP_KEY), the
# digest of the values it reads, and its stamp; assert_no_extra_restart compares
# them after the run.
record_settled_before() {
  local consumer consumers settled digest
  : > "$TMP/settled-before"
  consumers="$("$TMP/bin/fake-snapshot-loaded" list "$TMP/store" | awk '{print $1}' | sort -u)" \
    || fail "cannot list the consumers for the extra-restart check"
  [[ -n "$consumers" ]] || fail "the extra-restart check found no consumer"
  while read -r consumer; do
    [[ -d "$TMP/store/_deploy/$consumer" ]] || continue
    settled=no
    if "$TMP/bin/fake-snapshot-loaded" settled "$TMP/store" "$consumer" "$RUN_STAMP_KEY"; then
      settled=yes
    fi
    digest="$("$TMP/bin/fake-snapshot-loaded" inputs "$TMP/store" "$consumer")" \
      || fail "cannot digest the inputs of $consumer"
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fail "empty or malformed input digest for $consumer"
    printf '%s %s %s %s\n' "$consumer" "$settled" "$digest" \
      "$(stamp_of "$consumer" "$RUN_STAMP_KEY")" >> "$TMP/settled-before"
  done <<<"$consumers"
}

# A settled consumer (running its Secrets' current values, stamped by this
# script) whose inputs did not change and whose stamp is unchanged after the run
# was restarted for nothing. This check does not use the expected-restart lists.
assert_no_extra_restart() {
  local rollout="$1" consumer settled digest stamp checked=0
  while read -r consumer settled digest stamp; do
    [[ "$settled" == yes ]] || continue
    [[ "$("$TMP/bin/fake-snapshot-loaded" inputs "$TMP/store" "$consumer")" == "$digest" ]] || continue
    [[ "$(stamp_of "$consumer" "$RUN_STAMP_KEY")" == "$stamp" ]] || continue
    checked=$((checked + 1))
    printf '%s\n' "$consumer" >> "$TMP/settled-checked-list"
    if grep -qxF "$consumer" "$rollout"; then
      fail "$consumer was restarted although it was settled and nothing it reads changed"
    fi
  done < "$TMP/settled-before"
  printf '%s' "$checked" > "$TMP/settled-checked"
}

# The extra-restart check runs after every run except FORCE_CONSUMER_RESTART=true,
# the one designed restart of settled consumers.
check_extra_restarts_after_run() {
  local rollout="$1"
  shift
  if [[ " $* " == *" FORCE_CONSUMER_RESTART=true "* ]]; then
    printf 'forced' > "$TMP/settled-checked"
    return 0
  fi
  assert_no_extra_restart "$rollout"
}

# run_script <script> <rollout-log> [capture-file] -- env [VAR=value | -u VAR]...
run_script() {
  local script="$1" rollout="$2" capture="$3" rc=0
  shift 3
  case "$script" in
    "$TOKENS_SCRIPT") RUN_STAMP_KEY="$TOKEN_STAMP_KEY" ;;
    "$BOT_SECRET_SCRIPT") RUN_STAMP_KEY="$BOT_STAMP_KEY" ;;
    *) fail "run_script: unknown script $script" ;;
  esac
  RUN_SALT=$((RUN_SALT + 1))
  : > "$rollout"
  : > "$TMP/patches.log"
  : > "$TMP/annotations.log"
  : > "$TMP/openssl-rand-count"
  : > "$TMP/secret-reads.log"
  : > "$TMP/secret-reads.log.injected"
  : > "$TMP/settled-checked"
  : > "$TMP/settled-checked-list"
  record_settled_before
  CAPTURE_FILE="$capture" ROLLOUT_LOG="$rollout" PATCH_LOG="$TMP/patches.log" \
    ANNOTATE_LOG="$TMP/annotations.log" FLAKY_STATE="$TMP/flaky" \
    SECRET_READ_LOG="$TMP/secret-reads.log" \
    KUBE_STORE="$TMP/store" PATH="$TMP/bin:$PATH" TOKEN_STAMP_RETRY_SECONDS=0 \
    OPENSSL_RAND_COUNT_FILE="$TMP/openssl-rand-count" OPENSSL_RAND_SALT="$RUN_SALT" \
    CLERUM_PROJECT_DIR="$TMP/sibling" "$@" \
    bash "$script" >"$TMP/stdout" 2>"$TMP/stderr" </dev/null || rc=$?
  assert_no_secret_material
  check_extra_restarts_after_run "$rollout" "$@"
  return "$rc"
}

# run_tokens <context> <rollout-log> [capture-file] env ...
run_tokens() {
  local context="$1" rollout="$2" capture="$3"
  shift 3
  run_script "$TOKENS_SCRIPT" "$rollout" "$capture" "$@" CONTEXT="$context"
}

run_bot_secret() {
  local rollout="$1"
  shift
  run_script "$BOT_SECRET_SCRIPT" "$rollout" "" "$@" CONTEXT=gke-dev
}

# Exits 0 when the file holds secret material: a hex run of 16 or more
# characters (every token and stamp in these tests is hex, so this also catches
# a prefix), the base64 of a run of zeros (every fake `openssl rand` token starts
# with more than 40 zeros), a fixture string, or the base64 form of a fixture.
has_secret_material() {
  grep -qE '[0-9a-f]{16,}|(MDAw){10}|member-registration-hmac|stale-|replace-with-|retired' "$1" \
    || grep -qF -f "$TMP/leak-base64.txt" "$1"
}

assert_no_secret_material() {
  local log
  for log in "$TMP/stdout" "$TMP/stderr"; do
    if has_secret_material "$log"; then
      echo "secret material leaked into $log" >&2
      cat "$log" >&2
      exit 1
    fi
  done
}

# The first 40 base64 characters of each fixture (40 also matches a wrapped
# base64 line).
for fixture in "$HCC_OLD" "$HCC_NEW" "$WRC_OLD" "$WRC_NEW" "$ROTATED" "$MEMBER_HMAC" \
               dev-member-registration-hmac-secret rotated-member-registration-hmac; do
  printf '%s' "$fixture" | base64 | tr -d '\n' | cut -c1-40
done > "$TMP/leak-base64.txt"
[[ "$(wc -l < "$TMP/leak-base64.txt" | tr -d ' ')" == "8" ]] || { echo "FAIL: leak-base64.txt is incomplete" >&2; exit 1; }
# Liveness of the patterns: they must match the base64 of a fixture and of a
# fake `openssl rand` token.
printf '%s' "$HCC_OLD" | base64 > "$TMP/leak-self-check"
has_secret_material "$TMP/leak-self-check" || { echo "FAIL: leak check misses the base64 of a fixture" >&2; exit 1; }
printf '%064x' 1001 | base64 > "$TMP/leak-self-check"
grep -qE '(MDAw){10}' "$TMP/leak-self-check" || { echo "FAIL: leak check misses the base64 of a generated token" >&2; exit 1; }

# assert_restarted_exactly <rollout-log> [<ns>/<deployment>]...
assert_restarted_exactly() {
  local rollout="$1"
  shift
  local expected actual
  expected="$(printf '%s\n' "$@" | sed '/^$/d' | sort)"
  actual="$(sort "$rollout")"
  if [[ "$expected" != "$actual" ]]; then
    fail "restarted consumers differ
expected:
${expected:-<none>}
actual:
${actual:-<none>}"
  fi
}

# Every consumer carries the stamp this run wrote or confirmed.
assert_all_stamped() {
  local consumer
  for consumer in "${ALL_TOKEN_CONSUMERS[@]}"; do
    [[ "$(stamp_of "$consumer")" =~ ^[0-9a-f]{64}$ ]] || fail "$consumer has no token stamp"
  done
}

# Liveness witness for a run that restarted nothing: the script reached the
# end, patched every Secret it owns, and logged one skip line per consumer.
assert_noop_witness() {
  local consumer secret
  grep -q '\] Done\.$' "$TMP/stderr" || fail "script did not reach Done."
  for secret in "${TOKEN_SECRETS[@]}"; do
    grep -qx "$secret" "$TMP/patches.log" || fail "Secret $secret was not patched"
  done
  for consumer in "${ALL_TOKEN_CONSUMERS[@]}"; do
    grep -qF "Skipping rollout of ${consumer}: tokens unchanged" "$TMP/stderr" \
      || fail "missing skip line for $consumer"
  done
  [[ ! -s "$TMP/annotations.log" ]] || fail "a no-op run must not rewrite any stamp"
  assert_settled_checked "${#ALL_TOKEN_CONSUMERS[@]}"
}

# Liveness of the extra-restart check: it compared this many settled consumers.
assert_settled_checked() {
  [[ "$(cat "$TMP/settled-checked")" == "$1" ]] \
    || fail "the extra-restart check did not cover every consumer (checked $(cat "$TMP/settled-checked"), expected $1)"
}

# Liveness of the extra-restart check in a targeted case: it compared at least
# one consumer, and among them the one the case expects untouched.
assert_extra_restart_checked() {
  local consumer="$1" checked
  checked="$(cat "$TMP/settled-checked")"
  [[ "$checked" =~ ^[0-9]+$ && "$checked" -gt 0 ]] \
    || fail "the extra-restart check compared no consumer (settled-checked: ${checked:-<empty>})"
  grep -qxF "$consumer" "$TMP/settled-checked-list" \
    || fail "the extra-restart check did not compare $consumer"
}

# The fake injected a Secret-read failure for <ns>/<secret>/<key>#<n>. Read from
# the fake's own record, not from the script's output.
assert_read_injected() {
  grep -qxF "$1" "$TMP/secret-reads.log.injected" || fail "the Secret-read failure $1 was never injected"
}

# Digest of every Secret value in the store, to show a run changed none.
secrets_digest() {
  find "$TMP/store" -path "$TMP/store/_deploy" -prune -o -type f -print | LC_ALL=C sort \
    | while IFS= read -r file; do printf '%s\n' "${file#"$TMP"/store/}"; cat "$file"; printf '\n'; done \
    | "$TMP/bin/openssl" dgst -sha256 | awk '{print $NF}'
}

assert_openssl_rand_calls() {
  local expected="$1" actual
  actual="$(cat "$TMP/openssl-rand-count")"
  [[ "${actual:-0}" == "$expected" ]] || fail "expected $expected openssl rand calls, got ${actual:-0}"
}

# A run that left restarts pending: non-zero exit, before Done, naming each one
# with its restart command and the FORCE alternative.
assert_pending() {
  local item
  grep -q '\] Done\.$' "$TMP/stderr" && fail "a run with pending restarts must stop before Done."
  grep -qF 'restarts are pending' "$TMP/stderr" || fail "missing pending-restarts error"
  grep -qF 'the next run of this script restarts them automatically' "$TMP/stderr" \
    || fail "missing automatic-retry notice"
  grep -qF 'FORCE_CONSUMER_RESTART=true' "$TMP/stderr" || fail "missing FORCE recovery"
  local target command
  for item in "$@"; do
    target="${item#*/}"
    if [[ "$target" == *=* ]]; then
      command="kubectl --context gke-dev -n ${item%%/*} rollout restart deploy -l $target"
    else
      command="kubectl --context gke-dev -n ${item%%/*} rollout restart deploy $target"
    fi
    grep -qxF "[inter-service-tokens]   $command" "$TMP/stderr" \
      || grep -qxF "[workflow-approval-bot-secret]   $command" "$TMP/stderr" \
      || fail "missing restart command for $item"
  done
}

# A cluster as a pre-stamp deploy leaves it: every token written, every
# consumer running, no token stamp anywhere.
seed_unstamped() {
  local consumer
  new_cluster
  run_tokens gke-dev "$TMP/rollout-seed.log" "" env CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET="$MEMBER_HMAC" \
    || fail "seed run failed"
  for consumer in "${ALL_TOKEN_CONSUMERS[@]}"; do unstamp "$consumer"; done
}

# run_tokens_killable <rollout-log> env ... — like run_tokens on gke-dev, with
# the script's PID in $TMP/script.pid (exec keeps it) for KUBE_KILL_AT_ROLLOUT.
run_tokens_killable() {
  local rollout="$1" rc=0
  shift
  : > "$rollout"
  : > "$TMP/patches.log"
  : > "$TMP/annotations.log"
  : > "$TMP/openssl-rand-count"
  : > "$TMP/secret-reads.log"
  : > "$TMP/secret-reads.log.injected"
  : > "$TMP/settled-checked"
  : > "$TMP/settled-checked-list"
  RUN_SALT=$((RUN_SALT + 1))
  RUN_STAMP_KEY="$TOKEN_STAMP_KEY"
  record_settled_before
  CAPTURE_FILE="" ROLLOUT_LOG="$rollout" PATCH_LOG="$TMP/patches.log" \
    ANNOTATE_LOG="$TMP/annotations.log" FLAKY_STATE="$TMP/flaky" \
    SECRET_READ_LOG="$TMP/secret-reads.log" \
    KUBE_STORE="$TMP/store" PATH="$TMP/bin:$PATH" TOKEN_STAMP_RETRY_SECONDS=0 \
    OPENSSL_RAND_COUNT_FILE="$TMP/openssl-rand-count" OPENSSL_RAND_SALT="$RUN_SALT" \
    CLERUM_PROJECT_DIR="$TMP/sibling" "$@" CONTEXT=gke-dev KUBE_KILL_AT_ROLLOUT="$TMP/script.pid" \
    bash -c 'printf %s "$$" > "$1"; exec bash "$2"' _ "$TMP/script.pid" "$TOKENS_SCRIPT" \
    >"$TMP/stdout" 2>"$TMP/stderr" </dev/null || rc=$?
  assert_no_secret_material
  check_extra_restarts_after_run "$rollout" "$@"
  return "$rc"
}

# --- Member-registration HMAC resolution (unchanged behaviour) ---

new_store
minikube_capture="$TMP/minikube-control-api-internal-tokens.json"
run_tokens clerum-codex-member-registration-test "$TMP/rollout.log" "$minikube_capture" env
jq -e '.stringData.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET and .stringData.CONTROL_API_INTERNAL_TOKENS and .stringData.CONTROL_API_INTERNAL_SERVICE_TOKENS' "$minikube_capture" >/dev/null
jq -e '.stringData.CONTROL_API_INTERNAL_SERVICE_TOKENS | contains("codex-llm-proxy=")' "$minikube_capture" >/dev/null
jq -e '.stringData.CONTROL_API_INTERNAL_SERVICE_TOKENS | contains("grok-llm-proxy=")' "$minikube_capture" >/dev/null

new_store
branch_profile_capture="$TMP/branch-profile-control-api-internal-tokens.json"
run_tokens clerum-cursor-46f812cd-185fc31b "$TMP/rollout.log" "$branch_profile_capture" env
jq -e '.stringData.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET == "dev-member-registration-hmac-secret"' "$branch_profile_capture" >/dev/null

new_store
detached_profile_capture="$TMP/detached-profile-control-api-internal-tokens.json"
run_tokens clerum-detached-rwo-abc12345 "$TMP/rollout.log" "$detached_profile_capture" env
jq -e '.stringData.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET == "dev-member-registration-hmac-secret"' "$detached_profile_capture" >/dev/null

new_store
non_minikube_capture="$TMP/non-minikube-control-api-internal-tokens.json"
if run_tokens gke-dev "$TMP/rollout.log" "$non_minikube_capture" env; then
  fail "expected non-minikube run without member-registration HMAC to fail"
fi
grep -q "is required when no existing control-api Secret value is present" "$TMP/stderr"

new_store
env_capture="$TMP/env-control-api-internal-tokens.json"
run_tokens gke-dev "$TMP/rollout.log" "$env_capture" env CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET="$MEMBER_HMAC"
jq -e '.stringData.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET == "test-member-registration-hmac"' "$env_capture" >/dev/null

# --- Token consumer restarts ---

# First deploy: every token is absent and no consumer has a stamp, so every
# consumer restarts and is stamped.
new_cluster
rollout="$TMP/rollout-first-deploy.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET="$MEMBER_HMAC"
assert_restarted_exactly "$rollout" "${ALL_TOKEN_CONSUMERS[@]}"
assert_all_stamped
assert_loaded_matches_secrets

# Normal redeploy (preserve path): identical values are written, nothing restarts.
rollout="$TMP/rollout-noop.log"
run_tokens gke-dev "$rollout" "" env -u CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET
assert_restarted_exactly "$rollout"
assert_noop_witness
assert_openssl_rand_calls 0
assert_loaded_matches_secrets

# --- Secret read failures (an API error, not NotFound) ---

# A no-op on a stamped cluster with one Secret read failing once at each
# change-detection site: the read is retried and the run stays a no-op.
for spec in \
  "profiles/external-rest-api-secrets/EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN#2" \
  "control-plane/control-api-internal-tokens/CONTROL_API_INTERNAL_SERVICE_TOKENS#1" \
  "control-plane/internal-control-jwt-secrets/INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET#2"; do
  rollout="$TMP/rollout-read-site.log"
  run_tokens gke-dev "$rollout" "" env KUBE_SECRET_READ_FLAKE="$spec" \
    || fail "a transient Secret read failure ($spec) failed the run"
  assert_read_injected "$spec"
  assert_restarted_exactly "$rollout"
  assert_noop_witness
  assert_openssl_rand_calls 0
  assert_loaded_matches_secrets
done

# Census of the -o jsonpath Secret reads of a no-op, then one run per read with
# that read failing once: every run stays a no-op and writes the same values.
# A no-op makes 25 such reads: 9 resolve_token reads (the six caller tokens,
# the handoff token, the WRC and HCC HMACs), 1 member-registration HMAC read,
# 1 read of control-api's service-token map, 6 caller change checks (each
# caller's own key), 1 handoff check, 1 WRC and 1 HCC check, and 5 control-api
# checks (map, flat list, member HMAC, WRC, HCC). ensure_secret's existence read
# and the legacy-key read (-o json) are not jsonpath reads and are not counted.
rollout="$TMP/rollout-read-census.log"
run_tokens gke-dev "$rollout" "" env || fail "the census run failed"
reads="$(awk '{n[$0]++; print $0 "#" n[$0]}' "$TMP/secret-reads.log")"
read_count="$(printf '%s\n' "$reads" | sed '/^$/d' | wc -l | tr -d ' ')"
[[ "$read_count" == "25" ]] || fail "the census expected 25 Secret reads, saw $read_count"
for site in "profiles/external-rest-api-secrets/EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN#2" \
            "control-plane/control-api-internal-tokens/CONTROL_API_INTERNAL_SERVICE_TOKENS#1"; do
  printf '%s\n' "$reads" | grep -qxF "$site" || fail "the census misses $site"
done
while IFS= read -r spec; do
  rollout="$TMP/rollout-read-flake.log"
  run_tokens gke-dev "$rollout" "" env KUBE_SECRET_READ_FLAKE="$spec" \
    || fail "a transient Secret read failure ($spec) failed the run"
  assert_read_injected "$spec"
  assert_restarted_exactly "$rollout"
  assert_noop_witness
  assert_openssl_rand_calls 0
done <<<"$reads"
assert_loaded_matches_secrets

# A Secret that cannot be read stops the run before anything is written: an
# unreadable value is neither absent (a new token) nor changed (a restart).
for unreadable in profiles/external-rest-api-secrets control-plane/control-api-internal-tokens; do
  rollout="$TMP/rollout-secret-unreadable.log"
  if run_tokens gke-dev "$rollout" "" env KUBE_SECRET_READ_FAIL="$unreadable"; then
    fail "an unreadable Secret ($unreadable) must fail the run"
  fi
  [[ "$(grep -c "^$unreadable/" "$TMP/secret-reads.log.injected")" == "3" ]] \
    || fail "the read of $unreadable was not attempted three times"
  grep -qF "cannot read Secret $unreadable; no Secret was written" "$TMP/stderr" \
    || fail "missing Secret read error line"
  if grep -qF 'is required when no existing control-api Secret value is present' "$TMP/stderr"; then
    fail "an unreadable Secret was treated as absent"
  fi
  [[ ! -s "$TMP/patches.log" ]] || fail "no Secret may be written after a failed Secret read"
  [[ ! -s "$TMP/annotations.log" ]] || fail "no consumer may be marked after a failed Secret read"
  assert_openssl_rand_calls 0
  assert_restarted_exactly "$rollout"
done
# The caller key is readable for resolve_token and then fails on every attempt
# of the change check: the run still stops before writing.
spec_key="profiles/external-rest-api-secrets/EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN"
rollout="$TMP/rollout-secret-check-unreadable.log"
if run_tokens gke-dev "$rollout" "" env KUBE_SECRET_READ_FLAKE="$spec_key#2 $spec_key#3 $spec_key#4"; then
  fail "a change check that cannot read its Secret must fail the run"
fi
assert_read_injected "$spec_key#4"
grep -qF "cannot read Secret profiles/external-rest-api-secrets; no Secret was written" "$TMP/stderr" \
  || fail "missing Secret read error line for the change check"
[[ ! -s "$TMP/patches.log" ]] || fail "no Secret may be written after a failed change check"
[[ ! -s "$TMP/annotations.log" ]] || fail "no consumer may be marked after a failed change check"
assert_restarted_exactly "$rollout"
assert_loaded_matches_secrets

# control-api's service-token map cannot be read on any attempt (it is read
# once, at top level, after every token is resolved): the run stops before
# marking or writing anything.
spec_key="control-plane/control-api-internal-tokens/CONTROL_API_INTERNAL_SERVICE_TOKENS"
secrets_before="$(secrets_digest)"
rollout="$TMP/rollout-map-unreadable.log"
if run_tokens gke-dev "$rollout" "" env KUBE_SECRET_READ_FLAKE="$spec_key#1 $spec_key#2 $spec_key#3"; then
  fail "a map that cannot be read must fail the run"
fi
assert_read_injected "$spec_key#3"
[[ "$(grep -c "^$spec_key#" "$TMP/secret-reads.log.injected")" == "3" ]] \
  || fail "the map read was not attempted three times"
grep -qF "cannot read Secret control-plane/control-api-internal-tokens; no Secret was written" "$TMP/stderr" \
  || fail "missing Secret read error line for the map"
[[ ! -s "$TMP/patches.log" ]] || fail "no Secret may be written after a failed map read"
[[ ! -s "$TMP/annotations.log" ]] || fail "no consumer may be marked after a failed map read"
assert_restarted_exactly "$rollout"
[[ "$(secrets_digest)" == "$secrets_before" ]] || fail "a Secret value changed although the map read failed"
assert_loaded_matches_secrets

# A key edited out of band (control-api's flat token list) and loaded by a
# control-api pod that restarted since (eviction): the run writes the list back
# and restarts control-api, the only consumer that reads it.
store_set control-plane control-api-internal-tokens CONTROL_API_INTERNAL_TOKENS stale-list
pod_restart control-plane/control-api
rollout="$TMP/rollout-secret-drift.log"
run_tokens gke-dev "$rollout" "" env || fail "the drift run failed"
assert_restarted_exactly "$rollout" control-plane/control-api
grep -qF 'Recorded pending restart on control-plane/control-api before writing Secrets' "$TMP/stderr" \
  || fail "control-api was not marked before the write"
[[ "$(store_get control-plane control-api-internal-tokens CONTROL_API_INTERNAL_TOKENS)" != "stale-list" ]] \
  || fail "the drifted Secret key was not rewritten"
assert_loaded_matches_secrets

# control-api's service-token map edited out of band (rpc-proxy entry) and
# loaded by a restarted control-api pod: the run writes the map back and
# restarts control-api, the only consumer that reads the map. rpc-proxy reads
# only its own Secret, which did not change, and its stamp matches: it is
# neither marked nor restarted. The run after it is a no-op.
live_map="$(store_get control-plane control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS)"
# rpc-proxy is never the first map entry, so ",rpc-proxy=" is unique.
map_tail="${live_map#*,rpc-proxy=}"
oob_map="${live_map%%,rpc-proxy=*},rpc-proxy=$ROTATED,${map_tail#*,}"
[[ "$oob_map" != "$live_map" ]] || fail "the out-of-band map edit did not apply"
store_set control-plane control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS "$oob_map"
pod_restart control-plane/control-api
rollout="$TMP/rollout-map-drift.log"
run_tokens gke-dev "$rollout" "" env || fail "the map drift run failed"
assert_restarted_exactly "$rollout" control-plane/control-api
grep -qF 'Recorded pending restart on control-plane/control-api before writing Secrets' "$TMP/stderr" \
  || fail "control-api was not marked before the write"
grep -qF 'Skipping rollout of rpc-proxy/rpc-proxy: tokens unchanged' "$TMP/stderr" \
  || fail "rpc-proxy was not evaluated"
if grep -q '^rpc-proxy/rpc-proxy ' "$TMP/annotations.log"; then
  fail "rpc-proxy must not be marked when only control-api's map entry changed"
fi
assert_extra_restart_checked rpc-proxy/rpc-proxy
[[ "$(store_get control-plane control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS)" == "$live_map" ]] \
  || fail "the map was not written back"
assert_loaded_matches_secrets
rollout="$TMP/rollout-map-drift-settled.log"
run_tokens gke-dev "$rollout" "" env
assert_restarted_exactly "$rollout"
assert_noop_witness
assert_loaded_matches_secrets

# A map without the grok-llm-proxy entry (an upgrade that adds a caller, or an
# out-of-band edit): the run adds it back and restarts control-api only.
[[ "$live_map" == *",grok-llm-proxy="* ]] || fail "grok-llm-proxy is not in the map"
store_set control-plane control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS "${live_map%,grok-llm-proxy=*}"
pod_restart control-plane/control-api
rollout="$TMP/rollout-map-missing-entry.log"
run_tokens gke-dev "$rollout" "" env || fail "the missing-entry run failed"
assert_restarted_exactly "$rollout" control-plane/control-api
grep -qF 'Skipping rollout of control-plane/grok-llm-proxy: tokens unchanged' "$TMP/stderr" \
  || fail "grok-llm-proxy was not evaluated"
if grep -q '^control-plane/grok-llm-proxy ' "$TMP/annotations.log"; then
  fail "grok-llm-proxy must not be marked when only its map entry is missing"
fi
assert_extra_restart_checked control-plane/grok-llm-proxy
[[ "$(store_get control-plane control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS)" == "$live_map" ]] \
  || fail "the grok-llm-proxy entry was not added back"
assert_loaded_matches_secrets

# The same rpc-proxy map edit, and rpc-proxy's Deployment cannot be read before
# the write: an existing consumer whose other end changes must be read (it may
# have no stamp), so the run stops before writing any Secret. The next plain
# run restarts control-api only.
store_set control-plane control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS "$oob_map"
pod_restart control-plane/control-api
rollout="$TMP/rollout-map-peer-read-fails.log"
if run_tokens gke-dev "$rollout" "" env KUBE_GET_DEPLOY_FAIL="rpc-proxy/rpc-proxy"; then
  fail "a failed Deployment read of a consumer whose other end changes must fail the run"
fi
grep -qF 'cannot read deployment rpc-proxy/rpc-proxy before writing Secrets; no Secret was written' "$TMP/stderr" \
  || fail "missing pre-write read error line for rpc-proxy"
grep -qF 'injected get failure for rpc-proxy/rpc-proxy' "$TMP/stderr" || fail "the rpc-proxy read failure was never injected"
[[ ! -s "$TMP/patches.log" ]] || fail "no Secret may be written after a failed pre-write read"
assert_restarted_exactly "$rollout"
rollout="$TMP/rollout-map-peer-read-heals.log"
run_tokens gke-dev "$rollout" "" env || fail "the run after a failed rpc-proxy read failed"
assert_restarted_exactly "$rollout" control-plane/control-api
[[ "$(store_get control-plane control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS)" == "$live_map" ]] \
  || fail "the map was not written back after the failed read"
assert_loaded_matches_secrets

# An extra map entry added out of band: the run removes it and restarts
# control-api only.
store_set control-plane control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS "$live_map,extra-caller=$ROTATED"
pod_restart control-plane/control-api
rollout="$TMP/rollout-map-extra-entry.log"
run_tokens gke-dev "$rollout" "" env || fail "the extra-entry run failed"
assert_restarted_exactly "$rollout" control-plane/control-api
[[ "$(store_get control-plane control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS)" == "$live_map" ]] \
  || fail "the extra map entry was not removed"
assert_loaded_matches_secrets

# Only control-api's end of the reader's token changes: the reader's entry in
# the map is edited out of band and loaded by a restarted control-api pod. The
# run writes the map back and restarts control-api; the reader reads only its
# own Secret, which did not change, and its stamp matches, so it is neither
# marked nor restarted.
map_tail="${live_map#*,workflow-approval-reader=}"
oob_reader_map="${live_map%%,workflow-approval-reader=*},workflow-approval-reader=$ROTATED,${map_tail#*,}"
[[ "$oob_reader_map" != "$live_map" ]] || fail "the out-of-band reader entry edit did not apply"
store_set control-plane control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS "$oob_reader_map"
pod_restart control-plane/control-api
rollout="$TMP/rollout-map-reader-entry.log"
run_tokens gke-dev "$rollout" "" env || fail "the reader-entry run failed"
assert_restarted_exactly "$rollout" control-plane/control-api
grep -qF 'Recorded pending restart on control-plane/control-api before writing Secrets' "$TMP/stderr" \
  || fail "control-api was not marked before the write"
grep -qF 'Skipping rollout of channels/clerum-workflow-approval-request-reader: tokens unchanged' "$TMP/stderr" \
  || fail "the reader was not evaluated"
if grep -q '^channels/clerum-workflow-approval-request-reader ' "$TMP/annotations.log"; then
  fail "the reader must not be marked when only control-api's entry for it changed"
fi
assert_extra_restart_checked channels/clerum-workflow-approval-request-reader
[[ "$(store_get control-plane control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS)" == "$live_map" ]] \
  || fail "the reader's map entry was not written back"
assert_loaded_matches_secrets

# Only the caller's end of a token changes: rpc-proxy's Secret is edited out of
# band and the run pins the token to the value control-api's map already holds.
# rpc-proxy's own key changes, so it is marked and restarted; control-api's
# keys do not change and its stamp matches, so it is neither marked nor
# restarted.
rpc_entry="${live_map#*,rpc-proxy=}"
rpc_entry="${rpc_entry%%,*}"
[[ "$(store_get rpc-proxy rpc-proxy-secrets RPC_PROXY_CONTROL_API_SERVICE_TOKEN)" == "$rpc_entry" ]] \
  || fail "rpc-proxy's Secret does not hold its map entry before the edit"
store_set rpc-proxy rpc-proxy-secrets RPC_PROXY_CONTROL_API_SERVICE_TOKEN "$ROTATED"
rollout="$TMP/rollout-caller-end-only.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_RPC="$rpc_entry" \
  || fail "the caller-end-only run failed"
assert_restarted_exactly "$rollout" rpc-proxy/rpc-proxy
grep -qF 'Recorded pending restart on rpc-proxy/rpc-proxy before writing Secrets' "$TMP/stderr" \
  || fail "rpc-proxy was not marked before the write"
grep -qF 'Skipping rollout of control-plane/control-api: tokens unchanged' "$TMP/stderr" \
  || fail "control-api was not evaluated"
if grep -q '^control-plane/control-api ' "$TMP/annotations.log"; then
  fail "control-api must not be marked when only the caller's end of a token changed"
fi
assert_extra_restart_checked control-plane/control-api
[[ "$(store_get rpc-proxy rpc-proxy-secrets RPC_PROXY_CONTROL_API_SERVICE_TOKEN)" == "$rpc_entry" ]] \
  || fail "rpc-proxy's Secret was not written back"
assert_loaded_matches_secrets

# A Deployment created after the pre-write read and before its Secret is
# patched, with a value it reads changing: it has no stamp and may have loaded
# the old value, so it restarts.
rm -rf "$TMP/store/_deploy/rpc-proxy/rpc-proxy"
rollout="$TMP/rollout-created-mid-run.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_RPC="$(printf '%064x' 0xA1138)" \
  KUBE_CREATE_DEPLOY_ON_PATCH=rpc-proxy/rpc-proxy || fail "the created-mid-run run failed"
[[ -d "$TMP/store/_deploy/rpc-proxy/rpc-proxy" ]] || fail "the rpc-proxy Deployment was never created"
assert_restarted_exactly "$rollout" control-plane/control-api rpc-proxy/rpc-proxy
grep -qF 'Rolling deployment rpc-proxy/rpc-proxy to pick up fresh Secret values (no stamp and tokens changed)' \
  "$TMP/stderr" || fail "missing no-stamp restart reason"
assert_loaded_matches_secrets

# A rotation that dies after control-api's Secret is written (the rpc-proxy
# Secret patch fails): a control-api pod that starts before the next run loads
# the new map. The next plain run writes the old values back and restarts both.
rollout="$TMP/rollout-half-applied-stamped.log"
if run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_RPC="$WRC_NEW" \
     KUBE_PATCH_FAIL="rpc-proxy/rpc-proxy-secrets"; then
  fail "a failed Secret patch must fail the run"
fi
grep -qF 'injected patch failure for rpc-proxy/rpc-proxy-secrets' "$TMP/stderr" || fail "the patch failure was never injected"
grep -qx 'control-plane/control-api-internal-tokens' "$TMP/patches.log" || fail "control-api's Secret was not written first"
assert_restarted_exactly "$rollout"
pod_restart control-plane/control-api
rollout="$TMP/rollout-half-applied-stamped-heals.log"
run_tokens gke-dev "$rollout" "" env || fail "the run after a half-applied rotation failed"
assert_restarted_exactly "$rollout" control-plane/control-api rpc-proxy/rpc-proxy
assert_loaded_matches_secrets

# rpc-proxy token rotated: rpc-proxy and control-api (which holds it in its map).
rollout="$TMP/rollout-rpc-rotated.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_RPC="$ROTATED"
assert_restarted_exactly "$rollout" control-plane/control-api rpc-proxy/rpc-proxy
[[ "$(store_get rpc-proxy rpc-proxy-secrets RPC_PROXY_CONTROL_API_SERVICE_TOKEN)" == "$ROTATED" ]] \
  || fail "rotated rpc-proxy token was not written"
assert_loaded_matches_secrets

# Out-of-band rotation of a caller's Secret: the run preserves it, copies it into
# control-api's map, and both ends restart.
store_set profiles external-rest-api-secrets EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN "$WRC_NEW"
rollout="$TMP/rollout-out-of-band.log"
run_tokens gke-dev "$rollout" "" env
assert_restarted_exactly "$rollout" control-plane/control-api profiles/external-rest-api
assert_loaded_matches_secrets

# One rotation per override: exactly the caller and control-api.
rotation_case() {
  local env_var="$1" value="$2" consumer="$3"
  local rollout="$TMP/rollout-rotate-$env_var.log"
  run_tokens gke-dev "$rollout" "" env "$env_var=$value"
  assert_restarted_exactly "$rollout" control-plane/control-api "$consumer"
  assert_loaded_matches_secrets
}
rotation_case CONTROL_API_INTERNAL_TOKEN_EXT_REST "$ROTATED" profiles/external-rest-api
rotation_case CONTROL_API_INTERNAL_TOKEN_WEBHOOK_PROXY "$WRC_OLD" webhook-ingress/webhook-proxy
rotation_case CONTROL_API_INTERNAL_TOKEN_CODEX_LLM_PROXY "$HCC_OLD" control-plane/codex-llm-proxy
rotation_case CONTROL_API_INTERNAL_TOKEN_GROK_LLM_PROXY "$HCC_NEW" control-plane/grok-llm-proxy
# The reader's control-api token: the reader, not the channel-readers.
rotation_case CONTROL_API_INTERNAL_TOKEN_WA_READER "$WRC_NEW" channels/clerum-workflow-approval-request-reader

# Member-registration HMAC rotated: control-api only.
rollout="$TMP/rollout-member-hmac.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=rotated-member-registration-hmac
assert_restarted_exactly "$rollout" control-plane/control-api
assert_loaded_matches_secrets

# Reader handoff token rotated: the reader and the channel-readers only.
rollout="$TMP/rollout-handoff-rotated.log"
run_tokens gke-dev "$rollout" "" env CHANNEL_READER_HANDOFF_TOKEN="$ROTATED"
assert_restarted_exactly "$rollout" \
  channels/clerum-workflow-approval-request-reader channels/channel-reader-stubhost \
  channels/channel-reader-stubhost-b
assert_loaded_matches_secrets

# A legacy `replace-with-*` placeholder counts as absent: regenerated, restarted.
store_set control-plane codex-llm-proxy-secrets CODEX_LLM_PROXY_CONTROL_API_TOKEN replace-with-codex-token
rollout="$TMP/rollout-placeholder.log"
run_tokens gke-dev "$rollout" "" env
assert_restarted_exactly "$rollout" control-plane/control-api control-plane/codex-llm-proxy
assert_openssl_rand_calls 1
assert_loaded_matches_secrets

# --- Self-healing: a restart that does not happen is retried by the next run ---

# Every service-token caller, as override-env-var|consumer.
SERVICE_TOKEN_CALLERS=(
  "CONTROL_API_INTERNAL_TOKEN_EXT_REST|profiles/external-rest-api"
  "CONTROL_API_INTERNAL_TOKEN_RPC|rpc-proxy/rpc-proxy"
  "CONTROL_API_INTERNAL_TOKEN_WEBHOOK_PROXY|webhook-ingress/webhook-proxy"
  "CONTROL_API_INTERNAL_TOKEN_CODEX_LLM_PROXY|control-plane/codex-llm-proxy"
  "CONTROL_API_INTERNAL_TOKEN_GROK_LLM_PROXY|control-plane/grok-llm-proxy"
  "CONTROL_API_INTERNAL_TOKEN_WA_READER|channels/clerum-workflow-approval-request-reader"
)
caller_index=0
for caller in "${SERVICE_TOKEN_CALLERS[@]}"; do
  IFS='|' read -r caller_env caller_consumer <<<"$caller"
  caller_index=$((caller_index + 1))
  new_token="$(printf '%064x' $((0xB000 + caller_index)))"

  # The caller's restart fails on every attempt: control-api still restarts,
  # the run fails naming the caller, and the caller keeps its old stamp.
  rollout="$TMP/rollout-rollout-fails-$caller_index.log"
  if run_tokens gke-dev "$rollout" "" env "$caller_env=$new_token" KUBE_ROLLOUT_FAIL="$caller_consumer"; then
    fail "a failed restart of $caller_consumer must fail the run"
  fi
  assert_restarted_exactly "$rollout" control-plane/control-api
  assert_pending "$caller_consumer"

  # The next plain run, with no override and no FORCE, restarts only the caller.
  rollout="$TMP/rollout-self-heal-$caller_index.log"
  run_tokens gke-dev "$rollout" "" env || fail "the healing run for $caller_consumer failed"
  assert_restarted_exactly "$rollout" "$caller_consumer"
  grep -q '\] Done\.$' "$TMP/stderr" || fail "the healing run did not reach Done."
  assert_loaded_matches_secrets
done

# A failed Deployment read (not NotFound) of a consumer whose token rotates:
# the restart obligation cannot be checked before the write, so the run stops
# before writing any Secret, and the next run does the whole rotation.
rpc_before="$(store_get rpc-proxy rpc-proxy-secrets RPC_PROXY_CONTROL_API_SERVICE_TOKEN)"
rollout="$TMP/rollout-read-fails.log"
if run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_RPC="$WRC_OLD" \
     KUBE_GET_DEPLOY_FAIL="rpc-proxy/rpc-proxy"; then
  fail "a failed Deployment read must fail the run"
fi
grep -qF 'cannot read deployment rpc-proxy/rpc-proxy before writing Secrets; no Secret was written' "$TMP/stderr" \
  || fail "missing pre-write read error line"
grep -qF 'injected get failure for rpc-proxy/rpc-proxy' "$TMP/stderr" || fail "the read failure was never injected"
[[ ! -s "$TMP/patches.log" ]] || fail "no Secret may be written after a failed pre-write read"
assert_restarted_exactly "$rollout"
[[ "$(store_get rpc-proxy rpc-proxy-secrets RPC_PROXY_CONTROL_API_SERVICE_TOKEN)" == "$rpc_before" ]] \
  || fail "the rpc-proxy token changed although the run stopped before writing"
rollout="$TMP/rollout-read-heals.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_RPC="$WRC_OLD" \
  || fail "the rotation after a read failure failed"
assert_restarted_exactly "$rollout" control-plane/control-api rpc-proxy/rpc-proxy
assert_loaded_matches_secrets

# A failed read of a consumer whose values do not change: the rotation goes on,
# the unread consumer is reported pending, and it keeps its (still valid) stamp.
rollout="$TMP/rollout-read-unchanged-fails.log"
if run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_RPC="$WRC_NEW" \
     KUBE_GET_DEPLOY_FAIL="profiles/external-rest-api"; then
  fail "a failed Deployment read must fail the run"
fi
assert_restarted_exactly "$rollout" control-plane/control-api rpc-proxy/rpc-proxy
assert_pending profiles/external-rest-api
grep -qF 'cannot read deployment profiles/external-rest-api; its restart is pending' "$TMP/stderr" \
  || fail "missing reconcile read error line"
rollout="$TMP/rollout-read-unchanged-heals.log"
run_tokens gke-dev "$rollout" "" env || fail "the run after an unchanged-consumer read failure failed"
assert_restarted_exactly "$rollout"
assert_loaded_matches_secrets

# A failed stamp write after a successful restart: the run fails, the consumer
# keeps its restart-pending mark, and the next run restarts it once more (an
# extra restart, never a missed one).
rollout="$TMP/rollout-stamp-fails.log"
if run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_EXT_REST="$HCC_OLD" \
     KUBE_STAMP_WRITE_FAIL="profiles/external-rest-api"; then
  fail "a failed stamp write must fail the run"
fi
grep -qF 'injected stamp failure for profiles/external-rest-api' "$TMP/stderr" || fail "the stamp-write failure was never injected"
assert_restarted_exactly "$rollout" control-plane/control-api profiles/external-rest-api
assert_pending profiles/external-rest-api
[[ "$(stamp_of profiles/external-rest-api)" == "restart-pending" ]] || fail "external-rest-api lost its mark"
rollout="$TMP/rollout-stamp-heals.log"
run_tokens gke-dev "$rollout" "" env || fail "the run after a failed stamp write failed"
assert_restarted_exactly "$rollout" profiles/external-rest-api
assert_loaded_matches_secrets
rollout="$TMP/rollout-stamp-settled.log"
run_tokens gke-dev "$rollout" "" env
assert_restarted_exactly "$rollout"
assert_loaded_matches_secrets

# A failure on the first attempt only is retried within the run.
rollout="$TMP/rollout-transient.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_RPC="$HCC_NEW" \
  KUBE_FLAKY="get:control-plane/control-api rollout:rpc-proxy/rpc-proxy annotate:rpc-proxy/rpc-proxy stamp:rpc-proxy/rpc-proxy" \
  || fail "transient failures must be absorbed by the retries"
assert_restarted_exactly "$rollout" control-plane/control-api rpc-proxy/rpc-proxy
grep -q '\] Done\.$' "$TMP/stderr" || fail "the run with transient failures did not reach Done."
[[ -e "$TMP/flaky/rollout-rpc-proxy_rpc-proxy" ]] || fail "the transient rollout failure was never injected"
[[ -e "$TMP/flaky/stamp-rpc-proxy_rpc-proxy" ]] || fail "the transient stamp-write failure was never injected"
assert_loaded_matches_secrets

# The channel-reader list cannot be read before a handoff rotation: the run
# stops before writing any Secret, and the next run does the whole rotation.
rollout="$TMP/rollout-selector-fails.log"
if run_tokens gke-dev "$rollout" "" env CHANNEL_READER_HANDOFF_TOKEN="$WRC_NEW" \
     KUBE_GET_DEPLOY_FAIL="channels/app=channel-reader"; then
  fail "a failed channel-reader list must fail the run"
fi
grep -qF 'cannot list channel-reader deployments before writing Secrets; no Secret was written' "$TMP/stderr" \
  || fail "missing pre-write list error line"
grep -qF 'injected get failure for channels/app=channel-reader' "$TMP/stderr" || fail "the list failure was never injected"
[[ ! -s "$TMP/patches.log" ]] || fail "no Secret may be written after a failed pre-write list"
assert_restarted_exactly "$rollout"
rollout="$TMP/rollout-selector-heals.log"
run_tokens gke-dev "$rollout" "" env CHANNEL_READER_HANDOFF_TOKEN="$WRC_NEW" \
  || fail "the handoff rotation after a list failure failed"
assert_restarted_exactly "$rollout" channels/clerum-workflow-approval-request-reader channels/channel-reader-stubhost \
  channels/channel-reader-stubhost-b
assert_loaded_matches_secrets

# The list succeeds before the write and fails after it: both unstamped
# channel-readers were listed and marked before the write, so the next plain
# run restarts both, and the printed command uses the label selector (a
# Deployment name cannot contain "=").
seed_unstamped
rollout="$TMP/rollout-selector-post-fails.log"
if run_tokens gke-dev "$rollout" "" env CHANNEL_READER_HANDOFF_TOKEN="$HCC_NEW" KUBE_LIST_FAIL_FROM=2; then
  fail "a failed post-write channel-reader list must fail the run"
fi
grep -qF 'injected list failure for channels/app=channel-reader' "$TMP/stderr" || fail "the post-write list failure was never injected"
assert_restarted_exactly "$rollout" channels/clerum-workflow-approval-request-reader
[[ "$(stamp_of channels/channel-reader-stubhost)" == "restart-pending" ]] || fail "the listed channel-reader was not marked"
[[ "$(stamp_of channels/channel-reader-stubhost-b)" == "restart-pending" ]] || fail "the second listed channel-reader was not marked"
grep -qF 'restarts are pending: channels/app=channel-reader' "$TMP/stderr" || fail "missing selector pending entry"
assert_pending channels/app=channel-reader
if grep -qF 'rollout restart deploy app=channel-reader' "$TMP/stderr"; then
  fail "the selector must not be printed as a Deployment name"
fi
rollout="$TMP/rollout-selector-post-heals.log"
run_tokens gke-dev "$rollout" "" env || fail "the healing run after a post-write list failure failed"
assert_restarted_exactly "$rollout" channels/channel-reader-stubhost channels/channel-reader-stubhost-b
for channel_reader in channels/channel-reader-stubhost channels/channel-reader-stubhost-b; do
  grep -qF "Rolling deployment $channel_reader to pick up fresh Secret values (restart pending (recorded before a Secret write))" \
    "$TMP/stderr" || fail "missing restart-pending reason for $channel_reader"
done
assert_loaded_matches_secrets

# --- Stamps missing (first run with stamps, or a recreated Deployment) ---

# Nothing changed in this run: every consumer is stamped, none restarts.
for consumer in "${ALL_TOKEN_CONSUMERS[@]}"; do unstamp "$consumer"; done
rollout="$TMP/rollout-bootstrap-unchanged.log"
run_tokens gke-dev "$rollout" "" env
assert_restarted_exactly "$rollout"
assert_all_stamped
for consumer in "${ALL_TOKEN_CONSUMERS[@]}"; do
  grep -qF "Recording token stamp on ${consumer}: tokens unchanged, no restart" "$TMP/stderr" \
    || fail "missing stamp-recording line for $consumer"
done
assert_loaded_matches_secrets

# A value changed in this run: its consumers restart; the others are stamped only.
for consumer in "${ALL_TOKEN_CONSUMERS[@]}"; do unstamp "$consumer"; done
rollout="$TMP/rollout-bootstrap-changed.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_RPC="$ROTATED"
assert_restarted_exactly "$rollout" control-plane/control-api rpc-proxy/rpc-proxy
assert_all_stamped
# Only the two changed ends were marked restart-pending before the write.
marked="$(grep ' clerum.io/inter-service-tokens-sha256=restart-pending$' "$TMP/annotations.log" | cut -d' ' -f1 | sort)"
[[ "$marked" == "$(printf '%s\n' control-plane/control-api rpc-proxy/rpc-proxy)" ]] \
  || fail "unexpected restart-pending marks: ${marked:-<none>}"
assert_loaded_matches_secrets

# No stamps and a run that died between the control-api patch and the caller
# patch (control-api's Secret already holds the new token, the caller's does
# not): both ends count as changed, so both restart.
run_tokens gke-dev "$TMP/rollout-setup.log" "" env CONTROL_API_INTERNAL_TOKEN_WEBHOOK_PROXY="$HCC_OLD"
webhook_before="$(store_get webhook-ingress webhook-proxy-secrets WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN)"
run_tokens gke-dev "$TMP/rollout-setup.log" "" env CONTROL_API_INTERNAL_TOKEN_WEBHOOK_PROXY="$WRC_NEW"
store_set webhook-ingress webhook-proxy-secrets WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN "$webhook_before"
for consumer in "${ALL_TOKEN_CONSUMERS[@]}"; do unstamp "$consumer"; done
rollout="$TMP/rollout-bootstrap-half-applied.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_WEBHOOK_PROXY="$WRC_NEW"
assert_restarted_exactly "$rollout" control-plane/control-api webhook-ingress/webhook-proxy
assert_all_stamped
assert_loaded_matches_secrets

# --- Unstamped consumers: the pre-write mark makes a failed restart survive to the next run ---

# Every service-token caller without a stamp: its restart fails on every
# attempt. It was marked restart-pending before the write, so the next plain
# run restarts exactly it, and the run after that is a no-op.
caller_index=0
for caller in "${SERVICE_TOKEN_CALLERS[@]}"; do
  IFS='|' read -r caller_env caller_consumer <<<"$caller"
  caller_index=$((caller_index + 1))
  new_token="$(printf '%064x' $((0xC000 + caller_index)))"
  seed_unstamped
  rollout="$TMP/rollout-unstamped-fails-$caller_index.log"
  if run_tokens gke-dev "$rollout" "" env "$caller_env=$new_token" KUBE_ROLLOUT_FAIL="$caller_consumer"; then
    fail "a failed restart of unstamped $caller_consumer must fail the run"
  fi
  assert_restarted_exactly "$rollout" control-plane/control-api
  assert_pending "$caller_consumer"
  [[ "$(stamp_of "$caller_consumer")" == "restart-pending" ]] || fail "$caller_consumer was not marked restart-pending"
  rollout="$TMP/rollout-unstamped-heals-$caller_index.log"
  run_tokens gke-dev "$rollout" "" env || fail "the healing run for unstamped $caller_consumer failed"
  assert_restarted_exactly "$rollout" "$caller_consumer"
  [[ "$(stamp_of "$caller_consumer")" =~ ^[0-9a-f]{64}$ ]] || fail "$caller_consumer has no stamp after healing"
  grep -q '\] Done\.$' "$TMP/stderr" || fail "the healing run for $caller_consumer did not reach Done."
  rollout="$TMP/rollout-unstamped-settled-$caller_index.log"
  run_tokens gke-dev "$rollout" "" env
  assert_restarted_exactly "$rollout"
  assert_noop_witness
  assert_loaded_matches_secrets
done

# Unstamped WRC and HCC with their HMAC rotated and their restart failing.
for hmac in "INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET|control-plane/workflow-recipes" \
            "INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET|control-plane/host-context-controller"; do
  IFS='|' read -r hmac_env hmac_consumer <<<"$hmac"
  seed_unstamped
  rollout="$TMP/rollout-unstamped-hmac-fails.log"
  if run_tokens gke-dev "$rollout" "" env "$hmac_env=$ROTATED" KUBE_ROLLOUT_FAIL="$hmac_consumer"; then
    fail "a failed restart of unstamped $hmac_consumer must fail the run"
  fi
  assert_restarted_exactly "$rollout" control-plane/control-api
  assert_pending "$hmac_consumer"
  rollout="$TMP/rollout-unstamped-hmac-heals.log"
  run_tokens gke-dev "$rollout" "" env || fail "the healing run for unstamped $hmac_consumer failed"
  assert_restarted_exactly "$rollout" "$hmac_consumer"
  assert_loaded_matches_secrets
done

# The restart-pending mark cannot be written: the run stops before writing any
# Secret, and the next run does the whole rotation.
seed_unstamped
rpc_before="$(store_get rpc-proxy rpc-proxy-secrets RPC_PROXY_CONTROL_API_SERVICE_TOKEN)"
rollout="$TMP/rollout-mark-fails.log"
if run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_RPC="$ROTATED" \
     KUBE_ANNOTATE_FAIL="rpc-proxy/rpc-proxy"; then
  fail "a failed restart-pending mark must fail the run"
fi
grep -qF 'cannot record the pending restart of rpc-proxy/rpc-proxy; no Secret was written' "$TMP/stderr" \
  || fail "missing mark error line"
[[ "$(grep -c 'injected annotate failure for rpc-proxy/rpc-proxy' "$TMP/stderr")" == "3" ]] \
  || fail "the mark was not attempted three times"
[[ ! -s "$TMP/patches.log" ]] || fail "no Secret may be written after a failed mark"
assert_restarted_exactly "$rollout"
[[ "$(store_get rpc-proxy rpc-proxy-secrets RPC_PROXY_CONTROL_API_SERVICE_TOKEN)" == "$rpc_before" ]] \
  || fail "the rpc-proxy token changed although the run stopped before writing"
rollout="$TMP/rollout-mark-heals.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_RPC="$ROTATED" \
  || fail "the rotation after a failed mark failed"
assert_restarted_exactly "$rollout" control-plane/control-api rpc-proxy/rpc-proxy
assert_loaded_matches_secrets

# The run dies (SIGKILL) after every Secret is written and before any restart:
# the marks survive, and the next plain run restarts exactly the changed ends.
seed_unstamped
rollout="$TMP/rollout-killed.log"
killed_exit=0
run_tokens_killable "$rollout" env CONTROL_API_INTERNAL_TOKEN_RPC="$WRC_OLD" || killed_exit=$?
[[ "$killed_exit" == "137" ]] || fail "the run was not killed (exit $killed_exit)"
assert_restarted_exactly "$rollout"
for secret in "${TOKEN_SECRETS[@]}"; do
  grep -qx "$secret" "$TMP/patches.log" || fail "Secret $secret was not written before the kill"
done
grep -q '\] Done\.$' "$TMP/stderr" && fail "a killed run must not reach Done."
[[ "$(stamp_of rpc-proxy/rpc-proxy)" == "restart-pending" ]] || fail "rpc-proxy lost its mark"
[[ "$(stamp_of control-plane/control-api)" == "restart-pending" ]] || fail "control-api lost its mark"
rollout="$TMP/rollout-killed-heals.log"
run_tokens gke-dev "$rollout" "" env || fail "the run after a killed run failed"
assert_restarted_exactly "$rollout" control-plane/control-api rpc-proxy/rpc-proxy
assert_loaded_matches_secrets

# Half-applied run on unstamped consumers for every caller (control-api already
# holds the new token in its map and flat list, the caller's Secret does not):
# both ends count as changed, so control-api and that caller restart, nothing
# else.
caller_index=0
for caller in "${SERVICE_TOKEN_CALLERS[@]}"; do
  IFS='|' read -r caller_env caller_consumer <<<"$caller"
  caller_index=$((caller_index + 1))
  token_a="$(printf '%064x' $((0xD000 + caller_index)))"
  token_b="$(printf '%064x' $((0xE000 + caller_index)))"
  seed_unstamped
  run_tokens gke-dev "$TMP/rollout-setup.log" "" env "$caller_env=$token_a" || fail "half-applied setup A failed"
  case "$caller_consumer" in
    profiles/external-rest-api) caller_secret="profiles external-rest-api-secrets EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN" ;;
    rpc-proxy/rpc-proxy) caller_secret="rpc-proxy rpc-proxy-secrets RPC_PROXY_CONTROL_API_SERVICE_TOKEN" ;;
    webhook-ingress/webhook-proxy) caller_secret="webhook-ingress webhook-proxy-secrets WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN" ;;
    control-plane/codex-llm-proxy) caller_secret="control-plane codex-llm-proxy-secrets CODEX_LLM_PROXY_CONTROL_API_TOKEN" ;;
    control-plane/grok-llm-proxy) caller_secret="control-plane grok-llm-proxy-secrets GROK_LLM_PROXY_CONTROL_API_TOKEN" ;;
    channels/clerum-workflow-approval-request-reader) caller_secret="channels workflow-approval-request-reader-credentials control-api-token" ;;
  esac
  run_tokens gke-dev "$TMP/rollout-setup.log" "" env "$caller_env=$token_b" || fail "half-applied setup B failed"
  # shellcheck disable=SC2086 # three words: namespace secret key
  store_set $caller_secret "$token_a"
  for consumer in "${ALL_TOKEN_CONSUMERS[@]}"; do unstamp "$consumer"; done
  rollout="$TMP/rollout-half-applied-$caller_index.log"
  run_tokens gke-dev "$rollout" "" env "$caller_env=$token_b" || fail "half-applied run for $caller_consumer failed"
  assert_restarted_exactly "$rollout" control-plane/control-api "$caller_consumer"
  if [[ "$caller_consumer" == channels/clerum-workflow-approval-request-reader ]]; then
    grep -qF 'Recording token stamp on channels/channel-reader-stubhost: tokens unchanged, no restart' "$TMP/stderr" \
      || fail "the channel-reader must only be stamped when the reader's control-api token is half-applied"
  fi
  assert_loaded_matches_secrets
done

# A caller's Secret rotated out of band on an unstamped cluster:
# control-api's map does not hold it yet, so both ends restart and the map
# entry is updated.
caller_index=0
for caller in "${SERVICE_TOKEN_CALLERS[@]}"; do
  IFS='|' read -r caller_env caller_consumer <<<"$caller"
  caller_index=$((caller_index + 1))
  token_oob="$(printf '%064x' $((0xF000 + caller_index)))"
  seed_unstamped
  case "$caller_consumer" in
    profiles/external-rest-api) caller_secret="profiles external-rest-api-secrets EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN"; map_name=external-rest-api ;;
    rpc-proxy/rpc-proxy) caller_secret="rpc-proxy rpc-proxy-secrets RPC_PROXY_CONTROL_API_SERVICE_TOKEN"; map_name=rpc-proxy ;;
    webhook-ingress/webhook-proxy) caller_secret="webhook-ingress webhook-proxy-secrets WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN"; map_name=webhook-proxy ;;
    control-plane/codex-llm-proxy) caller_secret="control-plane codex-llm-proxy-secrets CODEX_LLM_PROXY_CONTROL_API_TOKEN"; map_name=codex-llm-proxy ;;
    control-plane/grok-llm-proxy) caller_secret="control-plane grok-llm-proxy-secrets GROK_LLM_PROXY_CONTROL_API_TOKEN"; map_name=grok-llm-proxy ;;
    channels/clerum-workflow-approval-request-reader) caller_secret="channels workflow-approval-request-reader-credentials control-api-token"; map_name=workflow-approval-reader ;;
  esac
  # shellcheck disable=SC2086 # three words: namespace secret key
  store_set $caller_secret "$token_oob"
  rollout="$TMP/rollout-oob-unstamped-$caller_index.log"
  run_tokens gke-dev "$rollout" "" env || fail "out-of-band run for unstamped $caller_consumer failed"
  assert_restarted_exactly "$rollout" control-plane/control-api "$caller_consumer"
  [[ ",$(store_get control-plane control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS)," == *",$map_name=$token_oob,"* ]] \
    || fail "control-api's map was not updated for $map_name"
  assert_loaded_matches_secrets
done

# The stamp-only write fails on an unstamped, unchanged consumer: no restart is
# owed, the run fails naming it, and the next run records the stamp.
seed_unstamped
rollout="$TMP/rollout-stamp-only-fails.log"
if run_tokens gke-dev "$rollout" "" env KUBE_ANNOTATE_FAIL="rpc-proxy/rpc-proxy"; then
  fail "a failed stamp-only write must fail the run"
fi
grep -qF 'cannot write the token stamp on rpc-proxy/rpc-proxy; the next run records it' "$TMP/stderr" \
  || fail "missing stamp-only write error line"
assert_pending rpc-proxy/rpc-proxy
assert_restarted_exactly "$rollout"
grep -qF 'Recording token stamp on control-plane/control-api: tokens unchanged, no restart' "$TMP/stderr" \
  || fail "the other consumers were not stamped"
rollout="$TMP/rollout-stamp-only-heals.log"
run_tokens gke-dev "$rollout" "" env || fail "the run after a failed stamp-only write failed"
assert_restarted_exactly "$rollout"
grep -qF 'Recording token stamp on rpc-proxy/rpc-proxy: tokens unchanged, no restart' "$TMP/stderr" \
  || fail "rpc-proxy's stamp was not recorded on the next run"
[[ "$(stamp_of rpc-proxy/rpc-proxy)" =~ ^[0-9a-f]{64}$ ]] || fail "rpc-proxy has no stamp"
assert_loaded_matches_secrets

# Restore a fully stamped cluster for the cases below.
seed_unstamped
run_tokens gke-dev "$TMP/rollout-restamp.log" "" env || fail "re-stamp run failed"

# --- Hand-off from a key rotation to the token step ---
# A key-consumer restart that stays pending is marked on the token stamp
# (restart-jwt-key-consumers.sh); the next plain token run restarts exactly it.
: > "$TMP/rollout-key-walk.log"; : > "$TMP/annotations.log"
key_rc=0
PATH="$TMP/bin:$PATH" KUBE_STORE="$TMP/store" ROLLOUT_LOG="$TMP/rollout-key-walk.log" \
  PATCH_LOG="$TMP/patches.log" ANNOTATE_LOG="$TMP/annotations.log" FLAKY_STATE="$TMP/flaky" \
  CONTEXT=gke-dev JWT_KEY_RESTART_RETRY_SECONDS=0 KUBE_ROLLOUT_FAIL="rpc-proxy/rpc-proxy" \
  bash -c 'source "$1"; restart_jwt_key_consumers kubectl --context gke-dev' _ \
  "$ROOT/deploy/scripts/lib/restart-jwt-key-consumers.sh" >"$TMP/stdout" 2>"$TMP/stderr" </dev/null || key_rc=$?
assert_no_secret_material
[[ "$key_rc" == "1" ]] || fail "a pending key-consumer restart must fail the walk (exit $key_rc)"
grep -qF 'rpc-proxy/rpc-proxy marked restart-pending: the next apply-inter-service-tokens.sh run restarts it.' \
  "$TMP/stderr" || fail "rpc-proxy was not handed to the token step"
grep -qx 'control-plane/control-api' "$TMP/rollout-key-walk.log" || fail "the key walk did not run"
[[ "$(stamp_of rpc-proxy/rpc-proxy)" == "restart-pending" ]] || fail "rpc-proxy has no restart-pending token stamp"
rollout="$TMP/rollout-key-handoff.log"
run_tokens gke-dev "$rollout" "" env || fail "the token run after a key hand-off failed"
assert_restarted_exactly "$rollout" rpc-proxy/rpc-proxy
assert_loaded_matches_secrets

# --- Stamp library: the recovery commands run as printed without CONTEXT ---
STAMP_LIB="$ROOT/deploy/scripts/lib/token-consumer-stamp.sh"
mkdir -p "$TMP/argv-bin"
cat > "$TMP/argv-bin/kubectl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${KUBECTL_ARGV_LOG:?}"
SH
chmod +x "$TMP/argv-bin/kubectl"
report_rc=0
bash -c 'log() { printf "%s\n" "$*" >&2; }; source "$1"; TOKEN_RESTART_PENDING=(rpc-proxy/rpc-proxy channels/app=channel-reader); token_stamp_fail_if_pending ""' \
  _ "$STAMP_LIB" 2>"$TMP/report.err" || report_rc=$?
[[ "$report_rc" == "1" ]] || fail "a pending report must return 1 (got $report_rc)"
grep '^  kubectl ' "$TMP/report.err" > "$TMP/report-commands" \
  || fail "no recovery command was printed: $(cat "$TMP/report.err")"
[[ "$(wc -l < "$TMP/report-commands" | tr -d ' ')" == "2" ]] \
  || fail "expected two printed recovery commands, got: $(cat "$TMP/report.err")"
: > "$TMP/kubectl-argv.log"
while IFS= read -r command; do
  command="${command#  }"
  command_rc=0
  (cd "$TMP" && PATH="$TMP/argv-bin:$PATH" KUBECTL_ARGV_LOG="$TMP/kubectl-argv.log" bash -c "$command") \
    </dev/null 2>"$TMP/command.err" || command_rc=$?
  [[ "$command_rc" == "0" ]] || fail "the printed command '$command' does not run: $(cat "$TMP/command.err")"
done < "$TMP/report-commands"
[[ "$(cat "$TMP/kubectl-argv.log")" == "$(printf '%s\n' \
  '-n rpc-proxy rollout restart deploy rpc-proxy' \
  '-n channels rollout restart deploy -l app=channel-reader')" ]] \
  || fail "the printed commands ran other kubectl arguments: $(cat "$TMP/kubectl-argv.log")"
# An unknown changed-in-run value is refused before any kubectl call.
mark_rc=0
bash -c 'log() { printf "%s\n" "$*" >&2; }; kctl() { exit 9; }; source "$1"; token_stamp_mark_pending a ns dep bogus' \
  _ "$STAMP_LIB" 2>"$TMP/mark.err" || mark_rc=$?
[[ "$mark_rc" == "1" ]] || fail "an invalid changed-in-run value must return 1 (got $mark_rc)"
grep -qF 'ERROR: invalid changed-in-run value for ns/dep; no Secret was written' "$TMP/mark.err" \
  || fail "missing invalid changed-in-run line"

# HCC rebuilt a channel-reader Deployment without the stamp: it is re-stamped.
unstamp channels/channel-reader-stubhost
rollout="$TMP/rollout-rebuilt-channel-reader.log"
run_tokens gke-dev "$rollout" "" env
assert_restarted_exactly "$rollout"
assert_all_stamped
assert_loaded_matches_secrets

# FORCE_CONSUMER_RESTART=true restarts every consumer although nothing changed.
rollout="$TMP/rollout-force.log"
run_tokens gke-dev "$rollout" "" env FORCE_CONSUMER_RESTART=true
assert_restarted_exactly "$rollout" "${ALL_TOKEN_CONSUMERS[@]}"
if grep -q 'tokens unchanged' "$TMP/stderr"; then
  fail "FORCE_CONSUMER_RESTART must not skip any consumer"
fi
assert_loaded_matches_secrets

# --- InternalControl JWT HMACs (WRC / HCC share one Secret) ---

store_set control-plane internal-control-jwt-secrets INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET "$HCC_OLD"
store_set control-plane internal-control-jwt-secrets INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET "$WRC_OLD"
# Bring the stamps in line with these values.
run_tokens gke-dev "$TMP/rollout-hmac-setup.log" "" env

# Overrides equal to the stored values: nothing restarts.
rollout="$TMP/rollout-hmac-unchanged.log"
run_tokens gke-dev "$rollout" "" env \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_OLD" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_OLD"
assert_restarted_exactly "$rollout"
assert_noop_witness
assert_loaded_matches_secrets

# Dominant CI redeploy path: no HMAC override, values preserved from the Secret.
rollout="$TMP/rollout-hmac-preserve.log"
run_tokens gke-dev "$rollout" "" env \
  -u INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET \
  -u INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET
assert_restarted_exactly "$rollout"
assert_noop_witness
assert_loaded_matches_secrets

# HCC HMAC rotated: HCC and control-api, not WRC.
rollout="$TMP/rollout-hcc-rotated.log"
run_tokens gke-dev "$rollout" "" env \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_NEW" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_OLD"
assert_restarted_exactly "$rollout" control-plane/control-api control-plane/host-context-controller
grep -q 'Rolling deployment control-plane/host-context-controller' "$TMP/stderr" || fail "HCC roll line missing"
assert_loaded_matches_secrets

# WRC-only rotation: WRC and control-api, HCC skipped.
rollout="$TMP/rollout-wrc-only.log"
run_tokens gke-dev "$rollout" "" env \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_NEW" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_NEW"
assert_restarted_exactly "$rollout" control-plane/control-api control-plane/workflow-recipes
grep -qF 'Skipping rollout of control-plane/host-context-controller: tokens unchanged' "$TMP/stderr" \
  || fail "HCC skip line missing on WRC-only rotation"
assert_loaded_matches_secrets

# HCC key absent before the run: HCC restarts.
store_delete control-plane internal-control-jwt-secrets INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET
rollout="$TMP/rollout-hcc-empty-before.log"
run_tokens gke-dev "$rollout" "" env INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_OLD"
assert_restarted_exactly "$rollout" control-plane/control-api control-plane/host-context-controller
assert_loaded_matches_secrets

# --- No consumer deployed yet (first apply before any workload) ---
new_store
rollout="$TMP/rollout-no-deployments.log"
run_tokens gke-dev "$rollout" "" env FORCE_CONSUMER_RESTART=true CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET="$MEMBER_HMAC"
assert_restarted_exactly "$rollout"
grep -q '\] Done\.$' "$TMP/stderr" || fail "run without deployments did not reach Done."
grep -qF 'Skipping rollout of channels/app=channel-reader: none deployed' "$TMP/stderr" \
  || fail "missing channel-reader none-deployed line"
for consumer in "${ALL_TOKEN_CONSUMERS[@]:0:9}"; do
  grep -qF "Skipping rollout of ${consumer}: not deployed yet" "$TMP/stderr" \
    || fail "missing not-deployed line for $consumer"
done

# --- apply-workflow-approval-bot-secret.sh ---

READER=channels/clerum-workflow-approval-request-reader
READER_SKIP="Skipping rollout of ${READER}: tokens unchanged"

new_cluster
rollout="$TMP/rollout-bot-first.log"
run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET
assert_restarted_exactly "$rollout" "$READER"
assert_openssl_rand_calls 1
[[ "$(stamp_of "$READER" "$BOT_STAMP_KEY")" =~ ^[0-9a-f]{64}$ ]] || fail "reader has no bot-secret stamp"
assert_loaded_matches_secrets

rollout="$TMP/rollout-bot-noop.log"
run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET
assert_restarted_exactly "$rollout"
grep -qF "$READER_SKIP" "$TMP/stderr" || fail "bot-secret skip line missing"
grep -qx 'channels/workflow-approval-request-reader-credentials' "$TMP/patches.log" \
  || fail "bot-secret no-op run did not patch the reader Secret"
grep -q '\] Done\.$' "$TMP/stderr" || fail "bot-secret script did not reach Done."
assert_openssl_rand_calls 0
assert_settled_checked 1
assert_loaded_matches_secrets

# The webhook secret's change check reads it once more after resolving it; one
# failing read there is retried and the run stays a no-op.
spec="channels/workflow-approval-request-reader-credentials/telegram-webhook-secret#2"
rollout="$TMP/rollout-bot-read-site.log"
run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET KUBE_SECRET_READ_FLAKE="$spec" \
  || fail "a transient read failure of the webhook secret failed the bot run"
assert_read_injected "$spec"
assert_restarted_exactly "$rollout"
grep -qF "$READER_SKIP" "$TMP/stderr" || fail "bot-secret skip line missing"
grep -q '\] Done\.$' "$TMP/stderr" || fail "bot-secret script did not reach Done."
[[ ! -s "$TMP/annotations.log" ]] || fail "a bot no-op must not rewrite any stamp"
assert_openssl_rand_calls 0
assert_settled_checked 1
assert_loaded_matches_secrets

# Census of the bot's Secret reads, then one run per read with that read
# failing once: every run stays a no-op.
rollout="$TMP/rollout-bot-read-census.log"
run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET || fail "the bot census run failed"
bot_reads="$(awk '{n[$0]++; print $0 "#" n[$0]}' "$TMP/secret-reads.log")"
[[ "$(printf '%s\n' "$bot_reads" | sed '/^$/d' | wc -l | tr -d ' ')" == "2" ]] \
  || fail "the bot census expected 2 Secret reads, saw: $bot_reads"
while IFS= read -r spec; do
  rollout="$TMP/rollout-bot-read-flake.log"
  run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET KUBE_SECRET_READ_FLAKE="$spec" \
    || fail "a transient Secret read failure ($spec) failed the bot run"
  assert_read_injected "$spec"
  assert_restarted_exactly "$rollout"
  grep -qF "$READER_SKIP" "$TMP/stderr" || fail "bot-secret skip line missing"
  [[ ! -s "$TMP/annotations.log" ]] || fail "a bot no-op must not rewrite any stamp"
  assert_openssl_rand_calls 0
  assert_settled_checked 1
done <<<"$bot_reads"
assert_loaded_matches_secrets

# The reader's Secret cannot be read: the bot run stops before writing.
webhook_before="$(store_get channels workflow-approval-request-reader-credentials telegram-webhook-secret)"
rollout="$TMP/rollout-bot-secret-unreadable.log"
if run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET \
     KUBE_SECRET_READ_FAIL=channels/workflow-approval-request-reader-credentials; then
  fail "an unreadable reader Secret must fail the bot run"
fi
[[ "$(grep -c '^channels/workflow-approval-request-reader-credentials/' "$TMP/secret-reads.log.injected")" == "3" ]] \
  || fail "the reader Secret read was not attempted three times"
grep -qF 'cannot read Secret channels/workflow-approval-request-reader-credentials; no Secret was written' "$TMP/stderr" \
  || fail "missing bot Secret read error line"
[[ ! -s "$TMP/patches.log" ]] || fail "no Secret may be written after a failed bot Secret read"
[[ ! -s "$TMP/annotations.log" ]] || fail "the reader may not be marked after a failed bot Secret read"
assert_openssl_rand_calls 0
assert_restarted_exactly "$rollout"
[[ "$(store_get channels workflow-approval-request-reader-credentials telegram-webhook-secret)" == "$webhook_before" ]] \
  || fail "the webhook secret changed although the bot run stopped before writing"

# The webhook secret resolves, then its second read (the change check) fails on
# every attempt: the bot run stops before marking or writing anything.
spec_key="channels/workflow-approval-request-reader-credentials/telegram-webhook-secret"
secrets_before="$(secrets_digest)"
rollout="$TMP/rollout-bot-check-unreadable.log"
if run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET \
     KUBE_SECRET_READ_FLAKE="$spec_key#2 $spec_key#3 $spec_key#4"; then
  fail "a webhook-secret change check that cannot read its Secret must fail the bot run"
fi
assert_read_injected "$spec_key#4"
[[ "$(grep -c "^$spec_key#" "$TMP/secret-reads.log.injected")" == "3" ]] \
  || fail "the webhook-secret change check was not attempted three times"
grep -qF 'cannot read Secret channels/workflow-approval-request-reader-credentials; no Secret was written' "$TMP/stderr" \
  || fail "missing bot Secret read error line for the change check"
[[ ! -s "$TMP/patches.log" ]] || fail "no Secret may be written after a failed webhook-secret change check"
[[ ! -s "$TMP/annotations.log" ]] || fail "the reader may not be marked after a failed webhook-secret change check"
assert_openssl_rand_calls 0
assert_restarted_exactly "$rollout"
[[ "$(secrets_digest)" == "$secrets_before" ]] || fail "a Secret value changed although the bot change check failed"

# The two scripts keep separate stamps on the reader: the token script's run
# neither reads nor rewrites the bot-secret stamp.
bot_stamp_before="$(stamp_of "$READER" "$BOT_STAMP_KEY")"
run_tokens gke-dev "$TMP/rollout-tokens-on-reader.log" "" env CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET="$MEMBER_HMAC"
[[ "$(stamp_of "$READER" "$BOT_STAMP_KEY")" == "$bot_stamp_before" ]] || fail "the token script changed the bot-secret stamp"
[[ "$(stamp_of "$READER")" =~ ^[0-9a-f]{64}$ ]] || fail "reader has no token stamp"
rollout="$TMP/rollout-bot-after-tokens.log"
run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET
assert_restarted_exactly "$rollout"
assert_loaded_matches_secrets

rollout="$TMP/rollout-bot-rotated.log"
run_bot_secret "$rollout" env WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET="$ROTATED"
assert_restarted_exactly "$rollout" "$READER"
[[ "$(store_get channels workflow-approval-request-reader-credentials telegram-webhook-secret)" == "$ROTATED" ]] \
  || fail "rotated telegram-webhook-secret was not written"
assert_loaded_matches_secrets

# A failed reader restart heals on the next plain run.
rollout="$TMP/rollout-bot-fails.log"
if run_bot_secret "$rollout" env WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET="$HCC_OLD" KUBE_ROLLOUT_FAIL="$READER"; then
  fail "a failed reader restart must fail the bot-secret run"
fi
assert_restarted_exactly "$rollout"
assert_pending "$READER"
rollout="$TMP/rollout-bot-heals.log"
run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET || fail "the bot-secret healing run failed"
assert_restarted_exactly "$rollout" "$READER"
assert_loaded_matches_secrets

# The same with no bot-secret stamp on the reader: it is marked before the
# write, so the next plain run restarts it.
unstamp "$READER" "$BOT_STAMP_KEY"
rollout="$TMP/rollout-bot-unstamped-fails.log"
if run_bot_secret "$rollout" env WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET="$WRC_NEW" KUBE_ROLLOUT_FAIL="$READER"; then
  fail "a failed restart of the unstamped reader must fail the bot-secret run"
fi
assert_restarted_exactly "$rollout"
assert_pending "$READER"
[[ "$(stamp_of "$READER" "$BOT_STAMP_KEY")" == "restart-pending" ]] || fail "the unstamped reader was not marked"
rollout="$TMP/rollout-bot-unstamped-heals.log"
run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET || fail "the unstamped reader healing run failed"
assert_restarted_exactly "$rollout" "$READER"
[[ "$(stamp_of "$READER" "$BOT_STAMP_KEY")" =~ ^[0-9a-f]{64}$ ]] || fail "the reader has no bot-secret stamp after healing"
assert_loaded_matches_secrets

store_set channels workflow-approval-request-reader-credentials telegram-webhook-secret replace-with-telegram-secret
rollout="$TMP/rollout-bot-placeholder.log"
run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET
assert_restarted_exactly "$rollout" "$READER"
assert_openssl_rand_calls 1
assert_loaded_matches_secrets

rollout="$TMP/rollout-bot-force.log"
run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET FORCE_CONSUMER_RESTART=true
assert_restarted_exactly "$rollout" "$READER"
if grep -qF "$READER_SKIP" "$TMP/stderr"; then
  fail "FORCE_CONSUMER_RESTART must not skip the reader"
fi
assert_loaded_matches_secrets

# --- deploy/base contract: token Secrets ship an empty stringData canary ---
# A value in a base manifest is re-applied by every `kubectl apply` (server-side
# and client-side), overwriting the token this script patched.
canary_checked=0
for pair in "${TOKEN_SECRETS[@]}"; do
  secret="${pair#*/}"
  while IFS= read -r manifest; do
    verdict="$(awk -v name="$secret" '
      /^---/ { if (is_secret && named) print (bad ? "BAD" : "OK"); is_secret=0; named=0; bad=0; in_sd=0; next }
      /^kind: Secret/ { is_secret=1 }
      $0 ~ "^  name: " name "$" { named=1 }
      /^stringData:/ { in_sd=1; if ($0 !~ /\{\}[[:space:]]*$/) bad=1; next }
      /^data:/ { bad=1 }
      in_sd && /^  [^ ]/ { bad=1 }
      /^[^ ]/ && !/^stringData:/ { in_sd=0 }
      END { if (is_secret && named) print (bad ? "BAD" : "OK") }
    ' "$manifest")"
    case "$verdict" in
      *BAD*) fail "$manifest ships a value for $secret; base token Secrets must use stringData: {}" ;;
      *OK*) canary_checked=$((canary_checked + 1)) ;;
    esac
  done < <(grep -rl --include='*.yaml' -E "^  name: ${secret}\$" "$ROOT/deploy/base" || true)
done
[[ "$canary_checked" -ge 6 ]] || fail "expected at least 6 token Secrets declared in deploy/base, checked $canary_checked"

echo "inter-service token and bot-secret restart tests passed"
