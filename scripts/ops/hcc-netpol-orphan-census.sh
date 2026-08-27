#!/bin/bash
# Job 4.1-D: read-only census of HCC-managed NetworkPolicy orphans.
#
# get/list only — never create, patch, replace, or delete.
# Classifies by clerum.io/policy-type in {context-allow, rpc-proxy-egress,
# external-egress}. Do not treat managed-by alone as membership.
#
# CONTEXT_MAPPER_* knobs are read from the live host-context-controller
# Deployment. Code defaults are never printed as cluster facts: an absent
# env is UNSET. `live_cap_would_trip` therefore stays none when the
# Deployment omitted the cap keys.
#
# The running controller still applies compiled defaults in that case
# (absolute 10, percent 20 — host-context-controller/src/config.ts).
# `controller_cap_would_trip` answers that question so a reader cannot
# treat live_cap_would_trip=none as "the sweep will proceed".
#
# Double-samples 90s apart. Adjudicates only when the desired Context +
# McpServer identity set is identical across samples; otherwise
# INCONCLUSIVE_RERUN.
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
# controller source defaults as cluster facts.
deployment_env() {
  local key="$1"
  local value
  value="$(kc -n "${HCC_NS}" get deploy "${HCC_DEPLOYMENT}" -o "jsonpath={.spec.template.spec.containers[0].env[?(@.name==\"${key}\")].value}" 2>/dev/null || true)"
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
echo "  CONTEXT_MAPPER_RPC_PROXY_NAMESPACE=${RPC_NS}"
echo "  CONTEXT_MAPPER_NETPOL_RESYNC_SEC=${RESYNC_SEC}"
echo "  CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP=${ORPHAN_CAP}"
echo "  CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP_PERCENT=${ORPHAN_CAP_PCT}"

if [[ "${MAPPER_NS}" == "UNSET" || "${HOST_NS}" == "UNSET" || "${RPC_NS}" == "UNSET" ]]; then
  echo "[census] FATAL: Deployment did not declare mapper/host/rpc-proxy namespaces; refusing to invent defaults" >&2
  exit 2
fi

# One read-only snapshot of desired identities + orphan candidates.
# Filters on policy-type, not managed-by.
sample_state() {
  local contexts_json servers_json np_json
  contexts_json="$(kc get contexts.clerum.io -n "${MAPPER_NS}" -o json)"
  servers_json="$(kc get mcpservers.clerum.io -n "${MAPPER_NS}" -o json)"
  np_json="$(
    {
      kc get networkpolicy -n "${MAPPER_NS}" -o json
      kc get networkpolicy -n "${HOST_NS}" -o json
      kc get networkpolicy -n "${RPC_NS}" -o json
    } | jq -s "{items: [.[].items[]?]}"
  )"

  local desired_contexts desired_servers listed orphans orphan_count
  desired_contexts="$(printf "%s" "${contexts_json}" | jq -r '[.items[]?.spec.contextId // empty] | unique | sort | join(",")')"
  desired_servers="$(printf "%s" "${servers_json}" | jq -r '[.items[]?.metadata.name // empty] | unique | sort | join(",")')"
  listed="$(printf "%s" "${np_json}" | jq -r '[.items[] | select((.metadata.labels["clerum.io/policy-type"] == "context-allow") or (.metadata.labels["clerum.io/policy-type"] == "rpc-proxy-egress") or (.metadata.labels["clerum.io/policy-type"] == "external-egress"))] | length')"

  orphans="$(printf "%s" "${np_json}" | jq -r --arg ctxs "${desired_contexts}" --arg srvs "${desired_servers}" '
    ($ctxs | split(",") | map(select(length>0))) as $desiredCtx
    | ($srvs | split(",") | map(select(length>0))) as $desiredSrv
    | .items[]
    | .metadata.labels["clerum.io/policy-type"] as $t
    | select($t == "context-allow" or $t == "rpc-proxy-egress" or $t == "external-egress")
    | . as $p
    | (
        if $t == "external-egress" then
          ($p.metadata.labels["clerum.io/mcpserver"] as $s | ($s == null) or (($desiredSrv | index($s)) == null))
        else
          ($p.metadata.labels["clerum.io/context"] as $c | ($c == null) or (($desiredCtx | index($c)) == null))
        end
      )
    | select(.)
    | [$p.metadata.namespace, $p.metadata.name, $t]
    | @tsv
  ')"

  if [[ -z "${orphans}" ]]; then
    orphan_count=0
  else
    orphan_count="$(printf "%s\n" "${orphans}" | grep -c . || true)"
  fi

  printf "DESIRED_CONTEXTS=%s\n" "${desired_contexts}"
  printf "DESIRED_SERVERS=%s\n" "${desired_servers}"
  printf "LISTED_MANAGED=%s\n" "${listed}"
  printf "ORPHAN_COUNT=%s\n" "${orphan_count}"
  printf "ORPHANS<<EOF\n"
  printf "%s\n" "${orphans}"
  printf "EOF\n"
}

parse_field() {
  local blob="$1" key="$2"
  printf "%s" "${blob}" | sed -n "s/^${key}=//p" | head -n1
}

echo "[census] sample 1"
SAMPLE1="$(sample_state)"
echo "${SAMPLE1}" | sed "/^ORPHANS<<EOF/,/^EOF/d"

echo "[census] waiting ${SAMPLE_GAP_SEC}s for second sample"
sleep "${SAMPLE_GAP_SEC}"

echo "[census] sample 2"
SAMPLE2="$(sample_state)"
echo "${SAMPLE2}" | sed "/^ORPHANS<<EOF/,/^EOF/d"

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
echo "[census] desired set identical across samples"
echo "[census] listed_managed=${LISTED} orphan_count=${ORPHAN_COUNT}"
echo "[census] orphans (namespace name policy-type):"
printf "%s" "${SAMPLE2}" | sed -n "/^ORPHANS<<EOF/,/^EOF/{ /^ORPHANS<<EOF/d; /^EOF/d; p; }"

# Controller compiled defaults (config.ts). Used only for
# controller_cap_would_trip, never as a substitute for live env.
COMPILED_ABS_DEFAULT=10
COMPILED_PCT_DEFAULT=20

cap_would_trip() {
  local orphan_count="$1" listed="$2" abs="$3" pct="$4"
  if [[ "${orphan_count}" -gt "${abs}" ]]; then
    printf "absolute"
  elif [[ "${listed}" -gt 0 && $((listed * pct)) -ge 100 && $((orphan_count * 100)) -gt $((listed * pct)) ]]; then
    printf "percent"
  else
    printf "none"
  fi
}

CAP_REASON="none"
if [[ "${ORPHAN_CAP}" != "UNSET" && "${ORPHAN_COUNT}" -gt "${ORPHAN_CAP}" ]]; then
  CAP_REASON="absolute"
elif [[ "${ORPHAN_CAP_PCT}" != "UNSET" && "${LISTED}" -gt 0 ]]; then
  # Integer compare of orphan*100 > listed*percent, inert when percent*listed < 100.
  if [[ $((LISTED * ORPHAN_CAP_PCT)) -ge 100 && $((ORPHAN_COUNT * 100)) -gt $((LISTED * ORPHAN_CAP_PCT)) ]]; then
    CAP_REASON="percent"
  fi
fi

CONTROLLER_ABS="${ORPHAN_CAP}"
CONTROLLER_PCT="${ORPHAN_CAP_PCT}"
if [[ "${CONTROLLER_ABS}" == "UNSET" ]]; then
  CONTROLLER_ABS="${COMPILED_ABS_DEFAULT}"
fi
if [[ "${CONTROLLER_PCT}" == "UNSET" ]]; then
  CONTROLLER_PCT="${COMPILED_PCT_DEFAULT}"
fi
CONTROLLER_CAP_REASON="$(cap_would_trip "${ORPHAN_COUNT}" "${LISTED}" "${CONTROLLER_ABS}" "${CONTROLLER_PCT}")"

echo "[census] live_cap_would_trip=${CAP_REASON}"
echo "[census] compiled_default_absolute=${COMPILED_ABS_DEFAULT} compiled_default_percent=${COMPILED_PCT_DEFAULT}"
echo "[census] controller_cap_would_trip=${CONTROLLER_CAP_REASON} (live env, else compiled defaults)"
if [[ "${ORPHAN_COUNT}" -eq 0 ]]; then
  echo "[census] VERDICT=CLEAN"
else
  echo "[census] VERDICT=ORPHANS_PRESENT"
fi
