# Control UI Workflow Recipes and Registry Guide

This guide explains how WorkflowRecipes and the Registry fit together in Clerum, starting from the operator and product view and moving down into the code paths that create, validate, publish, install, run, and display them.

It is written for the next round of work on `control-ui`, especially the effort to unify the Workflow Recipes and Registry sections. The goal is to make the current behavior clear enough that UI/UX changes can be made deliberately instead of by archaeology.

## 1. Executive Summary

Clerum has two related but currently separate management surfaces:

- **Workflow Recipes** are installed, cluster-resident `WorkflowRecipe` CRDs. They are what actually run. Control UI uses this section to create recipes from JSON, validate them, configure secrets, manage authorized users, inspect status, view workloads, connect background OAuth integrations, and trigger runs.
- **Registry** is a versioned catalog of installable things. It can hold standalone MCP servers and WorkflowRecipe entries. Control UI uses this section to discover, publish, edit metadata, remove catalog versions, and install catalog entries into the cluster.

The two concepts overlap because a registry recipe becomes a live WorkflowRecipe after install. The user thinks "I want a workflow"; the platform currently splits that into:

1. Find or publish a catalog entry in Registry.
2. Install it through `/registry/install`.
3. Land on the live WorkflowRecipe detail page in `/workflow-recipes/sandbox-recipes/<name>`.
4. Configure secrets, integrations, grants, and triggers there.
5. Let Desktop App users run it from Workflows, or open it from Apps if it exposes `spec.ui`.

The core unification opportunity is to treat Registry as an acquisition/install source and Workflow Recipes as the lifecycle/runtime home. A unified UI should make the state transition obvious:

```text
Catalog recipe version
  -> install checkpoint
  -> live WorkflowRecipe in sandbox-recipes
  -> grants/integrations/secrets/status/runs
  -> visible in Desktop App Workflows and/or Apps
```

## 2. Conceptual Model

### 2.1 WorkflowRecipe

A `WorkflowRecipe` is a Kubernetes custom resource with:

```yaml
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: my-workflow
  namespace: sandbox-recipes
spec:
  workloads: []
  steps: []
```

The CRD is the package. It can declare:

- Kubernetes workloads: `deployment`, `statefulset`, `cronjob`, `job`, `daemonset`.
- MCP-facing workloads, identified by a `transport` field.
- Non-MCP runtime workloads such as databases, workers, cron jobs, and webhook handlers.
- Agentic or deterministic workflow steps under `spec.steps`.
- Snippet steps under `step.run`.
- Input schemas under `spec.inputContract`.
- Runtime triggers under `spec.triggers`.
- Output artifacts under `spec.output`.
- Secrets, OAuth clients, webhooks, egress, UI embedding, and policy/security controls.

Important invariant: **WorkflowRecipe CRDs always live in `sandbox-recipes`**. Control API strips or ignores author-provided namespaces on create and update. The reconciler then renders children into the correct namespaces.

### 2.2 Namespace Splitting

The platform routes recipe content by purpose:

| Spec content | Runtime namespace | Why |
|---|---|---|
| `WorkflowRecipe` CRD object | `sandbox-recipes` | Canonical storage and workflow runtime namespace. |
| Workload with `transport` | `mcp-server` | Becomes a managed MCP server child. |
| Workload referenced by `spec.ui.workloadRef` | `sandbox-ui` | Rendered as a sandboxed Desktop App UI. |
| Non-transport workloads | `sandbox-recipes` | Databases, workers, cron jobs, webhook handlers, coordinators. |
| Workflow run coordinators and output PVCs | `sandbox-recipes` | Runtime state stays with the recipe. |

This matters for UI because an installed recipe is not "in" the registry or the MCP server namespace. The live management surface must target `sandbox-recipes`.

### 2.3 Registry Entry

A Registry entry is versioned metadata plus installable content. In Control UI it is represented by `RegistryEntry` in `control-ui/lib/api.ts`.

Key fields:

| Field | Meaning |
|---|---|
| `name`, `version` | Stable catalog identity. |
| `entry_type` | `mcp-server` or `recipe`. |
| `server_mode` | `local` or `remote` for MCP server entries. |
| `recipe_type` | Usually `workflow` or `only-workloads` for recipe entries. |
| `mcp_server_meta` | Image, port, transport, credential schema, remote endpoints, egress summary. |
| `recipe_meta.recipeYaml` | YAML or JSON content used to install a WorkflowRecipe. |
| `trust_level`, `quality_tier`, `origin` | Catalog trust and curation metadata. |
| `downloads`, `installs` | Registry usage counters. |

Registry entries do not run by themselves. Install creates cluster resources and stamps them with catalog labels:

```yaml
clerum.io/catalog-id: <entry-name>
clerum.io/catalog-version: <entry-version>
clerum.io/managed-by: control-api
```

Control UI uses those labels to decide whether a catalog entry is already installed.

## 3. Current Control UI Surfaces

### 3.1 Workflow Recipes List

Route:

```text
control-ui/app/workflow-recipes/page.tsx
```

Major components:

| File | Role |
|---|---|
| `control-ui/components/RecipesTab.tsx` | Table of live recipes with search, phase, workloads, created date, and row navigation. |
| `control-ui/components/RecipeEditor.tsx` | Create/edit flow for JSON WorkflowRecipe manifests. |
| `control-ui/lib/hooks/useRecipePolling.ts` | Loads recipes, status, and recent runs. |
| `control-ui/lib/workflowRecipeRunState.ts` | Computes user-facing display phase and run button state. |
| `control-ui/app/constants/workflowRecipes.ts` | Holds `DEFAULT_WORKFLOW_RECIPE_NAMESPACE` (`sandbox-recipes`). |

