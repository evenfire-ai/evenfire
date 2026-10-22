#!/usr/bin/env bash
# Runtime TLS contract for the remote MCP egress proxy.
#
# Builds nginx-egress-proxy/Dockerfile, renders the per-server
# default.conf.template with the real HCC McpServerReconciler, and starts the
# image through its own entrypoint (so the /etc/nginx/templates envsubst step
# runs) as uid/gid 101 with every capability dropped, as HCC deploys it. A local
# TLS upstream presents one certificate per port:
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
# Requires docker, curl, openssl, node and `npm ci` in host-context-controller.
# NGINX_TLS_TEST_MUTATION=verify-off|depth-1 rewrites the rendered template to
# check that the cases detect a disabled verification or a lower depth; a
# mutated run is expected to fail.
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
  "" | verify-off | depth-1) ;;
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

# ─── Images ──────────────────────────────────────────────────────────────────

BASE_IMAGE="$(sed -n 's/^FROM[[:space:]]\{1,\}\([^[:space:]]*\).*/\1/p' "$DOCKERFILE_DIR/Dockerfile")"
[ -n "$BASE_IMAGE" ] || { echo "FAIL: no FROM line in $DOCKERFILE_DIR/Dockerfile" >&2; exit 1; }
docker build -q -t "$PROXY_IMAGE" "$DOCKERFILE_DIR" >/dev/null
echo "arch: $(docker version --format '{{.Server.Arch}}')"
echo "base image: $BASE_IMAGE"
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
  echo "log_format tlstest 'TLSTEST port=\$server_port uri=\$request_uri token=\$http_x_test_token sni=\$ssl_server_name auth=\"\$http_authorization\"';"
  for cert in valid chain2 untrusted expired wrongsan; do
    cat <<EOF
server {
    listen $(port_of "$cert") ssl;
    server_name upstream.test;
    ssl_certificate /fixtures/$cert.chain.pem;
    ssl_certificate_key /fixtures/$cert.key;
    access_log /var/log/nginx/access.log tlstest;
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
  "$BASE_IMAGE" >/dev/null

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

wait_for() {
  local what="$1" container="$2"
  shift 2
  local _
  for _ in $(seq 1 60); do
    if [ "$("$@" 2>/dev/null || true)" = "200" ]; then
      return 0
    fi
    sleep 0.5
  done
  echo "FAIL: $what did not become ready within 30s" >&2
  docker logs "$container" >&2 2>&1 || true
  exit 1
}

for cert in valid chain2 untrusted expired wrongsan; do
  wait_for "upstream port $(port_of "$cert")" "$UPSTREAM" upstream_handshake "$(port_of "$cert")" "ready-$cert"
done

# ─── Rendered proxy template ─────────────────────────────────────────────────

AUTH_SECRET="secret-$RUN_ID"
mkdir -p "$WORK/templates"
(
  cd "$HCC_DIR"
  # shellcheck disable=SC2016 # TypeScript source; ${...} is a JS template literal.
  TEMPLATE_DIR="$WORK/templates" node node_modules/ts-node/dist/bin.js --transpile-only -e '
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
for (const port of [8441, 8442, 8443, 8444, 8445]) {
  const cm = (reconciler as any).buildNginxConfigMap({
    name: `tls-test-${port}`,
    namespace: "mcp-server",
    spec: {
      contextRef: "tls-test",
      image: "clerum/nginx-egress-proxy:0.1.0",
      transport: { type: "streamableHttp", port: 3000 },
      managed: true,
      enabled: true,
      remote: {
        baseUrl: `https://upstream.test:${port}/mcp`,
        authHeaders: [{ header: "Authorization", valueTemplate: "Bearer ${UPSTREAM_TOKEN}" }],
      },
    },
  })
  const dir = path.join(process.env.TEMPLATE_DIR as string, String(port))
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "default.conf.template"), cm.data["default.conf.template"])
}
'
)

mutate() {
  local file="$1" from="$2" to="$3" count
  count="$(grep -cF -- "$from" "$file" || true)"
  if [ "$count" != "1" ]; then
    echo "FAIL: mutation expected one '$from' in $file, found $count" >&2
    exit 1
  fi
  sed "s/$from/$to/" "$file" >"$file.new" && mv "$file.new" "$file"
}

for port in 8441 8442 8443 8444 8445; do
  t="$WORK/templates/$port/default.conf.template"
  grep -q "proxy_pass https://upstream.test:$port/mcp;" "$t" || { echo "FAIL: rendered template for $port has no proxy_pass" >&2; exit 1; }
  case "$MUTATION" in
    verify-off) mutate "$t" "proxy_ssl_verify on;" "proxy_ssl_verify off;" ;;
    depth-1) mutate "$t" "proxy_ssl_verify_depth 3;" "proxy_ssl_verify_depth 1;" ;;
  esac
  chmod 755 "$WORK/templates/$port"
  chmod 644 "$t"
