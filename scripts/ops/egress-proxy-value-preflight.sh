#!/bin/bash
# egress-proxy-value-preflight: read-only, pre-upgrade inventory of the values a
# remote McpServer will render into its egress-proxy NGINX template (#1240).
#
# Usage:
#   CONTEXT=<kube-context> NAMESPACE=<mcp-server namespace> \
#     ./scripts/ops/egress-proxy-value-preflight.sh
#
# Both variables are required; there are no defaults. The script follows the
# read-only census convention of scripts/ops/hcc-netpol-orphan-census.sh
# (CONTEXT, `kubectl --context`, `VERDICT=` lines, distinct exit codes).
#
# RBAC (read-only, all in $NAMESPACE):
#   - get/list mcpservers.clerum.io
#   - get configmaps and deployments
#   - get the Secrets named by the secretKeyRef entries of referenced names only
# The script never writes to the cluster.
#
# Value-handling contract: no Secret value and no resolved env value is printed
# on any stream, put in argv (visible in `ps`), or written to disk. No URL
# query/path text is printed or put in argv either, but the rendered template
# does reach disk: it is CRD text, so a baseUrl query or path (or a literal
# valueTemplate) can appear in it. The script writes it as a 0600 file inside a
# 0700 mktemp directory that the EXIT trap removes; a SIGKILL can leave the
# directory behind. Resolved values travel from the API response into the
# environment of a clean `env -i` child through a pipe, and that child runs the
# repository's real nginx-egress-proxy/egress-proxy-template-check on the live
# rendered template. Diagnostics name only the namespace, server, env-var name,
# source category, and NGINX context.
#
# Exit codes:
#   0  VERDICT=CLEAN              at least one server checked, all OK
#   1  VERDICT=VALUES_REJECTED    at least one REJECT
#   2  VERDICT=ERROR              usage, missing tool, kubectl/RBAC failure, or
#                                 a check run that produced no verdict
#   3  VERDICT=INCONCLUSIVE       no REJECT, at least one server not judged
#   4  VERDICT=NO_REMOTE_SERVERS  zero remote servers matched; never a success
#
# Static checks (CRD text, never values):
#   S1  literal URL characters the new HCC refuses after WHATWG normalization:
#       the query (from the first "?" to the first "#"), with complete ${NAME}
#       placeholders removed, may not hold \ ; { } $; the path may not hold $ ;.
#   S2  a query placeholder or authHeader reference naming one of the eight
#       reserved egress-proxy names or one of the nine FORBIDDEN_CRD_ENV_NAMES.
# The two name lists live on the RESERVED_NAMES= and FORBIDDEN_NAMES= lines so
# that host-context-controller's SC-1 test can compare them with the TypeScript
# sets instead of duplicating them.
#
# Values the check must judge are resolved only for names the live template
# references, with the reference patterns of egress-proxy-template-check's
# reference_at. A container envFrom entry means the Deployment was changed
# outside HCC (buildContainerEnv never emits envFrom), so the value source is
# unknowable and the server is INCONCLUSIVE. A Deployment without exactly one
# egress-proxy container is treated like a missing one (reason=no-deployment):
# it is not the shape HCC writes.
#
# Names reserved for this script: every internal shell variable that holds
# tenant-derived data, and every variable of the env -i child, starts with
# `epvp_`. A tenant-chosen env name that starts with `epvp_`, that bash rewrites
# for a child (`_`), or that is unsafe for any local process (dynamic loader,
# locale, awk/bash startup) is never exported: the server is INCONCLUSIVE
# reason=unsafe-env-name. Refusing the name keeps a tenant value from
# overwriting a variable this script depends on.
#
# A `value` literal holding `$(` is INCONCLUSIVE reason=dependent-env-reference:
# Kubernetes expands dependent env references at container start, so the pod's
# value is not the literal the CRD holds. The new HCC refuses such a literal by
# design; replace it before the upgrade.
#
# The live template is the one the current HCC rendered; the new renderer adds
# directives and comments but no env reference and moves no placeholder.
#
# shellcheck shell=bash
# shellcheck disable=SC2016 # awk and env -i child programs are literal: $0, $1
# and $@ inside those single-quoted programs are the child's own fields.

