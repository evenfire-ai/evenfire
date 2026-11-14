#!/usr/bin/env bash
# Existing Contexts belong to the user after bootstrap, even when kubectl's
# last-applied annotation still records the original empty connector list.
# jq programs use single quotes so their variables are not expanded by Bash.
# shellcheck disable=SC2016
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRIPT="${PROVISION_GFS_RUNTIME_SCRIPT:-$ROOT/deploy/scripts/provision-gfs-runtime.sh}"
JQ="$(command -v jq)"
TEST_CONTEXT="clerum-context-preservation-test"
export TEST_CONTEXT
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/overlay/instances"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$*"; }

# JSON is valid Kubernetes manifest input. The kubectl stub owns decoding and
# API state; the provisioner still has to handle both real dry-run JSON shapes.
cat >"$TMP/overlay/instances/01-context.json" <<'JSON'
{"apiVersion":"clerum.io/v1alpha1","kind":"Context","metadata":{"name":"context1","namespace":"mcp-server","labels":{"managed-by":"bootstrap"}},"spec":{"contextId":"context1","description":"declarative description","mcpServers":[]}}
JSON
cat >"$TMP/overlay/instances/02-context.json" <<'JSON'
{"apiVersion":"clerum.io/v1alpha1","kind":"Context","metadata":{"name":"context2","namespace":"another-team","labels":{"owner":"bootstrap"},"annotations":{"fixture.example/owner":"bootstrap"}},"spec":{"contextId":"context2","description":"new context","mcpServers":["bootstrap-tools"]}}
JSON
cat >"$TMP/overlay/instances/03-host.json" <<'JSON'
{"apiVersion":"clerum.io/v1alpha1","kind":"Host","metadata":{"name":"chatllm","namespace":"mcp-host"},"spec":{"host":"chatLLM","contextRef":"context1"}}
JSON
cat >"$TMP/overlay/instances/04-channel.json" <<'JSON'
{"apiVersion":"clerum.io/v1alpha1","kind":"CommunicationChannel","metadata":{"name":"fixture-channel","namespace":"channels"},"spec":{"type":"fixture"}}
JSON
cat >"$TMP/overlay/instances/05-gfs.json" <<'JSON'
{"apiVersion":"clerum.io/v1alpha1","kind":"GlobalFileSystem","metadata":{"name":"fixture-gfs","namespace":"gfs"},"spec":{"storage":{"size":"1Gi"}}}
JSON

cat >"$TMP/bin/kubectl" <<'STUB'
#!/bin/bash
set -euo pipefail
: "${TEST_STATE:?}" "${TEST_CALLS:?}" "${TEST_MUTATIONS:?}" "${TEST_JQ:?}"
printf '%s\n' "$*" >>"$TEST_CALLS"

verb='' context='' namespace='' file='' output='' dry_run=false
ignore_missing=false save_config=false patch='' patch_type=merge
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --context) context="$2"; shift 2 ;;
    --context=*) context="${1#*=}"; shift ;;
    -n|--namespace) namespace="$2"; shift 2 ;;
    --namespace=*) namespace="${1#*=}"; shift ;;
    -f|--filename) file="$2"; shift 2 ;;
    --filename=*) file="${1#*=}"; shift ;;
    -o|--output) output="$2"; shift 2 ;;
    --output=*) output="${1#*=}"; shift ;;
    --dry-run=client) dry_run=true; shift ;;
    --dry-run) [ "$2" = client ]; dry_run=true; shift 2 ;;
    --ignore-not-found|--ignore-not-found=true) ignore_missing=true; shift ;;
    --type) patch_type="$2"; shift 2 ;;
    --type=*) patch_type="${1#*=}"; shift ;;
    -p|--patch) patch="$2"; shift 2 ;;
    --patch=*) patch="${1#*=}"; shift ;;
    --patch-file) patch="$(cat "$2")"; shift 2 ;;
    --field-manager) shift 2 ;;
    --field-manager=*|--validate=*) shift ;;
    --save-config) save_config=true; shift ;;
    --*) printf 'fixture: unsupported flag %s\n' "$1" >&2; exit 90 ;;
    *)
      if [ -z "$verb" ]; then verb="$1"; else args+=("$1"); fi
      shift ;;
  esac
