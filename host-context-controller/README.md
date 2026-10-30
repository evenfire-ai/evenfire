# Host Context Controller

The Host Context Controller is a Kubernetes operator and REST API service that sits at the heart of the Clerum platform. It performs these key roles:

1. **McpServer Operator** — Watches `McpServer` CRDs and automatically manages Deployments and Services for each MCP server, including secret validation.
2. **Host Operator** — Watches `Host` CRDs and automatically manages one Deployment, one Service, and one PVC per host, including secret validation. Hosts that opt into `spec.lifecycle.stateless` can be suspended (scaled to 0) when idle and woken on demand.
3. **NetworkPolicy Operator** — Watches `Context` and `McpServer` CRDs and generates a four-layer NetworkPolicy model (deny-all, infrastructure, context-allow, external-egress) plus recipe binding policies.
4. **LlmHook Operator** — Watches `LlmHook` CRDs in `llm-hooks` and runs the guardrail hook workloads (`src/llmHookReconciler.ts`).
5. **REST API** — Exposes a curated API that `mcp-host` uses to discover available MCP servers, their status, and auth tokens.

It also reconciles `GlobalFileSystem` (`src/gfsReconciler.ts`) and `SharedFileSystem` (`src/sharedFileSystemReconciler.ts`) CRDs.

## Architecture

```
                                         ┌─────────────────────┐
                                         │   McpServer CRDs    │
                                         └──────────┬──────────┘
                                                    │ watch
                                                    ▼
┌─────────────────┐     REST API      ┌───────────────────────────┐     manages      ┌─────────────────────┐
│    mcp-host     │ ───────────────▶  │  host-context-controller  │ ──────────────▶  │  Deployments        │
│  (mcp-host ns)  │                   │    (control-plane ns)     │                  │  Services           │
└─────────────────┘                   └───────────────────────────┘                  │  NetworkPolicies    │
                                                    │                                └─────────────────────┘
                                           watch    │      reads
                                    ┌───────────────┼───────────────┐
                                    ▼               ▼               ▼
                             ┌─────────────┐  ┌───────────┐  ┌─────────────┐
                             │ Context CRDs│  │  Secrets  │  │ MCP Server  │
                             └─────────────┘  └───────────┘  │    Pods     │
                                                             └─────────────┘
```

## McpServer Operator

When an `McpServer` CRD is created, modified, or deleted, the host-context-controller reconciler:

- **ADDED** — Validates that referenced secrets exist, then creates a Deployment and Service for the MCP server.
- **MODIFIED** — Updates the Deployment and Service to match the CRD spec (env vars, image, ports, resources, etc.).
- **DELETED** — Removes the Deployment and Service.

Remote egress-proxy McpServers keep the author's `spec.image` as desired-state input; HCC no longer rewrites it to the platform proxy image. The former `canonicalizeRemoteEgressProxyImage` step and its `ImageCanonicalized` status condition were removed (PR #205 readiness-safety cleanup): canonicalization mutated the observed CRD cache object and bumped the resource generation, retiring the in-flight reconcile before it could create the runtime resources. The platform-owned proxy image is instead selected at Deployment build time (`buildDeployment`), leaving the CRD spec untouched.

The reconciler builds Deployments with labels used for pod selection and network policy targeting:

| Label                  | Value                     | Purpose                           |
| ---------------------- | ------------------------- | --------------------------------- |
| `app`                  | `<server-name>`           | Standard app selector             |
| `clerum.io/managed-by` | `host-context-controller` | Identifies operator-managed pods  |
| `clerum.io/mcpserver`  | `<server-name>`           | Targets a specific MCP server pod |

### Secret Validation

Before deploying an MCP server, the reconciler checks that:

1. The secret referenced by `spec.envSecret.name` exists in the namespace.
2. All keys listed in `spec.envSecret.keys[].secretKey` are present in the secret data.

If the secret is missing or incomplete, the MCP server will **not** be deployed. Creating the secrets an `McpServer` references is not the host-context-controller's responsibility — for those it only validates their existence. (It does create its own Secrets elsewhere, e.g. the per-Host runtime-token Secret in `mcp-host`.)

### Credential rollout

Container env vars that come from `secretKeyRef` are read only when the container starts, so editing the Secret alone does not reach a running pod. HCC closes that gap with a pod-template annotation: secret validation returns a sha256 of the Secret it just read, and the reconciler stamps it as `clerum.io/credentials-revision` on the Deployment's pod template (`src/reconciler.ts`). A `SecretInformer` on the McpServer namespace re-enqueues the servers that reference a changed Secret, the hash changes, and Kubernetes rolls the pod.

The same annotation drives rollouts for per-Host channel-reader pods (a second informer on `channels`) and for LlmHook pods (a third informer on `llm-hooks`) (`src/main.ts`).

For setting and rotating connector credentials from the operator side, see [Connect an OAuth connector](../docs/how-to/connect-oauth-connector.md).

## NetworkPolicy Operator

The host-context-controller enforces **deny-by-default** network isolation across all runtime namespaces and generates allow policies from `Context` and `McpServer` CRDs. The model has four layers, implemented in `src/networkPolicyReconciler.ts`, plus recipe-scoped binding policies in `src/bindingPolicyReconciler.ts`.

### L0 — Default deny

One `deny-all-<namespace>` policy per runtime namespace, configurable via `CONTEXT_MAPPER_RUNTIME_NAMESPACES` (the shipped deployment sets `mcp-server,sandbox-recipes,rpc-proxy,sandbox-ui`; the code default is `mcp-server,mcp-host,sandbox-recipes,rpc-proxy`). Empty pod selector with `policyTypes: [Ingress, Egress]` — all traffic in both directions is blocked unless a higher layer allows it.

Note: as deployed, `mcp-host` is **not** in that list — its deny-all, DNS and K8s-API policies are static manifests (`deploy/base/mcp-host/networkpolicies.yaml`), not controller-managed.

### L1 — Infrastructure

Baseline plumbing, created once per runtime namespace:

