# nginx-egress-proxy

Hardened nginx image that serves as the pinned egress path for **remote** MCP
servers (McpServer CRDs with `spec.remote.baseUrl`).

**This directory contains only a Dockerfile — there is no application code
here.** All proxy logic (config generation, URL/header sanitization, deployment)
lives in [host-context-controller](../host-context-controller/) (`src/reconciler.ts`).

## The image

- Base: the official `nginx:<x.y.z>-alpine` image named by the `FROM` line of
  the [Dockerfile](./Dockerfile), pinned by multi-arch index digest. It is kept
  because its entrypoint runs `envsubst` on `/etc/nginx/templates/*.template`
  at startup, which HCC relies on for credential injection. The minimum NGINX
  release per line, and the CVEs behind it, are in
  [scripts/nginx-image-policy.sh](../scripts/nginx-image-policy.sh);
  `scripts/validate-nginx-images.sh` rejects older platform references.
- Hardened to run as non-root (`USER 101:101`): the `user` directive is removed
  from `nginx.conf`, the PID file moves to `/tmp/nginx.pid`, the shipped
  `default.conf` is removed, and nginx dirs plus `/tmp` temp dirs are chowned
  to `101:101`.

## How it works

For each remote McpServer, host-context-controller:

1. **Validates and sanitizes `spec.remote.baseUrl`** (`sanitizeRemoteUrl`):
   HTTPS only; DNS hostnames only (IPv4/IPv6 literals rejected); internal
   cluster hosts (`*.svc`, `*.svc.cluster.local`, `kubernetes.default`) and
   private/link-local/loopback patterns rejected; the URL is reconstructed from
   parsed components so injected characters (e.g. newlines) are stripped.
   Query placeholders must be complete `${NAME}` values where `NAME` matches
   `[A-Z_][A-Z0-9_]*` and is declared by `spec.env` or `spec.envSecret`. The
   URL parser runs first: it strips TAB/CR/LF and percent-encodes spaces and
   other control characters, which are then accepted in encoded form. The query
   check then rejects any `$`, brace, backslash or semicolon outside a complete
   placeholder, and undeclared names. The path takes no placeholders; the
   parser also percent-encodes braces in the path and turns `\` into `/`, so the
   path check rejects `$` and `;`. Both are rendered into the NGINX template
   unquoted.
2. **Renders a per-server `default.conf.template` ConfigMap** that resolves and
   re-resolves the external base URL with NGINX. The resolver comes from the
   pod's `/etc/resolv.conf`, and the upstream `server ... resolve` directive
   follows DNS TTL changes without restarting NGINX or opening an upstream
   keepalive pool. TLS to the upstream remains mandatory (`proxy_ssl_verify on`,
   SNI, system CA bundle), along with SSE-friendly settings (buffering/cache
   off, long read timeouts) and a local `/health` endpoint.
3. **Sanitizes each `spec.remote.authHeaders` entry** (`sanitizeAuthHeader`):
   header names restricted to `[A-Za-z0-9-]`, values capped at 2048 chars,
   CR/LF/NUL rejected (HTTP request smuggling / nginx directive-injection
   defense), backslashes and quotes escaped for nginx's quoted-string context.
4. **Deploys this image as the only container** (`egress-proxy`) of the
   per-server Deployment. The ConfigMap mounts at `/etc/nginx/templates`, so
   `envsubst` resolves `${VAR}` placeholders in auth headers and in the baseUrl
   query at pod start from env vars sourced from `spec.env` and
   `spec.envSecret`. With placeholders, credentials never appear in the
   ConfigMap itself. A literal value inlined in the CRD would be emitted
   (escaped) into the ConfigMap — always use placeholders.

HCC appends `NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1` and an empty
`NGINX_ENVSUBST_FILTER` after CRD-provided env and `spec.envSecret` entries.
Kubernetes uses the last duplicate, so a CRD cannot disable the platform
resolver setting or restrict which declared names `envsubst` substitutes. The
image exports the pod's local nameservers into `NGINX_LOCAL_RESOLVERS`, which
the generated `resolver` directive uses.

Residuals:

- Declared values are substituted literally by `envsubst`; HCC validates
  placeholder names, not values. In the unquoted `baseUrl` query a value
  containing `;` or a newline adds whole NGINX directives; in a double-quoted
  `authHeaders` value a `"` or a `\` breaks out of the string with the same
  effect. In both, a value containing `$name` is expanded by NGINX, so a client
  header can reach the upstream URL, an added header or the error log. Only an
  admin who can write the Secret or the CRD env can set such a value, and the
  same actor can already do it on `dev` through `authHeaders`. A
  container-start template value check closes it; that layer is tracked with
  #1240.
- A literal credential written into `baseUrl` instead of a placeholder is still
  stored in the ConfigMap. Use placeholders.

## Configuration

The image takes no configuration of its own; env vars are injected per-server
by HCC from the McpServer CRD (`spec.env`, `spec.envSecret`). The image
reference is platform-controlled:

