#!/usr/bin/env bash
# Runtime TLS, DNS re-resolution and log-redaction contract for the remote MCP
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
# Cases (12, the run fails unless exactly this many ran):
#
#   valid, chain2, untrusted, expired, wrongsan, nobundle   TLS contract
#   dns-switch     the upstream's A record moves to another container while the
#                  same NGINX master keeps serving (resolver + `resolve`, TTL 1s)
#   query-accept   a ${VAR} query placeholder is resolved by envsubst inside the
#                  container and reaches the upstream (#1240)
#   redact         an upstream error line never carries the remote query, in the
#                  IP form, the upstream-group form, a line truncated at
#                  NGINX's 2047-byte error cap, and a line where upstream bytes
#                  quoted in the message put a fake field ahead of the real one
#                  while the value itself holds a quote (#1240)
#   signals        QUIT and TERM reach the NGINX master, which is PID 1
#   filter-death   the exec liveness script fails once the stderr filter dies,
#                  and no unfiltered error line reaches the logs
#   value-reject   a query value, a header value and a lowercase name matching a
#                  template NGINX variable that would change the NGINX syntax
#                  stop the container before NGINX starts, naming the variable
#                  and never the value; a valid header value with + / = and a
#                  space is served unchanged
#
# Requires docker, curl, openssl, node and `npm ci` in host-context-controller.
#
# NGINX_TLS_TEST_MUTATION=<mode> rewrites the rendered template or builds the
# image from an edited copy, to prove the cases detect a broken build. A mutated
# run is expected to fail:
#
#   verify-off            proxy_ssl_verify off               -> untrusted, expired, wrongsan, nobundle red
#   depth-1               proxy_ssl_verify_depth 1           -> chain2 red
#   no-resolve            drops ` resolve` (dns-switch only) -> dns-switch red
#   no-ssl-name           drops proxy_ssl_name               -> valid, chain2, wrongsan red
#   no-redact             runs the proxy without its filter  -> redact, filter-death red
#   liveness-health-only  liveness script checks /health only -> filter-death red
#   redact-first-only     filter redacts only the first field -> redact (req4) red
#   redact-first-quote    filter ends the field at the first quote -> redact (req4) red
#   no-value-check        wrapper skips the template value check -> value-reject red
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
UPSTREAM_X="$NAME-upstream-x"
UPSTREAM_Y="$NAME-upstream-y"
DNS="$NAME-dns"
WORK="$(mktemp -d)"
EXPECTED_CASES=12
# Pinned by multi-arch index digest: the CI matrix runs this harness on amd64
# and arm64, and a tag alone would let the two runs use different CoreDNS
# builds. registry.k8s.io is used instead of Docker Hub so this image does not
# need the mirror mapping the nginx base image uses.
COREDNS_IMAGE="registry.k8s.io/coredns/coredns:v1.12.1@sha256:e8c262566636e6bc340ece6473b0eed193cad045384401529721ddbe6463d31c"
# shellcheck disable=SC2016  # awk program: $2 is an awk field, not a shell expansion.
RSS_AWK='/^VmRSS:/ { s += $2 } END { print s + 0 }'
failures=0
cases=0
startup_no_live=0

for tool in docker curl openssl node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FAIL: $tool is required" >&2; exit 1; }
done
if [ ! -f "$HCC_DIR/node_modules/ts-node/dist/bin.js" ]; then
  echo "FAIL: run npm ci in host-context-controller first (ts-node is missing)" >&2
  exit 1
fi
case "$MUTATION" in
  "" | verify-off | depth-1 | no-resolve | no-ssl-name | no-redact | liveness-health-only | \
    redact-first-only | redact-first-quote | no-value-check) ;;
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
  redact-first-only | redact-first-quote)
    build_context="$WORK/image-mutation"
    cp -R "$DOCKERFILE_DIR" "$build_context"
    if [ "$MUTATION" = "redact-first-only" ]; then
      mutate "$build_context/egress-proxy-log-filter" \
        'while ((start = index(rest, FIELD)) > 0) {' 'if ((start = index(rest, FIELD)) > 0) {'
    else
      mutate "$build_context/egress-proxy-log-filter" 'NEXT_HOST = "\", host: \""' 'NEXT_HOST = "\""'
    fi
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

