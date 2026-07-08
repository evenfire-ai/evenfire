import { createHash } from 'node:crypto'
import type { WorkflowCallerContext } from './workflowShared'

type TargetSeed = { kind: 'user'; id: string } | { kind: 'team'; id: string }

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function boundedString(value: string | undefined | null, maxLength = 512): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > maxLength ? 'sha256:' + sha256(trimmed) : trimmed
}

function normalizedText(value: string | undefined): string | null {
  const bounded = boundedString(value?.replace(/\s+/g, ' '), 4096)
  return bounded
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(item => canonicalize(item))
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (typeof value !== 'object') return null

  const object = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(object).sort()) {
    const item = object[key]
    if (item === undefined) continue
    result[key] = canonicalize(item)
  }
  return result
}

export function canonicalWorkflowTriggerHash(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)))
}

export function workflowTriggerApprovalExecutionId(params: {
  caller: string
  namespace: string
  name: string
  targetUserId?: string
  targetTeamId?: string
  inputs?: Record<string, unknown>
  workflowCallerContext: WorkflowCallerContext | null
}): string | undefined {
  const context = params.workflowCallerContext
  if (!context) return undefined

  const target: TargetSeed = params.targetUserId
    ? { kind: 'user', id: params.targetUserId }
    : { kind: 'team', id: params.targetTeamId ?? '' }
  if (!target.id) return undefined

  const providerEventId = boundedString(context.providerEventId)
  const sourceMessageId = boundedString(context.sourceMessageId)
  const sourceMessage = normalizedText(context.sourceMessageContent)
  const requesterUserId = boundedString(context.targetUserId)

  const seed = {
    version: 'workflowTriggerApproval:v2',
    caller: params.caller,
    recipe: {
      namespace: params.namespace,
      name: params.name,
    },
    target,
    requester: requesterUserId
      ? {
          kind: 'user',
          id: requesterUserId,
        }
      : {
          kind: 'autonomous',
          id: null,
        },
    conversationId: boundedString(context.conversationId, 256),
    provider: {
      medium: context.originChannelType ?? null,
      userId: boundedString(context.providerUserId),
      workspaceId: boundedString(context.providerWorkspaceId ?? undefined),
      channelId: boundedString(context.providerChannelId),
      eventId: providerEventId,
      sourceMessageId: providerEventId ? null : sourceMessageId,
      sourceMessageHash: providerEventId || !sourceMessage ? null : sha256(sourceMessage),
    },
    inputsHash: canonicalWorkflowTriggerHash(params.inputs ?? {}),
  }

  return `workflow-trigger-approval-${canonicalWorkflowTriggerHash(seed)}`
}
