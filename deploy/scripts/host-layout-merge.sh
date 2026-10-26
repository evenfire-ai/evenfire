#!/usr/bin/env bash
# Issue #825: read-only inventory and turn-off gate for the HCC workspace
# layout merge on any cluster (docs/deploy/host-pvc-layout-upgrade.md).
#
# Every Host PVC is classified with the merge init's own rules: the check
# Pods run deploy/scripts/workspace-layout-merge.sh (the script HCC renders,
# kept equal to it by a host-context-controller test) with the moves removed
# and the writability checks read from mode bits, because the PVC is mounted
# read-only. The script never opens a database and never execs into a Host.
set -euo pipefail

usage() {
  cat <<'EOF'
usage:
  host-layout-merge.sh inventory --context <kube-context> [options]
  host-layout-merge.sh verify    --context <kube-context> [options]
  host-layout-merge.sh check-script [--root <path>]

inventory     before an upgrade: what the merge init will do to every Host PVC.
              Exit 1 when a tree will be refused (UPGRADE_BLOCKERS > 0), the
              flag is "false" while a tree is split, the flag is invalid, or a
              PVC could not be read.
verify        whether CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE can be set to
              "false": exit 0 only when every Host Deployment renders the merge
              init and no Host PVC still carries the split layout.
check-script  print the check the PVC check Pods run.

options:
  --hcc-namespace <ns>     HCC namespace (default control-plane)
  --hcc-deployment <name>  HCC Deployment (default host-context-controller)
  --no-pvc-pods            start no check Pod; PVC results are UNVERIFIED
  --check-timeout <sec>    wait per check Pod (default 120)
  --root <path>            check-script only: PVC root (default /mnt/workspace-root)

Reads only, except one short-lived Pod per inspected PVC: claim mounted
read-only, uid/gid 1001, no service-account token, deleted after its log is
read. Every kubectl call names --context; the current-context is never used.
Exit: 0 pass, 1 an observed blocker, 2 usage, read failure, empty scope or
check Pod cleanup failure.
EOF
}

KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"
MERGE_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/workspace-layout-merge.sh"
PVC_ROOT=/mnt/workspace-root

die() {
  echo "host-layout-merge: $*" >&2
  exit 2
}
usage_error() {
  echo "host-layout-merge: $*" >&2
  usage >&2
  exit 2
}

# ─── check script ─────────────────────────────────────────────────────
# Prints the merge script with:
#   - the root replaced (check-script --root, used by the tests);
#   - each refusal printed on stdout as WILL_REFUSE_<section> <line>, where
#     the section is the "# F<n>" block it ran in (F1 before the first);
#   - each "no signature" exit printed as NO_SPLIT_SIGNATURE;
#   - `[ -w ]` replaced by a mode-bit test, since the check mount is read-only;
#   - the T5 rename of state/ replaced by WILL_SUPERSEDE;
#   - everything from the move function on replaced by WILL_MERGE.
# Each rewrite must match the expected number of lines, so a changed merge
# script stops here instead of producing a check that no longer matches it.
# The patterns and replacements below are shell text for the check Pod, so
# they are single-quoted on purpose.
# shellcheck disable=SC2016
print_check_script() {
  local root=$1 line roots=0 sets=0 echoes=0 exits=0 sections=0 noops=0 writes=0 supersedes=0 cut=0
  case "$root" in *"'"*) usage_error "--root must not contain a single quote" ;; esac
  [ -f "$MERGE_SCRIPT" ] || die "missing $MERGE_SCRIPT"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "root='/mnt/workspace-root'")
        printf "root='%s'\n" "$root"
        roots=$((roots + 1))
        ;;
      'set -eu')
        printf '%s\n' "$line" 'phase=F1'
        cat <<'EOF'
