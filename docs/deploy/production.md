# Running evenfire on your own cluster

This page is for operators who want to run evenfire on a real Kubernetes
cluster, not on minikube. It lists what the cluster needs, what you must write
yourself, the install order, and what this repository does not provide.

This repository ships Kubernetes manifests ([`deploy/base`](../../deploy/base)),
a CRD Helm chart ([`charts/clerum-crds`](../../charts/clerum-crds/README.md)),
release images on `ghcr.io/evenfire-ai`, and bootstrap scripts. The only
overlays in the repository are the minikube ones. **There is no production
overlay.** You write your own overlay on top of `deploy/base`, and
[`deploy/overlays/minikube`](../../deploy/overlays/minikube) is the worked
example to copy from.

> Code and API group still use the historical name **clerum** (`clerum.io`,
> `CLERUM_*`). Same project.

## What "production" means here

- All platform services run on a real cluster (not a single dev-mode `mcp-host`).
- The JWT auth chain is on the external edges (desktop → rpc-proxy,
  service → control-api). `mcp-host` runtime routes still use edge trust
  headers, restricted by NetworkPolicy.
- Default-deny NetworkPolicies are enforced by the CNI.
- Secrets and LLM keys live in cluster Secrets.
- Workloads run non-root with capabilities dropped. The connector-image
  allowlist is switched from audit to enforce.

## What your cluster needs

