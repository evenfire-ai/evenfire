#!/usr/bin/env bash
# Runtime TLS and log-redaction contract for the remote MCP
# egress proxy.
#
# Builds nginx-egress-proxy/Dockerfile, renders the per-server
# default.conf.template with the real HCC McpServerReconciler, and starts the
# image through its own entrypoint (so the /etc/nginx/templates envsubst step
# runs) with the docker equivalent of the securityContext HCC generates for the
# egress-proxy container (user, dropped capabilities, no_new_privs, the default
# seccomp profile), checked on the NGINX master process.
#
# A local TLS upstream presents one certificate per port:
#
#   valid     leaf issued by test CA A            -> 200
#   chain2    leaf under two CA A intermediates   -> 200 (proxy_ssl_verify_depth 3)
#   untrusted leaf issued by test CA B            -> 502, (21:unable to verify the first certificate)
#   expired   expired leaf issued by CA A         -> 502, certificate has expired
#   wrongsan  CA A leaf for other.test            -> 502, does not match "upstream.test"
#   nobundle  valid leaf, image's own CA bundle   -> 502, (21:unable to verify the first certificate)
#
# CA A is mounted over /etc/ssl/certs/ca-certificates.crt in every case except
# nobundle. That proves the proxy's verification settings, not the contents of
# the production bundle. Each 502 case first completes a direct handshake with
# the upstream port and then checks that its request token never reached the
# upstream.
#
# The upstream sends only the leaf, so OpenSSL reports a missing issuer of the
# leaf as error 21, not 20 (which needs an intermediate with a missing issuer).
#
# Cases (14, the run fails unless exactly this many ran):
#
#   valid, chain2, untrusted, expired, wrongsan, nobundle   TLS contract
#   query-accept   a ${VAR} query placeholder is resolved by envsubst inside the
#                  container and reaches the upstream (#1240)
#   redact         an upstream error line never carries the remote query, in the
#                  IP form, a line truncated at NGINX's 2047-byte error cap,
#                  and a line where upstream bytes quoted in the message put a
#                  fake field ahead of the real one while the client request
#                  itself holds a quote; the message rule removes the whole
#                  quoted echo there (#1240)
#   echo           an upstream echoes a credential the proxy forwarded (the
#                  per-user OAuth Bearer, a static authHeaders value and the
#                  query value) in the response headers NGINX quotes, plus the
#                  two X-Accel headers the generated template ignores: the
#                  filtered log never holds a marker and each echo has its own
#                  upstream access-log witness (#1240)
#   filter-lines   the shipped filter program on fixed NGINX 1.30.6 lines a live
#                  upstream fixture cannot produce (P2-P4, the no-context
#                  branch, a non-quoting control), behind the audited-release
#                  gate (#1240)
#   signals        QUIT and TERM reach the NGINX master, which is PID 1
#   filter-death   the exec liveness script fails once the stderr filter dies,
#                  and no unfiltered error line reaches the logs
#   value-reject   a query value, a header value and a lowercase name matching a
#                  template NGINX variable that would change the NGINX syntax
#                  stop the container before NGINX starts, naming the variable
#                  and never the value; a valid header value with + / = and a
#                  space is served unchanged
#   template-check the check's verdict for seven NGINX contexts × 24 values plus
#                  two special rows, against real NGINX parsing and serving, and
#                  zero rows disagreeing with the reviewed table (#1240)
#
# Requires docker, curl, openssl, node and `npm ci` in host-context-controller.
#
# NGINX_TLS_TEST_MUTATION=<mode> rewrites the rendered template or builds the
# image from an edited copy, to prove the cases detect a broken build. A mutated
# run is expected to fail:
#
#   verify-off            proxy_ssl_verify off               -> untrusted, expired, wrongsan, nobundle red
#   depth-1               proxy_ssl_verify_depth 1           -> chain2 red
#   no-redact             runs the proxy without its filter  -> redact, echo, filter-death red
#   liveness-health-only  liveness script checks /health only -> filter-death red
#   redact-first-quote    filter ends the field at the first quote -> redact (req4) red
#   no-value-check        wrapper skips the template value check -> value-reject red
#   no-message-redact     filter drops the message rule      -> redact (req4), echo (E1-E5),
#                                                             filter-lines (S1-S3, S5) red
#   message-first-client  message rule stops at the first client field -> echo (E4),
#                                                             filter-lines (S1-S3) red
#   message-no-cut        message rule ignores the 2047-byte cap -> echo (E5) red
#   message-no-default    message rule has no no-context branch -> filter-lines (S5) red
#   no-ignore-accel       template stops ignoring X-Accel-*  -> echo (E6a, E6b, and the
#                                                             marker scan) red
#   template-check-mismatch  check accepts %zz / %2 unquoted  -> template-check red
#
# audit-version is a run-time switch, not a file mutation: it compares the built
# image's release against nginx/0.0.0, so the release gate in filter-lines (and
# nothing else) goes red. A gate that never read the image would stay green.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HCC_DIR="$REPO_ROOT/host-context-controller"
DOCKERFILE_DIR="$REPO_ROOT/nginx-egress-proxy"
MUTATION="${NGINX_TLS_TEST_MUTATION:-}"
PREFIX="nginx-tls-test"
RUN_ID="$(date +%s)-$$"
NAME="$PREFIX-$RUN_ID"
NETWORK="$NAME-net"
PROXY_IMAGE="$NAME-proxy:local"
UPSTREAM="$NAME-upstream"
WORK="$(mktemp -d)"
EXPECTED_CASES=14
# The release the message list in egress-proxy-log-filter was audited against.
# filter-lines reads the release of the built image and fails on any other one,
# so a base bump cannot ship an unaudited upstream-quoting message.
AUDITED_NGINX_VERSION=nginx/1.30.6
# shellcheck disable=SC2016  # awk program: $2 is an awk field, not a shell expansion.
RSS_AWK='/^VmRSS:/ { s += $2 } END { print s + 0 }'
failures=0
cases=0

for tool in docker curl openssl node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FAIL: $tool is required" >&2; exit 1; }
done
if [ ! -f "$HCC_DIR/node_modules/ts-node/dist/bin.js" ]; then
  echo "FAIL: run npm ci in host-context-controller first (ts-node is missing)" >&2
  exit 1
fi
case "$MUTATION" in
  "" | verify-off | depth-1 | no-redact | liveness-health-only | \
    redact-first-quote | no-value-check | no-message-redact | message-first-client | \
    message-no-cut | message-no-default | no-ignore-accel | audit-version | \
    template-check-mismatch) ;;
  *) echo "FAIL: unknown NGINX_TLS_TEST_MUTATION '$MUTATION'" >&2; exit 1 ;;
esac

leftovers="$(docker ps -a --filter "name=^$PREFIX-" --format '{{.Names}}')"
if [ -n "$leftovers" ]; then
  echo "FAIL: containers from an earlier run still exist; remove them first:" >&2
  echo "$leftovers" >&2
  exit 1
fi

cleanup() {
  docker ps -a --filter "name=^$NAME-" --format '{{.Names}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker image rm "$PROXY_IMAGE" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

# Replaces the one literal occurrence of <from> with <to> in a file under
# $WORK (a rendered template or a copy of the build context). Any other count
# stops the run, so a mutation can never silently match nothing.
mutate() {
  local file="$1" from="$2" to="$3" count content
  count="$(grep -cF -- "$from" "$file" || true)"
  if [ "$count" != "1" ]; then
    echo "FAIL: mutation expected one '$from' in $file, found $count" >&2
    exit 1
  fi
  content="$(cat "$file"; printf x)"
  content="${content%x}"
  printf '%s' "${content/"$from"/"$to"}" >"$file"
}

# ─── Images ──────────────────────────────────────────────────────────────────

BASE_IMAGE="$(sed -n 's/^FROM[[:space:]]\{1,\}\([^[:space:]]*\).*/\1/p' "$DOCKERFILE_DIR/Dockerfile")"
[ -n "$BASE_IMAGE" ] || { echo "FAIL: no FROM line in $DOCKERFILE_DIR/Dockerfile" >&2; exit 1; }
# With NGINX_REGISTRY_MIRROR set (CI uses mirror.gcr.io), the Docker Hub base is
# pulled from the mirror by digest, for the build and for the upstream. The
# build log must name the mirror reference: a --build-context key that does not
# match the FROM line is ignored by BuildKit, which then pulls Docker Hub.
UPSTREAM_IMAGE="$BASE_IMAGE"
MIRROR="${NGINX_REGISTRY_MIRROR:-}"

# Image mutations edit a copy of the build context in $WORK; the repository
# tree is never modified. The filter and liveness scripts are part of the image
# contract, so a mutation that removes their behaviour has to be built, not
# switched on with an environment variable the production image would read.
build_context="$DOCKERFILE_DIR"
if [ "$MUTATION" = "liveness-health-only" ]; then
  build_context="$WORK/image-mutation"
  cp -R "$DOCKERFILE_DIR" "$build_context"
  cat >"$build_context/egress-proxy-liveness" <<'LIVENESS'
#!/bin/sh
# Vacuity mutation: the probe only checks /health and never looks at the log
# filter, so a dead filter would leave the pod Ready and silent.
set -u
wget -q -T 2 -O /dev/null "http://127.0.0.1:${1:?}/health"
LIVENESS
  chmod 0755 "$build_context/egress-proxy-liveness"
fi
case "$MUTATION" in
  no-value-check)
    build_context="$WORK/image-mutation"
    cp -R "$DOCKERFILE_DIR" "$build_context"
    # shellcheck disable=SC2016 # literal shell text in the wrapper
    mutate "$build_context/egress-proxy-entrypoint" \
      'exec awk -f "$TEMPLATE_CHECK" $templates' 'exec true'
    ;;
  template-check-mismatch)
    build_context="$WORK/image-mutation"
    cp -R "$DOCKERFILE_DIR" "$build_context"
    # C6 of the R1-M2 table: `%` stays in the class, so the check accepts a
    # value NGINX serves as something else and the driver reports MISMATCH>0.
    # H15 has to fail on that count, not only on the driver's exit status.
    mutate "$build_context/egress-proxy-template-check" \
      'gsub(/%[0-9A-Fa-f][0-9A-Fa-f]/, "", rest)' 'gsub(/%/, "", rest)'
    ;;
  redact-first-quote)
    build_context="$WORK/image-mutation"
    cp -R "$DOCKERFILE_DIR" "$build_context"
    mutate "$build_context/egress-proxy-log-filter" 'NEXT_HOST = "\", host: \""' 'NEXT_HOST = "\""'
    ;;
  no-message-redact | message-first-client | message-no-cut | message-no-default)
    build_context="$WORK/image-mutation"
    cp -R "$DOCKERFILE_DIR" "$build_context"
    filter_copy="$build_context/egress-proxy-log-filter"
    case "$MUTATION" in
      no-message-redact)
        # The field rule sees the raw line again, so the quoted echo survives.
        # shellcheck disable=SC2016  # literal awk text, not a shell expansion.
        mutate "$filter_copy" 'rest = redact_quoted($0)' 'rest = $0'
        ;;
      message-first-client)
        # The terminator stops at the first forged ", client: " inside the echo.
        # shellcheck disable=SC2016  # literal awk text, not a shell expansion.
        mutate "$filter_copy" \
          'while ((i = index(rest, CONTEXT)) > 0) {' 'if ((i = index(rest, CONTEXT)) > 0) {'
        ;;
      message-no-cut)
        # A cut line keeps its forged terminator and the tail after it.
        # shellcheck disable=SC2016  # literal awk text, not a shell expansion.
        mutate "$filter_copy" 'length(s) >= MAX_ERROR_LINE || last == 0' 'last == 0'
        ;;
      message-no-default)
        # A quoting line with no context at all reprints its tail.
        # shellcheck disable=SC2016  # literal awk text, not a shell expansion.
        mutate "$filter_copy" 'length(s) >= MAX_ERROR_LINE || last == 0' 'length(s) >= MAX_ERROR_LINE'
        ;;
    esac
    ;;
esac

