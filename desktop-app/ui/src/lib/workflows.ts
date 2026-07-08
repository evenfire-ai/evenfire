import type { WorkflowRecipeResource } from '../../../src/types'
import type { WorkflowSummary } from '../workflows.types'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function canTriggerWorkflowAsUser(resource: WorkflowRecipeResource): boolean {
  const spec = asRecord(resource.spec)
  const triggers = asRecord(spec?.triggers)
  const onDemand = asRecord(triggers?.onDemand)
  if (!onDemand) return false

  const allowedActors = onDemand.allowedActors
  if (!Array.isArray(allowedActors)) return true
  return allowedActors.includes('user')
}

export function summarizeWorkflowResource(resource: WorkflowRecipeResource): WorkflowSummary {
  return {
    namespace: resource.metadata?.namespace || 'default',
    name: resource.metadata?.name || 'unknown',
    status: resource.status?.phase,
    createdAt: resource.metadata?.creationTimestamp,
    triggerableByUser: canTriggerWorkflowAsUser(resource),
  }
}
