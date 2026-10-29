#!/usr/bin/env bash
# Runtime TLS contract for the remote MCP egress proxy.
#
# Builds nginx-egress-proxy/Dockerfile, renders the per-server
# default.conf.template with the real HCC McpServerReconciler, and starts the
# image through its own entrypoint (so the /etc/nginx/templates envsubst step
# runs) with the docker equivalent of the securityContext HCC generates for the
# egress-proxy container (user, dropped capabilities, no_new_privs, the default
# seccomp profile), checked on the running process. A local TLS upstream
# presents one certificate per port:
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
# With NGINX_REGISTRY_MIRROR set (CI uses mirror.gcr.io), the Docker Hub base is
# pulled from the mirror by digest, for the build and for the upstream. The
# build log must name the mirror reference: a --build-context key that does not
# match the FROM line is ignored by BuildKit, which then pulls Docker Hub.
UPSTREAM_IMAGE="$BASE_IMAGE"
MIRROR="${NGINX_REGISTRY_MIRROR:-}"
if [ -n "$MIRROR" ]; then
  case "$BASE_IMAGE" in
    nginx:*@sha256:*) ;;
    *) echo "FAIL: NGINX_REGISTRY_MIRROR is set, but FROM '$BASE_IMAGE' is not a Docker Hub nginx:<tag>@<digest>" >&2; exit 1 ;;
  esac
  UPSTREAM_IMAGE="$MIRROR/library/nginx@${BASE_IMAGE#*@}"
  BUILD_LOG="$WORK/build.log"
  if ! docker buildx build --progress=plain --load --build-context "$BASE_IMAGE=docker-image://$UPSTREAM_IMAGE" \
    -t "$PROXY_IMAGE" "$DOCKERFILE_DIR" >"$BUILD_LOG" 2>&1; then
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
  docker build -q -t "$PROXY_IMAGE" "$DOCKERFILE_DIR" >/dev/null
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

for cert in valid chain2 untrusted expired wrongsan; do
  wait_for "upstream port $(port_of "$cert")" "$UPSTREAM" upstream_handshake "$(port_of "$cert")" "ready-$cert"
done

# ─── Rendered proxy template ─────────────────────────────────────────────────

AUTH_SECRET="secret-$RUN_ID"
mkdir -p "$WORK/templates"
(
  cd "$HCC_DIR"
  # shellcheck disable=SC2016 # TypeScript source; ${...} is a JS template literal.
  TEMPLATE_DIR="$WORK/templates" SECURITY_ARGS="$WORK/proxy-security-args" \
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
const server = (port: number) => ({
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
for (const port of [8441, 8442, 8443, 8444, 8445]) {
  const cm = (reconciler as any).buildNginxConfigMap(server(port))
  const dir = path.join(process.env.TEMPLATE_DIR as string, String(port))
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "default.conf.template"), cm.data["default.conf.template"])
}

// The proxy runs with the securityContext HCC generates for the egress-proxy
// container. Each field maps to one docker flag; a field this test does not
// map, or a value other than the mapped one, stops the test so the mapping is
// updated together with the reconciler.
const deployment = (reconciler as any).buildDeployment(server(8441))
const proxies = deployment.spec.template.spec.containers.filter((c: any) => c.name === "egress-proxy")
if (proxies.length !== 1) throw new Error(`expected one egress-proxy container, found ${proxies.length}`)
const sc = proxies[0].securityContext ?? {}
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
    "${PROXY_SECURITY_ARGS[@]}"
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
  check_proxy_process "$case_name" "$container"
}

# The NGINX master (PID 1) must run with the generated identity, an empty
# capability bounding set (a non-root process has no effective capabilities
# even without --cap-drop, so CapEff alone would not show the drop),
# no_new_privs and a seccomp filter (mode 2).
check_proxy_process() {
  local case_name="$1" container="$2" status uid="${PROXY_UID_GID%%:*}" gid="${PROXY_UID_GID##*:}" want t=$'\t' missing=0
  status="$(docker exec "$container" cat /proc/1/status)"
  for want in "Uid:$t$uid$t$uid$t$uid$t$uid" "Gid:$t$gid$t$gid$t$gid$t$gid" \
    "CapEff:${t}0000000000000000" "CapBnd:${t}0000000000000000" "NoNewPrivs:${t}1" "Seccomp:${t}2"; do
    if ! grep -qxF -- "$want" <<<"$status"; then
      echo "FAIL: proxy for $case_name: /proc/1/status has no line '$want'" >&2
      missing=1
    fi
  done
  if [ "$missing" -ne 0 ]; then
    grep -E '^(Uid|Gid|CapEff|CapBnd|NoNewPrivs|Seccomp):' <<<"$status" >&2
    exit 1
  fi
}

proxy_request() {
  local container="$1" token="$2"
  curl -s -o "$WORK/body" -w '%{http_code}' --max-time 15 -H "X-Test-Token: $token" \
    "http://127.0.0.1:$(host_port "$container" 3000)/mcp"
}

# Prints the upstream log lines for a token (empty when none). Returns 2 when
# the upstream log cannot be read.
upstream_log_line() {
  local log
  log="$(container_log "$UPSTREAM")" || return 2
  printf '%s\n' "$log" | grep -F "token=$1 " || true
}

expect_accept() {
  local case_name="$1" port container token code line
  port="$(port_of "$case_name")"
  container="$NAME-proxy-$case_name"
  token="tok-$case_name-$RUN_ID"
  cases=$((cases + 1))
  start_proxy "$case_name" "$port" yes
  code="$(proxy_request "$container" "$token")"
  if [ "$code" != "200" ]; then
    fail "$case_name: expected 200, got $code; proxy log: $(container_log "$container" | tail -n 5)"
  elif ! grep -qF "echo token=$token" "$WORK/body"; then
    fail "$case_name: response body does not carry the token: $(cat "$WORK/body")"
  elif ! wait_log "$UPSTREAM" "token=$token "; then
    fail "$case_name: upstream did not log token $token within ${LOG_SECONDS}s"
  elif ! line="$(upstream_log_line "$token")"; then
    fail "$case_name: could not read the upstream log"
  elif ! printf '%s' "$line" | grep -qF "port=$port uri=/mcp token=$token sni=upstream.test auth=\"Bearer $AUTH_SECRET\""; then
    fail "$case_name: upstream saw the wrong port, path, SNI or Authorization: $line"
  else
    echo "PASS: $case_name -> 200, token, path, SNI and envsubst Authorization reached port $port"
  fi
  docker rm -f "$container" >/dev/null
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
  start_proxy "$case_name" "$port" "$mount_ca"
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
  elif ! seen="$(upstream_log_line "$token")"; then
    fail "$case_name: could not read the upstream log"
  elif [ -n "$seen" ]; then
    fail "$case_name: request token reached the upstream: $seen"
  else
    echo "PASS: $case_name -> 502 ($reason), upstream live and logging, token not forwarded"
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
