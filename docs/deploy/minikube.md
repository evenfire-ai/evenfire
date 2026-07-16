# Minikube Deploy Guide — evenfire full stack

Reference guide for deploying the **full** evenfire platform on local minikube
(all services, JWT auth chain, NetworkPolicies). Historical scripts and profiles
may still say **clerum** ([code names](../concepts/code-names.md)).

> **New here?** For a 10-minute agent-only try without Kubernetes, use the
> [Quickstart](../get-started/quickstart.md) first. This guide is the full local
> platform path (Path C in the [learning path](../get-started/learning-path.md)).

Includes the correct order of operations, the JWT authentication chain, and known issues.

---

## Minikube Profile

Normal local development uses the single-node `clerum-test` profile:

```bash
minikube start --profile clerum-test --cpus 6 --memory 10240 --driver docker --cni calico
# or simply:
make minikube-start
```

Multi-node minikube is intentionally opt-in. Use it only for gates that must
prove cross-node scheduling behavior, such as WorkflowRecipe RWO/PVC affinity
validation for PR #369 / issue #368:

```bash
MINIKUBE_PROFILE=clerum-codex-rwo-<sha> \
MINIKUBE_MULTI_NODE=true \
MINIKUBE_NODES=2 \
make minikube-start
```

For final PR evidence, use a fresh generated profile instead of the shared
`clerum-test` profile. The profile must pass native
`minikube -p <profile> status`, have at least two Ready schedulable nodes, expose
the `standard` StorageClass, run the `storage-provisioner` pod, and have Calico
Ready before E2E results are interpreted.

---

## Prerequisites

- **Docker Desktop** installed and running
- **minikube** v1.30+ (`brew install minikube`)
- **kubectl** (`brew install kubectl`)
- **python3** (for JWT key sync)
- **Node.js** 24+ (for building services and desktop app)
- `.env` file at project root with LLM API keys (optional — uses placeholders if missing)

---

## Full Setup (First Time — from scratch)

```bash
make minikube-setup    # Single command: cluster → namespaces → CRDs → keys → secrets → images → deploy → verify
make minikube-status   # Confirm all services after setup
```

This takes 5-10 minutes on first run (image build is the slowest part). The script is idempotent — safe to run again if interrupted or if something fails.

After rebasing or syncing with `dev`, do not assume the running cluster is fresh.
Run the pre-gate sync before cluster-backed E2E so images, CRDs, manifests,
generated config, secrets, and rollouts match the current worktree:

```bash
make minikube-pre-gate-sync GATE=<gate-name>
```

When deployable code changed and the E2E runner will manage port-forwards
itself, force the sync and skip the short-lived background port-forward refresh:

```bash
make minikube-pre-gate-sync GATE=<gate-name> ARGS="--force-cluster-sync --skip-port-forwards"
```

### Invitation Email / member-registration (not in this repo)

`member-registration-service` lives in a **separate repository that is not part of
this distribution**. There is no `member-registration` overlay, manifest, or deploy
script in this tree, so `make minikube-setup` cannot deploy it.

> control-api also has a **hosted mode**
> (`CONTROL_API_MEMBER_REGISTRATION_MODE=hosted`) that sends invitation emails
> via evenfire's shared registration hub with nothing to deploy — see [Member
> invitations on self-hosted](../how-to/member-invitations-self-hosted.md).
> It does not apply here: hosted mode requires real, publicly resolvable
> `CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL` / `CONTROL_API_CONTROL_UI_BASE_URL`
> domains and refuses `localhost`/IP literals, so a stock minikube deploy
> (127.0.0.1 defaults) cannot use it. This section's sibling-checkout path
> remains the only option for local minikube.

`scripts/minikube/full-setup.sh` looks for a sibling checkout at
`../evenfire-member-registration` (override with `EVENFIRE_MEMBER_REGISTRATION_DIR`).
Without it, setup simply prints a warning and continues:

```
evenfire-member-registration not found at <path>/evenfire-member-registration
control-api invitation flows will fail any registration call until you clone it:
```

Everything else in this guide works without it; only control-api invitation /
registration calls fail.

### After Setup

```bash
# 1. Start local Control UI + Profile UI + Desktop App against minikube
npm run ui

# 2. Open Control UI
open http://localhost:3000

# 3. Invite a member in Control UI. The email link should target:
#    http://localhost:3001/invitations/<token>
```

`make minikube-setup` seeds the default test user and agent/context access. `npm run ui` keeps the required API port-forwards open while it runs the local frontends.

`make test-e2e-vitest` and `make test-e2e-all` install `tests/e2e`
dependencies when missing and hold the minikube port-forwards for the Vitest
phase. They also mint `MCP_HOST_AUTH_TOKEN` for legacy direct `mcp-host`
suites. Direct `npx vitest` runs still need an active `make minikube-pf-all`
terminal, or `scripts/minikube/pf-all-stack.sh --hold` in Codex/App runners
that clean child processes, plus the auth token when runtime auth is enabled.
Set `E2E_HOST_REF` if your local runtime host is not `chatllm`. Local runs wait
for optional full-stack endpoints by default; GitHub Actions skips those waits
unless `E2E_WAIT_FULL_STACK=true`.

The software-creation suites require a special model and approval-policy
profile; run them explicitly with `E2E_RUN_SOFTWARE_CREATION=1`.

### Options