if ! docker image inspect "$COREDNS_IMAGE" >/dev/null 2>&1; then
  if ! docker pull "$COREDNS_IMAGE" >/dev/null; then
    echo "FAIL: cannot pull the pinned DNS fixture image $COREDNS_IMAGE" >&2
    exit 1
  fi
fi
echo "dns image: $COREDNS_IMAGE"

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
  echo "log_format tlstest 'TLSTEST port=\$server_port uri=\$request_uri token=\$http_x_test_token sni=\$ssl_server_name auth=\"\$http_authorization\"';"
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
DNS_FLIP_SECONDS=20

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

# ─── DNS fixture for the dns-switch case ─────────────────────────────────────

# Two containers with the same certificate serve the same host on 8446 and
# answer with their own identity. The DNS record decides which one the proxy
# reaches; the identity in the body is the witness that the answer changed.
identity_upstream_config() {
  local identity="$1"
  cat <<EOF
log_format tlstest 'TLSTEST port=\$server_port uri=\$request_uri token=\$http_x_test_token sni=\$ssl_server_name auth="\$http_authorization"';
server {
    listen 8446 ssl;
    server_name upstream.test;
    ssl_certificate /fixtures/valid.chain.pem;
    ssl_certificate_key /fixtures/valid.key;
    access_log /var/log/nginx/access.log tlstest;
    location / {
        default_type text/plain;
        return 200 "echo id=$identity token=\$http_x_test_token\n";
    }
}
EOF
}

for side in X Y; do
  container="$UPSTREAM_X"
  [ "$side" = "Y" ] && container="$UPSTREAM_Y"
  identity_upstream_config "$side" >"$WORK/upstream-$side.conf"
  chmod 644 "$WORK/upstream-$side.conf"
  docker run -d --name "$container" --network "$NETWORK" \
    -v "$PKI:/fixtures:ro" -v "$WORK/upstream-$side.conf:/etc/nginx/conf.d/default.conf:ro" \
    "$UPSTREAM_IMAGE" >/dev/null
done

docker_ip() {
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"
}

X_IP="$(docker_ip "$UPSTREAM_X")"
Y_IP="$(docker_ip "$UPSTREAM_Y")"
[ -n "$X_IP" ] && [ -n "$Y_IP" ] || { echo "FAIL: could not read the identity upstream addresses" >&2; exit 1; }

mkdir -p "$WORK/dns" "$WORK/coredns"
printf '%s upstream.test\n' "$X_IP" >"$WORK/dns/hosts"
cat >"$WORK/coredns/Corefile" <<'CORE'
upstream.test:53 {
    hosts /zone/hosts {
        ttl 1
        reload 1s
        no_reverse
    }
    log
    errors
}
CORE
chmod 644 "$WORK/coredns/Corefile"

docker run -d --name "$DNS" --network "$NETWORK" \
  -v "$WORK/dns:/zone:ro" -v "$WORK/coredns/Corefile:/etc/coredns/Corefile:ro" \
  "$COREDNS_IMAGE" -conf /etc/coredns/Corefile >/dev/null
DNS_IP="$(docker_ip "$DNS")"
[ -n "$DNS_IP" ] || { echo "FAIL: could not read the DNS fixture address" >&2; exit 1; }
# The proxy's only nameserver is the fixture, so 15-local-resolvers.envsh
# exports exactly this address as NGINX_LOCAL_RESOLVERS and the rendered
# `resolver` line uses it instead of Docker's embedded 127.0.0.11.
printf 'nameserver %s\n' "$DNS_IP" >"$WORK/dns-resolv.conf"
chmod 644 "$WORK/dns-resolv.conf"

dns_ready() {
  container_log "$DNS" | grep -q "CoreDNS-"
}
wait_until "the DNS fixture to start" "$READY_SECONDS" dns_ready || { docker logs "$DNS" >&2 2>&1; exit 1; }