if [ -n "$MIRROR" ]; then
  case "$BASE_IMAGE" in
    nginx:*@sha256:*) ;;
    *) echo "FAIL: NGINX_REGISTRY_MIRROR is set, but FROM '$BASE_IMAGE' is not a Docker Hub nginx:<tag>@<digest>" >&2; exit 1 ;;
  esac
  UPSTREAM_IMAGE="$MIRROR/library/nginx@${BASE_IMAGE#*@}"
  BUILD_LOG="$WORK/build.log"
  if ! docker buildx build --progress=plain --load --build-context "$BASE_IMAGE=docker-image://$UPSTREAM_IMAGE" \
    -t "$PROXY_IMAGE" "$build_context" >"$BUILD_LOG" 2>&1; then
    cat "$BUILD_LOG" >&2
    echo "FAIL: building $PROXY_IMAGE from $UPSTREAM_IMAGE failed" >&2
    exit 1
  fi
  if ! grep -qF "$UPSTREAM_IMAGE" "$BUILD_LOG"; then
    cat "$BUILD_LOG" >&2
    echo "FAIL: the build log does not name $UPSTREAM_IMAGE; the base came from another registry" >&2
    exit 1
  fi
else
  docker build -q -t "$PROXY_IMAGE" "$build_context" >/dev/null
fi
echo "arch: $(docker version --format '{{.Server.Arch}}')"
echo "base image: $BASE_IMAGE (pulled as $UPSTREAM_IMAGE)"
echo "proxy image: $(docker run --rm --entrypoint nginx "$PROXY_IMAGE" -v 2>&1)"
echo "proxy user: $(docker run --rm --entrypoint id "$PROXY_IMAGE")"

# ─── Certificates ────────────────────────────────────────────────────────────

