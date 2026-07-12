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
- **Node.js** 20+ (for building services and desktop app)
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

### Local Invitation Email Setup

For local invitation email, use the optional gitignored minikube kustomize env files. Real values stay out of git, while `make minikube-setup` still applies them as Kubernetes objects.

```bash
cd deploy/overlays/minikube-local-member-registration
cp member-registration-config.env.example member-registration-config.env
cp member-registration-secrets.env.example member-registration-secrets.env
```

Edit the generated files:

- `member-registration-config.env`: non-secret settings. Kustomize generates a `ConfigMap`.
- `member-registration-secrets.env`: SMTP credentials and invitation JWT secret. Kustomize generates a `Secret`.

Both generated files are gitignored. If either file exists, both must exist or setup fails early.
The project-root `.env` file is not used for member-registration invitation email config.

After editing the files, run:

```bash
make minikube-setup ARGS="--skip-build"
kubectl --context clerum-test -n profiles rollout status deployment/member-registration-service
```

When those files are present, `make minikube-setup` uses `deploy/overlays/minikube-local-member-registration` instead of the plain minikube overlay. The local overlay generates hashed ConfigMap/Secret names and patches `deployment/member-registration-service`, so changing the env files triggers a pod-template change on the next setup run.

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
make minikube-start           # 1. Start cluster
make minikube-gen-keys        # 2. Generate JWT keys + auto-sync
make minikube-apply-secrets   # 3. Apply all secrets
make minikube-build-images    # 4. Build Docker images
make minikube-deploy-all      # 5. Deploy via kustomize
```

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

> **NOTE**: `make minikube-gen-keys` now automatically syncs the JWT public key
> to mcp-host-config. You no longer need to run `make minikube-sync-auth-key` separately.

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
      → chatllm:8080  GET /v1/runtime/status  (Bearer rpc_token)  ← SAME TOKEN
          validates rpc_token  (issuer=control-api, aud=rpc-proxy)
          ← status JSON
```

### Critical Invariants

| Invariant                | Description                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Same RSA key**         | `rpc-proxy-secrets.JWT_PUBLIC_KEY` == `mcp-host-config.CLERUM_AUTH_JWT_PUBLIC_KEY` == public pair of `jwt-signing-keys.CONTROL_API_RPC_JWT_PRIVATE_KEY`                                                                   |
| **Audience passthrough** | mcp-host validates `aud: "rpc-proxy"` (NOT `"mcp-host"`). The rpc-proxy passes through the user's token; mcp-host is downstream of the proxy.                                                                             |
| **Issuer**               | All RPC tokens have `iss: "control-api"`. mcp-host must have `CLERUM_AUTH_JWT_ISSUER=control-api`                                                                                                                         |
| **Auth header**          | `rpc-proxy/src/services/controlApiRestService.ts` MUST return `headers: { authorization: \`Bearer \${rpcAccessToken}\` }`in`fetchHostConnectionFromControlApi`. Without this, mcp-host receives requests without a token. |

### Required Configuration Per Service

#### rpc-proxy-secrets (Secret, namespace: rpc-proxy)

```
RPC_PROXY_JWT_PUBLIC_KEY      = <RSA-4096 public key, pair of CONTROL_API_RPC_JWT_PRIVATE_KEY>
RPC_PROXY_JWT_ISSUER          = control-api
RPC_PROXY_JWT_AUDIENCE        = rpc-proxy
```

#### mcp-host-config (ConfigMap, namespace: mcp-host)

```
CLERUM_ENABLE_AUTH            = true
CLERUM_AUTH_JWT_ISSUER        = control-api
CLERUM_AUTH_JWT_AUDIENCE      = rpc-proxy      ← NOT "mcp-host" — passthrough of the rpc-proxy token
CLERUM_AUTH_JWT_PUBLIC_KEY    = <same public key as rpc-proxy-secrets>
```

> **Why `aud=rpc-proxy` in mcp-host?**
> The RPC token is issued by control-api with `aud: "rpc-proxy"`. The rpc-proxy validates it
> and then does a **passthrough** of the SAME token to mcp-host. If mcp-host validated
> `aud: "mcp-host"`, all requests would fail with `Invalid token`. The audience
> reflects who is the original authorized recipient of the token.

---

## SSE Stream and Token Lifecycle

The Desktop App maintains an SSE stream to rpc-proxy to receive agent status updates. The token is captured **once** when the stream is opened.