The list is runtime-focused. It reads live recipes from:

```ts
GET /api/v1/admin/recipes
```

Each row opens:

```text
/workflow-recipes/:namespace/:name
```

The list currently has an **Install Recipe** button, but that button opens `RecipeEditor`, not the registry. This is one reason the UX feels split: "install" means "paste JSON and create a CRD" here, while "install" in Registry means "install a catalog version."

### 3.2 Workflow Recipe Detail

Route:

```text
control-ui/app/workflow-recipes/[namespace]/[name]/page.tsx
```

The detail page is the live operations hub. It loads:

- The recipe CRD.
- Reconciler status.
- Pods and workload status.
- Recent workflow runs.
- Secrets.
- Background OAuth integration status.
- Authorized trigger users.

Tabs include:

| Tab | Purpose |
|---|---|
| Runs | Recent workflow runs, trigger modal, run artifacts. |
| Workloads | Workload reconciliation and pod/container health. |
| Conditions | CRD conditions from the reconciler. |
| Secrets | Recipe-scoped secret management. |
| Integrations | Background OAuth clients from `spec.oauthClients`. |
| Users | Workflow trigger grants. |

This is the page Desktop App behavior depends on indirectly. If a recipe does not declare a user on-demand trigger or has no authorized users, it may be live in Control UI but not practically usable by end users.

### 3.3 Recipe Editor

Component:

```text
control-ui/components/RecipeEditor.tsx
```

The editor is a JSON-first create/update flow. It supports:

- Built-in templates such as MongoDB MCP Stack, Agentic Workflow, PDF reports, snippet workflows, and local-only custom coordinator templates.
- Client validation with `control-ui/lib/recipeValidator.ts`.
- Server validation through `POST /api/v1/admin/recipes/validate`.
- Optional operator default enrichment from `control-ui/lib/recipeDefaults.ts`.
- External egress review from `control-ui/lib/egressModel.ts`.
- Secret detection and pre-deploy secret upsert.
- Per-step human approval gating editor for `step.requiresApproval`.
- Workflow trigger grants through `GrantsPanel`.

The effective create flow is:

1. Operator pastes JSON or loads a template.
2. Operator clicks **Validate**.
3. Client validation checks parse, shape, limits, secret hygiene, template refs, and some security rules.
4. Editor detects referenced secrets from snippet capabilities and workload `envSecret`.
5. Operator may enter secret values. Values are written as Kubernetes Secrets, not copied into the recipe JSON.
6. Operator may apply defaults.
7. Operator selects authorized users.
8. Operator clicks **Deploy Recipe**.
9. Editor runs server validation.
10. Editor creates or updates the WorkflowRecipe.
11. On create, editor saves workflow grants after the CRD exists.

Server validation is intentionally a submit-time gate because it requires cluster state. For example, agentic recipes that set `spec.contextRef` must also set:

```json
"security": { "allowContextRef": true }
```

and the namespace must have a matching `WorkflowRecipePolicy` that allows context sharing.

### 3.4 Registry Catalog

Component:

```text
control-ui/components/RegistryCatalog.tsx
```

The registry catalog is embedded in the dashboard tab and supports:

- Search.
- Type filtering: all, MCP servers, Workflow Recipes.
- Category filtering.
- Mode filtering: local, remote, workflow, only-workloads.
- Installed detection.
- Detail navigation.
- Install navigation.
- Edit metadata.
- Remove catalog version.
- Publish new entry.

The catalog reads:

```ts
GET /api/v1/admin/registry/entries
GET /api/v1/admin/registry/categories
GET /api/v1/admin/mcp-servers
GET /api/v1/admin/recipes
```

Installed detection differs by entry type:

- MCP servers match either catalog labels or `metadata.name`.
- Recipes match catalog labels on live WorkflowRecipe CRDs.

### 3.5 Registry Detail

Route:

```text
control-ui/app/registry/entries/[name]/[version]/page.tsx
```

The detail page shows:

- Trust, quality, category, tags, downloads, installs.
- Install/Edit/Remove actions.
- Description.
- Container images extracted from recipe YAML.
- Source repo URL extracted from `clerum.io/source-repo` annotation.
- Expandable recipe YAML.

For recipe entries, the install button currently routes through a legacy deep link:

```text
/workflow-recipes?registry=<entry>&version=<version>
```

`/workflow-recipes` immediately redirects that link to:

```text
/registry/install?entry=<entry>&version=<version>
```

A unified UI should remove or hide this historical detour.

### 3.6 Registry Install

Route:

```text
control-ui/app/registry/install/page.tsx
```

This route branches by `entry.entry_type`.

For MCP servers, it renders:

```text
control-ui/components/RegistryInstallForm/index.tsx
```

That form collects server name, context, credentials, and warns about external egress.

For recipe entries, it renders `RegistryRecipeInstallPreview` inside the route file. That preview:

- Reads `entry.recipe_meta.recipeYaml`.
- Attempts browser-side validation via `validateRecipe`.
- Runs egress analysis.
- Blocks install on browser-visible validation errors or egress errors.
- Calls `installRecipeFromRegistry`.

Then Control UI navigates to the live recipe detail page:

```text
/workflow-recipes/sandbox-recipes/<created-recipe-name>
```

### 3.7 Publish to Registry

Route:

```text
control-ui/app/registry/publish/page.tsx
```

Component:

```text
control-ui/components/PublishToRegistryForm.tsx
```

This form can publish:

- MCP server entries.
- Recipe entries.

For recipe entries it posts the raw recipe YAML/text in `payload.recipe`. It does not currently provide the full lifecycle affordances the Recipe Editor does, such as secret detection, grants, policy explanations, or rich YAML preview. That is an important product gap if the plan is to make Registry and Recipes feel unified.

## 4. Control API Paths

### 4.1 Live WorkflowRecipe Admin API

Main route:

```text
control-api/src/routes/admin/recipes.ts
```

Client functions:

```text
control-ui/lib/api.ts
```

Important endpoints:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/v1/admin/recipes` | List live WorkflowRecipes. |
| `POST` | `/api/v1/admin/recipes` | Create live WorkflowRecipe. |
| `POST` | `/api/v1/admin/recipes/validate` | Validate without creating. |
| `GET` | `/api/v1/admin/recipes/:name` | Read one recipe. |
| `PUT` | `/api/v1/admin/recipes/:name` | Update recipe spec. |
| `DELETE` | `/api/v1/admin/recipes/:name` | Delete recipe. |
| `POST` | `/api/v1/admin/recipes/:name/retry` | Retry failed reconciliation. |
| `GET` | `/api/v1/admin/recipes/:name/status` | Read status. |
| `GET` | `/api/v1/admin/recipes/:name/pods` | Read rendered pods. |
| `POST` | `/api/v1/admin/recipes/secrets` | Upsert recipe secret. |

Workflow run and grant endpoints:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/v1/admin/workflows/:ns/:name/runs` | List run history. |
| `POST` | `/api/v1/admin/workflows/:ns/:name/trigger` | Trigger a run. |
| `GET` | `/api/v1/admin/workflows/:ns/:name/grants` | List authorized users. |
| `PUT` | `/api/v1/admin/workflows/:ns/:name/grants` | Replace authorized users. |
| `GET` | `/api/v1/admin/workflows/:ns/:name/runs/:runId/artifacts` | List run artifacts. |

The server-side route enforces:

- Recipe names must be RFC1123 labels.
- WorkflowRecipe CRDs are stored in `config.sandboxNamespace`.
- Recipe namespaces are not author-controlled.
- Secret names and keys are validated.
- Platform-managed `wf-*` secrets cannot be used by recipe config.
- Inline sensitive env values are rejected or warned against.
- Template references are checked against declared inputs, computed values, resources, and workload host/port fields.
- Recipe limits are checked through `validateWorkflowRecipeLimits`.
- Agentic `contextRef` requires explicit recipe and policy permission.

### 4.2 Registry Admin API

Main route:

```text
control-api/src/routes/admin/registry.ts
```

Registry client:

```text
control-api/src/services/registryClient.ts
```

Important endpoints:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/v1/admin/registry/entries` | Search catalog. |
| `POST` | `/api/v1/admin/registry/entries` | Publish entry. |
| `GET` | `/api/v1/admin/registry/entries/:name/versions/:version` | Read version. |
| `GET` | `/api/v1/admin/registry/categories` | List categories. |
| `GET` | `/api/v1/admin/registry/entries/:name/versions/:version/credential-schema` | Read install credentials schema. |
| `POST` | `/api/v1/admin/registry/install` | Install MCP server entry. |
| `POST` | `/api/v1/admin/registry/install-recipe` | Install recipe entry. |
| `PUT` | `/api/v1/admin/registry/entries/:name/versions/:version` | Edit version metadata. |
| `DELETE` | `/api/v1/admin/registry/entries/:name/versions/:version` | Remove catalog version. |

`install-recipe` does the important recipe-specific work:

1. Requires `registryEntryName` and `registryEntryVersion`.
2. Fetches the version from registry.
3. Verifies `entry_type === "recipe"`.
4. Extracts `recipe_meta.recipeYaml`.
5. Rejects content over 100 KB.
6. Parses YAML first, JSON second.
7. Generates a recipe name if one was not provided.
8. Uses `parsed.spec` when present, or the parsed object as spec for legacy payloads.
9. Validates recipe limits.
10. Optionally merges `inputValues` into `inputContract.properties[*].default`.
11. Creates the WorkflowRecipe CRD with catalog labels.
12. Reports install back to registry asynchronously.

One difference from direct Recipe Editor creation: `install-recipe` does not currently run the full `validateRecipeBody` path from `admin/recipes.ts`. The browser preview and CRD/admission/reconciler still protect the install, but a unified system should consider whether registry recipe install should reuse the same validation path as direct create.

## 5. Desktop App Visibility

There are two different Desktop App places where recipes can appear.

### 5.1 Workflows Page

Route/component:

```text
desktop-app/ui/src/pages/WorkflowsPage.tsx
desktop-app/ui/src/hooks/domain/useWorkflowController.ts
desktop-app/ui/src/lib/workflows.ts
```

This page lists deployed WorkflowRecipes available to the signed-in user. It shows:

- Name.
- Namespace.
- Status.
- Input form from `spec.inputContract`.
- Trigger button.
- Recent runs and downloadable artifacts.

For the trigger button to be useful, the recipe should declare:

```yaml
spec:
  triggers:
    onDemand:
      allowedActors: [user]
```

If `allowedActors` is absent, Desktop App treats it as triggerable once `onDemand` exists. If `allowedActors` exists and does not contain `user`, the UI disables trigger.

Separate from `spec.triggers`, Control API grants decide which users can see or trigger a workflow. Control UI stores those through the Users/Grants panel.

### 5.2 Apps / Sandbox UI Page

Component:

```text
desktop-app/ui/src/pages/SandboxUiPage.tsx
```

This page lists recipes that expose a sandbox UI:

```yaml
spec:
  ui:
    workloadRef: ui
    port: 8080
    title: Sales CRM
    defaultPath: /