PKI="$WORK/pki"
mkdir -p "$PKI/newcerts"
: >"$PKI/index.txt"
echo 1000 >"$PKI/serial"
cat >"$PKI/openssl.cnf" <<EOF
[ ca ]
default_ca = test_ca
[ test_ca ]
database = $PKI/index.txt
new_certs_dir = $PKI/newcerts
serial = $PKI/serial
default_md = sha256
policy = policy_any
unique_subject = no
copy_extensions = none
[ policy_any ]
commonName = supplied
[ req ]
distinguished_name = dn
[ dn ]
[ v3_root ]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[ v3_int ]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[ v3_leaf ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:upstream.test
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[ v3_leaf_wrongsan ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:other.test
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF

# Fixed dates keep the result independent of clock skew between host and
# container. Only the expired leaf ends in the past.
VALID_FROM=20250101000000Z
VALID_TO=20400101000000Z

new_key_csr() {
  local name="$1" cn="$2"
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -config "$PKI/openssl.cnf" -subj "/CN=$cn" \
    -keyout "$PKI/$name.key" -out "$PKI/$name.csr" 2>/dev/null
}

sign() {
  local name="$1" issuer="$2" ext="$3" from="$4" to="$5"
  openssl ca -batch -notext -config "$PKI/openssl.cnf" \
    -cert "$PKI/$issuer.pem" -keyfile "$PKI/$issuer.key" \
    -extensions "$ext" -startdate "$from" -enddate "$to" \
    -in "$PKI/$name.csr" -out "$PKI/$name.pem" 2>/dev/null
}

root() {
  local name="$1" cn="$2"
  new_key_csr "$name" "$cn"
  openssl ca -batch -notext -selfsign -config "$PKI/openssl.cnf" \
    -keyfile "$PKI/$name.key" -extensions v3_root \
    -startdate "$VALID_FROM" -enddate "$VALID_TO" \
    -in "$PKI/$name.csr" -out "$PKI/$name.pem" 2>/dev/null
}

root ca-a "TLS Test CA A"
root ca-b "TLS Test CA B"
new_key_csr int1 "TLS Test CA A Intermediate 1"
sign int1 ca-a v3_int "$VALID_FROM" "$VALID_TO"
new_key_csr int2 "TLS Test CA A Intermediate 2"
sign int2 int1 v3_int "$VALID_FROM" "$VALID_TO"

new_key_csr valid upstream.test
sign valid ca-a v3_leaf "$VALID_FROM" "$VALID_TO"
new_key_csr chain2 upstream.test
sign chain2 int2 v3_leaf "$VALID_FROM" "$VALID_TO"
new_key_csr untrusted upstream.test
sign untrusted ca-b v3_leaf "$VALID_FROM" "$VALID_TO"
new_key_csr expired upstream.test
sign expired ca-a v3_leaf 20250101000000Z 20250201000000Z
new_key_csr wrongsan other.test
sign wrongsan ca-a v3_leaf_wrongsan "$VALID_FROM" "$VALID_TO"

cp "$PKI/valid.pem" "$PKI/valid.chain.pem"
cat "$PKI/chain2.pem" "$PKI/int2.pem" "$PKI/int1.pem" >"$PKI/chain2.chain.pem"
cp "$PKI/untrusted.pem" "$PKI/untrusted.chain.pem"
cp "$PKI/expired.pem" "$PKI/expired.chain.pem"
cp "$PKI/wrongsan.pem" "$PKI/wrongsan.chain.pem"
cp "$PKI/ca-a.pem" "$WORK/trust-ca-a.pem"
chmod 644 "$PKI"/*.pem "$PKI"/*.key "$WORK/trust-ca-a.pem"

# ─── Upstream ────────────────────────────────────────────────────────────────

port_of() {
  case "$1" in
    valid | nobundle) echo 8441 ;;
    chain2) echo 8442 ;;
    untrusted) echo 8443 ;;
    expired) echo 8444 ;;
    wrongsan) echo 8445 ;;
  esac
}

{
  # H13 fixture design: one exact-match /echo location per server. X-Echo-Mode
  # selects what the upstream sends back in a response header, so one proxy can
  # carry every credential kind at once. An empty add_header value adds no
  # header (NGINX skips it), which is why mode "none" produces a plain 200.
  cat <<'MAPS'
map $http_x_echo_mode $echo_cl          { auth $http_authorization; query $arg_apikey; x $http_x_echo; default ""; }
map $http_x_echo_mode $echo_server      { key $http_x_api_key; default ""; }
map $http_x_echo_mode $echo_xa_redirect { xa-redirect "/nowhere/$http_x_echo"; default ""; }
map $http_x_echo_mode $echo_xa_charset  { xa-charset $http_x_echo; default ""; }
MAPS
  # key, echo and the two sent_http fields are H13's per-request witnesses: they
  # record what this upstream received and which response headers it sent.
  echo "log_format tlstest 'TLSTEST port=\$server_port uri=\$request_uri token=\$http_x_test_token sni=\$ssl_server_name auth=\"\$http_authorization\" key=\"\$http_x_api_key\" echo=\"\$http_x_echo\" xa=\"\$sent_http_x_accel_redirect\" xc=\"\$sent_http_x_accel_charset\"';"
  for cert in valid chain2 untrusted expired wrongsan; do
    cat <<EOF
server {
    listen $(port_of "$cert") ssl;
    server_name upstream.test;
    ssl_certificate /fixtures/$cert.chain.pem;
    ssl_certificate_key /fixtures/$cert.key;
    access_log /var/log/nginx/access.log tlstest;
    # A second Content-Length makes the proxy log "upstream sent duplicate
    # header line" with the raw header value, ahead of the real upstream field.
    location = /shadow {
        add_header Content-Length 'upstream: "a", host: "b' always;
        return 200 'ok';
    }
    # H13: echo a credential the proxy forwarded (mode auth, query, x) or a
    # header the generated template must ignore (mode xa-redirect, xa-charset)
    # in a response header, which is where NGINX quotes upstream bytes in the
    # error log.
    location = /echo {
        default_type text/plain;
        add_header Content-Length \$echo_cl always;
        add_header Server \$echo_server always;
        add_header X-Accel-Redirect \$echo_xa_redirect always;
        add_header X-Accel-Charset \$echo_xa_charset always;
        return 200 'ok';
    }
    location / {
        default_type text/plain;
        return 200 "echo token=\$http_x_test_token\n";
    }
}
EOF
  done
} >"$WORK/upstream.conf"
chmod 644 "$WORK/upstream.conf"

docker network create "$NETWORK" >/dev/null
docker run -d --name "$UPSTREAM" --network "$NETWORK" --network-alias upstream.test \
  -v "$PKI:/fixtures:ro" -v "$WORK/upstream.conf:/etc/nginx/conf.d/default.conf:ro" \
  -p 127.0.0.1::8441 -p 127.0.0.1::8442 -p 127.0.0.1::8443 -p 127.0.0.1::8444 -p 127.0.0.1::8445 \
  "$UPSTREAM_IMAGE" >/dev/null

host_port() {
  docker port "$1" "$2/tcp" | head -n1 | sed 's/.*://'
}

# Direct handshake to an upstream port from the host. -k because the point is
# that the server is up and speaking TLS, not that the host trusts CA A.
upstream_handshake() {
  local port="$1" token="$2" hp
  hp="$(host_port "$UPSTREAM" "$port")"
  curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
    --resolve "upstream.test:$hp:127.0.0.1" -H "X-Test-Token: $token" \
    "https://upstream.test:$hp/liveness"
}

READY_SECONDS=30
LOG_SECONDS=15

# Polls until the command prints 200, for at most READY_SECONDS of wall-clock
# time (each attempt has its own curl --max-time, so attempts are not counted).
wait_for() {
  local what="$1" container="$2"
  shift 2
  local deadline=$((SECONDS + READY_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$("$@" 2>/dev/null || true)" = "200" ]; then
      return 0
    fi
    sleep 0.5
  done
  echo "FAIL: $what did not become ready within ${READY_SECONDS}s" >&2
  docker logs "$container" >&2 2>&1 || true
  exit 1
}

# Bounded wait for a predicate. Fails (returns 1) on expiry; never used as a
# fixed sleep.
wait_until() {
  local what="$1" seconds="$2"
  shift 2
  local deadline=$((SECONDS + seconds))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if "$@"; then
      return 0
    fi
    sleep 0.5
  done
  echo "WAIT EXPIRED after ${seconds}s: $what" >&2
  return 1
}

# Container log (nginx writes its error log to stderr). Returns 2 when the log
# cannot be read, so an unreadable log never reads as "line absent". Callers
# run it in a command substitution and must check that status.
container_log() {
  local out
  if ! out="$(docker logs "$1" 2>&1)"; then
    echo "FAIL: could not read the log of $1: $out" >&2
    return 2
  fi
  printf '%s\n' "$out"
}

# stdout only: the access log. nginx writes it through the wrapper's untouched
# stdout, so it is the witness that the filter never sees access lines.
# Same contract as container_log: returns 2 when the log cannot be read.
container_stdout() {
  local out
  if ! out="$(docker logs "$1" 2>/dev/null)"; then
    echo "FAIL: could not read the stdout log of $1" >&2
    return 2
  fi
  printf '%s\n' "$out"
}

# stderr only: the filtered error log. Returns 2 when the log cannot be read.
container_stderr() {
  local out
  # shellcheck disable=SC2069 # the order is the point: stderr to the pipe, stdout dropped
  if ! out="$(docker logs "$1" 2>&1 >/dev/null)"; then
    echo "FAIL: could not read the stderr log of $1" >&2
    return 2
  fi
  printf '%s\n' "$out"
}

# Waits up to LOG_SECONDS for a fixed string in a container log. nginx writes a
# log line after it answers, so a single read right after the response races it.
# Returns 1 on timeout and 2 on a log read error.
wait_log() {
  local container="$1" text="$2" log
  local deadline=$((SECONDS + LOG_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    log="$(container_log "$container")" || return 2
    if printf '%s\n' "$log" | grep -qF -- "$text"; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

# Same, on stdout only.
wait_stdout_log() {
  local container="$1" text="$2" log
  local deadline=$((SECONDS + LOG_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    log="$(container_stdout "$container")" || return 2
    if printf '%s\n' "$log" | grep -qF -- "$text"; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

for cert in valid chain2 untrusted expired wrongsan; do
  wait_for "upstream port $(port_of "$cert")" "$UPSTREAM" upstream_handshake "$(port_of "$cert")" "ready-$cert"
done

# ─── Rendered proxy template ─────────────────────────────────────────────────

AUTH_SECRET="secret-$RUN_ID"
(
  cd "$HCC_DIR"
  # shellcheck disable=SC2016 # TypeScript source; ${...} is a JS template literal.
  TEMPLATE_DIR="$WORK/templates" SECURITY_ARGS="$WORK/proxy-security-args" \
    LIVENESS_FILE="$WORK/proxy-liveness-command" \
    MEMORY_LIMIT_FILE="$WORK/proxy-memory-limit" \
    node node_modules/ts-node/dist/bin.js --transpile-only -e '
import * as fs from "fs"
import * as path from "path"
import * as k8s from "@kubernetes/client-node"
import { McpServerReconciler } from "./src/reconciler"

const reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
  assumeInventoryAuthorityWhenUnconfigured: true,
  appsApi: {} as never,
  coreApi: {} as never,
  customApi: {} as never,
})
const server = (baseUrl: string): any => ({
  name: "tls-test",
  namespace: "mcp-server",
  spec: {
    image: "clerum/nginx-egress-proxy:0.1.0",
    transport: { type: "streamableHttp", port: 3000 },
    env: [{ name: "UPSTREAM_QUERY_KEY", value: "render-only" }],
    managed: true,
    enabled: true,
    remote: {
      baseUrl,
      authHeaders: [{ header: "Authorization", valueTemplate: "Bearer ${UPSTREAM_TOKEN}" }],
    },
  },
})
const templateDir = process.env.TEMPLATE_DIR as string
const renderServer = (dir: string, crd: any) => {
  const cm = (reconciler as any).buildNginxConfigMap(crd)
  const out = path.join(templateDir, dir)
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, "default.conf.template"), cm.data["default.conf.template"])
}
const render = (dir: string, baseUrl: string) => renderServer(dir, server(baseUrl))
// H13: the real oauth shape. One proxy carries the per-user Bearer passthrough
// (auth.type oauth), a static authHeaders placeholder and a query placeholder,
// so one echoed response header per credential kind reaches the error log.
const oauthServer = (baseUrl: string) => {
  const crd = server(baseUrl)
  crd.spec.auth = { type: "oauth" }
  crd.spec.remote.authHeaders = [{ header: "X-Api-Key", valueTemplate: "${UPSTREAM_TOKEN}" }]
  return crd
}
for (const port of [8441, 8442, 8443, 8444, 8445]) {
  render(String(port), "https://upstream.test:" + port + "/mcp")
}
render("query-accept", "https://upstream.test:8441/mcp?apikey=${UPSTREAM_QUERY_KEY}")
render("redact", "https://upstream.test:8443/mcp?apikey=${UPSTREAM_QUERY_KEY}")
render("redact-shadow", "https://upstream.test:8441/shadow?apikey=${UPSTREAM_QUERY_KEY}")
renderServer("echo", oauthServer("https://upstream.test:8441/echo?apikey=${UPSTREAM_QUERY_KEY}"))

const deployment = (reconciler as any).buildDeployment(server("https://upstream.test:8441/mcp"))
const proxies = deployment.spec.template.spec.containers.filter((c: any) => c.name === "egress-proxy")
if (proxies.length !== 1) throw new Error(`expected one egress-proxy container, found ${proxies.length}`)
const proxy = proxies[0]

// A1-H1 option (b): the image keeps NGINX as PID 1 and the Deployment turns a
// dead log filter into a restart with an exec probe. The harness runs the exact
// command the reconciler emits, so the probe path and the image cannot drift.
const probe = proxy.livenessProbe ?? {}
if (!probe.exec || !Array.isArray(probe.exec.command)) {
  throw new Error(`the egress-proxy livenessProbe is not an exec probe: ${JSON.stringify(probe)}`)
}
const livenessCommand: string[] = probe.exec.command
if (livenessCommand[0] !== "/usr/local/bin/egress-proxy-liveness") {
  throw new Error(`the liveness probe does not exec /usr/local/bin/egress-proxy-liveness: ${JSON.stringify(livenessCommand)}`)
}
if (livenessCommand.length !== 2) {
  throw new Error(`the liveness probe must pass only the transport port: ${JSON.stringify(livenessCommand)}`)
}
fs.writeFileSync(process.env.LIVENESS_FILE as string, livenessCommand.join("\n") + "\n")

const memoryLimit = proxy.resources?.limits?.memory
if (!memoryLimit) throw new Error("the egress-proxy container has no memory limit")
fs.writeFileSync(process.env.MEMORY_LIMIT_FILE as string, String(memoryLimit) + "\n")

// The proxy runs with the securityContext HCC generates for the egress-proxy
// container. Each field maps to one docker flag; a field this test does not
// map, or a value other than the mapped one, stops the test so the mapping is
// updated together with the reconciler.
const sc = proxy.securityContext ?? {}
const mapped = ["runAsNonRoot", "runAsUser", "runAsGroup", "capabilities", "allowPrivilegeEscalation", "seccompProfile"]
const unmapped = Object.keys(sc).filter((k) => !mapped.includes(k))
if (unmapped.length > 0) throw new Error(`egress-proxy securityContext fields not mapped to docker: ${unmapped.join(", ")}`)
const expect = (field: string, ok: boolean) => {
  if (!ok) throw new Error(`egress-proxy securityContext.${field} = ${JSON.stringify(sc[field])} is not mapped to docker`)
}
expect("runAsNonRoot", sc.runAsNonRoot === true)
expect("runAsUser", Number.isInteger(sc.runAsUser) && sc.runAsUser > 0)
expect("runAsGroup", Number.isInteger(sc.runAsGroup))
expect("capabilities", JSON.stringify(sc.capabilities) === JSON.stringify({ drop: ["ALL"] }))
expect("allowPrivilegeEscalation", sc.allowPrivilegeEscalation === false)
// RuntimeDefault is the engine default profile; start_proxy checks that the
// running process is under a seccomp filter.
expect("seccompProfile", JSON.stringify(sc.seccompProfile) === JSON.stringify({ type: "RuntimeDefault" }))
const args = ["--user", `${sc.runAsUser}:${sc.runAsGroup}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges"]
fs.writeFileSync(process.env.SECURITY_ARGS as string, args.join("\n") + "\n")
'
)
PROXY_SECURITY_ARGS=()
while IFS= read -r arg; do
  PROXY_SECURITY_ARGS+=("$arg")
done <"$WORK/proxy-security-args"
PROXY_UID_GID="${PROXY_SECURITY_ARGS[1]}"
if [ "${#PROXY_SECURITY_ARGS[@]}" -ne 6 ] || ! [[ "$PROXY_UID_GID" =~ ^[0-9]+:[0-9]+$ ]]; then
  echo "FAIL: unexpected proxy security arguments: ${PROXY_SECURITY_ARGS[*]}" >&2
  exit 1
fi

if [ "$(wc -l <"$WORK/proxy-liveness-command" | tr -d ' ')" != "2" ]; then
  echo "FAIL: unexpected liveness command file: $(cat "$WORK/proxy-liveness-command")" >&2
  exit 1
fi
LIVENESS_BIN="$(sed -n '1p' "$WORK/proxy-liveness-command")"
LIVENESS_PORT="$(sed -n '2p' "$WORK/proxy-liveness-command")"
[ "$LIVENESS_BIN" = "/usr/local/bin/egress-proxy-liveness" ] || {
  echo "FAIL: liveness command is $LIVENESS_BIN, expected /usr/local/bin/egress-proxy-liveness" >&2
  exit 1
}

memory_kib() {
  local value="$1"
  case "$value" in
    *Ki) echo $((${value%Ki})) ;;
    *Mi) echo $((${value%Mi} * 1024)) ;;
    *Gi) echo $((${value%Gi} * 1024 * 1024)) ;;
    *) echo "" ;;
  esac
}
PROXY_MEMORY_KIB="$(memory_kib "$(cat "$WORK/proxy-memory-limit")")"
if [ -z "$PROXY_MEMORY_KIB" ]; then
  echo "FAIL: unsupported egress-proxy memory limit '$(cat "$WORK/proxy-memory-limit")'" >&2
  exit 1
fi
echo "proxy liveness: $LIVENESS_BIN $LIVENESS_PORT"
echo "proxy memory limit: ${PROXY_MEMORY_KIB}KiB"

assert_count() {
  local file="$1" text="$2" want="$3" count
  count="$(grep -cF -- "$text" "$file" || true)"
  if [ "$count" != "$want" ]; then
    echo "FAIL: $file has $count line(s) with '$text', expected $want" >&2
    echo "----- $file -----" >&2
    cat "$file" >&2
    exit 1
  fi
}

# ─── H0: the rendered template must carry the new contract ───────────────────

for port in 8441 8442 8443 8444 8445; do
  t="$WORK/templates/$port/default.conf.template"
  # shellcheck disable=SC2016  # literal envsubst placeholder expected in the template.
  assert_count "$t" "proxy_pass https://upstream.test:$port/mcp;" 1
done
# H13's template must carry all three credential kinds the oauth shape emits: the
# passthrough Bearer, the static header placeholder and the query placeholder.
# If the template stopped being oauth, echo could pass for the wrong reason.
t="$WORK/templates/echo/default.conf.template"
# shellcheck disable=SC2016  # literal directive expected in the template.
assert_count "$t" 'proxy_set_header Authorization $http_authorization;' 1
# shellcheck disable=SC2016  # literal envsubst placeholder expected in the template.
assert_count "$t" 'proxy_set_header X-Api-Key "${UPSTREAM_TOKEN}";' 1
# shellcheck disable=SC2016  # literal envsubst placeholder expected in the template.
assert_count "$t" 'proxy_pass https://upstream.test:8441/echo?apikey=${UPSTREAM_QUERY_KEY};' 1
assert_count "$t" 'proxy_ignore_headers X-Accel-Redirect X-Accel-Charset;' 1

case "$MUTATION" in
  verify-off)
    for port in 8441 8442 8443 8444 8445; do
      mutate "$WORK/templates/$port/default.conf.template" "proxy_ssl_verify on;" "proxy_ssl_verify off;"
    done
    ;;
  depth-1)
    for port in 8441 8442 8443 8444 8445; do
      mutate "$WORK/templates/$port/default.conf.template" "proxy_ssl_verify_depth 3;" "proxy_ssl_verify_depth 1;"
    done
    ;;
  no-ignore-accel)
    # The template stops ignoring the two headers NGINX logs in messages the
    # filter does not cover, so E6a and E6b really reach those messages.
    mutate "$WORK/templates/echo/default.conf.template" \
      "proxy_ignore_headers X-Accel-Redirect X-Accel-Charset;" \
      "# proxy_ignore_headers removed by NGINX_TLS_TEST_MUTATION=no-ignore-accel"
    ;;
esac

# `no-redact` removes the filter from the containers that prove it: they start
# through the official entrypoint, exactly like a proxy image without the
# wrapper. The mutation is a run-time entrypoint switch, never an image knob.
REDACT_FILTER=on
[ "$MUTATION" = "no-redact" ] && REDACT_FILTER=off

# `audit-version` is a run-time switch too: the harness constant is not a file
# under $WORK. It is the release gate's own liveness proof, because a comparison
# that never read the image would stay green.
[ "$MUTATION" = "audit-version" ] && AUDITED_NGINX_VERSION=nginx/0.0.0
for dir in "$WORK"/templates/*; do
  chmod 755 "$dir"
  chmod 644 "$dir/default.conf.template"
done
[ -n "$MUTATION" ] && echo "mutation: $MUTATION"

# ─── Proxy lifecycle ─────────────────────────────────────────────────────────

# start_proxy <case> <template-dir> <mount-ca yes|no> <filter on|off> [extra docker flags...]
#
# filter=off starts the official entrypoint directly, which is the `no-redact`
# mutation: no FIFO, no filter, raw nginx stderr.
start_proxy() {
  local case_name="$1" template="$2" mount_ca="$3" filter="$4"
  shift 4
  local container="$NAME-proxy-$case_name"
  local args=(
    -d --name "$container" --network "$NETWORK"
    "${PROXY_SECURITY_ARGS[@]}"
    -e "UPSTREAM_TOKEN=${PROXY_UPSTREAM_TOKEN:-$AUTH_SECRET}"
    -v "$WORK/templates/$template:/etc/nginx/templates:ro"
    -p 127.0.0.1::3000
  )
  if [ "$mount_ca" = "yes" ]; then
    args+=(-v "$WORK/trust-ca-a.pem:/etc/ssl/certs/ca-certificates.crt:ro")
  fi
  args+=("$@")
  if [ "$filter" = "off" ]; then
    docker run "${args[@]}" --entrypoint /docker-entrypoint.sh "$PROXY_IMAGE" nginx -g 'daemon off;' >/dev/null
  else
    docker run "${args[@]}" "$PROXY_IMAGE" >/dev/null
  fi
  wait_for "proxy for $case_name" "$container" proxy_health "$container"
  check_proxy_process "$case_name" "$container"
  record_rss "$case_name" "$container"
}

proxy_health() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$(host_port "$1" 3000)/health"
}

# The NGINX master must run with the generated identity, an empty capability
# bounding set (a non-root process has no effective capabilities even without
# --cap-drop, so CapEff alone would not show the drop), no_new_privs and a
# seccomp filter (mode 2). The master is read from the pidfile the image sets
# (/tmp/nginx.pid), and A1-H1 option (b) additionally requires it to be PID 1:
# a wrapper that stayed PID 1 would pass a /proc/1 check while the identity and
# the signal handling belonged to the wrapper.
check_proxy_process() {
  local case_name="$1" container="$2" pid identity status uid="${PROXY_UID_GID%%:*}" gid="${PROXY_UID_GID##*:}" want t=$'\t' missing=0
  pid="$(docker exec "$container" cat /tmp/nginx.pid 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$pid" ]; then
    echo "FAIL: proxy for $case_name: /tmp/nginx.pid is missing or empty" >&2
    exit 1
  fi
  if [ "$pid" != "1" ]; then
    echo "FAIL: proxy for $case_name: the NGINX master is PID $pid, expected PID 1 (A1-H1 option b)" >&2
    exit 1
  fi
  identity="$(docker exec "$container" sh -c "tr '\\0' ' ' < /proc/$pid/cmdline" 2>/dev/null || true)"
  case "$identity" in
    "nginx: master process"*) ;;
    *)
      echo "FAIL: proxy for $case_name: /proc/$pid/cmdline is '$identity', not the NGINX master" >&2
      exit 1
      ;;
  esac
  status="$(docker exec "$container" cat "/proc/$pid/status" 2>/dev/null || true)"
  for want in "Uid:$t$uid$t$uid$t$uid$t$uid" "Gid:$t$gid$t$gid$t$gid$t$gid" \
    "CapEff:${t}0000000000000000" "CapBnd:${t}0000000000000000" "NoNewPrivs:${t}1" "Seccomp:${t}2"; do
    if ! grep -qxF -- "$want" <<<"$status"; then
      echo "FAIL: proxy for $case_name: /proc/$pid/status has no line '$want'" >&2
      missing=1
    fi
  done
  if [ "$missing" -ne 0 ]; then
    grep -E '^(Uid|Gid|CapEff|CapBnd|NoNewPrivs|Seccomp):' <<<"$status" >&2
    exit 1
  fi
}

# R6: the log filter must fit the container's memory limit. The sum of every
# VmRSS is an upper bound of what the cgroup has to hold (it double counts
# shared pages), so passing here is the safe direction.
record_rss() {
  local case_name="$1" container="$2" rss
  rss="$(docker exec "$container" sh -c "awk '$RSS_AWK' /proc/[0-9]*/status 2>/dev/null" | tr -d '[:space:]')"
  case "$rss" in
    '' | *[!0-9]*)
      fail "$case_name: could not read the container RSS (got '$rss')"
      return
      ;;
  esac
  echo "RSS $case_name ${rss}KiB (limit ${PROXY_MEMORY_KIB}KiB)"
  if [ "$rss" -ge "$PROXY_MEMORY_KIB" ]; then
    fail "$case_name: container RSS ${rss}KiB is at or above the ${PROXY_MEMORY_KIB}KiB limit"
  fi
}