```bash
make minikube-setup                        # Full setup from scratch
make minikube-setup ARGS="--skip-build"    # Re-deploy without rebuilding images (~1 min)
make minikube-setup ARGS="--reset-db"      # Reset postgres before deploy (fixes WAL corruption)
make minikube-setup ARGS="--force-keys"    # Regenerate all JWT signing keys
```

### Manual Steps (Advanced)

If you need to run individual steps:

```bash
make minikube-start             # 1. Start cluster
make minikube-apply-namespaces  # 2. Create namespaces (gen-keys writes Secrets into them)
make minikube-deploy-crds       # 3. Install CRDs (Helm chart + CRD YAML)
make minikube-gen-keys          # 4. Generate/keep JWT keys + auto-sync public key
make minikube-apply-secrets     # 5. Apply the remaining secrets
make minikube-build-images      # 6. Build Docker images
make minikube-deploy-all        # 7. Deploy via kustomize
```

Steps 2 and 3 are not optional on a fresh cluster: `minikube-gen-keys` applies Secrets
and ConfigMaps into `control-plane`, `sandbox-recipes`, `rpc-proxy` and `profiles`, which
must already exist, and the deploy is meaningless without the CRDs.

`make minikube-start` delegates to `scripts/minikube/start.sh`. That helper keeps
single-node as the default, adds `--nodes=<n>` only when
`MINIKUBE_MULTI_NODE=true` or `MINIKUBE_NODES>1`, enables
`default-storageclass` and `storage-provisioner`, and fails if native minikube
status or required node/storage readiness checks do not pass.
If `full-setup.sh` detects a broken profile, it refuses destructive recreation
unless `MINIKUBE_RECREATE_PROFILE=true` and `CONFIRM_PROFILE=<profile>` are both
set for that exact profile.
Destructive maintenance flags such as `--reset-db` act on the selected
`MINIKUBE_PROFILE`, not just `clerum-test`; verify the target profile before
using them.

> **NOTE**: `make minikube-gen-keys` applies the key Secrets and then chains
> `make minikube-sync-auth-key` itself (Makefile, `minikube-gen-keys`), so the JWT public
> key lands in mcp-host-config without a separate command. Re-running
> `make minikube-sync-auth-key` later is harmless — `scripts/minikube/sync-auth-key.sh`
> only writes the ConfigMap when it detects drift.

> **`minikube-gen-keys` does NOT regenerate keys on an existing cluster.**
> `scripts/minikube/generate-keys.sh` has an anti-pattern guard: if the Secret
> `control-api-secrets` already exists in `control-plane` and `FORCE_REGEN` is not
> `true`, it logs "Skipping key generation…" and exits without generating or writing new
> keys (regeneration would invalidate every existing token and session).
> `make minikube-apply-secrets` has the same skip. To actually regenerate:
>
> ```bash
> FORCE_REGEN=true make minikube-gen-keys
> # or, as part of a full setup:
> make minikube-setup ARGS="--force-keys"
> ```

---

## JWT Authentication Chain

### Full Flow

```
Desktop App
  POST /api/v1/rpc/token (Bearer session_token)
  → external-rest-api:8091
      → control-api:8090  POST /external/rpc/token
          ← JWT  { iss: "control-api", aud: "rpc-proxy", typ: "user",
                   sub: <userId>, scopes: [...], hostRefs: [...], exp: iat+300 }
  ← RPC token (TTL 300s)

Desktop App
  GET /api/v1/rpc/hosts/chatllm/status/stream  (Bearer rpc_token)
  → rpc-proxy:8094
      validates rpc_token  (issuer=control-api, aud=rpc-proxy)
      → control-api:8090  GET /rpc/access/users/{id}/mcp-hosts/chatllm
          ← { url: "http://chatllm.mcp-host.svc:8080", hostRef: "chatllm" }
      → chatllm:8080  GET /v1/runtime/status   ← NO Authorization header
          x-clerum-edge-caller: rpc-proxy
          x-clerum-edge-host-ref: chatllm
          x-clerum-edge-user-id: <userId>
          mcp-host's runtimeEdgeGuard validates the edge headers
          ← status JSON
```

### Critical Invariants

| Invariant                | Description                                                                                                                                                                                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Same RSA key**         | `rpc-proxy-secrets.RPC_PROXY_JWT_PUBLIC_KEY` == `mcp-host-config.CLERUM_AUTH_JWT_PUBLIC_KEY` == public pair of `control-api-secrets.CONTROL_API_RPC_JWT_PRIVATE_KEY`. `scripts/minikube/generate-keys.sh` writes the two Secrets into `deploy/minikube/secrets/jwt-signing-keys.yaml`; the ConfigMap value is **not** in that manifest — `scripts/minikube/sync-auth-key.sh` copies the public key from the live `rpc-proxy-secrets` Secret into the live `mcp-host-config` ConfigMap.                                                                                                                       |
| **Token stops at rpc-proxy** | The RPC token (`aud: "rpc-proxy"`) is validated by rpc-proxy and is NOT forwarded. `/v1/runtime/*` routes on mcp-host are wrapped in `runtimeEdgeGuard`, which returns `401 Authorization is not accepted on this direct mcp-host runtime route` if an `Authorization` header is present. |
| **Issuer**               | All RPC tokens have `iss: "control-api"`. mcp-host must have `CLERUM_AUTH_JWT_ISSUER=control-api`                                                                                                                                                                                       |
| **Edge headers**         | `rpc-proxy/src/services/controlApiRestService.ts` returns `headers: {}` on purpose; `mcpProxyService.ts` then adds `x-clerum-edge-caller: rpc-proxy`, `x-clerum-edge-host-ref`, `x-clerum-edge-user-id`. Adding an `Authorization` header here would make every mcp-host call fail 401.  |