```

When a user opens an app, Desktop App asks the main process to mint a sandbox UI session, mounts a `WebContentsView`, and points it to the platform sandbox UI endpoint. A recipe can therefore appear both:

- In **Workflows**, if it has triggerable workflow steps.
- In **Apps**, if it has `spec.ui`.

The CRM sample is primarily interesting because it is an app-style recipe with a UI, optional integrations, and background jobs. It demonstrates why "workflow recipe" is broader than "LLM workflow."

## 6. Step-by-Step: Create a New WorkflowRecipe

This section describes the practical path for creating new recipes. Use the UI path for day-to-day authoring; use `kubectl` or direct API only for debugging or automation.

### 6.1 Start With the Smallest Valid Shape

For a non-UI, non-agent workload:

```yaml
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: hello-recipe
  namespace: sandbox-recipes
spec:
  description: Minimal test workload.
  workloads:
    - id: web
      type: deployment
      image: nginxinc/nginx-unprivileged:1.27-alpine
      port: 8080
      healthCheck:
        type: http
        path: /
        port: 8080
      resources:
        requests:
          cpu: 50m
          memory: 64Mi
        limits:
          cpu: 200m
          memory: 128Mi
  security:
    isolationLevel: minimal
```

Control UI's editor expects JSON today, so convert the YAML to JSON before using **Workflow Recipes -> Install Recipe**, or install from Registry if the entry is published as YAML.

### 6.2 Add Inputs

Inputs make recipes reusable. They feed template substitutions and Desktop App trigger forms.

```yaml
spec:
  inputContract:
    properties:
      topic:
        type: string
        default: latest advances in multi-agent systems
        description: Research topic
```

In workflow steps, reference them as:

```yaml
instruction: "Research {{inputs.topic}} and produce a concise report."
```

The Desktop App trigger modal/form will prefill defaults from `inputContract`.

### 6.3 Add Workflow Steps

Agentic steps use `instruction`:

```yaml
spec:
  agent:
    provider: zai
    model: glm-4.7
  triggers:
    onDemand:
      allowedActors: [user, autonomous]
  steps:
    - id: research
      instruction: "Research {{inputs.topic}}."
      timeoutSeconds: 600
    - id: summarize
      dependsOn: [research]
      instruction: |
        Using this research:

        {{research:output}}

        Produce a structured summary.
```

Snippet steps use `run`:

```yaml
steps:
  - id: query-postgres
    run:
      type: snippet
      language: typescript
      code: |
        const rows = await sdk.postgres.query(ref, {
          sql: "select now() as now"
        });
        return rows;
      capabilities:
        postgres:
          workloads: [postgres]
          access: readWrite
```

Custom coordinator image recipes can declare `coordinatorImage` and steps without `instruction` or `run`; the custom image owns the execution logic.

### 6.4 Add Workloads

Use workloads for databases, web apps, APIs, workers, MCP servers, and cron jobs.

```yaml
workloads:
  - id: postgres
    type: statefulset
    image: postgres:16-alpine
    port: 5432
    env:
      - name: POSTGRES_DB
        value: app
      - name: POSTGRES_USER
        value: app
      - name: PGDATA
        value: /var/lib/postgresql/data/pgdata
    envSecret:
      name: app-db
      keys:
        - secretKey: password
          envVar: POSTGRES_PASSWORD
    volumeMounts:
      - name: pgdata
        mountPath: /var/lib/postgresql/data
    volumeClaimTemplates:
      - name: pgdata
        storageClass: standard
        accessMode: ReadWriteOnce
        size: 1Gi
    security:
      runAsUser: 70
      runAsGroup: 70
      fsGroup: 70
```

Use `dependsOn` when startup ordering matters:

```yaml
- id: api
  type: deployment
  image: my-org/api:1.0.0
  dependsOn: [postgres]
```

Use template references for sibling service discovery:

```yaml
env:
  - name: DATABASE_URL
    value: "postgres://app:{{app-db:password}}@{{postgres:host}}:{{postgres:port}}/app"
```

Be careful with credentials in templates. Inline sensitive values are rejected or flagged. Prefer `envSecret` or snippet secret capabilities.

### 6.5 Expose an MCP Server

A workload becomes MCP-facing by declaring `transport`:

```yaml
workloads:
  - id: crm-tools
    type: deployment
    image: my-org/crm-mcp:1.0.0
    port: 3000
    transport:
      type: streamableHttp
      path: /mcp
```

That workload will be rendered into `mcp-server`, not `sandbox-recipes`.

If the MCP workload needs to call a database workload, add a binding:

```yaml
bindings:
  - from: crm-tools
    to: postgres
    port: 5432
```

Bindings are important because the default posture is network deny.

### 6.6 Expose a Sandbox UI

A recipe with a UI can show up in Desktop App Apps.

```yaml
workloads:
  - id: ui
    type: deployment
    image: my-org/my-ui:1.0.0
    port: 8080
    healthCheck:
      type: http
      path: /
      port: 8080
ui:
  workloadRef: ui
  port: 8080
  title: My App
  defaultPath: /
