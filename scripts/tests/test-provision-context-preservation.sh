#!/usr/bin/env bash
# mcp-server/context1 keeps user selections after bootstrap, even when kubectl's
# last-applied annotation still records the original empty connector list.
# jq programs use single quotes so their variables are not expanded by Bash.
# shellcheck disable=SC2016
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRIPT="${PROVISION_GFS_RUNTIME_SCRIPT:-$ROOT/deploy/scripts/provision-gfs-runtime.sh}"
JQ="$(command -v jq)"
TEST_BASH="${TEST_BASH:-/bin/bash}"
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
    --patch-file=*) patch="$(cat "${1#*=}")"; shift ;;
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

concurrent_connector_update() {
  local live
  live="$(lookup Context mcp-server context1)"
  if [ "$TEST_RACE" = read-remove ]; then
    live="$(printf '%s\n' "$live" | "$TEST_JQ" -c '.spec.mcpServers |= map(select(. != "ui-calendar"))' | advance_version)"
  else
    live="$(printf '%s\n' "$live" | "$TEST_JQ" -c '.spec.mcpServers += ["ui-concurrent-tools"]' | advance_version)"
  fi
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
  if [ "$verb" = get ] && [ "$kind/$namespace/$name" = Context/mcp-server/context1 ] && [ "$TEST_FAILURE" = read-with-stdout ]; then
    lookup Context mcp-server context1 | "$TEST_JQ" -c '{apiVersion:"v1",kind:"List",items:[.]}'
    printf 'fixture: injected Context read failure after output\n' >&2
    exit 1
  fi
  live="$(lookup "$kind" "$namespace" "$name")"
  if [ -z "$live" ]; then
    if [ "$verb" = get ] && [ "$kind" = Context ] && [ "$file" = - ] &&
       [ "${TEST_GET_RESPONSE:-list}" = empty-list ]; then
      printf '%s\n' '{"apiVersion":"v1","kind":"List","items":[]}'
      exit 0
    fi
    not_found "$resource" "$name"
  fi
  if [ "$verb" = get ]; then
    # Return the snapshot read by this request, then model an independent UI
    # update before the provisioner's next API operation.
    if { [ "$TEST_RACE" = read ] || [ "$TEST_RACE" = read-remove ]; } &&
       [ "$kind/$namespace/$name" = Context/mcp-server/context1 ] && [ ! -f "$TEST_STATE.raced" ]; then
      concurrent_connector_update
    fi
    case "$output" in
      json|'')
        if [ "$kind" = Context ] && [ -n "$file" ]; then
          [ "$file" = - ] && $ignore_missing && [ "$output" = json ] || {
            printf 'fixture: Context get must use -f - --ignore-not-found -o json\n' >&2
            exit 96
          }
          case "${TEST_GET_RESPONSE:-list}" in
            list) printf '%s\n' "$live" | "$TEST_JQ" -c '{apiVersion:"v1",kind:"List",items:[.]}' ;;
            empty-list) printf '%s\n' '{"apiVersion":"v1","kind":"List","items":[]}' ;;
            object) printf '%s\n' "$live" ;;
            multiple) printf '%s\n' "$live" | "$TEST_JQ" -c '{apiVersion:"v1",kind:"List",items:[.,.]}' ;;
            wrong-name) printf '%s\n' "$live" | "$TEST_JQ" -c '{apiVersion:"v1",kind:"List",items:[. | .metadata.name="different"]}' ;;
            wrong-namespace) printf '%s\n' "$live" | "$TEST_JQ" -c '{apiVersion:"v1",kind:"List",items:[. | .metadata.namespace="different"]}' ;;
            wrong-kind) printf '%s\n' "$live" | "$TEST_JQ" -c '{apiVersion:"v1",kind:"List",items:[. | .kind="Host"]}' ;;
            wrong-api) printf '%s\n' "$live" | "$TEST_JQ" -c '{apiVersion:"v1",kind:"List",items:[. | .apiVersion="other.example/v1"]}' ;;
            malformed) printf '%s\n' '{invalid-json' ;;
            invalid-items) printf '%s\n' '{"apiVersion":"v1","kind":"List","items":{}}' ;;
            null-items) printf '%s\n' '{"apiVersion":"v1","kind":"List","items":null}' ;;
            missing-items) printf '%s\n' '{"apiVersion":"v1","kind":"List"}' ;;
            null-item) printf '%s\n' '{"apiVersion":"v1","kind":"List","items":[null]}' ;;
            scalar-item) printf '%s\n' '{"apiVersion":"v1","kind":"List","items":["unexpected"]}' ;;
            nested) printf '%s\n' "$live" | "$TEST_JQ" -c '{apiVersion:"v1",kind:"List",items:[{apiVersion:"v1",kind:"List",items:[.]}]}' ;;
            wrong-list-api) printf '%s\n' "$live" | "$TEST_JQ" -c '{apiVersion:"v2",kind:"List",items:[.]}' ;;
            null) printf '%s\n' 'null' ;;
            whitespace) printf ' \t ' ;;
            two-documents) printf '%s\n%s\n' "$live" "$live" ;;
            *) printf 'fixture: unsupported Context get response\n' >&2; exit 97 ;;
          esac
        else
          printf '%s\n' "$live"
        fi ;;
      name) printf '%s/%s\n' "$resource" "$name" ;;
      *) printf 'fixture: unsupported get output %s\n' "$output" >&2; exit 93 ;;
    esac
    exit 0
  fi

  # A second deploy can change the baseline, or a replacement Context can
  # appear, between the provisioner's read and its annotation migration.
  if [ "$verb" = patch ] && [ "$kind/$namespace/$name" = Context/mcp-server/context1 ] &&
     { [ "$TEST_RACE" = baseline ] || [ "$TEST_RACE" = recreate ]; } &&
     [ ! -f "$TEST_STATE.raced" ]; then
    if [ "$TEST_RACE" = baseline ]; then
      live="$(printf '%s\n' "$live" | "$TEST_JQ" -c '
        .metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] |=
          (fromjson | .spec.description = "concurrent deploy" | tojson)')"
    else
      live="$(printf '%s\n' "$live" | "$TEST_JQ" -c '
        .metadata.uid = "replacement-uid" | .spec.mcpServers = ["replacement-tools"]')"
    fi
    live="$(printf '%s\n' "$live" | advance_version)"
    save_object "$live"
    : >"$TEST_STATE.raced"
  fi
  if [ "$verb" = patch ] && [ "$kind/$namespace/$name" = Context/mcp-server/context1 ] && [ "$TEST_FAILURE" = patch ]; then
    printf 'fixture: injected Context migration failure (Forbidden)\n' >&2
    exit 1
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
    if [ "$kind/$ns/$name" = Context/mcp-server/context1 ] && [ -z "$live" ] && [ "$TEST_RACE" = create ]; then
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
    if [ "$kind/$ns/$name" = Context/mcp-server/context1 ] && [ -z "$live" ] && [ "$TEST_FAILURE" = create ]; then
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
    TEST_GET_RESPONSE="${GET_RESPONSE:-list}" \
    ALLOWED_CONTEXTS="$TEST_CONTEXT" PATH="$TMP/bin:$PATH" \
    "$TEST_BASH" "$SCRIPT" --context "$TEST_CONTEXT" --overlay "$CASE_DIR/overlay" \
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
    .metadata.uid == $expected[0].metadata.uid and
    .spec.mcpServers == $expected[0].spec.mcpServers and
    .metadata.labels["ui-label"] == $expected[0].metadata.labels["ui-label"] and
    .status == $expected[0].status' "$CASE_DIR/state.json" >/dev/null ||
    fail 'existing context1 lost its identity, connectors, or unrelated live state'
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
  for GET_RESPONSE in list object; do
    init_case "preserve-$RENDER-$GET_RESPONSE"
    expect_success
    assert_state
    # A UI addition between deploys must survive the next application too.
    "$JQ" 'map(if .kind == "Context" and .metadata.name == "context1" then .spec.mcpServers += ["ui-added-later"] else . end)' \
      "$CASE_DIR/state.json" >"$CASE_DIR/state.next"
    mv "$CASE_DIR/state.next" "$CASE_DIR/state.json"
    remember_existing_context
    expect_success
    assert_state
    pass "Context connectors survive $RENDER dry-run and $GET_RESPONSE get JSON"
  done