done
[ -n "$MUTATION" ] && echo "mutation: $MUTATION"

# ─── Cases ───────────────────────────────────────────────────────────────────

start_proxy() {
  local case_name="$1" port="$2" mount_ca="$3" container="$NAME-proxy-$1"
  local args=(
    -d --name "$container" --network "$NETWORK"
    --user 101:101 --cap-drop ALL --security-opt no-new-privileges
    -e "UPSTREAM_TOKEN=$AUTH_SECRET"
    -v "$WORK/templates/$port:/etc/nginx/templates:ro"
    -p 127.0.0.1::3000
  )
  if [ "$mount_ca" = "yes" ]; then
    args+=(-v "$WORK/trust-ca-a.pem:/etc/ssl/certs/ca-certificates.crt:ro")
  fi
  docker run "${args[@]}" "$PROXY_IMAGE" >/dev/null
  wait_for "proxy for $case_name" "$container" \
    curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$(host_port "$container" 3000)/health"
}

proxy_request() {
  local container="$1" token="$2"
  curl -s -o "$WORK/body" -w '%{http_code}' --max-time 15 -H "X-Test-Token: $token" \
    "http://127.0.0.1:$(host_port "$container" 3000)/mcp"
}

upstream_log_line() {
  docker logs "$UPSTREAM" 2>&1 | grep -F "token=$1 " || true
}

expect_accept() {
  local case_name="$1" port container token code line
  port="$(port_of "$case_name")"
  container="$NAME-proxy-$case_name"
  token="tok-$case_name-$RUN_ID"
  cases=$((cases + 1))
  start_proxy "$case_name" "$port" yes
  code="$(proxy_request "$container" "$token")"
  line="$(upstream_log_line "$token")"
  if [ "$code" != "200" ]; then
    fail "$case_name: expected 200, got $code; proxy log: $(docker logs "$container" 2>&1 | tail -n 5)"
  elif ! grep -qF "echo token=$token" "$WORK/body"; then
    fail "$case_name: response body does not carry the token: $(cat "$WORK/body")"
  elif [ -z "$line" ]; then
    fail "$case_name: upstream never logged token $token"
  elif ! printf '%s' "$line" | grep -qF "port=$port uri=/mcp token=$token sni=upstream.test auth=\"Bearer $AUTH_SECRET\""; then
    fail "$case_name: upstream saw the wrong port, path, SNI or Authorization: $line"
  else
    echo "PASS: $case_name -> 200, token, path, SNI and envsubst Authorization reached port $port"
  fi
  docker rm -f "$container" >/dev/null
}

expect_reject() {
  local case_name="$1" mount_ca="$2" reason="$3" port container token code live
  port="$(port_of "$case_name")"
  container="$NAME-proxy-$case_name"
  token="tok-$case_name-$RUN_ID"
  cases=$((cases + 1))
  live="$(upstream_handshake "$port" "live-$case_name-$RUN_ID")"
  if [ "$live" != "200" ]; then
    fail "$case_name: direct handshake to upstream port $port returned $live"
    return
  fi
  start_proxy "$case_name" "$port" "$mount_ca"
  code="$(proxy_request "$container" "$token")"
  if [ "$code" != "502" ]; then
    fail "$case_name: expected 502, got $code"
  elif ! docker logs "$container" 2>&1 | grep -qF -- "$reason"; then
    fail "$case_name: proxy log has no '$reason': $(docker logs "$container" 2>&1 | tail -n 5)"
  elif [ -n "$(upstream_log_line "$token")" ]; then
    fail "$case_name: request token reached the upstream"
  else
    echo "PASS: $case_name -> 502 ($reason), upstream live, token not forwarded"
  fi
  docker rm -f "$container" >/dev/null
}

expect_accept valid
expect_accept chain2
expect_reject untrusted yes "(21:unable to verify the first certificate)"
expect_reject expired yes "(10:certificate has expired)"
expect_reject wrongsan yes 'upstream SSL certificate does not match "upstream.test"'
expect_reject nobundle no "(21:unable to verify the first certificate)"

echo "cases=$cases failures=$failures"
if [ "$cases" -eq 0 ]; then
  echo "FAIL: no cases ran" >&2
  exit 1
fi
if [ "$failures" -ne 0 ]; then
  exit 1
fi
echo "OK -- nginx egress proxy TLS contract ($cases cases)"
