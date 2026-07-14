# Clerum WorkflowRecipe — Authoring & Publishing Guide

A single reference for authoring `WorkflowRecipe` (`apiVersion: clerum.io/v1alpha1`) CRDs **and** publishing them through the Control UI so operators on any Clerum cluster can install them. Covers capabilities, security model, sandbox UIs, OAuth, webhooks, workflow steps, validation rules, image requirements, versioning, restrictions, examples, and operations.

When this doc and the cluster code disagree, the code wins. Authoritative sources are listed in §16.

---

## 1. What a WorkflowRecipe is

A single Kubernetes CRD that declares everything Clerum needs to:

- Deploy one or more workloads (Deployments / StatefulSets / Jobs / CronJobs / DaemonSets).
- Expose workloads as MCP servers.
- Render a web UI inside the Clerum desktop app (sandbox-ui).
- Broker OAuth flows for that UI.
- Accept and verify external HTTP webhooks (Stripe, GitHub, Slack, Meta, …).
- Run agentic / deterministic workflow steps (LLM-driven `instruction:` or TypeScript-snippet `run:`).

You write ONE recipe; the Workflow Recipe Controller (WRC) fans it out across the cluster.

### 1.1 Namespace routing (you do not control this)

The recipe CRD object itself ALWAYS lives in `sandbox-recipes`:

```yaml
metadata:
  name: my-recipe              # DNS-1123, ≤ 63 chars, unique within sandbox-recipes
  namespace: sandbox-recipes   # ALWAYS — never sandbox-ui, never mcp-server
```

WRC then splits the spec across three namespaces:

| Spec content | Reconciled into | Reason |
|---|---|---|
| Workloads with `transport: { ... }` | `mcp-server` | NetworkPolicy isolates MCP traffic. |
| Workload referenced by `spec.ui.workloadRef` | `sandbox-ui` | rpc-proxy is the only ingress; sibling pods cannot spoof identity. |
| Everything else | `sandbox-recipes` | Default home for DBs, workers, webhook handlers, cron, etc. |

`spec.contextRef` references a pre-existing `Context` CR. It is **required only when a workload exposes an MCP `transport`** (it enables Discovery API registration) — use `context1` unless told otherwise.

**Do NOT set `contextRef` on an agentic (`spec.steps`) recipe.** control-api rejects a steps-based recipe that sets `spec.contextRef` unless the recipe ALSO sets `spec.security.allowContextRef: true` AND a `WorkflowRecipePolicy` with `allowContextRef: true` exists in `sandbox-recipes` (operator-owned, absent by default). Omit it: WRC auto-creates a private Context `wf-<recipeName>` with no sharing and no policy required.

---

## 2. Top-level fields

| Field | Required | Notes |
|---|---|---|
| `description` | optional (strongly recommended) | One-paragraph human description. Shown in admin UI. `spec` has **no** OpenAPI `required` list, so admission accepts a recipe without it — but publish workflows and §14.4 expect it. |
| `contextRef` | only with MCP `transport` | Pre-existing `Context` CR (use `context1`). Omit on agentic (`steps`) recipes — see §1.1. |
| `agent` | optional; **allowed only with `steps`** (R1) | LLM provider config (`model`, `provider` ∈ openai/claude/zai/bailian, `secretRef`, `soulRef`). `steps` do **not** require it — R1 only forbids `agent` without `steps`. |
| `workloads` | optional, ≤ 25 | Each becomes a Deployment / StatefulSet / Job / DaemonSet / CronJob. Operators can lower this runtime limit with `CLERUM_WORKFLOW_MAX_WORKLOADS_PER_RECIPE`. |
| `bindings` | optional | Sibling-to-sibling network bindings (NetworkPolicy generation). |
| `resources` | optional | PVCs, Secrets, ConfigMaps shared across workloads. |
| `ui` | optional | Sandbox-UI surface. Requires a referenced workload of `type: deployment`, `replicas: 1`, no `transport`. |
| `oauthClients` | optional, ≤ 8 | Requires `spec.ui` OR a `workloads[].oauthClientRefs` consumer per client (O1). Embed-initiated OAuth grants, or background access (§7.5). |
| `webhooks` | optional, ≤ 16 | External HTTP webhook handlers. |
| `steps` | optional | Agentic / deterministic workflow steps. |
| `inputContract` | optional | JSON Schema for `inputs.*` template substitution in steps. |
| `triggers` | required with `steps` | `onDemand` and/or `schedule` (cron). At least one is required (R6), and a recipe with non-empty `steps` MUST declare one (cluster admission policy). |
| `output` | optional | Where step output goes (stdout / configmap / pvc / secret). |
| `scheduling` | optional | When the workflow runs (cron). |
| `security` | optional | Recipe-level isolation floor (e.g. `isolationLevel: minimal`). |

A recipe MUST have at least one of `workloads` or `steps` populated (rule R2).

---

## 3. Quick-start shapes

### 3.1 MCP server (simplest shape)

```yaml
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: my-mcp-server
  namespace: sandbox-recipes
spec:
  description: One-paragraph description of what this MCP server exposes.
  contextRef: context1
  workloads:
    - id: server
      type: deployment
      image: my-org/my-mcp-server:1.0.0
      port: 3000
      transport:
        type: streamableHttp        # streamableHttp | sse | stdio
        path: /mcp
      healthCheck: { type: http, path: /health, port: 3000 }
      resources:
        requests: { cpu: '50m',  memory: '64Mi' }
        limits:   { cpu: '500m', memory: '256Mi' }
```

### 3.2 Sandbox UI (web app inside the desktop)

```yaml
spec:
  description: Web UI shown in the desktop app's sandbox-ui slot.
  contextRef: context1
  workloads:
    - id: web
      type: deployment
      image: nginxinc/nginx-unprivileged:1.27-alpine   # MUST run non-root, listen on 8080
      port: 8080
      healthCheck: { type: http, path: /, port: 8080 }
      resources:
        requests: { cpu: '50m',  memory: '64Mi' }
        limits:   { cpu: '500m', memory: '256Mi' }
  ui:
    workloadRef: web
    port: 8080                  # MUST equal workload port and be in platform allow-list (default 8080)
    title: 'My App'
    defaultPath: '/'
  security:
    isolationLevel: minimal
```

### 3.3 Sandbox UI with OAuth (e.g. Slack-connected)

```yaml
spec:
  oauthClients:
    - id: slack-bot
      provider: slack             # salesforce | slack | notion | microsoft-graph | google
      clientIdRef:     { name: slack-oauth-creds, key: client-id }
      clientSecretRef: { name: slack-oauth-creds, key: client-secret }
      scopes: [users:read, channels:read]
  workloads:
    - { id: web, type: deployment, image: my-org/slack-ui:1, port: 8080, ... }
  ui: { workloadRef: web, port: 8080, title: 'Slack Dashboard', defaultPath: '/' }
```

Then create the secret yourself:

```bash
kubectl create secret generic slack-oauth-creds \
  -n sandbox-recipes \
  --from-literal=client-id="$SLACK_CLIENT_ID" \
  --from-literal=client-secret="$SLACK_CLIENT_SECRET"
```

### 3.4 Webhook handler (Stripe / GitHub / Slack / Meta)

```yaml
spec:
  workloads:
    - id: handler
      type: deployment
      image: my-org/webhook-handler:1.0.0
      port: 8080
  webhooks:
    - id: slack-events
      workloadRef: handler
      path: /events
      verification:
        scheme: hmac-sha256-timestamp-body
        secretRef: { name: slack-creds, key: webhook-signing-secret }
        signatureHeader: X-Slack-Signature
        signaturePrefix: 'v0='
        signatureEncoding: hex
      replay:                                    # REQUIRED iff scheme == hmac-sha256-timestamp-body (W8)
        timestampHeader: X-Slack-Request-Timestamp
        toleranceSec: 300                        # int, 10–3600, default 300
```

The timestamp header and its tolerance live on `webhooks[].replay` (`required: [timestampHeader, toleranceSec]`) — **not** on `verification`. There is no `timestampHeader` / `timestampPrefix` / `timestampToleranceSec` under `verification`, and no `replay.windowSec`.

### 3.5 Agentic / deterministic workflow

```yaml
spec:
  triggers:
    onDemand: {}                # REQUIRED for any recipe with steps — onDemand and/or schedule
  inputContract:
    properties:
      topic:
        type: string
        default: 'latest advances in multi-agent AI'
  steps:
    - id: research
      instruction: 'Research {{inputs.topic}} using web search. 3 paragraphs, with citations.'
    - id: summarize
      dependsOn: [research]
      instruction: |
        Using the following research:

        {{research:output}}

        Produce a one-sentence headline.
```

Workflow steps don't need workloads unless they require a specific MCP server.

---

## 4. `spec.workloads[]` — pod-shaped resources

### 4.1 Required + common fields

```yaml
- id: my-workload                # ^[a-z][a-z0-9-]*$, ≤ 63 chars, unique within recipe
  type: deployment               # deployment | statefulset | cronjob | job | daemonset
  image: registry/path:tag
  port: 8080                     # Primary container port
  replicas: 1                    # Default 1. UI workloads MUST be 1 (R16).
  command: ['/bin/sh', '-c']     # Optional
  args: ['exec my-binary']       # Optional
  env:
    - { name: LOG_LEVEL, value: info }
  envSecret:
    name: my-secret
    keys:
      - { secretKey: api-key, envVar: API_KEY }
      - { secretKey: slack-token, envVar: SLACK_TOKEN, optional: true }   # see §4.1.1
  healthCheck:                   # Becomes BOTH livenessProbe + readinessProbe
    type: http                   # http | tcp | exec — pick ONE shape below
    path: /health                #  http: path + port
    port: 8080
    # type: tcp                  #  tcp:  port only
    # type: exec                 #  exec: command[] only — NOT `exec:` (common mistake)
    # command: ['pg_isready', '-U', 'crm', '-d', 'crm']
    initialDelaySeconds: 5
    periodSeconds: 10
    timeoutSeconds: 3
    failureThreshold: 3
  resources:
    requests: { cpu: '50m',  memory: '64Mi' }
    limits:   { cpu: '500m', memory: '256Mi' }
  imagePullSecrets: [ghcr-creds]
  dependsOn: [db]                # Workload ordering — see §4.5
  schedule: '0 */6 * * *'        # REQUIRED for type: cronjob
  timeZone: 'UTC'                # Optional for cronjob — IANA TZ name (K8s ≥1.27)
  includeWhen: 'inputs.enable_db == true'   # Optional conditional deployment — a CEL expression over inputs
```

There is **no `envFromConfigMap`** field: `env` (name/value pairs) and `envSecret` (Secret-key → env-var mappings) are the only env-projection surfaces, and there is no ConfigMap env-projection path at all. The conditional-deployment field is **`includeWhen`** (a CEL expression, not `{{...}}` template syntax); `when:` does not exist and is rejected as an unknown field.

**HealthCheck field-shape pitfalls** (the CRD validates these — wrong field name = silent omission or rejection):

| `type` | Required field | Common mistake |
|---|---|---|
| `http` | `path` + `port` | Forgetting `port` defaults to the workload's `port`, not 80. |
| `tcp` | `port` | Same default rule. |
| `exec` | `command: [...]` (string array) | Using `exec: [...]` — there is **no** `exec` subfield; the command goes in `command`. |

### 4.1.1 Optional `envSecret` keys (deferred credentials)

Each `envSecret.keys[]` entry accepts `optional: true` (default `false`). The flag changes how the controller projects the env var when the underlying Secret or key is missing at reconcile time:

| `optional` | Secret present, key present | Secret present, key missing | Secret missing entirely |
|---|---|---|---|
| `false` (default) | Env var projected via `secretKeyRef`. | Env var still projected; kubelet fails the pod with `CreateContainerConfigError`. | Same — kubelet fails the pod. |
| `true` | Env var projected via `secretKeyRef`. | Env var **omitted** from the pod spec. App sees `process.env.MY_KEY === undefined`. | Same — env var omitted. |

The reconciler reads each referenced Secret once per reconcile pass to decide which optional keys to project. A K8s watch on Secrets in `sandbox-recipes` fans reconciles back to dependent recipes when a Secret's key-set changes (debounced ~10s to coalesce bursts of `kubectl create secret …` / `kubectl patch secret …`). On that re-reconcile, the Deployment spec gains or loses the env var, and Kubernetes natively rolls the pod.

```yaml
- id: api
  type: deployment
  image: my-crm-api:1
  envSecret:
    name: api-creds
    keys:
      - { secretKey: pg-password,        envVar: PG_PASSWORD }                       # required — recipe is dead without it
      - { secretKey: fireflies-api-key,  envVar: FIREFLIES_API_KEY,  optional: true } # enable Fireflies later
      - { secretKey: whatsapp-app-secret,envVar: WHATSAPP_APP_SECRET, optional: true } # enable WhatsApp later
```

**When to use:**

- The workload's core functionality runs without this credential; it only enables an integration.
- The recipe needs to reach `phase: active` so the operator can use the parts that *are* configured (UI, core endpoints) while they're still gathering the optional credentials.
- The image already treats the env var as optional (gates the integration behind an `if (process.env.X)` check). If the image hard-requires the variable to be defined and crashes otherwise, marking it `optional: true` only converts `CreateContainerConfigError` into `CrashLoopBackOff` — you must also fix the image.

**When NOT to use:**

- Postgres/MongoDB connection passwords, JWT signing keys, anything the workload reads at startup and can't run without — keep these required so the pod fails loudly instead of starting up half-broken.

**Failure modes preserved:**