done
GET_RESPONSE=list

# Only mcp-server/context1 has the new preservation policy. Existing Contexts
# with the same name in another namespace, or another name in the same
# namespace, continue through the normal apply path.
init_case other-contexts-apply
index=2
for identity in another-team/context2 another-team/context1 mcp-server/context2; do
  ns="${identity%/*}"
  name="${identity#*/}"
  desired="$CASE_DIR/overlay/instances/0${index}-other-context.json"
  "$JQ" --arg ns "$ns" --arg name "$name" \
    '.metadata.namespace = $ns | .metadata.name = $name | .spec.contextId = $name' \
    "$TMP/overlay/instances/02-context.json" >"$desired"
  "$JQ" --slurpfile desired "$desired" '
    . + [($desired[0] | .metadata.uid = "existing-other-context" |
      .metadata.resourceVersion = "7" |
      .metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] = ($desired[0] | tojson) |
      .spec.description = "user drift" | .spec.mcpServers = ["ui-only"])]' \
    "$CASE_DIR/state.json" >"$CASE_DIR/state.next"
  mv "$CASE_DIR/state.next" "$CASE_DIR/state.json"
  index=$((index + 4))
done
rm -- "$CASE_DIR/overlay/instances/02-context.json"
expect_success
for identity in another-team/context2 another-team/context1 mcp-server/context2; do
  ns="${identity%/*}"
  name="${identity#*/}"
  "$JQ" -e --arg ns "$ns" --arg name "$name" '
    any(.[]; .kind == "Context" and .metadata.namespace == $ns and .metadata.name == $name and
      .spec.description == "new context" and .spec.mcpServers == ["bootstrap-tools"])' \
    "$CASE_DIR/state.json" >/dev/null || fail "non-target Context $identity was not reconciled"
  grep -Fq "$(printf 'apply\tContext\t%s\t%s' "$ns" "$name")" "$CASE_DIR/mutations.log" ||
    fail "non-target Context $identity did not use apply"