done
[ "$context" = "$TEST_CONTEXT" ] || {
  printf 'fixture: missing or incorrect explicit context\n' >&2
  exit 91
}

manifests() {
  if [ "$file" = - ]; then
    cat
  elif [ -d "$file" ]; then
    cat "$file"/*.json
  else
    cat "$file"
  fi | "$TEST_JQ" -cs '[.[] | if .kind == "List" then .items[] else . end]'
}

kind_for() {
  case "${1%%.*}" in
    Context|context|contexts) printf Context ;;
    Host|host|hosts) printf Host ;;
    CommunicationChannel|communicationchannel|communicationchannels) printf CommunicationChannel ;;
    GlobalFileSystem|globalfilesystem|globalfilesystems) printf GlobalFileSystem ;;
    *) printf '%s' "$1" ;;
  esac
}

lookup() {
  "$TEST_JQ" -c --arg kind "$1" --arg ns "$2" --arg name "$3" \
    '.[] | select(.kind == $kind and (.metadata.namespace // "default") == $ns and .metadata.name == $name)' "$TEST_STATE"
}

save_object() {
  local object="$1"
  "$TEST_JQ" --argjson object "$object" \
    '[.[] | select(.kind != $object.kind or .metadata.name != $object.metadata.name or (.metadata.namespace // "default") != ($object.metadata.namespace // "default"))] + [$object]' \
    "$TEST_STATE" >"$TEST_STATE.next"
  mv "$TEST_STATE.next" "$TEST_STATE"
}

advance_version() {
  "$TEST_JQ" -c '.metadata.resourceVersion = (((.metadata.resourceVersion // "0") | tonumber) + 1 | tostring)'
}

concurrent_add() {
  local live
  live="$(lookup Context mcp-server context1)"
  live="$(printf '%s\n' "$live" | "$TEST_JQ" -c '.spec.mcpServers += ["ui-concurrent-tools"]' | advance_version)"
  save_object "$live"
  : >"$TEST_STATE.raced"
}

not_found() {
  $ignore_missing && exit 0
  printf 'Error from server (NotFound): %s "%s" not found\n' "$1" "$2" >&2
  exit 1
}

if [ "$verb" = create ] && $dry_run; then
  [ "$output" = json ] || exit 92
  if [ "$TEST_FAILURE" = render ]; then
    printf 'fixture: injected manifest render failure\n' >&2
    exit 1
  fi
  objects="$(manifests)"
  if [ "$TEST_RENDER" = list ]; then
    printf '%s\n' "$objects" | "$TEST_JQ" '{apiVersion:"v1",kind:"List",items:.}'
  else
    printf '%s\n' "$objects" | "$TEST_JQ" '.[]'
  fi
  exit 0
fi

if [ "$verb" = get ] || [ "$verb" = patch ]; then
  if [ -n "$file" ]; then
    object="$(manifests | "$TEST_JQ" -ce 'if length == 1 then .[0] else error("expected one resource") end')"
    resource="$(printf '%s\n' "$object" | "$TEST_JQ" -r '.kind')"
    name="$(printf '%s\n' "$object" | "$TEST_JQ" -r '.metadata.name')"
    namespace="$(printf '%s\n' "$object" | "$TEST_JQ" -r --arg ns "${namespace:-default}" '.metadata.namespace // $ns')"
  else
    resource="${args[0]:-}"
    name="${args[1]:-}"
  fi
  if [[ "$resource" == */* ]]; then name="${resource#*/}"; resource="${resource%%/*}"; fi
  kind="$(kind_for "$resource")"
  namespace="${namespace:-default}"

  # Required platform resources exist; fixture-gfs is deliberately not gfs, so
  # the final credential reconciler has no GFS runtime to mutate in this test.
  case "$resource" in
    crd|role|rolebinding|networkpolicy) [ "$verb" = get ]; exit 0 ;;
  esac
  if [ "$verb" = get ] && [ "$kind/$namespace/$name" = Context/mcp-server/context1 ] && [ "$TEST_FAILURE" = read ]; then
    printf 'fixture: injected Context read failure (Forbidden)\n' >&2
    exit 1
  fi
  live="$(lookup "$kind" "$namespace" "$name")"
  [ -n "$live" ] || not_found "$resource" "$name"
  if [ "$verb" = get ]; then
    # Return the snapshot read by this request, then model an independent UI
    # update before the provisioner's next API operation.
    if [ "$TEST_RACE" = read ] && [ "$kind/$namespace/$name" = Context/mcp-server/context1 ] && [ ! -f "$TEST_STATE.raced" ]; then
      concurrent_add
    fi
    case "$output" in
      json|'') printf '%s\n' "$live" ;;
      name) printf '%s/%s\n' "$resource" "$name" ;;
      *) printf 'fixture: unsupported get output %s\n' "$output" >&2; exit 93 ;;
    esac
    exit 0
  fi

  # JSON Patch test failures are atomic conflicts. JSON Merge Patch is also
  # supported so the fixture does not require one production patch transport.
  if [ "$patch_type" = json ]; then
    if ! updated="$(printf '%s\n' "$live" | "$TEST_JQ" -ce --argjson operations "$patch" '
      reduce $operations[] as $op (. ;
        ($op.path | split("/")[1:] | map(gsub("~1"; "/") | gsub("~0"; "~"))) as $path |
        if $op.op == "test" then
          if getpath($path) == $op.value then . else error("test failed") end
        elif $op.op == "remove" then delpaths([$path])
        elif $op.op == "add" or $op.op == "replace" then setpath($path; $op.value)
        else error("unsupported JSON Patch operation") end)' 2>/dev/null)"; then
      printf 'Error from server (Conflict): the object has been modified\n' >&2
      exit 1
    fi
  elif [ "$patch_type" = merge ]; then
    updated="$(printf '%s\n' "$live" | "$TEST_JQ" -c --argjson patch "$patch" '
      def mergepatch($p):
        if ($p | type) != "object" then $p
        else reduce ($p | keys_unsorted[]) as $key (. ;
          if $p[$key] == null then del(.[$key])
          else .[$key] |= mergepatch($p[$key]) end) end;
      mergepatch($patch)')"
  else
    printf 'fixture: unsupported patch type %s\n' "$patch_type" >&2
    exit 94
  fi
  updated="$(printf '%s\n' "$updated" | advance_version)"
  save_object "$updated"
  printf 'patch\t%s\t%s\t%s\n' "$kind" "$namespace" "$name" >>"$TEST_MUTATIONS"
  printf '%s\n' "$updated"
  exit 0