# ─── Rendered proxy template ─────────────────────────────────────────────────

AUTH_SECRET="secret-$RUN_ID"
(
  cd "$HCC_DIR"
  # shellcheck disable=SC2016 # TypeScript source; ${...} is a JS template literal.
  TEMPLATE_DIR="$WORK/templates" SECURITY_ARGS="$WORK/proxy-security-args" \
    PROXY_ENV_FILE="$WORK/proxy-env-entry" LIVENESS_FILE="$WORK/proxy-liveness-command" \
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
const server = (baseUrl: string) => ({
  name: "tls-test",
  namespace: "mcp-server",
  spec: {
    contextRef: "tls-test",
    image: "clerum/nginx-egress-proxy:0.1.0",
    transport: { type: "streamableHttp", port: 3000 },
    managed: true,
    enabled: true,
    remote: {
      baseUrl,
      authHeaders: [{ header: "Authorization", valueTemplate: "Bearer ${UPSTREAM_TOKEN}" }],
    },
  },
})
const templateDir = process.env.TEMPLATE_DIR as string
const render = (dir: string, baseUrl: string) => {
  const cm = (reconciler as any).buildNginxConfigMap(server(baseUrl))
  const out = path.join(templateDir, dir)
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, "default.conf.template"), cm.data["default.conf.template"])
}
for (const port of [8441, 8442, 8443, 8444, 8445]) {
  render(String(port), "https://upstream.test:" + port + "/mcp")
}
render("dns-switch", "https://upstream.test:8446/mcp")
render("query-accept", "https://upstream.test:8441/mcp?apikey=${UPSTREAM_QUERY_KEY}")
render("redact", "https://upstream.test:8443/mcp?apikey=${UPSTREAM_QUERY_KEY}")
render("redact-group", "https://unresolvable.test:8443/mcp?apikey=${UPSTREAM_QUERY_KEY}")
render("redact-shadow", "https://upstream.test:8441/shadow?apikey=${UPSTREAM_QUERY_KEY}")

const deployment = (reconciler as any).buildDeployment(server("https://upstream.test:8441/mcp"))
const proxies = deployment.spec.template.spec.containers.filter((c: any) => c.name === "egress-proxy")
if (proxies.length !== 1) throw new Error(`expected one egress-proxy container, found ${proxies.length}`)
const proxy = proxies[0]

// Plan §3.3: the resolver entry must be present and last, because
// 15-local-resolvers.envsh returns early on an empty value and the CRD env
// would otherwise win. The harness passes exactly this entry to docker run, so
// a template that needs the variable while the Deployment stopped setting it
// fails here instead of silently rendering `${NGINX_LOCAL_RESOLVERS}`.
const resolverEntries = (proxy.env ?? []).filter(
  (e: any) => e.name === "NGINX_ENTRYPOINT_LOCAL_RESOLVERS"
)
if (resolverEntries.length === 0) {
  throw new Error("the egress-proxy container has no NGINX_ENTRYPOINT_LOCAL_RESOLVERS entry")
}
const resolverEntry = resolverEntries[resolverEntries.length - 1]
if (resolverEntry.value !== "1") {
  throw new Error(
    `the last NGINX_ENTRYPOINT_LOCAL_RESOLVERS entry is ${JSON.stringify(resolverEntry)}; ` +
      "15-local-resolvers.envsh would skip the resolv.conf export"
  )
}
fs.writeFileSync(process.env.PROXY_ENV_FILE as string, `${resolverEntry.name}=${resolverEntry.value}\n`)

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

PROXY_ENV_ENTRY="$(cat "$WORK/proxy-env-entry")"
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
echo "proxy env: $PROXY_ENV_ENTRY"
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
  assert_count "$t" 'resolver ${NGINX_LOCAL_RESOLVERS} ipv6=off;' 1
  assert_count "$t" "server upstream.test:$port resolve;" 1
  assert_count "$t" "proxy_pass https://remote_upstream/mcp;" 1