done
"$JQ" -e --slurpfile expected "$CASE_DIR/expected-context.json" '
  any(.[]; .kind == "Context" and .metadata.namespace == "mcp-server" and
    .metadata.name == "context1" and .metadata.uid == $expected[0].metadata.uid and
    .spec.mcpServers == $expected[0].spec.mcpServers)' "$CASE_DIR/state.json" >/dev/null ||
  fail 'target connectors changed while applying other Contexts'
pass 'only mcp-server/context1 is preserved; other Contexts still apply'

init_case target-not-declared
rm -- "$CASE_DIR/overlay/instances/01-context.json"
expect_success
assert_state
if grep -Fq 'get -f - --ignore-not-found -o json' "$CASE_DIR/calls.log"; then
  fail 'bootstrap read context1 when it was not declared'
fi
if grep -Fq "$(printf 'create\tContext\tmcp-server\tcontext1')" "$CASE_DIR/mutations.log"; then
  fail 'bootstrap created context1 when it was not declared'
fi
pass 'a manifest without context1 only applies its declared resources'

init_case target-declarative-update
"$JQ" 'map(if .kind == "Context" and .metadata.namespace == "mcp-server" and .metadata.name == "context1" then
  .metadata.labels.retired = "old" |
  .metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] |=
    (fromjson | .metadata.labels.retired = "old" | tojson)
  else . end)' "$CASE_DIR/state.json" >"$CASE_DIR/state.next"
mv "$CASE_DIR/state.next" "$CASE_DIR/state.json"
"$JQ" '.spec.description = "new declarative description" |
  del(.metadata.labels["managed-by"]) | .metadata.labels.release = "new"' \
  "$CASE_DIR/overlay/instances/01-context.json" >"$CASE_DIR/context.next"
mv "$CASE_DIR/context.next" "$CASE_DIR/overlay/instances/01-context.json"
expect_success
"$JQ" -e 'map(select(.kind == "Context" and .metadata.namespace == "mcp-server" and .metadata.name == "context1"))[0] |
  .metadata.uid == "existing-context-uid" and .spec.mcpServers == ["ui-calendar", "ui-drive"] and
  .spec.description == "new declarative description" and .metadata.labels.release == "new" and
  .metadata.labels["ui-label"] == "retained" and
  (.metadata.labels | has("managed-by") | not) and (.metadata.labels | has("retired") | not) and
  ((.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] | fromjson | .spec | has("mcpServers")) | not)' \
  "$CASE_DIR/state.json" >/dev/null || fail 'context1 did not apply other declared changes while preserving connectors'
pass 'context1 preserves connectors while applying other declarative changes'

GET_RESPONSE=empty-list
init_case empty-get-list
cp "$CASE_DIR/state.json" "$CASE_DIR/before.json"
if run_provision; then
  fail 'unexpected empty Context get List was accepted'
fi
grep -Fq 'cannot validate Context response' "$CASE_DIR/output.log" ||
  fail 'empty Context get List did not fail at response validation'
cmp -s "$CASE_DIR/before.json" "$CASE_DIR/state.json" ||
  fail 'empty Context get List changed instance state'
[ ! -s "$CASE_DIR/mutations.log" ] || fail 'empty Context get List reached an instance mutation'
pass 'empty Context get List fails before instance mutation'
GET_RESPONSE=list

for GET_RESPONSE in multiple wrong-name wrong-namespace wrong-kind wrong-api malformed invalid-items null-items missing-items null-item scalar-item nested wrong-list-api null whitespace two-documents; do
  init_case "invalid-get-$GET_RESPONSE"
  cp "$CASE_DIR/state.json" "$CASE_DIR/before.json"
  if run_provision; then
    fail "invalid Context get response $GET_RESPONSE was accepted"
  fi
  grep -Fq 'cannot validate Context response' "$CASE_DIR/output.log" ||
    fail "$GET_RESPONSE did not fail at the Context response validation"
  grep -Fq 'get -f - --ignore-not-found -o json' "$CASE_DIR/calls.log" ||
    fail "$GET_RESPONSE did not exercise the manifest-based Context get"
  cmp -s "$CASE_DIR/before.json" "$CASE_DIR/state.json" ||
    fail "$GET_RESPONSE changed state before rejecting the response"
  [ ! -s "$CASE_DIR/mutations.log" ] || fail "$GET_RESPONSE reached an instance mutation"
  pass "invalid Context get response $GET_RESPONSE fails before mutation"
