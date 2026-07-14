/**
 * Child WorkflowRecipe factory for workflow-run execution artifacts.
 *
 * `workflow_runs` is the durable WorkflowRun model and source of truth. This
 * factory only materializes the per-run child WorkflowRecipe CRD that WRC uses
 * to execute the workload. It must not become a parallel authorization, run, or
 * approval model.
 */
import * as k8s from '@kubernetes/client-node'
import { createHash } from 'node:crypto'
import { createLogger } from '../observability/logger'
import { CRD_GROUP, CRD_VERSION, WORKFLOWRECIPE_PLURAL } from '../reconciler/crdConstants'

// Strict allowlist: child WorkflowRecipe CRDs inherit the platform-owned
// WorkflowRecipe namespace only. Rendered MCP transport children are represented
// by McpServer CRDs elsewhere; a child WorkflowRecipe must never materialize in
// mcp-server, control-plane, kube-system, or any caller-supplied namespace.
const ALLOWED_CHILD_NAMESPACES = ['sandbox-recipes'] as const

export interface ParentRecipe {
  metadata: {
    name: string
    namespace: string
    uid: string
  }
  spec: {
    contextRef?: string
    security?: Record<string, unknown>
    inputs?: Record<string, unknown>
    inputContract?: Record<string, unknown>
    computed?: unknown[]
    coordinatorImage?: string
    steps?: unknown[]
    agent?: unknown
    mcpServers?: unknown[]
    workloads?: unknown[]
    resources?: unknown[]
    runtimeEgress?: Record<string, unknown>
    output?: unknown
    // scheduling intentionally NOT included in child
  }
}

export interface ChildRecipeOptions {
  triggerKind?: 'schedule' | 'onDemand'
  inputs?: Record<string, unknown>
  outputOverrides?: Record<string, unknown>
  annotations?: Record<string, string>
  labels?: Record<string, string>
  nameSuffix?: string
  stableName?: string
}

export const INHERITED_PARENT_RESOURCES_ANNOTATION = 'clerum.io/inherited-parent-resources'

// Kubernetes label values (and DNS-1123 labels used for Service /
// Deployment names) are capped at 63 bytes. The child-recipe name is
// copied into both surfaces downstream by WRC's resolveWorkloadResourceName
// + workloadLabels, so this is the tightest constraint end-to-end. See
// docs/architecture/workflow-recipe-naming.md for the canonical scheme,
// including why 63 — and not the DNS subdomain cap of 253 — is the real
// ceiling for child-recipe names.
const K8S_LABEL_VALUE_MAX = 63

// Short-form run-id suffix used by buildDbRunChildName. 8 hex chars =
// 32 bits of entropy, which lifts the parent-stem budget to 54 bytes
// (63 − 1 separator − 8 suffix). Birthday-bound collision ≈ 2¹⁶ (~65k)
// runs of the same parent. See §2.3 of
// docs/architecture/workflow-recipe-naming.md.
const RUN_ID_SHORT_LEN = 8

/**
 * Truncate a parent name to a DNS-1123-safe stem of at most `maxStem` chars.
 *
 * Shared by `buildDbRunChildName` and the scheduled/on-demand name builder so
 * the §2.4 truncation rule lives in exactly one place:
 *   1. slice to `maxStem`,
 *   2. strip any trailing `-` so we never emit `foo--<suffix>`,
 *   3. fall back to the literal `"workflow"` if the stem trims to empty.
 *
 * Note: this does NOT lowercase or add a disambiguating hash — those concerns
 * differ between the two callers (the DB-run path gets its uniqueness from the
 * run-id suffix; the scheduled path gets it from `boundScheduledName`), so
 * keeping this helper minimal preserves `buildDbRunChildName`'s byte-for-byte
 * historical output.
 */
function truncateStem(parentName: string, maxStem: number): string {
  const bounded = Math.max(1, maxStem)
  return parentName.slice(0, bounded).replace(/-+$/u, '') || 'workflow'
}

// Length of the stable parent-disambiguator hash appended when a long parent
// name must be truncated on the scheduled/on-demand path. 8 hex chars mirrors
// the `hash8` convention used by §2.5 downstream resource names. The same
// length is reused to bound an oversized caller `nameSuffix` (see below).
const PARENT_HASH_LEN = 8