done
for template in dns-switch query-accept redact redact-group redact-shadow; do
  t="$WORK/templates/$template/default.conf.template"
  # shellcheck disable=SC2016  # literal envsubst placeholder expected in the template.
  assert_count "$t" 'resolver ${NGINX_LOCAL_RESOLVERS} ipv6=off;' 1
done

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
  no-ssl-name)
    for port in 8441 8442 8443 8444 8445; do
      mutate "$WORK/templates/$port/default.conf.template" \
        "proxy_ssl_name upstream.test;" "# proxy_ssl_name removed by NGINX_TLS_TEST_MUTATION=no-ssl-name"
    done
    ;;
  no-resolve)
    mutate "$WORK/templates/dns-switch/default.conf.template" " resolve;" ";"
    ;;
esac

# `no-redact` removes the filter from the containers that prove it: they start
# through the official entrypoint, exactly like a proxy image without the
# wrapper. The mutation is a run-time entrypoint switch, never an image knob.
REDACT_FILTER=on
[ "$MUTATION" = "no-redact" ] && REDACT_FILTER=off
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
    -e "$PROXY_ENV_ENTRY"
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

# Counts the "no live upstreams" lines a resolving proxy logged, so the 10-run
# flake record can tell a start-up resolution race from a real failure.
note_no_live() {
  local n
  n="$(container_log "$1" | grep -cF 'no live upstreams' || true)"
  if [ "${n:-0}" -gt 0 ]; then
    echo "NOTE: $1 logged $n 'no live upstreams' line(s)"
    startup_no_live=$((startup_no_live + n))
  fi
}

proxy_request() {
  local container="$1" token="$2" path="${3:-/mcp}"
  curl -s -o "$WORK/body" -w '%{http_code}' --max-time 15 -H "X-Test-Token: $token" \
    "http://127.0.0.1:$(host_port "$container" 3000)$path"
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
  note_no_live "$container"
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
  note_no_live "$container"
  docker rm -f "$container" >/dev/null 2>&1 || true
}

# ─── H7: DNS re-resolution inside one NGINX master ───────────────────────────

# Number of A queries for upstream.test that the fixture DNS received from the
# proxy's own address.
dns_query_count() {
  local container="$1" proxy_ip="$2" log
  log="$(container_log "$container")" || return 2
  printf '%s\n' "$log" | grep -F "$proxy_ip:" | grep -c 'A IN upstream.test\.' || true
}