done
GET_RESPONSE=list

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

init_case no-last-applied-foreign-metadata
"$JQ" 'map(if .kind == "Context" and .metadata.name == "context1" then
  del(.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"]) |
  .spec.description = "declarative description" |
  .metadata.ownerReferences = [{apiVersion:"clerum.io/v1alpha1",kind:"WorkflowRecipe",name:"another-owner",uid:"owner-uid"}] |
  .metadata.finalizers = ["fixture.example/finalizer"] else . end)' \
  "$CASE_DIR/state.json" >"$CASE_DIR/state.next"
mv "$CASE_DIR/state.next" "$CASE_DIR/state.json"
remember_existing_context
expect_success
assert_state
"$JQ" -e 'map(select(.kind == "Context" and .metadata.name == "context1"))[0] |
  .metadata.ownerReferences[0].uid == "owner-uid" and
  .metadata.finalizers == ["fixture.example/finalizer"]' "$CASE_DIR/state.json" >/dev/null ||
  fail 'undeclared owner references or finalizers were removed'
pass 'unmanaged Context retains owner references and finalizers not declared by bootstrap'

init_case changed-bootstrap-connectors
"$JQ" '.spec.mcpServers = ["a-new-bootstrap-default"]' \
  "$CASE_DIR/overlay/instances/01-context.json" >"$CASE_DIR/context.next"
mv "$CASE_DIR/context.next" "$CASE_DIR/overlay/instances/01-context.json"
expect_success
assert_state
pass 'changes to bootstrap connectors do not replace user selections'

init_case contexts-only
rm -- "$CASE_DIR/overlay/instances/02-context.json" "$CASE_DIR/overlay/instances/03-host.json" "$CASE_DIR/overlay/instances/04-channel.json" "$CASE_DIR/overlay/instances/05-gfs.json"
expect_success
"$JQ" -e --slurpfile expected "$CASE_DIR/expected-context.json" '
  map(select(.kind == "Context" and .metadata.name == "context1"))[0] |
  .metadata.uid == $expected[0].metadata.uid and .spec.mcpServers == $expected[0].spec.mcpServers' \
  "$CASE_DIR/state.json" >/dev/null || fail 'Context-only provisioning changed context1 connectors'
pass 'a Context-only instance directory preserves context1 connectors'

init_case no-last-applied-drift
"$JQ" 'map(if .kind == "Context" and .metadata.name == "context1" then
  del(.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"])
  else . end)' "$CASE_DIR/state.json" >"$CASE_DIR/state.next"
mv "$CASE_DIR/state.next" "$CASE_DIR/state.json"
remember_existing_context
expect_success
assert_state
"$JQ" -e 'any(.[]; .kind == "Context" and .metadata.name == "context1" and
  .spec.description == "declarative description")' "$CASE_DIR/state.json" >/dev/null ||
  fail 'context1 without last-applied did not apply its declared fields'
pass 'context1 without last-applied applies declarative fields and preserves connectors'

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

init_case concurrent-read-clean-baseline
"$JQ" 'map(if .kind == "Context" and .metadata.name == "context1" then
  .metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] |=
    (fromjson | del(.spec.mcpServers) | tojson) else . end)' \
  "$CASE_DIR/state.json" >"$CASE_DIR/state.next"
mv "$CASE_DIR/state.next" "$CASE_DIR/state.json"
remember_existing_context
"$JQ" '.spec.mcpServers += ["ui-concurrent-tools"]' \
  "$CASE_DIR/expected-context.json" >"$CASE_DIR/expected-context.next"
mv "$CASE_DIR/expected-context.next" "$CASE_DIR/expected-context.json"
expect_success
[ -f "$CASE_DIR/state.json.raced" ] || fail 'concurrent UI update with clean baseline was not exercised'
assert_state
pass 'concurrent UI addition survives after ownership was already transferred'

RACE=read-remove
init_case concurrent-removal
"$JQ" '.spec.mcpServers |= map(select(. != "ui-calendar"))' \
  "$CASE_DIR/expected-context.json" >"$CASE_DIR/expected-context.next"
mv "$CASE_DIR/expected-context.next" "$CASE_DIR/expected-context.json"
expect_success
[ -f "$CASE_DIR/state.json.raced" ] || fail 'concurrent UI removal was not exercised'
assert_state
pass 'concurrent UI removal survives provisioning'

RACE=create
init_case concurrent-create
"$JQ" 'map(select(.kind != "Context" or .metadata.namespace != "mcp-server" or .metadata.name != "context1"))' \
  "$CASE_DIR/state.json" >"$CASE_DIR/state.next"