```

Rules of thumb from the CRM sample and sandbox UI examples:

- Use non-root images such as `nginxinc/nginx-unprivileged` for static UIs.
- Listen on 8080 unless the platform allowlist says otherwise.
- Keep secrets out of the UI pod. Put secrets in backend workloads in `sandbox-recipes`.
- Use the sandbox UI route as a browser surface, not as a privileged backend.
- If the UI needs backend data, route to an API workload through the platform-supported internal egress/proxy configuration.

### 6.7 Add External Egress

Public internet access is closed by default. Declare explicit egress for workloads that need it.

Exact-host egress:

```yaml
workloads:
  - id: web-search
    type: deployment
    image: ghcr.io/aas-ee/open-web-search:latest
    port: 3000
    transport:
      type: streamableHttp
    egressBindings:
      - dns: duckduckgo.com
        port: 443
        protocol: TCP
      - dns: html.duckduckgo.com
        port: 443
        protocol: TCP
```

Public-web egress:

```yaml
egressBindings:
  - egressClass: public-web
```

Use public-web sparingly. The UI already treats it as a special review point because it expands the trust boundary, even though private/internal ranges remain blocked.

### 6.8 Add Secrets

For workload environment variables:

```yaml
envSecret:
  name: sales-crm-app
  keys:
    - secretKey: pg-password
      envVar: PG_PASSWORD
    - secretKey: fireflies-api-key
      envVar: FIREFLIES_API_KEY
      optional: true
```

For snippet capabilities:

```yaml
run:
  capabilities:
    secrets:
      - alias: pg_password
        secretRef:
          name: pg-auth
          key: password
```

Control UI detects both patterns and offers a secrets panel during create/edit. Filled values are written to Kubernetes Secrets before the recipe is submitted.

Namespace detail:

- Secrets for non-transport workflow workloads go to `sandbox-recipes`.
- Secrets for transport/MCP workloads go to `mcp-server`.
- The editor derives this from whether the workload has `transport`.

### 6.9 Add OAuth Integrations

Background OAuth clients let the platform hold a recipe-owned grant and broker short-lived provider tokens.

Example shape:

```yaml
oauthClients:
  - id: google-gmail
    provider: google
    backgroundAccess: true
    clientIdRef:
      name: sales-crm-google-oauth
      key: client-id
    clientSecretRef:
      name: sales-crm-google-oauth
      key: client-secret
    scopes:
      - https://www.googleapis.com/auth/gmail.readonly
```

After install, Control UI detail page -> Integrations tab handles connect/disconnect for the recipe. The workload receives broker access, not raw refresh tokens.

### 6.10 Add Webhooks

The CRM sample uses optional webhooks so the recipe can become active before all provider credentials are available.

Pattern:

```yaml
webhooks:
  - id: fireflies
    workloadRef: api
    path: /webhook/fireflies
    optional: true
    verification:
      scheme: hmac-sha256-body
      secretRef:
        name: sales-crm-fireflies-webhook
        key: signing-secret
      signatureHeader: X-Hub-Signature-256
      signaturePrefix: sha256=
      signatureEncoding: hex
```

Optional webhooks can be dormant until their secret exists. This is useful for progressive setup.

### 6.11 Add Human Approval Gates

Per-step approval is expressed on a step:

```yaml
steps:
  - id: send-email
    instruction: "Draft and send the customer email."
    requiresApproval:
      target:
        userId: <user-id>
      message: Approve before sending this email.
      timeoutSeconds: 3600
```

Control UI has an approval gating editor inside `RecipeEditor`. It can add or remove this block without manually editing JSON.

### 6.12 Configure Output and Retention

For downloadable run artifacts:

```yaml
output:
  name: competitive-intel-report
  destination: pvc
  format: pdf
  storageSize: 256Mi
runRetention:
  successfulHistoryLimit: 10
  failedHistoryLimit: 10
  ttlSecondsAfterFinished: 604800
  maxRunDurationSeconds: 3600