```
Desktop App opens SSE stream with token T1 (TTL=300s)
  rpc-proxy captures T1 → creates host = { url, headers: { authorization: Bearer T1 } }
  Every 3s: forwardHostStatus(host) → GET chatllm:8080/v1/runtime/status Bearer T1
    → OK for the first ~5 minutes
    → After 300s: chatllm returns 401 "Invalid token" (token expired)

  RECOVERY MECHANISM (since commit c06c6a6):
    consecutiveAuthFailures++
    After 3 consecutive 401 failures (~9s):
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
# 1. Compile TypeScript
cd rpc-proxy && npm run build

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
kubectl apply -f deploy/minikube/configmaps/mcp-host-config.yaml --context clerum-test
kubectl rollout restart deployment/chatllm -n mcp-host --context clerum-test
```

> **Important**: Pods read ConfigMaps **at startup** (via `envFrom`).
> A change in the ConfigMap is NOT automatically propagated — you must restart the pod.

---

## Port Forwards for the Desktop App

```bash
make minikube-pf-desktop
# equivalent to:
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

### Public Key ConfigMap — CRITICAL (fix 2026-03-23)

The coordinator pod reads the WRC public key from the ConfigMap `clerum-wrc-public-key`.
This ConfigMap must exist in **TWO** namespaces:

```bash
# Automatically created by make minikube-gen-keys (updated 2026-03-23)
kubectl get configmap clerum-wrc-public-key -n control-plane --context clerum-test
kubectl get configmap clerum-wrc-public-key -n sandbox-recipes --context clerum-test
```

> **Bug fixed**: before 2026-03-23 `generate-keys.sh` only created the ConfigMap in
> `control-plane`. The coordinator pod (which runs in `sandbox-recipes`) could not read the
> public key and all workflow JWTs failed with `401 Invalid token`.

### Workflow Env Vars (deploy/minikube/services/wrc/deployment.yaml)

| Variable                   | Default                            | Usage                                      |
| -------------------------- | ---------------------------------- | ------------------------------------------ |
| `CLERUM_COORDINATOR_IMAGE` | `clerum/workflow-coordinator:test` | Coordinator pod image                      |
| `CLERUM_MCP_HOST_IMAGE`    | `clerum/mcp-host:test`             | mcp_host image injected into workflows     |
| `CLERUM_WRC_SERVICE_NAME`  | `workflow-recipes`                 | Service name for coordinator DNS callbacks |

> **Bug fixed**: previously `clerum-operator` was used as the service name. The coordinator could
> not reach the WRC REST endpoint and all status updates returned `ECONNREFUSED`.

### stdio-bridge in HCC (deploy/minikube/services/hcc/deployment.yaml)

```yaml
CONTEXT_MAPPER_STDIO_BRIDGE_IMAGE: clerum/stdio-bridge:test
```

The `clerum/stdio-bridge:test` image is built with `make minikube-build-images`.

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

## WorkflowRecipe — Namespace, NetworkPolicies and Execution (bugs and fixes 2026-03-23)

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

### Workflow NetworkPolicies — 6 Required NPs

When the WRC creates a workflow, it generates **6 NetworkPolicies** (previously 4, with 2 missing):

| NP                           | Namespace         | Direction | Purpose                                                                           |
| ---------------------------- | ----------------- | --------- | --------------------------------------------------------------------------------- |
| `{name}-coord-to-mcp-host`   | `sandbox-recipes` | Egress    | Coordinator → mcp_host pod                                                        |
| `{name}-coord-to-wrc`        | `sandbox-recipes` | Egress    | Coordinator → WRC REST API                                                        |
| `{name}-wrc-to-mcp-host`     | `sandbox-recipes` | Ingress   | WRC → mcp_host (`/configure` after `/configure-model` or SDK `/injections/model`) |
| `{name}-mcp-host-to-servers` | `sandbox-recipes` | Egress    | mcp_host → MCP servers in `mcp-server`                                            |
| `{name}-wf-mcp-host-ingress` | **`mcp-server`**  | Ingress   | MCP servers accept connections from mcp_host                                      |
| `{name}-mcp-host-to-llm-api` | `sandbox-recipes` | Egress    | mcp_host → external LLM (ports 443/80)                                            |

```bash
# Verify that all 6 NPs exist:
kubectl get networkpolicies -n sandbox-recipes -l clerum.io/recipe=<recipeName> --context clerum-test
kubectl get networkpolicies -n mcp-server -l clerum.io/recipe=<recipeName> --context clerum-test
```

**Bugs fixed:**

- **NP-01**: the `mcp-host-to-servers` egress used label `{workloadId}` — now uses `{recipeName}-{workloadId}` which is the actual pod format.
- **NP-02**: the ingress NP in `mcp-server` (`wf-mcp-host-ingress`) was missing — the namespace deny-all blocked all cross-namespace traffic.
- **NP-03**: egress to ports 443/80 for the external LLM (`mcp-host-to-llm-api`) was missing — the `sandbox-recipes` deny-all blocked calls to ZAI/OpenAI and each step timed out at 300s.

**Symptom of missing NPs:**

```
[Coordinator] Failed to connect to MCP servers: web-search   ← NP-01 or NP-02
step-timeout (300s)                                           ← NP-03 (LLM unreachable)
```

---

### Coordinator HTTP Timeout — Fix

The coordinator used `FETCH_TIMEOUT_MS = 30_000` (fixed 30s) for **all** HTTP calls,
including calls to `/execute` that run LLM steps with timeouts up to 300s.

**Symptom**: the coordinator aborted the step call at 30s with:

```
AbortError: The operation was aborted due to timeout
```

even though mcp_host was still processing the LLM response.

**Fix applied** (`coordinator.ts`):

```typescript
// Dynamic timeout: step timeout + 30s buffer
const stepTimeoutMs = (body.timeoutSeconds ?? 300) * 1000 + 30_000
```

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
kubectl patch workflowrecipe <recipeName> -n mcp-server --subresource=status --type=merge \
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
kubectl get workflowrecipe <recipeName> -n mcp-server -o jsonpath='{.status.phase}' --context clerum-test
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
kubectl patch workflowrecipe $RECIPE -n mcp-server --subresource=status --type=merge \
  -p '{"status":{"phase":"pending","message":"","steps":[],"workflowExecution":null}}' --context $CTX

# The reconciler detects the phase change and recreates everything in ~10s
```

