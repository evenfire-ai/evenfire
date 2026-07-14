import { WORKFLOW_RECIPE_DEFAULT_ALLOWED_CAPABILITIES } from '@clerum/workflow-recipe-capability-policy'
import type {
  EnrichmentDiff,
  EnrichmentResult,
  OperatorDefaults,
  WorkflowRecipeSpec,
  WorkflowRecipeWorkload,
} from './recipeTypes'

export const DEFAULT_OPERATOR_DEFAULTS: OperatorDefaults = {
  security: {
    allowedCapabilities: [...WORKFLOW_RECIPE_DEFAULT_ALLOWED_CAPABILITIES],
    maxRunAsUser: 65534,
    requireNonRoot: true,
  },
  storage: {
    defaultStorageClass: 'standard',
    defaultAccessMode: 'ReadWriteOnce',
    maxPvcSizeGi: 100,
    outputPath: '/var/clerum/output',
  },
  resources: {
    defaultCpuRequest: '100m',
    defaultMemoryRequest: '128Mi',
    defaultCpuLimit: '500m',
    defaultMemoryLimit: '512Mi',
  },
  namespaces: {
    mcpWorkloads: 'mcp-server',
    nonMcpWorkloads: 'sandbox-recipes',
  },
  registry: {
    prefix: 'us-central1-docker.pkg.dev/${GCP_PROJECT}/clerum/',
    imagePullSecrets: [],
  },
}

/**
 * Applies operator defaults to a WorkflowRecipeSpec.
 * Returns the enriched spec and a list of diffs showing what changed.
 *
 * Rules applied:
 * 1. Workloads without `resources` get default CPU/memory requests+limits.
 * 2. Images without a registry prefix (no slash) get the prefix prepended.
 * 3. VolumeClaimTemplates without `storageClass` get the default storage class.
 * 4. Security is validated — NOT auto-injected (dev must declare explicitly).
 */
export function applyDefaults(
  spec: WorkflowRecipeSpec,
  defaults: OperatorDefaults
): EnrichmentResult {
  const diffs: EnrichmentDiff[] = []
  const enriched: WorkflowRecipeSpec = JSON.parse(JSON.stringify(spec)) as WorkflowRecipeSpec

  if (!Array.isArray(enriched.workloads)) {
    return { enriched, diffs }
  }

  enriched.workloads = enriched.workloads.map((w: WorkflowRecipeWorkload) => {
    const wCopy = { ...w }

    // Rule 1: Inject resource defaults if not set
    if (!wCopy.resources) {
      const injected = {
        requests: {
          cpu: defaults.resources.defaultCpuRequest,
          memory: defaults.resources.defaultMemoryRequest,
        },
        limits: {
          cpu: defaults.resources.defaultCpuLimit,
          memory: defaults.resources.defaultMemoryLimit,
        },
      }
      wCopy.resources = injected
      diffs.push({
        path: `workloads[${w.id}].resources`,
        before: undefined,
        after: injected,
        reason: 'Operator default resources injected (workload had none)',
      })
    }

    // Rule 2: Prepend registry prefix to bare image names (no slash = no registry)
    if (wCopy.image && !wCopy.image.includes('/') && defaults.registry.prefix) {
      const before = wCopy.image
      wCopy.image = `${defaults.registry.prefix}${wCopy.image}`
      diffs.push({
        path: `workloads[${w.id}].image`,
        before,
        after: wCopy.image,
        reason: 'Registry prefix applied by operator policy',
      })
    }

    // Rule 3: Apply default storageClass to VCTs that lack one
    if (Array.isArray(wCopy.volumeClaimTemplates)) {
      wCopy.volumeClaimTemplates = wCopy.volumeClaimTemplates.map(vct => {
        if (!vct.storageClass) {
          diffs.push({
            path: `workloads[${w.id}].volumeClaimTemplates[${vct.name}].storageClass`,
            before: undefined,
            after: defaults.storage.defaultStorageClass,
            reason: 'Default storageClass applied by operator policy',
          })
          return { ...vct, storageClass: defaults.storage.defaultStorageClass }
        }
        return vct
      })
    }

    return wCopy
  })

  return { enriched, diffs }
}
