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
   HTTPS only; DNS hostnames only (IPv4/IPv6 literals rejected); the hostname
   must stay within `[a-z0-9._-]` (the URL parser lowercases ASCII names and
   converts IDNs to punycode), and trailing root-label dots are removed before
   the host checks, so `sentry.svc.cluster.local.` is still rejected as internal
   while `api.example.com.` renders as `api.example.com`. Internal cluster hosts
   (`*.svc`, `*.svc.cluster.local`, `kubernetes.default`) and
   private/link-local/loopback patterns rejected; the URL is reconstructed from
   parsed components so injected characters (e.g. newlines) are stripped.
   Query placeholders must be complete `${NAME}` values where `NAME` matches
   `[A-Za-z_][A-Za-z0-9_]*`; bare dollars, malformed braces, backslashes, and
   semicolons are rejected. The URL parser strips TAB/CR/LF and percent-encodes
   other control characters and spaces before that check. A placeholder name is
   set in the egress-proxy container env (`spec.env`, except the names HCC
   strips as forbidden; `spec.envSecret`; `envMapping`; or a placeholder of
   `spec.remote.authHeaders`); an undeclared name is rejected, because it would
   otherwise survive into the rendered config, where NGINX resolves it as one of
   its own variables. Eight reserved egress-proxy names cannot be query
   placeholders or authHeader references. Six of them are pinned by the image
   entrypoint before the template check, and HCC strips a CRD-supplied value of
   any of those six from every remote-server env source:
   `NGINX_ENVSUBST_TEMPLATE_DIR`, `NGINX_ENVSUBST_TEMPLATE_SUFFIX`,
   `NGINX_ENVSUBST_OUTPUT_DIR`, `NGINX_ENVSUBST_STREAM_TEMPLATE_SUFFIX`,
   `NGINX_ENVSUBST_STREAM_OUTPUT_DIR`, and `NGINX_ENVSUBST_FILTER`. The resolver
   pair, `NGINX_ENTRYPOINT_LOCAL_RESOLVERS` and `NGINX_LOCAL_RESOLVERS`, is
   reserved for a different reason: `15-local-resolvers.envsh` exports
   `NGINX_LOCAL_RESOLVERS` after the template check when
   `NGINX_ENTRYPOINT_LOCAL_RESOLVERS` is set, so a placeholder of either name
   would be filled with a value the check never saw. HCC rejects both names as
   placeholders and does not strip them. A CRD may still set them, and no
   template HCC renders references them. The path takes no placeholders. Before
   the path check, the URL parser converts `\` to `/` and percent-encodes
   braces, spaces, and control characters, so the check rejects `$` and `;` in
   practice because they would change the unquoted NGINX template. Literal query
   text outside a complete `${NAME}` placeholder is also refused when it
   contains `\`, `;`, `{`, `}`, or `$` (store `\` as `%5C`). A reference inside
   an unquoted argument is in query position when an unescaped `?` occurs
   earlier in the same argument. The resolved value there must use only
   `[-A-Za-z0-9._~!'()*,=:@/?]` and complete `%XX` escapes, so `=`, `/`, `:`,
   `@`, `?`, `,`, `!`, `'`, `(`, `)`, and `*` are accepted raw. Raw `+` is
   refused (store `%2B`: a form-decoding upstream reads `+` as a space) and raw
   `\` is refused (store `%5C`: NGINX unescapes `\\`, `\t`, `\n`, and `\r`
   inside an unquoted argument, and a trailing `\` escapes the `;`). The proxy
   never encodes a value, and an already percent-encoded value is passed
   through unchanged. The value-class table below is the same contract as
   [Value classes](../docs/crds/mcpserver.md#value-classes).
2. **Renders a per-server `default.conf.template` ConfigMap** pinning
   `proxy_pass` to that single external base URL, with TLS to the upstream
   (`proxy_ssl_verify on`, SNI, system CA bundle), SSE-friendly settings
   (buffering/cache off, long read timeouts), and a local `/health` endpoint.
3. **Sanitizes each `spec.remote.authHeaders` entry** (`sanitizeAuthHeader`):
   header names restricted to `[A-Za-z0-9-]`. The CRD-authored `valueTemplate`
   is capped at 2048 characters, CR/LF/NUL are rejected in that text, and HCC
   escapes `\` and `"` so the template stays inside nginx's quoted string. HCC
   never escapes a resolved value. The bytes of a Secret, of `spec.env`, or of
   `envMapping` are substituted as stored and must themselves be in the quoted
   class below. A template that references a forbidden env name (`PATH`,
   `LD_PRELOAD`, ...) or a reserved proxy env name is dropped as a whole, and
   the name is not backfilled into the container env. A query placeholder that
   names one of those is a reconcile failure (`Resource sync failed`); a dropped
   authHeader means the upstream stops receiving that header.
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
3. Replace the literal query value with a complete `${NAME}` placeholder and
   provide the new value through `spec.envSecret`, not `spec.env`.
4. Apply the updated CRD. HCC records the digest of the rendered NGINX template
   on the remote PodTemplate, so a ConfigMap-only URL change rolls the egress
   proxy. Verify that the generated ConfigMap contains the placeholder, the
   Deployment restarted with the new template digest, and the proxy becomes
   ready.

### Before upgrading

Run the inventory before the paired upgrade, and fix every `REJECT` and
`INCONCLUSIVE` first. Both variables are required:

```
CONTEXT=<kube-context> NAMESPACE=<mcp-server namespace> \
  ./scripts/ops/egress-proxy-value-preflight.sh
```

The script is read-only. It prints one `server=<namespace>/<name> verdict=OK`,
`REJECT`, or `INCONCLUSIVE` line per remote server, then one `VERDICT=` line
(`CLEAN`, `VALUES_REJECTED`, `ERROR`, `INCONCLUSIVE`, or `NO_REMOTE_SERVERS`).
A value `REJECT` repeats the template check's message, which names the variable
and the context (`an unquoted query value`, `a quoted string`, …) and replaces
the template path with `<namespace>/<name>`. A static `REJECT` prints one
`static:` line: `S1` names the rule (`query` or `path`) and not the URL text;
`S2` names the header or placeholder and the reserved or forbidden name. An
`INCONCLUSIVE` line names the reason and, for a per-name reason, the env var.
Exit 0 is `CLEAN` (at least one server, all OK), 1 is `VALUES_REJECTED`, 2 is
`ERROR`, 3 is `INCONCLUSIVE`, and 4 is `NO_REMOTE_SERVERS` (never a success).
The script never prints a Secret value, a resolved env value, a literal value,
URL query or path text, the offending character, or the value's length, and it
never puts a Secret value or a resolved env value in argv or on disk. No URL
query or path text is printed or put in argv either. The rendered template does
reach disk: it is CRD text, so a baseUrl query or path (or a literal
valueTemplate) can appear in it. The script writes that file mode 0600 inside a
0700 mktemp directory that the EXIT trap removes; a SIGKILL can leave the
directory behind.

Every enabled HCC-managed remote proxy rolls once at the paired upgrade. One
Deployment replace carries the image, the exec liveness probe, the template
digest annotation, `proxy_ignore_headers`, and the env after the reserved-name
strip. Disabled servers and `managed: false` servers are not touched.

Each of those rolls disconnects that server from mcp-host for a short window,
including when every value is inside its class. Right after HCC replaces the
Deployment, the rollout is not ready (`observedGeneration` is behind
`generation`, or the replica counts differ). HCC publishes that status at once.
mcp-host polls HCC every 30 seconds, drops a live connection whose status is
not ready, and refuses new sessions with `MCP server not ready`. When the
readiness poll (at most 24 × 5 s) sees the rollout converge, HCC publishes
ready and mcp-host readmits the server on its next poll. The window is the
roll's convergence time plus up to one poll interval; a roll that converges
between two polls can go unseen. `maxUnavailable=0` keeps the old pod serving
at the Kubernetes level. It does not keep mcp-host connected. A full reconcile
handles up to 10 servers at once, so the windows overlap. The deploy workflows
pin HCC and this image to one commit and apply them together. They do not
restart the mcp-host fleet: those processes apply HCC's status in place. Their
rollout check treats the `mcp-server` namespace as non-gating (60 seconds,
warning only), so the windows are not a failed deploy. Run the paired upgrade
in a maintenance window.

A server whose values are outside the classes is not rolled. HCC leaves the
ConfigMap and the Deployment unchanged, writes `EgressProxyValuesValid=False`
with reason `ValueOutsideClass` and `Ready=False` with reason
`EgressProxyValuesInvalid`, and mcp-host stays disconnected until the value is
fixed. When `spec.envSecret` is set and the Secret exists with its keys,
`SecretResolved` stays `True` with reason `SecretFound`. The condition message
names the placeholder, the source, and the context. It never includes value
bytes, the value's length, or the offending character. See
[Value classes](../docs/crds/mcpserver.md#value-classes).

If the new image starts under an HCC that does not run that preflight, the new
pod refuses to start instead. The container log is the template check's line:
it names the variable and the context and never the value. HCC then reports the
rollout not ready and, after 24 × 5 s, writes `DeploymentReady=False` with
reason `RolloutIncomplete`. There is no `EgressProxyValuesValid` condition on
that path. Read the pod log for the variable name.

HCC and this image ship together. The image reference is HCC configuration
(`CONTEXT_MAPPER_EGRESS_PROXY_IMAGE`).

| HCC | Image | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| old | old   | Previous behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| old | new   | Deployments keep the old shape: `httpGet` liveness, so a dead stderr filter does not restart the pod; no template-digest annotation, so a ConfigMap-only change does not roll; no reserved-name strip; no value preflight. The new image pins the six envsubst knobs and applies the classes below at every container start, so an out-of-class value makes that pod refuse to start, with the pod log and `RolloutIncomplete` above and no `EgressProxyValuesValid` condition. |
| new | old   | The exec liveness binary is absent, so the probe fails and the kubelet restarts the container about every 45 s (failure threshold 3 × period 15 s). The preflight and the strip apply. The old image substitutes values without the template check.                                                                                                                                                                                                                             |
| new | new   | Intended.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Old HCC with the new image leaves an out-of-class value as a pod that never
becomes ready. The check refuses the start, the log names the variable and the
context, and the rollout ends `RolloutIncomplete` after the readiness budget.
There is no status condition that names the class. New HCC with the old image
restarts the container on the missing liveness binary, about every 45 seconds,
while the preflight still blocks an out-of-class value before either object is
written. The old image, if it does start, substitutes without the check.
Rollback is the previous HCC together with its previous image reference, which
rolls every remote proxy once more.

### Value classes

A value reaches the NGINX template through one of six channels. The image check
and the HCC preflight enforce channels 2 and 3 with the same classes. HCC alone
validates channels 1 and 4. An undefined braced `${NAME}` is rejected wherever
it sits. An undefined bare `$name` is left alone.

| #   | Channel                                                                                                          | Where it lands                                         | Class                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Literal query text in `spec.remote.baseUrl`, outside `${NAME}`                                                   | `proxy_pass`, unquoted, after `?`                      | Parser output minus `\`, `;`, `{`, `}`, `$`, and U+0000–U+0020. Unchanged.                                                                                                                    |
| 2   | Resolved value of the env var named by a query placeholder `${NAME}` (Secret, `spec.env`, or `envMapping`)       | `proxy_pass`, unquoted, after `?` in the same argument | Query class: `[-A-Za-z0-9._~!'()*,=:@/?]` plus complete `%XX` escapes.                                                                                                                        |
| 3   | Resolved value of the env var referenced by `authHeaders[].valueTemplate` (`${NAME}` or `$NAME`). Never escaped. | `proxy_set_header`, inside `"…"`                       | Quoted class, byte-wise: reject bytes 0x01–0x1F, 0x7F, `"` (0x22), `$` (0x24), and `\` (0x5C). Accept every other byte, including every byte ≥ 0x80, whether or not the value is valid UTF-8. |
| 4   | Literal text of `authHeaders[].valueTemplate` (CRD-authored). HCC escapes `\` and `"` in this text.              | `proxy_set_header`, inside `"…"`                       | At most 2048 characters; no CR, LF, or NUL; no reference to a forbidden or reserved name. Unchanged.                                                                                          |
| 5   | A defined env var at any other unquoted position (not after `?`)                                                 | generic unquoted argument                              | `[A-Za-z0-9._~-]` plus complete `%XX` escapes. HCC never emits this position.                                                                                                                 |
| 6   | A defined env var at an argument start, inside `'…'`, in a comment, or after `\`                                 | —                                                      | No defined value is accepted.                                                                                                                                                                 |

Query position is an unescaped `?` earlier in the same unquoted argument.
Characters the query class accepts raw include `=`, `/`, `:`, `@`, `?`, `,`,
`!`, `'`, `(`, `)`, and `*`, plus `A–Z`, `a–z`, `0–9`, `-`, `.`, `_`, and `~`,
and a complete `%XX` escape. Any byte ≥ 0x80 is rejected in a query value.
In a quoted value, bytes ≥ 0x80 are accepted, including NEL (U+0085, bytes
`C2 85`) and U+2028. The character-by-character query table is in
[Value classes](../docs/crds/mcpserver.md#value-classes).

The quoted rule compares bytes with `index()`. An earlier head of this PR used
`[[:cntrl:]]`. In the image's C.UTF-8 locale, musl `regexec` reports no match
for a whole value that contains an invalid UTF-8 byte, so a Secret value of
`tok`, then byte 0xFF, then CR, LF, and `X-Injected: 1` passed the check,
`nginx -t` passed, and the upstream received a second header line. The
byte-wise rule rejects 0x01–0x1F and 0x7F in any locale, whether or not the
value is valid UTF-8, which closes that gap. Writing the value still requires
write access to the Secret, and each upstream request uses its own HTTP/1.0
connection. A byte 0x00 cannot appear in an environment variable (a C string
ends at NUL), so the image never sees it. The HCC preflight rejects a Secret
value that contains 0x00, and it refuses a referenced literal that contains
`$(` because it does not emulate Kubernetes' `$(NAME)` expansion.

These shapes were substituted on the previous release and are refused now:

| Shape                                                                                                         | Channel | Remediation                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| raw `+` in a query value (standard base64)                                                                    | 2       | Store `%2B`. `API_KEY='example/def+gh=='` is refused. `API_KEY='example/def%2Bgh=='` and `API_KEY='sk:example_1'` are accepted. A form-decoding upstream already read `+` as a space. |
| `\` in a query value                                                                                          | 2       | Store `%5C`.                                                                                                                                                               |
| any other character outside the query class                                                                   | 2       | Percent-encode it. Base64url, hex, JWT, `sk-…`, and `pk:…` contain none of the refused characters except raw `+` in standard base64.                                       |
| a byte 0x01–0x1F or 0x7F in a header value, most often a trailing LF from `kubectl create secret --from-file` | 3       | Recreate the Secret without it: `--from-literal=<key>=<value>`, or `printf '%s'` into the file.                                                                            |
| `"`, `$`, or `\` in a header value                                                                            | 3       | No encoding exists for a header value. That credential cannot go through an authHeader placeholder.                                                                        |
| a `$(NAME)` reference in a literal `spec.env` or `envMapping` value whose env var a placeholder references    | 2, 3    | Blocked by design. Put the final value in the CRD or in a Secret.                                                                                                          |
| `\`, `;`, `{`, `}`, or `$` in the literal query of `spec.remote.baseUrl`, outside a complete `${NAME}`        | 1       | Percent-encode it in the CRD (`\` as `%5C`).                                                                                                                               |
| a query placeholder or an authHeader reference naming one of the eight reserved names or a forbidden name     | 2, 3    | Rename the env var. A query placeholder fails the reconcile. An authHeader is dropped.                                                                                     |

Before NGINX starts, `egress-proxy-entrypoint` copies each mounted top-level
`*.template` into a private directory and runs `egress-proxy-template-check` on
that copy. `mktemp -d` creates `/tmp/egress-proxy-templates.XXXXXX` mode 0700
with a new name on every start, so a restart that keeps the writable layer
never reads the previous copy. Each file is one `cat` into a regular file.
`umask 077` covers only that copy and is restored afterwards. Before the check,
the entrypoint assigns and exports all six envsubst knobs:
`NGINX_ENVSUBST_TEMPLATE_DIR` (the snapshot),
`NGINX_ENVSUBST_TEMPLATE_SUFFIX=.template`,
`NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/conf.d`,
`NGINX_ENVSUBST_STREAM_TEMPLATE_SUFFIX=.stream-template`,
`NGINX_ENVSUBST_STREAM_OUTPUT_DIR=/etc/nginx/stream-conf.d`, and
`NGINX_ENVSUBST_FILTER` empty. The assignments are plain, not `${VAR:-default}`,
so a pod env cannot point envsubst at a directory the check did not read, skip
the checked file, or leave a declared `${NAME}` unsubstituted. The pins do not
touch the resolver pair. `15-local-resolvers.envsh` runs later, inside the
official entrypoint.

envsubst substitutes every defined variable (`$NAME` and `${NAME}`). The check
reads each reference to a defined variable, works out where it sits the way
NGINX's tokenizer does, and rejects a value outside the class for that
position. A rejected value stops the container before NGINX starts
(CrashLoopBackOff, readiness never passes). The log names the template file,
the variable, and the context, never the value. An undefined bare `$name`
(NGINX's own `$host`, `$scheme`, …) is left untouched. An undefined braced
`${NAME}` stops the container: HCC emits that form only for names it declared,
and envsubst would otherwise leave it for NGINX to read as one of its own
variables (`${HTTP_X}` is the client's `X` request header). That happens when a
running pod restarts onto a template whose new placeholder its older env lacks.

HCC strips CRD-supplied values of the six `NGINX_ENVSUBST_*` names from every
remote-server env source (`spec.env`, `spec.envSecret`, and `envMapping`), then
appends one empty `NGINX_ENVSUBST_FILTER` last. The resolver pair is not
stripped. Kubernetes uses the last duplicate, so that empty entry is the
Deployment's value for the name even while an older image is still running. On
this image the entrypoint also assigns the same empty filter before envsubst.

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
script checks `/health` with `wget -Y off`, so a pod `http_proxy` does not
divert the probe, and it checks that the stderr filter process is alive and
not a zombie. A dead filter causes a visible container restart (after about
5 s + 3 × 15 s) instead of silently losing error logs. `http_proxy` is not
stripped: NGINX ignores it, and a tenant value can only make this probe miss.
The script does not measure whether the filter keeps reading: a filter that
stays alive but stops reading blocks NGINX's error-log writes once the 64 KiB
FIFO is full.

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

HCC and this image are upgraded together. The same four pairings are in
[Before upgrading](#before-upgrading):

| HCC | Image | Result                                                                                                                                                                                                                                                                                                                                         |
| --- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| old | old   | Previous behavior.                                                                                                                                                                                                                                                                                                                             |
| old | new   | The new image applies the value classes and the six envsubst pins at every start. An out-of-class value refuses the pod. There is no `EgressProxyValuesValid` condition; the pod log names the variable and the context, and the rollout ends `RolloutIncomplete`. Liveness stays `httpGet`, so a dead stderr filter does not restart the pod. |
| new | old   | The exec liveness binary is absent, so the kubelet restarts the container about every 45 s (failure threshold 3 × period 15 s). The preflight and the strip apply. The old image substitutes values without the template check.                                                                                                                |
| new | new   | Intended.                                                                                                                                                                                                                                                                                                                                      |

Rollback is the previous HCC with its previous image reference, together.

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
together, with the commit that carries them. HCC also records the rendered
ConfigMap digest on the remote pod template, so a ConfigMap-only template
change rolls the pod. The per-commit image tag remains necessary to keep HCC
and this image paired when their code changes together. The T2 lane builds
`clerum/nginx-egress-proxy:test`.

<!-- auto-deploy proof: OSS dev → build → mirror → infra apply (2026-07-22) -->
