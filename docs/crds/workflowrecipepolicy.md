# WorkflowRecipePolicy CRD Reference

**API Group:** `clerum.io`  
**Version:** `v1alpha1`  
**Scope:** Namespaced (must live in `sandbox-recipes`)  
**Short names:** `wrp`, `policy`  
**Enforced by:** workflow-recipes operator (WRC), during each recipe reconcile

## Purpose

Governance rules for `WorkflowRecipe` deployments in a namespace. WRC lists
every WorkflowRecipePolicy in the recipe's own namespace and checks the recipe
against all of them before it deploys anything. Pair with the
[WorkflowRecipe](workflowrecipe.md) CRD.

Things to know before you write one:

- **Namespace is fixed.** A ValidatingAdmissionPolicy in `deploy/base` rejects
  any WorkflowRecipePolicy outside `sandbox-recipes`, the namespace that stores
  WorkflowRecipe CRDs.
- **No selector.** A policy has no match or selector field. Every policy in
  `sandbox-recipes` applies to every recipe there. When several policies set
  the same limit, the recipe must satisfy each one.
- **No status.** The CRD has no status subresource. A violation shows up on
  the *WorkflowRecipe*: `status.phase: failed` and `status.message:
  "Policy violation: [<policy>] <rule>: <detail>"`. WRC does not retry or
  self-heal a policy failure, and editing the spec does not clear it: while
  the recipe is `failed` with a `Policy violation:` message, WRC skips policy
  evaluation and the recipe stays `failed`. After you fix the recipe spec (or
  the policy), call the control-api admin endpoint
  `POST /api/v1/admin/recipes/<name>/retry`. It moves the recipe to
  `candidate`, and the next reconcile evaluates the policies again. Deleting
  and re-creating the recipe also starts it from `candidate`.
- **Many fields are not enforced yet.** The schema accepts more than WRC
  checks. The tables below mark each field as **Enforced** or **Not
  enforced**. A not-enforced field is stored but nothing reads it.