- Required keys (`optional: false` or omitted) still project as `secretKeyRef`. The kubelet fails the pod if they're missing, exactly as today. This is the right behavior for credentials the workload genuinely depends on.
- A 404 on `readNamespacedSecret` (Secret doesn't exist) and an empty `data` field are both treated as "no keys present" — optional keys are skipped, required keys still project (and fail at the pod layer).
- Transient apiserver errors (non-404) during the reconcile-time Secret read fall back to "empty key-set" — conservatively skipping optional keys until the next reconcile. The WRC logs the underlying error.

**Pre-conditions on the image / app code:**

- Treat the env var as nullable in the app code.
- For child-process commands or scripts that interpolate the env var, guard against the unset case (`${SLACK_TOKEN:-}` in shell, `process.env.SLACK_TOKEN ?? ''` in Node, etc.).
- If the integration has feature-flag-style guarding, gate it on the env var's *presence*, not on the recipe spec.
- **Fail closed when the env var is absent.** A missing optional credential MUST disable the integration entirely — return an explicit "not configured" error from the affected endpoint, refuse to sign/verify, or skip the outbound call. Code that *defaults* to no-auth, an unauthenticated client, an empty signing key, or a permissive fallback when the env var is unset converts a deferred credential into a silent security hole. If you cannot guarantee fail-closed behavior, mark the key required.

### 4.2 Per-workload security overrides

Some images (PostgreSQL UID 70, MongoDB UID 999) need specific UIDs:

```yaml
security:
  runAsUser: 70                  # Min 1 (root rejected by CRD)
  runAsGroup: 70
  fsGroup: 70                    # REQUIRED when mounting PVCs (chowns volumes)
  addCapabilities:               # Re-add caps after recipe-level DROP ALL
    - CHOWN
    - FOWNER
    - DAC_OVERRIDE
```

`runAsUser` automatically forces `runAsNonRoot: true`.

### 4.3 Volumes

- **Only PVCs are auto-wired into `volumes:`.** ConfigMap/Secret volume mounts via `volumeMounts` are NOT supported today. If you need static config files in a workload, write them at startup via `command:` (e.g. `cat > /tmp/x <<EOF ... EOF`).
- For StatefulSets, declare PVCs with `volumeClaimTemplates`:

```yaml
- id: postgres
  type: statefulset
  image: postgres:16-alpine
  serviceName: postgres-headless # OPTIONAL — defaults to <recipeName>-<id>-headless
  env:
    - { name: PGDATA, value: /var/lib/postgresql/data/pgdata }   # subdir avoids chown conflicts
  volumeMounts:
    - { name: pgdata, mountPath: /var/lib/postgresql/data }
  volumeClaimTemplates:
    - name: pgdata
      storageClass: standard     # 'standard' (minikube), 'do-block-storage' (DO), 'pd-standard' (GCP)
      accessMode: ReadWriteOnce
      size: 256Mi
  security:
    runAsUser: 70
    runAsGroup: 70
    fsGroup: 70                  # MUST set for PVC mount to be writable
    addCapabilities: [CHOWN, FOWNER, DAC_OVERRIDE]
```

**`serviceName` (StatefulSet only)** — sets the StatefulSet's headless Service name (`spec.serviceName`). Leave it unset unless another component (e.g. an external operator, a chart that hard-codes a hostname) requires a specific name. Defaults to `<recipeName>-<workloadId>-headless`. Per-pod stable DNS still works either way (`<pod-name>.<serviceName>.<namespace>.svc.cluster.local`) — but `{{workloadId:host}}` resolves to the **regular** Service FQDN (§10.2.2), not the headless one.

### 4.4 `spec.resources[]` — shared resources

Top-level `spec.resources[]` declares cluster objects that live alongside the workloads in `sandbox-recipes` and are shared across them. Each entry has an `id` (DNS-1123, unique within the recipe) and a `type`.

```yaml
spec:
  resources:
    - id: shared-data
      type: pvc
      storageClass: standard          # cluster-dependent: 'standard' (minikube), 'do-block-storage' (DO), 'pd-standard' (GCP)
      accessMode: ReadWriteOnce
      size: 10Gi
    - id: bootstrap-config
      type: configmap
      data:
        settings.json: '{"foo":"bar"}'
    - id: external-creds
      type: secret                    # Secret content is provisioned out-of-band (kubectl / external-secrets / …).
```

**What WRC does with each `type` today:**

| Type | Reconciled artefact | Auto-wired into pods? |
|---|---|---|
| `pvc` | A `PersistentVolumeClaim` in `sandbox-recipes`. | YES — WRC synthesises pod `volumes:` from `spec.resources[]` (PVC type) when a workload's `volumeMounts[].name` matches the resource `id`. |
| `configmap` | A `ConfigMap` in `sandbox-recipes`. | NO — declared-but-not-mountable today, and there is **no** ConfigMap env-projection field. Read values via `{{resourceId:KEY}}` in `env[].value` / `command` / `args` (§10.2.2), or bootstrap files at startup via `command:`. |
| `secret` | A reference for NetworkPolicy / discovery purposes (content not managed by WRC). | NO — declared-but-not-mountable today. Use `envSecret:` for env-var projection. |

**`spec.resources[]` vs `volumeClaimTemplates`:** use `volumeClaimTemplates` on a StatefulSet (one PVC per replica, K8s-managed). Use `spec.resources[]` for a single PVC shared across one or more non-StatefulSet workloads.

**Per-resource sub-schema:** the authoritative shape is in the CRD (§16: `charts/clerum-crds/crds/workflowrecipe.yaml`). The examples above cover the attested fields; verify there before relying on additional keys.

### 4.5 `workloads[].dependsOn` — creation order only

Each workload may declare `dependsOn: [<other-workload-id>, ...]`. The reconciler topologically sorts workloads by this graph and **submits resource manifests to the K8s API in dependency order** (`workflow-recipes/src/reconciler/workflowRecipeReconciler.ts`).

**What `dependsOn` does:**

- Guarantees the `db` StatefulSet manifest is `kubectl apply`-d before the `api` Deployment manifest.
- Rejected at admission if it references a non-existent workload `id`.
- Used by `includeWhen` filtering to prune dangling refs when a workload is conditionally excluded.

**What `dependsOn` does NOT do** (despite the CRD field description):

- It does **NOT** wait for the dependency pod to be `Ready` before creating dependents. The reconciler submits and moves on; both pods start scheduling immediately.
- It does **NOT** stop a CronJob from firing before its dependency is healthy. The first cron tick depends only on `schedule`, not on `dependsOn`.

If you need actual runtime ordering (dependent pod should not serve traffic until the dependency answers), declare a **`healthCheck`** on the dependency (§4.1). K8s itself will gate the dependent's NetworkPolicy/Service routing through pod readiness — `dependsOn` does not replace that.

Connection-refused storms during a first install are almost always missing-`healthCheck` issues, not missing-`dependsOn` issues. Add the probe.

### 4.6 Slow-startup workloads — bind the port first, don't stall before `listen()`

WRC defaults `livenessProbe.initialDelaySeconds: 10` with `failureThreshold: 3` and `periodSeconds: 15`. That gives a workload roughly **55 seconds** between container start and the first SIGKILL. Any workload that does substantive work *before* binding its HTTP port — running migrations, warming a cache, registering with a service mesh, restoring snapshot state — will be killed mid-startup on a cold install. The signature is identical to §9.5's trap:

- `lastState.terminated.exitCode = 137`, `reason: Error`.
- `Liveness probe failed: ... connection refused` in pod events.
- Empty `kubectl logs` (Node line-buffers stdout; SIGKILL skips flush).
- `kubectl logs --previous` shows at most a single "shutting down" line if Fastify/Express SIGTERM handlers ran before kubelet escalated to SIGKILL.

**There is no `startupProbe` field.** `workloads[]` exposes exactly one probe surface — `healthCheck`, which WRC renders as BOTH `livenessProbe` and `readinessProbe`. A recipe declaring `startupProbe:` is rejected as an unknown field. The two levers you actually have are `healthCheck`'s own timing knobs (`initialDelaySeconds`, `periodSeconds`, `failureThreshold`) and, better, the shape of your process:

**A. Widen the `healthCheck` budget.** Raise `initialDelaySeconds` / `failureThreshold` so the liveness budget covers your worst cold start. Blunt — it also loosens steady-state liveness, since the same probe is both liveness and readiness.

```yaml
workloads:
  - id: api
    type: deployment
    image: my-org/api:1.0.0
    port: 8080
    healthCheck:
      type: http
      path: /healthz
      port: 8080
      initialDelaySeconds: 30
      periodSeconds: 10
      failureThreshold: 30     # ~5 minutes of budget for migrations to finish
```

**B. Move pre-`listen` work to a background task (preferred).** Call `app.listen()` first; let `/healthz` return `503 starting` until migrations complete. The probe answers immediately, so liveness never fires; readiness holds traffic until you flip `ready`. This matches K8s' bias (Ready ≠ Live) and keeps steady-state liveness tight.

```ts
app.get('/healthz', () => ready ? { ok: true } : reply.code(503).send('starting'));
await app.listen({ host, port });
runMigrations().then(() => { ready = true; }).catch(fail);
```

The "no logs at all" debug experience is the most expensive part of this trap. When you see `exitCode 137` + empty logs, suspect *pre-listen blocking work*, not a misconfigured probe path.

---

## 5. MCP server workloads (`transport`)

Add `transport:` to a workload to expose it as an MCP server. WRC routes it to `mcp-server`.

```yaml
workloads:
  - id: search
    type: deployment
    image: my-org/search-mcp-server:1.0.0
    port: 3000
    transport:
      type: streamableHttp       # streamableHttp | sse | stdio
      path: /mcp
```

| Transport | Image expectation | Notes |
|---|---|---|
| `streamableHttp` | Listens HTTP on `port`, accepts MCP JSON-RPC at `path`. | Most common. |
| `sse` | HTTP server with Server-Sent Events at `path`. | Use only when upstream demands SSE. |
| `stdio` | Reads JSON-RPC from stdin, writes to stdout. Platform inserts a `stdio-bridge` sidecar. | For stdio-only images (postgres-mcp, redis-mcp). |

To use an MCP server from a step:

```yaml
steps:
  - id: search-the-web
    instruction: 'Search for {{inputs.query}}'
    mcpServers: [search]         # references workloads[].id
    allowedTools:                # OBJECT with an `include` array — not a bare array
      include: [search__web_search]      # server__tool with double underscore
```

---

## 6. Sandbox UI (`spec.ui`)

The UI workload runs inside the desktop app's Electron `WebContentsView` partition, reverse-proxied by `rpc-proxy`. You own the workload's HTTP behaviour; the platform owns the proxy, cookie, CSP, and embed sandboxing.

### 6.1 Schema

```yaml
spec:
  ui:
    workloadRef: web             # MUST match workloads[].id where type=deployment, replicas=1, no transport (R15/R16)
    port: 8080                   # MUST be in platform allow-list (default 8080 only)
    title: 'My App'              # ≤ 100 chars
    defaultPath: '/'             # MUST start with /, no scheme prefix, no // (R18)
    icon: 'data:image/svg+xml;base64,...'   # Optional. data: URI only. ≤ 32 KB.
    egress:
      internal:
        - { workloadRef: api, port: 8000 }        # workloadRef + port both required
      external:
        - { fqdn: 'api.openai.com', port: 443 }   # fqdn + port both required; `reason` optional
  security:
    isolationLevel: minimal
```

### 6.2 What the platform does for you (do not try to override)

- Mints a per-recipe session cookie `clerum_sandbox_ui_session` (HttpOnly, Secure, SameSite=Strict, scoped to `/api/v1/sandbox-ui/<ns>/<name>/`).
- Reverse-proxies `view/*` to your workload's Service. **Strips** client `Cookie`, `Authorization`, `X-Clerum-*` headers. **Injects** `X-Clerum-User` (from cookie) and `X-Clerum-Recipe` (`<ns>/<name>`).
- Sets a strict CSP on every response: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`.
- Sets `Permissions-Policy` denying camera/mic/geolocation/USB/etc., `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
- Loads URL inside an Electron `WebContentsView` with `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, `webSecurity:true`, per-recipe persistent partition.
- Rejects path-traversal (`..`, `%2e%2e`, `.%2e`, `%2e.`, `%252e%252e`), NUL bytes, backslashes with `400`.
- Rewrites same-origin/relative `Location:` headers to live under `view/*`. Off-origin redirects are stripped and coerced to `200`.

### 6.3 Trust model

User auths against control-api → desktop app POSTs `/sandbox-ui/<ns>/<name>/session` → JWT cookie → embed loads `/view/*` → rpc-proxy verifies cookie, strips/injects headers, proxies. NetworkPolicy locks ingress to rpc-proxy pods only. **Always trust `X-Clerum-User` server-side; never trust anything the embed JS sends about identity.**

**The `sandbox-ui` namespace is the credential boundary.** The UI workload faces the user's browser; the `sandbox-recipes` namespace sits behind it and is where Secrets live. So:

- **The UI workload MUST NOT declare `envSecret`, `imagePullSecrets`, or any other credential reference.** It receives no provider tokens, no signing keys, no API keys.
- **Credentialed code lives on sibling workloads in `sandbox-recipes`** — reached from the UI via `spec.bindings[]` (sibling-to-sibling NetworkPolicy + service DNS).
- **Operators only create Secrets in `sandbox-recipes`** (§14.4). There is intentionally no envSecret-resolution path from `sandbox-ui` — a UI pod that references a Secret will sit in `CreateContainerConfigError` indefinitely because the Secret does not exist in its namespace.

The canonical shape is a thin static-asset / proxy-shim UI image plus one or more backend workloads:

```yaml
workloads:
  - id: ui                      # static nginx + JS, no creds, → sandbox-ui
    type: deployment
    image: my-recipe-ui:1
  - id: api                     # the credentialed pod, → sandbox-recipes
    type: deployment
    image: my-recipe-api:1
    envSecret:
      name: my-recipe-creds
      keys:
        - { secretKey: api-key, envVar: API_KEY }
ui:
  workloadRef: ui
  port: 8080
bindings:
  - from: ui
    to:   api
    port: 8080                  # ui proxies /api/* → api.sandbox-recipes:8080
```

If your recipe currently has one credentialed workload doubling as the UI, split it. The platform will not — and is not designed to — mirror Secrets into `sandbox-ui`.

> ⚠ **When you split, every egress declaration moves with the work.** A single-image recipe's `spec.ui.egress.external[]` opens egress for the **UI workload pod** in `sandbox-ui` — which, in a single-image recipe, *is* the credentialed pod. After splitting, the credentialed pod lives in `sandbox-recipes` and its egress is governed by `workloads[].egressBindings[]`, not by `spec.ui.egress.*`. Forgetting to redistribute external destinations to `egressBindings[]` is the classic broken-after-split bug: third-party APIs that worked yesterday now `ETIMEDOUT`. Worked migration: see §12.7.

### 6.4 Container image requirements

The `sandbox-ui` namespace runs the K8s PodSecurity `restricted` profile. Your image MUST:

- Run as non-root (UID > 0). `nginxinc/nginx-unprivileged:1.27-alpine` (UID 101, port 8080) is the canonical example.
- Drop all capabilities (enforced; do not request them back).
- Listen on `0.0.0.0:8080` (not `127.0.0.1`, not any other port).
- Return 2xx on `/` (or your `healthCheck.path`) so K8s marks the pod Ready.
- Not require `NET_BIND_SERVICE` (no privileged ports).
- Not write to root FS (mount `emptyDir` if you need scratch).

### 6.5 What CSP / Electron prevent (work-arounds)

| Constraint | Implication |
|---|---|
| `script-src 'self'` | No inline `<script>`. No third-party CDN scripts. Bundle JS into same-origin `.js` files. |
| No `'unsafe-eval'` | No `eval`, no `new Function`, no string-arg `setTimeout`. Configure bundlers for no-eval mode. |
| `connect-src 'self'` | No `fetch`/XHR to external APIs from the embed. Relay through your sibling backend. |
| `img-src 'self' data:` | No remote images. Self-host or use `data:` URIs. |
| `frame-ancestors 'none'` + `X-Frame-Options: DENY` | Embed cannot be iframed; cannot iframe third parties. |
| `setWindowOpenHandler` denies all | `window.open` always pops to the OS browser. Use `location.assign` / `<a href>` for in-embed nav. |
| `will-download` prevented | Downloads blocked. Render content inline (`<pre>`, embedded PDF viewer you self-host, etc.). |
| WebSocket | Returns `426 Upgrade Required`. Use SSE or long-polling. |
| Body size | 25 MB request / 100 MB response (SSE/chunked exempt). |
| Permissions | Camera/mic/geolocation/notifications/midi/clipboard-read/display-capture denied unconditionally. |
| Cookies | Session cookie is HttpOnly and JS-invisible. `document.cookie` writes are stripped before reaching your container. Use server-side per-user state keyed by `X-Clerum-User`. `localStorage`/`sessionStorage` ARE available, partition-isolated per recipe. |

### 6.6 URL handling

The embed is mounted at `/api/v1/sandbox-ui/<ns>/<name>/view/`. rpc-proxy strips that prefix before forwarding to your nginx, so `GET /api/v1/sandbox-ui/<ns>/<name>/view/static/app.js` reaches your container as `GET /static/app.js`. On the response side rpc-proxy rewrites `Location` headers on 3xx so server-side redirects stay inside the mount.

**It does NOT rewrite response bodies.** Absolute paths like `<script src="/static/app.js">` or `fetch('/api/foo')` resolve in the WebView to `http://<embed-origin>/static/app.js` — outside the mount — and rpc-proxy returns `404 Not Found`. Classic symptom: HTML shell loads (200), JS never executes, React renders an empty `<div id="root">`.

#### Recommended fix: `<base href="./">` in the head + relative paths

Add this to `<head>` of your `index.html` BEFORE any `<link>` / `<script>`:

```html
<head>
  <base href="./" />
  <link rel="stylesheet" href="./static/styles.css" />
  <script type="module" src="./static/app.js"></script>
</head>
```

This pins the document's base URL to its own directory regardless of how the WebView opened the page, so all subsequent URL resolution behaves the same.

#### Why `<base>` is the safer default (the trailing-slash gotcha)

Relative paths in HTML are resolved against the **document's base URL**, which by default is the URL the page was loaded with — and that URL's trailing slash matters:

| Document URL | Relative `./static/app.js` resolves to |
|---|---|
| `…/view/` (with trailing slash) | `…/view/static/app.js` ✅ |
| `…/view` (no trailing slash) | `…/static/app.js` ❌ |
| `…/view/dashboard` | `…/view/static/app.js` ✅ (resolves against `…/view/`) |
| `…/view/dashboard/` | `…/view/dashboard/static/app.js` ❌ |

Today the desktop app always opens with a trailing slash (`view/` when `defaultPath` is `/`), so plain `./static/...` works. But any future change to navigation, any client-side router pushing history state, or a `defaultPath` change can break this. `<base href="./">` makes the resolution base explicit and stable.

#### What `<base href>` does NOT fix

- **Absolute paths inside your JS** — `fetch('/api/foo')`, `new URL('/api/foo', location.origin)`, `<a href="/path">` rendered by your framework. `<base>` only governs URLs in HTML attributes parsed from the document; it does not retroactively rewrite a `/`-prefixed string your code constructs. **Use relative paths in JS too** — `fetch('api/foo')` or `fetch('./api/foo')`.
- **Bare module specifiers** — `import x from 'lodash'` inside an ES module. Those need an import map, not `<base>`. (Not common in recipe SPAs but worth knowing.)

#### Build-system specifics

| Build system | What to set |
|---|---|
| Hand-written HTML (copy-to-public via esbuild, parcel, Make, etc.) | Edit `index.html` directly — `<base href="./">` + `./` paths. |
| Vite | `base: './'` in `vite.config.ts`. Emits relative URLs automatically for built assets; you still want `./api/...` in fetch calls. |
| Next.js / similar with absolute-asset baking | Set `basePath` / `assetPrefix` to the mount path, **OR** front the app with nginx that rewrites response HTML. Generally simpler to use the static-asset approach above. |

For 3xx `Location` headers your backend emits, you can return either `./<path>` or `/<path>` — rpc-proxy rewrites both to the prefixed form before sending them back to the WebView.

### 6.7 Recipe-upgrade UX

Empty Endpoints / 5xx upstream → rpc-proxy returns a styled HTML "recipe updating, retry shortly" page with 2 s auto-retry. SSE held up to 10 s waiting for Endpoints, else `503`. Recipe deleted mid-session → `410 Gone`.

---

## 7. OAuth (`spec.oauthClients[]`)

Declaring `spec.oauthClients[]` makes the platform run the entire auth-code flow: it signs the `state`, hosts the callback, encrypts grants at rest, and delivers completion into the embed via the desktop app's `clerum:` URL scheme. You write the embed-side JS.

### 7.1 Schema

```yaml
oauthClients:
  - id: slack-bot                # Stable identifier; the embed uses this as `clientId`
    provider: slack              # salesforce | slack | notion | microsoft-graph | google
    clientIdRef:     { name: slack-oauth-creds, key: client-id }
    clientSecretRef: { name: slack-oauth-creds, key: client-secret }
    scopes: [users:read, channels:read]
    backgroundAccess: false      # optional — see §7.5 (default false)
```

CEL rules: **O1** requires either `spec.ui` OR a `workloads[].oauthClientRefs` consumer for every declared client (so a UI-less background-OAuth recipe is legal — §7.5). **O2** `provider` enum (5 known). **O3** `id` unique. **O4** `oauthClientRefs` is not allowed on MCP transport workloads.

### 7.2 Embed endpoints (same-origin, no CORS)

| Path | Method | Body | Returns |
|---|---|---|---|
| `/api/v1/sandbox-ui/<ns>/<name>/oauth/token` | POST | `{ "oauthClientId": "..." }` | `{ "accessToken": "...", "expiresAt": "..." }` (200) or `{ "error": "no_grant" }` (404) or `{ "error": "integration_not_configured", "integration", "hint" }` (503, see §7.2.1) or `{ "error": "refresh_failed" }` (502) |
| `/api/v1/sandbox-ui/<ns>/<name>/oauth/grant` | DELETE | `{ "oauthClientId": "..." }` | 204 (idempotent) |

All cookie-authed (`credentials: 'include'`). The `userId` is derived from the cookie's `sub` claim. Refresh tokens are stored AES-256-GCM-encrypted; the embed never sees them. Access tokens are refreshed automatically when within 60 s of expiry.

### 7.2.1 Deferred-credentials response (`503 integration_not_configured`)

OAuth follows the same *deferred-credentials* contract as `envSecret` keys (§4.1.1) and `webhooks[].optional` (§8.6). Missing `clientIdRef` / `clientSecretRef` Secrets do **NOT** mark the recipe `degraded` — admission only validates the SHAPE of the refs, and the WRC reconciler never reads them. Resolution happens at use-site (the `/oauth/authorize-url`, `/oauth/token`, and `/oauth-callback` routes in control-api). When the Secret or the named key is missing, the use-site returns:

```
HTTP/1.1 503 Service Unavailable
Content-Type: application/json

{
  "error": "integration_not_configured",
  "integration": "<oauthClientId>",
  "hint": "create Secret <name> to activate this integration"
}
```

When the Secret exists but the named key is empty, the hint becomes `create key <key> on Secret <name> to activate this integration`.

**Which routes 503 — and when (important):** `/oauth/authorize-url` and `/oauth-callback` read the Secret **unconditionally**, so a missing Secret is always a `503 integration_not_configured`. `/oauth/token` is different: it short-circuits on grant state **before** ever reading the Secret. With no stored grant — the normal state *before* the user connects — it returns `404 no_grant` and never touches the Secret. It only reaches the Secret (and thus `503`) on the refresh path: a grant that already exists and whose access token is stale. **Consequence: an embed CANNOT use `/oauth/token` alone to detect "integration not configured" — a missing Secret in the pre-connect state is indistinguishable from "user hasn't connected yet" (both `404`). Probe `/oauth/authorize-url` to disambiguate (see §7.3 `probe()`).**

Embed authors should treat 503 the same way the recipe's UI would treat any other "operator hasn't finished setup yet" state — show a banner with the hint and prompt the operator to provision the Secret. 503 (vs the webhook gateway's 410) signals "configure me, then retry" — the operator's next OAuth Connect click should re-fire the request and succeed once the Secret is present.

### 7.3 Embed lifecycle (canonical)

```html
<a href="clerum://oauth?clientId=slack-bot">Connect Slack</a>
```

```js
// External same-origin .js. CSP forbids inline scripts.
const CLIENT_ID = 'slack-bot';
const m = window.location.pathname.match(/^(\/api\/v1\/sandbox-ui\/[^/]+\/[^/]+)\/view/);
const BASE = m ? m[1] : '';

function post(path) {
  return fetch(BASE + path, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oauthClientId: CLIENT_ID }),
  });
}

function probe() {
  return post('/oauth/token').then(r => {
    if (r.status === 200) return r.json().then(j => render('connected', j.accessToken, j.expiresAt));
    if (r.status === 502) return render('needs-reconnect');     // refresh_failed
    if (r.status === 503) return render('not-configured');      // stale-grant refresh path
    if (r.status === 404) {
      // no_grant is ambiguous: never-connected OR Secret missing.
      // /oauth/token short-circuits on no-grant WITHOUT reading the Secret
      // (§7.2.1), so disambiguate via /oauth/authorize-url, which checks
      // the Secret unconditionally.
      return post('/oauth/authorize-url').then(a => {
        if (a.status === 200) return render('not-connected');   // Secret present, no grant yet
        if (a.status === 503) return render('not-configured');  // Secret missing
        return a.text().then(b => render('error', a.status, b));
      });
    }
    return r.text().then(b => render('error', r.status, b));
  });
}

function disconnect() {
  return fetch(BASE + '/oauth/grant', {
    method: 'DELETE', credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oauthClientId: CLIENT_ID }),
  }).then(probe);
}

if (window.clerum && window.clerum.onOauthCompleted) {
  window.clerum.onOauthCompleted(p => {
    if (!p || !p.oauthClientId || p.oauthClientId === CLIENT_ID) probe();
  });
}

probe();
```

### 7.4 Egress to provider APIs

Your UI workload can use the access token to call the provider's API server-side. Add to `spec.ui.egress.external[]`:

```yaml
ui:
  egress:
    external:
      - { fqdn: 'slack.com', port: 443 }
      - { fqdn: 'api.slack.com', port: 443 }
```

Wildcard FQDNs are NOT supported (NetworkPolicy is CIDR-based; WRC resolves listed FQDNs to A records at reconcile and periodically re-resolves).

### 7.5 Background OAuth (`backgroundAccess`) — recipe-owned grants

§7.2–7.4 cover the **embed** flow: an end-user clicks Connect, and the resulting grant is *theirs* (keyed by their user id). That grant is only reachable from the cookie-authed embed endpoints — a CronJob or background Deployment has no cookie and no user, so it cannot use it.

`backgroundAccess: true` opts an `oauthClient` into a second, parallel flow that produces a **recipe-owned `service` grant** — one grant per `(recipe, oauthClient)`, with no user id. Background workloads obtain provider tokens from it through a control-api broker. The embed flow is unchanged and still available on the same client; the two grant kinds are independent rows.

**Who connects it.** Not the end-user — an **operator**, from the Control UI's recipe Integrations tab. The operator clicking "Connect for the recipe" is an explicit, audited admin action; there is no embed-reachable path to mint a `service` grant.

**Admission requirements.** `backgroundAccess: true` requires `scopes` to include the provider's offline/refresh scope (`refresh_token` for Salesforce, `offline_access` for Microsoft Graph) — without a refresh token the broker cannot sustain access past the first token expiry. Providers that negotiate offline access out-of-band (Google, Slack) have no scope requirement. A workload opts in via `oauthClientRefs` (below), which must reference declared `backgroundAccess` clients and is only valid on non-MCP, non-UI workloads.

**Opting a workload in (`oauthClientRefs`).** A workload does NOT get background OAuth implicitly — it must list the client ids it uses:

```yaml
workloads:
  - id: sync-cron
    type: cronjob
    image: my-sync:latest
    oauthClientRefs: [microsoft-graph]   # this workload uses the recipe's MS Graph service grant
```

Only workloads with a matching `oauthClientRefs` get the broker token mounted and egress to control-api — a webhook handler in the same recipe that doesn't list it gets neither.

**How a workload consumes it.** WRC mounts the broker token — a short-lived, recipe-bound JWT, rotated on the reconcile cadence — as a **read-only Secret volume** at `/var/run/clerum/oauth-broker/broker-token`, and sets `RECIPE_OAUTH_BROKER_TOKEN_FILE` to that path. Read the file fresh on each call (it's a *file*, not an env var, precisely so rotation propagates into a running pod without a restart). The broker route lives on the cluster-internal **`control-api` Service in the `control-plane` namespace**, port 8090:

```
POST http://control-api.control-plane.svc.cluster.local:8090/api/v1/recipe-oauth/token
  Authorization: Bearer $(cat $RECIPE_OAUTH_BROKER_TOKEN_FILE)
  Content-Type: application/json
  { "oauthClientId": "<id>" }

  → 200 { "accessToken": "...", "expiresAt": "..." }
  → 404 { "error": "no_grant" }                  operator hasn't connected it yet
  → 503 { "error": "integration_not_configured" } clientId/secret Secret missing
  → 502 { "error": "refresh_failed" }            provider rejected the refresh
  → 400 { "error": "unknown_oauth_client" }      not declared / not backgroundAccess
  → 429                                          per-recipe rate limit exceeded (Retry-After)
```

Use the returned `accessToken` for the outbound provider call. On a `401` from the provider, re-POST to the broker once and retry — the broker refreshes server-side, so a fresh token comes back without any client-side refresh logic. No token cache or refresh timer is needed; the provider access token lives only in the workload's process memory, never a Secret.

**Properties.** The refresh token and encryption key never leave control-api — the broker returns access tokens only. Deleting the `service` grant from the Integrations tab makes the broker return `404 no_grant` on the next call (immediate, fail-closed revocation; no Secret lingers). The broker token is `aud`-pinned to `oauth-broker` and `sub`-pinned to the recipe, so a workload can only ever request *its own* recipe's tokens. The broker route is rate-limited per recipe.

**Egress — what the platform handles vs what you declare.** The hop from your workload to the broker (`control-api` in `control-plane`) is **fully managed by the platform**: WRC emits `wf-<recipe>-oauth-broker-egress` for the opted-in workloads and the matching ingress rule sits on control-api. **Do not** add a `control-plane` / `control-api` entry to `egressBindings` — there is nothing for you to wire up for the broker call.

You are responsible only for the *second* hop: your workload → the provider's own API. That's an ordinary external dependency, no different from any other outbound call your code makes, and goes in `egressBindings` like any other:

```yaml
workloads:
  - id: sync-cron
    type: cronjob
    image: my-sync:latest
    oauthClientRefs: [microsoft-graph]
    egressBindings:
      - dns: graph.microsoft.com
        port: 443
```

---

## 8. Webhooks (`spec.webhooks[]`)

Declaring `spec.webhooks[]` provisions a dedicated **per-recipe webhook gateway pod** that:

1. Receives traffic at `<host>/api/v1/webhook/<recipeNs>/<recipeName>/<id>` via the cluster-shared **webhook-proxy** (separate from rpc-proxy; secrets-blind).
2. Verifies signatures against your declared scheme.
3. Optionally handles unsigned setup pings (Meta `hub.verify_token`, Slack URL verification).
4. Forwards verified bytes to your `workloadRef` in `sandbox-recipes`.

### 8.1 Schema

```yaml
webhooks:
  - id: provider-events          # DNS-1123, ≤ 63 chars, unique within recipe (W1)
    workloadRef: handler         # Must be a `type: deployment` workload with no transport (W2/W11)
    path: /events                # Forwarded path on the workload
    methods: [GET, POST]         # Default [POST]. POST is mandatory (W4). GET is
                                 # allowed ONLY with verification.setupHandshake (W13),
                                 # and REQUIRED by meta-hub-challenge (W14) — see below.
    maxBodyBytes: 1048576        # Default 1 MiB, max 10 MiB (W5)
    optional: true               # OPTIONAL — see §8.6 (dormant webhooks).
    cors:                        # OPTIONAL — see §8.7 (browser widgets).
      allowedOrigins:
        - https://widget.customer.example
        - http://localhost:9000
    verification:
      scheme: hmac-sha256-timestamp-body   # See §8.2
      secretRef:
        name: slack-creds
        key: webhook-signing-secret
      signatureHeader: X-Slack-Signature
      signaturePrefix: 'v0='
      signatureEncoding: hex     # hex | base64
      setupHandshake:            # OPTIONAL — nests INSIDE verification (NOT a webhook-level sibling). See §8.3
        strategy: meta-hub-challenge
        secretRef: { name: meta-creds, key: hub-verify-token }
    replay:                      # REQUIRED iff scheme == hmac-sha256-timestamp-body (W8)
      timestampHeader: X-Slack-Request-Timestamp   # required
      toleranceSec: 300                            # required; int 10–3600, default 300
```

This is a **field-shape reference, not a copy-paste provider recipe** — it deliberately shows every key at once (Slack-style HMAC headers alongside a Meta handshake). A real webhook picks one provider's headers and one handshake strategy (or none). See §8.2/§8.3 for per-provider shapes.

`verification` accepts exactly: `scheme`, `secretRef`, `signatureHeader`, `signaturePrefix`, `signatureEncoding`, `tokenHeader`, `tokenPrefix`, `jwksUrl`, `issuer`, `audience`, `setupHandshake`. The timestamp knobs are on `replay`, not here — a `verification.timestampHeader` / `timestampToleranceSec` is rejected as an unknown field.

### 8.2 Verification schemes

| Scheme | When to use | Required fields |
|---|---|---|
| `hmac-sha256-body` | Signature is HMAC over raw body, no timestamp. (GitHub, Fireflies, Granola, WhatsApp Cloud API, Shopify, Linear.) | `secretRef`, `signatureHeader`, `signaturePrefix`, `signatureEncoding`. |
| `hmac-sha256-timestamp-body` | Signature is HMAC over `<timestamp>.<body>` with replay protection. (Slack, Twilio.) | All of the above PLUS a sibling `replay` block with `timestampHeader` + `toleranceSec` (both required; the timestamp is read from its own header). |
| `jwt-bearer-jwks` | Provider sends a JWT in `Authorization`; verify against JWKS. (Google PubSub push, Auth0/Okta, Meta enterprise.) | `jwksUrl` (https only, multi-label DNS host), `issuer`, `audience`. NO `secretRef`. |
| `static-bearer` | Shared static bearer token. Default is `Authorization: Bearer <token>`; set `tokenHeader` / `tokenPrefix` for providers that ship the token in a custom header (Telegram). TLS + low-stakes only — no replay protection, no body binding. | `secretRef`. Optional: `tokenHeader` (defaults to `Authorization`), `tokenPrefix` (defaults to `Bearer `; explicit empty string `""` means no prefix). |

All schemes:

- Verifier reads RAW body before any JSON / form parsing (signature is over bytes).
- Constant-time signature comparison.
- Content-Type agnostic (JSON, form-encoded, octet-stream all OK).
- Failure codes: `401 invalid_signature`, `408 timestamp_skew`, `405 method_not_allowed`, `413 body_too_large`, `404 webhook_not_found`, `400 invalid_webhook_id`, `503 gateway_busy`, `504 gateway_timeout`, `500 verifier_misconfigured`.

Gateway request-lifetime budgets (NOT recipe-tunable): 5 s header receive, 10 s body-idle, 30 s total, 256 in-flight per pod.

**`static-bearer` examples:**

```yaml
# Default shape — Authorization: Bearer <token>
webhooks:
  - id: zapier
    workloadRef: api
    methods: [POST]
    verification:
      scheme: static-bearer
      secretRef: { name: zapier-creds, key: bearer-token }
      # tokenHeader defaults to Authorization
      # tokenPrefix defaults to "Bearer "

# Telegram shape — value in a custom header, no prefix
  - id: telegram
    workloadRef: api
    methods: [POST]
    verification:
      scheme: static-bearer
      secretRef: { name: telegram-creds, key: secret-token }
      tokenHeader: X-Telegram-Bot-Api-Secret-Token
      tokenPrefix: ''   # explicit empty: the WHOLE header value is the token
```

The empty-string vs unset distinction is load-bearing: `tokenPrefix: ''` means "strip nothing — the header value IS the token"; omitting `tokenPrefix` means "use the default `Bearer ` prefix." Header names are case-insensitive (normalized to lowercase before lookup).

### 8.3 Setup handshakes (optional)

| Strategy | Provider | Behaviour |
|---|---|---|
| `meta-hub-challenge` | Meta (FB / IG / WhatsApp) | Answers unsigned `GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...` if token matches secret. |
| `slack-url-verification` | Slack Events API | Answers unsigned `POST { type: 'url_verification', challenge: '...' }` with `{ challenge }`. |
| `stripe-verify` | Stripe | Reserved no-op for providers with explicit "verify the endpoint" steps. |

`meta-hub-challenge` REQUIRES `GET` in `methods` (W13/W14). **`setupHandshake` nests inside `verification`** — it is NOT a top-level webhook field. A schema like `webhooks[].setupHandshake` will be rejected by the CRD with `unknown field "spec.webhooks[N].setupHandshake"`.

```yaml
methods: [GET, POST]
verification:
  scheme: hmac-sha256-body
  secretRef: { name: meta-creds, key: app-secret }
  signatureHeader: X-Hub-Signature-256
  signaturePrefix: 'sha256='
  signatureEncoding: hex
  setupHandshake:                                  # ← under verification, NOT under the webhook entry
    strategy: meta-hub-challenge
    secretRef: { name: meta-creds, key: hub-verify-token }
```

Without `setupHandshake`, every unsigned request → 401.

### 8.4 What the handler receives

POSTed to `http://<workload-id>.<recipeNs-or-sandbox>.svc.cluster.local:<port><path>`:

- Exact bytes the provider sent (no body parsing on gateway).
- `X-Clerum-Webhook-Id: <recipeNs>/<recipeName>/<id>` header.
- Original `Content-Type` header preserved.
- NO `Authorization` (stripped — reaching the workload IS proof of verification).
- NO identity headers — webhooks are system-to-system. Map "provider account → Clerum user" in your own state.

### 8.5 Trust model

| Boundary | Control |
|---|---|
| Internet → webhook-proxy | Public TLS, cluster-level rate limit, method + body-size pre-check, optional exact-origin CORS (§8.7) |
| webhook-proxy → gateway | NetworkPolicy: only webhook-proxy pods may ingress on gateway |
| gateway → handler | NetworkPolicy: only this recipe's gateway may ingress on handler |
| gateway secrets | Projected Secret volumes mounted ONLY in this gateway pod |

webhook-proxy is shared but secret-blind. Compromising it gives a routing oracle but no signing material. Compromising one gateway gives only that recipe's secrets.

### 8.6 Optional webhooks (dormant — deferred credentials)

Each `webhooks[]` entry accepts `optional: boolean` (default `false`). When `true`, a missing or empty referenced Secret no longer marks the recipe `degraded`. The webhook stays *dormant* and the gateway short-circuits inbound traffic with `410 Gone` + `X-Clerum-Webhook-State: dormant`; the Secret watcher transitions it to `active` automatically when the operator creates the Secret.

```yaml
webhooks:
  - id: fireflies
    workloadRef: api
    path: /webhook/fireflies
    optional: true                           # ← stays dormant until the Secret exists
    verification:
      scheme: hmac-sha256-body
      secretRef: { name: sales-crm-fireflies-webhook, key: signing-secret }
      signatureHeader: X-Hub-Signature-256
      signaturePrefix: 'sha256='
      signatureEncoding: hex
```

**What changes for each state:**

| Webhook state | Recipe phase | Inbound POST response | Operator action to advance |
|---|---|---|---|
| `optional: false` (default), Secret missing | `degraded` (fail-closed: gateway not scheduled) | n/a — nothing listens | Create the Secret. |
| `optional: true`, Secret missing | `active` (dormant) | **`410 Gone` + `X-Clerum-Webhook-State: dormant`** + `{ error: "integration_not_configured", integration, hint }` | Create the Secret — watcher triggers a debounced reconcile (~10s), gateway rolls, entry transitions to active. |
| Any, Secret + key resolve | `active` | Normal verifier → upstream → handler workload | n/a. |

**Why 410 (not 503):** provider retry behaviour. Meta / Fireflies / Slack treat `5xx` as transient and retry with exponential backoff — that fills control-plane logs with retry storms for never-configured integrations. `410 Gone` is terminal for most providers; they pause until the recipe author triggers a new test event after configuring the Secret. The dormant-state response header lets ad-hoc `curl` probes distinguish "wrong webhookId" (`404 webhook_not_found`) from "configure me" (`410 + dormant`).

**Status conditions:**

- `WebhookSecretMissing=True` is reserved for REQUIRED webhooks with unresolved refs (fail-closed, same as today).
- `WebhookDormant=True` is set when ≥1 optional webhook is dormant. Info-level — does NOT contribute to `phase=degraded`. The message lists the dormant webhook ids and the Secret names the operator needs to create.

**Admission unchanged:** W7 still requires `secretRef` to be syntactically present even when `optional: true` — declaring intent ("this integration exists, it's just not configured yet") is the contract. Authoring `optional: true` without a `secretRef` block is rejected at admission.

**`meta-hub-challenge` + optional:** when a webhook with `verification.setupHandshake.strategy: meta-hub-challenge` is optional and EITHER `verification.secretRef` OR `setupHandshake.secretRef` is missing, the whole webhook is dormant (410 on every method). Re-resolving requires both refs to be present.

### 8.7 Browser CORS for webhook widgets

By default, a webhook is server-to-server only. If `cors` is omitted, or
`cors.allowedOrigins` is empty after validation, browser preflights return
`403 cors_origin_not_allowed` and real responses carry no `Access-Control-*`
headers.

When a recipe needs a browser widget to call a webhook URL directly, declare
the concrete widget origins:

```yaml
webhooks:
  - id: widget-events
    workloadRef: api
    path: /webhook/widget-events
    methods: [POST]
    cors:
      allowedOrigins:
        - https://widget.customer.example
        - http://localhost:9000
    verification:
      scheme: static-bearer
      secretRef: { name: widget-webhook, key: bearer-token }
```

CORS is enforced by the shared front-door `webhook-proxy`, before the
per-recipe gateway sees the request. The proxy only emits
`Access-Control-Allow-Origin` after the internal registry confirms that the
webhook exists and the request `Origin` is an exact allowlist match. Unknown
webhooks, malformed route segments, disallowed origins, and webhooks without a
CORS allowlist do not receive an origin echo.

Allowed origins are exact `scheme://host[:port]` strings. Wildcards, paths,
query strings, fragments, trailing slashes, and raw header patterns are not
accepted. `http://localhost:<port>` is valid for local widget development;
production widgets should use `https://` origins.

The proxy does not set `Access-Control-Allow-Credentials`; webhook widgets must
not depend on cookies. It also does not set `Access-Control-Expose-Headers`
today. Browser JavaScript can read the response body and CORS-safelisted
headers, but custom upstream headers remain hidden. If a future widget needs to
read custom response headers such as `X-Request-Id`, add an explicit
`cors.exposedHeaders` spec extension and proxy implementation rather than
implicitly exposing all upstream headers.

---

## 9. Egress — `spec.ui.egress` and `spec.bindings`

Platform default: **deny-all + DNS** for both `sandbox-ui` and `sandbox-recipes`. Every outbound flow must be declared.

There are four egress mechanisms and each only accepts a specific edge type. Pick the one that matches the edge you're declaring — using the wrong one fails reconcile (`spec.bindings[]` is the most common offender; see §9.3).

| Mechanism | Source pod | Destination | Generates |
|---|---|---|---|
| `spec.ui.egress.internal[]` (§9.1) | The UI workload (pod backing `spec.ui.workloadRef`). | A **non-MCP** sibling workload in `sandbox-recipes`. | NetworkPolicy in `sandbox-ui` permitting egress to the target. |
| `spec.ui.egress.external[]` (§9.2) | The UI workload. | External FQDN (no static CIDR). | NetworkPolicy in `sandbox-ui` permitting external egress. |
| `spec.bindings[]` (§9.3) | An MCP-transport workload **or** a non-transport workload. | The other side of the pair (exactly one transport endpoint). | NetworkPolicies connecting the MCP transport workload to its sibling. **Not** for arbitrary sibling-to-sibling links. |
| `workloads[].egressBindings[]` (§9.4) | Any non-UI, non-MCP workload. | External FQDN **OR** cluster-local sibling (`<id>.<ns>.svc.cluster.local`). | NetworkPolicy in the workload's namespace, plus a symmetric ingress policy on the sibling target when cluster-local. |

**Non-UI workload → non-UI sibling** (e.g. an API Deployment talking to a sibling Postgres StatefulSet, or a CronJob reading from a sibling cache) is handled by `egressBindings[]` — see §9.5 for the recipe pattern. Pre-`egressBindings` cluster-local support, this used to silently fail under `deny-all-<ns>` with an empty-logs SIGKILL.

### 9.1 `spec.ui.egress.internal[]` — sibling workloads

```yaml
ui:
  egress:
    internal:
      - { workloadRef: api, port: 8000 }     # Non-MCP sibling only (R17)
```

WRC generates a NetworkPolicy in `sandbox-ui` selecting the UI pod by 3 labels (`clerum.io/sandbox-ui=true`, `clerum.io/recipe-namespace=<ns>`, `clerum.io/recipe-name=<name>`) allowing egress to the target in `sandbox-recipes`. **MCP servers are not valid UI siblings** — route MCP from a non-UI backend.

`spec.ui.egress.internal[]` has a static CRD ceiling of 25 entries. Operators can lower the runtime limit for Control API preflight and WRC reconciliation with `CLERUM_WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS` (default 25, max 25).

### 9.2 `spec.ui.egress.external[]` — external destinations

```yaml
ui:
  egress:
    external:
      - { fqdn: 'api.openai.com', port: 443 }
```

Each entry MUST set `fqdn:` and `port:`. Static `cidr:` is not accepted — raw IPs aren't reviewable in PRs, freeze across vendor IP rotations, and could authorize cloud-metadata or sibling-tenant ranges that the RFC1918 carve-out doesn't trim (e.g. `169.254/16`). WRC resolves each FQDN to one `ipBlock` per A record and re-resolves periodically. RFC1918 (`10/8`, `172.16/12`, `192.168/16`) is trimmed from the policy via `except[]`. Wildcards NOT supported.

### 9.3 `spec.bindings[]` — MCP transport ↔ non-transport workload

`spec.bindings[]` is **not** a general sibling-to-sibling NetworkPolicy declaration. The reconciler enforces (`workflow-recipes/src/reconciler/workflowRecipeReconciler.ts:153-158`) that **exactly one endpoint** of each binding is an MCP transport workload (i.e. a workload with `transport:` set) and the other is a non-transport workload. A binding that connects two non-transport workloads — or two transport workloads — is rejected:

```
phase: failed
message: "Binding N: binding must connect exactly one MCP transport workload
          to one non-transport workload"
```

```yaml
workloads:
  - id: search-mcp
    type: deployment
    transport: { type: streamableHttp, path: /mcp }   # transport endpoint
    # ...
  - id: api
    type: deployment                                  # non-transport endpoint
    # ...
bindings:
  - { from: api, to: search-mcp, port: 3000, protocol: TCP }
```

Generates the NetworkPolicies the MCP transport workload needs to be reachable by its sibling.

**If you have two non-MCP workloads that need to talk** (e.g. an API Deployment and a Postgres StatefulSet, or a CronJob and a Postgres StatefulSet), `spec.bindings[]` is the wrong mechanism. See the table at the top of §9 for the alternatives.

### 9.4 `workloads[].egressBindings[]` — per-workload egress

The K8s-layer allowlist for any non-UI, non-MCP workload that needs outbound network access — either to an **external** service (public FQDN) or to a **cluster-local sibling** in this recipe. Max 20 entries per workload. The reconciler rejects CIDR notation, the bare `*` wildcard, and any `*.<domain>` form — every destination must be a concrete FQDN.

```yaml
workloads:
  - id: api
    type: deployment
    image: my-org/api:1.0.0
    egressBindings:
      # Cluster-local sibling (in this recipe) — resolves to a
      # namespaceSelector + sibling podSelector NetworkPolicy.
      - { dns: db.sandbox-recipes.svc.cluster.local, port: 5432, protocol: TCP }
      # External FQDNs — resolved to ipBlock CIDRs and re-resolved periodically.
      - { dns: api.anthropic.com,   port: 443, protocol: TCP }
      - { dns: api.fireflies.ai,    port: 443, protocol: TCP }
      - { dns: graph.microsoft.com, port: 443, protocol: TCP }
      - { dns: graph.facebook.com,  port: 443, protocol: TCP }
```

| Field | Type | Notes |
|---|---|---|
| `egressClass` | `exact-host` \| `public-web`, optional | Defaults to `exact-host`. `public-web` opens public TCP 80/443 (private/special ranges blocked by NetworkPolicy) and **must not** declare `dns`, `port`, or `protocol`. |
| `dns` | string, 1–128 chars | Concrete FQDN. Required for `exact-host`. No CIDR (`/`), no `*`, no `*.<domain>`. Cluster-local form is `<workload-id>.<namespace>.svc.cluster.local`; anything else is treated as external. |
| `port` | integer, 1–65535 | Destination port. Required for `exact-host`. |
| `protocol` | `TCP` \| `UDP`, optional | Defaults to TCP. Only for `exact-host`. |

The CRD item has **no `required` list** — `dns`/`port` are mandatory only for the default `exact-host` class, and are forbidden on `public-web`.

**Cluster-local vs external dispatch.** WRC inspects the DNS string:

- **Cluster-local** (`<svc>.<ns>.svc.cluster.local`) → generates a NetworkPolicy egress rule with `namespaceSelector(<ns>) + podSelector(clerum.io/recipe=<thisRecipe>, clerum.io/workload=<svc>)`, and a **symmetric ingress** policy on the sibling target so authors do not have to re-declare in `spec.bindings[]`.
- **External** (any other FQDN) → resolved via the platform's FQDN resolver and emitted as an `ipBlock` egress rule with RFC1918 trimmed to actual subsets.

**Cross-recipe guard.** A cluster-local FQDN MUST resolve to a workload `id` in **this** recipe in the **expected namespace**. Pointing at a non-sibling workload (e.g. `db.sandbox-recipes.svc.cluster.local` when this recipe has no `db` workload, or `db.other-namespace.svc.cluster.local`) is rejected at reconcile time. Without this guard, a malicious recipe could name another recipe's Service and have the platform auto-grant itself ingress on that target.

**Generated policy names.** `wl-egress-<recipe>-<workload>` for source-side egress; `wl-ingress-<recipe>-<workload>` for sibling-side ingress. Both live in the workload's own namespace and fit within K8s' 63-char DNS-1123 limit (the recipe stem is truncated when needed).

**FQDN-resolution failure is soft.** Like `spec.ui.egress`, transient DNS failures keep the previously-resolved CIDR set in the NetworkPolicy and log a warning. The recipe does NOT degrade.

**When to use this vs. `spec.ui.egress.external[]`:**

| Surface | Selects | Use for |
|---|---|---|
| `workloads[].egressBindings[]` | Any non-UI, non-MCP workload pod in `sandbox-recipes`. | API backends, webhook handlers, cronjobs that call external APIs OR a sibling DB / cache in the same recipe. |
| `spec.ui.egress.external[]` (§9.2) | The pod backing `spec.ui.workloadRef` in `sandbox-ui`. | The embedded UI's own outbound traffic. UI workloads do NOT use `egressBindings`. |

**App-level allowlist as defense-in-depth.** Kubernetes NetworkPolicy egress only supports CIDR — external FQDN entries are resolved by WRC and periodically re-resolved, then translated to CIDR rules. If an IP rotates between resolves a compromised dependency could briefly reach a different host on the same IP. For recipes that handle credentials, layer an app-level FQDN allowlist (e.g. an `EGRESS_ALLOWED_HOSTS` env var enforced by a `safeFetch` wrapper) on top of `egressBindings`.

### 9.5 Non-UI workload → non-UI sibling (cluster-local egressBindings)

The §6.3 canonical shape (thin UI + sibling backend) means the credentialed pod is NOT the UI workload, and `spec.ui.egress.internal[]` opens only the UI's policy — not the backend's. `spec.bindings[]` doesn't help either (it requires exactly one MCP transport endpoint, §9.3). Sibling-to-sibling traffic in `sandbox-recipes` flows through `workloads[].egressBindings[]` (§9.4) using the cluster-local FQDN form.

```yaml
workloads:
  - id: api               # backend Deployment in sandbox-recipes
    type: deployment
    image: my-org/api:1.0.0
    egressBindings:
      # Sibling Postgres in the same recipe.
      - { dns: db.sandbox-recipes.svc.cluster.local, port: 5432, protocol: TCP }
      # Mix in external FQDNs as usual.
      - { dns: api.anthropic.com, port: 443, protocol: TCP }

  - id: followup          # cronjob hits the same DB
    type: cronjob
    image: my-org/api:1.0.0
    schedule: '*/15 * * * *'
    egressBindings:
      - { dns: db.sandbox-recipes.svc.cluster.local, port: 5432, protocol: TCP }

  - id: db
    type: statefulset
    image: postgres:16-alpine
    port: 5432
```

WRC emits:

- `wl-egress-<recipe>-api` and `wl-egress-<recipe>-followup` in `sandbox-recipes` allowing egress to `db`.
- `wl-ingress-<recipe>-db` in `sandbox-recipes` allowing ingress from `api` and `followup` (aggregated — one policy per receiver, not per pair).

Authors do NOT need to declare a corresponding `spec.bindings[]` entry — symmetric ingress is automatic for cluster-local egressBindings. The cross-recipe guard ensures another recipe cannot piggyback onto your `db` by spelling its FQDN.

**Failure signature when the egressBinding is missing.** If you forget to declare the sibling, the failure is hostile to debug:

| Layer | Symptom |
|---|---|
| App | `connect ETIMEDOUT <sibling-svc-ip>:<port>` in `pg.Pool.connect`, redis client, etc. |
| Process | Hangs in a pre-`listen()` call (migrations, warm cache). Port 8080 never opens. |
| Pod | Liveness probe gets `connection refused`. Three failures, kubelet sends SIGKILL. `lastState.terminated.exitCode = 137`, `reason: Error`. |
| Logs | **Empty** (`kubectl logs --previous` may show only `"shutting down"`). Node's line-buffered stdout never flushes before SIGKILL. |
| `kubectl describe` | `Liveness probe failed: Get "http://<podIP>:8080/healthz": dial tcp: connect: connection refused`. |

The empty-logs trap is what makes this expensive to diagnose. Trained instinct says "probe is wrong" — but the probe is fine; the process never bound the port. Always cross-check the `wl-egress-<recipe>-<workload>` NetworkPolicy exists for any workload that does pre-`listen()` I/O.

---

## 10. Steps (`spec.steps[]`) — workflow execution

Steps run inside the platform's workflow coordinator (a separate platform pod), NOT as pods you launch.

### 10.1 Two execution shapes (mutually exclusive)

```yaml
- id: my-step
  instruction: 'Do {{inputs.thing}}.'   # LLM-driven agentic
```

```yaml
- id: my-step
  run:                                   # Deterministic, inline TypeScript snippet
    type: snippet                        # only value accepted
    language: typescript                 # only value accepted
    code: |                              # inline source, ≤ 20,000 chars
      export default async function (ctx) {
        return { merged: { ...ctx.inputs } }
      }
    capabilities: {}                     # explicit allowlist — http / secrets / mongo / postgres / mcp / artifacts
```

`run` is snippet-only: the CRD requires `type: snippet` with `language` and `code` (message: `run must define type=snippet with language and code`). There is no registered-handler surface — no `handler:`, no `params:`. Anything a snippet reaches (HTTP hosts, Secrets, MCP tools, DBs, artifacts) must be declared under `run.capabilities`.

### 10.2 Template variables — the complete substitution vocabulary

Clerum has **two surfaces** that perform `{{...}}` substitution, and they support **different placeholders**. Authoring mistakes here are the #1 source of "looks right but nothing connects" bugs.

#### 10.2.1 Step instructions — agentic step text

Resolved at **run time**, immediately before each step is dispatched. Source: `mcp-host/src/workflow/*` + the coordinator's `resolveTemplateVars`.

| Placeholder | Resolves to |
|---|---|
| `{{inputs.KEY}}` | A value from `spec.inputContract.properties.KEY` (default or runtime input). |
| `{{stepId:output}}` | The previous step's `output` string, truncated to 50,000 chars. |

Unresolvable placeholders stay **literal** — the LLM sees `{{x:output}}` as raw text, no error. `dependsOn` orders execution; it does NOT inject data. If the next step needs the previous step's output, embed `{{prevStepId:output}}` in the instruction explicitly.

#### 10.2.2 Workload `env[].value`, `command[]`, `args[]` — pod-shaped resources

Resolved at **reconcile time** (before the Deployment / StatefulSet / CronJob / Job / DaemonSet is written to the cluster). Source: `workflow-recipes/src/reconciler/templateEngine.ts`. Unresolvable references **throw** `UnresolvedTemplateError` and fail the reconcile — they do NOT stay literal.

| Placeholder | Resolves to |
|---|---|
| `{{inputs.KEY}}` | Build-time input value (same as §10.2.1). |
| `{{workloadId:host}}` | The K8s Service FQDN of the sibling workload (`<id>.<namespace>.svc.cluster.local`). Use this for in-recipe service discovery — DO NOT hardcode DNS. |
| `{{workloadId:port}}` | The sibling workload's port, as a string. |
| `{{resourceId:KEY}}` | A value from a sibling `spec.resources[]` entry (ConfigMap key). |
| `{{computed.NAME}}` | A reconciler-computed value (rare; see §16). |

Example — wiring a Deployment to a sibling Postgres StatefulSet:

```yaml
workloads:
  - id: db
    type: statefulset
    image: postgres:16-alpine
    port: 5432
    # ...
  - id: api
    type: deployment
    image: my-org/api:1.0.0
    env:
      - { name: PG_HOST, value: '{{db:host}}' }   # → db.sandbox-recipes.svc.cluster.local
      - { name: PG_PORT, value: '{{db:port}}' }   # → "5432"
```

**Do NOT use `{{stepId:output}}` in `workloads[].env`** — workload env is resolved at reconcile time, before any step has run. Step outputs are only available inside step instructions.

### 10.3 Step fields

```yaml
- id: research                          # ^[a-z][a-z0-9-]*$
  instruction: '...'                    # OR `run: {...}`
  dependsOn: [other-step]               # Ordering only
  mcpServers: [search]                  # workload IDs of MCP servers callable
  allowedTools:                         # OBJECT — `include` array of server__tool names
    include: [search__web_search]
  maxIterations: 10
  timeoutSeconds: 300
  backoffSeconds: 5
  maxRetries: 2
  agent:                                # Optional per-step LLM override — model / provider / soul ONLY
    provider: claude                    # openai | claude | zai | bailian
    model: claude-3-opus
  requiresApproval:                     # OBJECT — required: [target, message]
    target: { userId: '<uuid-or-login>' }   # exactly one of userId | teamId
    message: 'Approve the publish step?'    # 1–2000 chars
    timeoutSeconds: 3600                    # optional; 30–604800, default 3600 (auto-reject on expiry)
```

`steps[].agent` has no `apiKeyRef` — provider credentials come from `spec.agent.secretRef`, not from the per-step override. `requiresApproval: true` is a type error; it must be the object shape above.

### 10.4 `inputContract` and `triggers`

```yaml
inputContract:
  required: [topic]
  properties:
    topic: { type: string, default: 'latest advances in multi-agent AI' }
    depth: { type: integer, default: 3 }
triggers:
  onDemand: {}                          # PRESENCE enables manual triggering (requiresApproval defaults true)
  schedule:
    cron: '0 9 * * 1'                   # Strict 5-field cron (R7)
```

`spec.triggers` has exactly two sub-fields — `onDemand` and `schedule` — and R6 requires at least one of them. There is no `manual:` field. Any recipe with non-empty `spec.steps` MUST declare one of the two (cluster ValidatingAdmissionPolicy `workflowrecipe-namespace-allowlist`).

### 10.5 Execution model — what actually runs

Steps are NOT pods you launch. When a recipe has `spec.steps`, WRC provisions a per-run **two-pod workflow runtime** in `sandbox-recipes`:

| Pod | Restart policy | Purpose |
|---|---|---|
| `wf-<name>-coordinator` | Never | Step scheduling loop ordered by `dependsOn`. Owns the run lifecycle. Talks to WRC (`/status`, `/configure-model`) and mcp_host (`/execute`, `/configure`). Health on `:8090`. |
| `wf-<name>-mcp-host` | Never | Executes per-step LLM calls + tool invocations against the `mcpServers` the step declared. |

Plus the supporting reconciled objects (all in `sandbox-recipes`):

- Secret `wf-<name>-coordinator-token` — two JWTs (`mcp-host-token`, `wrc-token`), 24 h TTL.
- ConfigMap `<name>-workflow-config` — steps + agent spec compiled at reconcile.
- ConfigMap `wf-<name>-soul-md` — workflow-level SOUL.md content.
- Headless Service `wf-<name>-mcp-host` (clusterIP: None).
- Four NetworkPolicies: coordinator↔mcp_host, coordinator→WRC (cross-ns), WRC→mcp_host (cross-ns), mcp_host→declared MCP servers.

**Cleanup**: WRC's finalizer (`reconcileDelete()`) is the sole cleanup mechanism — K8s 1.24+ forbids cross-namespace ownerRefs, so the GC cannot do it. DELETE returns 200 immediately; runtime pods + token Secret + NetworkPolicies are torn down within ~2–5 s.

### 10.6 Triggering, outputs, approvals

**Triggering** — `spec.triggers` declares how a run starts.

```yaml
triggers:
  onDemand:                             # PRESENCE enables ad-hoc runs from admin UI / API
    requiresApproval: true              # default true
    allowedActors: [user]               # user | autonomous | scheduled (default [user])
  schedule:
    cron: '0 9 * * 1'                   # cron-driven runs (R7: strict 5-field)
```

The cron path is reconciled into a WRC-managed CronJob (one per recipe with a `schedule`). The on-demand path is initiated through control-api's admin recipe endpoints — see §16 (`control-api/src/routes/admin/recipes.ts`) for the exact route, as the surface is not stabilised in this guide.

**Reading run state** — each run patches `.status.workflowExecution.phase` on the recipe through `running → completed | failed`:

```bash
kubectl get workflowrecipe <name> -n sandbox-recipes \
  -o jsonpath='{.status.workflowExecution.phase}'
```

A run reaches a terminal phase whenever the coordinator pod itself reaches a terminal state — `failed` is the expected phase if e.g. the LLM API key is a stub. Successful completion requires real provider creds.

**Where step output goes** — two consumers exist today:

1. **The next step**, via `{{stepId:output}}` template substitution (50 KB cap per substitution — §10.2). This is the supported in-recipe data-flow path.
2. **Coordinator pod logs**, the canonical sink for human inspection:

   ```bash
   kubectl logs -n sandbox-recipes wf-<name>-coordinator
   kubectl logs -n sandbox-recipes wf-<name>-mcp-host
   ```

The top-level `spec.output` field listed in §2 (`stdout | configmap | pvc | secret`) is declared on the CRD as forward-looking surface for externalising results. Verify what WRC honours today against §16 (`workflow-recipes/src/workflow/*`, `mcp-host/src/workflow/*`) before relying on it in a recipe.

**Approvals** — a `requiresApproval: { target, message }` block on a step pauses the coordinator before that step executes; the request routes to `target.userId` (or every member of `target.teamId`) and auto-rejects as expired after `timeoutSeconds` (default 3600). The approval-delivery channel (admin UI prompt vs RPC vs message channel) is not part of the recipe surface; it lives in the coordinator's RPC client. See §16 (search `rpcClient` and `approval` in `workflow-recipes/src/coordinator.ts`).

**Retry semantics** — `maxRetries` / `backoffSeconds` / `timeoutSeconds` on a step bound **that step's** retry loop within a single run. There is no recipe-level "retry the whole workflow" knob; re-running the workflow is a fresh trigger and a new pair of coordinator/mcp_host pods.

---

## 11. CRD validation rules (what gets your recipe rejected)

Rejection messages cite the rule code. CEL is strict — fix locally before applying.

### 11.1 Recipe-wide

| Code | Rule | Why |
|---|---|---|
| R1 | `spec.agent` requires non-empty `spec.steps` | No agent config without a workflow. |
| R2 | At least one of `workloads` / `steps` non-empty | Empty recipe reconciles to nothing. |
| R3 | Each `steps[].id` unique | Step graph key. (Duplicate **workload** ids are caught by the reconciler, not CEL.) |
| R4/R5 | `spec.scheduling` requires `steps`; `scheduling.cron` is a valid 5-field cron | Coordinator parses strict 5-field grammar. |
| R6 | `spec.triggers` declares at least one of `onDemand` / `schedule` | A trigger block that triggers nothing is dead config. |
| R7 | `triggers.schedule.cron` valid 5-field cron | Same grammar as R5. |
| R8/R9/R10 | Step shape: `run` and `instruction` mutually exclusive; exactly one of them unless `spec.coordinatorImage` is set; `run` and `agent` mutually exclusive | One executor per step. |
| R11–R14 | Snippet rules: no wildcards in `run.capabilities.mcp.allowedTools.include`; snippet MCP servers require an explicit `allowedTools.include`; snippet HTTP hosts must be declared in `spec.runtimeEgress.http.allowedHosts` (`exact-host`) or use `public-web` with no `allowedHosts` | Explicit-allowlist egress + tool policy. |
| R15 | `ui.workloadRef` references existing `workloads[].id` | Cross-spec consistency. |
| R16 | UI workload MUST be `type: deployment`, `replicas: 1`, no `transport` | Sandbox-UI proxy assumptions. |
| R17 | `ui.egress.internal[].workloadRef` is non-MCP | UI must call its own backend, not MCP. |
| R18 | `ui.defaultPath` has no scheme prefix (field regex also enforces the leading `/` and blocks `//`) | Prevents `javascript:`/`data:`/`file:` smuggling. |

There is **no CEL rule forbidding `envSecret` / `imagePullSecrets` on the UI workload** — it is admitted and then fails at runtime with `CreateContainerConfigError`, because `sandbox-ui` has no Secrets (§6.3). Don't do it; just don't expect admission to stop you.

### 11.2 Webhook (W*)

| Code | Rule |
|---|---|
| W1 | `webhooks[].id` DNS-1123 ≤ 63, unique. |
| W2 | `workloadRef` is a non-MCP `type: deployment` workload — no other workload type is accepted (WRC-level, surfaces as `WebhookHandlerInvalid` condition). |
| W3 | `path` matches strict regex (no `..`, no `//`, no whitespace, allows `/.well-known`). |
| W4 | `methods` ⊆ {POST, GET}; POST mandatory. |
| W5 | `maxBodyBytes` ∈ [1024, 10485760]. |
| W6 | `verification.scheme` enum. |
| W7 | `secretRef` required for all schemes except `jwt-bearer-jwks`. `optional: true` (§8.6) does NOT relax this — the field must still be syntactically present; "optional" only means the referenced Secret is allowed to be absent at install time. |
| W8 | `replay` required iff scheme is `hmac-sha256-timestamp-body`. |
| W9 | `jwksUrl`/`issuer`/`audience` required iff scheme is `jwt-bearer-jwks`. |
| W10 | Header names match `^[a-zA-Z][a-zA-Z0-9-]{0,63}$`. |
| W11 | `replay.toleranceSec` ∈ [10, 3600] (default 300). |
| W12 | `jwksUrl` https only, multi-label DNS host (no IPs, no localhost). |
| W13/W14 | `setupHandshake.strategy: meta-hub-challenge` requires `secretRef` AND `GET` in `methods`. |
| W15 | `cors.allowedOrigins[]` entries are exact `http(s)://host[:port]` origins, max 32 entries; no wildcards, paths, query strings, fragments, or trailing slashes. Omitted/empty CORS means server-to-server only. |

### 11.3 OAuth (O*)

| Code | Rule |
|---|---|
| O1 | `oauthClients` requires **either** `spec.ui` **or** a `workloads[].oauthClientRefs` consumer for every declared client. (A UI-less background-OAuth recipe — §7.5 — is legal.) |
| O2 | `provider` enum (5 known). Field-level enum, not a CEL rule. |
| O3 | `oauthClients[].id` unique. |
| O4 | `workloads[].oauthClientRefs` is not allowed on MCP transport workloads. |

Enforced by the WRC reconciler (not CEL, so the rejection arrives as a status condition rather than at `kubectl apply`): `backgroundAccess: true` requires `scopes` to include the provider's offline/refresh scope (`refresh_token` Salesforce, `offline_access` Microsoft Graph — §7.5), and `oauthClientRefs[]` must resolve to declared `backgroundAccess` clients.

### 11.4 Egress (E*)

| Code | Rule |
|---|---|
| E1 | Each `ui.egress.external[]` entry sets `fqdn` (and `port`). Static `cidr:` is rejected at admission. |
| E2 | `workloads[].egressBindings[].dns` is a concrete FQDN — no CIDR (`/`), no `*`, no `*.<domain>`. |
| E3 | A cluster-local `egressBindings[].dns` (`<svc>.<ns>.svc.cluster.local`) MUST resolve to a workload `id` in THIS recipe AND target the namespace that workload reconciles into. Cross-recipe and cross-namespace cluster-local references are rejected at reconcile time — they would otherwise let one recipe auto-grant itself ingress on another recipe's Service. |

Plus field-level patterns: `metadata.name` DNS-1123 ≤ 63, `workloadRef` DNS-1123 ≤ 63, `port` ∈ [1, 65535], `icon` data URI regex, `defaultPath` regex.

---

## 12. Common pitfalls

| Mistake | Symptom | Fix |
|---|---|---|
| `metadata.namespace: sandbox-ui` (or `mcp-server`) | Admission rejects. | Always `sandbox-recipes`. |
| `spec.oauthClients` with neither `spec.ui` nor any `workloads[].oauthClientRefs` consumer | Admission rejects (O1). | Add `ui`, wire the client into a workload's `oauthClientRefs`, or remove the client. |
| Inline `<script>` in embed HTML | CSP error in DevTools. | External same-origin `.js`. |
| nginx serves `.js` as `application/octet-stream` | Browser refuses script under CSP. | Add `types { application/javascript js; ... }` to nginx config. |
| HTML uses absolute paths like `<script src="/static/app.js">` or `fetch('/api/...')` | Shell loads (200), JS bundle 404s, React renders an empty `<div id="root">`. rpc-proxy returns 404 because absolute paths resolve outside the `/api/v1/sandbox-ui/<ns>/<name>/view/` mount and rpc-proxy doesn't rewrite response bodies (§6.6). | Add `<base href="./">` to `<head>` AND use relative paths (`./static/app.js`, `fetch('./api/...')`) consistently across HTML, fetch calls, and CSS `url()`. `<base>` covers HTML attributes; absolute paths constructed inside JS need to be made relative in the source. |
| `dependsOn` without `{{stepId:output}}` | Later LLM step sees nothing from earlier. | Embed placeholder literally. |
| ConfigMap-mounted file via `volumeMounts` | Empty `emptyDir`; file missing. | Write file at startup via `command:` bootstrap. |
| `ui.port: 80` / `443` / `22` | Admission OK but runtime `502 port_not_allowed`. | Use 8080. |
| `ui.egress.external` uses `*.slack.com` | FQDN resolution empty; NetworkPolicy empty. | Wildcards unsupported — declare each subdomain. |
| `hmac-sha256-timestamp-body` without `replay:` | Admission rejects (W8). | Add `replay: { timestampHeader: <Header>, toleranceSec: 300 }`. |
| `meta-hub-challenge` without `GET` in methods | Admission rejects (W14). | `methods: [GET, POST]`. |
| OAuth secret missing | `/oauth/authorize-url` returns 503 `integration_not_configured`. NOTE: `/oauth/token` does **not** — with no grant it returns `404 no_grant` and never reads the Secret (§7.2.1). | Create K8s Secret in `sandbox-recipes`. |
| UI workload declares `envSecret` | Admission ACCEPTS it (no CEL rule blocks this), then the pod sticks in `CreateContainerConfigError`: `secret "X" not found`, even though the Secret exists in `sandbox-recipes`. UI workloads run in `sandbox-ui`, which has no Secrets (§6.3). | Split the recipe: thin UI workload (no creds) + sibling backend workload in `sandbox-recipes` that owns the `envSecret`. Wire them with `spec.bindings[]`. |
| OAuth callback `400 invalid_recipe_namespace` | Recipe in wrong namespace. | Use `sandbox-recipes`. |
| Workload runs as root | Image entrypoint requires root (`nginx:alpine` etc). | Switch to non-root variant or set `security.runAsUser`. |
| StatefulSet PVC mount fails to chown | `fsGroup` missing. | Set `fsGroup` = `runAsGroup`. |
| OAuth refresh fails after weeks | Provider rotated secret or user revoked. | `/oauth/token` returns 502 `refresh_failed`; show Reconnect UI. |
| Embed stuck on "still updating" | Pod not Ready. | Check `healthCheck` returns 2xx; binding `0.0.0.0:8080`. |
| `window.open('/foo')` opens OS browser | `setWindowOpenHandler` always denies. | Use `location.assign` or `<a href>`. |
| Download click does nothing | `will-download` prevented. | Render content inline. |
| Cross-user data leak | Trusted client-supplied identity. | Always read `X-Clerum-User` server-side. |
| `503 recipe_not_ready` | Pod rolling. | Wait — embed auto-refreshes every 5 s. |
| Pod `CrashLoopBackOff`, `exitCode 137`, **empty logs**, `Liveness probe failed: ... connection refused`. | Process is doing pre-`listen` work (migrations, warm cache) and gets SIGKILL'd before binding. Node line-buffers stdout, so the buffer never flushes. | Move pre-listen work to a background task, or widen the `healthCheck` budget (§4.6 — there is no `startupProbe` field). Check §9.5 first — most often the pre-listen call is a DB connect that's being dropped by `deny-all-<ns>`. |
| Workload `ETIMEDOUT` to a sibling Service in the same namespace. | No first-class field opens non-UI → non-UI sibling traffic; `deny-all-<ns>` drops it. | Add `egressBindings[]: { dns: <sibling>.<ns>.svc.cluster.local, port: <p> }` on the **calling** workload. See §9.5. |
| Single-image recipe split into UI + backend; suddenly third-party APIs fail with `ETIMEDOUT`. | `spec.ui.egress.external[]` only opened egress for the UI pod; after split the credentialed pod is no longer the UI pod. | Move every external FQDN to the backend's `egressBindings[]`. See §12.7. |

### 12.7 Migrating from single-image to UI + backend split

The canonical sandbox-UI shape is "thin static-asset UI pod + sibling credentialed backend" (§6.3). Recipes that start as a single image bundling both will eventually hit one of the following: a Secret they can't safely give the UI pod, a CSP rule they can't satisfy from a Node server, or a credentialed dependency they want to keep off the UI's network surface. This worked example covers the exact mechanical changes — every one of these has bitten real recipes.

**Image-level changes.**

| Before | After |
|---|---|
| `Dockerfile` builds Node app, copies bundled UI assets into `public/`, serves both. | `api/Dockerfile` (Node + Fastify, no statics) and `ui/Dockerfile` (multi-stage: build the bundle in Node, copy `public/` into `nginxinc/nginx-unprivileged:1.27-alpine`). |
| Server registers `@fastify/static` and a `/` route. | Server keeps only `/api/*`, `/webhook/*`, `/healthz`. Drop the static plugin entirely. |
| One image, one repo tag. | Two repos: `<org>/<name>-api:<tag>` and `<org>/<name>-ui:<tag>`. Both must satisfy §14.2 / §17.2 separately. |
| UI assets reference `/static/app.js`, `/static/styles.css`. | nginx config in the UI image serves `/static/` from `/usr/share/nginx/html/` AND reverse-proxies `/api/` to `http://${API_HOST}:${API_PORT}` (use `envsubst` templates so the FQDN is recipe-injected). |

**Recipe changes — the bug-prone half.**

1. **Repoint `spec.ui.workloadRef`** from the credentialed workload to the new UI workload.
   ```diff
    ui:
   -  workloadRef: api
   +  workloadRef: ui
   ```

2. **Redistribute external egress** out of `spec.ui.egress.external[]` and into the credentialed workload's `egressBindings[]`.
   ```diff
    ui:
      workloadRef: ui
   -  egress:
   -    internal:
   -      - { workloadRef: db, port: 5432 }       # was: api → db (api was the UI)
   -    external:
   -      - { fqdn: api.anthropic.com,   port: 443 }
   -      - { fqdn: graph.microsoft.com, port: 443 }
   +  egress:
   +    internal:
   +      - { workloadRef: api, port: 8080 }       # ui (nginx) reverse-proxies /api/* → api

    workloads:
      - id: api
        type: deployment
   +    egressBindings:
   +      - { dns: db.sandbox-recipes.svc.cluster.local, port: 5432, protocol: TCP }  # §9.5
   +      - { dns: api.anthropic.com,   port: 443, protocol: TCP }
   +      - { dns: graph.microsoft.com, port: 443, protocol: TCP }
   ```

3. **Audit every sibling cronjob.** A `followup` cron that previously talked to db via "we're in the same namespace and the api was the UI" now needs its own `egressBindings[]` for the db FQDN — and for any external FQDN it calls.

4. **Add a `ui` workload entry.**
   ```yaml
   workloads:
     - id: ui
       type: deployment
       image: docker.io/<org>/<name>-ui:<tag>
       port: 8080
       env:
         - { name: API_HOST, value: '{{api:host}}' }    # template var, §10.2
         - { name: API_PORT, value: '{{api:port}}' }
       healthCheck:
         type: http
         path: /healthz
         port: 8080
   ```

5. **Re-verify the constraints the platform applies only to UI workloads.** The new `ui` workload now hits R16 (`type: deployment`, `replicas: 1`, no `transport`) at admission. The old "I'll just put Secrets on the UI workload" shortcut stops working — not because admission blocks it (no CEL rule does, §11.1), but because `sandbox-ui` has no Secrets, so the pod sticks in `CreateContainerConfigError`. That's the credential boundary at §6.3.

**Migration checklist.**

- [ ] No `envSecret` or `imagePullSecrets` on the new UI workload (not admission-enforced — it fails at the pod layer, §11.1).
- [ ] Every external FQDN that the old UI workload reached now lives in **some workload's** `egressBindings[]` — not in `spec.ui.egress.external[]`.
- [ ] Every sibling in `sandbox-recipes` the backend talks to is in the backend's `egressBindings[]` as `<id>.<ns>.svc.cluster.local` (§9.5).
- [ ] `spec.ui.workloadRef` points at the new UI workload.
- [ ] `spec.ui.egress.internal[]` points at the backend (so the UI's nginx can reverse-proxy `/api/*`).
- [ ] Backend image's `/healthz` route survives the split — it was previously colocated with the static-serving handler, and we've seen it accidentally removed alongside the `/` index route.
- [ ] Bump the image **tag** (semver major if any installs already exist) — re-publishing the same tag with different bits violates §14.6 immutability.

**Common post-split failure modes** (all real):

| Symptom | Root cause |
|---|---|
| Backend pod `CrashLoopBackOff`, `ETIMEDOUT` to db. | Forgot step 2 — db's egress entry stayed on `spec.ui.egress.internal[]`. |
| Backend's third-party calls fail with `ETIMEDOUT`. | Forgot step 2 — external FQDNs stayed on `spec.ui.egress.external[]`. |
| UI pod `Running`, embed renders blank. | nginx `/api/*` proxy works but backend is in CrashLoop — backend's empty logs send you on a wild goose chase. Always check **both** namespaces' pods first. |
| `kubectl get pods -n sandbox-ui` empty, embed loads "recipe updating" forever. | `spec.ui.workloadRef` still points at the deleted/renamed old workload. |
| Webhook pod gets traffic but returns 503 `integration_not_configured`. | Webhook workload now runs in `sandbox-recipes` with no `envSecret` — the credentialed env vars are still on the old workload, which is being phased out. |

---

## 13. Install / manage / uninstall

> **The Control UI is the canonical operator surface.** Every cluster-operator action — browsing the registry, installing a recipe, provisioning Secrets, granting users access, viewing runtime state, uninstalling — is reachable from the UI without ever running `kubectl`. The UI surfaces (recipe detail page Workloads / Conditions / Secrets / Members tabs, the registry catalog detail pages, the `/secrets` Secrets page, the publisher at `/registry/publish`) are the supported path. Reach for `kubectl` only when the UI can't yet expose what you need: cluster-wide pod state, raw events, or NetworkPolicy debugging. The bash blocks in the rest of this section are documented for **scripting / CI / advanced troubleshooting**, not because they're the recommended day-to-day workflow.

| Action | Control UI path | kubectl fallback (advanced) |
|---|---|---|
| Browse the catalog | `/registry` | n/a — registry is HTTP-only. |
| Inspect a registry entry (description, source repo, images, CTAs) | Click a row in the catalog → `/registry/entries/[name]/[version]` | n/a |
| Install a recipe | Catalog row → **Install** → confirm in `/workflow-recipes` | `kubectl apply -f recipe.yaml -n sandbox-recipes` |
| Edit a recipe in-place | `/workflow-recipes/[ns]/[name]?edit=1` | `kubectl edit workflowrecipe …` |
| Uninstall a recipe | Recipe detail → kebab → **Uninstall** | `kubectl delete workflowrecipe …` |
| Create / edit / delete recipe Secrets | `/secrets/recipe`, or the recipe's **Secrets** tab | `kubectl create secret generic …` |
| Grant users access | Recipe detail → **Members** tab | n/a — grants are not raw K8s objects |
| Publish a recipe to the catalog | `/registry/publish` | n/a — publishing goes through the registry API |
| View recipe runtime / pod state / conditions | Recipe detail → **Workloads** / **Conditions** | `kubectl describe workflowrecipe …`, `kubectl get pods -A -l clerum.io/recipe=…` |
| Trigger a run | Recipe detail → **Run…** button | n/a |

### 13.1 RBAC prerequisite

`control-api` ServiceAccount needs:

- `mcp-server` ns: Role `control-api-mcp-resources` covering `contexts`, `mcpservers`, `workflowrecipes` — `deploy/base/mcp-server/rbac.yaml`.
- `sandbox-recipes` ns: Role `control-api-workflow-recipes-sandbox` for `workflowrecipes` — `deploy/base/sandbox-recipes/rbac.yaml`.

Both are part of the `deploy/base` kustomize bases (each namespace's `kustomization.yaml` lists `rbac.yaml`) and are applied with the rest of the deployment manifests. Without them, all `/api/v1/admin/recipes` calls return 500.

### 13.2 Install via Control UI (recommended)

This is the canonical operator path. Open `/registry`, find the recipe, click **Install** from either the catalog row or the entry detail page. The UI walks you through:

1. **INPUT** — pre-filled JSON in the editor (Install flow auto-loads the registry entry's YAML).
2. **VALIDATE** — client-side JSON parse → schema check → security compliance (`runAsUser ≥ 1`, capability allowlist).
3. **DEFAULTS** — optional **Apply Operator Defaults** (resource limits, namespace assignment by `transport`, pull secrets).
4. **CONFIRM** — **Deploy Recipe**.

Same UI handles in-place edits (`/workflow-recipes/[ns]/[name]?edit=1`), uninstalls (recipe detail → kebab → **Uninstall**), Secrets management (recipe detail → **Secrets** tab, or `/secrets/recipe`), and access grants (recipe detail → **Members** tab).

### 13.3 Install via API (scripting / CI only)

> Use this path for CI pipelines, bulk operations, or scripting. For one-off installs, use the Control UI (§13.2). Manual `kubectl` / `curl` paths bypass the UI's pre-flight validation, defaults, and audit trail.

```bash
TOKEN=$(curl -s -X POST http://localhost:8090/api/v1/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<password>"}' | jq -r '.token')

curl -s -X POST http://localhost:8090/api/v1/admin/recipes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @recipe.json | jq .
```

API routes (all require `Authorization: Bearer <admin_jwt>`):

| Method | Route |
|---|---|
| `GET` | `/api/v1/admin/recipes` |
| `POST` | `/api/v1/admin/recipes` |
| `GET` | `/api/v1/admin/recipes/:name` |
| `PUT` | `/api/v1/admin/recipes/:name` |
| `DELETE` | `/api/v1/admin/recipes/:name` |
| `POST` | `/api/v1/admin/recipes/validate` |
| `GET` | `/api/v1/admin/recipes/:name/status` |

### 13.4 Diagnostics

**Start in the Control UI.** The recipe detail page (`/workflow-recipes/[ns]/[name]`) carries everything the day-to-day operator needs:

- **Workloads tab** — every pod's phase / restarts / age / detail message across `sandbox-recipes` / `sandbox-ui` / `mcp-server`, joined with the reconcile-side `status.workloads[].ready` so the "WRC applied but kubelet broke it" gap is visible.
- **Conditions tab** — `WebhookSecretMissing`, `WebhookDormant`, `WebhookHandlerInvalid`, `WebhookGatewayNotReady`, `WebhookJwksFetchFailed`, each as a chip with `reason` + `message`.
- **Secrets tab** — every referenced `envSecret.name`, joined with what's actually provisioned in `sandbox-recipes`, with **Missing** chips + **Add** buttons that drop you into the prefilled secret-create flow.
- **Runs tab** — workflow run history with click-through.

Drop to `kubectl` when the UI doesn't surface what you need — typically raw events, NetworkPolicy debugging, or controller logs:

```bash
kubectl get workflowrecipes -A
kubectl describe workflowrecipe <name> -n sandbox-recipes
kubectl get networkpolicies -n sandbox-recipes
make minikube-logs SVC=workflow-recipes NS=control-plane
```

> Finalizer note: DELETE returns 200 immediately, but the resource may persist briefly while finalizers run (~2-5 s).

### 13.5 Reading `.status`

The recipe's `.status` subresource carries three coordinates: top-level fields for reconciliation health, `conditions[]` for per-feature signal, and `workloads[]` for per-workload reconcile result. This is the first place to look when something does not behave as the spec implies — but mind the gap between reconcile-level reporting and actual pod readiness (§13.5.1).

```yaml
status:
  phase: degraded                       # 13-state enum: candidate | pending-approval | approved | pending |
                                        # pending-operator-input | deploying | testing | active | degraded |
                                        # rolling-back | failed | deprecated | rollback-failed.
                                        # The healthy terminal phase is `active` — there is no `ready`.
  message: "Webhook gateway disabled: webhooks[fireflies].secretRef 'sales-crm-fireflies-webhook' not found ..."
  conditions:
    - type: WebhookSecretMissing
      status: 'True'
      reason: SecretMissing
      message: "webhooks[fireflies].secretRef 'sales-crm-fireflies-webhook' not found in namespace 'sandbox-recipes'"
      lastTransitionTime: 2026-05-11T12:57:02.553Z
    - type: WebhookHandlerInvalid
      status: 'False'                   # False here means "all good"
      reason: WorkloadRefValid
      message: "workloadRef references resolve"
      lastTransitionTime: 2026-05-11T12:57:02.553Z
  workloads:                            # per-workload reconcile result
    - { id: api,       type: deployment,   phase: deployed, ready: true }
    - { id: db,        type: statefulset,  phase: deployed, ready: true }
    - { id: followup,  type: cronjob,      phase: deployed, ready: true }
  workflowExecution:                    # only when spec.steps is set
    phase: completed                    # pending | initializing | running | recovering | completed | failed | cancelled
```

**Condition schema** — standard K8s shape: `{type, status, reason, message, lastTransitionTime}`. `status` is `True | False | Unknown`; for problem-condition types like `WebhookSecretMissing` and `WebhookHandlerInvalid`, **`status: False` is the healthy form** — it means "this problem is not present." Always read condition meaning by `(type, status, reason)`, not by `type` alone. Per-feature detail (e.g. *which* webhook is broken) goes into `message`.

#### 13.5.1 `.status.workloads[].ready` is NOT pod readiness

`workloads[].ready: true` means **WRC successfully applied the workload's K8s manifest** (Deployment / StatefulSet / CronJob / Job / DaemonSet was accepted by the API server). It does NOT mean any pod is actually running. Pods can be in `ImagePullBackOff`, `CreateContainerConfigError`, `CrashLoopBackOff`, or stuck pre-sandbox while `workloads[].ready` still reports `true` and `.status.phase` is `degraded` or even `active`.

The WRC also does NOT propagate kubelet-level failures into `.status.conditions[]`. Pod-level problems must be diagnosed at the pod layer:

```bash
kubectl get pods -n sandbox-recipes
kubectl describe pod <pod-name> -n sandbox-recipes
kubectl logs <pod-name> -n sandbox-recipes
```

Failure modes that surface ONLY at the pod layer (not in WRC status):

| Pod-level failure | Likely cause | Where it surfaces |
|---|---|---|
| `ImagePullBackOff` / `ErrImagePull` | Image not publicly pullable; missing `imagePullSecrets`; image truly doesn't exist. | Pod events, container `state.waiting.message`. |
| `CreateContainerConfigError` | A **required** `envSecret` key references a missing Secret or missing key. (Keys marked `optional: true` are skipped at reconcile time — see §4.1.1 — so they never reach this state.) | Pod events: `secret "X" not found` / `couldn't find key K in Secret X`. |
| `CrashLoopBackOff` | App crashes on startup — usually unresolved env vars, bad config, DB unreachable. | Pod logs. |
| Stuck in `ContainerCreating` past sandbox setup | CNI plugin failure, missing PVC, fsGroup mismatch, missing mount target. | Pod events. |

Required-webhook Secret problems are the **only** Secret-presence check WRC performs eagerly enough to set a `degraded` condition; **optional** webhooks (`optional: true`, §8.6) surface as a non-degraded `WebhookDormant` condition and the gateway short-circuits to `410 integration_not_configured` until the Secret appears. Missing OAuth `clientIdRef` / `clientSecretRef` Secrets are NOT eagerly checked — they surface at use-time as `503 integration_not_configured` from the OAuth endpoints (§7.2.1). Missing **required** `envSecret` Secrets surface as runtime pod failures (`CreateContainerConfigError`) — not reconcile conditions. Missing **optional** `envSecret` keys (`optional: true`, §4.1.1) are projected as "env var omitted" and the workload runs normally; creating the Secret later triggers a debounced reconcile that gains the env var via a rolling pod restart.

**Known condition types (today):**

| Type | When set | Operator action |
|---|---|---|
| `WebhookSecretMissing` | A **required** webhook `secretRef` resolves to a missing Secret/key. Gateway is NOT scheduled (fail-closed). | Create the K8s Secret in `sandbox-recipes` with the named key. |
| `WebhookDormant` | At least one webhook with `optional: true` (§8.6) has a missing `secretRef`. Gateway IS scheduled; dormant webhooks short-circuit to `410 integration_not_configured`. | Optional: create the K8s Secret to activate the dormant webhook. A debounced reconcile picks it up. |
| `WebhookHandlerInvalid` | A webhook's `workloadRef` does not name a workload, names one whose `type` is not `deployment`, or names one with `transport` set (the W2 check that's too costly for CEL). | Fix `workloadRef` to point at a `type: deployment` workload with no `transport`. |
| `WebhookGatewayNotReady` | Per-recipe webhook-gateway Deployment is not `Available`. | `kubectl describe pod` on the gateway pod; usually image pull / resource pressure. |
| `WebhookJwksFetchFailed` | Reconcile-time fetch of `verification.jwksUrl` failed. Gateway still deploys; lazy-refetch covers requests but `kid`-miss requests return `500 jwks_fetch_failed`. | Verify the JWKS URL is reachable from the gateway's egress and `jwksUrl` is HTTPS multi-label DNS. |

This list grows with the controller — new features publish their own condition types under the same schema. When triaging, treat anything you see in `conditions[]` as authoritative over what the spec implies.

**Reading status:**

```bash
# Full view (events + conditions)
kubectl describe workflowrecipe <name> -n sandbox-recipes

# Specific fields
kubectl get workflowrecipe <name> -n sandbox-recipes \
  -o jsonpath='{.status.phase}'
kubectl get workflowrecipe <name> -n sandbox-recipes \
  -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.message}{"\n"}{end}'
kubectl get workflowrecipe <name> -n sandbox-recipes \
  -o jsonpath='{.status.workflowExecution.phase}'

# Via control-api
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:8090/api/v1/admin/recipes/<name>/status | jq .
```

**Quick symptom → condition map:**

| Symptom | Likely status signal | Fix path |
|---|---|---|
| Embed sticks on "recipe updating" | `phase != active`; events on the UI pod | Check `kubectl describe pod` — readiness probe failing or image pull pending. |
| Webhook returns `401 invalid_signature` | None (verification just rejected the request) | Verify HMAC scheme, secret content, encoding. |
| Webhook returns `500 verifier_misconfigured` | `WebhookSecretMissing` | Create the missing Secret/key in `sandbox-recipes`. |
| Webhook returns `500 jwks_fetch_failed` | `WebhookJwksFetchFailed` | Confirm `jwksUrl` is reachable; check periodic re-resolution succeeded. |
| Workflow stuck in `running` indefinitely | `workflowExecution.phase: running` | Coordinator → WRC blocked by NetworkPolicy / token expired / mcp_host unreachable. See §10.5 troubleshooting + coordinator logs. |
| Recipe simply not reconciling | `phase: pending` long after `kubectl apply` | Check WRC pod logs: `kubectl logs -n control-plane deploy/workflow-recipes`. |

`status` is updated by WRC and (for workflow runs) by the coordinator via WRC's REST handler — both paths PATCH the same subresource on the canonical CRD in `sandbox-recipes`.

---

## 14. Publishing a recipe

A working recipe on your dev machine is not yet a *publishable* recipe. Getting it discoverable for every Clerum operator is two halves:

1. **Push the container image(s)** to a public registry (Docker Hub, GHCR, Quay, public ECR).
2. **Publish the recipe through the Control UI**, which writes it to Clerum's centralized registry service. Every Clerum cluster reads from that same registry, so any operator anywhere can then install it from their Control UI.

That's the whole surface. Publishing and installing are both Control-UI actions; there is no other path for recipe authors.

The recipe YAML is the published artefact. **Images and Secrets are NOT inside it** — K8s pulls images from the public container registry at install time, and the installing operator provisions Secrets out-of-band guided by `spec.description`.

### 14.1 What must be true at install time

| Component | Where it must live | Provided by |
|---|---|---|
| Container image(s) referenced by `workloads[].image` | A publicly-pullable registry (Docker Hub, GHCR, Quay, public ECR). | Recipe author. |
| Recipe YAML | The Clerum centralized registry, written via the Control UI. | Recipe author. |
| K8s Secrets referenced by `clientIdRef`, `clientSecretRef`, `envSecret`, webhook `secretRef`, etc. | The recipe's target namespace (`sandbox-recipes`). | The cluster admin who installs the recipe — guided by `spec.description`. |

### 14.2 Image requirements

The image must satisfy all of:

| Requirement | Why | How to verify |
|---|---|---|
| **Publicly pullable** (no auth). | `imagePullSecrets` defeats portability. | `docker logout && docker pull <image>` from a fresh shell. If it fails with `repository does not exist or may require 'docker login'`, your registry repo is **private**, not nonexistent — Docker Hub creates new repos as private by default. Flip to Public in the repo's *Settings → Visibility* (Docker Hub) or *Package settings → Change visibility* (GHCR). Your push succeeding tells you nothing about visibility. |
| **Immutable semver tag** (`1.0.0`, not `:latest` / `:dev`). | `latest` floats; installers can't reproduce builds; K8s won't re-pull on restart without `imagePullPolicy: Always` (which slows every restart). | `docker buildx imagetools inspect <image>` shows a content digest. |
| **Multi-arch: `linux/amd64` + `linux/arm64`.** | Prod clusters amd64; dev laptops Apple Silicon. Single-arch → `exec format error` on the wrong arch. | `docker buildx imagetools inspect <image>` lists both platforms. |
| **Non-root.** | All three namespaces (`sandbox-ui`, `sandbox-recipes`, `mcp-server`) enforce PodSecurity baseline; root pods are rejected. UI workloads have additional CSP / sandbox constraints — see §6.4. | `docker run --rm <image> id` → UID ≠ 0. |
| **Listens on the declared `workloads[].port`.** | Health check fails otherwise → pod never Ready. UI workloads MUST use 8080 (rpc-proxy allow-list). | `docker run --rm -p 8080:8080 <image>` then `curl localhost:8080`. |
| **Health-check path returns 2xx.** | K8s readiness gate. | `curl -v localhost:8080<healthCheck.path>`. |
| **No baked-in secrets.** | Published images are world-readable. | `docker history <image>` — review layers / env. |
| **OCI source + license annotations.** | Installers can audit provenance. | `docker inspect <image> \| jq '.[].Config.Labels'`. |

Build multi-arch with buildx:

```bash
docker buildx create --use --name multiarch   # one-time
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag ghcr.io/<org>/<image>:1.0.0 \
  --label org.opencontainers.image.source=https://github.com/<org>/<repo> \
  --label org.opencontainers.image.licenses=MPL-2.0 \
  --push \
  .
```

If an image MUST run as a specific UID (PostgreSQL 70, MongoDB 999), declare it via per-workload `security.runAsUser` (§4.2). UID 0 is rejected at admission.

### 14.3 Pinning the image in the recipe

```yaml
workloads:
  - id: web
    type: deployment
    image: ghcr.io/<org>/<image>:1.0.0   # NEVER :latest in a published recipe
    imagePullPolicy: IfNotPresent         # Default; correct for immutable tags
    port: 8080
```

`imagePullPolicy: Always` only makes sense while iterating on a mutable tag — which a published recipe must never have.

### 14.4 Documenting required Secrets in `spec.description`

Admins installing your recipe from the catalog read `spec.description` to know what Secrets to create *before* applying. **A recipe that fails to start because of a missing Secret without documenting it is a publishing bug, not a runtime bug.**

Operators provision Secrets through the Control UI — `/secrets/recipe` for the global view, or the recipe detail page's **Secrets** tab for the per-recipe view (the latter auto-detects missing references and offers an **Add** button that pre-fills the key list from the recipe spec). They should NOT have to copy-paste `kubectl create secret` lines into a terminal as their primary path. Your job as an author is to tell them *which Secret, which keys, where each value comes from, and which integration each key turns on* — the UI handles the rest.

The platform's only signal to the operator when a Secret is missing is a terse `integration_not_configured` HTTP response (503 for OAuth use-sites, 410 for dormant webhooks), a `WebhookSecretMissing` / `WebhookDormant` status condition on the recipe, or an `ImagePullBackOff` / `CreateContainerConfigError` pod state for required `envSecret` keys. They cannot reverse-engineer your provider integrations from a CRD object. Your `spec.description` is their entire onboarding doc.

#### 14.4.1 Inventory rule (do this FIRST)

Before writing `spec.description`, enumerate every Secret reference in your YAML and group by name. A single Secret with eight keys is ONE entry to document; eight references to the same Secret are ONE entry. The full inventory of secret-shaped fields:

| Field | Content | When required |
|---|---|---|
| `oauthClients[].clientIdRef` / `clientSecretRef` | OAuth app credentials. | Required to actually connect, but NOT eagerly checked at reconcile time. Missing → `503 integration_not_configured` at the embed's first authorize-URL call (§7.2.1). The recipe still reaches `active`. |
| `webhooks[].verification.secretRef` | HMAC signing secret OR static bearer. | All schemes except `jwt-bearer-jwks`. Webhooks with `optional: true` (§8.6) keep the field but tolerate a missing Secret — the webhook stays dormant (`410 integration_not_configured`) until the Secret is created. |
| `webhooks[].verification.setupHandshake.secretRef` | Provider verify token (e.g. Meta `hub.verify_token`). | Only with `meta-hub-challenge`. |
| `workloads[].envSecret` | Env-var-shaped runtime credentials (one Secret, N keys). Keys with `optional: true` (§4.1.1) may be deferred to post-install setup. | Required keys: when the workload needs them. Optional keys: only when the operator wants to enable that integration. |
| `workloads[].imagePullSecrets` | Private-registry pull credentials. | Discouraged for published recipes — document loudly if used. |

For each Secret in the inventory, your description MUST answer these five questions:

1. **WHAT** — What is this Secret for? (One sentence.)
2. **WHY** — Which workload / endpoint breaks if it's missing?
3. **WHERE** — How does the operator obtain each value? (Provider settings page URL, or "operator invents this", or "use `openssl rand -hex 32`".)
4. **REGISTER** — Is there a URL or value the operator must register at the provider's end? Spell it out, with `<control-api-host>` as the only placeholder.
5. **HOW** — The exact Secret name + key names the operator should enter in the Control UI's **Secrets → Create (recipe scope)** form (or, equivalently, an explicit `kubectl create secret generic …` for CI / scripted installs).

A description that skips any of (1)–(5) for any Secret is incomplete and will leave the operator stuck.

#### 14.4.2 Archetype templates (use the ones that match your recipe)

Mix and match these blocks. Each block is the complete prerequisite section for one archetype. **Concatenate every archetype your recipe uses** into `spec.description`.

**How operators consume these blocks.** Each archetype lists the Secret name + key names + where each value comes from. The day-to-day operator path:

1. Open the Control UI → recipe detail page → **Secrets** tab (or `/secrets/recipe` for the global view).
2. Click **Add** on the "Missing" row that matches the Secret name in this block; the form pre-fills the key list from the recipe spec.
3. Paste each value in.

The `kubectl create secret generic …` lines below are a faithful equivalent for CI pipelines, scripted installs, or operators who prefer the terminal — they are not the recommended one-off path.

**Archetype A — plain env-var Secret (`workloads[].envSecret`)**

```text
### Secret: <secret-name>

Used by: <workload-id-1>, <workload-id-2>, <workload-id-3> (envSecret).
Provides: <one-sentence purpose>.

Required keys (recipe stays degraded until these exist):

  pg-password           — Postgres password used by the db workload AND
                          referenced by the api workload's DATABASE_URL.
                          Generate with: openssl rand -hex 16
  anthropic-api-key     — Anthropic API key. Get from https://console.anthropic.com/
                          → API Keys → Create Key. Used by the followup
                          workload's LLM calls.
  openai-base-url       — OpenAI-compatible base URL. Use
                          https://api.openai.com/v1 for OpenAI proper, or
                          your provider's base URL (e.g. https://api.z.ai/api/coding/paas/v4
                          for ZAI).
  openai-api-key        — API key for the base URL above.
  openai-model          — Model name (e.g. gpt-4o, glm-4.7).

Optional keys (recipe runs without them; add later to enable the
integration — the workload picks them up via a debounced rolling restart):

  fireflies-api-key     — Fireflies API key. Get from
                          https://app.fireflies.ai/integrations → API → Generate Token.
                          Enables the api workload's transcript-sync endpoint.
                          Without it, /webhook/fireflies returns 503.
  whatsapp-phone-number-id   — Meta WhatsApp Business phone number ID. Get from
                               Meta App Dashboard → WhatsApp → API Setup.
                               Enables WhatsApp outbound replies. Pair with
                               whatsapp-access-token; either alone is a no-op.
  whatsapp-access-token      — Meta WhatsApp permanent token. Get from same
                               page; create a System User token with
                               whatsapp_business_messaging scope.

Create the Secret with just the required keys (recipe reaches active):

  kubectl create secret generic <secret-name> -n sandbox-recipes \
    --from-literal=pg-password="$PG_PASSWORD" \
    --from-literal=anthropic-api-key="$ANTHROPIC_API_KEY" \
    --from-literal=openai-base-url="$OPENAI_BASE_URL" \
    --from-literal=openai-api-key="$OPENAI_API_KEY" \
    --from-literal=openai-model="$OPENAI_MODEL"

Later, enable Fireflies by adding the key in-place (this triggers a
rolling restart of dependent workloads via the Secret watcher):

  kubectl patch secret <secret-name> -n sandbox-recipes \
    --type=json -p='[{"op":"add","path":"/data/fireflies-api-key",
    "value":"'$(echo -n "$FIREFLIES_API_KEY" | base64)'"}]'

Or just recreate the Secret with the full set when adding multiple keys:

  kubectl create secret generic <secret-name> -n sandbox-recipes \
    --dry-run=client -o yaml \
    --from-literal=pg-password="$PG_PASSWORD" \
    --from-literal=anthropic-api-key="$ANTHROPIC_API_KEY" \
    --from-literal=openai-base-url="$OPENAI_BASE_URL" \
    --from-literal=openai-api-key="$OPENAI_API_KEY" \
    --from-literal=openai-model="$OPENAI_MODEL" \
    --from-literal=fireflies-api-key="$FIREFLIES_API_KEY" \
    --from-literal=whatsapp-phone-number-id="$WHATSAPP_PHONE_NUMBER_ID" \
    --from-literal=whatsapp-access-token="$WHATSAPP_ACCESS_TOKEN" \
    | kubectl apply -f -
```

**Archetype B — webhook signing secret (`webhooks[].verification.secretRef`)**

```text
### Secret: <webhook-secret-name>

Used by: webhooks[<id>] (HMAC signature verification).
Provides: the shared signing secret the provider uses to sign every
inbound webhook body.

Keys (1):

  signing-secret  — Get from <provider settings URL>:
                    1. <step-by-step path through the provider's UI>
                    2. Copy the value into $WEBHOOK_SIGNING_SECRET.

Register the webhook URL at the provider:

  http://<control-api-host>/api/v1/webhook/sandbox-recipes/<recipeName>/<webhookId>

  Example for this recipe:
  http://<control-api-host>/api/v1/webhook/sandbox-recipes/sales-crm/fireflies

Create the Secret:

  kubectl create secret generic <webhook-secret-name> -n sandbox-recipes \
    --from-literal=signing-secret="$WEBHOOK_SIGNING_SECRET"
```

**Archetype C — webhook with `setupHandshake` (e.g. Meta `hub.verify_token`)**

```text
### Secret: <meta-webhook-secret-name>

Used by: webhooks[<id>] (HMAC signature verification + Meta hub.verify_token handshake).
Provides: BOTH the signing secret AND the verify token Meta uses to
gate webhook registration.

Keys (2):

  app-secret    — Meta App Secret. Get from
                  https://developers.facebook.com/apps/<your-app-id>/settings/basic/
                  → "App Secret" → Show. Used to verify x-hub-signature-256
                  on every payload.

  verify-token  — A random string YOU invent and register at Meta. Meta
                  echoes it back during webhook subscription setup. Pick
                  any high-entropy string:
                    openssl rand -hex 32

Register the webhook URL at Meta:

  http://<control-api-host>/api/v1/webhook/sandbox-recipes/<recipeName>/<webhookId>

  Example for this recipe:
  http://<control-api-host>/api/v1/webhook/sandbox-recipes/sales-crm/whatsapp

  When Meta's UI prompts for the verify token, paste the same value you
  put in --from-literal=verify-token=...

Create the Secret:

  kubectl create secret generic <meta-webhook-secret-name> -n sandbox-recipes \
    --from-literal=app-secret="$META_APP_SECRET" \
    --from-literal=verify-token="$META_VERIFY_TOKEN"
```

**Archetype D — OAuth provider credentials (`oauthClients[].clientIdRef` / `clientSecretRef`)**

```text
### Secret: <oauth-secret-name>

Used by: oauthClients[<id>] (auth-code flow for <provider>).
Provides: the OAuth app's client ID and client secret.

Keys (2):

  client-id     — <provider-specific instructions>. Example for Microsoft:
                  1. Go to https://portal.azure.com → Azure AD →
                     App registrations → New registration.
                  2. Name: "<your app name>". Supported account types:
                     pick whichever fits your org.
                  3. Redirect URI: Web →
                     http://<control-api-host>/api/v1/oauth-callback/<oauthClientId>
                     (replace <control-api-host>; the rest is exact).
                  4. After creation, copy "Application (client) ID".

  client-secret — Same app page → Certificates & secrets → New client
                  secret → copy the VALUE (not the secret ID).

Register the OAuth callback URL at the provider EXACTLY:

  http://<control-api-host>/api/v1/oauth-callback/<oauthClientId>

  Example for this recipe:
  http://<control-api-host>/api/v1/oauth-callback/microsoft

  (No trailing slash. The URL carries ONLY the oauthClientId — it is
  stable across recipe installs and catalog versions, so you register it
  once per OAuth client. The recipe identity travels in the signed OAuth
  state, not the URL. Mismatch → provider returns redirect_uri_mismatch
  and OAuth never completes.)

Create the Secret:

  kubectl create secret generic <oauth-secret-name> -n sandbox-recipes \
    --from-literal=client-id="$AZURE_CLIENT_ID" \
    --from-literal=client-secret="$AZURE_CLIENT_SECRET"
```

#### 14.4.3 Worked multi-secret example (4 Secrets, 4 archetypes)

A recipe with envSecret + webhook + meta-webhook + OAuth would have a `spec.description` shaped like this (abbreviated for length — each section is a full archetype block from §14.4.2):

```yaml
spec:
  description: |
    Sales CRM with Fireflies transcript ingestion, WhatsApp follow-ups,
    and Microsoft 365 OAuth for calendar sync.

    ## Prerequisites — create these BEFORE applying the recipe

    Four K8s Secrets must exist in the `sandbox-recipes` namespace
    before the recipe will reconcile to `phase=active`. Two webhook
    URLs and one OAuth callback URL must be registered at three
    providers' admin consoles.

    ### Secret: sales-crm-app
    [... full Archetype A block, all 8 keys with WHAT/WHERE/HOW ...]

    ### Secret: sales-crm-fireflies-webhook
    [... full Archetype B block: signing-secret + Fireflies URL ...]

    ### Secret: sales-crm-whatsapp-webhook
    [... full Archetype C block: app-secret + verify-token + Meta URL ...]

    ### Secret: sales-crm-msft-oauth
    [... full Archetype D block: client-id + client-secret + Azure URL ...]

    ## Install order

    1. Create the four Secrets (above).
    2. Install this recipe from the Control UI registry.
    3. Wait for `phase=active` — the recipe detail header shows it.
       From the CLI, first resolve the installed CR name (it is NOT
       "sales-crm"; see the naming note in the guide's §14.5):
       RECIPE=$(kubectl get workflowrecipes -n sandbox-recipes \
         -o name | grep sales-crm)
       kubectl get -n sandbox-recipes "$RECIPE" -w
    4. Register the two webhook URLs at Fireflies and Meta.
    5. Open the embed in the desktop app, click "Connect Microsoft",
       complete OAuth in your browser, return to the embed.

    ## Verifying the install

    All four Secrets present:
      kubectl get secret -n sandbox-recipes | grep sales-crm

    Recipe phase is `active` and no missing-Secret conditions:
      kubectl get -n sandbox-recipes "$RECIPE" \
        -o jsonpath='{.status.phase}'
      kubectl describe -n sandbox-recipes "$RECIPE" \
        | grep -A 3 Conditions
```

#### 14.4.4 Completeness self-check (run this before publishing)

Before adding the recipe to the registry, run through this checklist against your `spec.description`:

- [ ] **Every `secretRef.name` in the YAML appears literally in `spec.description`** as `### Secret: <name>`.
- [ ] **For each Secret**, the WHAT / WHY / WHERE / REGISTER / HOW questions (§14.4.1) are answered.
- [ ] **Every key in every `envSecret.keys[]` mapping** is listed with its origin (provider page link, generation command, or "operator invents this").
- [ ] **Every webhook id** has its public URL spelled out: `/api/v1/webhook/sandbox-recipes/<recipeName>/<id>`.
- [ ] **Every OAuth client id** has its callback URL spelled out: `/api/v1/oauth-callback/<oauthClientId>` (stable — one per client, no recipe instance).
- [ ] **Every `kubectl create secret generic ...` block has one `--from-literal=` per key** declared in the YAML's `envSecret.keys` / `secretRef.key` references — no fewer, no more.
- [ ] **Install order** is explicit (Secrets → apply → register URLs at providers → grant ACL → user-side actions).
- [ ] **A verification snippet** at the end shows the operator how to confirm `phase=active` and that all Secrets are picked up.

If your description fails any item, the operator will hit `integration_not_configured` (503/410), `ImagePullBackOff`, `redirect_uri_mismatch`, or an unverified webhook 401 — and they will have to reverse-engineer the integration from the CRD object. That is a publishing bug.

### 14.5 Publishing through the Control UI

Publishing is a Control-UI action — there is no other supported path. Once the image is public and the YAML is ready:

1. Open the Control UI's **Registry → Publish** page (`/registry/publish`).
2. Paste the recipe JSON or YAML.
3. **Validate** — client-side: JSON parse → schema (apiVersion, kind, name, workloads) → security compliance (`runAsUser >= 1`, capabilities in allowlist).
4. Optional: **Apply Operator Defaults** — injects resource requests/limits, namespace by `transport`, registry pull secrets.
5. **Publish** — writes the entry to the centralized Clerum registry. The recipe is now discoverable in every Clerum cluster's `/registry`.

Maintenance of a published entry (description / tags edits, version retirement, source-repo annotation) is done from the entry's detail page at `/registry/entries/[name]/[version]` — click any catalog row to land there.

Other operators install with the same UI: they browse `/registry`, click your entry's row, review the description / images / source repo on the detail page, and click **Install**. They provision Secrets through the recipe detail page's **Secrets** tab (see §14.7 for the full operator path).

**Authoring workflow tip — YAML to edit, JSON to upload.** YAML is the readable source-of-truth in the repo, but the Control UI editor and the admin API both prefer JSON. Convert with either:

```bash
yq -o=json '.' recipe.yaml > recipe.json
# or, if you don't have yq:
python3 -c 'import sys,yaml,json; json.dump(yaml.safe_load(open("recipe.yaml")),sys.stdout,indent=2)' > recipe.json
```

**Recipe naming inside the cluster.** When a recipe is installed from the registry (the Control-UI path), the installed CR is **not** named after your `metadata.name`. (A direct `kubectl apply -f recipe.yaml`, §13, does keep it.) Control-API derives the name from the **registry entry** name and version: `recipe-<entry-name>-v<version-with-dashes>-<hash8>` (e.g. `recipe-sales-crm-v1-0-0-87c8cacc`; `control-api/src/routes/admin/registry.ts`). Your `metadata.name` is not carried over as a label — the only label applied at install is `clerum.io/managed-by: control-api`; the catalog entry name and version are stored as the **annotations** `clerum.io/catalog-id` and `clerum.io/catalog-version` (org-scoped names are illegal label values). So `kubectl get workflowrecipe <metadata.name>` returns `NotFound`. Look it up by substring or by annotation:

```bash
kubectl get workflowrecipes -A | grep <your-entry-name>
# or, exactly, by the catalog annotation:
kubectl get workflowrecipes -A -o json \
  | jq -r '.items[] | select(.metadata.annotations["clerum.io/catalog-id"]=="<your-entry-name>")
           | "\(.metadata.namespace)/\(.metadata.name)"'
```

### 14.6 Versioning your recipe + image

Authors carry version discipline in two places: the **image tag** and (optionally) a `metadata.labels` or `metadata.annotations` field on the recipe. The cluster itself does not enforce a recipe version — the installed CR's name (derived from the registry entry name + version, §14.5) is the primary key — but you should still bump tags + announce changes to consumers.

| Change | Action |
|---|---|
| Bug fix in the embedded YAML only (typo, healthCheck path, tightened resources). | Re-distribute the YAML. No image bump needed. |
| Image rebuild (dependency bump, code change) with no recipe-schema change. | Bump the image tag (patch: `1.0.0 → 1.0.1`); update the `image:` in the YAML; re-distribute. |
| Adding an optional workload / `oauthClient` / broadening egress. | Image tag: minor (`1.0.1 → 1.1.0`). Re-distribute the YAML and note new prerequisites. |
| Removing a workload, changing a port, adding a newly-required Secret. | Image tag: major (`1.1.0 → 2.0.0`). Document the migration in `spec.description`. |

Never re-publish an unchanged tag with new content — admins who already installed the prior version won't re-pull (unless `imagePullPolicy: Always`, which you should not set).

### 14.7 What the installing operator does

The whole flow is Control-UI-driven. No terminal required.

1. **Browses the catalog** at `/registry`, clicks the row → entry detail page (`/registry/entries/[name]/[version]`).
2. **Reviews `spec.description`** in the detail page's full-page description reader — Secret prerequisites, callback URLs, container image links.
3. **Clicks Install** on the detail page (or the catalog row's inline button).
4. **Provisions the prerequisite Secrets** through the recipe's **Secrets** tab — Missing rows surface an **Add** button that pre-fills the key list from the spec. (Optional: a debounced reconcile picks up new keys without manual re-trigger; see §4.1.1.)
5. **`.status.phase`** advances through the 13-state machine (`pending → deploying → testing → active`; `active` is the healthy terminal phase — there is no `ready`), visible in the recipe detail header. The **Workloads** and **Conditions** tabs surface any failure modes (see §13.4 / §13.5).
6. **Grants the recipe to specific users** via the **Members** tab on the recipe detail page (recipe is invisible to end users until granted).
7. **End user sees the recipe** in the desktop app (sandbox-UI recipes) or trigger list (workflows).

Steps 4 and 6 are the only operator-action steps; the rest is platform automation. From your side as author, the work ends at publish — the quality of `spec.description` (and the field names you use in `envSecret`, `secretRef`, etc.) determines how smoothly step 4 goes for every operator who installs you.

### 14.8 Common publishing mistakes

| Mistake | Symptom | Fix |
|---|---|---|
| Image tag is `:latest` / `:dev` / `:test`. | Builds drift; restarts can pull a different image. | Use immutable semver. |
| Single-arch image. | Apple Silicon clusters: `exec format error`. | Rebuild with `--platform linux/amd64,linux/arm64`. |
| Image in a private registry. | Other clusters: `ImagePullBackOff`. | Push to a public registry. If unavoidable, document the `imagePullSecrets` requirement loudly. |
| Image runs as root. | Pod stuck in `CreateContainerError` (PodSecurity baseline). | Non-root Dockerfile, or set per-workload `security.runAsUser` (§4.2). |
| Image listens on 80 / 8000 / 3000 but recipe says `port: 8080`. | Health check fails; pod never Ready. UI workloads MUST use 8080. | Match the recipe's port — or change the recipe (except UI: stuck at 8080). |
| Secret name in `description` differs from the YAML's `secretRef.name`. | Admin creates the wrong Secret; install fails with `WebhookSecretMissing` / `integration_not_configured`. | Triple-check identical naming in both. |
| `spec.description` does not document required Secrets. | Admin installs, reconcile fails closed, admin reads cryptic `integration_not_configured` and asks you. | Spell out every Secret with the exact `kubectl create secret` invocation (§14.4). |
| Recipe references an MCP-server image not publicly pullable. | `ImagePullBackOff`. | ALL workload images (including MCP) must be publicly pullable. |
| OAuth recipe doesn't include the exact callback URL the admin must register at the provider. | Provider redirects to 404 / mismatch; OAuth never completes. | Spell out: `http://<control-api-host>/api/v1/oauth-callback/<oauthClientId>`. |
| Re-shipping an unchanged image tag with new bits inside. | Admins who installed already keep running the old image. | Bump the tag. Never overwrite a published tag. |

### 14.9 Worked example — publishing `sandbox-ui-oauth-hello`

**Step 1 — image is ready.** This recipe uses `nginxinc/nginx-unprivileged:1.27-alpine`, already public, multi-arch, non-root — so build/push is a no-op. For a custom image, run through §14.2 first (`docker buildx build --platform linux/amd64,linux/arm64 ... --push`).

**Step 2 — `spec.description` spells out every prerequisite.** The Slack OAuth app, the redirect URI to register (`http://<control-api-host>/api/v1/oauth-callback/slack-bot`), and the `kubectl create secret generic slack-oauth-creds ...` command.

**Step 3 — publish via Control UI.** Open **Marketplace** → **Recipes** → **+ Install Recipe** → paste JSON → **Validate** → **Deploy Recipe**. The entry is now in Clerum's centralized registry and visible to every cluster.

**Step 4 — operators install it.** From any Clerum cluster's Control UI: discover, create the prerequisite Secret, click Install.

**Step 5 — verify on a test install:**

```bash
# The installed CR is named recipe-<entry>-v<version>-<hash>, NOT
# "sandbox-ui-oauth-hello" (§14.5) — resolve it first.
RECIPE=$(kubectl get workflowrecipes -n sandbox-recipes -o name \
  | grep sandbox-ui-oauth-hello)
kubectl get -n sandbox-recipes "$RECIPE" -o jsonpath='{.status.phase}'
# Expect: active
```

Then read §13.5 to confirm `.status.conditions[]` is empty, and you're done.

---

## 15. Restrictions summary (the things you simply cannot do)

- **Cannot live outside `sandbox-recipes`.** The CRD object always lives there.
- **Cannot choose which namespace a workload lands in** — it's a function of `transport` and `spec.ui.workloadRef`.
- **Cannot ship arbitrary `run:` executors** — `run:` is snippet-only (`type: snippet`, `language: typescript`, inline `code`), and everything the snippet touches must be declared in `run.capabilities`. Logic that doesn't fit that envelope goes in agentic `instruction:` steps or in a workload.
- **Cannot use cross-namespace `ownerReferences`** (K8s 1.24+ GC deletes them with `OwnerRefInvalidNamespace`). WRC finalizers own cleanup.
- **Cannot mount ConfigMap/Secret as `volumeMounts`** today — only PVCs auto-wire. Bootstrap via `command:` if needed.
- **Cannot use `replicas > 1` for UI workloads** (R16).
- **Cannot point `ui.egress.internal` at MCP servers** (R17). Route via your own backend.
- **Cannot use ports other than 8080 for the UI** (platform allow-list).
- **Cannot use wildcard FQDNs** in `egress.external`.
- **Cannot use WebSocket** in sandbox UI (`426 Upgrade Required`). Use SSE / polling.
- **Cannot trigger downloads** in sandbox UI. Render inline.
- **Cannot use `window.open`** for in-embed navigation (always pops OS browser).
- **Cannot use inline scripts, `eval`, `new Function`, third-party CDN scripts** (CSP).
- **Cannot read or set HttpOnly cookies** from embed JS.
- **Cannot trust client-supplied identity** — always `X-Clerum-User` server-side.
- **Cannot iframe the embed** (`X-Frame-Options: DENY`, `frame-ancestors 'none'`).
- **Cannot propagate identity to MCP / control-api** from the embed (Decision 15: NOT planned for v2 either).
- **Cannot register webhook URLs with non-POST methods** unless explicitly declared, and only POST + GET are accepted.
- **Cannot use SHA-1 or SHA-512** for webhook HMAC (only SHA-256).
- **Cannot configure webhook lifetime budgets** (5 s / 10 s / 30 s / 256 in-flight are fixed).
- **Cannot omit `replay:`** when using `hmac-sha256-timestamp-body`.
- **Cannot use port 80 / 443 / privileged ports** in workloads (no `NET_BIND_SERVICE`).
- **Cannot run as root** in any workload (`runAsUser` min 1, enforced at admission).

---

## 16. Authoritative source files

When this doc and the code disagree, the code wins.

| Subject | File |
|---|---|
| CRD schema + ALL CEL rules | `charts/clerum-crds/crds/workflowrecipe.yaml` |
| WRC reconciler | `workflow-recipes/src/reconciler/resourceBuilder.ts`, `workflowRecipeReconciler.ts` |
| Sandbox-UI proxy / cookie / CSP | `rpc-proxy/src/routes/sandboxUi.ts` |
| Path normalisation | `rpc-proxy/src/services/sandboxUiPath.ts` |
| Port allow-list | `rpc-proxy/src/config.ts`, `rpc-proxy/src/services/sandboxUiRegistry.ts` |
| OAuth providers | `control-api/src/oauth/providers.ts` |
| OAuth callback / token / disconnect | `control-api/src/routes/external/oauthCallback.ts`, `control-api/src/routes/internal/oauth.ts` |
| Background OAuth (`backgroundAccess`) — operator connect / broker route / broker-token issuance | `control-api/src/routes/admin/recipeOauth.ts`, `control-api/src/routes/recipeOauth.ts`, `control-api/src/routes/auth/recipe-oauth/issue.routes.ts` |
| Webhook gateway | `webhook-gateway/src/server.ts`, `webhook-gateway/src/handshake.ts` |
| Workflow runtime | `mcp-host/src/workflow/*`, `workflow-recipes/src/workflow/*` |
| Static NetworkPolicies | `deploy/base/sandbox-ui/networkpolicies.yaml`, `deploy/base/rpc-proxy/networkpolicies.yaml` |
| Sample recipes | `workflow-recipes/samples/*.yaml` (sandbox-ui-hello, sandbox-ui-oauth-hello, sandbox-ui-test-harness, webhook-hello, mcp-postgres, mongodb-mcp-stack, stdio-mcp-multi-tool) |
| Control UI recipe editor | `control-ui/components/RecipeEditor.tsx`, `control-ui/lib/recipeValidator.ts`, `control-ui/lib/api.ts` |
| Control API admin recipe routes | `control-api/src/routes/admin/recipes.ts` |

---

## 17. Pre-flight checklist

### 17.1 Before applying (authoring)

- [ ] `metadata.namespace: sandbox-recipes` (always).
- [ ] `metadata.name` is DNS-1123, ≤ 63 chars, unique.
- [ ] `spec.contextRef` set ONLY if a workload exposes an MCP `transport` (use `context1`); omitted on agentic (`steps`) recipes — §1.1.
- [ ] If `spec.steps` is non-empty: `spec.triggers` declares `onDemand` and/or `schedule` (cluster admission policy rejects otherwise).
- [ ] All `workloads[].id` unique, lowercase, DNS-1123.
- [ ] At least one of `workloads` / `steps` non-empty.
- [ ] If `spec.ui`: referenced workload is `type: deployment`, `replicas: 1` (or omitted), no `transport`, port matches, container runs non-root on `0.0.0.0:8080`, `healthCheck` returns 2xx.
- [ ] Embed JS in external `.js` files (no inline `<script>`, no `eval`).
- [ ] All cross-origin embed fetches removed (or relayed server-side).
- [ ] `ui.defaultPath` matches `^/([^/\s][^\s]*)?$`.
- [ ] `ui.icon` (if set) is `data:` URI, ≤ 32 KB.
- [ ] If `spec.oauthClients`: `spec.ui` is set OR every client is consumed by a `workloads[].oauthClientRefs` (O1); Secrets referenced in `clientIdRef`/`clientSecretRef` exist in `sandbox-recipes`.
- [ ] If any `oauthClients[].backgroundAccess: true`: `scopes` includes the provider's offline/refresh scope (§7.5); each consuming workload opts in via `oauthClientRefs` and is non-MCP, non-UI.
- [ ] If `spec.webhooks`: each `workloadRef` is non-MCP; verification matches provider; `replay:` present iff `hmac-sha256-timestamp-body`; `meta-hub-challenge` has `GET` in methods.
- [ ] If steps use `{{stepId:output}}`: every referenced `stepId` exists and runs first.
- [ ] StatefulSet workloads with PVCs set `security.fsGroup` matching `runAsGroup`.
- [ ] `spec.ui.egress.external[]` uses concrete FQDNs (no wildcards, no static CIDRs).
- [ ] No `replicas > 1` on UI workload.
- [ ] All `resources.requests` AND `resources.limits` set.
- [ ] `security.isolationLevel: minimal` (the namespace floor is sufficient).
- [ ] No WebSocket usage in sandbox UI (SSE / polling instead).
- [ ] No download triggers in sandbox UI (render inline).
- [ ] All per-user logic reads `X-Clerum-User`, never trusts client identity.

If a referenced Secret is missing, the recipe still applies. The failure mode depends on the reference: required webhook `secretRef` → recipe `degraded` with `WebhookSecretMissing` (gateway not scheduled, fail-closed); optional webhook (§8.6) → recipe `active` with `WebhookDormant`, gateway returns `410 integration_not_configured`; OAuth `clientIdRef` / `clientSecretRef` → recipe `active`, endpoints return `503 integration_not_configured` (§7.2.1); required `envSecret` key → pod stuck in `CreateContainerConfigError`; optional `envSecret` key (§4.1.1) → workload runs without that env var. `.status.conditions[]` (§13.5) names the cause where applicable.

### 17.2 Before publishing through the Control UI

- [ ] **Image is in a public container registry** under an immutable semver tag (NOT `:latest` / `:dev`).
- [ ] **Image is genuinely public** — `docker logout && docker pull <image>` succeeds (don't trust that the push worked; Docker Hub creates new repos as private).
- [ ] **Image is multi-arch** — `docker buildx imagetools inspect <image>` shows `linux/amd64` AND `linux/arm64`.
- [ ] **Image runs as non-root** — `docker run --rm <image> id` shows UID ≠ 0.
- [ ] **Image listens on the declared port** — `docker run --rm -p 8080:8080 <image>` + `curl localhost:8080` works.
- [ ] **Health-check path returns 2xx with the right Content-Type** — `curl -i localhost:8080<healthCheck.path>` and `curl -i localhost:8080<defaultPath>` from a fresh shell; verify `.js` is served as `application/javascript` (CSP refuses scripts with the wrong type). This is the cheapest debugging step there is — three minutes here saves an hour of cluster-side detective work.
- [ ] **No baked-in secrets** — `docker history <image>` reveals nothing sensitive.
- [ ] **OCI source + license annotations** present.
- [ ] **Recipe applies cleanly on a fresh cluster** — `.status.phase: active`, `.status.conditions[]` empty, **AND** pods in `sandbox-recipes` AND `sandbox-ui` are all `Running 1/1`. Split recipes can have a Ready WorkflowRecipe with a CrashLoop'ing backend pod — always check both namespaces.
- [ ] **No `ETIMEDOUT` in any workload's startup logs** — if a backend talks to a sibling in the same namespace, confirm an `egressBindings[]` entry with the sibling's `<id>.<ns>.svc.cluster.local` FQDN exists (§9.5).
- [ ] **Every referenced Secret documented in `spec.description`** with the exact `kubectl create secret` invocation.
- [ ] **OAuth recipes**: exact callback URL spelled out (`/api/v1/oauth-callback/<oauthClientId>`).
- [ ] **Recipe passes CEL validation** in the Control UI — no `x-kubernetes-validations` errors.
- [ ] **Recipe runs end-to-end against a real external dependency** (real OAuth provider, real webhook source).
- [ ] **`spec.description` includes a one-sentence summary** at the top — operators see this in the catalog list before clicking through.