mv "$CASE_DIR/state.next" "$CASE_DIR/state.json"
if run_provision; then
  fail 'creation race was reported as successful provisioning'
fi
[ -f "$CASE_DIR/state.json.raced" ] || fail 'concurrent creation was not exercised'
"$JQ" -e 'map(select(.kind == "Context" and .metadata.name == "context1" and .metadata.namespace == "mcp-server"))[0] |
  .metadata.uid == "racing-creator-uid" and .spec.mcpServers == ["ui-racing-creator"]' \
  "$CASE_DIR/state.json" >/dev/null || fail 'creation race overwrote the winning Context'
pass 'Context creation race fails without overwriting the winner'
RACE=none

for RACE in baseline recreate; do
  init_case "concurrent-$RACE"
  if run_provision; then
    fail "concurrent $RACE was reported as successful provisioning"
  fi
  [ -f "$CASE_DIR/state.json.raced" ] || fail "concurrent $RACE was not exercised"
  [ ! -s "$CASE_DIR/mutations.log" ] || fail "concurrent $RACE reached an instance mutation"
  if [ "$RACE" = baseline ]; then
    "$JQ" -e 'map(select(.kind == "Context" and .metadata.name == "context1"))[0] |
      .spec.mcpServers == ["ui-calendar", "ui-drive"] and
      (.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] | fromjson | .spec.description) == "concurrent deploy"' \
      "$CASE_DIR/state.json" >/dev/null || fail 'migration overwrote the newer baseline'
  else
    "$JQ" -e 'map(select(.kind == "Context" and .metadata.name == "context1"))[0] |
      .metadata.uid == "replacement-uid" and .spec.mcpServers == ["replacement-tools"]' \
      "$CASE_DIR/state.json" >/dev/null || fail 'migration overwrote the replacement Context'
  fi
  pass "concurrent $RACE fails without overwriting the winner"
done
RACE=none

init_case skip-instances
cp "$CASE_DIR/state.json" "$CASE_DIR/before.json"
expect_success --skip-instances
cmp -s "$CASE_DIR/before.json" "$CASE_DIR/state.json" || fail '--skip-instances changed instance state'
[ ! -s "$CASE_DIR/mutations.log" ] || fail '--skip-instances issued an instance mutation'
pass '--skip-instances preserves all instance state'

for FIELD in manifest label annotation owner-reference finalizer spec; do
  init_case "declared-$FIELD"
  case "$FIELD" in
    manifest) expression='.spec.description = "changed bootstrap description"'; check='.spec.description == "changed bootstrap description"' ;;
    label) expression='.metadata.labels["managed-by"] = "changed"'; check='.metadata.labels["managed-by"] == "changed"' ;;
    annotation) expression='.metadata.annotations["fixture.example/owner"] = "changed"'; check='.metadata.annotations["fixture.example/owner"] == "changed"' ;;
    owner-reference) expression='.metadata.ownerReferences = [{apiVersion:"v1",kind:"ConfigMap",name:"owner",uid:"owner-uid"}]'; check='.metadata.ownerReferences[0].uid == "owner-uid"' ;;
    finalizer) expression='.metadata.finalizers = ["fixture.example/finalizer"]'; check='.metadata.finalizers == ["fixture.example/finalizer"]' ;;
    spec) expression='.spec.sharedFileSystems = ["fixture-gfs"]'; check='.spec.sharedFileSystems == ["fixture-gfs"]' ;;
  esac
  "$JQ" "$expression" "$CASE_DIR/overlay/instances/01-context.json" >"$CASE_DIR/context.next"
  mv "$CASE_DIR/context.next" "$CASE_DIR/overlay/instances/01-context.json"
  expect_success
  assert_state
  "$JQ" -e "map(select(.kind == \"Context\" and .metadata.name == \"context1\"))[0] | $check" \
    "$CASE_DIR/state.json" >/dev/null || fail "declared $FIELD was not applied"
  pass "context1 $FIELD applies without replacing connectors"
done

init_case invalid-last-applied
"$JQ" 'map(if .kind == "Context" and .metadata.name == "context1" then
  .metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] = "invalid-json"
  else . end)' "$CASE_DIR/state.json" >"$CASE_DIR/state.next"
mv "$CASE_DIR/state.next" "$CASE_DIR/state.json"
cp "$CASE_DIR/state.json" "$CASE_DIR/before.json"
if run_provision; then
  fail 'invalid last-applied annotation was accepted'
fi
grep -Fq 'invalid context1 last-applied configuration' "$CASE_DIR/output.log" ||
  fail 'invalid last-applied annotation did not report the correct failure'
cmp -s "$CASE_DIR/before.json" "$CASE_DIR/state.json" || fail 'invalid annotation changed instance state'
[ ! -s "$CASE_DIR/mutations.log" ] || fail 'invalid annotation reached an instance mutation'
pass 'invalid last-applied annotation fails before instance mutation'

