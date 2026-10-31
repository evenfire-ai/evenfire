# nginx-egress-proxy

Hardened nginx image that serves as the pinned egress path for **remote** MCP
servers (McpServer CRDs with `spec.remote.baseUrl`).

**This directory contains the Dockerfile and four small runtime scripts**
(`egress-proxy-entrypoint`, `egress-proxy-template-check`,
`egress-proxy-log-filter`, `egress-proxy-liveness`).
All proxy logic (config generation, URL/header sanitization, deployment) lives
in [host-context-controller](../host-context-controller/) (`src/reconciler.ts`).

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
   `[A-Z_][A-Z0-9_]*`; bare dollars, malformed braces, backslashes, and
   semicolons are rejected. The URL parser strips TAB/CR/LF and percent-encodes
   other control characters and spaces before that check. A placeholder name is
   set in the egress-proxy container env (`spec.env`, except the names HCC
   strips as forbidden; `spec.envSecret`; `envMapping`; or a placeholder of
   `spec.remote.authHeaders`); an undeclared name is rejected, because it would
   otherwise survive into the rendered config, where NGINX resolves it as one of
   its own variables. The path takes no placeholders and must not contain `$`
   (or the other characters the query check rejects: `\`, `;`, `{`, `}`,
   control characters and space), because it is rendered into the NGINX
   template unquoted. The value of a query placeholder must use only
   `[A-Za-z0-9._~-]` and complete `%XX` escapes; store any other character
   percent-encoded. The proxy never encodes a value, and an already
   percent-encoded value is passed through unchanged.
2. **Renders a per-server `default.conf.template` ConfigMap** pinning
   `proxy_pass` to that single external base URL, with TLS to the upstream
   (`proxy_ssl_verify on`, SNI, system CA bundle), SSE-friendly settings
   (buffering/cache off, long read timeouts), and a local `/health` endpoint.
3. **Sanitizes each `spec.remote.authHeaders` entry** (`sanitizeAuthHeader`):
   header names restricted to `[A-Za-z0-9-]`, values capped at 2048 chars,
   CR/LF/NUL rejected (HTTP request smuggling / nginx directive-injection
   defense), backslashes and quotes escaped for nginx's quoted-string context.
4. **Deploys this image as the only container** (`egress-proxy`) of the
   per-server Deployment. The ConfigMap mounts at `/etc/nginx/templates`, so
   `envsubst` resolves `${VAR}` placeholders in auth headers at pod start from
   env vars sourced from `spec.envSecret`. Query placeholders use the same
   runtime mechanism. With `${VAR}` placeholders, credentials never appear in
   the ConfigMap itself, and `spec.envSecret` keeps them out of the Deployment
   env too. A literal value inlined in the CRD would still be emitted (escaped)
   into the ConfigMap, and a literal `spec.env` value is visible in the
   Deployment env, so neither may carry a credential.

### Existing literal query credentials

This change does not migrate or reject a literal credential already written in
`spec.remote.baseUrl`. That value remains in the existing CRD and generated
ConfigMap until an operator replaces it. Complete the operational follow-up
before closing the underlying issue:

1. Inventory remote McpServer CRDs and their generated egress-proxy ConfigMaps
   for a URL query value that is not a complete `${NAME}` placeholder. Record
   the inventory outside public issue data; do not copy the URL or credential
   into an issue, PR, or log.
2. Rotate each affected provider key, because the old value may already have
   reached a ConfigMap or the NGINX error log.
3. Replace the literal query value with an uppercase `${NAME}` placeholder and
   provide the new value through `spec.envSecret`, not `spec.env`.
4. Apply the updated CRD, then verify that the generated ConfigMap contains the
   placeholder and that the egress proxy becomes ready.

HCC and this image must roll together in both directions. New HCC with an older
image fails the exec liveness probe and restarts visibly; rolling only the image
back removes the stderr filter while leaving the new probe. Preserve the previous
compatible HCC/image pair for rollback.

Before NGINX starts, `egress-proxy-entrypoint` runs `egress-proxy-template-check`
over the templates. envsubst substitutes every defined variable (`$NAME` and
`${NAME}`), so the check reads each reference to a defined variable, works out
where it sits the way NGINX's tokenizer does, and rejects a value that would
change the syntax there:

| Where the reference sits                               | Rejected in the value                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| inside `"..."` (auth headers)                          | control characters (TAB, CR, LF, …), `"`, `$`, `\`                               |
| inside an unquoted argument (the baseUrl query)        | anything outside `[A-Za-z0-9._~-]`, or a `%` that is not a complete `%XX` escape |
| argument start, inside `'...'`, a comment, after a `\` | any value                                                                        |

A rejected value stops the container before NGINX starts (CrashLoopBackOff,
readiness never passes). The log names the template file, the variable and the
context, never the value. This includes a credential pasted with a trailing
TAB or newline. Undefined variables are left untouched, as envsubst leaves them.
A `+` reaches a form-decoding upstream as a space, `&` starts a new parameter
and `#` ends the value, so such a value is refused instead of being sent as
something else.

HCC appends an empty `NGINX_ENVSUBST_FILTER` after CRD-provided env and
`spec.envSecret` entries. Kubernetes uses the last duplicate, so a CRD cannot
restrict which declared names `envsubst` substitutes.

NGINX's stderr (the error log) goes through `egress-proxy-log-filter`, which
applies two rules to every line:

1. **Upstream-quoted text.** NGINX quotes bytes the upstream sent in four
   messages: `upstream sent duplicate header line`,
   `upstream sent invalid "Content-Length" header`,
   `upstream sent unknown "Transfer-Encoding"` and
   `upstream sent invalid header`. Everything from the message's opening quote
   to the line's last `, client: ` becomes `REDACTED`; on a line cut at NGINX's
   2047-byte error cap, everything to the end of the line becomes `REDACTED`.
   A credential the proxy forwarded — a query value, an `authHeaders` value or
   the per-user OAuth Bearer — that the upstream echoes in a response header
   therefore never reaches the log.
2. **The upstream field.** The query of every `upstream: "..."` field becomes
   `?REDACTED`, as before; the scheme, peer and path stay.

Those upstream-quoted lines lose the header name, its value and the
`while …` action; a cut quoting line also loses its context fields. stdout (the
access log) is not filtered. An ordinary line costs about 0.4 ms of filter time
at the container's 100m CPU limit. A crafted line with about 200 forged
`, client: ` occurrences costs about 5 ms, and one upstream response can produce
up to about 190 cut lines, because every short duplicate of a long header
re-quotes the previous value. That fills the 64 KiB FIFO, so that upstream's own
proxy can block on error-log writes for about a second per response; no byte
leaks.

The generated template ignores the upstream's `X-Accel-Redirect` and
`X-Accel-Charset` (`proxy_ignore_headers`), whose values NGINX would otherwise
log in messages the filter does not cover. Clients see no header change: both
are already hidden from the response by NGINX's default proxy header list, so
only the internal redirect and the charset override stop.

The message list is audited against the NGINX release in the Dockerfile `FROM`.
The harness reads the release of the built image and fails on any other one,
with a message naming the list to re-audit, so an unaudited base bump turns the
`Egress proxy TLS` check red. That check is not a required status check, so the
red check is visible but does not block the merge (see "Updating NGINX").

Residuals:

- stdout (the access log) is not filtered. `log_format main` records
  client-side fields only, and the proxy never adds the remote query or
  forwarded headers to the client request line.
- `upstream sent invalid trailer` is not covered: it needs
  `proxy_pass_trailers on`, which the template does not set. Neither are the
  upstream messages of modules the template does not use (FastCGI, uwsgi,
  SCGI, gRPC, HTTP/2 proxying, memcached, mail).
- A literal credential written into `baseUrl` instead of a placeholder is still
  stored in the ConfigMap. Use placeholders.
- A query value may carry a percent-encoded control byte (`%0A`, `%00`): the
  check rejects the raw byte, not the escape, and an upstream that decodes the
  query receives that byte.

There is deliberately no short-value, percent-encoding or whitespace-trimming
residual: the redaction is positional, so whatever bytes NGINX quotes, trimmed
or encoded, lie inside the redacted span.

The remote container's readiness probe remains the local `/health` HTTP probe.
Its liveness probe runs `/usr/local/bin/egress-proxy-liveness <port>`. That
script checks `/health` and that the stderr filter process is alive and not a
zombie, so a dead filter causes a visible container restart (after about
5 s + 3 × 15 s) instead of silently losing error logs. It does not measure
whether the filter keeps reading: a filter that stays alive but stops reading
blocks NGINX's error-log writes once the 64 KiB FIFO is full.

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

HCC and this image must be upgraded together: the HCC liveness probe needs this
layer's `egress-proxy-liveness` script, and the stderr filter exists only in this
layer. An older image is expected to fail visibly (the exec probe fails and the
container restarts) rather than silently fall back.

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
The harness also covers query placeholder resolution (`H8 query-accept`),
stderr query redaction (`H9 redact`), credential echoes (`H13 echo`), the filter
program behind the audited-release gate (`H14 filter-lines`), signal delivery
(`H10 signals`), filter-death detection (`H11 filter-death`), the template value
check (`H12 value-reject`) and the template check's verdicts against NGINX
(`H15 template-check`).

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
4. Audit the upstream-quoting messages of the new release again. In
   `src/http/ngx_http_upstream.c`, in
   `src/http/modules/ngx_http_proxy_module.c`, and in any module the template
   starts using, find every `ngx_log_error` call whose arguments carry upstream
   response bytes. Update the `QUOTED[]` list and its comment in
   `egress-proxy-log-filter`, then set `AUDITED_NGINX_VERSION` in
   `scripts/tests/test-nginx-egress-proxy-tls.sh` to the new release. The
   harness fails on any other release, so a missed audit shows up as a red
   `Egress proxy TLS` check on the bump PR.
5. Run `bash scripts/validate-nginx-images.sh`,
   `bash scripts/tests/test-validate-nginx-images.sh`,
   `bash scripts/tests/test-verify-nginx-image-digests.sh` and
   `bash scripts/verify-nginx-image-digests.sh`.

Apart from that audit the guard tests and CI need no edits for such a bump: both
tests read the release from the validator and the Dockerfile. When a new CVE
raises the minimum, also edit `NGINX_RELEASE_FLOORS` and its CVE comment in
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

Image tag scope: the filter and the template change described above do not move
the image tag. `deploy/base` and `scripts/validate-nginx-images.sh` keep
`clerum/nginx-egress-proxy:0.1.0`. Deployed environments pin per-commit
`sha-<short>` tags, so the new filter and the new template line reach a cluster
together, with the commit that carries them. HCC puts no ConfigMap hash on the
pod template, so a ConfigMap update alone would not roll a pod; the per-commit
tag is what rolls it. The T2 lane builds
`clerum/nginx-egress-proxy:test`.

<!-- auto-deploy proof: OSS dev → build → mirror → infra apply (2026-07-22) -->