# Mode-bit write test: the check Pod mounts the PVC read-only, so the
# shell's -w test would refuse every tree. Same owner/group/other rule as
# access(2).
# A `+` in the mode string is a POSIX ACL, which the mode bits do not
# account for, so the check reports the tree UNREADABLE instead of guessing.
writable() {
  mode_writable "$1" && return 0
  [ "$?" -eq 2 ] || return 1
  echo "UNREADABLE ACL on $1: mode bits do not decide access"
  exit 0
}
mode_writable() (
  set -f
  [ "$(id -u)" -ne 0 ] || exit 0
  listing="$(ls -ldn "$1")" || exit 1
  set -- $listing
  case "$1" in *+*) exit 2 ;; esac
  if [ "$3" = "$(id -u)" ]; then
    case "$1" in ??w*) exit 0 ;; *) exit 1 ;; esac
  fi
  for gid in $(id -G); do
    if [ "$4" = "$gid" ]; then
      case "$1" in ?????w*) exit 0 ;; *) exit 1 ;; esac
    fi
  done
  case "$1" in ????????w*) exit 0 ;; *) exit 1 ;; esac
)
EOF
        sets=$((sets + 1))
        ;;
      '  echo "workspace layout merge refused: $1" >&2')
        printf '%s\n' '  echo "WILL_REFUSE_$phase workspace layout merge refused: $1"'
        echoes=$((echoes + 1))
        ;;
      '  exit 1')
        printf '%s\n' '  exit 0'
        exits=$((exits + 1))
        ;;
      '# F1' | '# F2' | '# F3' | '# F4')
        printf 'phase=%s\n' "${line#'# '}"
        sections=$((sections + 1))
        ;;
      *'|| exit 0')
        printf '%s\n' "${line%'|| exit 0'}|| { echo NO_SPLIT_SIGNATURE; exit 0; }"
        noops=$((noops + 1))
        ;;
      '  [ -w "$dir" ] || fail_merge "not writable by uid $(id -u): $dir"')
        printf '%s\n' '  writable "$dir" || fail_merge "not writable by uid $(id -u): $dir"'
        writes=$((writes + 1))
        ;;
      '  [ -w "$entry" ] || fail_merge "not writable by uid $(id -u): $entry"')
        printf '%s\n' '  writable "$entry" || fail_merge "not writable by uid $(id -u): $entry"'
        writes=$((writes + 1))
        ;;
      '  [ -w "$root" ] || fail_merge "not writable by uid $(id -u): $root"')
        printf '%s\n' '  phase=F4' '  writable "$root" || fail_merge "not writable by uid $(id -u): $root"' '  phase=F3'
        writes=$((writes + 1))
        ;;
      '  mv "$root/state" "$superseded"')
        printf '%s\n' '  echo WILL_SUPERSEDE'
        supersedes=$((supersedes + 1))
        ;;
      'move_to_root() {')
        printf '%s\n' 'echo WILL_MERGE'
        cut=1
        break
        ;;
      *)
        printf '%s\n' "$line"
        ;;
    esac
  done <"$MERGE_SCRIPT"
  local shape="root=$roots set=$sets echo=$echoes exit=$exits sections=$sections noops=$noops writes=$writes supersedes=$supersedes cut=$cut"
  [ "$shape" = "root=1 set=1 echo=1 exit=1 sections=4 noops=3 writes=3 supersedes=1 cut=1" ] ||
    die "$MERGE_SCRIPT has an unexpected shape ($shape); update print_check_script with it"
}

# ─── arguments ────────────────────────────────────────────────────────
COMMAND="${1:-}"
[ "$#" -eq 0 ] || shift
CONTEXT=""
HCC_NAMESPACE=control-plane
HCC_DEPLOYMENT='host-context-controller'
NO_PVC_PODS=0
CHECK_TIMEOUT=120
CHECK_ROOT="$PVC_ROOT"
need_value() { [ "$2" -ge 2 ] || usage_error "$1 needs a value"; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --context) need_value "$1" "$#"; CONTEXT="$2"; shift 2 ;;
    --context=*) CONTEXT="${1#--context=}"; shift ;;
    --hcc-namespace) need_value "$1" "$#"; HCC_NAMESPACE="$2"; shift 2 ;;
    --hcc-deployment) need_value "$1" "$#"; HCC_DEPLOYMENT="$2"; shift 2 ;;
    --no-pvc-pods) NO_PVC_PODS=1; shift ;;
    --check-timeout) need_value "$1" "$#"; CHECK_TIMEOUT="$2"; shift 2 ;;
    --root) need_value "$1" "$#"; CHECK_ROOT="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

case "$COMMAND" in
  check-script)
    print_check_script "$CHECK_ROOT"
    exit 0
    ;;
  inventory | verify) ;;
  *) usage_error "expected inventory, verify or check-script" ;;
esac
[ -n "$CONTEXT" ] || usage_error "--context is required; the current-context is never used"
[ "$CHECK_ROOT" = "$PVC_ROOT" ] || usage_error "--root applies to check-script only"
case "$CHECK_TIMEOUT" in '' | *[!0-9]*) usage_error "--check-timeout must be a whole number of seconds" ;; esac
command -v jq >/dev/null 2>&1 || die "jq is required"
CHECK_SCRIPT="$(print_check_script "$PVC_ROOT")"

