import type { WorkflowRecipeSpec } from '../types'
import type { WorkflowConfig } from './types'

const MAX_EGRESS_BINDINGS = 20

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function findDuplicateStepId(steps: WorkflowRecipeSpec['steps']): string | undefined {
  const seen = new Set<string>()
  for (const step of steps ?? []) {
    if (seen.has(step.id)) return step.id
    seen.add(step.id)
  }
  return undefined
}

export function validateWorkflowRecipeLimits(
  spec: WorkflowRecipeSpec,
  config: Pick<
    WorkflowConfig,
    | 'workflowMaxWorkloadsPerRecipe'
    | 'workflowUiEgressInternalMaxItems'
    | 'workflowMaxSteps'
    | 'workflowStepDependsOnMaxItems'
    | 'workflowStepAllowedToolsMaxItems'
    | 'workflowStepMcpServersMaxItems'
    | 'workflowMaxRunDurationSeconds'
    | 'workflowStatefulSetMaxReplicas'
    | 'workflowStatefulSetMaxVolumeClaimTemplates'
    | 'workflowStatefulSetMaxPvcPreflightChecks'
  >
): string | undefined {
  const workloads = spec.workloads ?? []
  if (workloads.length > config.workflowMaxWorkloadsPerRecipe) {
    return `spec.workloads must contain at most ${config.workflowMaxWorkloadsPerRecipe} items`
  }

  const uiEgressInternal = spec.ui?.egress?.internal ?? []
  if (uiEgressInternal.length > config.workflowUiEgressInternalMaxItems) {
    return `spec.ui.egress.internal must contain at most ${config.workflowUiEgressInternalMaxItems} items`
  }

  const steps = spec.steps ?? []
  if (steps.length > config.workflowMaxSteps) {
    return `spec.steps must contain at most ${config.workflowMaxSteps} items`
  }
  const duplicateStepId = findDuplicateStepId(steps)
  if (duplicateStepId) {
    return `duplicate step id "${duplicateStepId}" is not allowed`
  }
  const maxRunDurationSeconds = spec.runRetention?.maxRunDurationSeconds
  if (maxRunDurationSeconds !== undefined) {
    if (!Number.isInteger(maxRunDurationSeconds) || maxRunDurationSeconds < 1) {
      return 'spec.runRetention.maxRunDurationSeconds must be a positive integer'
    }
    if (maxRunDurationSeconds > config.workflowMaxRunDurationSeconds) {
      return `spec.runRetention.maxRunDurationSeconds must be at most ${config.workflowMaxRunDurationSeconds}`
    }
  }

  for (const [index, workload] of workloads.entries()) {
    if ((workload.egressBindings ?? []).length > MAX_EGRESS_BINDINGS) {
      return `spec.workloads[${index}].egressBindings must contain at most ${MAX_EGRESS_BINDINGS} items`
    }
    if (workload.type === 'statefulset') {
      const replicas = workload.replicas ?? 1
      if (replicas > config.workflowStatefulSetMaxReplicas) {
        return `spec.workloads[${index}].replicas must be at most ${config.workflowStatefulSetMaxReplicas}`
      }
      const volumeClaimTemplates = workload.volumeClaimTemplates ?? []
      if (volumeClaimTemplates.length > config.workflowStatefulSetMaxVolumeClaimTemplates) {
        return `spec.workloads[${index}].volumeClaimTemplates must contain at most ${config.workflowStatefulSetMaxVolumeClaimTemplates} items`
      }
      if (
        replicas * volumeClaimTemplates.length >
        config.workflowStatefulSetMaxPvcPreflightChecks
      ) {
        return `spec.workloads[${index}] StatefulSet PVC ownership checks must be at most ${config.workflowStatefulSetMaxPvcPreflightChecks}`
      }
    }
  }

  const runtimeAllowedHosts = spec.runtimeEgress?.http?.allowedHosts
  if (runtimeAllowedHosts && runtimeAllowedHosts.length > MAX_EGRESS_BINDINGS) {
    return `spec.runtimeEgress.http.allowedHosts must contain at most ${MAX_EGRESS_BINDINGS} items`
  }

  for (const [index, step] of steps.entries()) {
    const prefix = `spec.steps[${index}]`
    if ((step.dependsOn ?? []).length > config.workflowStepDependsOnMaxItems) {
      return `${prefix}.dependsOn must contain at most ${config.workflowStepDependsOnMaxItems} items`
    }
    if ((step.mcpServers ?? []).length > config.workflowStepMcpServersMaxItems) {
      return `${prefix}.mcpServers must contain at most ${config.workflowStepMcpServersMaxItems} items`
    }

    const allowedTools = (step as { allowedTools?: unknown }).allowedTools
    if (isRecord(allowedTools)) {
      const include = allowedTools.include
      if (Array.isArray(include) && include.length > config.workflowStepAllowedToolsMaxItems) {
        return `${prefix}.allowedTools.include must contain at most ${config.workflowStepAllowedToolsMaxItems} items`
      }
    }

    const run = (step as { run?: unknown }).run
    const capabilities = isRecord(run) && isRecord(run.capabilities) ? run.capabilities : undefined
    const http = capabilities && isRecord(capabilities.http) ? capabilities.http : undefined
    const allowedHosts = http?.allowedHosts
    if (Array.isArray(allowedHosts) && allowedHosts.length > MAX_EGRESS_BINDINGS) {
      return `${prefix}.run.capabilities.http.allowedHosts must contain at most ${MAX_EGRESS_BINDINGS} items`
    }
  }

  return undefined
}