### Required Configuration Per Service

#### rpc-proxy-secrets (Secret, namespace: rpc-proxy)

Written by `scripts/minikube/generate-keys.sh`:

```
RPC_PROXY_JWT_PUBLIC_KEY            = <RSA-4096 public key, pair of CONTROL_API_RPC_JWT_PRIVATE_KEY>
RPC_PROXY_CONTROL_API_SERVICE_TOKEN = <service token for the control-api RPC gateway>
```

#### rpc-proxy-config (ConfigMap, namespace: rpc-proxy)

The issuer/audience the proxy validates against are **not** in the Secret — they live in
`deploy/overlays/minikube/configmaps/rpc-proxy-config.yaml`:

```
RPC_PROXY_JWT_ISSUER          = control-api
RPC_PROXY_JWT_AUDIENCE        = rpc-proxy
```

#### mcp-host-config (ConfigMap, namespace: mcp-host)

```
CLERUM_ENABLE_AUTH            = true
CLERUM_AUTH_JWT_ISSUER        = control-api
CLERUM_AUTH_JWT_AUDIENCE      = rpc-proxy      ← NOT "mcp-host"
CLERUM_AUTH_JWT_PUBLIC_KEY    = <same public key as rpc-proxy-secrets>
```

> **Where does mcp-host still validate a bearer token?**
> Only on the two runtime routes that are not behind `runtimeEdgeGuard`:
> `GET /v1/runtime/sessions/search` (scope `host:session:read`) and
> `POST /v1/runtime/compact` (scope `host:compaction:invoke`). These use
> `requireScope`, which verifies an RS256 token issued by control-api with
> `aud: "rpc-proxy"` — hence the audience value above. Every other
> `/v1/runtime/*` route is edge-header authenticated and **rejects** an
> `Authorization` header with 401.

---

## SSE Stream and Token Lifecycle

The Desktop App maintains an SSE stream to rpc-proxy to receive agent status updates. The token is captured **once** when the stream is opened.

```
Desktop App opens SSE stream with token T1 (TTL=300s)
  rpc-proxy validates T1 once, then resolves and captures the host connection
    (url + x-clerum-edge-* headers — the RPC token itself is NOT forwarded)
  Every 3s: forwardHostStatus(host) → GET chatllm:8080/v1/runtime/status

  RECOVERY MECHANISM (since commit c06c6a6):
    If the upstream host starts rejecting polls with 401/403:
    consecutiveAuthFailures++
    After 3 consecutive auth failures (~9s):
      cleanup("auth-expired") → stream closed with SSE event
      → Desktop App receives "closed", calls getOrIssue() with expired token
      → getOrIssue() detects expiration → issueRpcToken() → new token T2
      → Opens new stream with T2 → cycle continues cleanly
```

**Without the fix**: the stream waited for the 60s idle timeout (20 polls × 3s) before closing.
**With the fix**: closes in ~9s (3 polls × 3s) → much faster reconnection.

---

## Rebuild and Update a Service

### rpc-proxy (example)

```bash
# Run from the repo root — the build context below is repo-root relative.

# 1. Compile TypeScript
npm run build --prefix rpc-proxy

# 2. Build Docker image
docker build -t clerum/rpc-proxy:test rpc-proxy/

# 3. Transfer to minikube node
docker save clerum/rpc-proxy:test > /tmp/rpc-proxy.tar
minikube cp /tmp/rpc-proxy.tar /tmp/rpc-proxy.tar --profile clerum-test
minikube ssh --profile clerum-test "docker rmi clerum/rpc-proxy:test 2>/dev/null; docker load -i /tmp/rpc-proxy.tar"

# 4. Restart deployment
kubectl rollout restart deployment/rpc-proxy -n rpc-proxy --context clerum-test
kubectl rollout status deployment/rpc-proxy -n rpc-proxy --timeout=60s

# Or simpler with the Makefile:
make minikube-build-images    # rebuild everything
```

### Update a ConfigMap and Have the Pod Pick It Up

```bash
kubectl apply -f deploy/overlays/minikube/configmaps/rpc-proxy-config.yaml --context clerum-test
kubectl rollout restart deployment/rpc-proxy -n rpc-proxy --context clerum-test
```

> **Important**: Pods read ConfigMaps **at startup** (via `envFrom`).
> A change in the ConfigMap is NOT automatically propagated — you must restart the pod.

> **Careful with `mcp-host-config`**: that manifest
> (`deploy/overlays/minikube/configmaps/mcp-host-config.yaml`) carries a **committed,
> stale** `CLERUM_AUTH_JWT_PUBLIC_KEY`. Applying it overwrites the live public key with
> the repo value and breaks mcp-host bearer auth. Always re-sync afterwards:
>
> ```bash
> kubectl apply -f deploy/overlays/minikube/configmaps/mcp-host-config.yaml --context clerum-test
> make minikube-sync-auth-key    # restores the key from rpc-proxy-secrets + restarts mcp-host
> ```
>
> (`make minikube-deploy-all` chains the same sync for exactly this reason.)