kc() { "$KUBECTL_BIN" --context="$CONTEXT" "$@"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/host-layout-merge.XXXXXX")"
CHECK_PODS="$WORK/check-pods"
: >"$CHECK_PODS"
HOST_NS=""

# A check Pod left behind keeps an RWO claim attached to its node, which can
# stop the Host from starting elsewhere, so a failed delete is exit 2.
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  local status=$? pod
  while IFS= read -r pod; do
    [ -n "$pod" ] || continue
    if ! kc delete pod "$pod" -n "$HOST_NS" --wait=true --timeout=60s >/dev/null 2>&1; then
      echo "host-layout-merge: check Pod $HOST_NS/$pod was not deleted; delete it by hand" >&2
      status=2
    fi
  done <"$CHECK_PODS"
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 2' INT TERM
# Check Pod names carry this run's id, so a name held by another run (or any
# other Pod) is never reused, and cleanup deletes only Pods this run created.
RUN_ID="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
case "$RUN_ID" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;; *) die "cannot draw a run id from /dev/urandom" ;; esac

# read_json <file> <kubectl args...>: a JSON object or exit 2 with stderr.
read_json() {
  local out=$1
  shift
  if ! kc "$@" >"$out" 2>"$out.err"; then
    die "kubectl $* failed: $(cat "$out.err")"
  fi
  jq -e 'type == "object"' "$out" >/dev/null 2>&1 || die "kubectl $* did not return a JSON object"
}

# ─── HCC ──────────────────────────────────────────────────────────────
read_json "$WORK/hcc.json" get deployment "$HCC_DEPLOYMENT" -n "$HCC_NAMESPACE" -o json
jq -e '[.spec.template.spec.containers[]? | select(.name == "host-context-controller")] | length == 1' \
  "$WORK/hcc.json" >/dev/null || die "$HCC_NAMESPACE/$HCC_DEPLOYMENT has no container named host-context-controller"
jq -e '(.spec.replicas // 1) as $r | $r > 0 and (.status.readyReplicas // 0) == $r and (.status.updatedReplicas // 0) == $r' \
  "$WORK/hcc.json" >/dev/null || die "HCC_NOT_READY: $HCC_NAMESPACE/$HCC_DEPLOYMENT is not fully rolled out and Ready"

# hcc_env <name>: <unset>, <valueFrom> or the literal value. A variable not
# set in env but possibly set through envFrom is <valueFrom>: its value is
# not in the Deployment, so its default must not be assumed.
hcc_env() {
  jq -r --arg n "$1" '.spec.template.spec.containers[] | select(.name == "host-context-controller")
    | ((.envFrom // []) | length > 0) as $from
    | [.env[]? | select(.name == $n)]
    | if length == 0 then (if $from then "<valueFrom>" else "<unset>" end)
      elif .[0].valueFrom then "<valueFrom>" else (.[0].value // "") end' "$WORK/hcc.json"
}

FLAG_RAW="$(hcc_env CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE)"
case "$FLAG_RAW" in
  '<unset>' | '' | true) FLAG=on ;;
  false) FLAG=off ;;
  '<valueFrom>') FLAG=unresolved ;;
  *) FLAG=invalid ;;
esac
HOST_NS="$(hcc_env CONTEXT_MAPPER_HOST_NAMESPACE)"
case "$HOST_NS" in
  '<unset>') HOST_NS=mcp-host ;;
  '' | '<valueFrom>') die "cannot resolve CONTEXT_MAPPER_HOST_NAMESPACE ($HOST_NS) from the HCC Deployment" ;;
esac
echo "HCC_IMAGE=$(jq -r '.spec.template.spec.containers[] | select(.name == "host-context-controller") | .image // "<none>"' "$WORK/hcc.json")"
echo "HCC_FLAG=$FLAG_RAW"
echo "HOST_NAMESPACE=$HOST_NS"

# ─── Hosts, Deployments, Pods, PVCs ───────────────────────────────────
read_json "$WORK/hosts.json" get hosts.clerum.io -n "$HOST_NS" -o json
read_json "$WORK/deployments.json" get deployments -n "$HOST_NS" -l clerum.io/host -o json
read_json "$WORK/pods.json" get pods -n "$HOST_NS" -l clerum.io/host -o json
read_json "$WORK/pvcs.json" get pvc -n "$HOST_NS" -l clerum.io/managed-by=host-context-controller -o json