fi

if [ "$verb" = create ] || [ "$verb" = apply ]; then
  objects="$(manifests)"
  while IFS= read -r desired; do
    kind="$(printf '%s\n' "$desired" | "$TEST_JQ" -r '.kind')"
    name="$(printf '%s\n' "$desired" | "$TEST_JQ" -r '.metadata.name')"
    ns="$(printf '%s\n' "$desired" | "$TEST_JQ" -r --arg ns "${namespace:-default}" '.metadata.namespace // $ns')"
    desired="$(printf '%s\n' "$desired" | "$TEST_JQ" -c --arg ns "$ns" '.metadata.namespace = $ns')"
    live="$(lookup "$kind" "$ns" "$name")"
    if [ "$kind/$ns/$name" = Context/another-team/context2 ] && [ -z "$live" ] && [ "$TEST_RACE" = create ]; then
      # Another actor wins immediately before this write. Create must fail;
      # apply would reconcile the winner and expose the clobber to the test.
      concurrent="$(printf '%s\n' "$desired" | "$TEST_JQ" -c '.spec.mcpServers = ["ui-racing-creator"] | .metadata.uid = "racing-creator-uid" | .metadata.resourceVersion = "1"')"
      save_object "$concurrent"
      : >"$TEST_STATE.raced"
      if [ "$verb" = create ]; then
        printf 'fixture: injected creation race (AlreadyExists)\n' >&2
        exit 1
      fi
      live="$concurrent"
    fi
    if [ "$kind/$ns/$name" = Context/another-team/context2 ] && [ -z "$live" ] && [ "$TEST_FAILURE" = create ]; then
      printf 'fixture: injected Context create failure (InternalError)\n' >&2
      exit 1
    fi
    if [ "$kind" = Host ] && [ "$TEST_FAILURE" = apply ]; then
      printf 'fixture: injected other-instance apply failure\n' >&2
      exit 1
    fi
    if [ "$verb" = create ] && [ -n "$live" ]; then
      printf 'Error from server (AlreadyExists): %s "%s" already exists\n' "$kind" "$name" >&2
      exit 1
    fi
    if [ -z "$live" ]; then
      updated="$(printf '%s\n' "$desired" | "$TEST_JQ" -c --arg uid "fixture-$kind-$ns-$name" '.metadata.uid = $uid | .metadata.resourceVersion = "0"')"
    else
      # Client-side apply removes fields present in last-applied and omitted
      # now. Arrays are atomic for these CRD fixtures, as mcpServers is in the
      # Context schema. Merely omitting the list without migrating ownership
      # therefore loses UI connectors and is a meaningful failing oracle.
      updated="$(printf '%s\n' "$live" | "$TEST_JQ" -c --argjson desired "$desired" '
        def apply3($old; $new; $current):
          if ($new | type) != "object" then $new
          else reduce (((($old // {}) | keys_unsorted) + ($new | keys_unsorted)) | unique[]) as $key
            ((if ($current | type) == "object" then $current else {} end);
              if $new | has($key) then .[$key] = apply3($old[$key]; $new[$key]; .[$key])
              elif ($old // {}) | has($key) then del(.[$key])
              else . end) end;
        (.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] // "{}" | fromjson) as $old |
        apply3($old; $desired; .)')"
    fi
    if [ "$verb" = apply ] || $save_config; then
      updated="$(printf '%s\n' "$updated" | "$TEST_JQ" -c --arg config "$desired" '.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] = $config')"
    fi
    updated="$(printf '%s\n' "$updated" | advance_version)"
    save_object "$updated"
    printf '%s\t%s\t%s\t%s\n' "$verb" "$kind" "$ns" "$name" >>"$TEST_MUTATIONS"
  done < <(printf '%s\n' "$objects" | "$TEST_JQ" -c '.[]')
  exit 0
fi

printf 'fixture: unsupported kubectl operation %s\n' "$verb" >&2
exit 95
STUB
chmod +x "$TMP/bin/kubectl"

init_case() {
  CASE_DIR="$TMP/$1"
  mkdir -p "$CASE_DIR"
  mkdir -p "$CASE_DIR/overlay/instances"
  cp "$TMP/overlay/instances/"*.json "$CASE_DIR/overlay/instances/"
  : >"$CASE_DIR/calls.log"
  : >"$CASE_DIR/mutations.log"
  "$JQ" -n --slurpfile context "$TMP/overlay/instances/01-context.json" \
    --slurpfile host "$TMP/overlay/instances/03-host.json" \
    --slurpfile channel "$TMP/overlay/instances/04-channel.json" \
    --slurpfile gfs "$TMP/overlay/instances/05-gfs.json" '
      [($context[0] |
          .metadata.uid = "existing-context-uid" |
          .metadata.resourceVersion = "7" |
          .metadata.labels["ui-label"] = "retained" |
          .metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] = ($context[0] | tojson) |
          .spec.description = "old description" |
          .spec.mcpServers = ["ui-calendar", "ui-drive"] |
          .status.phase = "Ready"),
       ($host[0] | .spec.contextRef = "obsolete"),
       ($channel[0] | .spec.type = "obsolete"),
       ($gfs[0] | .spec.storage.size = "obsolete")]' >"$CASE_DIR/state.json"
  remember_existing_context
}

remember_existing_context() {
  "$JQ" -S '.[] | select(.kind == "Context" and .metadata.name == "context1" and .metadata.namespace == "mcp-server")' \
    "$CASE_DIR/state.json" >"$CASE_DIR/expected-context.json"
}

run_provision() {
  TEST_STATE="$CASE_DIR/state.json" TEST_CALLS="$CASE_DIR/calls.log" \
    TEST_MUTATIONS="$CASE_DIR/mutations.log" TEST_JQ="$JQ" \
    TEST_RENDER="${RENDER:-stream}" \
    TEST_FAILURE="${FAILURE:-none}" TEST_RACE="${RACE:-none}" \
    ALLOWED_CONTEXTS="$TEST_CONTEXT" PATH="$TMP/bin:$PATH" \
    /bin/bash "$SCRIPT" --context "$TEST_CONTEXT" --overlay "$CASE_DIR/overlay" \
    --skip-auth-sync "$@" >"$CASE_DIR/output.log" 2>&1
}

expect_success() {
  if ! run_provision "$@"; then
    cat "$CASE_DIR/output.log" >&2
    fail "provisioning failed in $(basename "$CASE_DIR")"
  fi
}

assert_state() {
  "$JQ" -e --slurpfile expected "$CASE_DIR/expected-context.json" '
    map(select(.kind == "Context" and .metadata.name == "context1" and .metadata.namespace == "mcp-server"))[0] |
    . == $expected[0]' "$CASE_DIR/state.json" >/dev/null || fail 'existing Context changed after bootstrap'
  "$JQ" -e --slurpfile desired "$TMP/overlay/instances/02-context.json" '
    map(select(.kind == "Context" and .metadata.name == "context2" and .metadata.namespace == "another-team"))[0] |
    del(.metadata.uid, .metadata.resourceVersion, .metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"]) == $desired[0]' \
    "$CASE_DIR/state.json" >/dev/null || fail 'new Context did not retain all declared bootstrap values'
  for desired in "$TMP/overlay/instances/03-host.json" "$TMP/overlay/instances/04-channel.json" "$TMP/overlay/instances/05-gfs.json"; do
    "$JQ" -e --slurpfile desired "$desired" '
      map(select(.kind == $desired[0].kind and .metadata.name == $desired[0].metadata.name and .metadata.namespace == $desired[0].metadata.namespace))[0] |
      .spec == $desired[0].spec' "$CASE_DIR/state.json" >/dev/null || fail "other instance was not applied: $desired"
  done
}

for RENDER in stream list; do
  init_case "preserve-$RENDER"
  expect_success
  assert_state
  # A UI addition between deploys must survive the next application too.
  "$JQ" 'map(if .kind == "Context" and .metadata.name == "context1" then .spec.mcpServers += ["ui-added-later"] else . end)' \
    "$CASE_DIR/state.json" >"$CASE_DIR/state.next"
  mv "$CASE_DIR/state.next" "$CASE_DIR/state.json"
  remember_existing_context
  expect_success
  assert_state
  pass "Context connectors survive repeated provisioning with $RENDER dry-run JSON"
done

init_case no-last-applied
"$JQ" 'map(if .kind == "Context" and .metadata.name == "context1" then
  del(.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"]) |
  .spec.description = "declarative description" else . end)' \
  "$CASE_DIR/state.json" >"$CASE_DIR/state.next"
mv "$CASE_DIR/state.next" "$CASE_DIR/state.json"
remember_existing_context
expect_success
assert_state
pass 'existing Context without last-applied remains intact when declared fields match'

init_case no-last-applied-drift
"$JQ" 'map(if .kind == "Context" and .metadata.name == "context1" then
  del(.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"])
  else . end)' "$CASE_DIR/state.json" >"$CASE_DIR/state.next"
mv "$CASE_DIR/state.next" "$CASE_DIR/state.json"
cp "$CASE_DIR/state.json" "$CASE_DIR/before.json"
if run_provision; then
  fail 'unmanaged Context with declarative drift was accepted'
fi
grep -Fq 'explicit Context migration' "$CASE_DIR/output.log" || fail 'unmanaged drift did not report the required migration'
cmp -s "$CASE_DIR/before.json" "$CASE_DIR/state.json" || fail 'unmanaged drift rejection mutated instances'
pass 'existing Context without last-applied rejects declarative drift'

RENDER=stream
RACE="read"
init_case concurrent-read
"$JQ" '.spec.mcpServers += ["ui-concurrent-tools"] | .metadata.resourceVersion = "8"' \
  "$CASE_DIR/expected-context.json" >"$CASE_DIR/expected-context.next"
mv "$CASE_DIR/expected-context.next" "$CASE_DIR/expected-context.json"
expect_success
[ -f "$CASE_DIR/state.json.raced" ] || fail 'concurrent UI update was not exercised'
assert_state
pass 'concurrent UI addition after the existence read survives provisioning'

RACE=create
init_case concurrent-create
if run_provision; then
  fail 'creation race was reported as successful provisioning'
fi
[ -f "$CASE_DIR/state.json.raced" ] || fail 'concurrent creation was not exercised'
"$JQ" -e 'map(select(.kind == "Context" and .metadata.name == "context2" and .metadata.namespace == "another-team"))[0] |
  .metadata.uid == "racing-creator-uid" and .spec.mcpServers == ["ui-racing-creator"]' \
  "$CASE_DIR/state.json" >/dev/null || fail 'creation race overwrote the winning Context'
pass 'Context creation race fails without overwriting the winner'
RACE=none

init_case skip-instances
cp "$CASE_DIR/state.json" "$CASE_DIR/before.json"
expect_success --skip-instances
cmp -s "$CASE_DIR/before.json" "$CASE_DIR/state.json" || fail '--skip-instances changed instance state'
[ ! -s "$CASE_DIR/mutations.log" ] || fail '--skip-instances issued an instance mutation'
pass '--skip-instances preserves all instance state'

for GUARD in manifest annotation; do
  init_case "guard-$GUARD"
  if [ "$GUARD" = manifest ]; then
    "$JQ" '.spec.description = "changed bootstrap description"' \
      "$CASE_DIR/overlay/instances/01-context.json" >"$CASE_DIR/context.next"
    mv "$CASE_DIR/context.next" "$CASE_DIR/overlay/instances/01-context.json"
  else
    "$JQ" 'map(if .kind == "Context" and .metadata.name == "context1" then
      .metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] = "invalid-json"
      else . end)' "$CASE_DIR/state.json" >"$CASE_DIR/state.next"
    mv "$CASE_DIR/state.next" "$CASE_DIR/state.json"
  fi
  cp "$CASE_DIR/state.json" "$CASE_DIR/before.json"
  if run_provision; then
    fail "invalid Context $GUARD was reported as successful provisioning"
  fi
  grep -Fq 'explicit Context migration' "$CASE_DIR/output.log" || {
    cat "$CASE_DIR/output.log" >&2
    fail "$GUARD case did not report the required migration"
  }
  cmp -s "$CASE_DIR/before.json" "$CASE_DIR/state.json" || fail "$GUARD rejection mutated instances"
  pass "Context $GUARD divergence fails before instance mutation"
done

for FAILURE in render read create apply; do
  init_case "failure-$FAILURE"
  if run_provision; then
    fail "unexpected $FAILURE failure was reported as successful provisioning"
  fi
  grep -Fq 'fixture: injected' "$CASE_DIR/output.log" || {
    cat "$CASE_DIR/output.log" >&2
    fail "$FAILURE case failed without reaching the intended API error"
  }
  pass "unexpected $FAILURE error fails provisioning"
done

pass 'Context bootstrap preserves UI-owned connector state'