---

## Port Forwards for the Desktop App

```bash
make minikube-pf-desktop
# equivalent to:
kubectl port-forward -n control-plane svc/control-api 8090:8090 --context clerum-test &
kubectl port-forward -n profiles svc/external-rest-api 8091:8091 --context clerum-test &
kubectl port-forward -n rpc-proxy svc/rpc-proxy 8094:8094 --context clerum-test &
```

| Port  | Service           | Usage                                 |
| ----- | ----------------- | ------------------------------------- |
| :8091 | external-rest-api | Login OAuth / issueRpcToken           |
| :8094 | rpc-proxy         | SSE stream + invoke/approve/deny      |
| :8090 | control-api       | Admin UI, CRUD (optional for Desktop) |
| :3000 | control-ui        | Control UI web (optional)             |

> **After any pod restart**: port-forwards are disconnected.
> Always re-run `make minikube-pf-desktop` after a `kubectl rollout restart`.

---

## Full Restart Without Losing Data

```bash
make minikube-restart-all     # Restart all deployments
make minikube-pf-desktop      # Re-establish port forwards
```

---

## Restart With Database Wipe

```bash
make minikube-db-reset        # Deletes postgres PVC, recreates it, restarts control-api
# → Allows re-running the initial admin setup in Control UI
```

---

## WorkflowRecipe / WRC — Configuration

The Workload Recipes Controller (WRC) manages `WorkflowRecipe` CRDs. It requires:

### Signing Key (JWT for workflow pods)

```bash
# Automatically generated by make minikube-gen-keys
# The script creates the Secret "clerum-wrc-signing-key" in control-plane with:
#   private.pem — signs tokens for coordinator + mcp_host pods
#   public.pem  — verifies tokens in the WRC REST endpoints

kubectl get secret clerum-wrc-signing-key -n control-plane --context clerum-test
```

If the WRC starts without the Secret, the workflow subsystem is disabled (degraded mode:
WorkflowRecipes of type `workflow` return errors, other workloads continue to function).

### Public Key ConfigMap — CRITICAL

The coordinator pod reads the WRC public key from the ConfigMap `clerum-wrc-public-key`.
This ConfigMap must exist in **TWO** namespaces:

```bash
# Automatically created by make minikube-gen-keys
kubectl get configmap clerum-wrc-public-key -n control-plane --context clerum-test
kubectl get configmap clerum-wrc-public-key -n sandbox-recipes --context clerum-test
```

If the ConfigMap is missing from `sandbox-recipes`, the coordinator pod (which runs
there) cannot read the public key and all workflow JWTs fail with `401 Invalid token`.

### Workflow Env Vars

| Variable                   | Value in base manifest             | Usage                                      |
| -------------------------- | ---------------------------------- | ------------------------------------------ |
| `CLERUM_COORDINATOR_IMAGE` | `clerum/workflow-coordinator:0.9.5` | Coordinator pod image                      |
| `CLERUM_MCP_HOST_IMAGE`    | `clerum/mcp-host:0.9.5`            | mcp_host image injected into workflows     |
| `CLERUM_WRC_SERVICE_NAME`  | not set (code fallback `workflow-recipes`) | Service name for coordinator DNS callbacks |

The first two are set in `deploy/base/control-plane/workflow-recipes.yaml` (lines
133-136). `CLERUM_WRC_SERVICE_NAME` is **not** in any manifest — it is an optional
override read from the process environment, with the fallback `workflow-recipes`
hardcoded in `workflow-recipes/src/reconciler/workflowRecipeReconciler.ts:622`.

The base manifest pins the two images to the release tag; the minikube overlay
rewrites them to `:test` through the `images:` block in
`deploy/overlays/minikube/kustomization.yaml` (see
`deploy/overlays/minikube/patches/dynamic-images.yaml` for why they are not
patched by value), so in a minikube cluster the running values are
`clerum/workflow-coordinator:test` and `clerum/mcp-host:test`.

> **Bug fixed**: previously `clerum-operator` was used as the service name. The coordinator could
> not reach the WRC REST endpoint and all status updates returned `ECONNREFUSED`.

### stdio-bridge in HCC (deploy/base/control-plane/host-context-controller.yaml)

```yaml
CONTEXT_MAPPER_STDIO_BRIDGE_IMAGE: clerum/stdio-bridge:0.9.5
```

Like the coordinator/mcp-host images above, the base manifest pins the release tag
and the minikube overlay rewrites it to `:test` via the `images:` block in
`deploy/overlays/minikube/kustomization.yaml`, so the running value in a minikube
cluster is `clerum/stdio-bridge:test`. That image is built with
`make minikube-build-images`.

### E2E Workflow Tests

```bash
# E2E suites for stdio recipes:
bash scripts/e2e/e2e-agentic-stdio-baseline.sh                  # Pure compute stdio
bash scripts/e2e/workflow-backend-compat/stdio-postgres.sh       # stdio + PostgreSQL
bash scripts/e2e/workflow-backend-compat/stdio-multi-tool.sh     # 2 stdio servers + Redis

# Workflow runtime gate:
bash scripts/e2e/e2e-workflow-runtime-gate.sh
```

**Contexts per recipe**: WRC creates a Context CRD `wf-{recipeName}` in `mcp-server` (H-04 isolation).
Tests should verify `kubectl get context wf-{recipeName}` instead of the shared `context1`.