# One tab-separated row per Host (H) and per Host PVC (P), "-" for empty.
# A Host Deployment and its Pods carry app == clerum.io/host == <host>; the
# per-Host channel-reader carries app=channel-reader and is excluded.
jq -r -n \
  --slurpfile hosts "$WORK/hosts.json" \
  --slurpfile deps "$WORK/deployments.json" \
  --slurpfile pods "$WORK/pods.json" \
  --slurpfile pvcs "$WORK/pvcs.json" '
  def owned($h): select(.metadata.labels.app == $h and .metadata.labels["clerum.io/host"] == $h);
  def kind: if (.spec.desktop.browser // false) or (.spec.desktop.x11 // false) then "DESKTOP"
    elif (.spec.lifecycle.stateless // false) then "STATELESS" else "STATEFUL" end;
  def template: [.spec.template.spec.initContainers[]?.name] as $i
    | if any($i[]; . == "workspace-layout-init") then "LEGACY_INIT"
      elif any($i[]; . == "workspace-layout-merge") then "MERGE" else "NO_INIT" end;
  def subpath($claim): .spec.template.spec as $s
    | [$s.volumes[]? | select(.persistentVolumeClaim.claimName == $claim) | .name] as $v
    | if any(($s.containers + ($s.initContainers // []))[] | .volumeMounts[]?;
        (.name as $n | $v | index($n)) != null and (.subPath // "") != "") then "yes" else "no" end;
  def merge_status: [.status.initContainerStatuses[]? | select(.name == "workspace-layout-merge")][0] as $s
    | if $s == null then "UNKNOWN"
      elif $s.state.terminated.exitCode == 0 then "POD_OK"
      elif $s.state.terminated.exitCode == 1 then "MERGE_REFUSED:current"
      elif $s.lastState.terminated.exitCode == 1 then "MERGE_REFUSED:previous"
      elif $s.state.terminated != null then "UNKNOWN"
      elif $s.state.running != null or $s.state.waiting != null then "MERGE_RUNNING"
      else "UNKNOWN" end;
  def worst: (map({"MERGE_REFUSED": 0, "UNKNOWN": 1, "MERGE_RUNNING": 2, "POD_OK": 3}[split(":")[0]]) | min) as $m
    | map(select({"MERGE_REFUSED": 0, "UNKNOWN": 1, "MERGE_RUNNING": 2, "POD_OK": 3}[split(":")[0]] == $m))[0];
  def dash: if . == null or . == "" then "-" else . end;
  def host_facts($h):
    [$deps[0].items[] | owned($h)] as $d
    | if ($d | length) > 1 then error("more than one Deployment for Host \($h)") else . end
    | [$pods[0].items[] | owned($h) | select(.metadata.deletionTimestamp == null)] as $p
    | ($d[0] // null) as $dep
    | ($dep | if . == null then null else [.spec.template.spec.containers[]? | select(.name == "mcp-host")][0] end) as $main
    | if $dep != null and $main == null then error("Deployment \($h) has no mcp-host container") else . end
    | {
        state: (if $dep == null then "NO_DEPLOYMENT" elif ($dep.spec.replicas // 1) == 0 then "SUSPENDED" else "ACTIVE" end),
        template: (if $dep == null then "-" else ($dep | template) end),
        subpath: (if $dep == null then "-" else ($dep | subpath("\($h)-workspace")) end),
        pods: ($p | length),
        nodes: ([$p[].spec.nodeName | select(. != null)] | unique),
        merge: (if ($p | length) == 0 then "-" else ($p | map({s: merge_status, pod: .metadata.name}) | (map(.s) | worst) as $w | map(select(.s == $w))[0] | "\(.s):\(.pod)") end),
        image: ($main.image // null),
        policy: ($main.imagePullPolicy // null),
        secrets: ($dep.spec.template.spec.imagePullSecrets // [] | map(.name) | join(","))
      };
  ($hosts[0].items | map({key: .metadata.name, value: kind}) | from_entries) as $kinds
  | [$pvcs[0].items[] | select(.metadata.name == "\(.metadata.labels["clerum.io/host"])-workspace") | .metadata.name] as $listed
  | ($hosts[0].items[] | .metadata.name as $h | host_facts($h) as $f
      | (["H", $h, $kinds[$h], $f.state, ($f.template | dash), ($f.subpath | dash)] | @tsv),
        # Every Host with a Deployment must have its <host>-workspace claim
        # mounted and in the PVC list; otherwise nothing reads that tree.
        ([$deps[0].items[] | owned($h)][0] // null
          | if . == null then empty
            elif ([.spec.template.spec.volumes[]?.persistentVolumeClaim.claimName] | index("\($h)-workspace")) == null then
              ["U", "\($h)-workspace", $h, $kinds[$h], $f.state, "Deployment mounts no \($h)-workspace claim"] | @tsv
            elif ($listed | index("\($h)-workspace")) == null then
              ["U", "\($h)-workspace", $h, $kinds[$h], $f.state, "claim not in the PVC list (clerum.io/managed-by=host-context-controller, clerum.io/host=\($h))"] | @tsv
            else empty end)),
    ($pvcs[0].items[] | .metadata.labels["clerum.io/host"] as $h
      | if $h == null then
          ["I", .metadata.name] | @tsv
        elif .metadata.name != "\($h)-workspace" then
          ["U", .metadata.name, $h, ($kinds[$h] // "ORPHAN"), (if $kinds[$h] == null then "NO_HOST" else host_facts($h).state end),
           "clerum.io/host=\($h) on a claim not named \($h)-workspace"] | @tsv
        elif $kinds[$h] == null then
          ["P", .metadata.name, $h, "ORPHAN", "NO_HOST", "-", "-", "0", "-", "-", "-", "-", "-"] | @tsv
        else
          host_facts($h) as $f
          | ["P", .metadata.name, $h, $kinds[$h], $f.state, ($f.template | dash), ($f.subpath | dash),
             ($f.pods | tostring), ($f.nodes | join(",") | dash), ($f.merge | dash),
             ($f.image | dash), ($f.policy | dash), ($f.secrets | dash)] | @tsv
        end)
' >"$WORK/rows.tsv" 2>"$WORK/rows.err" || die "cannot classify the Host objects: $(cat "$WORK/rows.err")"

HOSTS=0
PRE_825=no
DESKTOP_HOSTS=0
TEMPLATE_STALE=0
while IFS=$'\t' read -r type name kind state template subpath; do
  [ "$type" = H ] || continue
  HOSTS=$((HOSTS + 1))
  echo "HOST $name kind=$kind state=$state template=$template subPath=$subpath"
  [ "$kind" != DESKTOP ] || DESKTOP_HOSTS=$((DESKTOP_HOSTS + 1))
  if [ "$template" = LEGACY_INIT ] || [ "$subpath" = yes ]; then PRE_825=yes; fi
  if [ "$state" != NO_DEPLOYMENT ] && [ "$template" != MERGE ]; then TEMPLATE_STALE=$((TEMPLATE_STALE + 1)); fi
done <"$WORK/rows.tsv"
while IFS=$'\t' read -r type name _; do
  [ "$type" = I ] || continue
  echo "IGNORED_PVC $HOST_NS/$name (no clerum.io/host label)"
done <"$WORK/rows.tsv"
PVC_ROWS="$(awk -F'\t' '$1 == "P" || $1 == "U"' "$WORK/rows.tsv" | wc -l | tr -d ' ')"
[ "$HOSTS" -gt 0 ] || [ "$PVC_ROWS" -gt 0 ] || die "no Host and no Host PVC in namespace $HOST_NS; wrong --context or namespace?"
echo "PRE_825=$PRE_825"

# ─── verdicts that need no PVC read ───────────────────────────────────
if [ "$COMMAND" = verify ]; then
  case "$FLAG" in
    invalid) echo "HOST_LAYOUT_VERIFY=FLAG_INVALID"; exit 1 ;;
    unresolved) echo "HOST_LAYOUT_VERIFY=FLAG_UNRESOLVED"; exit 1 ;;
  esac
  if [ "$PRE_825" = yes ]; then
    echo "a Host Deployment still renders workspace-layout-init or a workspace subPath: run inventory and finish the upgrade first"
    echo "HOST_LAYOUT_VERIFY=PRE_825"
    exit 1
  fi
fi

# ─── check Pods ───────────────────────────────────────────────────────
# run_check <pvc> <node|-> <image> <policy> <secrets|->: prints the result
# token (and refusal line) for that PVC.
run_check() {
  local claim=$1 node=$2 image=$3 policy=$4 secrets=$5 pod phase elapsed=0 first lines
  pod="$(printf 'host-layout-check-%s' "$claim" | cut -c1-54 | sed 's/[-.]*$//')-$RUN_ID"
  jq -cn --arg pod "$pod" --arg ns "$HOST_NS" --arg node "$node" --arg image "$image" --arg policy "$policy" \
    --arg secrets "$secrets" --arg claim "$claim" --arg script "$CHECK_SCRIPT" --arg root "$PVC_ROOT" '{
      apiVersion: "v1", kind: "Pod",
      metadata: {name: $pod, namespace: $ns, labels: {purpose: "host-layout-merge-check"}},
      spec: ({
        restartPolicy: "Never", automountServiceAccountToken: false, enableServiceLinks: false,
        terminationGracePeriodSeconds: 0,
        securityContext: {runAsUser: 1001, runAsGroup: 1001, runAsNonRoot: true, seccompProfile: {type: "RuntimeDefault"}},
        imagePullSecrets: (if $secrets == "-" then [] else ($secrets | split(",") | map({name: .})) end),
        containers: [{
          name: "check", image: $image, imagePullPolicy: $policy,
          command: ["/bin/sh", "-c", $script],
          resources: {requests: {cpu: "10m", memory: "32Mi"}, limits: {cpu: "100m", memory: "64Mi"}},
          securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: ["ALL"]}},
          volumeMounts: [{name: "pvc", mountPath: $root, readOnly: true}]
        }],
        volumes: [{name: "pvc", persistentVolumeClaim: {claimName: $claim, readOnly: true}}]
      } + (if $node == "-" then {} else {nodeName: $node} end))
    }' >"$WORK/pod.json"
  # Registered before the create, so a create that times out after the API
  # accepted it is still deleted.
  printf '%s\n' "$pod" >>"$CHECK_PODS"
  kc create -f - <"$WORK/pod.json" >/dev/null 2>"$WORK/create.err" ||
    die "check Pod $HOST_NS/$pod create failed: $(cat "$WORK/create.err")"
  while :; do
    read_json "$WORK/status.json" get pod "$pod" -n "$HOST_NS" -o json
    phase="$(jq -r '.status.phase // ""' "$WORK/status.json")"
    case "$phase" in Succeeded | Failed) break ;; esac
    [ "$elapsed" -lt "$CHECK_TIMEOUT" ] || break
    sleep 2
    elapsed=$((elapsed + 2))
  done
  : >"$WORK/check.log"
  if [ "$phase" = Succeeded ] || [ "$phase" = Failed ]; then
    kc logs "$pod" -n "$HOST_NS" >"$WORK/check.log" 2>&1 || die "cannot read the log of check Pod $HOST_NS/$pod: $(cat "$WORK/check.log")"
  fi
  kc delete pod "$pod" -n "$HOST_NS" --wait=true --timeout=60s >/dev/null 2>"$WORK/delete.err" ||
    die "check Pod $HOST_NS/$pod delete failed: $(cat "$WORK/delete.err")"
  grep -vxF -- "$pod" "$CHECK_PODS" >"$CHECK_PODS.next" || true
  mv "$CHECK_PODS.next" "$CHECK_PODS"

  if [ "$phase" != Succeeded ]; then
    echo "UNREADABLE phase=${phase:-<none>} $(jq -r '[.status.containerStatuses[]?.state.waiting.reason // empty] | join(",")' "$WORK/status.json") $(tail -n 2 "$WORK/check.log" | tr '\n' ' ')"
    return
  fi
  first="$(head -n 1 "$WORK/check.log")"
  lines="$(wc -l <"$WORK/check.log" | tr -d ' ')"
  case "$first" in
    WILL_MERGE | WILL_SUPERSEDE | NO_SPLIT_SIGNATURE)
      if [ "$lines" = 1 ]; then echo "$first"; else echo "UNREADABLE unexpected output: $(tr '\n' ' ' <"$WORK/check.log")"; fi
      ;;
    'WILL_REFUSE_F'[1-4]' workspace layout merge refused: '*) tr '\n' ' ' <"$WORK/check.log" | sed 's/ $//'; echo ;;
    *) echo "UNREADABLE unexpected output: $(tr '\n' ' ' <"$WORK/check.log")" ;;
  esac
}

# The image for a PVC without a Host Deployment comes from HCC itself.
hcc_host_image() {
  local image policy secret
  image="$(hcc_env CONTEXT_MAPPER_HOST_IMAGE)"
  policy="$(hcc_env CONTEXT_MAPPER_HOST_IMAGE_PULL_POLICY)"
  secret="$(hcc_env CONTEXT_MAPPER_HOST_IMAGE_PULL_SECRET)"
  case "$image" in '' | '<unset>' | '<valueFrom>') die "cannot resolve CONTEXT_MAPPER_HOST_IMAGE ($image) for a check Pod" ;; esac
  case "$policy" in '<unset>') policy=Always ;; '' | '<valueFrom>') die "cannot resolve CONTEXT_MAPPER_HOST_IMAGE_PULL_POLICY ($policy)" ;; esac
  case "$secret" in '<unset>') secret=clerum ;; '' | '<valueFrom>') die "cannot resolve CONTEXT_MAPPER_HOST_IMAGE_PULL_SECRET ($secret)" ;; esac
  printf '%s\t%s\t%s\n' "$image" "$policy" "$secret"
}