for FAILURE in render read read-with-stdout patch create apply; do
  init_case "failure-$FAILURE"
  if [ "$FAILURE" = create ]; then
    "$JQ" 'map(select(.kind != "Context" or .metadata.namespace != "mcp-server" or .metadata.name != "context1"))' \
      "$CASE_DIR/state.json" >"$CASE_DIR/state.next"
    mv "$CASE_DIR/state.next" "$CASE_DIR/state.json"
  fi
  cp "$CASE_DIR/state.json" "$CASE_DIR/before.json"
  if run_provision; then
    fail "unexpected $FAILURE failure was reported as successful provisioning"
  fi
  grep -Fq 'fixture: injected' "$CASE_DIR/output.log" || {
    cat "$CASE_DIR/output.log" >&2
    fail "$FAILURE case failed without reaching the intended API error"
  }
  case "$FAILURE" in
    render|read|read-with-stdout|patch)
      cmp -s "$CASE_DIR/before.json" "$CASE_DIR/state.json" || fail "$FAILURE changed instance state"
      [ ! -s "$CASE_DIR/mutations.log" ] || fail "$FAILURE reached an instance mutation"
      ;;
  esac
  pass "unexpected $FAILURE error fails provisioning"
done

pass 'Context bootstrap preserves UI-owned connector state'

# The same bootstrap policy must serve the Minikube deployment paths. The
# optional seed replaces the initial Context declaration only when the Context
# is absent; it must not restore connectors a user removed on an existing one.
run_shared_bootstrap() {
  TEST_STATE="$CASE_DIR/state.json" TEST_CALLS="$CASE_DIR/calls.log" \
    TEST_MUTATIONS="$CASE_DIR/mutations.log" TEST_JQ="$JQ" \
    TEST_RENDER=stream TEST_FAILURE=none TEST_RACE=none \
    TEST_GET_RESPONSE="${GET_RESPONSE:-list}" \
    PATH="$TMP/bin:$PATH" \
    "$TEST_BASH" -c '. "$1"; shift; apply_bootstrap_instances "$@"' -- \
    "$ROOT/deploy/scripts/lib/bootstrap-instances.sh" "$TEST_CONTEXT" \
    "$CASE_DIR/overlay/instances" "$@" >"$CASE_DIR/output.log" 2>&1
}

make_seed() {
  mkdir -p "$CASE_DIR/seed"
  "$JQ" '.spec.mcpServers = ["demo-one", "demo-two"]' \
    "$CASE_DIR/overlay/instances/01-context.json" >"$CASE_DIR/seed/context.json"
  cat >"$CASE_DIR/seed/server.json" <<'JSON'
{"apiVersion":"clerum.io/v1alpha1","kind":"McpServer","metadata":{"name":"demo-one","namespace":"mcp-server"},"spec":{"enabled":true}}
JSON
}

init_case shared-existing-seed
make_seed
if ! run_shared_bootstrap "$CASE_DIR/seed"; then
  cat "$CASE_DIR/output.log" >&2
  fail 'shared bootstrap failed with an existing Context and seed'
fi
assert_state
"$JQ" -e 'any(.[]; .kind == "McpServer" and .metadata.name == "demo-one")' \
  "$CASE_DIR/state.json" >/dev/null || fail 'seed non-Context resource was not applied'
pass 'shared bootstrap preserves an existing Context while applying seed resources'

init_case shared-other-context-seed
make_seed
"$JQ" '.spec.description = "seed description" | .spec.mcpServers = ["seed-tools"]' \
  "$CASE_DIR/overlay/instances/02-context.json" >"$CASE_DIR/seed/other-context.json"
if ! run_shared_bootstrap "$CASE_DIR/seed"; then
  cat "$CASE_DIR/output.log" >&2
  fail 'shared bootstrap failed while applying a non-target Context from base and seed'
fi
"$JQ" -e 'any(.[]; .kind == "Context" and .metadata.namespace == "another-team" and
  .metadata.name == "context2" and .spec.description == "seed description" and
  .spec.mcpServers == ["seed-tools"])' "$CASE_DIR/state.json" >/dev/null ||
  fail 'seed did not apply after the base non-target Context'
[ "$(grep -Fc "$(printf 'apply\tContext\tanother-team\tcontext2')" "$CASE_DIR/mutations.log")" -eq 2 ] ||
  fail 'non-target Context was not applied once per source'
pass 'non-target Contexts apply from base and then seed'

init_case shared-context1-base-seed-order
make_seed
"$JQ" '.metadata.labels["base-only"] = "base"' \
  "$CASE_DIR/overlay/instances/01-context.json" >"$CASE_DIR/context.next"