```

Desktop App and Control UI can list and download run artifacts from the workflow run endpoints.

### 6.13 Install Through Control UI

Direct recipe authoring path:

1. Open Control UI.
2. Go to **Workflow Recipes**.
3. Click **Install Recipe**.
4. Paste JSON.
5. Click **Validate**.
6. Resolve errors and review warnings.
7. Fill detected secret values, or leave empty to use existing secrets.
8. Optionally click **Apply Operator Defaults**.
9. Add authorized users in the grants panel.
10. Click **Deploy Recipe**.
11. Open the recipe detail page.
12. Check Conditions, Workloads, Secrets, Integrations, Users, and Runs.

Registry path:

1. Go to **Registry**.
2. Filter type to **Workflow Recipes**.
3. Open a recipe entry.
4. Review description, images, source repo, trust, and YAML.
5. Click **Install**.
6. Review validation and external egress.
7. Click **Install recipe**.
8. Control UI navigates to the live recipe detail page.
9. Configure secrets, integrations, and authorized users there.

### 6.14 Verify With kubectl

The live CRD should be in `sandbox-recipes`:

```bash
kubectl --context=clerum-test -n sandbox-recipes get workflowrecipes
kubectl --context=clerum-test -n sandbox-recipes describe workflowrecipe <name>
```

Check non-transport workloads:

```bash
kubectl --context=clerum-test -n sandbox-recipes get pods -l clerum.io/recipe-name=<name>
```

Check transport/MCP children:

```bash
kubectl --context=clerum-test -n mcp-server get pods -l clerum.io/recipe-name=<name>
kubectl --context=clerum-test -n mcp-server get mcpservers
```

Check sandbox UI:

```bash
kubectl --context=clerum-test -n sandbox-ui get pods -l clerum.io/recipe-name=<name>
```

## 7. Step-by-Step: Publish a WorkflowRecipe to Registry

Publishing creates a catalog entry. It does not install the recipe.

### 7.1 Prepare the Recipe YAML

Use YAML for registry entries. Keep:

- `apiVersion: clerum.io/v1alpha1`
- `kind: WorkflowRecipe`
- `metadata.name`
- `metadata.namespace: sandbox-recipes` for readability, even though install enforces placement.
- `metadata.annotations.clerum.io/source-repo` when useful, because Registry detail extracts it for a Source repo button.
- `metadata.labels.clerum.io/catalog-version` if the recipe repo tracks its own version.
- A clear `spec.description`.

### 7.2 Ensure Images Are Pullable

Registry detail extracts `image:` values from recipe YAML and links known registries. Before publishing:

- Push every image tag referenced by the YAML.
- Prefer immutable version tags over `latest`.
- Confirm public/private pull settings match the target cluster.
- If local-only, mark it clearly and do not publish as a general installable recipe.

### 7.3 Publish From Control UI

1. Open Control UI.
2. Go to **Registry**.
3. Click **Publish to Registry**.
4. Select **Recipe**.
5. Fill common metadata:
   - Name: RFC1123-compatible.
   - Version: semantic or project version.
   - Author.
   - Description.
   - Category.
   - Origin.
   - Tags.
6. Paste the recipe YAML.
7. Submit.
8. Return to Registry and verify the entry appears.
9. Open the entry detail and inspect images and YAML.
10. Install it into a test cluster from Registry before sharing it.

### 7.4 Registry Install Naming

If a registry recipe install does not specify `recipeName`, Control API generates one from entry name and version:

```text
recipe-<slug>-v<version>-<hash8>
```

This avoids collisions between versions, but it can produce names that are less human-friendly than the recipe's own `metadata.name`.

For a polished UX, the install flow should probably expose a "Recipe name" field for recipe entries, similar to the MCP server install form.

### 7.5 Updating a Published Recipe

Recommended version flow:

1. Change code.
2. Build and push new image tags.
3. Update `recipe.yaml` image tags.
4. Bump recipe/catalog version.
5. Publish a new registry version.
6. Install into a test cluster.
7. Verify status, pods, app UI, workflow trigger, and artifacts.
8. Deprecate or remove older catalog versions only when appropriate.

The current UI supports metadata edit and removal, but not a rich "upgrade installed recipe to new catalog version" experience. The backend has registry upgrade-style routes later in `control-api/src/routes/admin/registry.ts`; they are a natural area to inspect before designing upgrade UX.

## 8. CRM Sample Deep Dive

Sample root:

```text
crm-plugin-sample-master/sales-crm
```

Key files:

| File | Purpose |
|---|---|
| `recipe.yaml` | Authoritative WorkflowRecipe. |
| `recipe.json` | JSON form of the recipe. |
| `api/` | Fastify API image, database migrations, webhook handlers, cron jobs. |
| `ui/` | Preact/nginx sandbox UI image. |
| `sales-crm/README.md` | App-specific build, deploy, provider, and test guide. |
| `CLERUM_WORKFLOW_RECIPE_GUIDE.md` | Long authoring guide with CRM examples. |

### 8.1 What the CRM Recipe Demonstrates

The CRM sample is a useful reference because it combines many recipe capabilities:

- A Postgres StatefulSet.
- An API deployment in `sandbox-recipes`.
- CronJob workloads for follow-up and inbox polling.
- A static/preact UI deployment in `sandbox-ui`.
- Optional third-party credentials.
- Optional dormant webhooks.
- Background OAuth for Gmail.
- Provider egress.
- Progressive enablement: the recipe can become active with only a Postgres password, then integrations can be enabled later by adding secrets.
- Desktop App Apps visibility through `spec.ui`.

### 8.2 Image Split

The sample uses two main images:

| Image | Namespace | Role |
|---|---|---|
| `docker.io/apavia/sales-crm-api:...` | `sandbox-recipes` | Fastify API, migrations, provider calls, webhooks, cron logic. |
| `docker.io/apavia/sales-crm-ui:...` | `sandbox-ui` | Static Preact UI served by nginx-unprivileged. |

The UI holds no secrets. It talks to backend routes. This is the right pattern for sandbox UI recipes.

### 8.3 Required Secret

The recipe is designed to need only one key at install time:

```bash
kubectl create secret generic sales-crm-app \
  -n sandbox-recipes \
  --from-literal=pg-password="$(openssl rand -hex 16)"