/**
 * Bound the scheduled / on-demand child-recipe name to ≤ 63 bytes (the DNS-1123
 * label / K8s label-value ceiling — see §1 of
 * docs/architecture/workflow-recipe-naming.md) for ANY inputs.
 *
 * Contract: the returned name is ALWAYS ≤ 63 bytes and a valid DNS-1123 label,
 * regardless of how long `parentName`, `fixedSuffix`, or `nameSuffix` are. This
 * is an unconditional bound, not one that only holds for catalog-sized inputs.
 *
 * The trailing suffix has two parts:
 *   - `fixedSuffix` = `-<timestamp>-<index>`, which disambiguates executions of
 *     the SAME parent and is ALWAYS kept verbatim so same-parent runs never
 *     collide. (`index` is zero-padded to ≥4 digits but can grow unbounded; it
 *     is short enough in practice that, combined with the budget math below, a
 *     1-char stem + hash still fits. If a pathological index ever pushed the
 *     fixed portion past the budget the final clamp still caps the result.)
 *   - `nameSuffix` = the optional caller-supplied `ChildRecipeOptions.nameSuffix`,
 *     which is UNBOUNDED in length. Because the public API lets a caller pass an
 *     arbitrarily long value, it must not be trusted to fit. When the whole name
 *     would overflow we shrink the `nameSuffix` contribution (and, if needed,
 *     replace it with an 8-hex hash of itself) so its length can never blow the
 *     budget while a distinct nameSuffix still yields a distinct name.
 *
 * Cross-parent uniqueness: control-api `generateRegistryName` packs a parent's
 * uniqueness into a TRAILING 8-char hash (e.g.
 * `recipe-<tenant>-<plugin>-vX-Y-Z-3092f68d`). Naive prefix truncation would cut
 * that hash off, so two distinct recipes sharing a long prefix would collide. To
 * keep cross-parent uniqueness we re-attach a stable hash of the FULL parent
 * name to the truncated stem — the same mitigation `generateRegistryName` uses.
 *
 * When the parent + full suffix already fits, the name passes through unchanged
 * (only lowercased to stay DNS-1123 valid, and routed through the same
 * empty/leading-hyphen sanitation as the truncated branch), so short parents
 * keep their historical `<parent>-<timestamp>-<index>` form with no hash and no
 * regression.
 */
function boundScheduledName(parentName: string, fixedSuffix: string, nameSuffix?: string): string {
  const callerSuffix = nameSuffix ? `-${nameSuffix}` : ''
  const fullSuffix = `${fixedSuffix}${callerSuffix}`

  // Fast path: the untouched `<parent><fixedSuffix><callerSuffix>` already fits.
  // We still run the stem through truncateStem so an empty/trailing-hyphen
  // parent is sanitized identically in both branches (empty → "workflow").
  if (parentName.length + fullSuffix.length <= K8S_LABEL_VALUE_MAX) {
    const stem = truncateStem(parentName, parentName.length)
    return `${stem}${fullSuffix}`.toLowerCase()
  }

  // The fixed `-<timestamp>-<index>` portion is always preserved verbatim.
  // Reserve a 1-char stem + `-` + `<hash8>` + fixedSuffix; whatever budget
  // remains is what the (possibly bounded) caller suffix may occupy.
  const hash = createHash('sha256').update(parentName).digest('hex').slice(0, PARENT_HASH_LEN)
  const reservedForCallerSuffix = K8S_LABEL_VALUE_MAX - 1 - 1 - PARENT_HASH_LEN - fixedSuffix.length

  // Bound the caller suffix. If it fits, keep it as-is; otherwise replace it
  // with `-<hash8>` of the original nameSuffix so a distinct nameSuffix still
  // maps to a distinct name. If even that hashed form doesn't fit (an
  // extreme/negative budget), drop the caller suffix entirely.
  let boundedCallerSuffix = ''
  if (nameSuffix) {
    if (callerSuffix.length <= reservedForCallerSuffix) {
      boundedCallerSuffix = callerSuffix
    } else if (1 + PARENT_HASH_LEN <= reservedForCallerSuffix) {
      const suffixHash = createHash('sha256')
        .update(nameSuffix)
        .digest('hex')
        .slice(0, PARENT_HASH_LEN)
      boundedCallerSuffix = `-${suffixHash}`
    }
  }

  // The stem gets whatever is left after the fixed suffix, the bounded caller
  // suffix, and `-<hash8>` are reserved. truncateStem floors this to ≥1 char;
  // the budget above already accounts for that single char.
  const stem = truncateStem(
    parentName,
    K8S_LABEL_VALUE_MAX - PARENT_HASH_LEN - 1 - fixedSuffix.length - boundedCallerSuffix.length
  )
  return `${stem}-${hash}${fixedSuffix}${boundedCallerSuffix}`.toLowerCase()
}

export function formatTimestamp(date: Date): string {
  const y = date.getUTCFullYear()
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  const h = String(date.getUTCHours()).padStart(2, '0')
  const mi = String(date.getUTCMinutes()).padStart(2, '0')
  const s = String(date.getUTCSeconds()).padStart(2, '0')
  return `${y}${mo}${d}-${h}${mi}${s}`
}