# merge_line <status:pod>: the refusal line from the merge init's log.
merge_line() {
  local which=${1%%:*} pod=${1#*:} args=()
  [ "$which" = previous ] && args=(--previous)
  kc logs "$pod" -n "$HOST_NS" -c workspace-layout-merge ${args[@]+"${args[@]}"} >"$WORK/merge.log" 2>&1 ||
    die "cannot read the workspace-layout-merge log of $HOST_NS/$pod: $(cat "$WORK/merge.log")"
  grep -m 1 '^workspace layout merge refused: ' "$WORK/merge.log" || echo "<no refusal line in the log>"
}

TOTAL=0 POD_OK=0 NO_SPLIT=0 SPLIT=0 REFUSED=0 RUNNING=0 UNREADABLE=0 UNVERIFIED=0 UNKNOWN=0
ORPHANS=0 ORPHAN_SPLIT=0 ORPHAN_UNREADABLE=0 ORPHAN_UNVERIFIED=0 UPGRADE_BLOCKERS=0 SPLIT_TREES=0
while IFS=$'\t' read -r type pvc host kind state detail _subpath pods nodes merge image policy secrets; do
  case "$type" in P | U) ;; *) continue ;; esac
  result=""
  merge_ok=0
  if [ "$type" = U ]; then
    result="UNKNOWN $detail"
  elif [ "$COMMAND" = verify ] && [ "$FLAG" = on ] && [ "$pods" -gt 0 ]; then
    # An init that exited 0 is not proof the tree has no split-layout
    # signature (it can be rewritten after the start), so POD_OK still reads it.
    case "${merge%%:*}" in
      POD_OK) merge_ok=1 ;;
      MERGE_RUNNING | UNKNOWN) result="${merge%%:*}" ;;
      MERGE_REFUSED) result="MERGE_REFUSED $(merge_line "${merge#MERGE_REFUSED:}")" ;;
      *) die "unexpected merge status $merge for $pvc" ;;
    esac
  fi
  if [ -n "$result" ]; then
    :
  elif [ "$NO_PVC_PODS" -eq 1 ]; then
    result=UNVERIFIED
  else
    node=-
    if [ "$pods" -gt 0 ]; then
      case "$nodes" in
        - ) node=- ;;
        *,*) result="UNREADABLE Host Pods on more than one node ($nodes)" ;;
        *) node="$nodes" ;;
      esac
    fi
    if [ -z "$result" ]; then
      if [ "$image" = - ]; then
        IFS=$'\t' read -r image policy secrets <<<"$(hcc_host_image)"
      fi
      result="$(run_check "$pvc" "$node" "$image" "$policy" "$secrets" </dev/null)"
      # verify names a tree the merge will still change SPLIT.
      case "$COMMAND:$result" in verify:WILL_MERGE | verify:WILL_SUPERSEDE) result=SPLIT ;; esac
      [ "$merge_ok" -eq 0 ] || [ "$result" != NO_SPLIT_SIGNATURE ] || result=POD_OK
    fi
  fi
  # A known split orphan does not block (T9); an orphan nobody could read does.
  if [ "$type" = P ] && [ "$kind" = ORPHAN ]; then
    echo "PVC $HOST_NS/$pvc host=$host kind=ORPHAN state=$state result=$result"
    ORPHANS=$((ORPHANS + 1))
    case "$result" in
      WILL_MERGE | WILL_SUPERSEDE | SPLIT | WILL_REFUSE_*) ORPHAN_SPLIT=$((ORPHAN_SPLIT + 1)) ;;
      NO_SPLIT_SIGNATURE) ;;
      UNREADABLE*) ORPHAN_UNREADABLE=$((ORPHAN_UNREADABLE + 1)) ;;
      UNVERIFIED) ORPHAN_UNVERIFIED=$((ORPHAN_UNVERIFIED + 1)) ;;
      *) die "unclassified orphan result for $pvc: $result" ;;
    esac
    continue
  fi
  echo "PVC $HOST_NS/$pvc host=$host kind=$kind state=$state result=$result"
  TOTAL=$((TOTAL + 1))
  case "$result" in
    POD_OK) POD_OK=$((POD_OK + 1)) ;;
    NO_SPLIT_SIGNATURE) NO_SPLIT=$((NO_SPLIT + 1)) ;;
    WILL_MERGE | WILL_SUPERSEDE | SPLIT) SPLIT=$((SPLIT + 1)); SPLIT_TREES=$((SPLIT_TREES + 1)) ;;
    WILL_REFUSE_*) REFUSED=$((REFUSED + 1)); SPLIT_TREES=$((SPLIT_TREES + 1)); UPGRADE_BLOCKERS=$((UPGRADE_BLOCKERS + 1)) ;;
    MERGE_REFUSED*) REFUSED=$((REFUSED + 1)) ;;
    MERGE_RUNNING) RUNNING=$((RUNNING + 1)) ;;
    UNREADABLE*) UNREADABLE=$((UNREADABLE + 1)) ;;
    UNVERIFIED) UNVERIFIED=$((UNVERIFIED + 1)) ;;
    UNKNOWN | 'UNKNOWN '*) UNKNOWN=$((UNKNOWN + 1)) ;;
    *) die "unclassified result for $pvc: $result" ;;
  esac