---

### PVC Immutability — ensure-pvcs.sh

When re-applying manifests with changes to `storageRequest`, Kubernetes returns:

```
The PersistentVolumeClaim "..." is invalid: spec.resources.requests.storage: Forbidden: field is immutable
```

**Solution**: `scripts/minikube/ensure-pvcs.sh` (new, 2026-03-23) runs before `kubectl apply`
and reconciles existing PVCs. The `minikube-deploy-mcp` and `minikube-deploy-profiles`
Makefile targets call it automatically.

```bash
# Manually:
bash scripts/minikube/ensure-pvcs.sh
```

---

### rpc-proxy-secrets — Key Rename

The key in the Secret `rpc-proxy-secrets` was renamed (2026-03-23):

| Before           | After                      |
| ---------------- | -------------------------- |
| `JWT_PUBLIC_KEY` | `RPC_PROXY_JWT_PUBLIC_KEY` |

The Makefile (`minikube-sync-auth-key`) and `generate-keys.sh` already use the new name.
If you have an older cluster, regenerate keys:

```bash
make minikube-gen-keys
make minikube-apply-secrets
make minikube-sync-auth-key
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

```bash
# Generate a token in control-api and verify it in chatllm:
PRIV=$(kubectl get secret rpc-proxy-secrets -n rpc-proxy \
  -o jsonpath='{.data.JWT_PRIVATE_KEY}' | base64 -d)
TOKEN=$(kubectl exec -n control-plane deployment/control-api -- \
  node -e "const jwt=require('jsonwebtoken'); \
  console.log(jwt.sign({sub:'test',typ:'user',scopes:['host:status:read'],hostRefs:['chatllm'],teamId:'t1',jti:'j1'},
  process.env.CONTROL_API_RPC_JWT_PRIVATE_KEY,{algorithm:'RS256',issuer:'control-api',audience:'rpc-proxy',expiresIn:300}))")
kubectl exec -n mcp-host deployment/chatllm -- \
  wget -qO- --header="Authorization: Bearer $TOKEN" \
  http://chatllm.mcp-host.svc.cluster.local:8080/v1/runtime/status