proxy_request() {
  local container="$1" token="$2" path="${3:-/mcp}"
  curl -s -o "$WORK/body" -w '%{http_code}' --max-time 15 -H "X-Test-Token: $token" \
    "http://127.0.0.1:$(host_port "$container" 3000)$path"
}

# proxy_request against the fixture's /echo location, with the mode that selects
# what the upstream echoes back in a response header. Extra arguments are curl
# options, used for the request headers that carry the markers.
echo_request() {
  local container="$1" token="$2" mode="$3"
  shift 3
  curl -s -o "$WORK/body" -w '%{http_code}' --max-time 15 -H "X-Test-Token: $token" \
    -H "X-Echo-Mode: $mode" "$@" "http://127.0.0.1:$(host_port "$container" 3000)/echo"
}

# Number of filtered "upstream sent duplicate header line" lines. Every echo
# line keeps that message text after redaction, including one cut before the
# context fields, so it is the growth witness E5 can use. Returns 2 when the log
# cannot be read, so an unreadable log never reads as zero lines.
quoted_line_count() {
  local log
  if ! log="$(container_stderr "$1")"; then
    return 2
  fi
  printf '%s\n' "$log" | grep -cF 'upstream sent duplicate header line: "' || true
}

# True when the container logged more quoting lines than the given count.
quoted_lines_grew() {
  local count
  count="$(quoted_line_count "$1")" || return 1
  [ "${count:-0}" -gt "${2:-0}" ]
}

# Newest quoting line of the filtered stderr log. Returns 2 when the log cannot
# be read, so a failed read never looks like an empty line.
newest_quoted_line() {
  local log
  if ! log="$(container_stderr "$1")"; then
    return 2
  fi
  printf '%s\n' "$log" | grep -F 'upstream sent duplicate header line: "' | tail -n 1
}

# True when the upstream access-log line of a request carries the X-Echo value
# the proxy forwarded. The value can hold quotes, commas and spaces, so only the
# field name and the marker are anchored.
echo_witness() {
  printf '%s' "$1" | grep -qF 'echo="' && printf '%s' "$1" | grep -qF -- "$2"
}

# Number of occurrences of a fixed string in one line.
count_fixed() {
  printf '%s' "$1" | grep -oF -- "$2" | grep -c . || true
}

# One echo step: sends the request, fails unless the status is the expected one,
# waits for a new quoting error line, and stores that line in the caller's
# echo_line. Returns 1 after fail() on any missing witness, so the caller only
# has to check the line's shape.
echo_step() {
  local case_name="$1" container="$2" label="$3" mode="$4" want="$5" token="$6"
  shift 6
  local before code
  if ! before="$(quoted_line_count "$container")"; then
    fail "$case_name: could not read the stderr log before $label"
    return 1
  fi
  code="$(echo_request "$container" "$token" "$mode" "$@")"
  if [ "$code" != "$want" ]; then
    fail "$case_name: $label expected $want, got $code $(cat "$WORK/body")"
    return 1
  fi
  if ! wait_until "$label's quoting error line" "$LOG_SECONDS" quoted_lines_grew "$container" "$before"; then
    fail "$case_name: $label produced no new quoting error line within ${LOG_SECONDS}s: $(container_log "$container" | tail -n 3)"
    return 1
  fi
  if ! echo_line="$(newest_quoted_line "$container")"; then
    fail "$case_name: could not read the stderr log after $label"
    return 1
  fi
  if [ -z "$echo_line" ]; then
    fail "$case_name: $label produced no quoting line"
    return 1
  fi
  return 0
}

# Prints the upstream log lines for a token (empty when none). Returns 2 when
# the upstream log cannot be read.
upstream_log_line() {
  local container="$1" token="$2" log
  log="$(container_log "$container")" || return 2
  printf '%s\n' "$log" | grep -F "token=$token " || true
}

expect_accept() {
  local case_name="$1" port container token code line
  port="$(port_of "$case_name")"
  container="$NAME-proxy-$case_name"
  token="tok-$case_name-$RUN_ID"
  cases=$((cases + 1))
  start_proxy "$case_name" "$port" yes on
  code="$(proxy_request "$container" "$token")"
  if [ "$code" != "200" ]; then
    fail "$case_name: expected 200, got $code; proxy log: $(container_log "$container" | tail -n 5)"
  elif ! grep -qF "echo token=$token" "$WORK/body"; then
    fail "$case_name: response body does not carry the token: $(cat "$WORK/body")"
  elif ! wait_log "$UPSTREAM" "token=$token "; then
    fail "$case_name: upstream did not log token $token within ${LOG_SECONDS}s"
  elif ! line="$(upstream_log_line "$UPSTREAM" "$token")"; then
    fail "$case_name: could not read the upstream log"
  elif ! printf '%s' "$line" | grep -qF "port=$port uri=/mcp token=$token sni=upstream.test auth=\"Bearer $AUTH_SECRET\""; then
    fail "$case_name: upstream saw the wrong port, path, SNI or Authorization: $line"
  else
    echo "PASS: $case_name -> 200, token, path, SNI and envsubst Authorization reached port $port"
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
}

expect_reject() {
  local case_name="$1" mount_ca="$2" reason="$3" port container token code live after seen
  port="$(port_of "$case_name")"
  container="$NAME-proxy-$case_name"
  token="tok-$case_name-$RUN_ID"
  cases=$((cases + 1))
  live="$(upstream_handshake "$port" "live-$case_name-$RUN_ID")"
  if [ "$live" != "200" ]; then
    fail "$case_name: direct handshake to upstream port $port returned $live"
    return
  fi
  start_proxy "$case_name" "$port" "$mount_ca" on
  code="$(proxy_request "$container" "$token")"
  after="after-$case_name-$RUN_ID"
  if [ "$code" != "502" ]; then
    fail "$case_name: expected 502, got $code"
  elif ! wait_log "$container" "$reason"; then
    fail "$case_name: proxy log has no '$reason' within ${LOG_SECONDS}s: $(container_log "$container" | tail -n 5)"
  # The upstream logs requests in order. Once a direct request sent after the
  # proxy attempt is in its log, a forwarded token would be there too.
  elif [ "$(upstream_handshake "$port" "$after")" != "200" ] || ! wait_log "$UPSTREAM" "token=$after "; then
    fail "$case_name: the upstream did not log the direct request $after sent after the proxy attempt"
  elif ! seen="$(upstream_log_line "$UPSTREAM" "$token")"; then
    fail "$case_name: could not read the upstream log"
  elif [ -n "$seen" ]; then
    fail "$case_name: request token reached the upstream: $seen"
  else
    echo "PASS: $case_name -> 502 ($reason), upstream live and logging, token not forwarded"
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
}

# ─── H8: a query placeholder resolved only inside the container ──────────────

expect_query_accept() {
  local case_name="query-accept" container="$NAME-proxy-query-accept" template="$WORK/templates/query-accept/default.conf.template"
  local token="tok-$case_name-$RUN_ID" code line
  cases=$((cases + 1))

  # shellcheck disable=SC2016  # literal envsubst placeholder expected in the template.
  if [ "$(grep -cF 'proxy_pass https://upstream.test:8441/mcp?apikey=${UPSTREAM_QUERY_KEY};' "$template" || true)" != "1" ]; then
    fail "$case_name: the rendered template does not carry the query placeholder exactly once"
    return
  fi
  start_proxy "$case_name" query-accept yes on -e "UPSTREAM_QUERY_KEY=$QUERY_MARKER"
  code="$(proxy_request "$container" "$token")"
  if [ "$code" != "200" ]; then
    fail "$case_name: expected 200, got $code; proxy log: $(container_log "$container" | tail -n 5)"
  elif ! grep -qF "echo token=$token" "$WORK/body"; then
    fail "$case_name: response body does not carry the token: $(cat "$WORK/body")"
  elif ! wait_log "$UPSTREAM" "token=$token "; then
    fail "$case_name: upstream did not log token $token within ${LOG_SECONDS}s"
  elif ! line="$(upstream_log_line "$UPSTREAM" "$token")"; then
    fail "$case_name: could not read the upstream log"
  elif ! printf '%s' "$line" | grep -qF "uri=/mcp?apikey=$QUERY_MARKER token=$token sni=upstream.test auth=\"Bearer $AUTH_SECRET\""; then
    fail "$case_name: the upstream did not receive the envsubst-resolved query: $line"
  else
    echo "PASS: $case_name -> 200, upstream received uri=/mcp?apikey=<resolved> and the Authorization header"
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
}

