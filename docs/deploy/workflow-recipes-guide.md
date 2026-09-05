# WorkflowRecipes — Configuration and Operations Guide

Complete guide for installing, managing, and debugging WorkflowRecipes through
Control UI and Control API. Documents the learnings from the integration session
on the `feat/testing-and-desktop-recipes` branch.

---

## What is a WorkflowRecipe

A **WorkflowRecipe** is a Kubernetes CRD (`clerum.io/v1alpha1`) that declares a
composition of workloads (Deployments, StatefulSets, Jobs, etc.) that the operator
manages as a single unit.

```yaml
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: my-recipe # RFC1123: lowercase, hyphens, digits only
  namespace: sandbox-recipes # required: admission rejects any other namespace
spec:
  workloads:
    - id: web
      type: deployment
      image: nginx:1.30.1-alpine
```

**Namespace contract**:

- `WorkflowRecipe` CRDs always live in `sandbox-recipes`.
- Runtime resources without `transport` also stay in `sandbox-recipes`.
- Workloads with HTTP/SSE/streamable HTTP `transport` render `McpServer`
  children and transport Services in `mcp-server` with `managed: false`.
  WRC owns the runtime and cleanup; HCC handles discovery/status for the
  rendered MCP surface.
- Workloads with stdio `transport` render an `McpServer` child in `mcp-server`
  with `managed: true`, because HCC owns the stdio-bridge Deployment.

---

## Feature Architecture in Control UI / Control API

```
Operator (admin)
  Control UI :3000
    → Next.js rewrite /control-api/* → control-api.control-plane.svc:8090
      → control-api (control-plane ns)
        → K8s API (via ServiceAccount control-api)
          → WorkflowRecipe CRDs in sandbox-recipes
          → rendered MCP transport children in mcp-server
```

### API Routes (control-api)

| Method   | Route                                | Description                |
| -------- | ------------------------------------ | -------------------------- |
| `GET`    | `/api/v1/admin/recipes`              | List all recipes           |
| `POST`   | `/api/v1/admin/recipes`              | Create / install a recipe  |
| `GET`    | `/api/v1/admin/recipes/:name`        | Get a recipe               |
| `PUT`    | `/api/v1/admin/recipes/:name`        | Update a recipe            |
| `DELETE` | `/api/v1/admin/recipes/:name`        | Uninstall a recipe         |
| `POST`   | `/api/v1/admin/recipes/validate`     | Validate without deploying |
| `GET`    | `/api/v1/admin/recipes/:name/status` | Deployment status          |

All routes require authentication. `POST /api/v1/admin/auth/login` (username/password)
does **not** return a token in the response body — it sets an HttpOnly session cookie
(`control_ui_admin_session`) and responds with `{ "me": { ... } }`. The admin gate
(`requireAuthForControlUI`) reads the session **only** from that cookie and ignores the
`Authorization` header, so `curl` must carry the cookie jar (`-c` on login, `-b` after).

### Proxy Next.js

The Control UI (Next.js) has rewrites configured in `next.config.js`:

```
/control-api/:path*  →  http://control-api.control-plane.svc.cluster.local:8090/:path*
```

This means the browser calls `localhost:3000/control-api/api/v1/admin/recipes`
and Next.js internally proxies it to the control-api pod. **No additional port-forward
is needed for control-api when using the UI**.

---

## RBAC — Critical Requirement

### Why it is needed

The `control-api` ServiceAccount needs permissions to create/read/update/delete
`workflowrecipes` in `sandbox-recipes` — control-api reads and writes WorkflowRecipe
CRDs only there (`RECIPE_CRD_NAMESPACE = config.sandboxNamespace`). Without this RBAC,
all API calls to the recipes endpoint return **HTTP 500** (K8s rejects with 403).

### Required Roles

#### Namespace `sandbox-recipes` — Role `control-api-workflow-recipes-sandbox`

```yaml
rules:
  - apiGroups: ['clerum.io']
    resources: ['workflowrecipes']
    verbs: ['get', 'list', 'create', 'update', 'delete']
  - apiGroups: ['']
    resources: ['secrets']
    verbs: ['get', 'list', 'create', 'update', 'patch', 'delete']
```

#### Namespace `mcp-server` — Role `control-api-mcp-resources`

Grants the rendered MCP surface only — no `workflowrecipes` here:

```yaml
rules:
  - apiGroups: ['clerum.io']
    resources: ['contexts', 'mcpservers']
    verbs: ['get', 'list', 'create', 'update', 'delete']
  - apiGroups: ['']
    resources: ['services', 'endpoints']
    verbs: ['get', 'list']
```

### Where the RBAC lives

The source files are `deploy/base/sandbox-recipes/rbac.yaml` (recipes) and
`deploy/base/mcp-server/rbac.yaml` (MCP resources). They are applied by the
kustomize overlay:

```bash
make minikube-deploy-all
```

> **Important**: RBAC fixes applied with `kubectl patch` at runtime
> are **volatile** — they do NOT survive a `make minikube-teardown`. They only persist
> in `deploy/base/`.

### Verify RBAC in the cluster

```bash
# Verify role in sandbox-recipes
kubectl get role control-api-workflow-recipes-sandbox -n sandbox-recipes \
  -o jsonpath='{.rules[0].resources}'
# Expected: ["workflowrecipes"]

# Verify role in mcp-server
kubectl get role control-api-mcp-resources -n mcp-server

# Verify RoleBindings
kubectl get rolebinding -n mcp-server | grep control-api
kubectl get rolebinding -n sandbox-recipes | grep control-api
```