```

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

Run:

```bash
make minikube-gen-keys        # Regenerates + auto-syncs
make minikube-restart-all     # Restart all pods to pick up new keys
```

---

## Known Issues and Solutions

| Symptom                                                      | Cause                                                                                                                           | Solution                                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `401: "Invalid token"` from chatllm                          | Token expired in SSE stream, or incorrect audience                                                                              | Verify `CLERUM_AUTH_JWT_AUDIENCE=rpc-proxy` in mcp-host-config. Restart chatllm.                                                               |
| `401: "Missing token"` from chatllm                          | `controlApiRestService.ts` returns `headers: {}` without Bearer                                                                 | Verify the code has `headers: { authorization: \`Bearer \${rpcAccessToken}\` }`                                                                |
| `401: "Invalid token"` in rpc-proxy when opening stream      | Session token expired in Desktop App                                                                                            | Close and reopen the app, do logout/login                                                                                                      |
| `403: "Forbidden: user cannot access this host"`             | hostRef does not match what is authorized in control-api, or the Host CRD does not exist                                        | Verify `kubectl get host chatllm -n mcp-host`, verify host assignment to team                                                                  |
| Pod in `ImagePullBackOff`                                    | Image not loaded in minikube                                                                                                    | `make minikube-build-images`                                                                                                                   |
| Port forward dropped after pod restart                       | Kubernetes closes the tunnel when the pod restarts                                                                              | `make minikube-pf-desktop`                                                                                                                     |
| `409 Conflict` on first setup                                | Previous data in postgres                                                                                                       | `make minikube-db-reset`                                                                                                                       |
| SSE stream closes with `"auth-expired"`                      | Token expired (300s TTL) while the stream was open                                                                              | Normal. The Desktop App reconnects automatically with a fresh token.                                                                           |
| **Workflow** — `WRC returned 404 on GET status`              | Stale rollout, old WRC, or a legacy recipe CRD outside `sandbox-recipes`                                                        | Run the clean pre-gate sync, verify `kubectl get workflowrecipes -n sandbox-recipes`, and delete any legacy `workflowrecipes` in `mcp-server`. |
| **Workflow** — `Failed to connect to MCP servers`            | NP-01: incorrect egress label (`{workloadId}` instead of `{recipeName}-{workloadId}`) or NP-02: missing ingress in `mcp-server` | Verify 6 NPs with `kubectl get netpol -n sandbox-recipes` and `-n mcp-server`. Reset workflow.                                                 |
| **Workflow** — step timeout at 30s (`AbortError`)            | Coordinator used fixed 30s timeout on `/execute`. Fix in `coordinator.ts`                                                       | Ensure updated `clerum/workflow-coordinator:test` image is used.                                                                               |
| **Workflow** — step timeout at 300s (no explicit error)      | NP-03: missing egress NP for external LLM (ports 443/80)                                                                        | Reset workflow + verify NP `{name}-mcp-host-to-llm-api` exists in `sandbox-recipes`.                                                           |
| **Workflow** — `401` in coordinator when reporting status    | Coordinator JWT token expired (WRC restarted or token TTL expired)                                                              | Delete Secret `wf-{name}-coordinator-token` + pods + reset status. See "Full Workflow Reset" section.                                          |
| **Workflow** — CRD phase stuck on `deploying`                | Bug fixed in `workflowReconciler.ts`. Ensure updated WRC image.                                                                 | `kubectl rollout restart deployment/workflow-recipes -n control-plane`                                                                         |
| **Workflow** — `{{inputs.topic}}` in instruction (literal)   | The reconciler did not execute `resolveInputs()` before the early return                                                        | Updated WRC image fixes this. Delete workflow ConfigMap + reset.                                                                               |
| **Workflow** — step does not receive data from previous step | Missing `{{stepId:output}}` in the instruction (common in old templates)                                                        | Edit the step instruction in the CRD. `dependsOn` does not inject data.                                                                        |
| `field is immutable` on PVC when applying manifests          | `storageRequest` changed in manifest for existing PVC                                                                           | `bash scripts/minikube/ensure-pvcs.sh` before `kubectl apply`                                                                                  |
| `clerum-wrc-public-key not found` in coordinator logs        | Public key ConfigMap does not exist in `sandbox-recipes`                                                                        | `make minikube-gen-keys && make minikube-apply-secrets` (script updated 2026-03-23)                                                            |

---

## Regenerate JWT Keys

When `make minikube-gen-keys` is run, new RSA-4096 key pairs are generated.
**After regenerating keys**, you must:

```bash
make minikube-apply-secrets      # Apply the new secrets
# Update mcp-host-config with the new public key:
kubectl apply -f deploy/minikube/configmaps/mcp-host-config.yaml
# Restart all pods that use the keys:
kubectl rollout restart deployment/rpc-proxy -n rpc-proxy
kubectl rollout restart deployment/chatllm -n mcp-host
kubectl rollout restart deployment/control-api -n control-plane
kubectl rollout restart deployment/external-rest-api -n profiles
```

> **Note**: `deploy/minikube/configmaps/mcp-host-config.yaml` contains the **hardcoded** public key
> from the last run of `make minikube-gen-keys`. After regenerating keys, you must update that file
> with the new public key from the `rpc-proxy-secrets` secret.
> The script `scripts/minikube/setup.sh` does this automatically when running from scratch.