# ─── H9: the error log never carries the remote query ────────────────────────

# Byte offset of the first "?" inside the `upstream: "..."` field of a complete
# filtered nginx error line. The filter keeps everything before it, so the
# offset is the same in the filtered and in the raw line.
upstream_field_query_offset() {
  local line="$1" head rest before
  case "$line" in
    *'upstream: "'*) ;;
    *) echo ""; return ;;
  esac
  head="${line%%upstream: \"*}"
  rest="${line#*upstream: \"}"
  before="${rest%%\?*}"
  echo $(( ${#head} + 11 + ${#before} + 1 ))
}

# True when the container logged more `upstream: "` lines than the given count.
upstream_lines_grew() {
  local count
  count="$(container_stderr "$1" | grep -cF 'upstream: "' || true)"
  [ "${count:-0}" -gt "${2:-0}" ]
}

expect_redact() {
  local case_name="redact" container="$NAME-proxy-redact" raw="$NAME-proxy-redact-raw"
  local shadow="$NAME-proxy-redact-shadow"
  local token="tok-$case_name-$RUN_ID" after code line lines good offset n q failures_before seen log
  local marker_prefix="${QUERY_MARKER:0:8}"
  cases=$((cases + 1))
  failures_before=$failures

  # req1: a TLS failure on the untrusted port, IP form of the field.
  start_proxy "$case_name" redact yes "$REDACT_FILTER" -e "UPSTREAM_QUERY_KEY=$QUERY_MARKER"
  code="$(proxy_request "$container" "$token")"
  after="after-$case_name-$RUN_ID"
  if [ "$code" != "502" ]; then
    fail "$case_name: req1 expected 502, got $code"
  elif ! wait_log "$container" "(21:unable to verify the first certificate)"; then
    fail "$case_name: req1 produced no '(21:unable to verify the first certificate)' within ${LOG_SECONDS}s: $(container_log "$container" | tail -n 5)"
  elif [ "$(upstream_handshake 8443 "$after")" != "200" ] || ! wait_log "$UPSTREAM" "token=$after "; then
    fail "$case_name: the upstream did not log the direct request sent after req1"
  elif ! seen="$(upstream_log_line "$UPSTREAM" "$token")"; then
    fail "$case_name: could not read the upstream log"
  elif [ -n "$seen" ]; then
    fail "$case_name: req1's token reached the upstream"
  else
    echo "PASS: $case_name req1 -> 502, TLS verification failed, token not forwarded"
  fi

  lines="$(container_stderr "$container" | grep -cF 'upstream: "' || true)"
  good="$(container_stderr "$container" | grep -cE 'upstream: "https://[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:8443/mcp\?REDACTED"' || true)"
  if [ "${lines:-0}" -lt 1 ]; then
    fail "$case_name: req1 logged no upstream line"
  elif [ "$lines" != "$good" ]; then
    fail "$case_name: $lines upstream line(s) but only $good are 'https://<ipv4>:8443/mcp?REDACTED': $(container_stderr "$container" | grep -F 'upstream: "' | tail -n 3)"
  else
    echo "PASS: $case_name req1 -> every upstream line keeps peer:port and path and redacts the query"
  fi

  # req3: a client query long enough that nginx truncates the 2047-byte error
  # line inside the credential, where there is no closing quote to anchor on.
  line="$(container_stderr "$container" | grep -F 'upstream: "' | tail -n 1)"
  offset="$(upstream_field_query_offset "$line")"
  if [ -z "$offset" ]; then
    fail "$case_name: could not locate the upstream field in the previous line: $line"
  else
    # 2000 keeps the cut well inside the marker (the marker starts at
    # offset + 8 and the cap lands ~40 bytes later), whatever the pid and
    # connection-number widths do to the prefix.
    n=$((2000 - offset))
    if [ "$n" -lt 200 ]; then
      fail "$case_name: computed a negative truncation query length ($n) from offset $offset"
    else
      q="$(head -c "$n" /dev/zero | tr '\0' 'a')"
      lines="$(container_stderr "$container" | grep -cF 'upstream: "' || true)"
      code="$(proxy_request "$container" "tok-$case_name-trunc-$RUN_ID" "/mcp?$q")"
      if ! wait_until "req3's truncated error line" "$LOG_SECONDS" upstream_lines_grew "$container" "$lines"; then
        fail "$case_name: req3 logged no new upstream line within ${LOG_SECONDS}s"
      else
        line="$(container_stderr "$container" | grep -F 'upstream: "' | tail -n 1)"
        if [ "$code" != "502" ]; then
          fail "$case_name: req3 expected 502, got $code"
        elif ! printf '%s' "$line" | grep -qE 'upstream: "https://[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:8443/mcp\?REDACTED$'; then
          fail "$case_name: req3's truncated line is not redacted to the end of the line: ${line:0:200}..."
        elif printf '%s' "$line" | grep -qF 'host: "'; then
          fail "$case_name: req3's line still carries the host field; it was not truncated: ${line:0:200}..."
        elif printf '%s' "$line" | grep -qF -- "$marker_prefix"; then
          fail "$case_name: req3's truncated line leaked the marker prefix: ${line:0:200}..."
        else
          echo "PASS: $case_name req3 -> truncated line redacted to ?REDACTED at end of line, no marker prefix"
        fi
      fi
    fi
  fi

  # The same request against a control container without the filter proves the
  # line really is cut at NGINX's 2047-byte error cap, so req3 cannot pass on a
  # complete line.
  start_proxy redact-raw redact yes off -e "UPSTREAM_QUERY_KEY=$QUERY_MARKER"
  code="$(proxy_request "$raw" "tok-$case_name-raw-warm-$RUN_ID")"
  # nginx writes the error line after it answers; wait for it before reading.
  line=""
  if wait_log "$raw" 'upstream: "'; then
    line="$(container_stderr "$raw" | grep -F 'upstream: "' | tail -n 1)"
  fi
  offset="$(upstream_field_query_offset "$line")"
  if [ "$code" != "502" ] || [ -z "$offset" ]; then
    fail "$case_name: the raw control container did not log a complete upstream line"
  else
    n=$((2000 - offset))
    q="$(head -c "$n" /dev/zero | tr '\0' 'a')"
    lines="$(container_stderr "$raw" | grep -cF 'upstream: "' || true)"
    code="$(proxy_request "$raw" "tok-$case_name-raw-$RUN_ID" "/mcp?$q")"
    if ! wait_until "the raw control truncated error line" "$LOG_SECONDS" upstream_lines_grew "$raw" "$lines"; then
      fail "$case_name: the raw control request logged no new upstream line within ${LOG_SECONDS}s"
    else
      line="$(container_stderr "$raw" | grep -F 'upstream: "' | tail -n 1)"
      if [ "$code" != "502" ]; then
        fail "$case_name: the raw control request expected 502, got $code"
      elif [ "$(printf '%s' "$line" | wc -c | tr -d ' ')" != "2047" ]; then
        fail "$case_name: the raw control line is $(printf '%s' "$line" | wc -c | tr -d ' ') bytes, expected the 2047-byte NGINX error cap"
      elif ! printf '%s' "$line" | grep -qE "upstream: \"https://[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:8443/mcp\?apikey=$marker_prefix"; then
        fail "$case_name: the raw control line was not cut inside the marker: ${line:0:200}..."
      elif printf '%s' "$line" | grep -qF -- "$QUERY_MARKER"; then
        fail "$case_name: the raw control line holds the whole marker, so the cut is not inside it: ${line:0:200}..."
      elif printf '%s' "$line" | grep -qF 'host: "'; then
        fail "$case_name: the raw control line still carries the host field; it was not truncated: ${line:0:200}..."
      else
        echo "PASS: $case_name truncation witness -> the raw line is exactly 2047 bytes and ends inside the marker"
      fi
    fi
  fi

  # req4: the client sends a raw quote after the configured query. The upstream
  # answers with a second Content-Length whose value is `upstream: "a", host: "b`.
  # NGINX quotes that raw value ahead of the real field. The message rule removes
  # the echo, and the field rule must not stop at the client quote inside the real
  # upstream URL. The configured value must be gone from every stream; the tail
  # travels in the client request line, so the field assertion below is what
  # proves the redaction crossed the quote.
  local shadow_head shadow_tail
  shadow_head="sq1-$RUN_ID-$(openssl rand -hex 16)"
  shadow_tail="sq2-$(openssl rand -hex 16)"
  start_proxy redact-shadow redact-shadow yes "$REDACT_FILTER" -e "UPSTREAM_QUERY_KEY=$shadow_head"
  code="$(proxy_request "$shadow" "tok-$case_name-shadow-$RUN_ID" "/shadow\"$shadow_tail")"
  if [ "$code" != "502" ]; then
    fail "$case_name: req4 expected 502, got $code"
  elif ! wait_log "$shadow" 'upstream sent duplicate header line: "REDACTED, client: '; then
    fail "$case_name: req4 produced no redacted duplicate-header line within ${LOG_SECONDS}s: $(container_log "$shadow" | tail -n 3)"
  elif ! log="$(container_log "$shadow")"; then
    fail "$case_name: could not read the req4 log"
  elif printf '%s\n' "$log" | grep -qF 'upstream: "a", host: "b'; then
    fail "$case_name: req4 kept the upstream-quoted fake field"
  elif printf '%s\n' "$log" | grep -qF -- "$shadow_head"; then
    fail "$case_name: req4 leaked the configured query value"
  elif ! printf '%s\n' "$log" | grep -F 'duplicate header line' |
    grep -qE 'upstream: "https://[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:8441/shadow\?REDACTED", host: "'; then
    fail "$case_name: req4's real field is not 'https://<ipv4>:8441/shadow?REDACTED': $(printf '%s\n' "$log" | grep -F 'duplicate header line' | tail -n 1)"
  else
    echo "PASS: $case_name req4 -> the quoted echo is REDACTED and a quote in the real value does not end its field"
  fi

  # Global negatives, after the positives, on every filtered container. Each
  # log is read once and its read status checked, so an unreadable log can
  # never count as "marker absent".
  local scanned=0 redacted_total=0
  for c in "$container" "$shadow"; do
    if ! log="$(container_log "$c")"; then
      fail "$case_name: could not read the log of $c for the marker scan"
      continue
    fi
    scanned=$((scanned + $(printf '%s\n' "$log" | grep -cF -e "$QUERY_MARKER" -e "$marker_prefix" || true)))
  done
  if [ "$scanned" -ne 0 ]; then
    fail "$case_name: the marker (or its first 8 characters) appears on $scanned line(s) of the filtered logs"
  fi
  if ! log="$(container_stderr "$container")"; then
    fail "$case_name: could not read the stderr log of $container"
  else
    redacted_total=$((redacted_total + $(printf '%s\n' "$log" | grep -cF '?REDACTED' || true)))
  fi
  if [ "$redacted_total" -lt 2 ]; then
    fail "$case_name: only ${redacted_total} '?REDACTED' occurrence(s) across req1/req3"
  fi

  # stdout keeps the access log, unfiltered: it records the client request
  # line, to which the proxy never adds the remote query. One read serves the
  # positive and the negative check.
  if ! log="$(container_stdout "$container")"; then
    fail "$case_name: could not read the stdout log of $container"
  elif ! printf '%s\n' "$log" | grep -qF '"GET /mcp HTTP/1.1" 502'; then
    fail "$case_name: the access log on stdout has no 502 line for req1"
  elif printf '%s\n' "$log" | grep -qF '?REDACTED'; then
    fail "$case_name: stdout carries a filtered line; the wrapper routed stdout through the filter"
  fi

  if [ "$failures" -eq "$failures_before" ]; then
    echo "PASS: $case_name -> marker absent from every filtered stream, ${redacted_total} ?REDACTED lines, stdout untouched"
  fi
  docker rm -f "$container" "$raw" "$shadow" >/dev/null 2>&1 || true
}

# ─── H13: credentials the proxy forwards and an upstream echoes ──────────────
#
# One oauth proxy (Bearer passthrough, a static authHeaders value and a query
# value, rendered from the real reconciler) against an upstream that echoes a
# request value into a response header. NGINX quotes those bytes in four
# upstream messages, so this is the case the message rule exists for. Each
# negative has a positive in the same step: the upstream access log records the
# value it received and the header it sent.
expect_echo() {
  local case_name="echo" container="$NAME-proxy-echo"
  local token code line log before after failures_before scanned=0 m
  local echo_line="" cut_pad cut_echo hostile
  # Every uncut E line keeps the level, the client, the request and the real
  # upstream field; only the upstream-quoted span and the query are REDACTED.
  local shape='upstream sent duplicate header line: "REDACTED, client: [0-9.]+, server: , request: "GET /echo HTTP/1.1", upstream: "https://[0-9.]+:8441/echo\?REDACTED", host: "'
  cases=$((cases + 1))
  failures_before=$failures

  # PROXY_UPSTREAM_TOKEN is set explicitly, so the static authHeaders witness
  # can never pass on the shared AUTH_SECRET fallback.
  PROXY_UPSTREAM_TOKEN="$ECHO_KEY" start_proxy "$case_name" echo yes "$REDACT_FILTER" \
    -e "UPSTREAM_QUERY_KEY=$ECHO_MARKER"

  # E6a/E6b run first: while the template ignores the two X-Accel headers they
  # produce no error line, and running them first leaves the quoting-line count
  # clean for E1-E5. The witness is the upstream's own access log, which records
  # the headers it sent, not only the ones it received.
  token="tok-$case_name-xa-redirect-$RUN_ID"
  code="$(echo_request "$container" "$token" xa-redirect -H "X-Echo: $XA_REDIRECT_MARKER")"
  if [ "$code" != "200" ] || ! grep -qF 'ok' "$WORK/body"; then
    fail "$case_name: E6a expected 200 with body ok, got $code $(cat "$WORK/body")"
  elif ! wait_log "$UPSTREAM" "token=$token "; then
    fail "$case_name: the upstream did not log E6a within ${LOG_SECONDS}s"
  elif ! line="$(upstream_log_line "$UPSTREAM" "$token")"; then
    fail "$case_name: could not read the upstream log for E6a"
  elif ! printf '%s' "$line" | grep -qF "xa=\"/nowhere/$XA_REDIRECT_MARKER\""; then
    fail "$case_name: E6a's upstream did not send X-Accel-Redirect: $line"
  else
    echo "PASS: $case_name E6a -> 200, the upstream sent X-Accel-Redirect and the proxy ignored it"
  fi

  token="tok-$case_name-xa-charset-$RUN_ID"
  code="$(echo_request "$container" "$token" xa-charset -H "X-Echo: $XA_CHARSET_MARKER")"
  if [ "$code" != "200" ] || ! grep -qF 'ok' "$WORK/body"; then
    fail "$case_name: E6b expected 200 with body ok, got $code $(cat "$WORK/body")"
  elif ! wait_log "$UPSTREAM" "token=$token "; then
    fail "$case_name: the upstream did not log E6b within ${LOG_SECONDS}s"
  elif ! line="$(upstream_log_line "$UPSTREAM" "$token")"; then
    fail "$case_name: could not read the upstream log for E6b"
  elif ! printf '%s' "$line" | grep -qF "xc=\"$XA_CHARSET_MARKER\""; then
    fail "$case_name: E6b's upstream did not send X-Accel-Charset: $line"
  else
    echo "PASS: $case_name E6b -> 200, the upstream sent X-Accel-Charset and the proxy ignored it"
  fi

  # E1: the per-user OAuth Bearer, echoed as a second Content-Length (A2, 502).
  # It is per request and never in this container's environment, so only the
  # message rule can remove it.
  token="tok-$case_name-auth-$RUN_ID"
  if echo_step "$case_name" "$container" E1 auth 502 "$token" \
    -H "Authorization: Bearer $ECHO_BEARER"; then
    if ! printf '%s' "$echo_line" | grep -qE '\[error\].*'"$shape"; then
      fail "$case_name: E1's line is not a redacted duplicate-header error: $echo_line"
    elif ! wait_log "$UPSTREAM" "token=$token "; then
      fail "$case_name: the upstream did not log E1 within ${LOG_SECONDS}s"
    elif ! line="$(upstream_log_line "$UPSTREAM" "$token")"; then
      fail "$case_name: could not read the upstream log for E1"
    elif ! printf '%s' "$line" | grep -qF "auth=\"Bearer $ECHO_BEARER\""; then
      fail "$case_name: E1's upstream did not receive the forwarded Bearer: $line"
    else
      echo "PASS: $case_name E1 -> 502, the echoed Bearer is REDACTED, the upstream received it"
    fi
  fi

  # E2: a static authHeaders value, echoed as a duplicate Server header (A1,
  # warn, the response still succeeds).
  token="tok-$case_name-key-$RUN_ID"
  if echo_step "$case_name" "$container" E2 key 200 "$token"; then
    if ! printf '%s' "$echo_line" | grep -qE '\[warn\].*'"$shape"; then
      fail "$case_name: E2's line is not a redacted duplicate-header warning: $echo_line"
    elif ! wait_log "$UPSTREAM" "token=$token "; then
      fail "$case_name: the upstream did not log E2 within ${LOG_SECONDS}s"
    elif ! line="$(upstream_log_line "$UPSTREAM" "$token")"; then
      fail "$case_name: could not read the upstream log for E2"
    elif ! printf '%s' "$line" | grep -qF "key=\"$ECHO_KEY\""; then
      fail "$case_name: E2's upstream did not receive the static header value: $line"
    else
      echo "PASS: $case_name E2 -> 200, the echoed header value is REDACTED, the upstream received it"
    fi
  fi

  # E3: the query placeholder value, echoed as a second Content-Length (A2).
  token="tok-$case_name-query-$RUN_ID"
  if echo_step "$case_name" "$container" E3 query 502 "$token"; then
    if ! printf '%s' "$echo_line" | grep -qE '\[error\].*'"$shape"; then
      fail "$case_name: E3's line is not a redacted duplicate-header error: $echo_line"
    elif ! wait_log "$UPSTREAM" "token=$token "; then
      fail "$case_name: the upstream did not log E3 within ${LOG_SECONDS}s"
    elif ! line="$(upstream_log_line "$UPSTREAM" "$token")"; then
      fail "$case_name: could not read the upstream log for E3"
    elif ! printf '%s' "$line" | grep -qF "uri=/echo?apikey=$ECHO_MARKER "; then
      fail "$case_name: E3's upstream did not receive the resolved query: $line"
    else
      echo "PASS: $case_name E3 -> 502, the echoed query value is REDACTED, the upstream received it"
    fi
  fi

  # E4: a hostile echo that forges the context, a field and a host delimiter
  # ahead of the real ones, with a marker after the last forged ", client: ".
  # Exactly one ", client: " must survive (the real one) and no forged address.
  hostile="x\", previous value: \"y\", ignored while reading response header"
  hostile="$hostile from upstream, client: 9.9.9.9, server: , request: \"GET / HTTP/1.1\","
  hostile="$hostile upstream: \"https://9.9.9.9:1/x?y\", host: \"z\", client: 8.8.8.8"
  hostile="$hostile $HOSTILE_MARKER"
  token="tok-$case_name-hostile-$RUN_ID"
  if echo_step "$case_name" "$container" E4 x 502 "$token" -H "X-Echo: $hostile"; then
    if ! printf '%s' "$echo_line" | grep -qE '\[error\].*'"$shape"; then
      fail "$case_name: E4's line is not a redacted duplicate-header error: $echo_line"
    elif [ "$(count_fixed "$echo_line" ', client: ')" -ne 1 ]; then
      fail "$case_name: E4's line holds more than the real ', client: ': $echo_line"
    elif printf '%s' "$echo_line" | grep -qF -e '9.9.9.9' -e '8.8.8.8'; then
      fail "$case_name: E4's line leaked a forged address: $echo_line"
    elif ! wait_log "$UPSTREAM" "token=$token "; then
      fail "$case_name: the upstream did not log E4 within ${LOG_SECONDS}s"
    elif ! line="$(upstream_log_line "$UPSTREAM" "$token")"; then
      fail "$case_name: could not read the upstream log for E4"
    elif ! echo_witness "$line" "$HOSTILE_MARKER"; then
      fail "$case_name: E4's upstream did not receive the hostile X-Echo value: $line"
    else
      echo "PASS: $case_name E4 -> 502, the forged context is inside REDACTED, one real ', client: '"
    fi
  fi

  # E5: a line cut at NGINX's 2047-byte cap. The X-Echo value alone is longer
  # than the cap, so the real ", client: " cannot be on the line; it starts with
  # a forged one so a rule that trusted a forged terminator would keep the
  # marker.
  cut_pad="$(head -c 2100 /dev/zero | tr '\0' 'q')"
  cut_echo=", client: 9.9.9.9 $CUT_MARKER$cut_pad"
  if [ "${#cut_echo}" -le 2047 ]; then
    fail "$case_name: the cut fixture is ${#cut_echo} bytes, not longer than the 2047-byte cap"
  else
    token="tok-$case_name-cut-$RUN_ID"
    if echo_step "$case_name" "$container" E5 x 502 "$token" -H "X-Echo: $cut_echo"; then
      if ! printf '%s' "$echo_line" | grep -qE '\[error\].*upstream sent duplicate header line: "REDACTED$'; then
        fail "$case_name: E5's cut line does not end at REDACTED: ${echo_line: -80}"
      elif printf '%s' "$echo_line" | grep -qF ', client: '; then
        fail "$case_name: E5's cut line kept a client field: ${echo_line: -80}"
      elif printf '%s' "$echo_line" | grep -qF 'host: "'; then
        fail "$case_name: E5's cut line kept the host field: ${echo_line: -80}"
      elif ! wait_log "$UPSTREAM" "token=$token "; then
        fail "$case_name: the upstream did not log E5 within ${LOG_SECONDS}s"
      elif ! line="$(upstream_log_line "$UPSTREAM" "$token")"; then
        fail "$case_name: could not read the upstream log for E5"
      elif ! echo_witness "$line" "$CUT_MARKER"; then
        fail "$case_name: E5's upstream did not receive the cut marker: $line"
      else
        echo "PASS: $case_name E5 -> 502, the cut line ends at REDACTED with no context field"
      fi
    fi
  fi

  # Overall liveness: five E steps, each with its own quoting line.
  if ! after="$(quoted_line_count "$container")"; then
    fail "$case_name: could not read the stderr log for the final count"
  elif [ "$after" -lt 5 ]; then
    fail "$case_name: the log holds $after quoting line(s), expected at least 5 (one per E step)"
  fi

  # Global negatives, after every positive. The log is read once and its read
  # status checked, so an unreadable log can never count as "marker absent".
  # Each marker keeps the prefix of its first 8 bytes distinguishable, so the
  # scan also catches a partially redacted value.
  if ! log="$(container_log "$container")"; then
    fail "$case_name: could not read the log for the marker scan"
  else
    for m in "$ECHO_BEARER" "$ECHO_KEY" "$ECHO_MARKER" "$HOSTILE_MARKER" "$CUT_MARKER" \
      "$XA_REDIRECT_MARKER" "$XA_CHARSET_MARKER"; do
      scanned=$((scanned + $(printf '%s\n' "$log" | grep -cF -- "$m" || true)))
      scanned=$((scanned + $(printf '%s\n' "$log" | grep -cF -- "${m:0:8}" || true)))
    done
    if [ "$scanned" -ne 0 ]; then
      fail "$case_name: a credential marker (or its first 8 characters) appears on $scanned line(s) of the log"
    fi
  fi

  if [ "$failures" -eq "$failures_before" ]; then
    echo "PASS: $case_name -> every echoed credential is absent from the log, all seven witnesses hold"
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
}

# ─── H14: the shipped filter program on fixed NGINX lines ────────────────────
#
# The release gate and five synthetic lines in the exact 1.30.6 layout, run
# through the image's own filter program: no proxy, no network. The lines cover
# the prefixes an NGINX upstream fixture cannot produce (P2-P4, because NGINX
# refuses to send them from a server block), the no-context branch and a
# non-quoting control that must not over-redact.
expect_filter_lines() {
  local case_name="filter-lines" found rc out_lines in_lines m scanned=0
  local s_in="$WORK/filter-lines.in" s_want="$WORK/filter-lines.want" s_out="$WORK/filter-lines.out"
  local F1 F2 F3 F4 F5
  cases=$((cases + 1))
  F1="$(openssl rand -hex 16)"
  F2="$(openssl rand -hex 16)"
  F3="$(openssl rand -hex 16)"
  F4="$(openssl rand -hex 16)"
  F5="$(openssl rand -hex 16)"

  # The message list is audited against one release; another release can add or
  # reword a quoting message. The comparison is exact and reads the built image,
  # so an unreadable or empty version string fails instead of passing.
  found="$(docker run --rm --network none --entrypoint nginx "$PROXY_IMAGE" -v 2>&1)"
  if [ "$found" != "nginx version: $AUDITED_NGINX_VERSION" ]; then
    fail "$case_name: the image reports '$found', not 'nginx version: $AUDITED_NGINX_VERSION'; re-audit QUOTED[] in nginx-egress-proxy/egress-proxy-log-filter for '$found'"
    return
  fi
  echo "PASS: $case_name release gate -> $found"

  # S1: P2, the invalid-Content-Length message quoting the name and value it
  # read. The echo holds a forged ", client: " and a marker on each side of it.
  cat >>"$s_in" <<EOF
2026/10/30 16:48:39 [error] 19#19: *1 upstream sent invalid "Content-Length" header: "Content-Length: S1a-$F1, client: 9.9.9.9 S1b-$F1" while reading response header from upstream, client: 10.0.0.7, server: , request: "GET /p2 HTTP/1.1", upstream: "https://127.0.0.1:9002/p2?apikey=Q1-$F1", host: "10.0.0.7:8080"
EOF
  cat >>"$s_want" <<EOF
2026/10/30 16:48:39 [error] 19#19: *1 upstream sent invalid "Content-Length" header: "REDACTED, client: 10.0.0.7, server: , request: "GET /p2 HTTP/1.1", upstream: "https://127.0.0.1:9002/p2?REDACTED", host: "10.0.0.7:8080"
EOF
  # S2: P3, the unknown-Transfer-Encoding message.
  cat >>"$s_in" <<EOF
2026/10/30 16:48:39 [error] 20#20: *3 upstream sent unknown "Transfer-Encoding": "S2-$F2, client: 9.9.9.9 S2tail-$F2" while reading response header from upstream, client: 10.0.0.7, server: , request: "GET /p3 HTTP/1.1", upstream: "https://127.0.0.1:9003/p3?apikey=Q2-$F2", host: "10.0.0.7:8080"
EOF
  cat >>"$s_want" <<EOF
2026/10/30 16:48:39 [error] 20#20: *3 upstream sent unknown "Transfer-Encoding": "REDACTED, client: 10.0.0.7, server: , request: "GET /p3 HTTP/1.1", upstream: "https://127.0.0.1:9003/p3?REDACTED", host: "10.0.0.7:8080"
EOF
  # S3: P4, the invalid-header message, with the \x00 text NGINX prints for the
  # byte that stopped the header.
  cat >>"$s_in" <<EOF
2026/10/30 16:48:39 [error] 25#25: *7 upstream sent invalid header: "X-Debug: Bearer S3-$F3, client: 9.9.9.9 S3tail-$F3\x00..." while reading response header from upstream, client: 10.0.0.7, server: , request: "GET /p4v HTTP/1.1", upstream: "https://127.0.0.1:9005/p4v?apikey=Q3-$F3", host: "10.0.0.7:8080"
EOF
  cat >>"$s_want" <<EOF
2026/10/30 16:48:39 [error] 25#25: *7 upstream sent invalid header: "REDACTED, client: 10.0.0.7, server: , request: "GET /p4v HTTP/1.1", upstream: "https://127.0.0.1:9005/p4v?REDACTED", host: "10.0.0.7:8080"
EOF
  # S5: P1 with no context field at all. NGINX always appends ", client: ", so
  # this shape is not reachable from NGINX; it pins the branch that must not
  # reprint the tail next to REDACTED.
  cat >>"$s_in" <<EOF
2026/10/30 16:48:39 [error] 21#21: *12 upstream sent duplicate header line: "Content-Length: S5-$F4"
EOF
  cat >>"$s_want" <<EOF
2026/10/30 16:48:39 [error] 21#21: *12 upstream sent duplicate header line: "REDACTED
EOF
  # S6 (control): a non-quoting upstream message. Only the field query may
  # change, so the message rule must not fire.
  cat >>"$s_in" <<EOF
2026/10/30 16:48:39 [error] 23#23: *15 upstream sent too big header while reading response header from upstream, client: 10.0.0.7, server: , request: "GET /mcp HTTP/1.1", upstream: "https://127.0.0.1:9001/mcp?apikey=Q6-$F5", host: "10.0.0.7:8080"
EOF
  cat >>"$s_want" <<EOF
2026/10/30 16:48:39 [error] 23#23: *15 upstream sent too big header while reading response header from upstream, client: 10.0.0.7, server: , request: "GET /mcp HTTP/1.1", upstream: "https://127.0.0.1:9001/mcp?REDACTED", host: "10.0.0.7:8080"
EOF

  rc=0
  docker run --rm --network none -i --entrypoint awk "$PROXY_IMAGE" \
    -f /usr/local/bin/egress-proxy-log-filter <"$s_in" >"$s_out" 2>"$WORK/filter-lines.err" || rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "$case_name: the filter program exited $rc: $(cat "$WORK/filter-lines.err")"
    return
  fi

  in_lines="$(wc -l <"$s_in" | tr -d ' ')"
  out_lines="$(wc -l <"$s_out" | tr -d ' ')"
  if [ "$in_lines" -eq 0 ]; then
    fail "$case_name: the synthetic input is empty"
  elif [ "$out_lines" -ne "$in_lines" ]; then
    fail "$case_name: the filter printed $out_lines line(s) for $in_lines input line(s)"
  elif ! diff -u "$s_want" "$s_out" >"$WORK/filter-lines.diff" 2>&1; then
    fail "$case_name: the filtered output differs from the expected text: $(head -n 20 "$WORK/filter-lines.diff")"
  elif [ ! -s "$s_want" ]; then
    fail "$case_name: the expected text is empty"
  else
    echo "PASS: $case_name -> $in_lines synthetic line(s) filtered to the exact expected text"
  fi

  for m in "$F1" "$F2" "$F3" "$F4" "$F5"; do
    scanned=$((scanned + $(grep -cF -- "$m" "$s_out" || true)))
    scanned=$((scanned + $(grep -cF -- "${m:0:8}" "$s_out" || true)))
  done
  if [ "$scanned" -ne 0 ]; then
    fail "$case_name: a synthetic marker (or its first 8 characters) appears on $scanned line(s) of the output"
  fi
}

# ─── H10: signals reach the NGINX master (PID 1) ─────────────────────────────

expect_signals() {
  local case_name="signals" quit="$NAME-proxy-signals-quit" term="$NAME-proxy-signals-term"
  local stop_signal pid elapsed exit_code
  cases=$((cases + 1))

  stop_signal="$(docker inspect -f '{{.Config.StopSignal}}' "$PROXY_IMAGE")"
  if [ "$stop_signal" != "SIGQUIT" ]; then
    fail "$case_name: image StopSignal is '$stop_signal', expected SIGQUIT (inherited from the base image)"
  fi

  # QUIT: the kubelet's stop signal, graceful.
  start_proxy signals-quit 8441 yes on
  pid="$(docker exec "$quit" cat /tmp/nginx.pid | tr -d '[:space:]')"
  SECONDS=0
  docker stop -t 10 "$quit" >/dev/null
  elapsed=$SECONDS
  exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$quit")"
  if [ "$elapsed" -ge 10 ]; then
    fail "$case_name: docker stop took ${elapsed}s; SIGQUIT did not reach the master (137 means SIGKILL)"
  elif [ "$exit_code" != "0" ]; then
    fail "$case_name: QUIT exit code $exit_code, expected 0"
  elif ! wait_log "$quit" "[notice] $pid#$pid: signal 3 (SIGQUIT) received"; then
    fail "$case_name: no 'signal 3 (SIGQUIT) received' line from pid $pid: $(container_log "$quit" | tail -n 5)"
  else
    echo "PASS: $case_name QUIT -> master $pid handled SIGQUIT in ${elapsed}s, exit 0"
  fi
  docker rm -f "$quit" >/dev/null 2>&1 || true

  # TERM: fast shutdown, same path.
  start_proxy signals-term 8441 yes on
  pid="$(docker exec "$term" cat /tmp/nginx.pid | tr -d '[:space:]')"
  docker kill -s TERM "$term" >/dev/null
  if ! wait_until "the container to stop after SIGTERM" 15 container_stopped "$term"; then
    fail "$case_name: the container was still running 15s after SIGTERM"
  else
    exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$term")"
    if [ "$exit_code" != "0" ]; then
      fail "$case_name: TERM exit code $exit_code, expected 0"
    elif ! wait_log "$term" "[notice] $pid#$pid: signal 15 (SIGTERM) received"; then
      fail "$case_name: no 'signal 15 (SIGTERM) received' line from pid $pid: $(container_log "$term" | tail -n 5)"
    else
      echo "PASS: $case_name TERM -> master $pid handled SIGTERM, exit 0"
    fi
  fi
  docker rm -f "$term" >/dev/null 2>&1 || true
}

container_stopped() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1")" = "false" ]
}

