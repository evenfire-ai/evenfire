#!/bin/bash
# Job 4.1-D: read-only census of HCC-managed NetworkPolicy orphans.
#
# get/list only — never create, patch, replace, or delete.
# Classifies by clerum.io/policy-type in {context-allow, rpc-proxy-egress,
# external-egress} when managed-by is absent or host-context-controller
# (#484: exclude only present-and-foreign), plus both controller
# `repairable` one-marker arms: (1) managed-by present, policy-type absent,
# reserved name; (2) policy-type present, managed-by absent. Omitting either
# can print VERDICT=CLEAN while the controller still counts those objects
# and may trip the cap. This is not the full four-lane classifier (reserved
# names without owner labels can over-count vs the controller).
#
# CONTEXT_MAPPER_* knobs are read from the live host-context-controller
# Deployment. Code defaults are never printed as cluster facts: an absent
# env is UNSET. `live_cap_would_trip` is UNSET when the Deployment omitted
# both cap keys (not `none` — that means "evaluated, would not trip").
#
# The running controller still applies compiled defaults in that case
# (absolute 10, percent 20 — host-context-controller/src/config.ts).
# `controller_cap_would_trip` answers that question so a reader cannot
# treat live_cap_would_trip=none as "the controller will delete".
# A trip refuses deletes only; the pass still certifies.
#
# Namespaces: mapper and host must be set on the Deployment (they are in
# deploy/base). rpc-proxy may be omitted — the live line stays UNSET and
# is labelled `(controller applies compiled default: rpc-proxy)`, same
# two-tier shape as live_cap vs controller_cap. Sampling then uses that
# compiled default. Do not declare the key in deploy/ to unblock the job.
#
# This census reflects on-cluster orphans by policy-type plus the
# reserved-name repairable approximation. It is not the full pass
# authority gate, but one abort-shaped class is reported:
# VERDICT=AMBIGUOUS_PRESENT (exit 5) when a foreign managed-by,
# typed, reserved-name policy also carries an owner label. That
# object stays out of listed/orphans (#484) and must not print CLEAN
# — classifySafetyInventoryPolicy tags it ambiguous and the
# controller aborts the pass. Other ambiguous arms stay out of scope.
#
# Cap formula must stay aligned with evaluateNetPolOrphanSweepCap in
# host-context-controller/src/networkPolicyReconciler.ts and the compiled
# defaults in host-context-controller/src/config.ts (absolute 10, percent
# 20, rpc-proxy namespace). If you change either side, change this script.
# Typed membership excludes clerum.io/managed-by when it is present and
# not host-context-controller so a foreign-owned typed policy cannot
# inflate listed/orphans (#484). A typed policy with managed-by absent
# stays eligible — that is the controller's other repairable arm.
#
# Double-samples 90s apart. Adjudicates only when the desired Context +
# McpServer identity set is identical across samples; otherwise
# INCONCLUSIVE_RERUN. A sample that listed zero managed policies and
# zero ambiguous-foreign objects is INCONCLUSIVE_EMPTY, never CLEAN.
#
# Usage:
#   CONTEXT=<kube-context> ./scripts/ops/hcc-netpol-orphan-census.sh

set -euo pipefail
umask 077

: "${CONTEXT:?must set CONTEXT (kubectl context)}"

HCC_NS="${HCC_NS:-control-plane}"
HCC_DEPLOYMENT="${HCC_DEPLOYMENT:-host-context-controller}"
SAMPLE_GAP_SEC="${SAMPLE_GAP_SEC:-90}"

echo "[census] context=${CONTEXT} deployment=${HCC_NS}/${HCC_DEPLOYMENT}"

kc() {
  command kubectl --context "${CONTEXT}" "$@"
}