### Apply RBAC without restarting the cluster

```bash
kubectl apply -f deploy/base/sandbox-recipes/rbac.yaml --context clerum-test
```

---

## Control UI Components

### "Workflow Recipes" Tab

The tab is activated from the main dashboard. Implemented in:

| File                                         | Responsibility                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `control-ui/lib/api.ts`                      | CRUD functions: `getRecipes`, `createRecipe`, `updateRecipe`, `deleteRecipe`, `validateRecipeServer`, `getRecipeStatus` |
| `control-ui/lib/recipeValidator.ts`          | Client-side validation in 3 phases (before calling the API)                                                             |
| `control-ui/components/RecipesTab.tsx`       | Recipes table with per-row actions                                                                                      |
| `control-ui/components/RecipeEditor.tsx`     | JSON/YAML editor with 4-step flow                                                                                       |
| `control-ui/components/RecipeDefaultsPanel/` | Operator Defaults panel (security, storage, resources)                                                                  |
| `control-ui/components/RecipeStatusContent/` | Deployment status modal content                                                                                         |

### Installation flow in the editor (4 steps)

```
1. INPUT     → The admin writes/pastes the recipe JSON in the textarea
2. VALIDATE  → Client-side validation (3 phases) + "Validate" button
               - Phase 1: Valid JSON parsing
               - Phase 2: Schema (apiVersion, kind, metadata.name RFC1123, workloads[])
               - Phase 3: Security compliance (runAsUser >= 1, capabilities in allowlist)
3. DEFAULTS  → "Apply Operator Defaults" button (optional)
               `applyDefaults()` (control-ui/lib/recipeDefaults.ts) applies
               exactly three rules and nothing else:
               - Workloads with no `resources` get default CPU/memory
                 requests+limits
               - A bare image name (no `/`) gets the registry prefix
                 prepended — e.g. `nginx:1.30.1-alpine` becomes
                 `us-central1-docker.pkg.dev/${GCP_PROJECT}/clerum/nginx:1.30.1-alpine`
               - `volumeClaimTemplates` with no `storageClass` get the
                 default storage class
               It does NOT set a namespace and does NOT add imagePullSecrets.
               Security is validated, never auto-injected.
4. CONFIRM   → "Deploy Recipe" button → POST /api/v1/admin/recipes
               Editor closes and table refreshes
```

### Per-row actions in the table

| Button        | Action                                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**    | Opens modal showing the current recipe phase (`pending`, `deploying`, `active`, `degraded`, `failed`, … — the 13-state lowercase `status.phase` enum) |
| **Edit**      | Opens the editor pre-loaded with the recipe's current JSON                                                                                            |
| **Uninstall** | `window.confirm` → DELETE recipe from the cluster                                                                                                     |

---

## Install a WorkflowRecipe from Control UI

### Prerequisites

```bash
make minikube-pf-control-ui   # port-forward :3000
# or
make minikube-pf-all          # all port-forwards
```

### Steps

1. Open `http://localhost:3000` → log in with admin credentials
2. In the dashboard, click on the **"Workflow Recipes"** tab
3. Click **"+ Install Recipe"**
4. In the editor, paste the recipe JSON (minimal example):

```json
{
  "apiVersion": "clerum.io/v1alpha1",
  "kind": "WorkflowRecipe",
  "metadata": { "name": "my-nginx" },
  "spec": {
    "workloads": [{ "id": "web", "type": "deployment", "image": "nginx:1.30.1-alpine" }]
  }
}
```

5. Click **"Validate"** → wait for "Validation passed"
6. Click **"Deploy Recipe"**
7. The editor closes and the recipe appears in the table

> **Do not click "Apply Operator Defaults" on this example in minikube.**
> `nginx:1.30.1-alpine` has no `/`, so the registry rule rewrites it to
> `us-central1-docker.pkg.dev/${GCP_PROJECT}/clerum/nginx:1.30.1-alpine`, which
> minikube cannot pull (`ImagePullBackOff`). The button is safe for images that
> already carry a registry/repo path.

---

## Install a WorkflowRecipe from the API (direct)

```bash
# Login stores the HttpOnly session cookie in a cookie jar.
curl -s -c /tmp/clerum-admin.jar -X POST http://localhost:8090/api/v1/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<password>"}' | jq .

curl -s -b /tmp/clerum-admin.jar -X POST http://localhost:8090/api/v1/admin/recipes \
  -H "Content-Type: application/json" \
  -d '{
    "metadata": {"name": "my-nginx"},
    "spec": {
      "workloads": [{"id": "web", "type": "deployment", "image": "nginx:1.30.1-alpine"}]
    }
  }' | jq .
```

### Verify that the recipe was created in K8s

```bash
kubectl get workflowrecipes -n sandbox-recipes
kubectl describe workflowrecipe my-nginx -n sandbox-recipes
```

---

## Uninstall a WorkflowRecipe

### From Control UI

In the table, click **"Uninstall"** → confirm the dialog.

### From the API

```bash
curl -s -b /tmp/clerum-admin.jar -X DELETE http://localhost:8090/api/v1/admin/recipes/my-nginx | jq .
```

### From kubectl

```bash
kubectl delete workflowrecipe my-nginx -n sandbox-recipes
```

> **Note on finalizers**: The DELETE via API returns `200` immediately, but
> the `WorkflowRecipe` may persist for a few seconds while WRC processes the
> finalizer. A GET immediately after may still return the object. Wait ~2-5s to
> confirm deletion with `kubectl get workflowrecipes -n sandbox-recipes`.
> Rendered transport resources in `mcp-server` are cleaned by WRC finalization.

