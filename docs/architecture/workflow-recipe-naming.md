# Workflow Recipe Naming Taxonomy

Canonical naming scheme for WorkflowRecipe CRDs, the per-run child recipes
WRC creates on trigger, and the downstream Kubernetes resources those child
recipes render. **Every name emitted anywhere in this chain is ≤ 63 bytes**
so that every surface — DNS labels, label values, Service/Deployment names —
satisfies Kubernetes' tightest string constraint without further truncation.

This spec is the single source of truth the Desktop App, control-ui,
control-api and WRC all depend on. If you change the scheme, update this
doc first and the code afterwards.

---

## 1. Why 63 bytes (and not 253)

Kubernetes constrains object names by two separate rules that both apply
here:

| Surface | Limit | Authority |
|---|---|---|
| DNS-1123 **Label** (Service name, Deployment name, Ingress hostname segment) | **63 chars** | RFC 1123 §2.1 + Kubernetes API server |
| DNS-1123 **Subdomain** (Pod name, ConfigMap name, generic CRD instance name) | 253 chars | RFC 1123 (FQDN max) |
| Label **value** (`metadata.labels[k] = v`) | **63 bytes** | Kubernetes API server (`ValidateLabelValue`) |

Both Deployments and Services are created from the per-run child recipe,
and every such object copies the child-recipe name into:

1. its own `metadata.name` (Service, NetworkPolicy → DNS-1123 label = 63)
2. a `metadata.labels` value used by selectors (63 bytes)

**63 bytes is therefore the tightest constraint downstream**, and the
scheme keeps child-recipe names under that limit so we never need a
second sanitation pass further down the pipeline.

> The old value of 253 (subdomain limit) was correct only for the child
> recipe's own CRD storage, not for the Deployments/Services WRC derives
> from it. A child with a 64-byte name caused `HTTP 422` from the K8s
> API on every label write — observed end-to-end in clerum-test when a
> 27-byte parent recipe (`e2e-compintel-1777057465250`) was triggered
> from the Desktop App.

Modern DNS RFCs (5890, 6891) did **not** raise the label-length cap.
63 bytes remains the ceiling and will stay there for the foreseeable
future.

---

## 2. Canonical taxonomy

### 2.1 Parent WorkflowRecipe CRD

```
metadata.name ≤ 63 bytes
```

Enforced at:
- control-api `POST /admin/recipes` — the admin UI catches long names
  before they reach the cluster.
- Kubernetes CRD validation schema.

### 2.2 Per-run child recipe

Created by WRC's `createDbRunChildRecipe` every time a run is triggered.
The child is a separate WorkflowRecipe CRD whose `metadata.name` is
derived from the parent and the run ID:

```
<parent-stem>-<short-run-id>

parent-stem     := parent.metadata.name, possibly truncated (see §2.4)
short-run-id    := run.run_id.toLowerCase().slice(0, 8)
```

### 2.3 Why an 8-char truncated run ID

The run ID is a UUIDv4 — 36 characters including hyphens, 32 hex characters
of entropy. Using the full UUID leaves only `63 − 36 − 1 = 26` bytes for
the parent stem, which truncates user-chosen parent names mid-word (e.g.
`competitive-intel-report` → `competitive-intel-repor`) and erodes
debuggability.

Truncating the run ID to 8 characters (the first 8 hex characters of the
UUID, 32 bits of entropy) raises the parent-stem budget to `63 − 8 − 1 = 54`
bytes while bounding the collision probability inside a single parent at

> ~50 % after roughly 2¹⁶ ≈ 65,000 runs of the **same** parent (birthday
> bound on a 32-bit suffix)

This is a per-parent bound — only runs that share one parent recipe draw from
the same 32-bit suffix space, so the practical risk depends on how often a
single parent is triggered. Callers that expect high run counts on one parent
can widen the space with a longer `short-run-id` (below).

If a caller explicitly opts into higher collision resistance they can
pass a longer `short-run-id` — the function accepts it and shortens the
parent stem to compensate.

### 2.4 Parent-stem truncation

When the parent name exceeds the available budget the stem is trimmed
using the same rule as `resourceNames.buildMcpHostServiceName`:

1. `stem = parent.slice(0, maxStem).replace(/-+$/u, '')` — strip any
   trailing `-` so we never emit names like `foo--1a2b3c4d`.
2. If the stem ends up empty (edge case: parent starts with 54 hyphens),
   fall back to the literal `"workflow"` so the resulting name is still
   DNS-1123 valid.

**Determinism**: the same `(parent, run_id)` pair always produces the
same child-recipe name. Re-triggering a WorkflowRecipe for an identical
run ID (idempotency replay) always lands on the same child — required
by `workflow_runs.idx_wr_idempotency` uniqueness.

### 2.5 Downstream Deployment/Service naming

Workloads inside the child recipe are rendered into Deployments and
Services whose names derive from the child's `metadata.name`:

```
<child-stem>-<workload-id>-<hash8>

child-stem    := child.metadata.name, possibly truncated by composeResourceName
workload-id   := e.g. "web-search", "coordinator", "mcp-host"
hash8         := sha256(childUid || workloadId).slice(0, 8)
```

Implemented in `workflow-recipes/src/reconciler/resourceBuilder.ts`
`composeResourceName`. The truncation rule is symmetric to §2.4: the
child stem is trimmed, never the workload ID or hash, so downstream
label selectors (which use `app = <resourceName>`) stay stable across
reconciles.

---

## 3. Worked examples

Parent `e2e-ondemand-simple` (19 bytes) + run ID
`0842f0c5-8611-4d50-9c2b-92cc7c4ffcb6`:

| Resource | Name | Length |
|---|---|---|
| Child recipe | `e2e-ondemand-simple-0842f0c5` | 28 |
| Coordinator Deployment | `e2e-ondemand-simple-0842f0c5-coordinator-aa11bb22` | 49 |
| web-search Deployment | `e2e-ondemand-simple-0842f0c5-web-search-cc33dd44` | 48 |

Parent `competitive-intel-report` (24 bytes), same run ID:

| Resource | Name | Length |
|---|---|---|
| Child recipe | `competitive-intel-report-0842f0c5` | 33 |
| web-search Deployment | `competitive-intel-report-0842f0c5-web-search-cc33dd44` | 53 |

Long parent `autonomous-code-review-tooling-marketplace` (42 bytes),
same run ID:

| Resource | Name | Length | Notes |
|---|---|---|---|
| Child recipe | `autonomous-code-review-tooling-marketplace-0842f0c5` | 51 | fits, no truncation |
| web-search Deployment | `autonomous-code-review-tooling-marketplace-0842f0c5-web-search-cc33dd44` | 71 ❌ | child stem truncated to 42 by `composeResourceName` |

When truncation occurs the Deployment name becomes
`autonomous-code-review-tooling-marketplace-web-search-cc33dd44` (62),
derived from the child-recipe stem trimmed from 51 → 42 to leave room
for the workload suffix.

---

## 4. Implementation pointers

- `workflow-recipes/src/workflow/childRecipeFactory.ts::buildDbRunChildName` —
  the canonical name builder for per-run child recipes. Reads
  `K8S_LABEL_VALUE_MAX = 63`.
- `workflow-recipes/src/reconciler/resourceBuilder.ts::composeResourceName` /
  `resolveWorkloadResourceName` — derives Deployment/Service names
  from the child recipe. Same truncation rule.
- `workflow-recipes/src/workflow/resourceNames.ts::buildMcpHostServiceName` —
  the mcp-host-specific variant (prefix `wf-`, suffix `-mcp-host`).
  Kept symmetric so any stem that fits in one fits in the other.

---

## 5. How to extend the taxonomy

Do **not** add new consumers that derive names by string concatenation
off the child-recipe name. Route every new derivation through
`composeResourceName` (or a sibling helper in `resourceNames.ts`) so the
63-byte invariant remains centrally enforced. If you need a name pattern
the existing helpers don't cover, add a new helper in
`workflow-recipes/src/workflow/resourceNames.ts`, unit-test it against
a parent at every length bucket (19, 24, 42, 54, 63) and update this
document with the new pattern.
