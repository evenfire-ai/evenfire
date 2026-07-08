import { config } from '../config.js'
import { type DnsResolver, validateEgressBindingsPreflight } from '../http/validateMcpServerSpec.js'

type WorkflowLimitConfig = Pick<
  typeof config,
  | 'workflowMaxWorkloadsPerRecipe'
  | 'workflowUiEgressInternalMaxItems'
  | 'workflowMaxSteps'
  | 'workflowStepDependsOnMaxItems'
  | 'workflowStepAllowedToolsMaxItems'
  | 'workflowStepMcpServersMaxItems'
>

const MAX_EGRESS_BINDINGS = 20
const NON_TRANSPORT_PUBLIC_WEB_MESSAGE =
  'public-web is only supported on MCP transport workloads; non-transport workloads must use exact-host egressBindings'
const TRANSPORT_CLUSTER_LOCAL_MESSAGE =
  'cluster-local egressBindings are only supported on non-transport workloads'
const CLUSTER_DNS_SUFFIX = '.svc.cluster.local'

export interface WorkflowRecipeLimitError {
  field: string
  message: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseClusterLocalFqdn(dns: string): { service: string; namespace: string } | null {
  const normalized = dns.toLowerCase().replace(/\.$/, '')
  if (!normalized.endsWith(CLUSTER_DNS_SUFFIX)) return null
  const prefix = normalized.slice(0, -CLUSTER_DNS_SUFFIX.length)
  const parts = prefix.split('.')
  if (parts.length !== 2) return null
  const [service, namespace] = parts
  if (!service || !namespace) return null
  return { service, namespace }
}

function collectWorkloadIds(workloads: unknown): Set<string> {
  const ids = new Set<string>()
  if (!Array.isArray(workloads)) return ids
  for (const workload of workloads) {
    if (!isPlainObject(workload)) continue
    if (typeof workload.id === 'string' && workload.id.length > 0) ids.add(workload.id)
  }
  return ids
}

function maxItemsError(field: string, limit: number): WorkflowRecipeLimitError {
  return { field, message: `must contain at most ${limit} items` }
}

function rejectNonTransportPublicWebBindings(
  egressBindings: unknown,
  fieldPrefix: string,
  errors: WorkflowRecipeLimitError[]
) {
  if (!Array.isArray(egressBindings)) return
  egressBindings.forEach((binding, bindingIndex) => {
    if (!isPlainObject(binding)) return
    if ((binding.egressClass ?? 'exact-host') !== 'public-web') return
    errors.push({
      field: `${fieldPrefix}[${bindingIndex}].egressClass`,
      message: NON_TRANSPORT_PUBLIC_WEB_MESSAGE,
    })
  })
}

function filterAndValidateClusterLocalBindings(
  egressBindings: unknown,
  fieldPrefix: string,
  isTransport: boolean,
  siblingIds: Set<string>,
  expectedNamespace: string,
  errors: WorkflowRecipeLimitError[]
): unknown {
  if (!Array.isArray(egressBindings)) return egressBindings
  return egressBindings.filter((binding, bindingIndex) => {
    if (!isPlainObject(binding)) return true
    if (typeof binding.dns !== 'string') return true
    const parsed = parseClusterLocalFqdn(binding.dns.trim())
    if (!parsed) return true
    if (isTransport) {
      errors.push({
        field: `${fieldPrefix}[${bindingIndex}].dns`,
        message: TRANSPORT_CLUSTER_LOCAL_MESSAGE,
      })
      return false
    }
    if (!siblingIds.has(parsed.service)) {
      errors.push({
        field: `${fieldPrefix}[${bindingIndex}].dns`,
        message: `cluster-local dns "${binding.dns}" does not match any workload id in this recipe (got "${parsed.service}"); cross-recipe references are not allowed`,
      })
      return false
    }
    if (parsed.namespace !== expectedNamespace) {
      errors.push({
        field: `${fieldPrefix}[${bindingIndex}].dns`,
        message: `cluster-local dns "${binding.dns}" targets namespace "${parsed.namespace}" but workloads in this recipe live in "${expectedNamespace}"`,
      })
      return false
    }
    return false
  })
}

function validateEgressLimits(spec: Record<string, unknown>, errors: WorkflowRecipeLimitError[]) {
  const workloads = spec.workloads
  if (Array.isArray(workloads)) {
    workloads.forEach((workload, index) => {
      if (!isPlainObject(workload)) return
      const egressBindings = workload.egressBindings
      if (!workload.transport) {
        rejectNonTransportPublicWebBindings(
          egressBindings,
          `spec.workloads[${index}].egressBindings`,
          errors
        )
      }
      if (Array.isArray(egressBindings) && egressBindings.length > MAX_EGRESS_BINDINGS) {
        errors.push(maxItemsError(`spec.workloads[${index}].egressBindings`, MAX_EGRESS_BINDINGS))
      }
    })
  }

  const runtimeEgress = spec.runtimeEgress
  if (isPlainObject(runtimeEgress) && isPlainObject(runtimeEgress.http)) {
    const allowedHosts = runtimeEgress.http.allowedHosts
    if (Array.isArray(allowedHosts) && allowedHosts.length > MAX_EGRESS_BINDINGS) {
      errors.push(maxItemsError('spec.runtimeEgress.http.allowedHosts', MAX_EGRESS_BINDINGS))
    }
  }

  const steps = spec.steps
  if (Array.isArray(steps)) {
    steps.forEach((step, index) => {
      if (!isPlainObject(step)) return
      const run = isPlainObject(step.run) ? step.run : undefined
      const capabilities = isPlainObject(run?.capabilities) ? run.capabilities : undefined
      const http = isPlainObject(capabilities?.http) ? capabilities.http : undefined
      const allowedHosts = http?.allowedHosts
      if (Array.isArray(allowedHosts) && allowedHosts.length > MAX_EGRESS_BINDINGS) {
        errors.push(
          maxItemsError(
            `spec.steps[${index}].run.capabilities.http.allowedHosts`,
            MAX_EGRESS_BINDINGS
          )
        )
      }
    })
  }
}

function stepId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function validateWorkflowRecipeLimits(
  spec: unknown,
  limits: WorkflowLimitConfig = config
): WorkflowRecipeLimitError[] {
  const errors: WorkflowRecipeLimitError[] = []
  if (!isPlainObject(spec)) return errors

  validateEgressLimits(spec, errors)

  const workloads = spec.workloads
  if (Array.isArray(workloads) && workloads.length > limits.workflowMaxWorkloadsPerRecipe) {
    errors.push(maxItemsError('spec.workloads', limits.workflowMaxWorkloadsPerRecipe))
  }

  const ui = spec.ui
  const uiEgressInternal =
    isPlainObject(ui) && isPlainObject(ui.egress) ? ui.egress.internal : undefined
  if (
    Array.isArray(uiEgressInternal) &&
    uiEgressInternal.length > limits.workflowUiEgressInternalMaxItems
  ) {
    errors.push(maxItemsError('spec.ui.egress.internal', limits.workflowUiEgressInternalMaxItems))
  }

  const steps = spec.steps
  if (steps === undefined) return errors
  if (!Array.isArray(steps)) {
    errors.push({ field: 'spec.steps', message: 'steps must be an array' })
    return errors
  }
  if (steps.length > limits.workflowMaxSteps) {
    errors.push(maxItemsError('spec.steps', limits.workflowMaxSteps))
  }

  const stepIds = new Set<string>()
  const duplicateStepIds = new Set<string>()
  steps.forEach((step, index) => {
    if (!isPlainObject(step)) return
    const id = stepId(step.id)
    if (!id) return
    if (stepIds.has(id) && !duplicateStepIds.has(id)) {
      errors.push({ field: `spec.steps[${index}].id`, message: `duplicate step id "${id}"` })
      duplicateStepIds.add(id)
      return
    }
    stepIds.add(id)
  })

  steps.forEach((step, index) => {
    if (!isPlainObject(step)) return
    const prefix = `spec.steps[${index}]`

    if (Array.isArray(step.dependsOn)) {
      if (step.dependsOn.length > limits.workflowStepDependsOnMaxItems) {
        errors.push(maxItemsError(`${prefix}.dependsOn`, limits.workflowStepDependsOnMaxItems))
      }
      step.dependsOn.forEach((dependency, dependencyIndex) => {
        if (typeof dependency === 'string' && !stepIds.has(dependency)) {
          errors.push({
            field: `${prefix}.dependsOn[${dependencyIndex}]`,
            message: `references unknown step id "${dependency}"`,
          })
        }
      })
    }

    if (
      Array.isArray(step.mcpServers) &&
      step.mcpServers.length > limits.workflowStepMcpServersMaxItems
    ) {
      errors.push(maxItemsError(`${prefix}.mcpServers`, limits.workflowStepMcpServersMaxItems))
    }

    const allowedTools = step.allowedTools
    if (!isPlainObject(allowedTools)) return
    const include = allowedTools.include
    if (Array.isArray(include) && include.length > limits.workflowStepAllowedToolsMaxItems) {
      errors.push(
        maxItemsError(`${prefix}.allowedTools.include`, limits.workflowStepAllowedToolsMaxItems)
      )
    }
  })

  return errors
}

export async function validateWorkflowRecipeEgressPreflight(
  spec: unknown,
  options: { resolveDns?: DnsResolver } = {}
): Promise<WorkflowRecipeLimitError[]> {
  const errors: WorkflowRecipeLimitError[] = []
  if (!isPlainObject(spec)) return errors

  const workloads = spec.workloads
  const siblingIds = collectWorkloadIds(workloads)
  if (Array.isArray(workloads)) {
    await Promise.all(
      workloads.map(async (workload, index) => {
        if (!isPlainObject(workload)) return
        if (workload.egressBindings === undefined) return
        const fieldPrefix = `spec.workloads[${index}].egressBindings`
        if (!workload.transport) {
          rejectNonTransportPublicWebBindings(workload.egressBindings, fieldPrefix, errors)
        }
        // Cluster-local sibling refs intentionally bypass public-DNS strictness,
        // but must mirror WRC's sibling and namespace guard before install.
        const externalBindings = filterAndValidateClusterLocalBindings(
          workload.egressBindings,
          fieldPrefix,
          Boolean(workload.transport),
          siblingIds,
          config.sandboxNamespace,
          errors
        )
        const preflightErrors = await validateEgressBindingsPreflight(
          externalBindings,
          fieldPrefix,
          {
            ...options,
            allowCidr: false,
          }
        )
        errors.push(...preflightErrors)
      })
    )
  }

  const runtimeEgress = spec.runtimeEgress
  const runtimeHttp =
    isPlainObject(runtimeEgress) && isPlainObject(runtimeEgress.http)
      ? runtimeEgress.http
      : undefined
  if (isPlainObject(runtimeEgress) && isPlainObject(runtimeEgress.http)) {
    const http = runtimeEgress.http
    if (http.egressClass === 'public-web') {
      if (Array.isArray(http.allowedHosts) && http.allowedHosts.length > 0) {
        errors.push({
          field: 'spec.runtimeEgress.http.allowedHosts',
          message: 'allowedHosts must be omitted when egressClass is public-web',
        })
      }
    } else if (Array.isArray(http.allowedHosts)) {
      const syntheticBindings = http.allowedHosts.map(host => ({ dns: host, port: 443 }))
      const preflightErrors = await validateEgressBindingsPreflight(
        syntheticBindings,
        'spec.runtimeEgress.http.allowedHosts',
        options
      )
      errors.push(...preflightErrors)
    }
  }

  const steps = spec.steps
  if (Array.isArray(steps)) {
    await Promise.all(
      steps.map(async (step, index) => {
        if (!isPlainObject(step)) return
        const run = isPlainObject(step.run) ? step.run : undefined
        const capabilities = isPlainObject(run?.capabilities) ? run.capabilities : undefined
        const http = isPlainObject(capabilities?.http) ? capabilities.http : undefined
        if (!http) return
        if (http.egressClass === 'public-web') {
          if (runtimeHttp?.egressClass !== 'public-web') {
            errors.push({
              field: `spec.steps[${index}].run.capabilities.http.egressClass`,
              message: 'public-web requires spec.runtimeEgress.http.egressClass public-web',
            })
          }
          if (Array.isArray(http.allowedHosts) && http.allowedHosts.length > 0) {
            errors.push({
              field: `spec.steps[${index}].run.capabilities.http.allowedHosts`,
              message: 'allowedHosts must be omitted when egressClass is public-web',
            })
          }
          return
        }
        if (!Array.isArray(http.allowedHosts)) return
        if (runtimeHttp?.egressClass === 'public-web') {
          errors.push({
            field: `spec.steps[${index}].run.capabilities.http.allowedHosts`,
            message:
              'allowedHosts cannot be used when spec.runtimeEgress.http.egressClass is public-web',
          })
          return
        }
        const syntheticBindings = http.allowedHosts.map(host => ({ dns: host, port: 443 }))
        const preflightErrors = await validateEgressBindingsPreflight(
          syntheticBindings,
          `spec.steps[${index}].run.capabilities.http.allowedHosts`,
          options
        )
        errors.push(...preflightErrors)
      })
    )
  }

  return errors
}