expect_dns_switch() {
  local case_name="dns-switch" container="$NAME-proxy-dns-switch" template="$WORK/templates/dns-switch/default.conf.template"
  local token code proxy_ip q0 q1 pid_before pid_after started_before started_after restarts_before restarts_after seen_x
  local deadline last="" flip_token="" flipped=0
  cases=$((cases + 1))

  if [ "$(grep -cF 'proxy_ssl_verify on;' "$template" || true)" != "1" ]; then
    fail "$case_name: the rendered template does not enable proxy_ssl_verify exactly once"
  fi

  start_proxy "$case_name" dns-switch yes on -v "$WORK/dns-resolv.conf:/etc/resolv.conf:ro"
  proxy_ip="$(docker_ip "$container")"
  if [ -z "$proxy_ip" ]; then
    fail "$case_name: could not read the proxy address"
    docker rm -f "$container" >/dev/null 2>&1 || true
    return
  fi
  if ! wait_until "the proxy to query the DNS fixture" "$READY_SECONDS" \
    dns_query_seen "$DNS" "$proxy_ip"; then
    fail "$case_name: the proxy never queried the fixture DNS for upstream.test"
    docker rm -f "$container" >/dev/null 2>&1 || true
    return
  fi

  # Warmup: the first answer must be X, so a later Y can only come from the
  # record change. Without it the case could pass with Y as the first answer.
  token="warmup-$case_name-$RUN_ID"
  code="$(proxy_request "$container" "$token")"
  if [ "$code" != "200" ] || ! grep -qF "id=X" "$WORK/body"; then
    fail "$case_name: warmup expected 200 id=X, got $code $(cat "$WORK/body")"
    docker rm -f "$container" >/dev/null 2>&1 || true
    return
  fi
  if ! wait_log "$UPSTREAM_X" "token=$token "; then
    fail "$case_name: upstream X did not log the warmup token within ${LOG_SECONDS}s"
    docker rm -f "$container" >/dev/null 2>&1 || true
    return
  fi

  q0="$(dns_query_count "$DNS" "$proxy_ip")"
  pid_before="$(docker exec "$container" cat /tmp/nginx.pid | tr -d '[:space:]')"
  started_before="$(docker inspect -f '{{.State.StartedAt}}' "$container")"
  restarts_before="$(docker inspect -f '{{.RestartCount}}' "$container")"

  # Switch the record by writing a new file and renaming it into the mounted
  # directory. A single-file bind mount would pin the old inode.
  printf '%s upstream.test\n' "$Y_IP" >"$WORK/dns/hosts.new"
  mv "$WORK/dns/hosts.new" "$WORK/dns/hosts"
  echo "$case_name: switched upstream.test from X ($X_IP) to Y ($Y_IP)"

  deadline=$((SECONDS + DNS_FLIP_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    token="flip-$case_name-$RUN_ID-$RANDOM"
    code="$(proxy_request "$container" "$token")"
    if [ "$code" = "200" ] && grep -qF "id=Y" "$WORK/body"; then
      flip_token="$token"
      flipped=1
      break
    fi
    last="http=$code body=$(cat "$WORK/body")"
    sleep 0.5
  done

  q1="$(dns_query_count "$DNS" "$proxy_ip")"
  pid_after="$(docker exec "$container" cat /tmp/nginx.pid | tr -d '[:space:]')"
  started_after="$(docker inspect -f '{{.State.StartedAt}}' "$container")"
  restarts_after="$(docker inspect -f '{{.RestartCount}}' "$container")"

  if [ "$flipped" -ne 1 ]; then
    fail "$case_name: still not id=Y within ${DNS_FLIP_SECONDS}s (last: $last, DNS queries ${q0}->${q1})"
  elif ! wait_log "$UPSTREAM_Y" "token=$flip_token "; then
    fail "$case_name: upstream Y did not log the flip token within ${LOG_SECONDS}s"
  elif ! seen_x="$(upstream_log_line "$UPSTREAM_X" "$flip_token")"; then
    fail "$case_name: could not read the log of upstream X"
  elif [ -n "$seen_x" ]; then
    fail "$case_name: upstream X logged the flip token; the request did not follow the record"
  elif [ "${q1:-0}" -le "${q0:-0}" ]; then
    fail "$case_name: the proxy's DNS query count did not grow after the switch (${q0}->${q1})"
  elif [ "$pid_before" != "$pid_after" ]; then
    fail "$case_name: the NGINX master pid changed ($pid_before -> $pid_after)"
  elif [ "$started_before" != "$started_after" ] || [ "$restarts_before" != "$restarts_after" ]; then
    fail "$case_name: the container restarted (startedAt $started_before -> $started_after, restarts $restarts_before -> $restarts_after)"
  else
    echo "PASS: $case_name -> id=Y after the A record change, DNS queries ${q0}->${q1}, master pid $pid_after unchanged"
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
}

dns_query_seen() {
  local count
  count="$(dns_query_count "$1" "$2")" || return 1
  [ "${count:-0}" -ge 1 ]
}

# ─── H8: a query placeholder resolved only inside the container ──────────────

expect_query_accept() {
  local case_name="query-accept" container="$NAME-proxy-query-accept" template="$WORK/templates/query-accept/default.conf.template"
  local token="tok-$case_name-$RUN_ID" code line
  cases=$((cases + 1))

  # shellcheck disable=SC2016  # literal envsubst placeholder expected in the template.
  if [ "$(grep -cF 'proxy_pass https://remote_upstream/mcp?apikey=${UPSTREAM_QUERY_KEY};' "$template" || true)" != "1" ]; then
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
  note_no_live "$container"
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
  local case_name="redact" container="$NAME-proxy-redact" group="$NAME-proxy-redact-group" raw="$NAME-proxy-redact-raw"
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

  # req2: an unresolvable upstream has no live peer, so nginx logs the field
  # with the upstream group name instead of a peer address (the form the
  # production NXDOMAIN case produces, design evidence d2).
  start_proxy redact-group redact-group yes "$REDACT_FILTER" -e "UPSTREAM_QUERY_KEY=$QUERY_MARKER"
  code="$(proxy_request "$group" "tok-$case_name-group-$RUN_ID")"
  if [ "$code" != "502" ]; then
    fail "$case_name: req2 expected 502, got $code"
  elif ! wait_log "$group" "no live upstreams"; then
    fail "$case_name: req2 produced no 'no live upstreams' within ${LOG_SECONDS}s: $(container_log "$group" | tail -n 5)"
  elif [ "$(container_stderr "$group" | grep -cF 'upstream: "https://remote_upstream/mcp?REDACTED"' || true)" -lt 1 ]; then
    fail "$case_name: req2's line is not 'upstream: \"https://remote_upstream/mcp?REDACTED\"': $(container_stderr "$group" | grep -F 'upstream: "' | tail -n 3)"
  else
    echo "PASS: $case_name req2 -> group-name form redacted to https://remote_upstream/mcp?REDACTED"
  fi

  # req3: a client query long enough that nginx truncates the 2047-byte error
  # line inside the credential, where there is no closing quote to anchor on.
  line="$(container_stderr "$group" | grep -F 'upstream: "' | tail -n 1)"
  offset="$(upstream_field_query_offset "$line")"
  if [ -z "$offset" ]; then
    fail "$case_name: could not locate the upstream field in req2's line: $line"
  else
    # 2000 keeps the cut well inside the marker (the marker starts at
    # offset + 8 and the cap lands ~40 bytes later), whatever the pid and
    # connection-number widths do to the prefix.
    n=$((2000 - offset))
    if [ "$n" -lt 200 ]; then
      fail "$case_name: computed a negative truncation query length ($n) from offset $offset"
    else
      q="$(head -c "$n" /dev/zero | tr '\0' 'a')"
      lines="$(container_stderr "$group" | grep -cF 'upstream: "' || true)"
      code="$(proxy_request "$group" "tok-$case_name-trunc-$RUN_ID" "/mcp?$q")"
      if ! wait_until "req3's truncated error line" "$LOG_SECONDS" upstream_lines_grew "$group" "$lines"; then
        fail "$case_name: req3 logged no new upstream line within ${LOG_SECONDS}s"
      else
        line="$(container_stderr "$group" | grep -F 'upstream: "' | tail -n 1)"
        if [ "$code" != "502" ]; then
          fail "$case_name: req3 expected 502, got $code"
        elif ! printf '%s' "$line" | grep -qE 'upstream: "https://remote_upstream/mcp\?REDACTED$'; then
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
  start_proxy redact-raw redact-group yes off -e "UPSTREAM_QUERY_KEY=$QUERY_MARKER"
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
      elif ! printf '%s' "$line" | grep -qF "upstream: \"https://remote_upstream/mcp?apikey=$marker_prefix"; then
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

  # req4: the upstream answers with a second Content-Length whose value is
  # `upstream: "a", host: "b`. NGINX quotes that raw value in the message text
  # ahead of the real field, so the line holds a fake field and a fake host
  # delimiter before the real one. The substituted value also holds a raw
  # quote, which must not end the redaction early. Two markers, one on each
  # side of that quote.
  local shadow_head shadow_tail
  shadow_head="sq1-$RUN_ID-$(openssl rand -hex 16)"
  shadow_tail="sq2-$(openssl rand -hex 16)"
  start_proxy redact-shadow redact-shadow yes "$REDACT_FILTER" -e "UPSTREAM_QUERY_KEY=$shadow_head\"$shadow_tail"
  code="$(proxy_request "$shadow" "tok-$case_name-shadow-$RUN_ID" /shadow)"
  if [ "$code" != "502" ]; then
    fail "$case_name: req4 expected 502, got $code"
  elif ! wait_log "$shadow" 'upstream sent duplicate header line: "Content-Length: upstream: "a", host: "b"'; then
    fail "$case_name: req4 produced no duplicate-header line quoting the fake field within ${LOG_SECONDS}s: $(container_log "$shadow" | tail -n 3)"
  elif ! log="$(container_log "$shadow")"; then
    fail "$case_name: could not read the req4 log"
  elif printf '%s\n' "$log" | grep -qF -e "$shadow_head" -e "$shadow_tail"; then
    fail "$case_name: req4 leaked the value on one side of its quote"
  elif ! printf '%s\n' "$log" | grep -F 'duplicate header line' |
    grep -qE 'upstream: "https://[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:8441/shadow\?REDACTED", host: "'; then
    fail "$case_name: req4's real field is not 'https://<ipv4>:8441/shadow?REDACTED': $(printf '%s\n' "$log" | grep -F 'duplicate header line' | tail -n 1)"
  else
    echo "PASS: $case_name req4 -> the real field is redacted behind a fake field and a quote in the value"
  fi

  # Global negatives, after the positives, on every filtered container. Each
  # log is read once and its read status checked, so an unreadable log can
  # never count as "marker absent".
  local scanned=0 redacted_total=0
  for c in "$container" "$group" "$shadow"; do
    if ! log="$(container_log "$c")"; then
      fail "$case_name: could not read the log of $c for the marker scan"
      continue
    fi
    scanned=$((scanned + $(printf '%s\n' "$log" | grep -cF -e "$QUERY_MARKER" -e "$marker_prefix" || true)))
  done
  if [ "$scanned" -ne 0 ]; then
    fail "$case_name: the marker (or its first 8 characters) appears on $scanned line(s) of the filtered logs"
  fi
  for c in "$container" "$group"; do
    if ! log="$(container_stderr "$c")"; then
      fail "$case_name: could not read the stderr log of $c"
      continue
    fi
    redacted_total=$((redacted_total + $(printf '%s\n' "$log" | grep -cF '?REDACTED' || true)))
  done
  if [ "$redacted_total" -lt 3 ]; then
    fail "$case_name: only ${redacted_total} '?REDACTED' occurrence(s) across req1/req2/req3"
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
  docker rm -f "$container" "$group" "$raw" "$shadow" >/dev/null 2>&1 || true
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

  start_proxy filter-death redact-group yes "$REDACT_FILTER" -e "UPSTREAM_QUERY_KEY=$QUERY_MARKER"

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
  if [ "$code" != "502" ] || ! wait_log "$container" 'upstream: "https://remote_upstream/mcp?REDACTED"'; then
    fail "$case_name: no filtered upstream line before the kill (http $code)"
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
    -e "$PROXY_ENV_ENTRY" \
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

# ─── Cases ───────────────────────────────────────────────────────────────────

QUERY_MARKER="qk-$RUN_ID-$(openssl rand -hex 32)"
echo "query marker: ${QUERY_MARKER:0:8}... (${#QUERY_MARKER} bytes)"

expect_accept valid
expect_accept chain2
expect_reject untrusted yes "(21:unable to verify the first certificate)"
expect_reject expired yes "(10:certificate has expired)"
expect_reject wrongsan yes 'upstream SSL certificate does not match "upstream.test"'
expect_reject nobundle no "(21:unable to verify the first certificate)"
expect_dns_switch
expect_query_accept
expect_redact
expect_signals
expect_filter_death
expect_value_reject

echo "cases=$cases failures=$failures startup_no_live_upstreams=$startup_no_live"
if [ "$cases" -ne "$EXPECTED_CASES" ]; then
  echo "FAIL: ran $cases cases, expected $EXPECTED_CASES" >&2
  exit 1
fi
if [ "$failures" -ne 0 ]; then
  exit 1
fi
echo "OK -- nginx egress proxy TLS, DNS and redaction contract ($cases cases)"