set -u
set -o pipefail

# Eight names read by the image's 20-envsubst-on-templates.sh or exported by its
# 15-local-resolvers.envsh (union of ENVSUBST_PINNED_PROXY_ENV and
# RESOLVER_RESERVED_PROXY_ENV in host-context-controller/src/reconciler.ts).
RESERVED_NAMES='NGINX_ENVSUBST_TEMPLATE_DIR NGINX_ENVSUBST_TEMPLATE_SUFFIX NGINX_ENVSUBST_OUTPUT_DIR NGINX_ENVSUBST_STREAM_TEMPLATE_SUFFIX NGINX_ENVSUBST_STREAM_OUTPUT_DIR NGINX_ENVSUBST_FILTER NGINX_ENTRYPOINT_LOCAL_RESOLVERS NGINX_LOCAL_RESOLVERS'
# Nine names sanitizeCrdSpec strips from spec.env (FORBIDDEN_CRD_ENV_NAMES).
FORBIDDEN_NAMES='LD_PRELOAD LD_LIBRARY_PATH PATH NODE_OPTIONS PYTHONPATH JAVA_TOOL_OPTIONS KUBECONFIG KUBERNETES_SERVICE_HOST KUBERNETES_SERVICE_PORT'

epvp_die() {
  printf 'VERDICT=ERROR reason=%s\n' "$1" >&2
  exit 2
}

[ -n "${CONTEXT:-}" ] || epvp_die 'usage: CONTEXT is required (kubectl context)'
[ -n "${NAMESPACE:-}" ] || epvp_die 'usage: NAMESPACE is required (McpServer namespace)'

epvp_tool=
for epvp_tool in kubectl jq awk bash base64; do
  command -v "$epvp_tool" >/dev/null 2>&1 || epvp_die "missing-tool=$epvp_tool"
done
epvp_awk_bin=$(command -v awk) || epvp_die 'missing-tool=awk'
epvp_bash_bin=$(command -v bash) || epvp_die 'missing-tool=bash'
epvp_check="$(
  CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P
)/nginx-egress-proxy/egress-proxy-template-check"
[ -r "$epvp_check" ] || epvp_die "missing-check=$epvp_check"

umask 077
epvp_work=$(mktemp -d "${TMPDIR:-/tmp}/egress-proxy-value-preflight.XXXXXX") ||
  epvp_die 'mktemp-failed'
# shellcheck disable=SC2064 # expanded when the trap runs, after epvp_work is set
trap 'rm -rf -- "$epvp_work"' EXIT

epvp_kc() {
  # stdin is the server-name list of the outer loop; no kubectl call may
  # consume it.
  kubectl --context "$CONTEXT" "$@" </dev/null
}

# True when $1 is one of the space-separated names in $2.
epvp_list_has() {
  case " $2 " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

# Unsafe for a local process, or reserved by this script. Prints nothing.
epvp_unsafe_name() {
  case $1 in
    # Dynamic loader, C-library locale and message catalogs, awk/bash startup.
    LD_* | DYLD_* | LC_* | \
      GCONV_PATH | GLIBC_TUNABLES | LOCPATH | NLSPATH | LANG | \
      AWKPATH | AWKLIBPATH | POSIXLY_CORRECT | BASH_ENV)
      return 0
      ;;
    # bash makes these read-only at startup, so `export` fails.
    BASHOPTS | BASH_VERSINFO | EUID | PPID | SHELLOPTS | UID)
      return 0
      ;;
    # bash rewrites `_` for the command it execs.
    _)
      return 0
      ;;
    # Every internal variable of this script and of the env -i child.
    epvp_*)
      return 0
      ;;
  esac
  return 1
}

