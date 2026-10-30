#!/usr/bin/env bash
# Runtime TLS and DNS re-resolution contract for the remote MCP egress proxy.
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
# Cases (8, the run fails unless exactly this many ran):
#
#   valid, chain2, untrusted, expired, wrongsan, nobundle   TLS contract
#   dns-switch     the upstream's A record moves to another container while the
#                  same NGINX master keeps serving (resolver + `resolve`, TTL 1s)
#   query-accept   a ${NAME} query placeholder declared by the CRD is resolved by
#                  envsubst inside the container and reaches the upstream
#
# Requires docker, curl, openssl, node and `npm ci` in host-context-controller.
#
# NGINX_TLS_TEST_MUTATION=<mode> rewrites the rendered template to prove the
# cases detect a broken build. A mutated run is expected to fail:
#
#   verify-off            proxy_ssl_verify off               -> untrusted, expired, wrongsan, nobundle red
#   depth-1               proxy_ssl_verify_depth 1           -> chain2 red
#   no-resolve            drops ` resolve` (dns-switch only) -> dns-switch red
#   no-ssl-name           drops proxy_ssl_name               -> valid, chain2, wrongsan red

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
EXPECTED_CASES=8
# Pinned by multi-arch index digest: the CI matrix runs this harness on amd64
# and arm64, and a tag alone would let the two runs use different CoreDNS
# builds. registry.k8s.io is used instead of Docker Hub so this image does not
# need the mirror mapping the nginx base image uses.
COREDNS_IMAGE="registry.k8s.io/coredns/coredns:v1.12.1@sha256:e8c262566636e6bc340ece6473b0eed193cad045384401529721ddbe6463d31c"
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
  "" | verify-off | depth-1 | no-resolve | no-ssl-name) ;;
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
# $WORK (a rendered template). Any other count
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
    PROXY_ENV_FILE="$WORK/proxy-env-entry" \
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
const renderServer = (dir: string, crd: any) => {
  const cm = (reconciler as any).buildNginxConfigMap(crd)
  const out = path.join(templateDir, dir)
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, "default.conf.template"), cm.data["default.conf.template"])
}
const render = (dir: string, baseUrl: string) => renderServer(dir, server(baseUrl))
for (const port of [8441, 8442, 8443, 8444, 8445]) {
  render(String(port), "https://upstream.test:" + port + "/mcp")
}
render("dns-switch", "https://upstream.test:8446/mcp")
// H8: the placeholder must be declared by the CRD (the reconciler rejects an
// undeclared one); the value itself is supplied to docker run. The literal
// placeholder stays in the ConfigMap for the image entrypoint to resolve.
const queryServer = server("https://upstream.test:8441/mcp?apikey=${UPSTREAM_QUERY_KEY}")
queryServer.spec.env = [{ name: "UPSTREAM_QUERY_KEY", value: "render-only" }]
renderServer("query-accept", queryServer)

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
echo "proxy env: $PROXY_ENV_ENTRY"

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
# shellcheck disable=SC2016  # literal envsubst placeholder expected in the template.
assert_count "$WORK/templates/dns-switch/default.conf.template" 'resolver ${NGINX_LOCAL_RESOLVERS} ipv6=off;' 1

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

for dir in "$WORK"/templates/*; do
  chmod 755 "$dir"
  chmod 644 "$dir/default.conf.template"
done
[ -n "$MUTATION" ] && echo "mutation: $MUTATION"

# ─── Proxy lifecycle ─────────────────────────────────────────────────────────

# start_proxy <case> <template-dir> <mount-ca yes|no> [extra docker flags...]
start_proxy() {
  local case_name="$1" template="$2" mount_ca="$3"
  shift 3
  local container="$NAME-proxy-$case_name"
  local args=(
    -d --name "$container" --network "$NETWORK"
    "${PROXY_SECURITY_ARGS[@]}"
    -e "$PROXY_ENV_ENTRY"
    -e "UPSTREAM_TOKEN=$AUTH_SECRET"
    -v "$WORK/templates/$template:/etc/nginx/templates:ro"
    -p 127.0.0.1::3000
  )
  if [ "$mount_ca" = "yes" ]; then
    args+=(-v "$WORK/trust-ca-a.pem:/etc/ssl/certs/ca-certificates.crt:ro")
  fi
  args+=("$@")
  docker run "${args[@]}" "$PROXY_IMAGE" >/dev/null
  wait_for "proxy for $case_name" "$container" proxy_health "$container"
  check_proxy_process "$case_name" "$container"
}

proxy_health() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$(host_port "$1" 3000)/health"
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
  start_proxy "$case_name" "$port" yes
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

  start_proxy "$case_name" dns-switch yes -v "$WORK/dns-resolv.conf:/etc/resolv.conf:ro"
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
  start_proxy "$case_name" query-accept yes -e "UPSTREAM_QUERY_KEY=$QUERY_MARKER"
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

echo "cases=$cases failures=$failures startup_no_live_upstreams=$startup_no_live"
if [ "$cases" -ne "$EXPECTED_CASES" ]; then
  echo "FAIL: ran $cases cases, expected $EXPECTED_CASES" >&2
  exit 1
fi
if [ "$failures" -ne 0 ]; then
  exit 1
fi
echo "OK -- nginx egress proxy TLS and DNS contract ($cases cases)"