| Requirement                              | Why                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kubernetes 1.30 or newer**             | [`deploy/base/cluster-wide/workflowrecipe-admission.yaml`](../../deploy/base/cluster-wide/workflowrecipe-admission.yaml) uses `ValidatingAdmissionPolicy` at `admissionregistration.k8s.io/v1`, which is GA from 1.30. Older API servers reject the apply.            |
| **A CNI that enforces NetworkPolicy**    | Every namespace starts from deny-all. The isolation model depends on the CNI enforcing it, including `ipBlock` egress rules to the API server endpoint. The minikube setup uses Calico. A CNI that ignores NetworkPolicy runs the platform with no network isolation. |
| **Cluster-scoped install rights**        | You install CRDs, ClusterRoles, ClusterRoleBindings, PriorityClasses (`clerum-batch`, `clerum-service`, `clerum-interactive-host`) and ValidatingAdmissionPolicies. See [`deploy/base/cluster-wide`](../../deploy/base/cluster-wide).                                 |
| **CoreDNS labeled `k8s-app: kube-dns`**  | Base DNS egress rules select pods in `kube-system` with that label. If your cluster DNS uses another label, patch those rules.                                                                                                                                        |
| **Block storage (RWO)**                  | Postgres (`control-postgres-data`, 5Gi), one workspace PVC per agent (10Gi default), SharedFileSystem PVCs (RWO by default), per-recipe workflow output PVCs.                                                                                                         |
| **RWX storage (only for legacy output)** | Base still creates the legacy shared `clerum-workflow-output` PVC (RWX, 1Gi). New WorkflowRecipes do not mount it. See [workflow output PVC upgrade](workflow-output-pvc-upgrade.md).                                                                                 |
| **Postgres**                             | Base runs `postgres:16-alpine` as one replica on one RWO PVC. See [Database](#database).                                                                                                                                                                              |
| **Your own ingress, DNS and TLS**        | Base ships no ingress controller and no Ingress objects. See [How users reach the platform](#how-users-reach-the-platform).                                                                                                                                           |
| **Outbound internet**                    | LLM providers, image pulls, channel APIs. See [Outbound destinations](#outbound-destinations).                                                                                                                                                                        |

## Sizing

Be careful with any single number:

- **6 CPUs / 10 GB RAM** is the Docker Desktop allocation for the minikube
  evaluation setup ([minikube.md](minikube.md#prerequisites)). It is a local
  evaluation footprint, not a production recommendation.
- The static Deployments in `deploy/base` (18 of them, with no agents running)
  **request** about 0.9 CPU and 2.7 GiB of memory in total. Requests are not
  real usage. `codex-llm-proxy` and `grok-llm-proxy` each request 768Mi even
  though both subscriptions are off by default.
- Most load comes from pods that the controllers create at runtime. These are
  not in `deploy/base`.

What the host-context-controller (HCC) creates for **each agent (Host)**:

| Resource                                     | Namespace  | Default                                                                                 |
| -------------------------------------------- | ---------- | --------------------------------------------------------------------------------------- |
| `mcp-host` Deployment                        | `mcp-host` | 100m CPU / 128Mi requested, 500m / 2Gi limit (`CONTEXT_MAPPER_HOST_RESOURCES_*`)        |
| Service                                      | `mcp-host` |                                                                                         |
| Workspace PVC                                | `mcp-host` | RWO, 10Gi (`CONTEXT_MAPPER_HOST_WORKSPACE_SIZE`)                                        |
| `channel-reader-<host>` Deployment + Service | `channels` | Always created. `replicas: 0` until a CommunicationChannel references the Host, then 1. |

A Host with `spec.desktop` runs the desktop image instead, with a 250m / 256Mi
request and a 1 CPU / 4Gi limit by default (`CONTEXT_MAPPER_DESKTOP_RESOURCES_*`).
McpServers (connectors), workflow coordinator pods, GFS controllers (`gfsc`) and
workspace-files-controllers add their own pods. Size the cluster for the number
of agents and connectors you plan to run, then measure.

## Database

Base runs one Postgres Deployment (`control-postgres` in `control-plane`):
`postgres:16-alpine`, one replica, `strategy: Recreate`, one 5Gi RWO PVC with no
`storageClassName` set. It has no replication, no failover and no backup job.
Back it up yourself.

Moving to an external Postgres is **not** one connection string. Several
services read their own Secret, and the provisioning scripts assume the
in-cluster Deployment:

| Consumer                 | Where the DSN comes from                                                             |
| ------------------------ | ------------------------------------------------------------------------------------ |
| control-api              | `CONTROL_API_PG_CONNECTION_STRING` from Secret `control-api-postgres-runtime`        |
| trace-maintenance-worker | `TRACING_MAINTENANCE_PG_CONNECTION_STRING` from `trace-maintenance-postgres-runtime` |
| workflow-recipes         | `POSTGRES_CONNECTION_STRING` from `workflow-recipes-postgres-runtime`                |
| GFS controllers          | Secrets `gfs-controller-db` (writer) and `gfs-controller-reader-db` (reader)         |

- [`provision-control-api-runtime-roles.sh`](../../deploy/scripts/provision-control-api-runtime-roles.sh)
  and [`provision-gfs-db.sh`](../../deploy/scripts/provision-gfs-db.sh) run
  `psql` through `kubectl exec` into `deployment/control-postgres`. With an
  external database you run the equivalent role SQL yourself.
- The GFS NetworkPolicies HCC generates select the Postgres pod by label
  (`app: control-postgres`, `CONTEXT_MAPPER_GFS_POSTGRES_APP_LABEL`).
- `control-api-config` in base also carries a default DSN with the
  `postgres:postgres` credentials. The Secret-sourced env var above takes
  precedence, but do not leave the default credentials in place.

## How users reach the platform

Base ships no ingress controller, no Ingress objects and no TLS. Minikube uses
`kubectl port-forward`. On a real cluster you bring your own ingress and
certificates for these Services:

| Who                            | Service (namespace, port)                         | Notes                                                                                                          |
| ------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Administrators                 | `control-ui` (`control-plane`, 3000)              | [Control UI](../surfaces/control-ui.md)                                                                        |
| Members                        | `profile-ui` and `external-rest-api` (`profiles`) | Sign-in, invitations, Desktop App API                                                                          |
| Desktop App                    | `rpc-proxy` (`rpc-proxy`, 8094)                   | JWT-authenticated chat and streaming                                                                           |
| Slack, Teams, webhook triggers | `webhook-proxy` (`webhook-ingress`, 8095)         | Inbound only if you use them. See [Slack](../how-to/connect-slack.md) and [Teams](../how-to/connect-teams.md). |

**The NetworkPolicies decide which ingress works.** Base admits public traffic
to `control-ui`, `profile-ui`, `external-rest-api`, `rpc-proxy` and
`webhook-proxy` only from pods
labeled `app: cloudflared` in a namespace named `ingress`. That matches the
optional Cloudflare Tunnel stack in [`deploy/base/ingress`](../../deploy/base/ingress),
which `deploy/base/kustomization.yaml` deliberately does not include. To use it,
add `../../base/ingress` (or your path to it) to your overlay and supply the
tunnel credentials Secret yourself. To use any other ingress controller, either
run it so it matches those selectors or patch those NetworkPolicies in your
overlay.

Then point the platform at your public URLs. In base and the minikube configs
these are unset or `127.0.0.1`/`localhost` values that only work with
port-forwards; set them in your overlay:

| Variable                                                                                                                              | Where                |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `CONTROL_API_CONTROL_UI_BASE_URL`                                                                                                     | `control-api-config` |
| `CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL`, `CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL`, `CONTROL_API_DESKTOP_RPC_PROXY_BASE_URL` | `control-api-config` |
| `CONTROL_API_OAUTH_CALLBACK_BASE_URL`                                                                                                 | `control-api-config` |
| `CONTROL_API_GOOGLE_CLIENT_ID` (placeholder in base)                                                                                  | `control-api-config` |
| `RPC_PROXY_CORS_ORIGIN`, `RPC_PROXY_OAUTH_CALLBACK_BASE_URL`                                                                          | `rpc-proxy-config`   |

Set `CONTROL_API_OAUTH_CALLBACK_BASE_URL` and `RPC_PROXY_OAUTH_CALLBACK_BASE_URL`
to the same public origin, with no path or trailing slash. If you use OAuth
connectors, also set `MCP_OAUTH_BROKER_ENABLED: "true"` in `control-api-config`.
Base leaves it off, and without it the agent asks for consent forever even after
the user authorizes. See [OAuth connectors](../how-to/connect-oauth-connector.md).

`RPC_PROXY_MCP_SERVER_NAMESPACE` (base Deployment `env`, default `mcp-server`
when unset) names the namespace of the MCP servers for rpc-proxy. If you move the
MCP servers, set it to the same value as control-api's
`CONTROL_API_MCP_SERVERS_NAMESPACE`.

`MCP_HOST_ACTIVITY_MAX_EVENT_BYTES` (default `2048`) caps one Host activity
event. rpc-proxy reads the same variable to size the activity frames it relays,
so if you change it, set the same value on the Host and on rpc-proxy.

## Outbound destinations

The NetworkPolicies are port and CIDR rules, not hostname rules. Agent pods
(`mcp-host`) may reach any **public** address on TCP 80 and 443; private,
link-local, metadata, carrier-grade NAT and reserved ranges are excluded
([`deploy/base/public-egress-exceptions.yaml`](../../deploy/base/public-egress-exceptions.yaml)).
Connector (McpServer) egress is generated per server from its
`egressBindings`; `exact-host` is the default and a `cidr` binding cannot name
a private range ([McpServer reference](../crds/mcpserver.md#egress-bindings)).

If you run a perimeter firewall, these are the destinations the platform uses:

| Destination                                     | Used by                       | When                                                                                                                            |
| ----------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Your LLM provider's API                         | `mcp-host`, workflow pods     | Always. Each provider has a fixed endpoint; see [LLM providers](../llm-providers/README.md).                                    |
| `ghcr.io`                                       | Nodes (image pulls)           | When you run release images                                                                                                     |
| Telegram Bot API                                | `channel-reader-<host>`       | Telegram channels. The reader polls outbound; no inbound webhook is needed.                                                     |
| `login.microsoftonline.com`, Bot Framework APIs | `channel-reader-<host>`       | Teams channels (plus inbound to `webhook-proxy`)                                                                                |
| Slack API                                       | `channel-reader-<host>`       | Slack channels (plus inbound to `webhook-proxy`)                                                                                |
| OAuth providers                                 | control-api                   | [OAuth connectors](../how-to/connect-oauth-connector.md)                                                                        |
| `registry.evenfire.ai`                          | control-api, workflow-recipes | Optional. Only if you set `CLERUM_REGISTRY_URL`; see [connect to the registry](../how-to/connect-to-registry.md).               |
| `registration.evenfire.ai`                      | control-api                   | Only with `CONTROL_API_MEMBER_REGISTRATION_MODE=hosted`. See [member invitations](../how-to/member-invitations-self-hosted.md). |

## Write your overlay

Your overlay lists `deploy/base` as a resource and adds what base leaves out.
Use [`deploy/overlays/minikube/kustomization.yaml`](../../deploy/overlays/minikube/kustomization.yaml)
as the reference.

**Images.** Base refers to images by local `clerum/<name>` names. Add the
[`deploy/components/ghcr-images`](../../deploy/components/ghcr-images/kustomization.yaml)
component, which rewrites them to `ghcr.io/evenfire-ai/<name>` at the release
tag of the commit you check out, including the image references HCC and
workflow-recipes inject into the pods they create. Images are built for
`linux/amd64` and `linux/arm64`. See
[releases and upgrades](releases-and-upgrades.md#your-own-cluster) for pinning
and digests. Two HCC image settings are **not** covered by the component and
default to local names:

| HCC env var                    | Default                          | Set it when                  |
| ------------------------------ | -------------------------------- | ---------------------------- |
| `CONTEXT_MAPPER_GFSC_IMAGE`    | `clerum/gfs-controller:test`     | You use a GlobalFileSystem   |
| `CONTEXT_MAPPER_DESKTOP_IMAGE` | `clerum/mcp-host-desktop:latest` | Any Host sets `spec.desktop` |

**ConfigMaps base does not define.** HCC mounts `mcp-host-config` into every
agent pod with `envFrom`, and `rpc-proxy` reads `rpc-proxy-config`. Neither is
in base; without them those pods fail to start. Copy the minikube versions
([`mcp-host-config.yaml`](../../deploy/overlays/minikube/configmaps/mcp-host-config.yaml),
[`rpc-proxy-config.yaml`](../../deploy/overlays/minikube/configmaps/rpc-proxy-config.yaml))
and replace their values. In `mcp-host-config`, `HCC_AUTHORITY_MAX_STALENESS_MS`
must satisfy the
[mcp-host authority staleness floor](releases-and-upgrades.md#mcp-host-authority-staleness-floor)
or every Host refuses to start. The minikube `rpc-proxy-config` contains fixed
development secrets (`RPC_PROXY_DESKTOP_COOKIE_SECRET`,
`RPC_PROXY_DESKTOP_API_TOKEN`, `RPC_PROXY_SANDBOX_UI_COOKIE_SECRET`) and
localhost URLs. Many features are off in base and on in minikube; decide each
one with [the configuration reference](../reference/configuration.md) instead
of copying minikube's choices.

**Environment-specific values base hard-codes or leaves unset.**

| Setting                                                                             | Base value        | What to do                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API server `cidr` in `allow-k8s-api-egress-control-plane`, `-mcp-host`, `-channels` | `10.109.0.1/32`   | Patch to your API server endpoint IP (`kubectl --context "$KCTX" get endpoints kubernetes -n default`). The minikube template [`k8s-api-ip.yaml.template`](../../deploy/overlays/minikube/patches/k8s-api-ip.yaml.template) explains why this is an `ipBlock`. |
| `CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS` (HCC)                                 | unset             | Unset uses your cluster's default StorageClass. Set a block StorageClass to choose another one, for example `do-block-storage-retain` on DigitalOcean to keep `Retain`.                                                                                        |
| `storageClassName` on `control-postgres-data` and `clerum-workflow-output`          | unset             | Patch, or rely on your default StorageClass.                                                                                                                                                                                                                   |
| `CONTEXT_MAPPER_HOST_IMAGE_PULL_SECRET` (HCC)                                       | unset (no Secret) | Name your pull Secret in `mcp-host` if your Host images need one.                                                                                                                                                                                              |
| `CONTEXT_MAPPER_WFC_IMAGE_PULL_SECRET` (HCC)                                        | unset (no Secret) | Name your pull Secret in `mcp-host` if your workspace-files-controller image needs one; without it that Deployment ends in `ImagePullBackOff` on a private registry.                                                                                           |
| `CONTEXT_MAPPER_ENFORCE_IMAGE_ALLOWLIST` (HCC)                                      | `"false"` (audit) | Set `"true"`, and narrow `CONTEXT_MAPPER_ALLOWED_IMAGE_PREFIXES` (base includes `clerum/`).                                                                                                                                                                    |
| `CONTROL_API_ENFORCE_IMAGE_ALLOWLIST` (control-api)                                 | `"false"` (audit) | Set `"true"` so control-api refuses non-allowlisted connector images up front, not only HCC at reconcile.                                                                                                                                                      |

For a read-only check of API-server and DNS egress before you rely on
enforcement, see [`deploy/scripts/np-enforce-preflight.sh`](../../deploy/scripts/np-enforce-preflight.sh).
It was written for GKE; read it before you run it elsewhere.

## Install order

The RPC Proxy → MCP Host edge has one protocol, `signed-assertion-v1`, with no
transitional mode. control-api signs a short-lived edge assertion (RS256, at most
300 seconds) with the RPC signing key it already holds
(`CONTROL_API_RPC_JWT_PRIVATE_KEY`), RPC Proxy forwards it as
`x-clerum-edge-assertion`, and each MCP Host verifies it with the RPC public key
(`CLERUM_AUTH_JWT_PUBLIC_KEY`). No extra secret is needed.

- **Before the upgrade: RBAC and the HCC env.**
  - HCC reads `deployment/rpc-proxy` (`get deployments`) and lists its pods
    (`list pods`) in namespace `rpc-proxy` before every Host create or
    template move. The rules are in `deploy/base/rpc-proxy/rbac.yaml`. If your
    CD strips Roles from the overlay apply, run
    [`deploy/scripts/bootstrap-rbac.sh`](../../deploy/scripts/bootstrap-rbac.sh)
    with an admin kubeconfig before HCC rolls out:

    ```bash
    CONTEXT="$KCTX" CONFIRM=yes bash deploy/scripts/bootstrap-rbac.sh
    ```

    The script applies every `rbac.yaml`, `clusterroles.yaml` and
    `clusterrolebindings.yaml` under `deploy/base`, not only the RPC Proxy
    Role. Always pass `CONTEXT`: without it the script applies to the current
    kubeconfig context and asks for no confirmation. With `CONTEXT` set, it
    refuses a context whose name contains `clerum` (and none of `example-dev`,
    `clerum-test`, `minikube` or `kind`) unless `CONFIRM=yes`. Without these
    rules the read is refused and HCC creates and wakes no Host. Check with:

    ```bash
    kubectl --context "$KCTX" auth can-i get deployments/rpc-proxy -n rpc-proxy \
      --as=system:serviceaccount:control-plane:host-context-controller
    kubectl --context "$KCTX" auth can-i list pods -n rpc-proxy \
      --as=system:serviceaccount:control-plane:host-context-controller
    ```

    When the barrier blocks, HCC logs `RpcProxyEdgeCohortBarrierError`. Its
    message has one of two forms:
    - `RPC Proxy edge protocol cohort cannot be read`: a read failed. The
      message names the read (`reading Deployment "rpc-proxy"` or
      `listing pods "app=rpc-proxy"`), the namespace, and `HTTP <status>`, or
      `no HTTP status` when the API server returned none (timeout, network
      error). Two statuses add a hint:
      - `HTTP 403` on either read: the rules above are missing. The message
        names the Role, RoleBinding and ServiceAccount; apply them as above.
      - `HTTP 404` on the Deployment read: no RPC Proxy Deployment in that
        namespace. Check `CONTEXT_MAPPER_RPC_PROXY_NAMESPACE`.

      Any other status and `no HTTP status` add no hint.

    - `is not fully on signed-assertion-v1`: the RPC Proxy rollout has not
      finished. The message lists what blocks it (generation not observed,
      template label, or the unlabelled pods by name). HCC retries on the next
      reconcile of the Host.

  - HCC refuses to start unless
    `CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL=signed-assertion-v1`.
    `deploy/base/control-plane/host-context-controller.yaml` sets it. An
    install that renders the HCC env, the RPC Proxy pod template or the Roles
    from its own copy of the manifests must refresh that copy at a base that
    contains this release before it ships the new HCC image.

- **Upgrade order:** control-api, then RPC Proxy, then HCC and the Hosts. HCC
  creates no Host Deployment, and moves no Host pod template onto
  `clerum.io/rpc-proxy-edge-protocol=signed-assertion-v1`, until the whole RPC
  Proxy pod cohort carries that label. A held Host Deployment that keeps its
  old pod template (only its replicas change) is updated without that wait.
  Suspending a Host that still has its old template also moves the template,
  so that suspension waits too; HCC retries it on its next reconcile of the
  Host (`CONTEXT_MAPPER_HOST_RESYNC_SEC`, default 300 seconds).
- **Rollback order:** HCC and the Hosts first, then RPC Proxy, then control-api.
  RPC Proxy may stop forwarding the assertion only after no Host requires it.
  A pipeline that applies the whole previous release at once, or control-api
  first, does not follow this order and cuts Desktop → Host traffic twice:
  while control-api is old and RPC Proxy is new, every Host route request
  that control-api authorizes under V1 authority answers 503
  `authority_unavailable` because control-api returns no edge assertion
  (with `CONTROL_API_USER_ACCESS_ACTION_CONTEXT_V2` unset that is every Host
  route except session search, which is V2-only and answers 403 as before)
  (RPC Proxy logs `control-api answered the host resolve without an edge
  assertion`); while RPC Proxy is old and
  the Hosts are new, every Host answers 401 until HCC has replaced them all.
  Roll back by hand in this order: HCC, wait until the label check below
  lists nothing, then RPC Proxy, then control-api.
  - Roll HCC back to its previous Deployment revision, which restores image,
    env and labels together:
    `kubectl --context "$KCTX" -n control-plane rollout undo deployment/host-context-controller --to-revision=<n>`.
    Released HCC versions up to v0.12.1 do not read
    `CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL`. A `dev` build from before
    this release accepts only `legacy-headers` or `dedicated-header-v1` and
    refuses `signed-assertion-v1` at start, so an image-only rollback to such
    a build leaves no HCC running (one replica, `Recreate` strategy).
  - Roll RPC Proxy back only after this lists nothing:

    ```bash
    kubectl --context "$KCTX" -n mcp-host get deployments,pods \
      -l 'clerum.io/managed-by=host-context-controller,clerum.io/host,clerum.io/rpc-proxy-edge-protocol=signed-assertion-v1'
    ```

    This is the label part of the gate the Minikube wrapper enforces
    (`host_cohort_unsigned` in `scripts/minikube/rpc-proxy-edge-rollout-gate.sh`).
    Hosts held by a blocked suspension, or suspended with a pending resource
    change, keep `signed-assertion-v1` until the hold clears or the Host
    wakes, so the list can stay non-empty for them.

- **Keep V2 off.** Leave `CONTROL_API_USER_ACCESS_ACTION_CONTEXT_V2` unset on
  control-api for the whole life of this release, including through any RPC
  Proxy rollback. A Host refuses every request that carries V2 authority, and
  an RPC Proxy older than this release refuses the V2 checkpoint that
  control-api now returns with the edge assertion.
- **Issuer.** control-api signs with `CONTROL_API_RPC_JWT_ISSUER` from
  ConfigMap `control-api-config` (namespace `control-plane`). Each Host checks
  `CLERUM_AUTH_JWT_ISSUER` from the ConfigMap HCC injects into Hosts
  (`CONTEXT_MAPPER_HOST_CONFIGMAP_NAME`, default `mcp-host-config`, namespace
  `mcp-host`); unset means `control-api`. The two values must match.
- **Completion gate.** The upgrade is complete when this lists nothing:

  ```bash
  kubectl --context "$KCTX" -n mcp-host get deployments,pods \
    -l 'clerum.io/managed-by=host-context-controller,clerum.io/host,clerum.io/rpc-proxy-edge-protocol!=signed-assertion-v1'
  ```

  and the same command with `clerum.io/rpc-proxy-edge-protocol=signed-assertion-v1`
  lists every Host. The `clerum.io/host` key leaves out the
  workspace-files-controller Deployments, which HCC also manages but which
  carry no protocol label. Hosts held by a blocked suspension, or suspended
  with a pending resource change, keep the old template until the hold clears
  or the Host wakes, so the gate can stay non-empty for them.

- **Host refusal log.** A Host logs one warning for each edge assertion it
  refuses, then answers 401. The fields are `event`
  (`runtime_edge_assertion_refused`), `reason`, `scope` (the route scope),
  `errorName` (only with `verify-failed`) and `claimError` (only with
  `claims-rejected`). No token, header value or key is logged. Example:

  ```text
  {"event":"runtime_edge_assertion_refused","reason":"verify-failed","scope":"host:approval:write","errorName":"JsonWebTokenError","timestamp":"…","level":"warn","msg":"[Server] Refused rpc-proxy edge assertion"}
  ```

  `reason` is one of `missing`, `not-a-string`, `v2-refused`,
  `no-verification-key`, `verify-failed`, `typ-mismatch` and
  `claims-rejected`. `not-a-string` does not occur over HTTP, because Node
  joins repeated headers into one string. The others mean:

  | What you see                                              | Meaning                                                                                                                                                                                         |
  | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `missing`                                                 | An RPC Proxy older than this release, or a V2 request with no assertion.                                                                                                                        |
  | `v2-refused`                                              | The request carries V2 authority: the V2 policy is on. Turn it off.                                                                                                                             |
  | `no-verification-key`                                     | `CLERUM_AUTH_JWT_PUBLIC_KEY` is empty and `CLERUM_ENABLE_AUTH=false`. With auth on (the default), a Host with no key does not start.                                                            |
  | `verify-failed` with `JsonWebTokenError` on every request | The Host's key or issuer differs from control-api's signer.                                                                                                                                     |
  | `verify-failed` with `TokenExpiredError`                  | Clock skew, or a request at the end of its assertion's life.                                                                                                                                    |
  | `typ-mismatch`                                            | Signed by the right key for the edge audience, but with another header type: control-api and Host versions differ.                                                                              |
  | `claims-rejected` with `claimError`                       | The assertion's host, user, team or scope does not match this Host or route; `claimError` names which, for example `host mismatch`, `sub mismatch`, `teamId mismatch` or `route scope missing`. |
  | `claims-rejected` with `claimError: iat is in the future` | The assertion was issued more than 5 seconds ahead of the Host's clock: the Host's clock is behind control-api's. Fix the node's time sync; the Host refuses every RPC Proxy request until then. |

- **Image tags.** Never republish a Host or RPC Proxy image tag. The HCC
  barrier checks the pod template label, not the image. A republished tag
  lets a Host pod with the old label start on the new image (wake from zero,
  eviction, node drain) while RPC Proxy is still old, and that Host answers
  401.
- **Host restarts.** The upgrade replaces every Host Deployment. Host
  Deployments use the `Recreate` strategy, HCC does not wait for one Host to
  come back before it replaces the next (`HCC_HOST_FULL_RECONCILE_CONCURRENCY`,
  default 2, limits concurrent reconciles, not downtime), and the Host pod
  sets no `terminationGracePeriodSeconds`, so in-flight tasks are cut after
  the Kubernetes default of 30 seconds. Plan a maintenance window.
- **Retired edge credentials.** No release up to v0.12.1 created or read
  Secret `rpc-proxy-edge-credentials` (namespace `mcp-host`) or the key
  `RPC_PROXY_MCP_HOST_EDGE_TOKEN` in Secret `rpc-proxy-secrets` (namespace
  `rpc-proxy`); only `dev` builds from before this release did. This release
  reads neither. If your cluster ran such a `dev` build, keep both until the
  rollback window closes, then delete them: an HCC rolled back to that build
  with `CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL=dedicated-header-v1` writes
  Host pods that require the Secret, and that RPC Proxy build uses the key
  only for V2 Host traffic (it starts without it).
- **Key sync after every overlay apply.** From this release every Desktop →
  Host route depends on `CLERUM_AUTH_JWT_PUBLIC_KEY` in `mcp-host-config`;
  before it, only `POST /v1/runtime/compact` and session search did. An
  overlay apply overwrites that ConfigMap with the key literal committed in
  the overlay, so the production orchestrator (owned by
  `keyper-labs/evenfire-infra`, see above) runs
  `scripts/minikube/sync-auth-key.sh` right after it. The script patches the
  key back from `RPC_PROXY_JWT_PUBLIC_KEY` in Secret `rpc-proxy-secrets`,
  checks that every Deployment in `mcp-host` that binds the key (HCC-managed
  Hosts included) runs with it, restarts the ones that drifted, and fails
  otherwise. The orchestrator's phased apply rolls out and verifies
  control-api before RPC Proxy and HCC change. A Host started between the
  apply and the sync answers 401 on every Desktop → Host route until the sync
  restarts it.
- **Confirm three keys match before the upgrade:** the public half of
  control-api's RPC signing key (`CONTROL_API_RPC_JWT_PRIVATE_KEY` in Secret
  `control-api-secrets`, namespace `control-plane`), `RPC_PROXY_JWT_PUBLIC_KEY`
  in Secret `rpc-proxy-secrets` (namespace `rpc-proxy`), and
  `CLERUM_AUTH_JWT_PUBLIC_KEY` in ConfigMap `mcp-host-config` (namespace
  `mcp-host`). Compare SHA-256 digests of the DER public key, and print only
  the digests. Secret values are base64 in `.data`; ConfigMap values are not.
  The key may be stored with real newlines or a literal `\n` (the Host
  accepts both), so normalize it before hashing. At runtime, a Host refusal
  log with `verify-failed` and `JsonWebTokenError` is the signal that the
  keys drifted.

The in-repository executable barrier covers the supported Minikube path. Production
GCP rollout and rollback orchestration is owned by `keyper-labs/evenfire-infra`;
this OSS repository does not publish its exact workflow path. That orchestrator
must enforce both orders before this release reaches production.

[minikube.md](minikube.md) and `scripts/minikube/full-setup.sh` show the full
dependency graph. The minikube scripts are bound to a minikube profile; the
scripts under [`deploy/scripts`](../../deploy/scripts) take a `CONTEXT` and are
the ones to use elsewhere. Several of them also require `ALLOWED_CONTEXTS`, an
exact allowlist of kube-contexts they may touch.

Pick one kube-context for the whole install and pass it explicitly to every
command; do not rely on your kubeconfig's current context. The examples use
`KCTX`, and the same value goes into each script's `CONTEXT`:

```bash
KCTX=<your-context>
kubectl --context "$KCTX" cluster-info   # confirm this is the cluster you mean
```

1. **CRDs.**

   ```bash
   helm --kube-context "$KCTX" install clerum-crds ./charts/clerum-crds
   # After chart upgrades, re-apply the CRD YAML (Helm 3 does not upgrade crds/):
   kubectl --context "$KCTX" apply -f ./charts/clerum-crds/crds/
   ```

2. **Namespaces.** The key scripts write into existing namespaces, so create
   them first:

   ```bash
   kubectl --context "$KCTX" apply -f deploy/base/namespaces.yaml
   ```

   Your overlay apply (step 4) adds the deny-all baselines, Roles and
   cluster-wide objects. If your CD identity may not patch Roles, run
   [`deploy/scripts/bootstrap-rbac.sh`](../../deploy/scripts/bootstrap-rbac.sh)
   once with an admin kubeconfig.

3. **Keys and secrets.** Run
   [`deploy/scripts/gen-jwt-keys.sh`](../../deploy/scripts/gen-jwt-keys.sh)
   with `CONTEXT="$KCTX"`. It creates the four RSA-4096 key pairs
   (session, rpc, admin, wrc), the OAuth state HMAC and encryption key, the
   Control UI CSRF secret, the prompt-history encryption key, and the
   Secrets and public-key ConfigMaps that carry them. Then run
   [`deploy/scripts/apply-inter-service-tokens.sh`](../../deploy/scripts/apply-inter-service-tokens.sh)
   for the service-to-service tokens with the same explicit context:
   ```bash
   CONTEXT="$KCTX" bash deploy/scripts/apply-inter-service-tokens.sh
   ```
   Know these before you run them:
   - `gen-jwt-keys.sh` generates **new** keys on every run. Running it again
     rotates every key, including the OAuth encryption key. Run it once and
     keep the output. A second run is a full re-bootstrap that cuts service,
     not a rotation: it restarts only the Deployments in `mcp-host`, so until
     you restart control-api and RPC Proxy, every Desktop → Host request
     returns 401.
   - Set `ADMIN_BOOTSTRAP_PASSWORD_HASH` (a bcrypt hash) before you run it.
     Otherwise it writes a placeholder hash.
   - It writes the `control-postgres` Secret with user `postgres` and password
     `postgres`. Replace it before Postgres first starts. A re-run resets that
     Secret to `postgres`/`postgres`, and the admin hash to the placeholder
     unless you set `ADMIN_BOOTSTRAP_PASSWORD_HASH` again.
   - `mcp-host-config` must carry the RPC public key as
     `CLERUM_AUTH_JWT_PUBLIC_KEY`. `gen-jwt-keys.sh` patches it only if the
     ConfigMap already exists, so after your first overlay apply (and after
     any apply that rewrites it) copy `RPC_PROXY_JWT_PUBLIC_KEY` from Secret
     `rpc-proxy-secrets` (namespace `rpc-proxy`) into it, then restart every
     Deployment in `mcp-host`: from this release every Desktop → Host route
     depends on that key. Never keep the key
     from the minikube copy. `control-api-public-key` and
     `clerum-wrc-public-key` are not in base: `gen-jwt-keys.sh` creates them
     and `kubectl apply -k` leaves them alone.
   - `apply-inter-service-tokens.sh` creates any missing Secret and then
     writes with `kubectl patch`, so later `kubectl apply -k` runs do not wipe
     the tokens. It keeps existing values. Minikube runs it again after every
     overlay apply; do the same. Outside minikube it
     refuses to run without `CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET` (or
     an existing value in the Secret).
   - Secrets for LLM keys and channel credentials are separate; see
     [LLM providers (operator guide)](llm-providers.md).

4. **Apply your overlay** (`kubectl --context "$KCTX" apply -k <your-overlay>`), with the
   ghcr component pinned to one release tag.

5. **Database migrations and roles.** Run
   [`run-control-api-db-migration.sh`](../../deploy/scripts/run-control-api-db-migration.sh)
   `--overlay <your-overlay>`, then
   [`provision-control-api-runtime-roles.sh`](../../deploy/scripts/provision-control-api-runtime-roles.sh).
   If you use the Global File System, follow
   [GFS permission-store credential lifecycle](gfs-permission-store.md)
   (`provision-gfs-db.sh`, `provision-gfs-runtime.sh`).
   The instance-provisioning path in `provision-gfs-runtime.sh` requires `jq`.
   When it applies the overlay's instances directory, it preserves the live
   connector associations of `mcp-server/context1`; removing a connector from
   that directory does not remove the association. Remove it through Control UI
   or an explicit administrative update instead.
   `provision-gfs-runtime.sh` refuses a non-dev context unless it is listed in
   `ALLOWED_CONTEXTS` or you pass `--allow-prod`. `provision-gfs-db.sh` has no
   such guard: it runs against whatever `CONTEXT` you give it, so check that
   value before you run it.

6. **First admin.** control-api creates the bootstrap admin from
   `CONTROL_API_ADMIN_BOOTSTRAP_USERNAME`, `CONTROL_API_ADMIN_BOOTSTRAP_EMAIL`
   and `CONTROL_API_ADMIN_BOOTSTRAP_PASSWORD_HASH` when it initializes the
   schema, and only while no other active admin exists. The control-api image
   runs with `NODE_ENV=production`, so it will not start without the hash.
   It does start with the placeholder hash `gen-jwt-keys.sh` writes when
   `ADMIN_BOOTSTRAP_PASSWORD_HASH` is unset; that placeholder is not a usable
   password.
   The minikube seed scripts are test tooling; do not use them here.

7. **UIs and the Desktop App.** `control-ui` and `profile-ui` are in base. The
   Desktop App is distributed to users, not deployed; see
   [Ship it to your users](../surfaces/desktop-app.md#ship-it-to-your-users).

8. **First Host, Context and channel.** Start with the smallest declarative
   config. See the [CRD reference](../crds/README.md).

9. **Connectors.** Add McpServers on an allowlisted Context; see
   [Add an MCP server](../how-to/add-mcp-server.md).

10. **Member invitations.** Decide how invitation email is sent before you
    invite anyone; see [member invitations on self-hosted](../how-to/member-invitations-self-hosted.md).
    The zero-config path is `CONTROL_API_MEMBER_REGISTRATION_MODE=hosted`:
    control-api enrolls itself with evenfire's registration hub, which sends
    the mail. It requires your Profile UI and Control UI base URLs to be
    **real, publicly resolvable domains** (the host guard refuses `localhost`,
    IP literals and dotless hostnames) plus egress to
    `registration.evenfire.ai`. The alternative is to run your own
    `member-registration-service` (not in this repository) and keep the
    default mode, `remote`. Minikube's `127.0.0.1` URLs cannot use hosted mode.

11. **Observability.** [`monitoring/`](../../monitoring/README.md) is an
    optional Loki and Grafana starter (Helm values and a dashboard). It is
    not part of `deploy/base`.

For the generation-aware Desktop GFS rollout, read the [operator parity
compatibility contract](../architecture/gfs-desktop-operator-parity.md#rollout-and-compatibility-contract)
before upgrading. The first rollout intentionally requires one sign-in per
existing external session, and direct callers of `DELETE /api/v1/members/:userId`
must send both a non-empty `reason` and an `Idempotency-Key`.

## Upgrades

Back up Postgres, apply the CRDs from the new checkout, then roll out every
image from the same release tag. The full order and the feature-specific
runbooks are in [releases and upgrades](releases-and-upgrades.md#upgrade-notes):

- [Workflow output PVC upgrade](workflow-output-pvc-upgrade.md)
- [Plugin Workload SDK upgrade and policy migration](plugin-workload-sdk-upgrade.md)
- [GFS permission-store credential lifecycle](gfs-permission-store.md)

## Security non-negotiables

- Do not run with `CLERUM_DEV_MODE=true`, and never expose `mcp-host`'s runtime
  port beyond the NetworkPolicy-allowed edge services. The edge trust headers
  it accepts are forgeable by anyone who can reach the port.
- Keep default-deny NetworkPolicies; only open (context, server) pairs you intend.
- Switch both connector-image allowlists to enforce
  (`CONTEXT_MAPPER_ENFORCE_IMAGE_ALLOWLIST=true` for HCC and
  `CONTROL_API_ENFORCE_IMAGE_ALLOWLIST=true` for control-api), and narrow both
  allowed-prefix lists.
- Custom workflow coordinator images are off by default
  (`WRC_ENABLE_CUSTOM_COORDINATOR_IMAGE=false`). If you turn them on, keep
  `WRC_REQUIRE_COORDINATOR_IMAGE_DIGEST=true` (the default), which requires a
  sha256 digest.
- Replace every development default: the `postgres:postgres` database
  credentials, the minikube `rpc-proxy-config` secrets, and any placeholder
  key or hash.
- Treat approval policy as a control, not a UX preference.
- Report vulnerabilities per [SECURITY.md](../../SECURITY.md).

## What this repository does not provide

- **A production overlay.** Only minikube overlays exist. The base
  kustomization mentions GKE overlays; those are not in this repository.
- **An ingress controller, Ingress objects or certificates.** The optional
  Cloudflare Tunnel stack in `deploy/base/ingress` is the only edge
  component, and it is not included by default.
- **External secret-manager integration.** There is no Vault or External
  Secrets Operator wiring. Secrets are plain Kubernetes Secrets created by the
  scripts above.
- **Self-hosted model endpoints.** Each LLM provider has a fixed API endpoint
  (Azure OpenAI takes `AZURE_OPENAI_ENDPOINT`), and agent egress excludes
  private address ranges. A model server on your private network is not
  reachable as shipped.
- **Highly available Postgres or backups.** Base runs one Postgres replica.
- **The member-registration service.** Use hosted mode or run your own.
- **Turnkey cloud-vendor guides.**

## License

evenfire is open source under **MPL-2.0**: self-hosting, modification, and
commercial use are permitted; file-level copyleft applies when you distribute
modified MPL-licensed files. See [LICENSE](../../LICENSE).

## Related

- [Releases and upgrades](releases-and-upgrades.md)
- [Configuration reference](../reference/configuration.md)
- [Minikube setup](minikube.md)
- [WorkflowRecipes operations](workflow-recipes-guide.md)
- [Host PVC layout upgrade from v0.10.x / v0.11.x](host-pvc-layout-upgrade.md)
- [Member invitations on self-hosted](../how-to/member-invitations-self-hosted.md)
- [Architecture / topology](../architecture/platform-topology.md)
- [FAQ](../faq.md)