# Valid POSIX shell identifier; names come from the template regex, and the
# export in the child requires this shape.
epvp_valid_name() {
  case $1 in
    '' | [0-9]*) return 1 ;;
    [A-Za-z_]*)
      case $1 in
        *[!A-Za-z0-9_]*) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
  return 0
}

# --- server selection -------------------------------------------------------
#
# The API responses stay in shell variables: a baseUrl query or an authHeader
# valueTemplate may hold a literal credential, so a JSON file under $epvp_work
# would put that text on disk. Only names, rule names, the static findings and
# the rendered template reach a file. The template is the CRD text the live HCC
# rendered, so it can hold a literal URL query or path; it never holds a
# resolved Secret or env value, which exist only in memory and in the pipe to
# the check child.

epvp_servers=$(epvp_kc get mcpservers -n "$NAMESPACE" -o json 2>/dev/null) ||
  epvp_die 'kubectl-get-mcpservers'
printf '%s' "$epvp_servers" |
  jq -r '(.items // [])[]
    | select(.spec.remote.baseUrl != null)
    | select(.spec.managed != false)
    | select(.spec.enabled != false)
    | .metadata.name' >"$epvp_work/names" 2>/dev/null ||
  epvp_die 'invalid-mcpservers-json'

# --- static checks on the CRD text (S1, S2) --------------------------------
#
# The URL travels on stdin, never argv: the literal query and path text may hold
# a credential. Findings name only the rule and, for S2, the env-var or header
# name; the URL text is never echoed.

epvp_static_findings() {
  printf '%s' "$1" | LC_ALL=C "$epvp_awk_bin" '
    # The WHATWG parser leaves \, ;, {, } and $ unchanged in a query and $ and ;
    # unchanged in a path (it turns an unescaped \ into / and percent-encodes
    # braces in a path), and no control byte or space survives it. The raw text
    # therefore gives the new HCC verdict for the characters checked here.
    { url = url $0 }
    END {
      hash = index(url, "#")
      qpos = index(url, "?")
      q = ""
      if (qpos > 0 && (hash == 0 || qpos < hash)) {
        if (hash > qpos) q = substr(url, qpos + 1, hash - qpos - 1)
        else q = substr(url, qpos + 1)
      }
      # Complete ${NAME} placeholders are dynamic, not literal text.
      while (match(q, /[$][{][A-Za-z_][A-Za-z0-9_]*[}]/)) {
        print "s2q", substr(q, RSTART + 2, RLENGTH - 3)
        q = substr(q, 1, RSTART - 1) substr(q, RSTART + RLENGTH)
      }
      if (index(q, "\\") || index(q, ";") || index(q, "{") ||
          index(q, "}") || index(q, "$")) print "s1", "query"
      p = ""
      scheme = index(url, "://")
      if (scheme > 0) {
        rest = substr(url, scheme + 3)
        slash = index(rest, "/")
        if (slash > 0) p = substr(rest, slash)
      }
      if (p != "") {
        c1 = index(p, "?")
        c2 = index(p, "#")
        cut = 0
        if (c1 > 0) cut = c1
        if (c2 > 0 && (cut == 0 || c2 < cut)) cut = c2
        if (cut > 0) p = substr(p, 1, cut - 1)
      }
      if (index(p, "$") || index(p, ";")) print "s1", "path"
    }'
}