| Policy                      | Allows                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow-dns-egress-<ns>`     | DNS (UDP+TCP 53) to `kube-system`; optional extra ipBlock rule for GKE NodeLocal DNSCache via `CONTEXT_MAPPER_NODELOCAL_DNS_CIDR`                                                                                                                                                                                                                 |
| `allow-hcc-api-egress-<ns>` | Egress to the `host-context-controller-api-gateway` pod in the control-plane namespace, scoped per namespace to the pod classes that need discovery (managed mcp-host pods, `mcp-proxy`, `rpc-proxy`, workflow MCP hosts)                                                                                                                         |
| `allow-k8s-api-egress-<ns>` | Egress to the Kubernetes API server (TCP 443; CIDRs from `CONTEXT_MAPPER_K8S_API_CIDRS`, falling back to `KUBERNETES_SERVICE_HOST`, then to a hardcoded `10.96.0.1/32` when that is unset). **Deny by default** outside `mcp-host`: pods in other runtime namespaces must opt in with the platform-owned label `clerum.io/k8s-api-egress: "true"` |

Namespaces listed in `CONTEXT_MAPPER_MINIMAL_INFRA_NAMESPACES` get only deny-all + DNS egress (no HCC-API or K8s-API egress).

`ensureDefaultPolicies` additionally creates one non-suffixed `allow-host-context-controller-api` policy — not per namespace, but a single policy in `CONTEXT_MAPPER_NAMESPACE` (`mcp-server`). It permits ingress from the `mcp-host` namespace on `CONTEXT_MAPPER_PORT` to pods matching `app: host-context-controller`. As shipped, the controller Deployment runs in `control-plane`, so this policy matches no pod in `mcp-server` and has no effect; the mcp-host → controller route is actually opened by the `allow-hcc-api-egress-<ns>` egress policies above.

### L2 — Context allow

For each MCP server in a `Context` CRD's `spec.mcpServers`, three paired policies open a single route on the server's transport port:

- `ctx-<contextId>-<serverName>` (ingress, MCP server namespace) — the server pod accepts traffic only from mcp-host pods **labeled with that context** (`clerum.io/context`), from `rpc-proxy` pods, and from `mcp-proxy`.
- `ctx-<contextId>-<serverName>-egress` (egress, `mcp-host` namespace) — the context-labeled mcp-host pods may reach that server (required because L0 also denies egress).
- `rpc-egress-<contextId>-<serverName>` (egress, `rpc-proxy` namespace) — rpc-proxy pods may reach that server.

Servers removed from a Context lose their policies on the next reconcile; deleting a Context removes all three families.

### L3 — External egress

`McpServer.spec.egressBindings` produce `ext-egress-*` policies in the server's namespace (`reconcileExternalEgress` in `src/networkPolicyReconciler.ts`):

- **`exact-host`** (default) — a CIDR binding, or a public DNS hostname resolved to `/32` ipBlocks, on one declared port/protocol. CIDRs and resolved IPs are rejected if they overlap `PUBLIC_EGRESS_EXCEPT_CIDRS` (RFC1918, CGNAT, loopback, link-local incl. cloud metadata, documentation, benchmarking, multicast, reserved ranges). Hostnames like `localhost`, `metadata.goog`, `*.internal`, `*.svc`, `*.cluster.local` are rejected outright.
- **`public-web`** — `0.0.0.0/0` on TCP 80/443 with `PUBLIC_EGRESS_EXCEPT_CIDRS` carved out via `except`.

Results are written to the McpServer's `status.conditions` (`ExternalEgressReady`) and `status.resolvedEgressIPs`. A failed binding blocks runtime reconciliation of that server, so a workload cannot start before its egress converges. DNS-derived allows are never retained across a failed refresh: HCC revokes the unprovable policy before certifying global readiness, while only the affected runtime remains blocked until DNS recovers. Each lookup has a bounded deadline.

HCC readiness certifies authoritative inventory and revocation safety, not
completion of positive policy creation. A renamed or newly requested allow may
therefore remain unavailable after HCC becomes Ready until its additive
reconciliation succeeds. HCC never keeps an obsolete allow merely to avoid
that availability gap: when old and new ownership cannot be proven equivalent,
revocation wins and only the affected runtime remains fail-closed.

During an in-place release, HCC is also the controller that stamps
`CONTEXT_MAPPER_HOST_IMAGE` onto managed mcp-host workloads. The new HCC
producer is consequently running before it replaces those consumers with the
new mcp-host image. For compatibility, an omitted `status.authoritative` field
retains the legacy fail-closed meaning; only an explicit `authoritative: false`
asks a new mcp-host to preserve an unchanged live connection.

### Recipe binding policies

McpServers carrying a `clerum.io/recipe-bindings` annotation (set for WorkflowRecipe bindings) get paired `bind-<recipe>-<from>-<to>-{egress,ingress}` policies connecting the MCP workload in the MCP server namespace with its counterpart in `sandbox-recipes` on the declared port/protocol (`src/bindingPolicyReconciler.ts`). Deleting the McpServer removes the recipe's binding policies.

### Reconciliation Lifecycle

- **Startup safety** — Ensures L0/L1 defaults, revokes stale or orphaned context-allow, rpc-proxy-egress, and external-egress policies from authoritative Context/McpServer inventories, then certifies readiness safety.
- **Startup additive convergence** — Reconciles Context allows after certification. The dedicated external-egress coordinator is the sole owner of McpServer egress creation, per-server startup gating, retry, and periodic DNS refresh; a failed binding blocks only that server's runtime.
- **Context ADDED/MODIFIED/DELETED** — Creates, updates, or removes the L2 policy set for that context.
- **McpServer ADDED/MODIFIED/DELETED** — Reconciles L3 external egress (before the workload Deployment is created) and recipe binding policies.

### Resync and orphan sweep

Every NetworkPolicy `fullReconcile` (startup, event-driven, and timer) sweeps HCC-labeled `context-allow`, `rpc-proxy-egress` and `external-egress` policies whose Context or McpServer no longer exists. Each delete counts in `clerum_hcc_netpol_orphans_deleted_total{lane}`.

A mass-delete guard protects against a bad cache. If the orphan count is above `CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP` (default `10`) or above `CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP_PERCENT` of the listed fleet (default `20`), the pass deletes nothing, still certifies, and increments `clerum_hcc_netpol_orphan_sweep_capped_total`. Those orphans stay until an operator raises the cap.

Two periodic timers exist, both **off by default** (`0`):

- `CONTEXT_MAPPER_NETPOL_RESYNC_SEC` re-runs the full coordinated pass (sweep plus L0/L1 defaults). A tick that finds a pass in flight is skipped, not queued.
- `CONTEXT_MAPPER_NETPOL_DEFAULTS_RESYNC_SEC` re-applies only the L0/L1 defaults.

With both off, startup still converges once and watch events still reconcile. See the [NetworkPolicy env table](#networkpolicy) for the full rules.

### Cross-Namespace Targeting

Policies select peers with the built-in `kubernetes.io/metadata.name` namespace label combined with pod label selectors, e.g. the L2 ingress rule:

```yaml
ingress:
  - from:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: mcp-host
        podSelector:
          matchLabels:
            clerum.io/managed-by: host-context-controller
            clerum.io/context: context1
    ports:
      - port: 3000
        protocol: TCP