```

That password is used by both the DB and API/follow-up jobs. Without it, the core app cannot start.

### 8.4 Optional Secrets

Optional keys include:

- `anthropic-api-key`
- `openai-base-url`
- `openai-api-key`
- `openai-model`
- `fireflies-api-key`
- `whatsapp-phone-number-id`
- `whatsapp-access-token`

The recipe marks optional integration keys as `optional: true` so the workload can start without them. The app code must fail closed when optional credentials are absent.

### 8.5 Background OAuth

The CRM sample uses a recipe-owned Google OAuth client for Gmail ingestion:

1. Operator creates a Google OAuth Web Application client.
2. Operator creates `sales-crm-google-oauth` with `client-id` and `client-secret`.
3. Operator opens Control UI recipe detail -> Integrations.
4. Operator clicks **Connect for the recipe**.
5. Control API stores the grant server-side.
6. Runtime workloads use the OAuth broker to request short-lived tokens.

This is different from putting refresh tokens in Kubernetes Secrets. The recipe references client credentials; the platform owns user/provider grants.

### 8.6 Webhooks

The CRM sample shows how to use optional webhooks:

- Fireflies webhook can remain dormant until its signing secret exists.
- Telegram and WhatsApp style webhooks can use provider-specific verification.
- The gateway handles verification before traffic reaches the workload.

This pattern is very important for install UX. A recipe can be "installed and mostly usable" before every external provider is configured.

### 8.7 Desktop App Surfacing

The CRM appears in Desktop App Apps because it declares `spec.ui`. It is not primarily a Workflows page item unless it also declares triggerable workflow steps.

This distinction should be clear in a unified UI:

- "This recipe installs an app" when `spec.ui` exists.
- "This recipe installs runnable workflow triggers" when `spec.triggers.onDemand` and `spec.steps` exist.
- "This recipe installs MCP tools" when workloads have `transport`.
- "This recipe installs support infrastructure" when it has only non-transport workloads.

## 9. Validation and Security Rules to Understand

### 9.1 Client Validation

Client validator:

```text
control-ui/lib/recipeValidator.ts
```

It checks:

- Valid JSON.
- `apiVersion`.
- `kind`.
- `metadata.name`.
- Step count and per-step limits.
- Duplicate step IDs.
- Step shape: `instruction` or `run`, not both.
- Snippet run shape.
- Workload type.
- Secret name/key shape.
- Inline sensitive env values.
- PVC size limits.
- Capabilities allowlist.
- Egress binding count limits through `egressModel`.
- Template reference sanity for many common cases.

The UI currently validates JSON, not YAML, in the direct Recipe Editor. Registry install can parse YAML server-side and attempts browser validation only when `validateRecipe` can parse it.

### 9.2 Server Validation

Server validation:

```text
POST /api/v1/admin/recipes/validate
control-api/src/routes/admin/recipes.ts
```

It repeats structural checks and adds cluster-aware policy checks. This is the validation path users see when clicking Deploy in Recipe Editor.

### 9.3 Admission and Reconciler Validation

Even if UI or Control API misses something, the CRD schema, admission policy, and WRC reconciler remain enforcement layers. Treat UI validation as an ergonomic preflight, not the sole security boundary.

### 9.4 Egress Review

Egress analysis is intentionally prominent in both direct Recipe Editor and Registry install. The platform is default-deny; external access should be visible before deployment.

Current UI messages distinguish:

- No egress declarations.
- Exact-host egress.
- Public-web egress.
- Blocking egress errors.

### 9.5 Grants Are Product-Critical

A recipe can deploy successfully with no authorized users. In that case:

- Admins can see it in Control UI.
- Desktop App users will not be able to trigger it.

The editor warns on create when no users are selected. A unified install flow should preserve or strengthen this warning, especially for registry installs, which currently land on detail after install but do not force a grant decision first.

## 10. UX Unification Opportunities

### 10.1 Rename Actions by Intent

Current ambiguity:

- Workflow Recipes -> **Install Recipe** means "create from JSON template/editor."
- Registry -> **Install** means "install catalog entry."

Better labels:

| Current | Suggested |
|---|---|
| Install Recipe in Workflow Recipes | Create recipe |
| Registry Install | Install from catalog |
| Publish to Registry | Publish catalog entry |

### 10.2 Unified Recipe Home

A unified page could have one "Recipes" top-level section with tabs or segmented views:

- Installed
- Catalog
- Draft/Create

Installed should remain runtime-first. Catalog should be acquisition-first. Detail pages can cross-link:

- Installed recipe detail shows catalog source/version if labels exist.
- Catalog detail shows installed versions and links to live recipes.

### 10.3 One Install Wizard for Recipe Entries

Registry recipe install should eventually reuse the richer Recipe Editor capabilities:

- Show parsed YAML.
- Show exact install name.
- Show detected capabilities: App, Workflow, MCP tools, webhooks, OAuth, secrets, egress.
- Let operator choose authorized users before install.
- Detect required secrets and offer to create them.
- Show integrations that will require post-install connect.
- Run the same server validation as direct create.
- Land on the live detail page with a clear setup checklist.

### 10.4 Capability Badges

The catalog and installed list could expose badges derived from spec:

| Badge | Detection |
|---|---|
| App | `spec.ui` exists. |
| Workflow | `spec.steps` exists. |
| On-demand | `spec.triggers.onDemand` exists. |
| Scheduled | `spec.triggers.schedule` exists. |
| MCP tools | Any workload has `transport`. |
| OAuth | `spec.oauthClients.length > 0`. |
| Webhooks | `spec.webhooks.length > 0`. |
| Secrets | Workload `envSecret` or snippet secret capabilities exist. |
| Egress | Workload `egressBindings` or UI egress exists. |

These badges would help users understand what a recipe "has" without reading YAML.

### 10.5 Setup Checklist on Detail

After install, the detail page could show a recipe setup checklist:

- Required secrets present.
- Optional secrets missing.
- OAuth clients connected/disconnected.
- Webhooks active/dormant.
- Authorized users selected.
- App visible to Desktop users.
- On-demand trigger enabled.
- Workloads ready.
- Last run status.

This would be especially valuable for CRM-style recipes, where install is only the first step.

## 11. Code Map for Future Work

Use this map when modifying the UI.

### 11.1 Control UI

| Area | Files |
|---|---|
| Workflow list | `control-ui/app/workflow-recipes/page.tsx`, `control-ui/components/RecipesTab.tsx` |
| Workflow detail | `control-ui/app/workflow-recipes/[namespace]/[name]/page.tsx` |
| Recipe create/edit | `control-ui/components/RecipeEditor.tsx` |
| Recipe status | `control-ui/components/RecipeStatusContent/index.tsx` |
| Run modal | `control-ui/components/WorkflowRunModal/index.tsx` |
| Registry catalog | `control-ui/components/RegistryCatalog.tsx` |
| Registry install | `control-ui/app/registry/install/page.tsx`, `control-ui/components/RegistryInstallForm/index.tsx` |
| Registry detail | `control-ui/app/registry/entries/[name]/[version]/page.tsx` |
| Registry publish | `control-ui/app/registry/publish/page.tsx`, `control-ui/components/PublishToRegistryForm.tsx` |
| API client | `control-ui/lib/api.ts` |
| Validation | `control-ui/lib/recipeValidator.ts` |
| Defaults | `control-ui/lib/recipeDefaults.ts` |
| Egress | `control-ui/lib/egressModel.ts`, `control-ui/components/EgressEditor.tsx` |
| Types | `control-ui/lib/recipeTypes.ts` |

Remember the UI agent rules for `control-ui`: reusable types belong in sibling `types.ts`, shared constants belong in `app/constants`, colors and spacing should use global CSS tokens, and shared classes go in `app/globals.css`.

### 11.2 Control API

| Area | Files |
|---|---|
| Live recipe CRUD/validation/secrets/status | `control-api/src/routes/admin/recipes.ts` |
| Registry search/publish/install | `control-api/src/routes/admin/registry.ts` |
| Registry HTTP client | `control-api/src/services/registryClient.ts` |
| Workflow grants | `control-api/src/services/workflows/workflowGrantManagementService.ts` |
| Workflow trigger | `control-api/src/services/workflows/workflowTriggerService.ts` |
| Run artifacts | `control-api/src/services/workflows/workflowRunArtifactService.ts` |
| Run history | `control-api/src/services/workflowRunService.ts` |
| Limits | `control-api/src/services/workflowRecipeLimits.ts` |

### 11.3 Desktop App

| Area | Files |
|---|---|
| Workflows page | `desktop-app/ui/src/pages/WorkflowsPage.tsx` |
| Workflow controller hook | `desktop-app/ui/src/hooks/domain/useWorkflowController.ts` |
| Workflow summary logic | `desktop-app/ui/src/lib/workflows.ts` |
| Sandbox app page | `desktop-app/ui/src/pages/SandboxUiPage.tsx` |

### 11.4 Docs and Examples

| Area | Files |
|---|---|
| Feature hub | `docs/features/workflow-recipes.md` |
| CRD reference | `docs/crds/workflowrecipe.md` |
| Operations guide | `docs/deploy/workflow-recipes-guide.md` |
| Custom coordinator snippet guide | `docs/features/custom-coordinator-snippet-workflow.md` |
| Registry seed recipes | `registry-api/seed/recipes.json` |
| CRM sample | `crm-plugin-sample-master/sales-crm/recipe.yaml` |

## 12. Practical Checklist for a New Recipe

Use this as the authoring checklist.

1. Define the recipe purpose.
2. Decide which capabilities it has: App, Workflow, MCP tools, OAuth, webhooks, cron, storage, egress.
3. Create the smallest valid `WorkflowRecipe` YAML.
4. Add workloads with explicit resources and health checks.
5. Add `spec.ui` only if it should show in Desktop App Apps.
6. Add `spec.steps` and `spec.triggers.onDemand` only if it should show in Desktop App Workflows.
7. Add `spec.inputContract` for user-provided run inputs.
8. Add `envSecret` and snippet secret capabilities for credentials.
9. Mark truly optional integration secrets as `optional: true`.
10. Add exact-host egress for provider/API calls.
11. Add bindings between workloads that must communicate.
12. Add OAuth clients if the platform should broker provider tokens.
13. Add webhooks with verification and replay settings.
14. Validate locally in Control UI or through `POST /admin/recipes/validate`.
15. Install in a clean test cluster.
16. Verify CRD phase, conditions, pods, secrets, integrations, UI, trigger, runs, and artifacts.
17. Publish to Registry with versioned metadata.
18. Install from Registry into a test cluster.
19. Confirm catalog labels are present on the live recipe.
20. Confirm Desktop App visibility for the intended users.

## 13. Known Sharp Edges

- Direct Recipe Editor is JSON-first; registry recipes are usually YAML.
- Registry recipe install preview can fail to parse YAML client-side but still allow server-side YAML install only when there are no parsed blocking findings; the messaging currently calls this a fallback.
- Registry recipe install currently does not ask for authorized users before install.
- Registry publish form does not validate recipe YAML as richly as the Recipe Editor validates JSON.
- Installed detection depends on catalog labels, so direct-created recipes will not show as installed catalog entries.
- `metadata.labels` in author YAML may not survive direct recipe create because Control API owns labels and namespace placement.
- A recipe can be active but not visible in Desktop App Workflows if grants/triggers are missing.
- A recipe can be active but not visible in Desktop App Apps if `spec.ui` is absent.
- Optional credentials only work safely when the application code treats missing env vars as disabled integrations.
- Public-web egress should be treated as a serious review moment in UI.

## 14. Recommended Mental Model

Think of the system as three layers:

1. **Catalog layer**: Registry entries answer "What can I install?"
2. **Runtime layer**: WorkflowRecipes answer "What is running and healthy?"
3. **User layer**: Desktop App answers "What can this user open or trigger?"

Most confusion comes from jumping between those layers without naming the transition. The unification work should make the transition explicit:

```text
Registry entry selected
  -> install preview and setup requirements
  -> WorkflowRecipe created in sandbox-recipes
  -> operator completes secrets/integrations/grants
  -> users see Apps or Workflows in Desktop App
```

If the UI can keep that story visible, the underlying technical richness becomes a strength instead of a maze.