- **Nothing ships by default.** `deploy/base` ships no WorkflowRecipePolicy.
  The minikube overlay ships one dev policy (see [Example](#example)).

## Spec fields

| Field                  | Type    | Enforced?    | Description                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec.description`     | string  | n/a          | Free text.                                                                                                                                                                                                                                                                                                                                                              |
| `spec.allowContextRef` | boolean | **Enforced** | Widens the default-deny on `spec.contextRef` for agentic recipes (recipes with `spec.steps[]`). Such a recipe may reference a shared Context only if the recipe sets `spec.security.allowContextRef: true` **and** at least one policy in the namespace sets this field to `true`. Checked by control-api when a recipe is validated or submitted, and again by WRC. |
| `spec.governance`      | object  | partly       | See [governance](#specgovernance).                                                                                                                                                                                                                                                                                                                                      |
| `spec.detection`       | object  | partly       | See [detection](#specdetection).                                                                                                                                                                                                                                                                                                                                        |
| `spec.publication`     | object  | Not enforced | See [other blocks](#other-blocks-not-enforced).                                                                                                                                                                                                                                                                                                                         |
| `spec.deployment`      | object  | Not enforced | See [other blocks](#other-blocks-not-enforced).                                                                                                                                                                                                                                                                                                                         |
| `spec.notification`    | object  | Not enforced | See [other blocks](#other-blocks-not-enforced).                                                                                                                                                                                                                                                                                                                         |
| `spec.deprecation`     | object  | Not enforced | See [other blocks](#other-blocks-not-enforced).                                                                                                                                                                                                                                                                                                                         |

No field carries a schema default. `spec` is the only required top-level field.

### `spec.governance`

| Field                                    | Type     | Enforced?    | Description                                                                                                                                                                                                                        |
| ---------------------------------------- | -------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `governance.requireApproval`             | boolean  | **Enforced** | When `true`, WRC rejects the recipe while its `status.phase` is `candidate` or `pending-approval`. Phases past the approval gate are not re-blocked. See [Approval Workflow](workflowrecipe.md#152-approval-workflow).          |
| `governance.maxWorkloadsPerRecipe`       | integer  | **Enforced** | Min 1. Rejects a recipe with more `spec.workloads[]` entries. The CRD already caps `workloads` at 25.                                                                                                                             |
| `governance.maxReplicasPerWorkload`      | integer  | **Enforced** | Min 1. Rejects any workload whose `replicas` (default 1) is higher.                                                                                                                                                               |
| `governance.allowedWorkloadTypes`        | string[] | **Enforced** | Lowercase enum: `deployment`, `statefulset`, `cronjob`, `job`, `daemonset`. Rejects a workload whose `type` is not listed. Empty or absent means all types.                                                                     |
| `governance.requiredSecurityLevel`       | string   | **Enforced** | `minimal` \| `standard` \| `strict`. Rejects a recipe whose `spec.security.isolationLevel` is lower. A recipe without `isolationLevel` counts as `minimal`.                                                                      |

### `spec.detection`

| Field                              | Type     | Enforced?    | Description                                                                                                                                         |
| ---------------------------------- | -------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detection.imageAllowlist`         | string[] | **Enforced** | Glob patterns (`*` within a path segment, `**` across segments, `?` one character). When non-empty, every workload image must match at least one. |
| `detection.imageDenylist`          | string[] | **Enforced** | Glob patterns. Any workload image that matches is rejected.                                                                                       |
| `detection.enabled`                | boolean  | Not enforced | Stored only. The allow/deny lists apply whether or not this is `true`.                                                                              |
| `detection.scanOnDeploy`           | boolean  | Not enforced | Stored only. No image scanning runs.                                                                                                                |
| `detection.allowedStorageClasses`  | string[] | Not enforced | Stored only. PVC StorageClasses are not checked.                                                                                                    |
| `detection.maxResourceLimits.cpu`    | string   | Not enforced | Stored only. Container limits are not checked.                                                                                                      |
| `detection.maxResourceLimits.memory` | string   | Not enforced | Stored only.                                                                                                                                        |

The workload, replica, type, and image rules all iterate `spec.workloads[]`. A
steps-only (workflow) recipe has no workloads, so those rules pass for it.

### Other blocks (not enforced)

These fields are in the schema, but no component reads them in this release.

| Field                                    | Type     | Schema description                                                        |
| ---------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `publication.registry`                   | string   | Registry URL for recipe publication.                                      |
| `publication.autoPublish`                | boolean  | Auto-publish recipes to the registry.                                     |
| `deployment.autoPromoteAfterSeconds`     | integer  | Min 0. Seconds before auto-promoting from testing to active.              |
| `deployment.rollbackOnFailure`           | boolean  | Auto-rollback on deployment failure.                                      |
| `deployment.maxConcurrentDeploys`        | integer  | Min 1. Maximum concurrent recipe deployments.                             |
| `notification.channels`                  | string[] | Notification channel references.                                          |
| `notification.events`                    | string[] | Enum: `deploy`, `rollback`, `failed`, `deprecated`.                       |
| `deprecation.gracePeriodDays`            | integer  | Min 0. Days before a deprecated recipe is removed.                        |
| `deprecation.autoDeprecateInactiveDays`  | integer  | Min 0. Days of inactivity before auto-deprecation.                        |

## Additional Printer Columns

`kubectl get wrp -n sandbox-recipes` displays: MAX-WORKLOADS
(`governance.maxWorkloadsPerRecipe`), SECURITY
(`governance.requiredSecurityLevel`), Age.

## Example

The only policy the repository ships is the minikube dev policy, applied by
`make minikube-deploy-instances`. Production overlays do not ship it, so shared
Context access for agentic recipes stays off until an operator opts in:

```yaml
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipePolicy
metadata:
  name: minikube-allow-context-ref
  namespace: sandbox-recipes
spec:
  description: >-
    Minikube dev default. Permits agentic workflows to share context between
    steps via `spec.contextRef`. Pair with a recipe that sets
    `spec.security.allowContextRef: true`.
  allowContextRef: true
```

Source: [deploy/overlays/minikube/instances/workflowrecipepolicy.yaml](../../deploy/overlays/minikube/instances/workflowrecipepolicy.yaml).

A production-style policy that uses only enforced fields:

```yaml
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipePolicy
metadata:
  name: prod-guardrails
  namespace: sandbox-recipes
spec:
  description: Production limits for recipe workloads.
  governance:
    maxWorkloadsPerRecipe: 10
    maxReplicasPerWorkload: 3
    allowedWorkloadTypes: [deployment, statefulset, job]
    requiredSecurityLevel: standard
  detection:
    imageAllowlist:
      - 'registry.example.com/approved/**'
    imageDenylist:
      - '**:latest'
```

With this policy, a recipe that omits `spec.security.isolationLevel` fails
with `requiredSecurityLevel`, because the omitted level counts as `minimal`.

## Related

- [WorkflowRecipe](workflowrecipe.md) — §8.6 (contextRef validation) and §15
  (approval and governance)
- [Workflow recipes guide](../deploy/workflow-recipes-guide.md)
- [packages/workflow-recipe-capability-policy](../../packages/workflow-recipe-capability-policy/)
- [CRD index](README.md)