---

## WorkflowRecipe — Namespace, NetworkPolicies and Execution

This section documents the bugs found during e2e testing of the agentic workflow execution
pipeline and the fixes applied.

### Critical — WorkflowRecipe Namespace

**WorkflowRecipes MUST be created in the `sandbox-recipes` namespace.**

This is a platform invariant. Recipe YAML does not decide final placement:
`control-api` strips or ignores author-supplied `metadata.namespace`, direct
cluster applies are denied outside `sandbox-recipes`, and WRC reconciles from
that canonical namespace. The `mcp-server` namespace is reserved for rendered
MCP transport children such as `McpServer` CRDs, Deployments, Services, and
their NetworkPolicies.

```bash
# CORRECT:
kubectl apply -f recipe.yaml -n sandbox-recipes

# INCORRECT (admission policy rejects it):
kubectl apply -f recipe.yaml -n mcp-server
```

The Control UI and Control API create recipes in `sandbox-recipes` by default.
The UI validator intentionally does not treat recipe YAML namespace as
authoritative.

---

### Workflow NetworkPolicies

When the WRC creates a workflow it manages, depending on what the recipe uses, up
to **11 NetworkPolicies** in `sandbox-recipes` plus **one ingress NP per MCP
server** in `mcp-server`:

| NP                                       | Namespace         | Direction | Purpose                                                                           |
| ---------------------------------------- | ----------------- | --------- | --------------------------------------------------------------------------------- |
| `{name}-coord-to-mcp-host`               | `sandbox-recipes` | Egress    | Coordinator → mcp_host pod                                                        |
| `{name}-coord-to-mcp-host-ingress`       | `sandbox-recipes` | Ingress   | mcp_host accepts connections from the coordinator                                 |
| `{name}-coord-to-wrc`                    | `sandbox-recipes` | Egress    | Coordinator → WRC REST API                                                        |
| `{name}-wrc-to-mcp-host`                 | `sandbox-recipes` | Ingress   | WRC → mcp_host (`/configure` after `/configure-model` or SDK `/injections/model`) |
| `{name}-wrc-to-artifact-reader`          | `sandbox-recipes` | Ingress   | WRC → artifact-reader                                                             |
| `{name}-mcp-host-to-servers`             | `sandbox-recipes` | Egress    | mcp_host → MCP servers in `mcp-server`                                            |
| `{name}-mcp-host-to-llm-api`             | `sandbox-recipes` | Egress    | mcp_host → external LLM (ports 443/80)                                            |
| `{name}-mcp-host-to-approval-gateway`    | `sandbox-recipes` | Egress    | mcp_host → workflow approval gateway                                              |
| `{name}-coord-to-snippet-runner`         | `sandbox-recipes` | Egress    | Coordinator → snippet runner                                                      |
| `{name}-coord-to-snippet-runner-ingress` | `sandbox-recipes` | Ingress   | Snippet runner accepts connections from the coordinator                           |
| `{name}-snippet-runner-egress`           | `sandbox-recipes` | Egress    | Snippet runner declared egress                                                    |
| `{name}-wf-mcp-ingress-{mcpServerName}`  | **`mcp-server`**  | Ingress   | That MCP server accepts connections from mcp_host (one NP per MCP server)         |

```bash
# List the NPs the recipe owns:
kubectl get networkpolicies -n sandbox-recipes -l clerum.io/recipe=<recipeName> --context clerum-test
kubectl get networkpolicies -n mcp-server -l clerum.io/recipe=<recipeName> --context clerum-test
```

**Bugs fixed:**

- **NP-01**: the `mcp-host-to-servers` egress used label `{workloadId}` — now uses `{recipeName}-{workloadId}` which is the actual pod format.
- **NP-02**: the ingress NP in `mcp-server` (now `wf-mcp-ingress-{mcpServerName}`, one per MCP server) was missing — the namespace deny-all blocked all cross-namespace traffic.
- **NP-03**: egress to ports 443/80 for the external LLM (`mcp-host-to-llm-api`) was missing — the `sandbox-recipes` deny-all blocked calls to ZAI/OpenAI and each step timed out at 300s.

**Symptom of missing NPs:**

```
[Coordinator] Failed to connect to MCP servers: web-search   ← NP-01 or NP-02
step-timeout (300s)                                           ← NP-03 (LLM unreachable)
```

---

### Coordinator HTTP Timeout on `/execute`

The coordinator's call to mcp_host `/execute` does **not** use a fixed HTTP timeout.
The timeout is derived per step in
`packages/workflow-runtime-core/src/mcp-host-client/client.ts`:

```typescript
const TIMEOUT_BUFFER_MS = 5000
// ...
const timeoutMs = resolveStepTimeoutSeconds(req) * 1000 + TIMEOUT_BUFFER_MS
```

`resolveStepTimeoutSeconds()` takes the step's `timeoutSeconds` when set (must be an
integer between 1 and 5400), otherwise falls back to the
`MCP_HOST_STEP_TIMEOUT_SECONDS` env var, otherwise 300s.

**Symptom of a step aborting early**: the coordinator aborts the `/execute` call with

```
AbortError: The operation was aborted due to timeout
```

while mcp_host is still processing the LLM response. Raise the step's
`timeoutSeconds` (or `MCP_HOST_STEP_TIMEOUT_SECONDS`) rather than expecting a larger
buffer — the buffer is only 5s on top of the step timeout.