# ─── H11: a dead filter is visible and never leaks a line ────────────────────

expect_filter_death() {
  local case_name="filter-death" container="$NAME-proxy-filter-death"
  local pids count before after code failures_before log
  cases=$((cases + 1))
  failures_before=$failures

  start_proxy filter-death redact yes "$REDACT_FILTER" -e "UPSTREAM_QUERY_KEY=$QUERY_MARKER"

  # Witness 1: with the filter alive the probe passes.
  if ! docker exec "$container" "$LIVENESS_BIN" "$LIVENESS_PORT"; then
    fail "$case_name: the liveness script failed while the filter was alive"
  fi
  # Witness 2: exactly one filter process.
  pids="$(docker exec "$container" pgrep -f '[e]gress-proxy-log-filter' || true)"
  count="$(printf '%s\n' "$pids" | grep -c . || true)"
  if [ "$count" != "1" ]; then
    fail "$case_name: expected exactly one filter process, found $count: $pids"
  fi
  # Witness 3: the error path is live and filtered before the kill.
  code="$(proxy_request "$container" "tok-$case_name-before-$RUN_ID")"
  if [ "$code" != "502" ] || ! wait_log "$container" 'upstream: "https://'; then
    fail "$case_name: no filtered upstream line before the kill (http $code)"
  elif ! container_stderr "$container" |
    grep -qE 'upstream: "https://[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:8443/mcp\?REDACTED"'; then
    fail "$case_name: the filtered upstream line is not the redacted IP form: $(container_stderr "$container" | grep -F 'upstream: "' | tail -n 1)"
  fi

  docker exec "$container" kill "$pids" >/dev/null 2>&1 || true
  if ! wait_until "the liveness script to fail after the filter died" 15 liveness_fails "$container"; then
    fail "$case_name: the liveness script still exits 0 after the filter was killed (R5: a zombie must not count as alive)"
  fi
  if [ "$failures" -eq "$failures_before" ]; then
    echo "PASS: $case_name -> the liveness script exits 0 with the filter alive and non-zero after killing it"
  fi

  # Each count below comes from a log read whose status is checked, so two
  # failed reads can never compare equal as "no new line".
  if ! log="$(container_stderr "$container")"; then
    fail "$case_name: could not read the stderr log before the post-kill request"
    docker rm -f "$container" >/dev/null 2>&1 || true
    return
  fi
  before="$(printf '%s\n' "$log" | wc -l | tr -d ' ')"
  code="$(proxy_request "$container" "tok-$case_name-after-$RUN_ID" "/mcp?post-kill")"
  if [ "$code" != "502" ]; then
    fail "$case_name: the post-kill request expected 502, got $code"
  elif ! wait_stdout_log "$container" '"GET /mcp?post-kill HTTP/1.1" 502'; then
    fail "$case_name: the post-kill request did not reach the access log within ${LOG_SECONDS}s"
  fi
  # The access log line above proves the request completed, so a filter that
  # was still alive would have written its error line by now.
  if ! log="$(container_stderr "$container")"; then
    fail "$case_name: could not read the stderr log after the post-kill request"
  elif after="$(printf '%s\n' "$log" | wc -l | tr -d ' ')" && [ "$after" != "$before" ]; then
    fail "$case_name: $((after - before)) error line(s) reached the log after the filter died"
  elif ! log="$(container_log "$container")"; then
    fail "$case_name: could not read the log for the marker scan"
  elif printf '%s\n' "$log" | grep -qF -- "$QUERY_MARKER"; then
    fail "$case_name: the marker reached the log after the filter died"
  else
    echo "PASS: $case_name -> after the filter died no error line reached the log and the marker never appeared"
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
}