```

## Host Operator

When a `Host` CRD is created, modified, or deleted in the host namespace, the host-context-controller host reconciler:

- **ADDED** — Validates that `spec.secretRef` exists, then creates/updates, in the host namespace (`mcp-host`):
  - `Deployment/<host-name>`
  - `Service/<host-name>`
  - `PersistentVolumeClaim/<host-name>-workspace`
  - `Secret/host-<host-name>-mcp-host-runtime-tokens` (runtime credentials, rotated by the reconciler)
  - `ServiceAccount/`, `Role/` and `RoleBinding/` scoping the pod to its own Host CRD and Secrets
  - `NetworkPolicy/allow-rpc-proxy-desktop-<host-name>` for desktop hosts
  - `NetworkPolicy/mcp-host-<host-name>-egress-codex-proxy` / `-egress-grok-proxy` for Hosts configured for a Codex or Grok subscription ([guide](../docs/how-to/connect-llm-subscription.md))
  - `NetworkPolicy/mcp-host-<host-name>-egress-llm-hooks` for Hosts that reference guardrail hooks (see [LlmHook Operator](#llmhook-operator))

  It also reconciles, in the channels namespace (`CONTEXT_MAPPER_CHANNELS_NAMESPACE`, default `channels`), a per-Host `Service/channel-reader-<host-name>`, `Deployment/channel-reader-<host-name>` and `NetworkPolicy/channel-reader-<host-name>-egress`.

- **MODIFIED** — Reconciles the same resources to match current runtime defaults and host identity.
- **DELETED** — Deletes the resources listed above, in both namespaces.

Generated resources are labeled for orphan cleanup:

| Label                  | Value                     | Purpose                                            |
| ---------------------- | ------------------------- | -------------------------------------------------- |
| `clerum.io/managed-by` | `host-context-controller` | Identifies operator-managed host runtime resources |
| `clerum.io/host`       | `<host-name>`             | Tracks ownership to a specific Host CRD            |

On startup, a full host reconciliation pass runs and deletes orphaned host runtime resources whose Host CRD no longer exists — including orphaned channel-reader resources in `channels` and orphaned per-Host NetworkPolicies (`sweepOrphanChannelReaderResources`, `sweepOrphanHostNetworkPolicies`).

The same full pass repeats every `CONTEXT_MAPPER_HOST_RESYNC_SEC` (default `300`). It runs at most `HCC_HOST_FULL_RECONCILE_CONCURRENCY` Hosts at a time (default `2`). Per-Host watch events (ADDED, MODIFIED, DELETED, wake) are admitted outside that budget. Each finite Kubernetes call on this path has its own deadline (`HCC_HOST_K8S_REQUEST_TIMEOUT_MS`, default `30000`).

**No-op writes are skipped.** Before replacing the per-Host Role, HCC compares the live rules and labels with the desired ones (`roleMatchesDesired` in `src/hostReconciler.ts`). When they match, no `replace()` is sent and `clerum_hcc_write_skips_total{kind="Role"}` increments. Other objects written through `replaceWithConflictRetry` follow the same pattern.

### Stateless lifecycle

A Host with `spec.lifecycle.stateless: true` can be suspended when idle. mcp-host keeps its session state on the workspace PVC, so HCC can scale the Deployment to 0 and bring it back later. Field reference: [Host CRD](../docs/crds/host.md). Design invariants: [stateless-invariants.md](../docs/architecture/stateless-invariants.md).

The durable state lives in `Host.status.lifecycle.state`: `active`, `draining` or `suspended`. HCC sets Deployment replicas from it on every reconcile (`0` when `suspended`), so a suspended Host stays suspended across HCC restarts.

HCC refuses stateless mode, keeps the Host `active`, and writes `StatelessEnableRejected=True` when any of these apply (`src/statelessLifecycleExecutor.ts`):

| Reason                        | Cause                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `DesktopEnabled`              | `spec.desktop` is set.                                                          |
| `ActiveCommunicationChannels` | A CommunicationChannel points at the Host. Channel-connected Hosts stay active. |
| `SfsColocationUnsatisfiable`  | Two or more SharedFileSystem mounts are pinned to different nodes.              |

**Idle and drain.** HCC does not receive heartbeats directly. mcp-host sends them to control-api, and HCC polls `GET /api/v1/auth/mcp-host/heartbeats` every `CONTEXT_MAPPER_HEARTBEAT_POLL_MS` (default 10 s) with its InternalControl JWT (`src/heartbeatPoller.ts`). A Host becomes drain-eligible when it reports no active work and its last activity is older than `max(CONTEXT_MAPPER_STATELESS_IDLE_MINUTES, CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES)`, which is 30 minutes with the defaults. A pod older than `CONTEXT_MAPPER_STATELESS_MAX_UPTIME_HOURS` (default 72) drains regardless of activity. HCC marks the Host `draining`; when the pod reports `drained`, HCC writes `suspended` (reason `idle`). If the pod acknowledged the drain (or went silent) but never reports `drained`, HCC suspends after `CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS` (default 60 s). If the heartbeat feed itself is down, the grace re-arms instead.

When activity keeps a Host awake, HCC publishes the cause in `status.lifecycle.reason` as `SuspendBlocked: <condition>`, where the condition is one of `awaitingApproval`, `activeTask`, `pendingResults`, `activeCronSchedules`, `activeWork` or `recentActivity`.

**Wake.** control-api requests a wake by bumping the `clerum.io/wake-requested` annotation on the Host. When that generation is higher than `status.lifecycle.wakeHandledGeneration`, HCC treats the wake as pending and will not drain or suspend the Host. Its wake fast-path first writes `state: active` with `wakeHandledGeneration` set to the requested generation, then scales the Deployment back up. Writing the status first means the wake survives an HCC crash before the scale.

**Image pull policy.** `CONTEXT_MAPPER_STATELESS_IMAGE_PULL_POLICY` overrides the pull policy for stateless pods (empty means inherit `CONTEXT_MAPPER_HOST_IMAGE_PULL_POLICY`). If it resolves to `IfNotPresent` and the image is not pinned (`@sha256:` digest or a `sha-<gitsha>` tag), the pod still runs with `IfNotPresent`, and HCC writes `StatelessPullPolicyRejected=True` (reason `MutableImageReference`) to warn that a wake can start stale cached code.

## LlmHook Operator

`LlmHook` CRs are installed guardrail hooks in the `llm-hooks` namespace (`CONTEXT_MAPPER_LLM_HOOKS_NAMESPACE`). Field reference: [LlmHook CRD](../docs/crds/llmhook.md). Operator guide: [Configure guardrails](../docs/how-to/configure-guardrails.md).

What HCC does depends on `spec.target` (`src/llmHookReconciler.ts`):

| Target    | What HCC creates                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------- |
| `image`   | A shared `Deployment`, `Service` and `NetworkPolicy`, all named `llmhook-<podKey>`, in `llm-hooks`.  |
| `service` | No workload. Only an ingress NetworkPolicy `llmhook-svc-<crName>` that admits the referencing Hosts. |
| `remote`  | Nothing. Status only.                                                                                |

**Shared pods (dedup).** Unlike other HCC reconcilers, many CRs can map to one workload. Image hooks that share a _pod key_ (a hash of image ref, port, `envSecret`, `egressBindings` and `addCapabilities`) run on one pod and are told apart by `spec.path`. The workload is reference-counted: HCC deletes it when the last member CR for that pod key is gone. Work is serialized per pod key, not per CR name.

**Network.** `llm-hooks` starts fully closed by the static `llm-hooks-static-default-deny` policy (`deploy/base/llm-hooks/networkpolicies.yaml`). The namespace is deliberately not in `CONTEXT_MAPPER_RUNTIME_NAMESPACES`, so it gets no namespace-wide DNS. HCC then opens only:

- ingress to a hook pod from the mcp-host pods whose Host lists that hook under `spec.guardrails.hooks`;
- egress from a hook pod to its declared `egressBindings` plus DNS to `kube-system`, only when it declares any (a hook with no bindings gets no egress at all);
- a per-Host `mcp-host-<host>-egress-llm-hooks` policy in `mcp-host` that lets each Host reach only the hooks it references (removed when it references none).

Host changes re-run these policies through a Host→LlmHook reverse index. Status reports `observedDigest`, `readyReplicas` and a `Ready` condition (reasons `NoWorkload`, `Deploying`, `Ready`, `DuplicatePath`, `SecretNotFound`, `InvalidEgress`, `ReconcileError`).

A full LlmHook pass runs at startup and every `CONTEXT_MAPPER_LLM_HOOK_RESYNC_SEC` (default `300`). It reconciles every pod key and every Host's hook egress, then deletes `llmhook-*` workloads whose pod key has no live member. Rotating a hook's `envSecret` rolls its pod through the [credentials-revision annotation](#credential-rollout).

## REST API

The Host-facing MCP contract is authenticated and Host-scoped. HCC verifies the
runtime bearer, resolves the live Host and its live Context server-side, and
checks the Context grant before it reads credential material. Callers do not
supply a Context reference.

### Health Check

```
GET /health
```

```json
{ "status": "ok", "ready": true }
```

The server also exposes `GET /` (API information), `GET /ready` (readiness: `200` once the controller is running and its McpServer, Context and Host watches are synced; otherwise `503` with a `reasons[]` list such as `controller_stopped`, `mcp_watch_unsynced`, `context_watch_unsynced`, `host_watch_unsynced`), `GET /metrics` (Prometheus), and `GET /api/v1/desktop/:hostRef` (desktop status; requires the `CONTEXT_MAPPER_DESKTOP_API_TOKEN` bearer token — the check is skipped when that variable is empty).

### Temporary system inventory (PR 2 compatibility)

```
GET /api/v1/mcpservers
```

```json
{
  "servers": [
    {
      "name": "mongodb-server",
      "transport": {
        "type": "sse",
        "url": "http://mongodb-server.mcp-server.svc.cluster.local:3000/sse"
      },
      "enabled": true,
      "status": { "deployed": true, "ready": true }
    }
  ],
  "contextRef": "*",
  "timestamp": "2026-02-14T15:11:12.000Z"
}
```

This anonymous, metadata-only route is retained temporarily for the existing
`mcp-proxy` poller. It is not the mcp-host discovery contract and exposes no
auth selector or Secret metadata. Its removal or authentication belongs to the
separate PR 2 migration.
The top-level `contextRef` is a legacy constant (`"*"`) with no consumer;
servers carry no context of their own, since a server belongs to a context only
through that Context's `mcpServers` list.

### Authenticated Host inventory

```
GET /api/v2/hosts/self/mcpservers
Authorization: Bearer <mcp-host-runtime-token>
```

The response contains only enabled McpServers granted by the authenticated
Host's live Context. It omits `contextRef`, auth selectors, and Secret metadata.
An authenticated server includes an opaque `credentialRevision` so mcp-host can
retire a credential before admitting a changed revision.

The verifier accepts only RS256 tokens from the configured Control API issuer
with an exact HCC audience set (HCC-only, or the bounded HCC + workflow
migration pair), one `hostRefs` entry, the matching `host_uid`, and the single
`mcp:credential:read` capability. The historical workflow scope/standalone
recipe claims identify the reused runtime-token family; they do not grant a
Context. HCC derives that authorization from the live Host and Context objects.

```json
{
  "servers": [
    {
      "name": "mongodb-server",
      "transport": {
        "type": "sse",
        "url": "http://mongodb-server.mcp-server.svc.cluster.local:3000/sse"
      },
      "enabled": true,
      "status": { "deployed": true, "ready": true },
      "authRequired": true,
      "credentialRevision": "opaque-revision"
    }
  ],
  "timestamp": "2026-02-14T15:11:12.000Z"
}
```

### Authenticated Host credential

```
POST /api/v2/hosts/self/mcpservers/credential
Authorization: Bearer <mcp-host-runtime-token>
Content-Type: application/json

{ "serverName": "mongodb-server" }
```

Response (with auth):

```json
{ "token": "credential-value", "credentialRevision": "opaque-revision" }
```

Response (no auth configured):

```json
{ "token": null, "credentialRevision": "opaque-revision" }
```

HCC returns the same opaque `404 {"error":"not_found"}` for an ungranted,
missing, disabled, or cross-Context server name. It performs the grant check
before any Secret value read and revalidates the live authority snapshot after
the read. Protected responses are non-cacheable.

The legacy caller-selected routes
`GET /api/v1/mcpservers/context/:contextRef` and
`GET /api/v1/mcpservers/:name/auth` are tombstoned with a generic HTTP 410 at
both the gateway and HCC application layers; there is no v1 fallback.

## Metrics

`GET /metrics` serves Prometheus metrics from a dedicated registry (`src/metrics.ts`). Every series carries the default label `service="host-context-controller"`. Labels are low-cardinality by design: no Host, user, team, Secret or JWT values appear in them (the one exception is `clerum_hcc_mcpserver_missing_secret`, which names the McpServer and Secret).

For the create and existence-read counters, including PromQL examples, see [CREATE_OBSERVABILITY.md](CREATE_OBSERVABILITY.md).

**Inventory and reconcile results**

| Metric                                          | Type    | Labels                             | Meaning                                                                                                                                                   |
| ----------------------------------------------- | ------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clerum_hcc_mcpservers_total`                   | gauge   | `status`                           | McpServer CRDs tracked by HCC.                                                                                                                            |
| `clerum_hcc_networkpolicies_total`              | gauge   | `layer`                            | NetworkPolicies managed by HCC.                                                                                                                           |
| `clerum_hcc_context_reconciliations_total`      | counter | `result`                           | Context reconciliations.                                                                                                                                  |
| `clerum_hcc_binding_reconciliations_total`      | counter | `result`                           | Recipe binding-policy reconciliations.                                                                                                                    |
| `clerum_hcc_context_metadata_only_events_total` | counter | —                                  | Context MODIFIED events that did not change the desired state, so Host and SharedFileSystem fan-out was skipped. A rising rate means label churn is back. |
| `clerum_hcc_mcpserver_missing_secret`           | gauge   | `namespace`, `name`, `secret_name` | `1` while an McpServer references a Secret that does not exist.                                                                                           |
| `clerum_hcc_external_egress_retries_at_cap`     | gauge   | —                                  | McpServers whose external-egress DNS retry is stuck at the maximum backoff.                                                                               |

**Kubernetes writes**