---

### Coordinator Token Expiry After WRC Restart

The coordinator pod uses a JWT signed by the WRC to authenticate against the REST endpoints.
This token is persisted in the Secret `wf-{recipeName}-coordinator-token` in `sandbox-recipes`.

**Problem**: when the WRC restarts (new deployment), the previous Secret still exists
(create-only semantics). A new coordinator pod will load the old Secret whose token may
be expired or signed with a different key.

**Symptom**:

```
[Coordinator] Unhandled error: Error: WRC rejected status update with 401
```

**Solution**: delete the token Secret to force its regeneration on the next reconcile:

```bash
kubectl delete secret wf-<recipeName>-coordinator-token -n sandbox-recipes --context clerum-test
kubectl delete pods -n sandbox-recipes -l clerum.io/recipe=<recipeName> --context clerum-test
# Reset the CRD status to pending to trigger the reconciler:
kubectl patch workflowrecipe <recipeName> -n sandbox-recipes --subresource=status --type=merge \
  -p '{"status":{"phase":"pending","message":"","steps":[],"workflowExecution":null}}' \
  --context clerum-test
```

---

### CRD Phase Stuck on `deploying`

After completing execution, the CRD showed `status.phase: deploying` indefinitely instead of `active`.

**Cause**: `workflowReconciler.reconcile()` always returned `phase: "deploying"` without reading the
`workflowExecution.phase` reported by the coordinator.

**Fix applied** (`workflowReconciler.ts`):

- `workflowExecution.phase === "completed"` → CRD phase `"active"`
- `workflowExecution.phase === "failed"` → CRD phase `"failed"`

**Verify**:

```bash
kubectl get workflowrecipe <recipeName> -n sandbox-recipes -o jsonpath='{.status.phase}' --context clerum-test
# Expected: "active" after successful execution, "failed" if there was an error
```

---

### `{{inputs.KEY}}` Not Substituted in Instructions

**Problem**: step instructions arrived at the coordinator with raw placeholders
(`{{inputs.topic}}` instead of the actual value) because the workflow-agentic path in the reconciler
did a `return` before executing `resolveInputs()`.

**Fix applied**: `resolveInputs()` now runs before the early return and the result
is passed to `ensureWorkflowConfigMap()` for build-time substitution.

**Verify that inputs are resolved in the ConfigMap**:

```bash
kubectl get configmap <recipeName>-workflow-config -n sandbox-recipes \
  -o jsonpath='{.data.config\.json}' --context clerum-test | python3 -m json.tool | grep instruction
# Should show the actual value, NOT "{{inputs.topic}}"
```

---

### Step Output Injection — `{{stepId:output}}` Required

**Critical rule**: `dependsOn: [stepId]` controls **execution order**, NOT data flow.
For a step to receive the output of the previous step, the CRD author must include
`{{stepId:output}}` explicitly in the instruction.

**Symptom without the placeholder**: the subsequent step says "I don't have access to previous results".

**Correct pattern**:

```yaml
steps:
  - id: research
    instruction: 'Research {{inputs.topic}}.'
  - id: summarize
    instruction: |
      Using the following research:

      {{research:output}}

      Produce a summary with key findings, timeline, and next steps.
    dependsOn: [research]
```

**The `{{stepId:output}}` placeholder is resolved at run-time** (execution loop), not in the ConfigMap.
If the referenced step does not exist or did not complete, the placeholder is preserved as literal text
and the LLM will see `{{research:output}}` in its instruction.

See also: [Workflow recipe authoring guide](../agents/CLERUM_WORKFLOW_RECIPE_GUIDE.md)

---

### Full Workflow Reset (troubleshooting)

Procedure to reset a workflow in any failed state:

```bash
RECIPE=<recipeName>
CTX=clerum-test

# 1. Delete workflow pods
kubectl delete pods -n sandbox-recipes -l clerum.io/recipe=$RECIPE --ignore-not-found=true --context $CTX

# 2. Delete NetworkPolicies (they are recreated on the next reconcile with the fixes)
kubectl delete networkpolicies -n sandbox-recipes -l clerum.io/recipe=$RECIPE --ignore-not-found=true --context $CTX
kubectl delete networkpolicies -n mcp-server -l clerum.io/recipe=$RECIPE --ignore-not-found=true --context $CTX

# 3. Delete the token Secret (forces regeneration with a fresh token)
kubectl delete secret wf-$RECIPE-coordinator-token -n sandbox-recipes --ignore-not-found=true --context $CTX

# 4. Delete the configuration ConfigMap (forces regeneration with updated instructions)
kubectl delete configmap $RECIPE-workflow-config -n sandbox-recipes --ignore-not-found=true --context $CTX

# 5. Reset the CRD status
kubectl patch workflowrecipe $RECIPE -n sandbox-recipes --subresource=status --type=merge \
  -p '{"status":{"phase":"pending","message":"","steps":[],"workflowExecution":null}}' --context $CTX

# The reconciler detects the phase change and recreates everything in ~10s
```

---

### PVC Immutability — ensure-pvcs.sh

When re-applying manifests with changes to `storageRequest`, Kubernetes returns:

```
The PersistentVolumeClaim "..." is invalid: spec.resources.requests.storage: Forbidden: field is immutable
```