| Setting                                     | Component                                                             | Default                           |
| ------------------------------------------- | --------------------------------------------------------------------- | --------------------------------- |
| `CONTEXT_MAPPER_EGRESS_PROXY_IMAGE`         | host-context-controller                                               | `clerum/nginx-egress-proxy:0.1.0` |
| `CONTROL_API_REMOTE_MCP_EGRESS_PROXY_IMAGE` | control-api (registry install stamps `spec.image` for remote entries) | `clerum/nginx-egress-proxy:0.1.0` |

HCC does not rewrite `spec.image` during reconciliation: that field remains
desired state owned by the CRD author. Deployment rendering always stamps the
configured platform image for remote egress proxies, so a remote CRD's
`spec.image` is never what runs.

HCC and this image must be upgraded together. The HCC template needs
`server ... resolve` (NGINX ≥ 1.27.3) and the base image's
`15-local-resolvers.envsh`, both provided by the pinned base. An older image is
expected to fail visibly rather than silently fall back.

## Ports

The image `EXPOSE`s **3000**. The actual `listen` port in the generated config
comes from `spec.transport.port` (default 3000); `/health` answers on it.

## Security

- Deployed as the workload's only container on the remote path: `runAsNonRoot` as `101:101`,
  all capabilities dropped, `allowPrivilegeEscalation: false`, seccomp
  `RuntimeDefault`, `automountServiceAccountToken: false` at the pod level.
- Proxy is pinned to exactly one sanitized external base URL over verified TLS.
- The broader egress-binding CIDR model (private, metadata, link-local,
  documentation, multicast, and reserved IPv4 ranges blocked) is validated in
  [control-ui/lib/egressModel.ts](../control-ui/lib/egressModel.ts).

## Testing

The generated config, sanitization rules, and deployment shape are asserted in
[host-context-controller/src/\_\_tests\_\_/reconciler.remote.test.ts](../host-context-controller/src/__tests__/reconciler.remote.test.ts).

[scripts/tests/test-nginx-egress-proxy-tls.sh](../scripts/tests/test-nginx-egress-proxy-tls.sh)
builds this image, renders the template through the HCC reconciler, and runs it
against a local TLS upstream: a trusted chain (direct and with two
intermediates) is accepted; an untrusted CA, an expired certificate, a hostname
mismatch, and the test CA without the mounted trust store are rejected.
The harness also covers the DNS switch (`H7 dns-switch`) and query placeholder
resolution (`H8 query-accept`).

The CDN answer-set rotation is proven end to end on a branch-owned minikube
profile by [scripts/e2e/e2e-egress-cdn-rotation.sh](../scripts/e2e/e2e-egress-cdn-rotation.sh);
see [docs/testing/egress-cdn-rotation.md](../docs/testing/egress-cdn-rotation.md)
for the operator steps and the test-only overrides it restores.

## Updating NGINX

A newer fixed release on an accepted line (for example 1.30.6 → 1.30.7):

1. Resolve the index digest of the new tag:
   `docker buildx imagetools inspect nginx:<x.y.z>-alpine` (the `Digest:` line).
2. Replace the old tag in the platform images: `FIXED_NGINX_IMAGE` in
   `scripts/validate-nginx-images.sh`, the Dockerfile `FROM` (tag and digest),
   the four gateway manifests under `deploy/base`,
   `scripts/minikube/build-images.sh` and `scripts/bootstrap-cluster.sh`.
3. Find the remaining references of both images:
   `git grep -nE '(nginx|nginx-unprivileged):<old>-alpine'`. These are the
   `nginxinc/nginx-unprivileged` recipe samples, the recipe guides, E2E scripts
   and specs, and unit tests. They stay valid at or above the floor, so moving
   them to the new release is optional; the validator does not require it.
4. Run `bash scripts/validate-nginx-images.sh`,
   `bash scripts/tests/test-validate-nginx-images.sh`,
   `bash scripts/tests/test-verify-nginx-image-digests.sh` and
   `bash scripts/verify-nginx-image-digests.sh`.

The guard tests and CI need no edits for such a bump: both tests read the
release from the validator and the Dockerfile. When a new CVE raises the
minimum, also edit `NGINX_RELEASE_FLOORS` and its CVE comment in
`scripts/nginx-image-policy.sh`, the floor cases in
`scripts/tests/test-validate-nginx-images.sh`, and every reference the
validator then reports as below the new floor, including the
`nginxinc/nginx-unprivileged` ones.

## Build & deploy

CI builds and publishes the image via
[.github/workflows/build-publish.yml](../.github/workflows/build-publish.yml)
(ghcr.io), tagged `sha-<short>`. The private infra repo then mirrors that tag
into the deploy-time GCP Artifact Registry. There are no static manifests for
this service: Deployments, ConfigMaps, and Services are created dynamically by
host-context-controller — see its [README](../host-context-controller/README.md).

<!-- auto-deploy proof: OSS dev → build → mirror → infra apply (2026-07-22) -->