| Metric                             | Type    | Labels            | Meaning                                                                                   |
| ---------------------------------- | ------- | ----------------- | ----------------------------------------------------------------------------------------- |
| `clerum_hcc_creates_total`         | counter | `kind`, `outcome` | Create outcomes: `created`, `conflict`, `error`, `skipped`. See CREATE_OBSERVABILITY.md.  |
| `clerum_hcc_existence_reads_total` | counter | `kind`, `outcome` | Existence GETs on create/converge paths: `found`, `absent`, `error`.                      |
| `clerum_hcc_writes_total`          | counter | `kind`            | Successful `replace()` calls made through `replaceWithConflictRetry`.                     |
| `clerum_hcc_write_skips_total`     | counter | `kind`            | Replaces skipped because the live object already matched (for example the per-Host Role). |

**NetworkPolicy convergence**

| Metric                                                          | Type      | Labels           | Meaning                                                                                                          |
| --------------------------------------------------------------- | --------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `clerum_hcc_initial_convergence_retries_total`                  | counter   | `lane`           | Retries scheduled after a failed background convergence pass.                                                    |
| `clerum_hcc_initial_convergence_last_success_timestamp_seconds` | gauge     | `lane`           | Unix time of the last successful background convergence pass.                                                    |
| `clerum_hcc_initial_convergence_swallowed_total`                | counter   | `lane`, `sink`   | Convergence requests that returned without certifying.                                                           |
| `clerum_hcc_initial_convergence_effects_dropped_total`          | counter   | `lane`, `kind`   | Allow-policy writes dropped because the pass's inventory lease was retired.                                      |
| `clerum_hcc_initial_convergence_pass_results_total`             | counter   | `lane`, `result` | Named outcomes of convergence passes.                                                                            |
| `clerum_hcc_initial_convergence_pass_duration_seconds`          | histogram | `lane`, `result` | Duration of a convergence pass.                                                                                  |
| `clerum_hcc_networkpolicy_safety_pass_duration_seconds`         | histogram | `outcome`        | Time until a safety pass has revoked stale allows.                                                               |
| `clerum_hcc_networkpolicy_safety_pass_policies_total`           | counter   | `operation`      | Policies listed and revoked by safety passes.                                                                    |
| `clerum_hcc_netpol_orphans_deleted_total`                       | counter   | `lane`           | Orphan NetworkPolicies deleted by a `fullReconcile` sweep.                                                       |
| `clerum_hcc_netpol_orphan_sweep_capped_total`                   | counter   | `reason`         | Sweeps that refused to delete because the orphan count hit the `absolute` or `percent` cap.                      |
| `clerum_hcc_netpol_resync_ticks_skipped_total`                  | counter   | `reason`         | Resync ticks skipped because a pass (`pass-in-flight`) or defaults tick (`defaults-only-in-flight`) was running. |
| `clerum_hcc_netpol_defaults_only_ticks_total`                   | counter   | `result`         | Defaults-only ticks by result (`success`, `error`).                                                              |
| `clerum_hcc_netpol_defaults_only_tick_duration_seconds`         | histogram | `result`         | Duration of a defaults-only tick.                                                                                |

**Host reconciliation**

| Metric                                             | Type      | Labels              | Meaning                                                                                         |
| -------------------------------------------------- | --------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `clerum_hcc_host_reconcile_queue_wait_seconds`     | histogram | `lane`, `outcome`   | Time a Host reconcile waited before its per-Host chain admitted it.                             |
| `clerum_hcc_host_reconcile_duration_seconds`       | histogram | `source`, `outcome` | Time a Host reconcile body ran after admission.                                                 |
| `clerum_hcc_host_reconcile_in_flight`              | gauge     | `lane`              | Host reconciles running now, by lane (`urgent`, `retry`, `fleet`).                              |
| `clerum_hcc_host_watch_recovery_seconds`           | histogram | `phase`, `outcome`  | Host watch LIST-to-WATCH recovery time (`list`, `watch`, `total`).                              |
| `clerum_hcc_host_fleet_requests_total`             | counter   | `result`            | Fleet pass requests: `started`, `coalesced`, `trailing`, `failed`.                              |
| `clerum_hcc_host_fleet_benign_supersessions_total` | counter   | `error`             | Fleet workers withdrawn because a newer equivalent pass replaced them.                          |
| `clerum_hcc_host_fleet_lifecycle_catch_total`      | counter   | `decision`          | Fleet catch-path decisions during a CommunicationChannel lifecycle change (`applied`, `retry`). |
| `clerum_hcc_host_cleanup_deferred_total`           | counter   | `reason`            | Orphan Host cleanups deferred.                                                                  |
| `clerum_hcc_host_delete_cleanup_total`             | counter   | `outcome`           | Host deletion cleanup: `queued`, `confirmed`, `completed`, `retried`, `superseded`.             |

**Secret watch, MCP API and reporters**

| Metric                                               | Type    | Labels                        | Meaning                                                                                                 |
| ---------------------------------------------------- | ------- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `clerum_hcc_secret_informer_events_total`            | counter | `type`                        | Secret informer events received.                                                                        |
| `clerum_hcc_secret_informer_reconnects_total`        | counter | —                             | Secret informer reconnect attempts.                                                                     |
| `clerum_hcc_secret_informer_running`                 | gauge   | —                             | `1` while the Secret watch is established.                                                              |
| `clerum_hcc_mcp_host_api_requests_total`             | counter | `action`, `outcome`, `reason` | Host-scoped MCP API requests (inventory, credential).                                                   |
| `clerum_hcc_infrastructure_telemetry_enqueued_total` | counter | `telemetry_type`              | Telemetry items accepted by the bounded reporter.                                                       |
| `clerum_hcc_infrastructure_telemetry_dropped_total`  | counter | `telemetry_type`, `reason`    | Telemetry items dropped.                                                                                |
| `clerum_hcc_infrastructure_telemetry_flushes_total`  | counter | `result`                      | Telemetry flush attempts.                                                                               |
| `clerum_hcc_infrastructure_telemetry_retries_total`  | counter | `telemetry_type`              | Telemetry retries after a failed flush.                                                                 |
| `clerum_hcc_infrastructure_telemetry_gaps_total`     | counter | `telemetry_type`, `reason`    | Gaps that leave trace or cost coverage incomplete.                                                      |
| `clerum_hcc_administrative_outcome_reporter_total`   | counter | `result`                      | Administrative outcome reports: enqueued, deduplicated, accepted, conflict, rejected, or a drop reason. |

## Environment Variables

HCC reads environment variables from `src/config.ts`, `src/gfsConfig.ts`,
`src/logger.ts`, and `src/k8sApiCidrs.ts`. Defaults below are the literal fallbacks
in code; where the deploy manifest overrides one, that is noted.

**Parsing semantics.** `getEnv(key, default)` uses `process.env[key] ?? default`,
so an **empty string wins over the default** — that is how the minikube overlay
disables the image-pull secret with `value: ""`. `getEnvInt` / `getEnvBool` treat
an empty string as unset and fall back to the default; `getEnvBool` accepts
`true` (any case) or `1`.

**Three variables fail the process closed on bad input** rather than programming
a permissive policy — see the NetworkPolicy and GFS tables:
`CONTEXT_MAPPER_K8S_API_CIDRS`, `CONTEXT_MAPPER_NODELOCAL_DNS_CIDR`, and
`CONTEXT_MAPPER_GFSC_IMAGE_PULL_POLICY`.

**Newer numeric knobs are parsed strictly** and also fail startup on a bad value
instead of silently falling back: the `CONTEXT_MAPPER_NETPOL_*` and
`HCC_EXTERNAL_EGRESS_*` families, `HCC_HOST_FULL_RECONCILE_CONCURRENCY`,
`HCC_HOST_K8S_REQUEST_TIMEOUT_MS` and `CONTEXT_MAPPER_HEARTBEAT_POLL_MS`. Most of
them treat an empty string as unset. `HCC_HOST_K8S_REQUEST_TIMEOUT_MS` does not:
set to `""` it fails startup.

**Removed variable.** `CLERUM_STATELESS_COMMUNICATION_CHANNEL_POLICY` is no
longer supported. Any non-empty value fails startup; CommunicationChannel-connected
Hosts are always kept active.

### Core / server

| Variable              | Default | Description                                                                                                                                          |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_PORT` | `8081`  | HTTP server port.                                                                                                                                    |
| `CLERUM_DEV_MODE`     | `false` | Read McpServers/Contexts/auth tokens from env instead of the K8s API. Also skips the `INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET` startup assertion below. |
| `LOG_LEVEL`           | `info`  | `debug` \| `info` \| `warn` \| `error`. Unrecognized values fall back to `info`.                                                                     |

### Namespaces

| Variable                                 | Default           | Description                                                                                                                                                                |
| ---------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_NAMESPACE`               | `mcp-server`      | Where `McpServer` / `Context` CRDs live and managed server workloads are created.                                                                                          |
| `CONTEXT_MAPPER_CONTROL_PLANE_NAMESPACE` | `control-plane`   | Where control-plane gateway services live.                                                                                                                                 |
| `CONTEXT_MAPPER_HOST_NAMESPACE`          | `mcp-host`        | Where mcp-host pods run (drives NetworkPolicy generation).                                                                                                                 |
| `CONTEXT_MAPPER_GFS_NAMESPACE`           | `gfs`             | Where the GlobalFileSystem controller (gfsc) runs.                                                                                                                         |
| `CONTEXT_MAPPER_RPC_PROXY_NAMESPACE`     | `rpc-proxy`       | Where rpc-proxy runs (L2 egress policy generation).                                                                                                                        |
| `CONTEXT_MAPPER_CHANNELS_NAMESPACE`      | `channels`        | Per-Host channel-reader Deployments/Services.                                                                                                                              |
| `CONTEXT_MAPPER_SANDBOX_NAMESPACE`       | `sandbox-recipes` | Workflow-recipe namespace. Read only by the GFS factory.                                                                                                                   |
| `CONTEXT_MAPPER_LLM_HOOKS_NAMESPACE`     | `llm-hooks`       | Where `LlmHook` CRDs are watched and image-hook workloads run.                                                                                                             |
| `HCC_TARGET_NAMESPACE`                   | `mcp-host`        | Namespace HCC names when asking control-api for caller-bound 1st-party mcp-host credentials. It must exactly equal `CONTEXT_MAPPER_HOST_NAMESPACE`; HCC exits 1 otherwise. |