**Solution**: `scripts/minikube/ensure-pvcs.sh` reconciles existing PVCs. No Makefile
target or setup script invokes it — run it yourself before `kubectl apply`:

```bash
bash scripts/minikube/ensure-pvcs.sh
```

---

### rpc-proxy-secrets — Key Rename

The key in the Secret `rpc-proxy-secrets` was renamed:

| Before           | After                      |
| ---------------- | -------------------------- |
| `JWT_PUBLIC_KEY` | `RPC_PROXY_JWT_PUBLIC_KEY` |

The Makefile (`minikube-sync-auth-key`) and `generate-keys.sh` already use the new name.
If you have an older cluster, force a regeneration (plain `make minikube-gen-keys` skips
when `control-api-secrets` already exists):

```bash
FORCE_REGEN=true make minikube-gen-keys   # regenerates, applies, and syncs the public key
make minikube-restart-all                 # restart pods so they pick up the new keys
```

---

## Quick Diagnostics

### View Status of All Services

```bash
make minikube-status
# or:
kubectl get pods -A --no-headers | awk '{print $1, $2, $3}' | column -t
```

### View Logs for a Service

```bash
make minikube-logs SVC=rpc-proxy NS=rpc-proxy
make minikube-logs SVC=chatllm NS=mcp-host
make minikube-logs SVC=control-api NS=control-plane
```

### End-to-End Auth Test From Inside the Cluster

`/v1/runtime/status` is edge-header authenticated, not bearer authenticated: it
**rejects** an `Authorization` header with 401. Reproduce what rpc-proxy sends:

```bash
kubectl exec -n mcp-host deployment/chatllm -- \
  wget -qO- \
  --header="x-clerum-edge-caller: rpc-proxy" \
  --header="x-clerum-edge-host-ref: chatllm" \
  --header="x-clerum-edge-user-id: test-user" \
  http://chatllm.mcp-host.svc.cluster.local:8080/v1/runtime/status
```

`rpc-proxy-secrets` holds only public/verification material plus the control-api
service token (`RPC_PROXY_JWT_PUBLIC_KEY`, `RPC_PROXY_CONTROL_API_SERVICE_TOKEN`).
The RPC **private** key lives in `control-api-secrets` as
`CONTROL_API_RPC_JWT_PRIVATE_KEY`; control-api uses it to sign every RPC token
(and, reusing the same keypair, gfs access tokens — `control-api/src/auth/gfsToken.ts`),
and rpc-proxy verifies them with the public half.

---

## Troubleshooting

### Login fails with 401 Unauthorized

Service tokens may not be properly applied. Run:

```bash
make minikube-setup ARGS="--skip-build"   # Re-applies kustomize overlay with correct tokens
```

### ImagePullBackOff on pods

Images are tagged `:test` locally but the cluster can't find them. Run:

```bash
make minikube-pre-gate-sync GATE=image-refresh ARGS="--force-cluster-sync"
# or:
make minikube-build-images    # Rebuilds all images in minikube's Docker daemon
make minikube-restart-all     # Restart deployments to pick up images
```

### Postgres CrashLoopBackOff (WAL corruption)

Common after cold starts. The setup script detects and auto-fixes this, but you can also run manually:

```bash
make minikube-setup ARGS="--reset-db --skip-build"
```

### JWT 401 errors after key regeneration

First try a plain re-sync — this fixes the common case where mcp-host-config drifted away
from `rpc-proxy-secrets` (for example after a manual `kubectl apply` of the ConfigMap):

```bash
make minikube-sync-auth-key   # Re-copies the public key from rpc-proxy-secrets
make minikube-restart-all     # Restart all pods to pick up the key
```

If the keys themselves must be replaced, force it — plain `make minikube-gen-keys` is a
no-op once `control-api-secrets` exists:

```bash
FORCE_REGEN=true make minikube-gen-keys   # Regenerates + applies + auto-syncs
make minikube-restart-all                 # Restart all pods to pick up new keys
```

---

## Known Issues and Solutions