mv "$CASE_DIR/context.next" "$CASE_DIR/overlay/instances/01-context.json"
"$JQ" 'map(if .kind == "Context" and .metadata.namespace == "mcp-server" and .metadata.name == "context1" then
  .metadata.labels["base-only"] = "unmanaged" else . end)' \
  "$CASE_DIR/state.json" >"$CASE_DIR/state.next"
mv "$CASE_DIR/state.next" "$CASE_DIR/state.json"
remember_existing_context
if ! run_shared_bootstrap "$CASE_DIR/seed"; then
  cat "$CASE_DIR/output.log" >&2
  fail 'shared bootstrap failed applying context1 base and seed'
fi
assert_state
"$JQ" -e 'map(select(.kind == "Context" and .metadata.namespace == "mcp-server" and .metadata.name == "context1"))[0] |
  (.metadata.labels | has("base-only") | not)' "$CASE_DIR/state.json" >/dev/null ||
  fail 'context1 seed did not remove a field declared by the base'
[ "$(grep -Fc "$(printf 'apply\tContext\tmcp-server\tcontext1')" "$CASE_DIR/mutations.log")" -eq 2 ] ||
  fail 'context1 was not applied once per source'
pass 'context1 applies base then seed while preserving connectors'

init_case shared-new-seed
make_seed
"$JQ" 'map(select(.kind != "Context" or .metadata.name != "context1"))' \
  "$CASE_DIR/state.json" >"$CASE_DIR/state.next"
mv "$CASE_DIR/state.next" "$CASE_DIR/state.json"
if ! run_shared_bootstrap "$CASE_DIR/seed"; then
  cat "$CASE_DIR/output.log" >&2
  fail 'shared bootstrap failed with a new Context and seed'
fi
"$JQ" -e 'any(.[]; .kind == "Context" and .metadata.name == "context1" and
  .spec.mcpServers == ["demo-one", "demo-two"] and
  ((.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] | fromjson | .spec | has("mcpServers")) | not))' "$CASE_DIR/state.json" >/dev/null ||
  fail 'new Context did not receive the seed connector selection'
pass 'shared bootstrap selects seed connectors for a new Context'

init_case shared-new-minimal
"$JQ" 'map(select(.kind != "Context" or .metadata.name != "context1"))' \
  "$CASE_DIR/state.json" >"$CASE_DIR/state.next"
mv "$CASE_DIR/state.next" "$CASE_DIR/state.json"
if ! run_shared_bootstrap; then
  cat "$CASE_DIR/output.log" >&2
  fail 'shared bootstrap failed with a new minimal Context'
fi
"$JQ" -e 'any(.[]; .kind == "Context" and .metadata.name == "context1" and
  .spec.mcpServers == [] and
  ((.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] | fromjson | .spec | has("mcpServers")) | not))' "$CASE_DIR/state.json" >/dev/null ||
  fail 'new minimal Context did not receive the empty bootstrap selection'
pass 'shared bootstrap selects minimal connectors for a new Context'

init_case shared-declarative-update
mv "$CASE_DIR/overlay/instances/01-context.json" "$CASE_DIR/overlay/instances/99-context.json"
"$JQ" '.spec.description = "changed bootstrap description"' \
  "$CASE_DIR/overlay/instances/99-context.json" >"$CASE_DIR/context.next"
mv "$CASE_DIR/context.next" "$CASE_DIR/overlay/instances/99-context.json"
if ! run_shared_bootstrap; then
  cat "$CASE_DIR/output.log" >&2
  fail 'shared bootstrap rejected an ordinary context1 declarative change'
fi
assert_state
"$JQ" -e 'any(.[]; .kind == "Context" and .metadata.name == "context1" and
  .spec.description == "changed bootstrap description")' "$CASE_DIR/state.json" >/dev/null ||
  fail 'shared bootstrap did not apply the context1 declarative change'
pass 'shared bootstrap applies context1 declarative changes while preserving connectors'

init_case shared-ambiguous-seed
make_seed
cp "$CASE_DIR/seed/context.json" "$CASE_DIR/seed/duplicate.json"
cp "$CASE_DIR/state.json" "$CASE_DIR/before.json"
if run_shared_bootstrap "$CASE_DIR/seed"; then
  fail 'shared bootstrap accepted ambiguous seed Contexts'
fi
cmp -s "$CASE_DIR/before.json" "$CASE_DIR/state.json" ||
  fail 'ambiguous seed mutated instances before failing'
pass 'shared bootstrap rejects ambiguous seed Contexts before mutation'

init_case shared-ambiguous-base
cp "$CASE_DIR/overlay/instances/01-context.json" "$CASE_DIR/overlay/instances/duplicate.json"
cp "$CASE_DIR/state.json" "$CASE_DIR/before.json"
if run_shared_bootstrap; then
  fail 'shared bootstrap accepted ambiguous base Contexts'