epvp_static_lines() {
  local url=$1 headers=$2 findings=$3
  : >"$findings"
  epvp_static_findings "$url" >"$epvp_work/url-findings"
  while read -r epvp_kind epvp_found; do
    case $epvp_kind in
      s1)
        printf 'static: S1 literal %s text is refused by the new HCC; mcp-host disconnects this server\n' \
          "$epvp_found" >>"$findings"
        ;;
      s2q)
        if epvp_list_has "$epvp_found" "$RESERVED_NAMES"; then
          printf 'static: S2 query placeholder %s names a reserved egress-proxy env var; the new HCC fails this server\n' \
            "$epvp_found" >>"$findings"
        elif epvp_list_has "$epvp_found" "$FORBIDDEN_NAMES"; then
          printf 'static: S2 query placeholder %s names a forbidden CRD env var; the new HCC fails this server\n' \
            "$epvp_found" >>"$findings"
        fi
        ;;
    esac
  done <"$epvp_work/url-findings"
  printf '%s' "$headers" |
    jq -r '.[] | (.header // "") as $h
      | [((.valueTemplate // "") | scan("[$][{]?[A-Za-z_][A-Za-z0-9_]*"))] | .[]
      | "\($h) \(.)"' >"$epvp_work/header-refs" 2>/dev/null ||
    epvp_die "invalid-authheaders-json $NAMESPACE"
  while read -r epvp_header epvp_ref; do
    [ -n "$epvp_header" ] && [ -n "$epvp_ref" ] || continue
    epvp_ref=${epvp_ref#\$}
    epvp_ref=${epvp_ref#\{}
    if epvp_list_has "$epvp_ref" "$RESERVED_NAMES"; then
      printf 'static: S2 authHeader %s references reserved name %s; the new HCC drops this header\n' \
        "$epvp_header" "$epvp_ref" >>"$findings"
    elif epvp_list_has "$epvp_ref" "$FORBIDDEN_NAMES"; then
      printf 'static: S2 authHeader %s references forbidden name %s; the new HCC drops this header\n' \
        "$epvp_header" "$epvp_ref" >>"$findings"
    fi
  done <"$epvp_work/header-refs"
}

# --- per-server inventory ---------------------------------------------------

epvp_checked=0
epvp_ok=0
epvp_rejected=0
epvp_inconclusive=0

epvp_summary() {
  printf 'VERDICT=%s checked=%d ok=%d rejected=%d inconclusive=%d\n' \
    "$1" "$epvp_checked" "$epvp_ok" "$epvp_rejected" "$epvp_inconclusive"
}

epvp_name_inconclusive() {
  printf 'server=%s/%s verdict=INCONCLUSIVE reason=%s name=%s\n' \
    "$NAMESPACE" "$epvp_name" "$2" "$1"
  [ -n "$epvp_reason" ] || epvp_reason=$2
}

epvp_server_inconclusive() {
  printf 'server=%s/%s verdict=INCONCLUSIVE reason=%s\n' "$NAMESPACE" "$epvp_name" "$1"
  epvp_inconclusive=$((epvp_inconclusive + 1))
}

while IFS= read -r epvp_name; do
  [ -n "$epvp_name" ] || continue
  epvp_checked=$((epvp_checked + 1))

  # The last matching list entry wins, as for a duplicated env name: list names
  # are unique in Kubernetes, so this keeps one rule for every name resolution.
  epvp_url=$(printf '%s' "$epvp_servers" | jq -jr --arg n "$epvp_name" \
    '[(.items // [])[] | select(.metadata.name == $n)] | last
      | .spec.remote.baseUrl // ""' \
    2>/dev/null) || epvp_die "invalid-mcpservers-json $NAMESPACE/$epvp_name"
  epvp_headers=$(printf '%s' "$epvp_servers" | jq -c --arg n "$epvp_name" \
    '[(.items // [])[] | select(.metadata.name == $n)] | last
      | .spec.remote.authHeaders // []' \
    2>/dev/null) || epvp_die "invalid-mcpservers-json $NAMESPACE/$epvp_name"

  # A static finding makes the server REJECT whatever the other steps say, so
  # the objects are not read when one is present.
  epvp_static_lines "$epvp_url" "$epvp_headers" "$epvp_work/static"
  if [ -s "$epvp_work/static" ]; then
    printf 'server=%s/%s verdict=REJECT\n' "$NAMESPACE" "$epvp_name"
    LC_ALL=C "$epvp_awk_bin" '{ print "  " $0 }' "$epvp_work/static"
    epvp_rejected=$((epvp_rejected + 1))
    continue
  fi

  epvp_configmap=$(epvp_kc -n "$NAMESPACE" get configmap "$epvp_name-nginx-conf" \
    -o json --ignore-not-found 2>/dev/null) ||
    epvp_die "kubectl-get-configmap $NAMESPACE/$epvp_name"
  if [ -z "$epvp_configmap" ] ||
    ! printf '%s' "$epvp_configmap" | jq -e '.data | has("default.conf.template")' \
      >/dev/null 2>&1; then
    epvp_server_inconclusive no-configmap
    continue
  fi
  # The template holds CRD text with placeholders and no resolved value; it is
  # the only file that may hold a baseUrl query or path, so it goes to the 0600
  # file inside the 0700 directory and the EXIT trap removes it.
  printf '%s' "$epvp_configmap" | jq -jr '.data["default.conf.template"]' \
    >"$epvp_work/template" 2>/dev/null ||
    epvp_die "invalid-configmap-json $NAMESPACE/$epvp_name"

  epvp_deployment=$(epvp_kc -n "$NAMESPACE" get deployment "$epvp_name" \
    -o json --ignore-not-found 2>/dev/null) ||
    epvp_die "kubectl-get-deployment $NAMESPACE/$epvp_name"
  if [ -z "$epvp_deployment" ] ||
    ! printf '%s' "$epvp_deployment" |
      jq -e '[.spec.template.spec.containers[]? | select(.name == "egress-proxy")] | length == 1' \
        >/dev/null 2>&1; then
    epvp_server_inconclusive no-deployment
    continue
  fi
  # buildContainerEnv emits only value and secretKeyRef, so envFrom means the
  # Deployment was changed outside HCC and the env source cannot be inventoried.
  if printf '%s' "$epvp_deployment" |
    jq -e '(.spec.template.spec.containers[] | select(.name == "egress-proxy")
      | (.envFrom // []) | length) > 0' >/dev/null 2>&1; then
    epvp_server_inconclusive unsupported-value-source
    continue
  fi

  # Referenced names only, with reference_at's patterns: a tenant name the live
  # template does not reference never reaches a local process.
  LC_ALL=C "$epvp_awk_bin" '
    {
      line = $0
      while (match(line, /[$]([{][A-Za-z_][A-Za-z0-9_]*[}]|[A-Za-z_][A-Za-z0-9_]*)/)) {
        token = substr(line, RSTART + 1, RLENGTH - 1)
        if (substr(token, 1, 1) == "{") token = substr(token, 2, length(token) - 2)
        print token
        line = substr(line, RSTART + RLENGTH)
      }
    }' <"$epvp_work/template" | LC_ALL=C sort -u >"$epvp_work/refs" ||
    epvp_die "read-template $NAMESPACE/$epvp_name"

  epvp_index=0
  epvp_reason=
  while IFS= read -r epvp_ref; do
    [ -n "$epvp_ref" ] || continue
    if ! epvp_valid_name "$epvp_ref" || epvp_unsafe_name "$epvp_ref"; then
      epvp_name_inconclusive "$epvp_ref" unsafe-env-name
      continue
    fi
    # Kubernetes keeps the last entry of a duplicated env name; HCC's
    # checkEgressProxyValues builds the same last-wins Map (reconciler.ts:1407).
    # Resolving the first entry would judge a value the pod never runs and could
    # call a server CLEAN that the new HCC blocks.
    epvp_entry=$(printf '%s' "$epvp_deployment" | jq -c --arg n "$epvp_ref" '
      [.spec.template.spec.containers[]
      | select(.name == "egress-proxy") | (.env // [])[]
      | select(.name == $n)] | .[-1] // empty' 2>/dev/null) ||
      epvp_die "invalid-deployment-json $NAMESPACE/$epvp_name"
    # Not in the container env: left undefined, as the pod's envsubst would
    # leave it; the check reports an undefined braced reference.
    [ -n "$epvp_entry" ] || continue
    epvp_source=$(printf '%s' "$epvp_entry" | jq -jr 'if has("valueFrom")
      then (if (.valueFrom.secretKeyRef | type) == "object" then "secret" else "unsupported" end)
      else "literal" end') || epvp_die "invalid-deployment-json $NAMESPACE/$epvp_name"
    case $epvp_source in
      unsupported)
        epvp_name_inconclusive "$epvp_ref" unsupported-value-source
        continue
        ;;
      secret)
        epvp_secret=$(printf '%s' "$epvp_entry" |
          jq -jr '.valueFrom.secretKeyRef.name // empty')
        epvp_key=$(printf '%s' "$epvp_entry" |
          jq -jr '.valueFrom.secretKeyRef.key // empty')
        if [ -z "$epvp_secret" ] || [ -z "$epvp_key" ]; then
          epvp_name_inconclusive "$epvp_ref" unsupported-value-source
          continue
        fi
        if ! epvp_secret_json=$(epvp_kc -n "$NAMESPACE" get secret "$epvp_secret" \
          -o json --ignore-not-found 2>/dev/null); then
          epvp_die "kubectl-get-secret $NAMESPACE/$epvp_secret"
        fi
        if [ -z "$epvp_secret_json" ]; then
          epvp_name_inconclusive "$epvp_ref" secret-unreadable
          continue
        fi
        # Presence first: an empty Secret value is an empty base64 string, which
        # is indistinguishable from an absent key by content alone. A key that
        # exists with an empty value is judged like any other value (both value
        # classes accept the empty string); only a missing key is unreadable.
        if ! printf '%s' "$epvp_secret_json" |
          jq -e --arg k "$epvp_key" '(.data // {}) | has($k)' >/dev/null 2>&1; then
          epvp_name_inconclusive "$epvp_ref" secret-unreadable
          continue
        fi
        epvp_encoded=$(printf '%s' "$epvp_secret_json" |
          jq -jr --arg k "$epvp_key" '.data[$k] // empty' 2>/dev/null) ||
          epvp_die "invalid-secret-json $NAMESPACE/$epvp_secret"
        # base64-decoded in a pipe: the value is never stored outside memory.
        if ! printf '%s' "$epvp_encoded" | base64 -d >/dev/null 2>&1; then
          epvp_name_inconclusive "$epvp_ref" secret-unreadable
          continue
        fi
        epvp_value=$( { printf '%s' "$epvp_encoded" | base64 -d; printf x; } )
        epvp_value=${epvp_value%x}
        ;;
      literal)
        epvp_value=$(printf '%s' "$epvp_entry" | jq -jr '.value // ""'; printf x)
        epvp_value=${epvp_value%x}
        case $epvp_value in
          *'$('*)
            epvp_name_inconclusive "$epvp_ref" dependent-env-reference
            printf '  advice: Kubernetes expands $(NAME) in env[].value at container start; store the final value before upgrading\n'
            continue
            ;;
        esac
        ;;
      *)
        epvp_die "internal-value-source $NAMESPACE/$epvp_name"
        ;;
    esac

    # resolved: value of one referenced name
    printf -v "epvp_pn_$epvp_index" '%s' "$epvp_ref"
    printf -v "epvp_pv_$epvp_index" '%s' "$epvp_value"
    epvp_index=$((epvp_index + 1))
  done <"$epvp_work/refs"

  if [ -n "$epvp_reason" ]; then
    # A server with any INCONCLUSIVE name is not run through the check: its
    # environment would be incomplete and a verdict would be misleading.
    printf 'server=%s/%s verdict=INCONCLUSIVE reason=%s\n' \
      "$NAMESPACE" "$epvp_name" "$epvp_reason"
    epvp_inconclusive=$((epvp_inconclusive + 1))
    continue
  fi

  epvp_feed() {
    epvp_i=0
    while [ "$epvp_i" -lt "$epvp_index" ]; do
      epvp_kn=epvp_pn_$epvp_i
      epvp_kv=epvp_pv_$epvp_i
      printf '%s\0%s\0' "${!epvp_kn}" "${!epvp_kv}"
      epvp_i=$((epvp_i + 1))
    done
  }

  # The child reads every entry before it exports any, then exports all of them
  # and execs the real check with a clean environment that holds exactly the
  # resolved referenced names (plus LC_ALL). Values never reach argv or disk: an
  # exported PATH cannot select the awk binary, and a name this script reserved
  # (epvp_*) cannot overwrite the child's loop state.
  epvp_check_rc=0
  epvp_feed |
    env -i LC_ALL=C "$epvp_bash_bin" -c '
      epvp_count=0
      while IFS= read -r -d "" epvp_item; do
        set -- "$@" "$epvp_item"
        epvp_count=$((epvp_count + 1))
      done
      if [ $((epvp_count % 2)) -ne 0 ]; then
        printf "egress-proxy-value-preflight: malformed value stream\n" >&2
        exit 3
      fi
      epvp_i=4
      while [ "$epvp_i" -le "$#" ]; do
        epvp_nm=${!epvp_i}
        epvp_i=$((epvp_i + 1))
        epvp_vl=${!epvp_i}
        export "$epvp_nm=$epvp_vl" || exit 4
        epvp_i=$((epvp_i + 1))
      done
      exec "$1" -f "$2" "$3"
    ' _ "$epvp_awk_bin" "$epvp_check" "$epvp_work/template" \
      >"$epvp_work/check.out" 2>"$epvp_work/check.err"
  epvp_check_rc=$?

  epvp_messages=$(LC_ALL=C grep -Ec \
    'is not allowed in|is not defined in the environment' \
    "$epvp_work/check.out" 2>/dev/null) || epvp_messages=0

  # The check names the template path; print the server instead. The message
  # holds the variable name and the NGINX context, never the value.
  LC_ALL=C "$epvp_awk_bin" -v p="$epvp_work/template" -v r="$NAMESPACE/$epvp_name" '
    { while ((at = index($0, p)) > 0) $0 = substr($0, 1, at - 1) r substr($0, at + length(p)); print }' \
    "$epvp_work/check.out" >"$epvp_work/check.msg"

  case $epvp_check_rc in
    0)
      printf 'server=%s/%s verdict=OK\n' "$NAMESPACE" "$epvp_name"
      epvp_ok=$((epvp_ok + 1))
      ;;
    1)
      if [ "${epvp_messages:-0}" -gt 0 ]; then
        printf 'server=%s/%s verdict=REJECT\n' "$NAMESPACE" "$epvp_name"
        LC_ALL=C "$epvp_awk_bin" '{ print "  " $0 }' "$epvp_work/check.msg"
        epvp_rejected=$((epvp_rejected + 1))
      else
        epvp_die "check-produced-no-verdict $NAMESPACE/$epvp_name"
      fi
      ;;
    *)
      epvp_die "check-produced-no-verdict $NAMESPACE/$epvp_name (exit $epvp_check_rc)"
      ;;
  esac
done <"$epvp_work/names"

if [ "$epvp_checked" -eq 0 ]; then
  epvp_summary NO_REMOTE_SERVERS
  exit 4
fi
if [ "$epvp_rejected" -gt 0 ]; then
  epvp_summary VALUES_REJECTED
  exit 1
fi
if [ "$epvp_inconclusive" -gt 0 ]; then
  epvp_summary INCONCLUSIVE
  exit 3
fi
epvp_summary CLEAN
exit 0