| Symptom                                                      | Cause                                                                                                                           | Solution                                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `401: "Invalid token"` from chatllm                          | Only the two bearer routes (`GET /v1/runtime/sessions/search`, `POST /v1/runtime/compact`) can emit this — `requireScope` rejected the RS256 token (expired, wrong issuer, or wrong audience). The SSE poll of `/v1/runtime/status` carries no bearer token and cannot produce it. | Verify `CLERUM_AUTH_JWT_ISSUER=control-api` and `CLERUM_AUTH_JWT_AUDIENCE=rpc-proxy` in mcp-host-config, and that the public key matches. Restart chatllm. |
| `401: "Authorization is not accepted on this direct mcp-host runtime route"` | Something added an `Authorization` header to a `/v1/runtime/*` call. `controlApiRestService.ts` returns `headers: {}` on purpose | Do not forward the RPC token to mcp-host. Runtime calls must carry only the `x-clerum-edge-*` headers                                          |
| `401: "Missing runtime edge caller context"` from chatllm    | Call reached mcp-host without a valid `x-clerum-edge-caller` (must be `rpc-proxy`, `channel-reader` or `workflow-approval-request-reader`) | Call through rpc-proxy instead of hitting mcp-host directly                                                                                    |
| `401: "Invalid token"` in rpc-proxy when opening stream      | Session token expired in Desktop App                                                                                            | Close and reopen the app, do logout/login                                                                                                      |
| `403: "Forbidden: user cannot access this host"`             | hostRef does not match what is authorized in control-api, or the Host CRD does not exist                                        | Verify `kubectl get host chatllm -n mcp-host`, verify host assignment to team                                                                  |
| Pod in `ImagePullBackOff`                                    | Image not loaded in minikube                                                                                                    | `make minikube-build-images`                                                                                                                   |
| Port forward dropped after pod restart                       | Kubernetes closes the tunnel when the pod restarts                                                                              | `make minikube-pf-desktop`                                                                                                                     |
| `409 Conflict` on first setup                                | Previous data in postgres                                                                                                       | `make minikube-db-reset`                                                                                                                       |
| SSE stream closes with `"auth-expired"`                      | mcp-host rejected 3 consecutive `/v1/runtime/status` polls with 401/403. Those polls carry only `x-clerum-edge-*` headers (no bearer token), so this is an edge-guard/host-access rejection, not RPC-token expiry. | The Desktop App clears its token cache and reconnects automatically. If it repeats, check chatllm logs for `Missing runtime edge caller context` / `Runtime edge host mismatch`. |
| **Workflow** — `WRC returned 404 on GET status`              | Stale rollout, old WRC, or a legacy recipe CRD outside `sandbox-recipes`                                                        | Run the clean pre-gate sync, verify `kubectl get workflowrecipes -n sandbox-recipes`, and delete any legacy `workflowrecipes` in `mcp-server`. |
| **Workflow** — `Failed to connect to MCP servers`            | NP-01: incorrect egress label (`{workloadId}` instead of `{recipeName}-{workloadId}`) or NP-02: missing ingress in `mcp-server` | List the recipe's NPs with `kubectl get netpol -n sandbox-recipes` and `-n mcp-server`. Reset workflow.                                        |
| **Workflow** — step aborts early with `AbortError` on `/execute` | The step's own timeout elapsed. `/execute` is aborted at `timeoutSeconds * 1000 + 5000` ms (`packages/workflow-runtime-core/src/mcp-host-client/client.ts`) | Raise the step's `timeoutSeconds` (max 5400) or `MCP_HOST_STEP_TIMEOUT_SECONDS`; the buffer on top of the step timeout is only 5s.             |
| **Workflow** — step timeout at 300s (no explicit error)      | NP-03: missing egress NP for external LLM (ports 443/80)                                                                        | Reset workflow + verify NP `{name}-mcp-host-to-llm-api` exists in `sandbox-recipes`.                                                           |
| **Workflow** — `401` in coordinator when reporting status    | Coordinator JWT token expired (WRC restarted or token TTL expired)                                                              | Delete Secret `wf-{name}-coordinator-token` + pods + reset status. See "Full Workflow Reset" section.                                          |
| **Workflow** — CRD phase stuck on `deploying`                | Bug fixed in `workflowReconciler.ts`. Ensure updated WRC image.                                                                 | `kubectl rollout restart deployment/workflow-recipes -n control-plane`                                                                         |
| **Workflow** — `{{inputs.topic}}` in instruction (literal)   | The reconciler did not execute `resolveInputs()` before the early return                                                        | Updated WRC image fixes this. Delete workflow ConfigMap + reset.                                                                               |
| **Workflow** — step does not receive data from previous step | Missing `{{stepId:output}}` in the instruction (common in old templates)                                                        | Edit the step instruction in the CRD. `dependsOn` does not inject data.                                                                        |
| `field is immutable` on PVC when applying manifests          | `storageRequest` changed in manifest for existing PVC                                                                           | `bash scripts/minikube/ensure-pvcs.sh` before `kubectl apply`                                                                                  |
| `clerum-wrc-public-key not found` in coordinator logs        | Public key ConfigMap does not exist in `sandbox-recipes`                                                                        | `FORCE_REGEN=true make minikube-gen-keys` — plain `minikube-gen-keys` skips (and writes nothing) once `control-api-secrets` exists             |

---

## Regenerate JWT Keys

New RSA-4096 key pairs are generated only on a cluster that has no
`control-api-secrets` Secret yet, or when `FORCE_REGEN=true` is set. On any existing
cluster, plain `make minikube-gen-keys` (and `make minikube-apply-secrets`) deliberately
**skips** key generation to avoid invalidating every token and session:

```bash
FORCE_REGEN=true make minikube-gen-keys   # Actually regenerates, applies, and syncs
# or:
make minikube-setup ARGS="--force-keys"
```

`minikube-gen-keys` already applies the new Secrets and chains
`make minikube-sync-auth-key`. **After regenerating keys**, restart the consumers:

```bash
# Restart all pods that use the keys:
kubectl rollout restart deployment/rpc-proxy -n rpc-proxy
kubectl rollout restart deployment/chatllm -n mcp-host
kubectl rollout restart deployment/control-api -n control-plane
kubectl rollout restart deployment/external-rest-api -n profiles
```

> **Note**: you do not edit the public key by hand.
> `scripts/minikube/sync-auth-key.sh` copies `RPC_PROXY_JWT_PUBLIC_KEY` from the
> `rpc-proxy-secrets` Secret into the live `mcp-host-config` ConfigMap (as
> `CLERUM_AUTH_JWT_PUBLIC_KEY`), and it is already invoked by
> `make minikube-gen-keys` and `make minikube-deploy-all`.