---

## Reconcile idempotency & drift behavior

WRC reconciles every recipe on a periodic resync. Deployments, StatefulSets, headless
Services, CronJobs, Jobs, DaemonSets and the McpServer CRD use the existing
**spec-hash idempotency gate**. The recipe-derived NetworkPolicies (`ui-ingress-*`,
`wl-ingress-*`, `wl-egress-*`, `wr-intdep-*`, `wf-*-oauth-broker-egress` and the three
webhook-gateway policies) use a stronger **live convergence check** instead: WRC reads
the current object, validates ownership/lifecycle, normalizes Kubernetes defaults and
skips the write only when the live enforcement plus WRC-authored metadata equal the
desired policy. A legacy `clerum.io/spec-hash` annotation is ignored for this decision;
it cannot hide later drift.

**What this path does _not_ cover.** Do not read the list above as "every policy writer":

- `ui-egress-*` and the `coordinator-to-gfs` policy keep their existing dedicated
  comparisons (#299 and #579 respectively); they do not use the recipe NetworkPolicy
  helper.
- `wl-egress-*` still uses the #299 content/renewal prefilter before the live convergence
  helper. External/mixed egress carries temporal resolution state; a cluster-local-only
  policy does not. In both cases, once the prefilter requires a write, the downstream
  helper rechecks the live spec and cannot cancel a real repair because of a stale seal.
- The **webhook gateway's own** ConfigMap, Deployment and Service remain ungated and are
  rewritten on every pass — only its three NetworkPolicies use live convergence.

**Operational consequences:**

- **Logs:** the live-convergence helper and the `wl-egress-*` prefilter use the structured
  WRC logger. In steady state expect `network policy unchanged; skipping update` or
  `network policy egress set unchanged; skipping live apply` with `policy`, `namespace`
  and `family` fields. Re-baseline alerts keyed on the old `Updated …` console line.
  `recipe reconciliation completed` records recipe UID, generation, outcome and retry
  delay only after the reconciliation result is ready; entering a reconcile is not its
  completion signal.
- **NetworkPolicy drift is auto-reverted.** A live change to `podSelector`,
  `policyTypes`, `ingress`, `egress`, WRC-authored metadata or the gateway controller
  owner forces one optimistic-concurrency replace using the `resourceVersion` from the
  same validated read on the next parent recipe reconcile. NetworkPolicy-only changes do
  not emit a WorkflowRecipe event. The following reconcile is read-only.
- **Retryable races schedule their own recovery.** A terminating object, create conflict
  whose winner disappears, missing live `resourceVersion`, replace 404/409 or transient
  API failure re-enqueues the parent with bounded backoff. A status-only update is not
  treated as the retry trigger.
- **Metadata ownership applies to writes too.** Replacing a policy preserves external
  labels, annotations and finalizers from the validated snapshot. Desired WRC keys win;
  retired egress state and the legacy spec-hash are removed. Additional foreign lifecycle
  owners are rejected, not silently dropped or adopted. The workload-egress pre-read uses
  the same transient-error classification as the downstream apply path.
- **Other spec-hash-managed objects retain their existing drift contract.** For example,
  a manually scaled recipe Deployment is not reverted until the desired manifest changes;
  its replica-health drift remains visible in recipe status.
- `deploy/scripts/verify-networkpolicies.sh` still covers only overlay-rendered policies.
  Recipe-derived policy integrity is owned by the runtime reconciliation described here.
- **First deploy after this change** does not require a NetworkPolicy stamping wave.
  Equivalent policies are one GET and zero writes; real spec/metadata/owner drift is
  repaired once.

## Automated Tests

### WRC NetworkPolicy live-convergence E2E

NetworkPolicy changes must run the aggregate gate against an isolated development
cluster with an explicit context. Its Make target acquires the existing profile mutation
lease; individual suites require that same inherited lease:

```bash
E2E_KUBECONTEXT=<branch-owned-context> \
  make test-e2e-wrc-networkpolicy-live-convergence
```

The aggregate fails unless all four executable suites run. Together they cover every
NetworkPolicy family routed through the live-convergence helper:

- `ui-ingress`, `workload-ingress` and `workload-egress`: correctly configured UI→API
  and API→sibling traffic, isolated ingress and undeclared-sibling egress controls,
  forced live-spec drift, a real
  parent recipe reconcile, repair, a terminating-policy race that self-heals through the
  scheduled retry without a second parent event, and a post-repair no-op witness plus
  pre-trigger UID/resourceVersion baseline and full observation window;
- `internal-dependency`: inferred source→backend traffic, an unlabelled denied pod,
  two-sided policy repair and no-churn;
- `oauth-broker-egress`: opted-in workload→Control API reachability, an unlabelled
  denied workload, drift repair and no-churn;
- `webhook-gateway`: all three policies, a signed public webhook business signal,
  spec drift, stale/missing owner repair, route recovery and no-churn.

Negative controls first prove reachability from the same probe with a narrow temporary
permission, remove only that permission, observe a remotely executed connection timeout,
and prove reachability again. Complementary permissions isolate ingress from egress.
An exec, authorization, missing-tool or malformed-response error fails the test instead
of counting as a policy denial. Silent failures and read timeouts after a connection
opens are also errors; only a connection-timeout diagnostic counts as denial.
Condition-based polling accommodates CNI propagation.

Every no-churn observation begins before the parent trigger. It requires the exact
UID/generation completion receipt, every policy/family no-op witness, unchanged policy
UID/resourceVersion, stable controller replica/container identities, and no observed
policy write during the entire window. A no-op followed by a write fails even when the
resourceVersion does not change. Exact API-call counts are asserted separately in unit
tests; the runtime logs are not a substitute for exhaustive Kubernetes audit accounting.

Fixtures use unique run IDs, collision-safe creation, UID-preconditioned deletion and
owned dynamic port-forwards. Generated children are enrolled only while the same owned
parent UID is verified before and after discovery; parent absence permits cleanup of
previously recorded child UIDs only. A failed parent deletion stops child cleanup.
Cleanup never enrolls an existing sample by name, and a
cleanup failure fails the suite. `E2E_KEEP_RESOURCES=1` explicitly retains run
resources for inspection, while still stopping owned port-forwards.

The public CI runner cannot provide this Calico-backed cluster. It runs
`make test-wrc-networkpolicy-contracts`: the actual aggregate against instrumented child
processes, every child failure/missing-child case, helper fault injection, and fixture
ownership/cleanup tests. Skipping the child invocation or swallowing a child error fails
this contract. The real dataplane result remains a separate local T2/pre-merge evidence
lane. Missing prerequisites, incomplete observations and zero execution are failures.

### Unit tests (vitest + @testing-library/react)

```bash
cd control-ui
npm test                       # whole control-ui suite

# Recipe-only slice:
npm test -- recipeValidator RecipesTab RecipeEditor RecipeDefaultsPanel RecipeStatusContent
```

Recipe unit tests live in `control-ui/lib/__tests__/recipeValidator.test.ts` and
`control-ui/components/__tests__/Recipe*.test.tsx`.

### Playwright E2E (currently BLOCKED — does not run)

> **The recipes Playwright suite cannot execute today.** `globalSetup`
> (`tests/e2e/playwright/global-setup.ts`) posts to `/api/v1/admin/auth/login`
> and then throws `Admin login response missing token field` unless the response
> body carries a `token`. The login route
> (`control-api/src/routes/admin/auth.ts`) returns only `{ "me": { ... } }` and
> sets the session as an HttpOnly cookie — it has never returned a `token` key.
> Global setup therefore fails before any test starts, and the `authedPage`
> fixture additionally depends on the `.auth/admin-token.json` that setup never
> writes. **This needs a code fix in the test harness (cookie-based session
> instead of a bearer token), not a doc change.** The command below is recorded
> for when that lands:

```bash
cd tests/e2e/playwright
CONTROL_API_URL=http://localhost:8090 \
npx playwright test control-ui/recipes.spec.ts --reporter=line
```

Once fixed, `global-setup.ts` is meant to perform the admin login itself
(`TEST_ADMIN_USERNAME` / `TEST_ADMIN_PASSWORD`, defaulting to the minikube
bootstrap admin) — no admin token is passed on the command line.

**Test groups as written in the spec file** (none of them currently execute) (`tests/e2e/playwright/control-ui/recipes.spec.ts`, 24 tests in 4
`describe` blocks):

| Group                  | Tests | Deploys real recipes             |
| ---------------------- | ----- | -------------------------------- |
| Navigation             | 4     | No                               |
| Editor UI              | 11    | No (client-side validation only) |
| Install and uninstall  | 5     | Yes                              |
| Status modal structure | 4     | Yes                              |

**Lifecycle test idempotency**: The cluster-touching groups use `beforeAll`/`afterAll`
to delete their recipes (`e2e-pw-recipe`, `e2e-pw-snippet-secret-ref`,
`e2e-pw-status-modal`) before and after each run. This prevents `409 Conflict`
errors when a test crashes mid-cycle.

---

## Known Issues and Solutions

| Symptom                                | Cause                                                                         | Solution                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `POST /api/v1/admin/recipes → 500`     | Missing RBAC in K8s                                                           | `kubectl apply -f deploy/base/sandbox-recipes/rbac.yaml`         |
| `409 Conflict` when creating recipe    | A recipe with that name already exists (possible orphan from a previous test) | `kubectl delete workflowrecipe <name> -n sandbox-recipes`        |
| Recipe appears in API but not in table | The tab did not refresh                                                       | Click the "Refresh" button                                       |
| Lifecycle tests always skip            | `locator.isVisible({timeout})` in Playwright is instant, does not wait        | Use `locator.waitFor({state:"visible", timeout})` with try/catch |
| Recipe created but pods do not start   | Namespace `sandbox-recipes` does not exist                                    | `make minikube-apply-namespaces`                                 |
| `403 Forbidden` when listing recipes   | Incorrect RBAC or wrong ServiceAccount                                        | Verify binding points to SA `control-api` in ns `control-plane`  |
| `esbuild "react-jsx" error` in vitest  | esbuild uses `"automatic"` not `"react-jsx"`                                  | Change `vitest.config.ts`: `jsx: "automatic"`                    |

---

## Quick Diagnostics for WorkflowRecipes

```bash
# List all recipes in the cluster
kubectl get workflowrecipes -A

# View the status of a specific recipe
kubectl describe workflowrecipe <name> -n sandbox-recipes

# View operator (WRC) logs to understand reconciliation errors
make minikube-logs SVC=workflow-recipes NS=control-plane

# Direct API test (with active port-forward + the cookie jar from admin login)
curl -s -b /tmp/clerum-admin.jar http://localhost:8090/api/v1/admin/recipes \
  | jq '.items[].metadata.name'

# Verify that the sandbox-recipes namespace exists
kubectl get namespace sandbox-recipes
```

---

## Feature Status

| Component                                                                    | Status                                                                                  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| control-api routes CRUD + validate + status                                  | ✅ Complete                                                                             |
| control-ui tab "Workflow Recipes"                                            | ✅ Complete                                                                             |
| RBAC persisted in `deploy/base/sandbox-recipes/rbac.yaml`                    | ✅ Complete                                                                             |
| Unit tests (vitest, `control-ui`)                                            | ✅ Complete                                                                             |
| Playwright E2E (`tests/e2e/playwright/control-ui/recipes.spec.ts`, 24 tests) | ⛔ Blocked — `globalSetup` throws on the missing `token` field; 0 tests run (see above) |
| Install recipe from UI → appears in K8s                                      | ✅ Verified                                                                             |
| View recipe status from UI                                                   | ✅ Verified                                                                             |
| Edit and update recipe from UI                                               | ✅ Verified                                                                             |
| Uninstall recipe from UI with confirmation                                   | ✅ Verified                                                                             |
| Cancel uninstall (dialog dismiss)                                            | ✅ Verified                                                                             |

---

## Two-Pod Workflow — Cluster Validation Findings

Architectural adjustments discovered during validation of the **Two-Pod
Workflow** model (coordinator + mcp_host) on a real minikube cluster.

### Executive Summary

Several behaviors diverged from the original Two-Pod Workflow plan. The adjustments
are driven by concrete Kubernetes constraints and are documented here to prevent
future regressions.

**Integration result**: The full workflow lifecycle works end-to-end:
`Create → Reconcile → WorkflowRecipe in sandbox-recipes → Status patch in sandbox-recipes → Terminal phase`.
When a recipe declares a transport workload, WRC additionally renders the MCP
transport children in `mcp-server`.

The integration test `tests/e2e/integration/workflow-lifecycle.test.ts` validates
**10/10 checks**, including Pod creation, env var injection, and transition to a
terminal phase.

### Bug 1 — K8s GC deletes resources with cross-namespace ownerRef (CRITICAL)

#### Original plan

The plan specified:

> "Secret TTL: Coordinator token Secret has `ownerRef` to coordinator Pod
> (auto-GC on Pod delete) + 24h expiry matching JWT"

Implicitly, `podFactory.ts`, `secretFactory.ts`, and `networkPolicyFactory.ts`
included `ownerReferences` pointing at the `WorkflowRecipe` CRD to leverage the
Kubernetes Garbage Collector.

#### Problem discovered

**K8s 1.24+ forbids cross-namespace ownerRefs and the GC deletes the child
resource immediately.**

The GC emits the `OwnerRefInvalidNamespace` event and wipes the child resource
within seconds:

```
LAST SEEN  TYPE     REASON                     OBJECT
2s         Warning  OwnerRefInvalidNamespace   pod/wf-smoke-coordinator
2s         Warning  OwnerRefInvalidNamespace   secret/wf-smoke-coordinator-token
2s         Warning  OwnerRefInvalidNamespace   networkpolicy/smoke-coord-to-mcp-host
```

**Namespace layout** (the root of the conflict):

- `WorkflowRecipe` CRD → namespace `sandbox-recipes`
- Coordinator Pod → namespace `sandbox-recipes`
- mcp_host Pod → namespace `sandbox-recipes`
- coordinator-token Secret → namespace `sandbox-recipes`
- NetworkPolicies (×4) → namespace `sandbox-recipes`
- ConfigMaps (SOUL.md, workflow-config) → namespace `sandbox-recipes`
- Headless Service (wf-{name}-mcp-host) → namespace `sandbox-recipes`

K8s requires the owner and the owned to be in the **same namespace**. The K8s
1.24+ GC detects the violation and deletes the child resources regardless of
their contents.

#### Adjustment applied

**All ownerReferences were removed** from workflow resources in `sandbox-recipes`.
Cleanup is now the **exclusive responsibility of the WRC finalizer** via
`reconcileDelete()`.

Files modified:

- `workflow-recipes/src/workflow/podFactory.ts` — 3 builders (coordinator Pod, mcp_host Pod, Service)
- `workflow-recipes/src/workflow/secretFactory.ts` — coordinator-token Secret
- `workflow-recipes/src/workflow/networkPolicyFactory.ts` — 4 NetworkPolicies
- `workflow-recipes/src/workflow/workflowReconciler.ts` — callers without `recipeUid`

**Adjusted security invariant**:

| Before (plan)                                | After (implementation)                                 |
| -------------------------------------------- | ------------------------------------------------------ |
| ownerRef → auto-GC on WorkflowRecipe delete  | WRC finalizer `reconcileDelete()` cleans up explicitly |
| ownerRef → auto-GC on coordinator Pod delete | No automatic GC — WRC decides when to clean up         |
| Implicit Secret TTL via GC                   | Explicit TTL via 24h JWT (sufficient)                  |

The resulting cleanup mechanism is **more correct** than cross-namespace ownerRefs:
explicit cleanup gives observability (logs, K8s events) and error control that
silent GC does not provide.

### Bug 2 — Wrong namespace in `createWorkflowEndpointHandlers`

#### Original plan

The plan did not explicitly specify the namespace split inside the WRC REST
handler. The initial implementation passed `sandboxNamespace` (`"sandbox-recipes"`)
as the single namespace to `createWorkflowEndpointHandlers`.

#### Problem discovered

`createWorkflowEndpointHandlers` must not infer the WorkflowRecipe namespace from
the WRC pod namespace. WorkflowRecipe CRDs live in `sandbox-recipes`; rendered
MCP transport resources live in `mcp-server`.

| Operation                                        | Correct namespace | Source                       |
| ------------------------------------------------ | ----------------- | ---------------------------- |
| `getRecipe` (read CRD)                           | `sandbox-recipes` | JWT `recipeNamespace` claim  |
| `patchNamespacedCustomObjectStatus` (update CRD) | `sandbox-recipes` | JWT `recipeNamespace` claim  |
| mcp_host DNS endpoint                            | `sandbox-recipes` | configured sandbox namespace |

The coordinator tried `GET /api/v1/workflow/{name}/status` → WRC → K8s API
looked for the CRD in the wrong namespace (the configured MCP transport child
namespace `mcp-server`, not `sandbox-recipes`) → 404 → coordinator failed with
`WRC returned 404 on GET status`.

#### Adjustment applied

The signature of `createWorkflowEndpointHandlers` now takes only the sandbox
namespace. The recipe namespace comes from the verified JWT claim that WRC minted
for the coordinator.

```typescript
// Before:
createWorkflowEndpointHandlers(customApi, recipeNamespace, sandboxNamespace)

// After:
createWorkflowEndpointHandlers(customApi, sandboxNamespace)
// sandboxNamespace = "sandbox-recipes"
// claims.recipeNamespace = "sandbox-recipes"
// WRC's MCP transport child namespace ("mcp-server") is not part of the REST
// handler contract — and neither is WRC's own pod namespace ("control-plane")
```

And in `server.ts`:

```typescript
// Before (bug):
createWorkflowEndpointHandlers(this.customApi, this.namespace, this.sandboxNamespace)

// After (correct):
createWorkflowEndpointHandlers(this.customApi, this.sandboxNamespace)
```

**Rule to remember**: Every operation against the `WorkflowRecipe` CRD
(`getNamespacedCustomObject`, `patchNamespacedCustomObjectStatus`) must use the
verified `claims.recipeNamespace`, which must be `sandbox-recipes` for current
WorkflowRecipe CRDs. The WRC pod namespace is unrelated to CRD status reads and
patches.

### Bug 3 — WRC DNS hardcoded as `clerum-operator`

#### Original plan

The plan did not explicitly specify the K8s Service name for the WRC. The
implementation inherited the name `clerum-operator` from an older version of
the service.

#### Problem discovered

The Coordinator Pod built the WRC URL as:

```
http://clerum-operator.control-plane.svc.cluster.local:8082
```

But the WRC K8s Service in minikube is called `workflow-recipes`:

```
http://workflow-recipes.control-plane.svc.cluster.local:8082
```

The coordinator failed with
`ENOTFOUND clerum-operator.control-plane.svc.cluster.local`.

#### Adjustment applied

In `workflow-recipes/src/reconciler/workflowRecipeReconciler.ts`:

```typescript
// Before:
wrcEndpoint: `http://clerum-operator.control-plane.svc.cluster.local:${port}`

// After:
wrcEndpoint: `http://${process.env.CLERUM_WRC_SERVICE_NAME ?? 'workflow-recipes'}.control-plane.svc.cluster.local:${port}`
```

The `CLERUM_WRC_SERVICE_NAME` env var allows override without rebuild if the
Service name changes in a different environment.

### Bug 4 — Wrong JWT env vars in mcp_host Pod

#### Original plan

The plan stated the mcp_host had to receive the WRC public key to verify JWT
tokens. The initial implementation used `CLERUM_JWT_PUBLIC_KEY`.

#### Problem discovered

mcp_host started with FATAL:

```
FATAL: CLERUM_AUTH_JWT_PUBLIC_KEY is not set — set it to the RS256 public key PEM
```

Three problems in the mcp_host Pod env:

1. Wrong variable: `CLERUM_JWT_PUBLIC_KEY` → must be `CLERUM_AUTH_JWT_PUBLIC_KEY`
2. Missing `CLERUM_AUTH_JWT_ISSUER=clerum-wrc` (mcp_host validates the issuer)
3. Missing `WRC_PUBLIC_KEY_PEM` (used by `workflowRouter.ts` to verify WRC tokens)

#### Adjustment applied

In `workflow-recipes/src/workflow/podFactory.ts`, mcp_host Pod env vars fixed:

```typescript
// Before (incorrect):
{ name: "CLERUM_JWT_PUBLIC_KEY", valueFrom: { configMapKeyRef: { name: "clerum-wrc-public-key", key: "public.pem" } } }

// After (correct):
{ name: "CLERUM_AUTH_JWT_PUBLIC_KEY", valueFrom: { configMapKeyRef: { name: "clerum-wrc-public-key", key: "public.pem" } } },
{ name: "CLERUM_AUTH_JWT_ISSUER",     value: "clerum-wrc" },
{ name: "CLERUM_AUTH_JWT_AUDIENCE",   value: "mcp-host" },
{ name: "WRC_PUBLIC_KEY_PEM",         valueFrom: { configMapKeyRef: { name: "clerum-wrc-public-key", key: "public.pem" } } },
```

**mcp_host JWT env var map in workflow mode**:

| Variable                     | Value                     | Middleware                       |
| ---------------------------- | ------------------------- | -------------------------------- |
| `CLERUM_AUTH_JWT_PUBLIC_KEY` | WRC public key PEM        | `authMiddleware.ts`              |
| `CLERUM_AUTH_JWT_ISSUER`     | `clerum-wrc`              | `authMiddleware.ts`              |
| `CLERUM_AUTH_JWT_AUDIENCE`   | `mcp-host`                | `authMiddleware.ts`              |
| `WRC_PUBLIC_KEY_PEM`         | WRC public key PEM        | `workflowRouter.ts`              |
| `CLERUM_WORKFLOW_ENABLED`    | `true`                    | `main.ts` (workflow-mode branch) |
| `CLERUM_WORKFLOW_RECIPE`     | `{recipeName}`            | `workflowRouter.ts`              |
| `CLERUM_CONTEXT_REF`         | `wf-{recipeName}`         | HCC Context isolation            |
| `CLERUM_MODEL_PROVIDER`      | `"zai"`, `"openai"`, etc. | LLM provider                     |
| `CLERUM_MODEL`               | `"glm-4.7"`, etc.         | LLM model                        |

> **Note**: `CLERUM_AUTH_JWT_AUDIENCE=mcp-host` in workflow mode (not `rpc-proxy`).
> In standalone mode the audience is `rpc-proxy` because the token arrives from
> the Desktop App via rpc-proxy. In workflow mode the token arrives directly
> from the Coordinator or the WRC, and the audience declared in the JWT is
> `mcp-host`.

### Resulting architecture vs. original plan

#### Cleanup mechanism comparison

| Aspect                | Plan                    | Current implementation            |
| --------------------- | ----------------------- | --------------------------------- |
| Pod cleanup           | ownerRef → automatic GC | WRC finalizer `reconcileDelete()` |
| Secret cleanup        | ownerRef → automatic GC | WRC finalizer `reconcileDelete()` |
| NetworkPolicy cleanup | ownerRef → automatic GC | WRC finalizer `reconcileDelete()` |
| Token TTL             | ownerRef + 24h JWT      | 24h JWT (sufficient)              |
| Cleanup observability | None (silent GC)        | WRC logs + K8s events             |

#### Namespace routing comparison

| Operation               | Plan (implicit)             | Current implementation                 |
| ----------------------- | --------------------------- | -------------------------------------- |
| Read WorkflowRecipe CRD | single namespace            | `recipeNamespace` = `sandbox-recipes`  |
| PATCH CRD status        | single namespace            | `recipeNamespace` = `sandbox-recipes`  |
| mcp_host Service DNS    | single namespace            | `sandboxNamespace` = `sandbox-recipes` |
| WRC endpoint DNS        | `clerum-operator` hardcoded | `CLERUM_WRC_SERVICE_NAME` env var      |

#### Runtime namespace diagram

```
sandbox-recipes namespace
  └── WorkflowRecipe CRD (wf-integration-smoke)
        ↑ PATCH status (via WRC REST handler with recipeNamespace)
        └── Watched by WRC reconciler (control-plane)

  ├── Pod: wf-smoke-coordinator    (restartPolicy: Never)
  ├── Pod: wf-smoke-mcp-host       (restartPolicy: Never)
  ├── Secret: wf-smoke-coordinator-token  (2 keys: mcp-host-token, wrc-token)
  ├── ConfigMap: smoke-workflow-config    (steps, agent spec)
  ├── ConfigMap: wf-smoke-soul-md         (SOUL.md content)
  ├── Service: wf-smoke-mcp-host          (clusterIP: None, headless)
  └── NetworkPolicies (×4):
        ├── smoke-coord-to-mcp-host       (coordinator → mcp_host egress)
        ├── smoke-coord-to-wrc            (coordinator → WRC egress, cross-ns)
        ├── smoke-wrc-to-mcp-host         (WRC → mcp_host ingress, cross-ns)
        └── smoke-mcp-host-to-servers     (mcp_host → MCP servers egress)

mcp-server namespace
  └── Optional rendered McpServer + transport Service for workloads that declare transport

control-plane namespace
  ├── Deployment: workflow-recipes  (WRC)
  ├── ConfigMap: clerum-wrc-public-key   (public.pem for JWT verification)
  └── Secret: clerum-wrc-signing-key    (private.pem for signing JWTs)
```

### Integration test result

The `tests/e2e/integration/workflow-lifecycle.test.ts` test validates the full
lifecycle with **10/10 checks passing**:

```
✓ control-api is reachable
✓ admin login succeeds
✓ WRC is running in control-plane
✓ creates WorkflowRecipe with two steps — default model zai/glm-4.7
✓ WRC creates coordinator Pod in sandbox-recipes within 60s
✓ WRC creates mcp_host Pod in sandbox-recipes within 60s
✓ mcp_host Pod env has CLERUM_WORKFLOW_ENABLED=true
✓ WorkflowRecipe reaches terminal phase (completed or failed) within 5 minutes
✓ coordinator Pod reached terminal state (Succeeded or Failed)
✓ WorkflowRecipe CRD has workflowExecution.phase after workflow runs
```

**Observed terminal phase**: `failed`

The `failed` phase is **expected** with the placeholder ZAI API key in minikube.
The test accepts both `completed` and `failed` as terminal states — what matters
is that the workflow **ran and reached a terminal phase**, not that it completed
successfully. Running with a real API key will produce `completed`.

To get `completed` in local development:

1. Provide a real ZAI API key in `deploy/overlays/minikube/secrets/llm-api-keys.yaml`
2. Run `make minikube-apply-secrets && kubectl -n control-plane rollout restart deployment/workflow-recipes`
3. Re-run the integration test

### New testing files

#### Integration tests (`tests/e2e/integration/`)

| File                              | Tests | Status         |
| --------------------------------- | ----- | -------------- |
| `workflow-lifecycle.test.ts`      | 10    | ✓ PASS         |
| `control-api-k8s.test.ts`         | ~10   | Skeleton       |
| `profiles-chain.test.ts`          | ~12   | Skeleton       |
| `mcp-proxy-routing.test.ts`       | ~6    | Skeleton       |
| `channel-reader-mcp-host.test.ts` | ~8    | Skeleton       |
| `contracts.test.ts`               | ~15   | Skeleton       |
| `helpers.integration.ts`          | —     | Shared helpers |

#### channel-reader tests (`channel-reader/test/`)

| File                        | Tests | Covers                                 |
| --------------------------- | ----- | -------------------------------------- |
| `config.test.ts`            | ~15   | Config parsing, dev mode, env defaults |
| `main.test.ts`              | ~12   | Polling loop, graceful shutdown        |
| `rpcClient.test.ts`         | ~10   | RPC client, approval/denial, reconnect |
| `channels/telegram.test.ts` | ~12   | Grammy Bot mock                        |
| `channels/email.test.ts`    | ~10   | ImapFlow mock                          |
| `channels/slack.test.ts`    | ~8    | @slack/web-api mock                    |

#### Coordinator (`workflow-recipes/src/coordinator.ts`, `Dockerfile.coordinator`)

The coordinator is the platform Pod that WRC deploys in `sandbox-recipes`. It
implements:

- Step execution loop ordered by dependencies
- WRC REST communication (`/status`, `/injections/model`; `/configure-model`
  remains a privileged compatibility route)
- mcp_host communication (`/execute`, `/configure`)
- Health server on `:8090` (Pod liveness probe)

Image: `clerum/workflow-coordinator:test` (build from
`workflow-recipes/Dockerfile.coordinator`).

#### Model Injection Scopes

`/configure-model` is the privileged platform coordinator compatibility path.
It requires the `configure_model` scope and is unavailable to custom coordinator
images.

Current SDK runtimes, including custom coordinator images, use
`/api/v1/workflow/{name}/injections/model`. That route requires
`model_injection_request`, validates `stepId/provider/model` against the
declared `WorkflowRecipe`, and then WRC brokers the provider secret to the child
`mcp_host`. The custom coordinator never receives provider secrets and still
cannot call `/configure-model` or `/trigger`. Snippet workflows remain the
platform-owned runtime path; custom coordinator images add third-party custom
code while keeping model/provider injection brokered by WRC.

### Prerequisites for running the workflow in minikube

```bash
# 1. ConfigMap with the WRC public key (for JWT verification in mcp_host)
kubectl -n control-plane get configmap clerum-wrc-public-key

# 2. Secret with the WRC private key (for signing coordinator + mcp_host JWTs)
kubectl -n control-plane get secret clerum-wrc-signing-key

# 3. WRC deployment updated with workflow env vars
kubectl -n control-plane get deployment workflow-recipes -o yaml | grep -A5 CLERUM_WRC

# 4. Coordinator image available in minikube
minikube -p clerum-test image ls | grep workflow-coordinator

# 5. sandbox-recipes namespace with base deny-all NetworkPolicy
kubectl -n sandbox-recipes get networkpolicies
```

**Full setup**:

```bash
make minikube-gen-keys          # Generate RSA-4096 keys (WRC signing + JWT)
make minikube-apply-secrets     # Apply secrets + configmaps
make minikube-pull-images       # Pull coordinator + mcp-host images (default mode)
make minikube-deploy-all        # Deploy all services via the Kustomize overlay for this cluster's mode
make minikube-deploy-instances  # Apply CRD instances (context, host)
```

On a cluster set up with `make minikube-setup-local`, swap
`minikube-pull-images` for `make minikube-build-images`. The coordinator and
mcp-host images the reconciler spawns follow the same mode: they run as
`ghcr.io/evenfire-ai/...` on a default cluster and `clerum/*:test` on a local
one. See
[minikube.md § Workflow Env Vars](minikube.md#workflow-env-vars).

### Workflow-specific troubleshooting

#### `OwnerRefInvalidNamespace` in Pod events

**Cause**: ownerRef points to a resource in a different namespace.
**Fix**: Workflow runtime resources are reconciled from a WorkflowRecipe in
`sandbox-recipes`. Cross-namespace rendered MCP resources in `mcp-server` must
not carry ownerRefs to a namespaced WorkflowRecipe; WRC finalizers own cleanup.

#### Coordinator fails with `WRC returned 404 on GET status`

**Cause**: stale WRC/control-api rollout or a legacy WorkflowRecipe CRD outside
the canonical namespace.
**Fix**: run the clean pre-gate sync, verify the CRD exists in
`sandbox-recipes`, and remove any legacy `mcp-server` WorkflowRecipe stragglers.

#### mcp_host fails with `FATAL: CLERUM_AUTH_JWT_PUBLIC_KEY is not set`

**Cause**: Wrong or missing env var in podFactory.
**Fix**: Verify that the Pod has the 4 JWT env vars:
`CLERUM_AUTH_JWT_PUBLIC_KEY`, `CLERUM_AUTH_JWT_ISSUER`,
`CLERUM_AUTH_JWT_AUDIENCE`, `WRC_PUBLIC_KEY_PEM`.

#### Coordinator fails with `ENOTFOUND clerum-operator.control-plane.svc.cluster.local`

**Cause**: Wrong WRC K8s Service name.
**Fix**: Verify the `CLERUM_WRC_SERVICE_NAME` env var in the WRC deployment. The
Service is called `workflow-recipes` in the standard minikube installation.

#### Workflow stays in `running` indefinitely

**Possible causes**:

1. Coordinator cannot reach WRC (NetworkPolicy blocking)
2. mcp_host cannot reach coordinator (headless Service fails to resolve)
3. JWT token expired or with wrong audience
4. Secret `wf-{name}-coordinator-token` deleted by GC (verify ownerRefs)