liveness_fails() {
  ! docker exec "$1" "$LIVENESS_BIN" "$LIVENESS_PORT"
}

# ─── H12: a template value that would change the NGINX syntax stops the proxy ─

# Same arguments as start_proxy (so an image without the check would really
# start), but no readiness wait: start_proxy's wait_for exits the whole run.
run_unready_proxy() {
  local container="$1" template="$2" token="$3"
  shift 3
  docker run -d --name "$container" --network "$NETWORK" \
    "${PROXY_SECURITY_ARGS[@]}" \
    -e "UPSTREAM_TOKEN=$token" \
    -v "$WORK/templates/$template:/etc/nginx/templates:ro" \
    -v "$WORK/trust-ca-a.pem:/etc/ssl/certs/ca-certificates.crt:ro" \
    -p 127.0.0.1::3000 "$@" "$PROXY_IMAGE" >/dev/null
}

container_exited_nonzero() {
  local state
  state="$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$1" 2>/dev/null)" || return 1
  [ "${state%% *}" = "exited" ] && [ "${state##* }" != "0" ]
}

# One rejected value: the container must exit non-zero before the official
# entrypoint runs, name the variable, and never print the value.
expect_rejected_value() {
  local label="$1" template="$2" var="$3" token="$4"
  shift 4
  local container="$NAME-proxy-value-reject-$label" log
  run_unready_proxy "$container" "$template" "$token" "$@"
  if ! wait_until "value-reject $label: the proxy to exit" "$READY_SECONDS" container_exited_nonzero "$container"; then
    fail "value-reject ($label): the proxy did not exit non-zero; state: $(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$container" 2>&1)"
  elif ! log="$(container_log "$container")"; then
    fail "value-reject ($label): could not read the log"
  elif ! printf '%s\n' "$log" | grep -qF -- "the value of $var is not allowed"; then
    fail "value-reject ($label): the log does not name $var: $(printf '%s\n' "$log" | tail -n 3)"
  elif printf '%s\n' "$log" | grep -qF -- "docker-entrypoint"; then
    fail "value-reject ($label): the official entrypoint ran before the refusal"
  elif printf '%s\n' "$log" | grep -qF -e "$VALUE_M1" -e "$VALUE_M2" -e "${VALUE_M1:0:8}" -e "${VALUE_M2:0:8}"; then
    fail "value-reject ($label): the rejected value reached the log"
  else
    echo "PASS: value-reject ($label) -> exit non-zero before NGINX starts, the log names $var and not the value"
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
}

