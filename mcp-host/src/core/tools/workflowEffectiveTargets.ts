import type { WorkflowBrokerClient } from './workflowBrokerClient'
import { WORKFLOW_RECIPE_NAMESPACE, type WorkflowCallerContext } from './workflowShared'

type EffectiveTargetLabel = {
  kind?: unknown
  label?: unknown
}

type EffectiveTargetResolution =
  | {
      kind: 'unique'
      approvalTarget: { targetUserId?: string; targetTeamId?: string }
      label: string
    }
  | {
      kind: 'none'
      message: string
    }
  | {
      kind: 'ambiguous'
      message: string
      targets: Array<{ kind: string; label: string }>
      duplicateLabels?: true
    }

export function shouldResolveEffectiveWorkflowTargets(
  context: WorkflowCallerContext | null
): context is WorkflowCallerContext & { targetUserId: string } {
  return Boolean(context?.targetUserId?.trim())
}

function targetLabels(value: unknown): Array<{ kind: string; label: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: EffectiveTargetLabel) => {
    if (!item || typeof item !== 'object') return []
    const kind = typeof item.kind === 'string' ? item.kind.trim() : ''
    const label = typeof item.label === 'string' ? item.label.trim() : ''
    return kind && label ? [{ kind, label }] : []
  })
}

function labelsText(targets: Array<{ label: string }>): string {
  return targets.map(target => target.label).join(', ')
}

export async function requestEffectiveWorkflowList(
  client: WorkflowBrokerClient,
  context: WorkflowCallerContext & { targetUserId: string }
): Promise<unknown> {
  return client.request('/api/v1/workflows/effective-targets/resolve', {
    method: 'POST',
    body: JSON.stringify({
      purpose: 'list',
      userId: context.targetUserId,
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
    }),
  })
}

export async function resolveEffectiveWorkflowTarget(
  client: WorkflowBrokerClient,
  context: WorkflowCallerContext & { targetUserId: string },
  workflowName: string,
  targetLabel?: string
): Promise<EffectiveTargetResolution> {
  const result = await client.request('/api/v1/workflows/effective-targets/resolve', {
    method: 'POST',
    body: JSON.stringify({
      purpose: 'trigger',
      userId: context.targetUserId,
      recipeNamespace: WORKFLOW_RECIPE_NAMESPACE,
      recipeName: workflowName,
      ...(targetLabel?.trim() ? { targetLabel: targetLabel.trim() } : {}),
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
    }),
  })

  const record =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {}
  if (record.status === 'unique') {
    const target =
      record.target && typeof record.target === 'object' && !Array.isArray(record.target)
        ? (record.target as Record<string, unknown>)
        : {}
    const label = typeof target.label === 'string' ? target.label.trim() : ''
    const userId = typeof target.userId === 'string' ? target.userId.trim() : ''
    const teamId = typeof target.teamId === 'string' ? target.teamId.trim() : ''
    if (userId) return { kind: 'unique', approvalTarget: { targetUserId: userId }, label }
    if (teamId) return { kind: 'unique', approvalTarget: { targetTeamId: teamId }, label }
  }

  if (record.status === 'ambiguous') {
    const targets = targetLabels(record.targets)
    const duplicateLabels = record.duplicateLabels === true
    return {
      kind: 'ambiguous',
      targets,
      ...(duplicateLabels ? { duplicateLabels } : {}),
      message: duplicateLabels
        ? `${workflowName} has duplicate target labels. Resolve the duplicate team names in Control UI before triggering it from chat.`
        : `${workflowName} is available for multiple targets: ${labelsText(targets)}. Ask the user to choose one of these labels.`,
    }
  }

  return {
    kind: 'none',
    message: `${workflowName} is not available for this conversation target.`,
  }
}

export function nonUniqueEffectiveTargetResponse(
  workflowName: string,
  resolution: Exclude<EffectiveTargetResolution, { kind: 'unique' }>
): Record<string, unknown> {
  return {
    workflowName,
    status: resolution.kind === 'none' ? 'not_available' : 'needs_clarification',
    message: resolution.message,
    ...(resolution.kind === 'ambiguous' ? { targets: resolution.targets } : {}),
    ...(resolution.kind === 'ambiguous' && resolution.duplicateLabels
      ? { duplicateLabels: true }
      : {}),
  }
}