fi
cmp -s "$CASE_DIR/before.json" "$CASE_DIR/state.json" ||
  fail 'ambiguous base mutated instances before failing'
pass 'shared bootstrap rejects ambiguous base Contexts before mutation'

init_case shared-missing-jq
if PATH="$TMP/bin" /bin/bash -c '. "$1"; apply_bootstrap_instances "$2" "$3"' -- \
  "$ROOT/deploy/scripts/lib/bootstrap-instances.sh" "$TEST_CONTEXT" \
  "$CASE_DIR/overlay/instances" >"$CASE_DIR/output.log" 2>&1; then
  fail 'shared bootstrap accepted a missing jq'
fi
grep -Fq 'jq is required' "$CASE_DIR/output.log" || fail 'missing jq did not report the prerequisite'
[[ ! -s "$CASE_DIR/calls.log" ]] || fail 'missing jq reached kubectl'
pass 'shared bootstrap rejects a missing jq before any Kubernetes operation'

init_case shared-classification-failure
cat >"$TMP/bin/jq" <<'STUB'
#!/bin/bash
case "$*" in
  *'.items | length'*) exit 1 ;;
  *) exec "$TEST_JQ" "$@" ;;
esac
STUB
chmod +x "$TMP/bin/jq"
cp "$CASE_DIR/state.json" "$CASE_DIR/before.json"
if run_shared_bootstrap; then
  fail 'shared bootstrap accepted an instance classification failure'
fi
grep -Fq 'cannot classify instance declarations' "$CASE_DIR/output.log" ||
  fail 'classification failure was not reported'
cmp -s "$CASE_DIR/before.json" "$CASE_DIR/state.json" ||
  fail 'classification failure mutated instances'
rm -- "$TMP/bin/jq"
pass 'shared bootstrap fails before mutation if instance classification fails'

# Exercise the actual Make target with an isolated lease wrapper and kubectl
# fixture. The wrapper verifies the target passes its identity to the lease;
# the lease implementation itself is covered by the Minikube contract tests.
run_make_instances() {
  local repo="$CASE_DIR/repo"
  mkdir -p "$repo/scripts/minikube" "$repo/deploy/scripts/lib" \
    "$repo/deploy/overlays/minikube/instances"
  cp "${CONTEXT_TEST_MAKEFILE:-$ROOT/Makefile}" "$repo/Makefile"
  cp "$ROOT/deploy/scripts/lib/bootstrap-instances.sh" "$repo/deploy/scripts/lib/"
  cp "$CASE_DIR/overlay/instances/"*.json "$repo/deploy/overlays/minikube/instances/"
  cat >"$repo/scripts/minikube/with-t2-mutation-lock.sh" <<'STUB'
#!/bin/bash
set -euo pipefail
[ "$T2_PROJECT_DIR" = "$PWD" ]
[ "$T2_PROFILE" = "$TEST_CONTEXT" ]
[ "$T2_CONTEXT" = "$TEST_CONTEXT" ]
[ "$1" = -- ]
shift
exec "$@"
STUB
  TEST_STATE="$CASE_DIR/state.json" TEST_CALLS="$CASE_DIR/calls.log" \
    TEST_MUTATIONS="$CASE_DIR/mutations.log" TEST_JQ="$JQ" \
    TEST_RENDER=stream TEST_FAILURE=none TEST_RACE=none \
    TEST_GET_RESPONSE="${GET_RESPONSE:-list}" \
    PATH="$TMP/bin:$PATH" /usr/bin/make --no-print-directory -C "$repo" \
    MINIKUBE_PROFILE="$TEST_CONTEXT" minikube-deploy-instances >"$CASE_DIR/output.log" 2>&1
}

init_case make-instances
if ! run_make_instances; then
  cat "$CASE_DIR/output.log" >&2
  fail 'Minikube instances target failed'
fi
assert_state
"$JQ" 'map(if .kind == "Context" and .metadata.name == "context1" then
  .spec.mcpServers = ["ui-drive", "ui-added-later"] else . end)' \
  "$CASE_DIR/state.json" >"$CASE_DIR/state.next"
mv "$CASE_DIR/state.next" "$CASE_DIR/state.json"
remember_existing_context
if ! run_make_instances; then
  cat "$CASE_DIR/output.log" >&2
  fail 'Minikube instances target failed on redeploy'
fi
assert_state
"$JQ" 'map(if .kind == "Context" and .metadata.name == "context1" then
  .spec.mcpServers = [] else . end)' "$CASE_DIR/state.json" >"$CASE_DIR/state.next"
mv "$CASE_DIR/state.next" "$CASE_DIR/state.json"
remember_existing_context
if ! run_make_instances; then
  cat "$CASE_DIR/output.log" >&2
  fail 'Minikube instances target failed after all connectors were removed'
fi
assert_state
pass 'Minikube instances target preserves user additions and removals on redeploy'