### MCP server provisioning

| Variable                                     | Default                             | Description                                                                                                                                                                                                                                |
| -------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CONTEXT_MAPPER_MCPSERVER_IMAGE_PULL_POLICY` | `IfNotPresent`                      | Pull policy for reconciled McpServer workloads.                                                                                                                                                                                            |
| `CONTEXT_MAPPER_EGRESS_PROXY_IMAGE`          | `clerum/nginx-egress-proxy:0.1.0`   | Per-server nginx egress proxy for **remote** MCP servers (`spec.remote`).                                                                                                                                                                  |
| `CONTEXT_MAPPER_STDIO_BRIDGE_IMAGE`          | (registry-qualified `stdio-bridge`) | stdio-bridge sidecar image for managed stdio MCP servers. Manifest pins `clerum/stdio-bridge:0.9.5`.                                                                                                                                       |
| `CONTEXT_MAPPER_STDIO_BRIDGE_REQUEST_MEMORY` | `32Mi`                              | stdio-bridge sidecar memory request.                                                                                                                                                                                                       |
| `CONTEXT_MAPPER_STDIO_BRIDGE_REQUEST_CPU`    | `50m`                               | stdio-bridge sidecar CPU request.                                                                                                                                                                                                          |
| `CONTEXT_MAPPER_STDIO_BRIDGE_LIMIT_MEMORY`   | `128Mi`                             | stdio-bridge sidecar memory limit.                                                                                                                                                                                                         |
| `CONTEXT_MAPPER_STDIO_BRIDGE_LIMIT_CPU`      | `200m`                              | stdio-bridge sidecar CPU limit.                                                                                                                                                                                                            |
| `HCC_EXTERNAL_EGRESS_RESYNC_SEC`             | `60`                                | Periodic external-egress DNS resync interval (seconds). `0` disables periodic refresh; watch events still reconcile. When enabled it must be at least the refresh floor and at most half the overlap; max `3600`. Startup fails otherwise. |
| `HCC_EXTERNAL_EGRESS_DNS_TIMEOUT_MS`         | `5000`                              | Per-hostname DNS lookup deadline in milliseconds.                                                                                                                                                                                          |
| `HCC_EXTERNAL_EGRESS_OVERLAP_SEC`            | `300`                               | How long a resolved `/32` stays allowed after its DNS TTL, so a provider that rotates A records keeps working. 1–3600.                                                                                                                     |
| `HCC_EXTERNAL_EGRESS_REFRESH_FLOOR_SEC`      | `5`                                 | Minimum resync interval; guards against a hot loop. 1–3600.                                                                                                                                                                                |
| `HCC_EXTERNAL_EGRESS_MAX_ENTRIES`            | `128`                               | Accumulated IPs kept per hostname. On overflow the least recently seen IP is evicted. 1–1300.                                                                                                                                              |

### mcp-host provisioning

| Variable                                            | Default                         | Description                                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_HOST_IMAGE`                         | (registry-qualified `mcp-host`) | Image for reconciled Host Deployments. Manifest pins `clerum/mcp-host:0.9.5`.                                                                                                                  |
| `CONTEXT_MAPPER_HOST_IMAGE_PULL_POLICY`             | `Always`                        | Pull policy. Minikube overlay sets `IfNotPresent`.                                                                                                                                             |
| `CONTEXT_MAPPER_HOST_IMAGE_PULL_SECRET`             | `clerum`                        | `imagePullSecrets` name. Minikube overlay sets `""` to disable (empty string overrides the default).                                                                                           |
| `CONTEXT_MAPPER_HOST_PORT`                          | `8080`                          | Container/service port for the host runtime.                                                                                                                                                   |
| `CONTEXT_MAPPER_HOST_CONFIGMAP_NAME`                | `mcp-host-config`               | ConfigMap loaded into host containers via `envFrom`.                                                                                                                                           |
| `CONTEXT_MAPPER_HOST_SERVICE_ACCOUNT`               | `mcp-host`                      | ServiceAccount used by Host Deployments.                                                                                                                                                       |
| `CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS`       | `do-block-storage-retain`       | StorageClass for per-host workspace PVCs. Minikube overlay sets `standard`.                                                                                                                    |
| `CONTEXT_MAPPER_HOST_WORKSPACE_SIZE`                | `10Gi`                          | Requested per-host workspace PVC size.                                                                                                                                                         |
| `CONTEXT_MAPPER_HOST_WORKSPACE_PATH`                | `/workspace`                    | Workspace mount path inside host containers.                                                                                                                                                   |
| `CONTEXT_MAPPER_HOST_RESOURCES_REQUEST_MEMORY`      | `128Mi`                         | Host container memory request.                                                                                                                                                                 |
| `CONTEXT_MAPPER_HOST_RESOURCES_REQUEST_CPU`         | `100m`                          | Host container CPU request.                                                                                                                                                                    |
| `CONTEXT_MAPPER_HOST_RESOURCES_LIMIT_MEMORY`        | `512Mi`                         | Host container memory limit.                                                                                                                                                                   |
| `CONTEXT_MAPPER_HOST_RESOURCES_LIMIT_CPU`           | `500m`                          | Host container CPU limit.                                                                                                                                                                      |
| `CONTEXT_MAPPER_HOST_RESYNC_SEC`                    | `300`                           | Periodic Host `fullReconcile` (seconds); guards against dropped watch events and drives auth-degraded self-heal. `0` disables.                                                                 |
| `HCC_MCP_HOST_RUNTIME_BOOTSTRAP_REFRESH_BEFORE_SEC` | `900`                           | How long before expiry HCC refreshes the mcp-host bootstrap credential Secret.                                                                                                                 |
| `CONTEXT_MAPPER_RUNTIME_TOKEN_ROTATE_BEFORE_S`      | `86400` (24 h)                  | Rotate the bootstrap runtime-token Secret when the refresh token's real `exp` is closer than this. Capped at half the token's lifetime so short-lived tokens do not rotate on every reconcile. |
| `HCC_HOST_FULL_RECONCILE_CONCURRENCY`               | `2`                             | Hosts reconciled in parallel during a full or lifecycle fleet pass. Integer 1–8; `1` is serial (diagnostic). Per-Host events are not counted against it.                                       |
| `HCC_HOST_K8S_REQUEST_TIMEOUT_MS`                   | `30000`                         | Deadline for each finite Kubernetes request on the Host convergence path. Watches are not affected. Positive integer.                                                                          |

### Stateless Hosts (Host CRD `spec.lifecycle.stateless`)