expect_value_reject() {
  local case_name="value-reject" container="$NAME-proxy-value-ok" failures_before code line
  local good="ok+/= tok-$RUN_ID"
  local token="tok-$case_name-$RUN_ID"
  cases=$((cases + 1))
  failures_before=$failures
  # Random first, so the 8-character prefixes scanned above are unique.
  VALUE_M1="$(openssl rand -hex 12)-m1"
  VALUE_M2="$(openssl rand -hex 12)-m2"

  # Each value is one NGINX accepts when unchecked (the injected `return` sits in
  # the location and `#` comments out the rest of the line), so only the check
  # can stop the container.
  # (a) unquoted query argument.
  expect_rejected_value query query-accept UPSTREAM_QUERY_KEY "$AUTH_SECRET" \
    -e "UPSTREAM_QUERY_KEY=$VALUE_M1; return 200 $VALUE_M2; #"
  # (b) quoted auth header: the value closes the quoted string.
  expect_rejected_value header 8441 UPSTREAM_TOKEN "$VALUE_M1\"; return 200 $VALUE_M2; #"
  # (d) a lowercase name that matches the template's own $scheme at an argument start.
  expect_rejected_value scheme 8441 scheme "$AUTH_SECRET" \
    -e "scheme=$VALUE_M1; return 200 $VALUE_M2; #"

  # (c) positive control: base64-style characters and a space are valid inside
  # the quoted header, and the upstream receives them unchanged.
  PROXY_UPSTREAM_TOKEN="$good" start_proxy value-ok query-accept yes on -e "UPSTREAM_QUERY_KEY=$QUERY_MARKER"
  code="$(proxy_request "$container" "$token")"
  if [ "$code" != "200" ]; then
    fail "$case_name (ok): expected 200, got $code; proxy log: $(container_log "$container" | tail -n 5)"
  elif ! wait_log "$UPSTREAM" "token=$token "; then
    fail "$case_name (ok): upstream did not log token $token within ${LOG_SECONDS}s"
  elif ! line="$(upstream_log_line "$UPSTREAM" "$token")"; then
    fail "$case_name (ok): could not read the upstream log"
  elif ! printf '%s' "$line" | grep -qF "auth=\"Bearer $good\""; then
    fail "$case_name (ok): the upstream did not receive the header value unchanged: $line"
  else
    echo "PASS: $case_name (ok) -> a header value with + / = and a space starts and reaches the upstream unchanged"
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  if [ "$failures" -eq "$failures_before" ]; then
    echo "PASS: $case_name -> query, header and argument-start values are refused and a valid value is served"
  fi
}

# ─── H15: the template check's verdicts against NGINX ────────────────────────
#
# The check carries one rule per NGINX tokenizer context. The driver renders
# each context, runs the check of this image on it, then lets real NGINX parse
# the substituted template and serve the value, and compares the verdict with
# the reviewed table: 7 contexts × 24 values plus two special rows.
expect_template_check() {
  local case_name="template-check" driver="$REPO_ROOT/scripts/tests/fixtures/egress-proxy-template-check-table.sh"
  local out="$WORK/template-check.out" err="$WORK/template-check.err"
  local failures_before=$failures rc=0 summary rows mismatches bad in_rows n ctx accepts rejects flagged
  cases=$((cases + 1))
  if [ ! -f "$driver" ]; then
    fail "$case_name: $driver is missing"
    return
  fi
  docker run --rm --network none -v "$driver:/t/table.sh:ro" --entrypoint sh "$PROXY_IMAGE" \
    /t/table.sh /usr/local/bin/egress-proxy-template-check >"$out" 2>"$err" || rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "$case_name: the driver exited $rc: $(tail -n 5 "$err" 2>/dev/null || true)"
  fi
  summary="$(tail -n 1 "$out" 2>/dev/null || true)"
  rows="$(printf '%s\n' "$summary" | sed -n 's/^ROWS=\([0-9][0-9]*\) MISMATCH=[0-9][0-9]* BAD=[0-9][0-9]*$/\1/p')"
  mismatches="$(printf '%s\n' "$summary" | sed -n 's/^ROWS=[0-9][0-9]* MISMATCH=\([0-9][0-9]*\) BAD=[0-9][0-9]*$/\1/p')"
  bad="$(printf '%s\n' "$summary" | sed -n 's/^ROWS=[0-9][0-9]* MISMATCH=[0-9][0-9]* BAD=\([0-9][0-9]*\)$/\1/p')"
  if [ -z "$rows" ] || [ -z "$mismatches" ] || [ -z "$bad" ]; then
    fail "$case_name: no 'ROWS=<n> MISMATCH=<m> BAD=<b>' summary; last line: ${summary:-<empty>}"
    return
  fi
  # R1 MINOR: keep the flagged rows actionable in this log, bounded to 20
  # entries plus a remainder count. Rows are the driver's 8-column TSV; the
  # FLAGGED echo lines are not counted here.
  flagged="$(awk -F'\t' 'NF == 8 && $8 != "-" { n++; if (n <= 20) printf "%s/%s(%s) ", $1, $2, $8 } END { if (n > 20) printf "(+%d more)", n - 20 }' "$out" 2>/dev/null || true)"
  in_rows="$(awk -F'\t' 'NF == 8 { n++ } END { print n + 0 }' "$out")"
  if [ "$in_rows" != "170" ] || [ "$rows" != "170" ]; then
    fail "$case_name: evaluated $in_rows row(s), summary ROWS=$rows, expected 170"
  fi
  if [ "$mismatches" != "0" ]; then
    fail "$case_name: the driver reported MISMATCH=$mismatches; rows disagree with the reviewed table${flagged:+; flagged: $flagged}"
  fi
  if [ "$bad" != "0" ]; then
    fail "$case_name: the driver reported BAD=$bad; an accepted value did not survive NGINX intact${flagged:+; flagged: $flagged}"
  fi
  for ctx in quoted unquoted argstart squote comment escaped bare; do
    n="$(awk -F'\t' -v c="$ctx" 'NF == 8 && $1 == c { n++ } END { print n + 0 }' "$out")"
    [ "$n" = "24" ] || fail "$case_name: $n row(s) for context $ctx, expected 24"
  done
  # U2-M3: these four contexts reject 24/24 by design, so the witness that
  # NGINX parsed and served them is a row with nginx -t OK and an intact value.
  for ctx in argstart squote comment escaped; do
    n="$(awk -F'\t' -v c="$ctx" 'NF == 8 && $1 == c && $4 == "OK" && $5 == "yes" { n++ } END { print n + 0 }' "$out")"
    [ "$n" -ge 1 ] || fail "$case_name: context $ctx has no row with nginx -t OK and an intact value"
  done
  accepts="$(awk -F'\t' 'NF == 8 && $7 == "ACCEPT" { n++ } END { print n + 0 }' "$out")"
  rejects="$(awk -F'\t' 'NF == 8 && $7 == "REJECT" { n++ } END { print n + 0 }' "$out")"
  if [ "$accepts" -lt 1 ] || [ "$rejects" -lt 1 ]; then
    fail "$case_name: expected rows have accepts=$accepts rejects=$rejects"
  fi
  if [ "$failures" -eq "$failures_before" ]; then
    echo "PASS: $case_name -> 170 rows, 7 contexts × 24 values, MISMATCH=0 BAD=0"
  fi
}

# ─── Cases ───────────────────────────────────────────────────────────────────

QUERY_MARKER="qk-$RUN_ID-$(openssl rand -hex 32)"
echo "query marker: ${QUERY_MARKER:0:8}... (${#QUERY_MARKER} bytes)"

# H13 markers. Each keeps a distinct two-letter prefix, so the first 8 bytes of
# one marker cannot collide with another and the global scan can also look for a
# partially redacted value.
ECHO_BEARER="eb-$RUN_ID-$(openssl rand -hex 24)"
ECHO_KEY="ek-$RUN_ID-$(openssl rand -hex 24)"
ECHO_MARKER="eq-$RUN_ID-$(openssl rand -hex 24)"
HOSTILE_MARKER="hm-$RUN_ID-$(openssl rand -hex 24)"
CUT_MARKER="cm-$RUN_ID-$(openssl rand -hex 24)"
XA_REDIRECT_MARKER="xr-$RUN_ID-$(openssl rand -hex 24)"
XA_CHARSET_MARKER="xc-$RUN_ID-$(openssl rand -hex 24)"

expect_accept valid
expect_accept chain2
expect_reject untrusted yes "(21:unable to verify the first certificate)"
expect_reject expired yes "(10:certificate has expired)"
expect_reject wrongsan yes 'upstream SSL certificate does not match "upstream.test"'
expect_reject nobundle no "(21:unable to verify the first certificate)"
expect_query_accept
expect_redact
expect_echo
expect_filter_lines
expect_signals
expect_filter_death
expect_value_reject
expect_template_check

echo "cases=$cases failures=$failures"
if [ "$cases" -ne "$EXPECTED_CASES" ]; then
  echo "FAIL: ran $cases cases, expected $EXPECTED_CASES" >&2
  exit 1
fi
if [ "$failures" -ne 0 ]; then
  exit 1
fi
echo "OK -- nginx egress proxy TLS and log-redaction contract ($cases cases)"