# Live Deployment env only. Missing keys are UNSET — never substitute
# controller source defaults as cluster facts. A kubectl failure is not
# an absent key: fail closed instead of printing UNSET.
deployment_env() {
  local key="$1"
  local value
  local rc=0
  value="$(kc -n "${HCC_NS}" get deployments "${HCC_DEPLOYMENT}" -o "jsonpath={.spec.template.spec.containers[0].env[?(@.name==\"${key}\")].value}")" || rc=$?
  if [[ "${rc}" -ne 0 ]]; then
    echo "[census] FATAL: kubectl failed reading ${key} from ${HCC_NS}/${HCC_DEPLOYMENT} (exit ${rc})" >&2
    exit 2
  fi
  if [[ -z "${value}" ]]; then
    printf "UNSET"
  else
    printf "%s" "${value}"
  fi
}

MAPPER_NS="$(deployment_env CONTEXT_MAPPER_NAMESPACE)"
HOST_NS="$(deployment_env CONTEXT_MAPPER_HOST_NAMESPACE)"
RPC_NS="$(deployment_env CONTEXT_MAPPER_RPC_PROXY_NAMESPACE)"
RESYNC_SEC="$(deployment_env CONTEXT_MAPPER_NETPOL_RESYNC_SEC)"
ORPHAN_CAP="$(deployment_env CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP)"
ORPHAN_CAP_PCT="$(deployment_env CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP_PERCENT)"

echo "[census] live Deployment env:"
echo "  CONTEXT_MAPPER_NAMESPACE=${MAPPER_NS}"
echo "  CONTEXT_MAPPER_HOST_NAMESPACE=${HOST_NS}"
COMPILED_RPC_NS_DEFAULT=rpc-proxy
if [[ "${RPC_NS}" == "UNSET" ]]; then
  echo "  CONTEXT_MAPPER_RPC_PROXY_NAMESPACE=UNSET (controller applies compiled default: ${COMPILED_RPC_NS_DEFAULT})"
else
  echo "  CONTEXT_MAPPER_RPC_PROXY_NAMESPACE=${RPC_NS}"
fi
echo "  CONTEXT_MAPPER_NETPOL_RESYNC_SEC=${RESYNC_SEC}"
echo "  CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP=${ORPHAN_CAP}"
echo "  CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP_PERCENT=${ORPHAN_CAP_PCT}"

if [[ "${MAPPER_NS}" == "UNSET" || "${HOST_NS}" == "UNSET" ]]; then
  echo "[census] FATAL: Deployment did not declare mapper/host namespaces; refusing to invent defaults" >&2
  exit 2
fi

# Base manifests omit CONTEXT_MAPPER_RPC_PROXY_NAMESPACE; the controller
# compiles rpc-proxy (config.ts). Sample with that default; the live line
# above already labelled UNSET vs compiled so we do not print a code
# default as a cluster fact.
if [[ "${RPC_NS}" == "UNSET" ]]; then
  RPC_NS="${COMPILED_RPC_NS_DEFAULT}"
fi

# Fail loud on a missing namespace. An empty list from a typo must never
# print VERDICT=CLEAN (zero-tests-is-never-success).
require_namespace() {
  local ns="$1"
  if ! kc get namespaces "${ns}" -o name >/dev/null; then
    echo "[census] FATAL: namespace ${ns} does not exist; refusing to sample an empty inventory" >&2
    exit 2
  fi
}
require_namespace "${MAPPER_NS}"
require_namespace "${HOST_NS}"
require_namespace "${RPC_NS}"

# Typed membership (type in set and managed-by null-or-HCC) plus the
# reserved-name untyped repairable class (managed-by present, type absent).
# Shared by listed + orphan filters.
CENSUS_MANAGED_JQ='
  def policy_type: .metadata.labels["clerum.io/policy-type"];
  def managed_by: .metadata.labels["clerum.io/managed-by"];
  def is_typed:
    (
      policy_type == "context-allow"
      or policy_type == "rpc-proxy-egress"
      or policy_type == "external-egress"
    )
    and (managed_by == null or managed_by == "host-context-controller");
  def is_untyped_repairable:
    .metadata.labels["clerum.io/managed-by"] == "host-context-controller"
    and (policy_type == null)
    and (
      (.metadata.name // "" | startswith("ctx-"))
      or (.metadata.name // "" | startswith("rpc-egress-"))
      or (.metadata.name // "" | startswith("ext-egress-"))
    );
  def is_census_managed: is_typed or is_untyped_repairable;
  def is_reserved:
    (.metadata.name // "" | startswith("ctx-"))
    or (.metadata.name // "" | startswith("rpc-egress-"))
    or (.metadata.name // "" | startswith("ext-egress-"));
  def has_owner:
    (.metadata.labels["clerum.io/context"] != null)
    or (.metadata.labels["clerum.io/mcpserver"] != null);
  def is_ambiguous_foreign:
    managed_by != null
    and managed_by != "host-context-controller"
    and (
      policy_type == "context-allow"
      or policy_type == "rpc-proxy-egress"
      or policy_type == "external-egress"
    )
    and is_reserved
    and has_owner;
  def census_lane:
    if policy_type == "external-egress"
       or (policy_type == null and (.metadata.name // "" | startswith("ext-egress-")))
    then "external" else "context" end;
'

# One read-only snapshot of desired identities + orphan candidates.
sample_state() {
  local contexts_json servers_json np_json
  contexts_json="$(kc get contexts.clerum.io -n "${MAPPER_NS}" -o json)"
  servers_json="$(kc get mcpservers.clerum.io -n "${MAPPER_NS}" -o json)"
  np_json="$(
    {
      kc get networkpolicy -n "${MAPPER_NS}" -o json
      kc get networkpolicy -n "${HOST_NS}" -o json
      kc get networkpolicy -n "${RPC_NS}" -o json
    } | jq -s '{items: [.[].items[]?] | unique_by(.metadata.uid // ((.metadata.namespace // "") + "/" + (.metadata.name // "")))}'
  )"

  local desired_contexts desired_servers listed untyped orphans orphan_count
  local ambiguous ambiguous_count
  desired_contexts="$(printf "%s" "${contexts_json}" | jq -r '[.items[]?.spec.contextId // empty] | unique | sort | join(",")')"
  desired_servers="$(printf "%s" "${servers_json}" | jq -r '[.items[]?.metadata.name // empty] | unique | sort | join(",")')"
  listed="$(printf "%s" "${np_json}" | jq -r "${CENSUS_MANAGED_JQ} [.items[] | select(is_census_managed)] | length")"
  untyped="$(printf "%s" "${np_json}" | jq -r "${CENSUS_MANAGED_JQ} [.items[] | select(is_untyped_repairable)] | length")"

  orphans="$(printf "%s" "${np_json}" | jq -r --arg ctxs "${desired_contexts}" --arg srvs "${desired_servers}" "${CENSUS_MANAGED_JQ}"'
    ($ctxs | split(",") | map(select(length>0))) as $desiredCtx
    | ($srvs | split(",") | map(select(length>0))) as $desiredSrv
    | .items[]
    | select(is_census_managed)
    | . as $p
    | (
        if census_lane == "external" then
          ($p.metadata.labels["clerum.io/mcpserver"] as $s | ($s == null) or (($desiredSrv | index($s)) == null))
        else
          ($p.metadata.labels["clerum.io/context"] as $c | ($c == null) or (($desiredCtx | index($c)) == null))
        end
      )
    | select(.)
    | [$p.metadata.namespace, $p.metadata.name, ($p.metadata.labels["clerum.io/policy-type"] // "repairable-untyped")]
    | @tsv
  ')"

  if [[ -z "${orphans}" ]]; then
    orphan_count=0
  else
    orphan_count="$(printf "%s\n" "${orphans}" | awk 'NF { n++ } END { print n+0 }')"
  fi

  ambiguous="$(printf "%s" "${np_json}" | jq -r "${CENSUS_MANAGED_JQ}"'
    .items[]
    | select(is_ambiguous_foreign)
    | [
        .metadata.namespace,
        .metadata.name,
        (.metadata.labels["clerum.io/policy-type"] // "none"),
        (.metadata.labels["clerum.io/managed-by"] // "")
      ]
    | @tsv
  ')"
  if [[ -z "${ambiguous}" ]]; then
    ambiguous_count=0
  else
    ambiguous_count="$(printf "%s\n" "${ambiguous}" | awk 'NF { n++ } END { print n+0 }')"
  fi

  printf "DESIRED_CONTEXTS=%s\n" "${desired_contexts}"
  printf "DESIRED_SERVERS=%s\n" "${desired_servers}"
  printf "LISTED_MANAGED=%s\n" "${listed}"
  printf "REPAIRABLE_UNTYPED=%s\n" "${untyped}"
  printf "ORPHAN_COUNT=%s\n" "${orphan_count}"
  printf "AMBIGUOUS_COUNT=%s\n" "${ambiguous_count}"
  printf "ORPHANS<<EOF\n"
  printf "%s\n" "${orphans}"
  printf "EOF\n"
  printf "AMBIGUOUS<<EOF\n"
  printf "%s\n" "${ambiguous}"
  printf "EOF\n"
}

parse_field() {
  local blob="$1" key="$2"
  printf "%s" "${blob}" | sed -n "s/^${key}=//p" | head -n1
}

echo "[census] sample 1"
SAMPLE1="$(sample_state)"
echo "${SAMPLE1}" | sed -e "/^ORPHANS<<EOF/,/^EOF/d" -e "/^AMBIGUOUS<<EOF/,/^EOF/d"

echo "[census] waiting ${SAMPLE_GAP_SEC}s for second sample"
sleep "${SAMPLE_GAP_SEC}"

echo "[census] sample 2"
SAMPLE2="$(sample_state)"
echo "${SAMPLE2}" | sed -e "/^ORPHANS<<EOF/,/^EOF/d" -e "/^AMBIGUOUS<<EOF/,/^EOF/d"

CTX1="$(parse_field "${SAMPLE1}" DESIRED_CONTEXTS)"
SRV1="$(parse_field "${SAMPLE1}" DESIRED_SERVERS)"
CTX2="$(parse_field "${SAMPLE2}" DESIRED_CONTEXTS)"
SRV2="$(parse_field "${SAMPLE2}" DESIRED_SERVERS)"

if [[ "${CTX1}" != "${CTX2}" || "${SRV1}" != "${SRV2}" ]]; then
  echo "[census] VERDICT=INCONCLUSIVE_RERUN"
  echo "[census] desired Context+McpServer set changed between samples; do not adjudicate"
  echo "  sample1 contexts=${CTX1}"
  echo "  sample2 contexts=${CTX2}"
  echo "  sample1 servers=${SRV1}"
  echo "  sample2 servers=${SRV2}"
  exit 3
fi

ORPHAN_COUNT="$(parse_field "${SAMPLE2}" ORPHAN_COUNT)"
LISTED="$(parse_field "${SAMPLE2}" LISTED_MANAGED)"
REPAIRABLE_UNTYPED="$(parse_field "${SAMPLE2}" REPAIRABLE_UNTYPED)"
AMBIGUOUS_COUNT="$(parse_field "${SAMPLE2}" AMBIGUOUS_COUNT)"
echo "[census] desired set identical across samples"
echo "[census] listed_managed=${LISTED} repairable_untyped=${REPAIRABLE_UNTYPED} orphan_count=${ORPHAN_COUNT} ambiguous_count=${AMBIGUOUS_COUNT}"
echo "[census] orphans (namespace name policy-type):"
printf "%s" "${SAMPLE2}" | sed -n "/^ORPHANS<<EOF/,/^EOF/{ /^ORPHANS<<EOF/d; /^EOF/d; p; }"
echo "[census] ambiguous (namespace name policy-type managed-by):"
printf "%s" "${SAMPLE2}" | sed -n "/^AMBIGUOUS<<EOF/,/^EOF/{ /^AMBIGUOUS<<EOF/d; /^EOF/d; p; }"

# Controller compiled defaults (config.ts). Used only for
# controller_cap_would_trip, never as a substitute for live env.
COMPILED_ABS_DEFAULT=10
COMPILED_PCT_DEFAULT=20

is_uint() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

cap_would_trip() {
  local orphan_count="$1" listed="$2" abs="$3" pct="$4"
  if ! is_uint "${orphan_count}" || ! is_uint "${listed}" || ! is_uint "${abs}" || ! is_uint "${pct}"; then
    printf "malformed"
    return
  fi
  if [[ "${orphan_count}" -gt "${abs}" ]]; then
    printf "absolute"
  elif [[ "${listed}" -gt 0 && $((listed * pct)) -ge 100 && $((orphan_count * 100)) -gt $((listed * pct)) ]]; then
    printf "percent"
  else
    printf "none"
  fi
}

if ! is_uint "${LISTED}" || ! is_uint "${ORPHAN_COUNT}"; then
  echo "[census] live_cap_would_trip=malformed"
  echo "[census] compiled_default_absolute=${COMPILED_ABS_DEFAULT} compiled_default_percent=${COMPILED_PCT_DEFAULT}"
  echo "[census] controller_cap_would_trip=malformed (listed_managed or orphan_count is not an unsigned integer)"
  echo "[census] VERDICT=INCONCLUSIVE_EMPTY"
  echo "[census] listed_managed or orphan_count is not an unsigned integer; do not treat this as CLEAN" >&2
  echo "[census] hint: re-check CONTEXT, mapper/host/rpc-proxy namespaces, and kubectl connectivity" >&2
  exit 4
fi

CAP_REASON="none"
if [[ "${ORPHAN_CAP}" == "UNSET" && "${ORPHAN_CAP_PCT}" == "UNSET" ]]; then
  CAP_REASON="UNSET"
elif [[ "${ORPHAN_CAP}" != "UNSET" ]]; then
  if ! is_uint "${ORPHAN_CAP}"; then
    CAP_REASON="malformed"
  elif [[ "${ORPHAN_COUNT}" -gt "${ORPHAN_CAP}" ]]; then
    CAP_REASON="absolute"
  fi
fi
if [[ "${CAP_REASON}" == "none" && "${ORPHAN_CAP_PCT}" != "UNSET" ]]; then
  if ! is_uint "${ORPHAN_CAP_PCT}"; then
    CAP_REASON="malformed"
  elif [[ "${LISTED}" -gt 0 ]]; then
    # Integer compare of orphan*100 > listed*percent, inert when percent*listed < 100.
    if [[ $((LISTED * ORPHAN_CAP_PCT)) -ge 100 && $((ORPHAN_COUNT * 100)) -gt $((LISTED * ORPHAN_CAP_PCT)) ]]; then
      CAP_REASON="percent"
    fi
  fi
fi

CONTROLLER_ABS="${ORPHAN_CAP}"
CONTROLLER_PCT="${ORPHAN_CAP_PCT}"
if [[ "${CONTROLLER_ABS}" == "UNSET" ]]; then
  CONTROLLER_ABS="${COMPILED_ABS_DEFAULT}"
elif ! is_uint "${CONTROLLER_ABS}"; then
  CONTROLLER_ABS="malformed"
fi
if [[ "${CONTROLLER_PCT}" == "UNSET" ]]; then
  CONTROLLER_PCT="${COMPILED_PCT_DEFAULT}"
elif ! is_uint "${CONTROLLER_PCT}"; then
  CONTROLLER_PCT="malformed"
fi
CONTROLLER_CAP_REASON="$(cap_would_trip "${ORPHAN_COUNT}" "${LISTED}" "${CONTROLLER_ABS}" "${CONTROLLER_PCT}")"

echo "[census] live_cap_would_trip=${CAP_REASON}"
echo "[census] compiled_default_absolute=${COMPILED_ABS_DEFAULT} compiled_default_percent=${COMPILED_PCT_DEFAULT}"
echo "[census] controller_cap_would_trip=${CONTROLLER_CAP_REASON} (live env, else compiled defaults)"
if ! is_uint "${AMBIGUOUS_COUNT}"; then
  echo "[census] VERDICT=INCONCLUSIVE_EMPTY"
  echo "[census] ambiguous_count is not an unsigned integer; do not treat this as CLEAN" >&2
  exit 4
fi
if [[ "${LISTED}" -eq 0 && "${AMBIGUOUS_COUNT}" -eq 0 ]]; then
  echo "[census] VERDICT=INCONCLUSIVE_EMPTY"
  echo "[census] listed zero managed NetworkPolicies; \"found nothing\" is not CLEAN"
  echo "[census] hint: re-check CONTEXT, CONTEXT_MAPPER_RPC_PROXY_NAMESPACE, and kubectl connectivity"
  exit 4
fi
if [[ "${AMBIGUOUS_COUNT}" -gt 0 ]]; then
  echo "[census] VERDICT=AMBIGUOUS_PRESENT"
  echo "[census] foreign typed reserved+owner policy present; controller aborts the pass — not CLEAN"
  exit 5
fi
if [[ "${ORPHAN_COUNT}" -eq 0 ]]; then
  echo "[census] VERDICT=CLEAN"
else
  echo "[census] VERDICT=ORPHANS_PRESENT"
fi