done <"$WORK/rows.tsv"

SUM=$((POD_OK + NO_SPLIT + SPLIT + REFUSED + RUNNING + UNREADABLE + UNVERIFIED + UNKNOWN))
[ "$SUM" -eq "$TOTAL" ] || die "counted $SUM results for $TOTAL Host PVCs"
echo "COUNTS total=$TOTAL pod_ok=$POD_OK no_split=$NO_SPLIT split=$SPLIT refused=$REFUSED running=$RUNNING unreadable=$UNREADABLE unverified=$UNVERIFIED unknown=$UNKNOWN template_stale=$TEMPLATE_STALE"
echo "ORPHANS=$ORPHANS ORPHAN_SPLIT=$ORPHAN_SPLIT"
echo "ORPHAN_UNDECIDED=$((ORPHAN_UNREADABLE + ORPHAN_UNVERIFIED))"
if [ "$ORPHAN_SPLIT" -gt 0 ]; then
  echo "note: a Host recreated with an orphan's name after the flag is off starts on an empty database; delete the orphan PVC first or recreate the Host before turning the flag off"
fi
echo "PVC_CONTENTS=NOT_INSPECTED"
if [ "$FLAG" = off ] && [ "$SPLIT_TREES" -gt 0 ]; then
  echo "FLAG_FALSE_WITH_SPLIT_TREES=$SPLIT_TREES"