function deepCopy<T>(value: T): T {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

export function buildChildRecipe(
  parent: ParentRecipe,
  executionIndex: number,
  now = new Date(),
  options: ChildRecipeOptions = {}
): Record<string, unknown> {
  const timestamp = formatTimestamp(now)
  const triggerKind = options.triggerKind ?? 'schedule'

  // Fail-closed: refuse to inherit any namespace outside the operator allowlist.
  // Without this guard a mutated parent CRD could bootstrap children into
  // arbitrary namespaces (confused-deputy via the WRC ServiceAccount).
  const parentNs = parent.metadata.namespace
  if (!ALLOWED_CHILD_NAMESPACES.includes(parentNs as (typeof ALLOWED_CHILD_NAMESPACES)[number])) {
    throw new Error(
      `Refusing to spawn child recipe: parent namespace "${parentNs}" is not in allowlist (${ALLOWED_CHILD_NAMESPACES.join(', ')}).`
    )
  }

  const output = deepCopy(parent.spec.output)
  if (output && typeof output === 'object' && !Array.isArray(output) && options.outputOverrides) {
    Object.assign(output as Record<string, unknown>, deepCopy(options.outputOverrides))
  }

  // The fixed `-<timestamp>-<index>` suffix disambiguates runs of the SAME
  // parent and is always preserved verbatim. The optional caller `nameSuffix`
  // is passed separately so boundScheduledName can bound it independently — it
  // is a public (unbounded) field, so it must not be trusted to fit. The result
  // is guaranteed ≤ 63 bytes and a valid DNS-1123 label for any inputs.
  const fixedSuffix = `-${timestamp}-${String(executionIndex).padStart(4, '0')}`
  const generatedName =
    options.stableName ?? boundScheduledName(parent.metadata.name, fixedSuffix, options.nameSuffix)

  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: {
      name: generatedName,
      namespace: parent.metadata.namespace,
      labels: {
        'clerum.io/parent-recipe': parent.metadata.name,
        'clerum.io/execution-index': String(executionIndex),
        'clerum.io/managed-by': 'clerum-wrc',
        ...(triggerKind === 'schedule'
          ? { 'clerum.io/scheduled': 'true' }
          : { 'clerum.io/on-demand': 'true' }),
        ...(options.labels ?? {}),
      },
      annotations: {
        [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true',
        ...(options.annotations ?? {}),
      },
      ownerReferences: [
        {
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'WorkflowRecipe',
          name: parent.metadata.name,
          uid: parent.metadata.uid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      ...(parent.spec.contextRef ? { contextRef: parent.spec.contextRef } : {}),
      ...(parent.spec.security ? { security: deepCopy(parent.spec.security) } : {}),
      ...(parent.spec.coordinatorImage ? { coordinatorImage: parent.spec.coordinatorImage } : {}),
      steps: deepCopy(parent.spec.steps),
      agent: deepCopy(parent.spec.agent),
      mcpServers: deepCopy(parent.spec.mcpServers),
      workloads: deepCopy(parent.spec.workloads),
      resources: deepCopy(parent.spec.resources),
      runtimeEgress: deepCopy(parent.spec.runtimeEgress),
      inputContract: deepCopy(parent.spec.inputContract),
      computed: deepCopy(parent.spec.computed),
      ...(options.inputs ? { inputs: deepCopy(options.inputs) } : {}),
      output,
      // scheduling is intentionally omitted — prevents recursive scheduling
    },
  }
}

/**
 * Compose the canonical per-run child-recipe name.
 *
 *   <parent-stem>-<short-run-id>
 *     parent-stem   = parentName trimmed to fit within 63 bytes
 *     short-run-id  = first 8 chars of the run UUID, lowercased
 *
 * Total length is guaranteed ≤ K8S_LABEL_VALUE_MAX (63) so every
 * downstream Kubernetes surface that copies this name into a label value
 * or a DNS-1123 label (Service / Deployment metadata.name) stays valid
 * without any secondary sanitation step.
 *
 * The scheme is deterministic: the same `(parentName, runId)` pair
 * always produces the same output, which is required by the
 * `workflow_runs.idx_wr_idempotency` uniqueness constraint.
 *
 * See `docs/architecture/workflow-recipe-naming.md` for the full
 * taxonomy (including collision analysis and worked examples).
 */
export function buildDbRunChildName(parentName: string, runId: string): string {
  const suffix = runId.toLowerCase().slice(0, RUN_ID_SHORT_LEN)
  // K8S_LABEL_VALUE_MAX − separator − suffix; uniqueness comes from `suffix`.
  const maxPrefixLength = K8S_LABEL_VALUE_MAX - suffix.length - 1
  const prefix = truncateStem(parentName, maxPrefixLength)
  return `${prefix}-${suffix}`
}

export async function resolveExecutionIndex(
  customApi: k8s.CustomObjectsApi,
  parentName: string,
  namespace: string
): Promise<number> {
  try {
    const result = (await customApi.listNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace,
      plural: WORKFLOWRECIPE_PLURAL,
      labelSelector: `clerum.io/parent-recipe=${parentName}`,
    })) as { items?: unknown[] }
    return result.items?.length ?? 0
  } catch (err) {
    // Best-effort — executionIndex is a label for tracing, not a uniqueness key
    // (child names are timestamp-based). Log the error so transient K8s API
    // failures are visible in operator logs rather than silently returning 0.
    createLogger('wrc', 'child-recipe-factory').warn('Could not resolve executionIndex', {
      parentName,
      error: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
}