Only used for Hosts with `spec.lifecycle.stateless: true`. See [Stateless lifecycle](#stateless-lifecycle). `deploy/base` sets the first four to their code defaults.

| Variable                                      | Default    | Description                                                                                                                              |
| --------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_STATELESS_IDLE_MINUTES`       | `30`       | Idle time before a Host may drain.                                                                                                       |
| `CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES` | `15`       | Platform floor. The effective idle window is `max(idle, floor)`.                                                                         |
| `CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS`     | `60000`    | After a drain verdict, how long HCC waits for a `drained` report before suspending anyway (only if the pod acknowledged or went silent). |
| `CONTEXT_MAPPER_HEARTBEAT_POLL_MS`            | `10000`    | How often HCC polls control-api for heartbeats. Positive integer; anything else fails startup.                                           |
| `CONTEXT_MAPPER_STATELESS_MAX_UPTIME_HOURS`   | `72`       | A pod older than this drains regardless of activity.                                                                                     |
| `CONTEXT_MAPPER_STATELESS_IMAGE_PULL_POLICY`  | `` (empty) | Pull policy for stateless pods. Empty inherits `CONTEXT_MAPPER_HOST_IMAGE_PULL_POLICY`.                                                  |

### LlmHook

The namespace is `CONTEXT_MAPPER_LLM_HOOKS_NAMESPACE` (see [Namespaces](#namespaces)).

| Variable                             | Default | Description                                                                                        |
| ------------------------------------ | ------- | -------------------------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_LLM_HOOK_RESYNC_SEC` | `300`   | Periodic LlmHook full pass (seconds): readiness, Host egress, orphan workload sweep. `0` disables. |

### mcp-host API authorization

| Variable                                 | Default       | Description                                                                                                                                |
| ---------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `HCC_MCP_HOST_JWT_PUBLIC_KEY`            | `` (empty)    | RS256 public key used to verify protected v2 Host MCP requests. HCC fails startup when it is absent, malformed, private, or a placeholder. |
| `HCC_MCP_HOST_JWT_ISSUER`                | `control-api` | Exact issuer accepted for protected v2 Host MCP requests.                                                                                  |
| `HCC_MCP_HOST_JWT_MAX_TTL_SECONDS`       | `600`         | Maximum accepted `exp - iat`; the deploy manifest sources this from Control API's access-token TTL contract.                               |
| `HCC_MCP_HOST_API_RATE_LIMIT_PER_MINUTE` | `120`         | Per verified Host UID and action fixed-window limit for inventory and credential requests.                                                 |

### Desktop (Host CRD `spec.desktop`)

| Variable                                          | Default                          | Description                                                                                                                                                                              |
| ------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_DESKTOP_IMAGE`                    | `clerum/mcp-host-desktop:latest` | Desktop sidecar image.                                                                                                                                                                   |
| `CONTEXT_MAPPER_DESKTOP_PORT`                     | `3000`                           | Desktop container port.                                                                                                                                                                  |
| `CONTEXT_MAPPER_DESKTOP_RESOURCES_REQUEST_MEMORY` | `256Mi`                          | Desktop memory request.                                                                                                                                                                  |
| `CONTEXT_MAPPER_DESKTOP_RESOURCES_REQUEST_CPU`    | `250m`                           | Desktop CPU request.                                                                                                                                                                     |
| `CONTEXT_MAPPER_DESKTOP_RESOURCES_LIMIT_MEMORY`   | `4Gi`                            | Desktop memory limit.                                                                                                                                                                    |
| `CONTEXT_MAPPER_DESKTOP_RESOURCES_LIMIT_CPU`      | `1`                              | Desktop CPU limit. Author the apiserver-canonical form (`1`, not `1000m`) so the Deployment no-op gate can match.                                                                        |
| `CONTEXT_MAPPER_DESKTOP_API_TOKEN`                | `` (empty)                       | Bearer token required by `GET /api/v1/desktop/:hostRef`. **When empty the check is skipped and the endpoint is unauthenticated** — a dev-mode convenience. Set it in any shared cluster. |

### channel-reader provisioning

| Variable                                          | Default                       | Description                                                                     |
| ------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_CHANNEL_READER_IMAGE`             | `clerum/channel-reader:0.9.5` | Image for per-Host channel-reader Deployments.                                  |
| `CONTEXT_MAPPER_CHANNEL_READER_IMAGE_PULL_POLICY` | `Always`                      | Pull policy. Minikube overlay sets `IfNotPresent` to use locally-loaded images. |
| `CONTEXT_MAPPER_CHANNEL_READER_HANDOFF_PORT`      | `8099`                        | Internal handoff port on per-Host channel-reader Services.                      |

### workspace-files-controller (WFC) provisioning

| Variable                                      | Default                      | Description                                                                                                                                                                                                    |
| --------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_WFC_IMAGE`                    | (registry-qualified `wfc`)   | Per-SharedFileSystem WFC image. Manifest pins `clerum/workspace-files-controller:0.9.5`.                                                                                                                       |
| `CONTEXT_MAPPER_WFC_IMAGE_PULL_POLICY`        | `IfNotPresent`               | Pull policy for WFC Deployments.                                                                                                                                                                               |
| `CONTEXT_MAPPER_WFC_IMAGE_PULL_SECRET`        | `clerum`                     | `imagePullSecrets` name. Minikube overlay sets `""` to disable.                                                                                                                                                |
| `CONTEXT_MAPPER_WFC_PORT`                     | `8086`                       | WFC container/service port.                                                                                                                                                                                    |
| `CONTEXT_MAPPER_WFC_INIT_IMAGE`               | `busybox:1.36`               | Init container that seeds directories and chowns the fresh PVC.                                                                                                                                                |
| `CONTEXT_MAPPER_WFC_RESOURCES_REQUEST_MEMORY` | `64Mi`                       | WFC memory request.                                                                                                                                                                                            |
| `CONTEXT_MAPPER_WFC_RESOURCES_REQUEST_CPU`    | `50m`                        | WFC CPU request.                                                                                                                                                                                               |
| `CONTEXT_MAPPER_WFC_RESOURCES_LIMIT_MEMORY`   | `128Mi`                      | WFC memory limit.                                                                                                                                                                                              |
| `CONTEXT_MAPPER_WFC_RESOURCES_LIMIT_CPU`      | `200m`                       | WFC CPU limit.                                                                                                                                                                                                 |
| `CONTEXT_MAPPER_WFC_JWT_PUBLIC_KEY_CM`        | `mcp-host-config`            | ConfigMap holding the JWT public key the WFC verifies against.                                                                                                                                                 |
| `CONTEXT_MAPPER_WFC_JWT_PUBLIC_KEY_CM_KEY`    | `CLERUM_AUTH_JWT_PUBLIC_KEY` | Key within that ConfigMap.                                                                                                                                                                                     |
| `CONTEXT_MAPPER_WFC_MAX_UPLOAD_BYTES`         | `104857600` (100 MiB)        | Upload size cap forwarded to the WFC container.                                                                                                                                                                |
| `CONTEXT_MAPPER_WFC_MAX_LIST_ENTRIES`         | `5000`                       | Max directory entries the WFC will list.                                                                                                                                                                       |
| `CONTEXT_MAPPER_WFC_MAX_PATH_DEPTH`           | `32`                         | Max path depth the WFC will traverse.                                                                                                                                                                          |
| `CONTEXT_MAPPER_SFS_RESYNC_SEC`               | `60`                         | Periodic SharedFileSystem `fullReconcile` (seconds). The SFS watch fires only on CRD changes — not on PVC binding or WFC readiness — so this is what drives `Initializing`/`Degraded` → `Ready`. `0` disables. |

### GlobalFileSystem (GFS) provisioning

Read by `src/gfsConfig.ts`. Invalid values **throw at startup** rather than silently defaulting.

| Variable                                                 | Default                      | Description                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_GFSC_PORT`                               | `8087`                       | gfsc service port.                                                                                                                                                                                                                                                          |
| `CONTEXT_MAPPER_GFSC_IMAGE`                              | `clerum/gfs-controller:test` | gfsc writer Deployment image. **The default is a `:test` tag** — override it.                                                                                                                                                                                               |
| `CONTEXT_MAPPER_GFSC_IMAGE_PULL_POLICY`                  | `IfNotPresent`               | Must be exactly `Always` \| `IfNotPresent` \| `Never`; any other non-empty value **throws** at startup.                                                                                                                                                                     |
| `CONTEXT_MAPPER_GFSC_IMAGE_PULL_SECRET`                  | _(unset)_                    | Optional `imagePullSecrets` name for gfsc.                                                                                                                                                                                                                                  |
| `CONTEXT_MAPPER_GFSC_PRIORITY_CLASS`                     | _(unset)_                    | Optional `priorityClassName` for the gfsc Deployment.                                                                                                                                                                                                                       |
| `CONTEXT_MAPPER_GFSC_INIT_IMAGE`                         | `busybox:1.36`               | gfsc init-container image.                                                                                                                                                                                                                                                  |
| `CONTEXT_MAPPER_GFSC_REQUEST_MEMORY`                     | `128Mi`                      | gfsc memory request.                                                                                                                                                                                                                                                        |
| `CONTEXT_MAPPER_GFSC_REQUEST_CPU`                        | `100m`                       | gfsc CPU request.                                                                                                                                                                                                                                                           |
| `CONTEXT_MAPPER_GFSC_LIMIT_MEMORY`                       | `256Mi`                      | gfsc memory limit.                                                                                                                                                                                                                                                          |
| `CONTEXT_MAPPER_GFSC_LIMIT_CPU`                          | `500m`                       | gfsc CPU limit.                                                                                                                                                                                                                                                             |
| `CONTEXT_MAPPER_GFS_POSTGRES_APP_LABEL`                  | `control-postgres`           | `app` pod label selecting the Postgres pods gfsc may reach (NetworkPolicy).                                                                                                                                                                                                 |
| `CONTEXT_MAPPER_GFS_POSTGRES_PORT`                       | `5432`                       | Postgres port for the gfsc egress policy.                                                                                                                                                                                                                                   |
| `CONTEXT_MAPPER_GFS_JWT_CONFIGMAP`                       | `gfs-config`                 | ConfigMap holding the JWT public key gfsc verifies against.                                                                                                                                                                                                                 |
| `CONTEXT_MAPPER_GFS_JWT_CONFIGMAP_KEY`                   | `jwt-public-key`             | Key within that ConfigMap.                                                                                                                                                                                                                                                  |
| `CONTEXT_MAPPER_GFS_PG_SECRET`                           | `gfs-controller-db`          | Secret holding the gfsc Postgres connection string.                                                                                                                                                                                                                         |
| `CONTEXT_MAPPER_GFS_PG_SECRET_KEY`                       | `connection-string`          | Key within that Secret.                                                                                                                                                                                                                                                     |
| `CONTEXT_MAPPER_GFS_READER_PG_SECRET`                    | `gfs-controller-reader-db`   | Secret holding the connection string for gfsc **reader** pods, so readers and the writer use separate least-privilege database roles.                                                                                                                                       |
| `CONTEXT_MAPPER_GFS_READER_PG_SECRET_KEY`                | `connection-string`          | Key within that Secret.                                                                                                                                                                                                                                                     |
| `CONTEXT_MAPPER_GFS_DRIVE_NAME`                          | `main`                       | Default GFS drive name.                                                                                                                                                                                                                                                     |
| `CONTEXT_MAPPER_GFS_TOKEN_AUDIENCE`                      | `gfs-controller`             | Expected `aud` claim on GFS access tokens.                                                                                                                                                                                                                                  |
| `CONTEXT_MAPPER_GFSC_AUTH_PROTOCOL_CUTOVER_ENABLED`      | `false`                      | Test-fleet-only: require protocol-v2 user claims on generated GFS writer and reader pods.                                                                                                                                                                                   |
| `CONTEXT_MAPPER_GFS_RESYNC_SEC`                          | `60`                         | Periodic GlobalFileSystem `fullReconcile` (seconds); drives convergence to `Ready` and the root-directory seed. `0` disables.                                                                                                                                               |
| `CONTEXT_MAPPER_GFSC_AGENT_READ_RL_PER_MIN_PER_REPLICA`  | `300`                        | Per-subject agent (host principal) read budget per minute, per gfsc replica. Written to every gfsc pod as `GFS_AGENT_READ_RL_PER_MIN_PER_REPLICA`. Canonical decimal from 1 to 60000; an empty or non-canonical value (`0x10`, `1e3`, `45.0`, `045`) **throws** at startup. |
| `CONTEXT_MAPPER_GFSC_AGENT_WRITE_RL_PER_MIN_PER_REPLICA` | `120`                        | Same for writes, written as `GFS_AGENT_WRITE_RL_PER_MIN_PER_REPLICA`. Same rules.                                                                                                                                                                                           |

The two agent budgets are part of the gfsc pod template, like `CONTEXT_MAPPER_GFSC_IMAGE`.
Changing either value, or the gfsc image, changes the writer's pod-template hash, so the
next reconcile restarts the whole gfsc fleet once: readers are scaled to 0, the writer is
recreated (`strategy: Recreate`), and readers return after the writer is available
(`src/gfsReconciler.ts`). Reads and writes through gfsc are unavailable for that window.
The defaults equal gfsc's own (`gfs-controller/src/config.ts`), which a test pins.

**Pass-through gfsc limits.** HCC also forwards a set of gfsc tuning variables
unchanged into the gfsc pods (`gfscEnv` in `src/k8s/gfsFactory.ts`):
`GFS_SYNC_COPY_MAX_OBJECTS`, `GFS_SYNC_COPY_MAX_BYTES`, `GFS_SYNC_COPY_TIMEOUT_MS`,
`GFS_MAX_WRITE_BODY_BYTES`, and every `CONTEXT_MAPPER_GFSC_UPLOAD_*` variable
(written to the pod as the matching `GFS_UPLOAD_*` name;
`CONTEXT_MAPPER_GFSC_UPLOAD_V2_ENABLED` goes to the writer only). HCC sets no
default for these: an unset variable is not injected, and gfsc's own default
applies (`gfs-controller/src/config.ts`; for `GFS_MAX_WRITE_BODY_BYTES`, 16 MiB
in `gfs-controller/src/api/serve.ts`). `deploy/base` sets only
`GFS_MAX_WRITE_BODY_BYTES` (`25165824`, 24 MiB).

### NetworkPolicy

| Variable                                          | Default                                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_RUNTIME_NAMESPACES`               | `mcp-server,mcp-host,sandbox-recipes,rpc-proxy` | Namespaces that get L0 deny-all + L1 infrastructure policies. Manifest overrides to `mcp-server,sandbox-recipes,rpc-proxy,sandbox-ui` — note it **drops `mcp-host`**, whose policies are static (`deploy/base/mcp-host/networkpolicies.yaml`), because an HCC deny-all would block mcp-host from reaching LLM APIs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `CONTEXT_MAPPER_MINIMAL_INFRA_NAMESPACES`         | `` (empty)                                      | Subset of runtime namespaces that get **only** deny-all + DNS egress — no HCC-API or K8s-API egress. Manifest sets `sandbox-ui`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `CONTEXT_MAPPER_K8S_API_CIDRS`                    | _(unset → `[]`)_                                | K8s API-server CIDRs for `allow-k8s-api-egress-*`. Empty falls back to `KUBERNETES_SERVICE_HOST`. **Validated fail-closed at module load**: a malformed entry, or one broader than `/24` (IPv4) or `/120` (IPv6), **crashes startup** rather than programming a permissive policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `CONTEXT_MAPPER_NODELOCAL_DNS_CIDR`               | `` (empty)                                      | DNS infrastructure CIDR for NodeLocal DNSCache / kube-dns. Must be exactly one IPv4 `/32`; anything else throws at startup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `CONTEXT_MAPPER_NETPOL_RESYNC_SEC`                | `0`                                             | Periodic NetworkPolicy coordinated convergence (seconds). Re-enters the single-flight pass with `ensureDefaults: true` so a tick covers orphan sweep (class A) and, when that flag is set, L0/L1 defaults (class D). Class D also has a separate cheap path via `CONTEXT_MAPPER_NETPOL_DEFAULTS_RESYNC_SEC` (#488). A tick while a pass is in flight is **skipped** (`clerum_hcc_netpol_resync_ticks_skipped_total{reason="pass-in-flight"}`) and does not coalesce; event-driven trailing is unchanged. `0` disables the interval (merge default). Startup still converges once; `start()` already applied defaults as a bootstrap barrier. Default `0` logs a `console.warn` on every boot (same pattern as Host/SFS/GFS/LlmHook) — expected; it names the self-heal gap. A non-canonical value (`25m`, `1e3`) **fails loud at load** instead of coercing through `parseInt`. **Enable is a separate ops decision** (issue #478, not this merge): with the skip guard the chosen value is **`1500`**; without the guard the floor is **`3600`**. `300` is not a valid enable while passes last minutes. Treadmill ⇔ pass duration ≥ period. Enable preconditions live on #478: image deployed, census read, histogram p99/max ≪ T, then infra **dev first**. |
| `CONTEXT_MAPPER_NETPOL_DEFAULTS_RESYNC_SEC`       | `0`                                             | Periodic L0/L1 defaults-only tick (seconds). Calls `ensureDefaultPolicies()` only — never `fullReconcile` / `runInitialNetworkPolicyConvergence`. Write sets are disjoint from the typed sweep (`policy-type ∈ {context-allow, rpc-proxy-egress, external-egress}`), so a concurrent full pass is safe and this timer does **not** share `initialConvergenceRuns` or increment `{reason="pass-in-flight"}`. Overlapping defaults-only ticks serialize (`clerum_hcc_netpol_resync_ticks_skipped_total{reason="defaults-only-in-flight"}`). `0` disables the interval (merge default) and does not warn. Not shipped in `deploy/base` or public overlays. A non-canonical value fails loud at load. Enable is a separate ops decision (issue #488).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP`         | `10`                                            | Absolute orphan-delete cap for a namespace-wide NetworkPolicy sweep. Candidates **strictly above** this count refuse **deletes** and increment `clerum_hcc_netpol_orphan_sweep_capped_total`; the pass **still certifies** (#478: alert and do not delete). Governs every `fullReconcile` (startup, event-driven, timer). Absolute is checked first, so at a fleet ≥ 50 with these defaults the percent rule never binds. One cap over the **sum of all lanes** (not per-lane): a trip leaves those orphans in place until an operator raises the env; the signal is that counter. `0` refuses every orphan delete; a negative or non-canonical value (`2e1`, `10.9`) fails loud at load. Census: `scripts/ops/hcc-netpol-orphan-census.sh` — `live_cap_would_trip` is Deployment env only (`UNSET` when both keys are omitted, not `none`); `controller_cap_would_trip` applies compiled defaults when unset. Census listed/orphan sets include the controller `repairable` class (managed-by + reserved name, policy-type absent). When the Deployment omits `CONTEXT_MAPPER_RPC_PROXY_NAMESPACE`, the census assumes the compiled `rpc-proxy` default.                                                                                                      |
| `CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP_PERCENT` | `20`                                            | Percent orphan-delete cap against the listed managed fleet. Strict `>`. Inert on a tiny inventory where `listed * percent / 100 < 1`. Values above 100 never fire. Same every-`fullReconcile` scope as the absolute cap; only binds when the fleet is small enough that 20% is below the absolute cap of 10. Non-canonical values fail loud at load.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `KUBERNETES_SERVICE_HOST`                         | _(injected by Kubernetes)_                      | Not set by the operator — the `/32` fallback source when `CONTEXT_MAPPER_K8S_API_CIDRS` is empty.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Plugin image allowlist

| Variable                                 | Default                     | Description                                                                                                                                         |
| ---------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_ALLOWED_IMAGE_PREFIXES`  | see `packages/image-policy` | Comma-separated trusted image prefixes for local-mode `McpServer` images. Manifest sets `ghcr.io/evenfire-ai/,mongodb/,mcr.microsoft.com/,clerum/`. |
| `CONTEXT_MAPPER_ENFORCE_IMAGE_ALLOWLIST` | `false`                     | `false` = audit mode (log would-be denials without blocking). `true` = enforce. Manifest sets `"false"`.                                            |

### Control-API integration

| Variable                               | Default                                                                       | Description                                                                                                                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTROL_API_BASE_URL`                 | `http://control-api.control-plane.svc.cluster.local:8090`                     | Cluster-internal control-api URL. HCC calls it directly to issue mcp-host runtime tokens for the pods it provisions.                                                                                                          |
| `INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET` | `` (empty)                                                                    | HS256 secret for signing InternalControl JWTs. **Required whenever `CLERUM_DEV_MODE` is not `true`** — the process logs `[HCC] FATAL` and exits 1 if empty or still a `replace-with-…` placeholder.                           |
| `MCP_HOST_GATEWAY_URL`                 | `http://nginx-workflow-approval-gateway.control-plane.svc.cluster.local:8092` | The nginx allowlist proxy mediating mcp-host → control-api. HCC **injects this into the mcp-host pods it provisions**; it does not call it itself.                                                                            |
| `GOVERNED_TRACING_ENABLED`             | `true`                                                                        | Turns on HCC's infrastructure-telemetry and administrative-outcome reporters, which post to control-api. Both also need a non-empty `CONTROL_API_BASE_URL`. See [governed tracing](../docs/architecture/governed-tracing.md). |

### Dev mode

Parsed only when `CLERUM_DEV_MODE` is truthy. A JSON parse failure logs an error and yields an empty result rather than crashing.

| Variable             | Default | Description                                                                                                       |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `CLERUM_MCP_SERVERS` | `[]`    | JSON array of McpServer objects.                                                                                  |
| `CLERUM_CONTEXTS`    | `[]`    | JSON array of Context objects used by the development provider. Caller-selected Context discovery is not exposed. |
| `CLERUM_MCP_AUTH`    | `{}`    | JSON object mapping MCP server name → auth token for development-provider fixtures.                               |

## Kubernetes RBAC

The shipped Roles and RoleBindings are the source of truth — see `deploy/base/<namespace>/rbac.yaml`. The controller's ServiceAccount lives in `control-plane` and is bound into `mcp-server`, `mcp-host`, `channels`, `rpc-proxy`, `sandbox-recipes`, `sandbox-ui`, `gfs` and `llm-hooks`. The table below is an overview of the two main namespaces, not a complete Role definition — do not build a Role from it.

In `mcp-server` (`deploy/base/mcp-server/rbac.yaml`):

| API Group           | Resource            | Verbs                             | Purpose                                                      |
| ------------------- | ------------------- | --------------------------------- | ------------------------------------------------------------ |
| `clerum.io`         | `mcpservers`        | get, list, watch, patch           | Watch McpServer CRDs                                         |
| `clerum.io`         | `mcpservers/status` | get, patch                        | Publish readiness / secret-resolution conditions             |
| `clerum.io`         | `contexts`          | get, list, watch                  | Watch Context CRDs for NetworkPolicy reconciliation          |
| `networking.k8s.io` | `networkpolicies`   | get, list, create, update, delete | Manage generated NetworkPolicies                             |
| `apps`              | `deployments`       | get, list, create, update, delete | Manage MCP server Deployments                                |
| _(core)_            | `services`          | get, list, create, update, delete | Manage MCP server Services                                   |
| _(core)_            | `configmaps`        | get, list, create, update, delete | Manage the remote egress proxy nginx config                  |
| _(core)_            | `secrets`           | get, list, watch                  | Read auth tokens, validate `envSecret`, re-enqueue on change |

In `mcp-host` (`deploy/base/mcp-host/rbac.yaml`), the controller additionally manages per-Host identity and SharedFileSystem resources: `hosts` (get, list, watch), `sharedfilesystems` + `sharedfilesystems/status`, `batch/jobs`, `deployments`, `services`, `persistentvolumeclaims`, `networkpolicies`, `serviceaccounts`, `roles`/`rolebindings`, `configmaps` (get, watch, list), `pods` (get, list), and `secrets` with **get, watch, list, create, update, patch, delete** — it creates the per-Host `host-<hostRef>-mcp-host-runtime-tokens` Secret and the per-Host ServiceAccount + Role + RoleBinding on every reconcile.

## Namespaces

| Component                | Namespace       | Purpose                                                              |
| ------------------------ | --------------- | -------------------------------------------------------------------- |
| host-context-controller  | `control-plane` | Operator and API service                                             |
| MCP server pods + CRDs   | `mcp-server`    | `McpServer` and `Context` source of truth + managed server workloads |
| mcp-host                 | `mcp-host`      | Consumer of the REST API, target of NetworkPolicy `from` rules       |
| channel-reader           | `channels`      | Communication layer                                                  |
| LlmHook CRDs + hook pods | `llm-hooks`     | Guardrail hooks; static default-deny plus HCC-managed allow policies |

## Local Development

### Dev Mode (without Kubernetes)

Run host-context-controller locally without Kubernetes by providing MCP servers via environment variables. In dev mode, no reconciliation occurs (no Deployments, Services, or NetworkPolicies are created).

Startup still requires a real trusted Control API RS256 public key in
`HCC_MCP_HOST_JWT_PUBLIC_KEY`, including in dev mode. Export it from the
approved local public-key source before either command below. `.env.example`
deliberately does not include a placeholder key, and HCC has no insecure
verifier fallback.

```bash
# Install dependencies
npm install

# Load HCC_MCP_HOST_JWT_PUBLIC_KEY from the trusted Control API public-key source.

# Option 1: Use .env file (recommended)
cp .env.example .env
# Edit .env with your servers
make dev

# Option 2: Run with inline example servers (quick test)
make dev-example
```

`make dev` requires a `.env` file — it sources `./.env` and exits with an error if the file is absent. Because the recipe re-sources `.env` after make has exported the environment, any key defined in `.env` overrides a value passed inline on the command line; a variable _not_ present in `.env` is passed through untouched. To provide your own servers, put them in `.env`:

```bash
CLERUM_DEV_MODE=true
MCP_HOST=localhost
CLERUM_MCP_SERVERS='[{"name":"filesystem","spec":{"description":"Filesystem operations","image":"mcp/filesystem:latest","transport":{"type":"sse","url":"http://'"$MCP_HOST"':3001/sse","port":3001},"enabled":true}}]'
CLERUM_CONTEXTS='[{"name":"dev-context","namespace":"dev","spec":{"contextId":"dev-context","description":"Dev context","mcpServers":["filesystem"]}}]'
CLERUM_MCP_AUTH='{"github":"ghp_your_token_here"}'
```

Dev mode retains the metadata-only global v1 inventory for local `mcp-proxy`
compatibility. It does not restore either caller-selected v1 Host route. The
protected v2 contract requires live Kubernetes Host/Context authority and
therefore fails closed when that authority is unavailable.

### Production Mode (with Kubernetes)

Run against the cluster in your current kubeconfig (watches K8s for McpServer and Context CRDs) with `CLERUM_DEV_MODE` unset. Production startup requires both the existing `INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET` signing material and the real Control API public key in `HCC_MCP_HOST_JWT_PUBLIC_KEY`. Load both from their approved sources before starting; missing or invalid verifier material fails startup closed.

```bash
make build
npm start
```

`make dev` also works, but only if a `.env` file exists (see above) — it is the same target, so it aborts when `.env` is absent. Leave `CLERUM_DEV_MODE` out of that `.env` and load both required values through the approved local configuration path to run against a real cluster.

## Deployment

`host-context-controller/Dockerfile` copies `packages/workflow-recipe-capability-policy`, `packages/image-policy` and `host-context-controller/`, so **the build context must be the repo root**, not this directory. Build from the repo root and point `-f` at the Dockerfile:

```bash
# From the repo root
export IMAGE=ghcr.io/<org>/host-context-controller:$(git describe --tags --always)

# Build
docker build -f host-context-controller/Dockerfile -t "$IMAGE" .

# Push
docker push "$IMAGE"

# Multi-platform build + push (ARM host targeting an amd64 cluster)
docker buildx build --platform linux/amd64 -f host-context-controller/Dockerfile -t "$IMAGE" --push .
```

For a local minikube cluster, `scripts/minikube/build-images.sh` builds this image (and the other services) with the correct root context.

> The component Makefile's `docker-build` / `docker-push` / `docker-push-cross` targets pass this directory as the build context, so the `COPY packages/...` layer cannot resolve and the build fails. Use the root-context commands above.

The component Makefile does not deploy. The controller's ServiceAccount, Deployment and Service live in `deploy/base/control-plane/host-context-controller.yaml`; namespaces are in `deploy/base/namespaces.yaml` and RBAC in `deploy/base/<namespace>/rbac.yaml`. All are applied with kustomize from the repo root, e.g. `kubectl apply -k deploy/overlays/minikube`.

The controller Deployment runs `replicas: 1` with `strategy: Recreate`, because HCC assumes it is the only NetworkPolicy writer and has no leader election. Each rollout therefore has a short window with no HCC, and a new pod that never becomes Ready leaves `/ready` at `503`. `progressDeadlineSeconds: 1200` only detects that; rolling back (`kubectl rollout undo`) is up to your deploy pipeline. See [HCC readiness flows §5](../docs/architecture/hcc-readiness-flows.md#5-deploy-invariant--single-writer).