fi

if [ "$COMMAND" = inventory ]; then
  echo "UPGRADE_BLOCKERS=$UPGRADE_BLOCKERS"
  if [ "$DESKTOP_HOSTS" -gt 0 ]; then
    echo "DESKTOP_HOSTS=$DESKTOP_HOSTS export /workspace/state.db* from each desktop Host Pod before the first rollout of this HCC (docs/deploy/host-pvc-layout-upgrade.md)"
  else
    echo "DESKTOP_HOSTS=0"
  fi
  if [ "$UPGRADE_BLOCKERS" -gt 0 ] || [ "$UNREADABLE" -gt 0 ] || [ "$UNKNOWN" -gt 0 ] ||
    [ "$ORPHAN_UNREADABLE" -gt 0 ] || { [ "$HOSTS" -gt 0 ] && [ "$TOTAL" -eq 0 ]; } ||
    { [ "$FLAG" = off ] && [ "$SPLIT_TREES" -gt 0 ]; } ||
    [ "$FLAG" = invalid ] || [ "$FLAG" = unresolved ]; then
    echo "HOST_LAYOUT_INVENTORY=BLOCKED"
    exit 1
  fi
  echo "HOST_LAYOUT_INVENTORY=OK"
  exit 0
fi

# A PVC nobody read is undecided whatever the flag says: ALREADY_OFF is
# printed only when every PVC was read and none is split.
UNDECIDED=$((UNREADABLE + UNVERIFIED + UNKNOWN + ORPHAN_UNREADABLE + ORPHAN_UNVERIFIED))
if [ "$FLAG" = off ]; then
  if [ "$SPLIT_TREES" -gt 0 ]; then
    echo "HOST_LAYOUT_VERIFY=FLAG_FALSE_WITH_SPLIT_TREES"
  elif [ "$UNDECIDED" -gt 0 ]; then
    echo "HOST_LAYOUT_VERIFY=FAIL"
  else
    echo "HOST_LAYOUT_VERIFY=ALREADY_OFF"
  fi
  exit 1
fi
if [ "$TOTAL" -gt 0 ] && [ "$((SPLIT + REFUSED + RUNNING + UNDECIDED + TEMPLATE_STALE))" -eq 0 ]; then
  echo "HOST_LAYOUT_VERIFY=PASS"
  exit 0
fi
echo "HOST_LAYOUT_VERIFY=FAIL"
exit 1
