import type { WorkflowBrokerClient } from './workflowBrokerClient'
import {
  nonUniqueEffectiveTargetResponse,
  requestEffectiveWorkflowList,
  resolveEffectiveWorkflowTarget,
  shouldResolveEffectiveWorkflowTargets,
} from './workflowEffectiveTargets'
import {
  WORKFLOW_RECIPE_NAMESPACE,
  type WorkflowCallerContext,
  getObject,
  getString,
  requireWorkflowRef,
} from './workflowShared'

export type EffectiveWorkflowTriggerParams = {
  namespace: string
  name: string
  targetUserId?: string
  targetTeamId?: string
  targetLabel?: string
  approvalMessage?: string
  idempotencyKey?: string
  timeoutSeconds?: number
  inputs?: Record<string, unknown>
  intermediateParameters?: Record<string, unknown>
  outputOverrides?: Record<string, unknown>
}

export const AUTHENTICATED_CHAT_APPROVAL_TIMEOUT_SECONDS = 180

function normalizeTargetLabelText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

function messageMentionsTargetLabel(message: string | undefined, targetLabel: string): boolean {
  const normalizedMessage = normalizeTargetLabelText(message || '')
  const normalizedLabel = normalizeTargetLabelText(targetLabel)
  return Boolean(normalizedLabel && normalizedMessage.includes(normalizedLabel))
}

function targetLabelIsWorkflowName(targetLabel: string, workflowName: string): boolean {
  return normalizeTargetLabelText(targetLabel) === normalizeTargetLabelText(workflowName)
}

function normalizeWorkflowName(value: string): string {
  return value.trim().toLowerCase()
}

function isAlphaNum(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')
}

function isWorkflowNameChar(ch: string): boolean {
  return isAlphaNum(ch) || ch === '-' || ch === '.'
}

function isSpecificWorkflowNameToken(value: string): boolean {
  const candidate = normalizeWorkflowName(value)
  if (candidate.length < 3 || candidate.length > 253) return false
  if (!candidate.includes('-') && !candidate.includes('.')) return false
  if (!isAlphaNum(candidate[0] || '')) return false
  if (!isAlphaNum(candidate[candidate.length - 1] || '')) return false
  return [...candidate].every(isWorkflowNameChar)
}

function firstWorkflowNameCandidate(value: string): string {
  let candidate = ''
  for (const ch of normalizeWorkflowName(value)) {
    if (!isWorkflowNameChar(ch)) break
    candidate += ch
  }
  return isSpecificWorkflowNameToken(candidate) ? candidate : ''
}

function workflowNameAfterPhrase(message: string, phrase: string): string {
  const start = message.indexOf(phrase)
  if (start < 0) return ''
  return firstWorkflowNameCandidate(message.slice(start + phrase.length))
}

function requestedWorkflowNameFromMessage(message: string | undefined): string {
  const normalized = normalizeWorkflowName(message || '')
  for (const phrase of ['workflow recipe named ', 'recipe named ', 'workflow named ']) {
    const name = workflowNameAfterPhrase(normalized, phrase)
    if (name) return name
  }
  for (const verb of ['run ', 'trigger ', 'start ', 'execute ']) {
    const start = normalized.indexOf(verb)
    if (start < 0) continue
    let rest = normalized.slice(start + verb.length)
    if (rest.startsWith('the ')) rest = rest.slice(4)
    const name = firstWorkflowNameCandidate(rest)
    if (name) return name
  }
  return ''
}

function workflowNamesFromEffectiveList(value: unknown): string[] {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const items = Array.isArray(record.items) ? record.items : []
  return items.flatMap(item => {
    const workflow =
      item && typeof item === 'object' && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : {}
    const name = typeof workflow.name === 'string' ? workflow.name.trim() : ''
    return name ? [name] : []
  })
}

function editDistance(left: string, right: string): number {
  const a = normalizeWorkflowName(left)
  const b = normalizeWorkflowName(right)
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  const current = new Array<number>(b.length + 1)
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + substitutionCost)
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[b.length] ?? Number.POSITIVE_INFINITY
}

function suggestedWorkflowName(requestedName: string, availableNames: string[]): string {
  let best = ''
  let bestDistance = Number.POSITIVE_INFINITY
  for (const name of availableNames) {
    const distance = editDistance(requestedName, name)
    if (distance < bestDistance) {
      best = name
      bestDistance = distance
    }
  }
  if (!best) return ''
  const maxDistance = Math.max(2, Math.floor(Math.max(requestedName.length, best.length) * 0.2))
  return bestDistance <= maxDistance ? best : ''
}

async function workflowNameUnavailableResponse(params: {
  client: WorkflowBrokerClient
  context: WorkflowCallerContext & { targetUserId: string }
  workflowName: string
}): Promise<Record<string, unknown> | null> {
  let effectiveList: unknown
  try {
    effectiveList = await requestEffectiveWorkflowList(params.client, params.context)
  } catch {
    return null
  }
  const availableNames = workflowNamesFromEffectiveList(effectiveList)
  const requested = normalizeWorkflowName(params.workflowName)
  if (availableNames.some(name => normalizeWorkflowName(name) === requested)) return null

  const suggestion = suggestedWorkflowName(params.workflowName, availableNames)
  return {
    workflowName: params.workflowName,
    status: 'workflow_not_found',
    message: suggestion
      ? `Workflow not found: ${params.workflowName}. Did you mean ${suggestion}?`
      : `Workflow not found: ${params.workflowName}. Use workflow_list to see available workflows.`,
    ...(suggestion ? { suggestedWorkflowName: suggestion } : {}),
  }
}

export function isApprovalTargetFallbackError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    error.message.includes('Approval request failed (403)') ||
    error.message.includes('approval_target_not_allowed')
  )
}

export function validateAuthenticatedChatWorkflowTriggerParams(
  params: Record<string, unknown>,
  workflowCallerContext: WorkflowCallerContext | null
): {
  namespace: string
  name: string
  nameFromSourceMessage?: boolean
  targetLabel?: string
  inputs?: Record<string, unknown>
} {
  const { namespace, name } = requireWorkflowRef(params, WORKFLOW_RECIPE_NAMESPACE)
  const targetUserId = getString(params, 'targetUserId')
  const targetTeamId = getString(params, 'targetTeamId')
  if (targetUserId) {
    throw new Error('workflow_trigger target user is derived from the authenticated conversation')
  }
  if (targetTeamId) {
    throw new Error('workflow_trigger target team is derived from the authenticated conversation')
  }
  if (getString(params, 'idempotencyKey')) {
    throw new Error('workflow_trigger idempotencyKey is derived by the runtime')
  }
  if (getString(params, 'approvalMessage')) {
    throw new Error('workflow_trigger approvalMessage is derived by the runtime')
  }
  if (typeof params.timeoutSeconds === 'number' && Number.isFinite(params.timeoutSeconds)) {
    throw new Error('workflow_trigger timeoutSeconds is derived by the runtime')
  }
  if (getObject(params, 'intermediateParameters')) {
    throw new Error('workflow_trigger intermediateParameters are not accepted from agent chat')
  }
  if (getObject(params, 'outputOverrides')) {
    throw new Error('workflow_trigger outputOverrides are not accepted from agent chat')
  }
  const targetLabel = getString(params, 'targetLabel')
  const sourceMessageContent = workflowCallerContext?.sourceMessageContent
  const requestedName = requestedWorkflowNameFromMessage(sourceMessageContent)
  const effectiveName = requestedName || name
  const acceptedTargetLabel =
    !targetLabelIsWorkflowName(targetLabel, effectiveName) &&
    messageMentionsTargetLabel(sourceMessageContent, targetLabel)
      ? targetLabel
      : ''
  return {
    namespace,
    name: effectiveName,
    ...(requestedName ? { nameFromSourceMessage: true } : {}),
    ...(acceptedTargetLabel ? { targetLabel: acceptedTargetLabel } : {}),
    inputs: getObject(params, 'inputs') || undefined,
  }
}

export async function resolveAuthenticatedChatWorkflowTriggerParams(params: {
  client: WorkflowBrokerClient
  workflowCallerContext: WorkflowCallerContext | null
  triggerParams: Record<string, unknown>
}): Promise<EffectiveWorkflowTriggerParams | Record<string, unknown>> {
  if (!shouldResolveEffectiveWorkflowTargets(params.workflowCallerContext)) {
    throw new Error('authenticated conversation is missing workflow user context')
  }
  const context = params.workflowCallerContext
  const base = validateAuthenticatedChatWorkflowTriggerParams(params.triggerParams, context)
  const resolution = await resolveEffectiveWorkflowTarget(params.client, context, base.name)
  if (resolution.kind === 'unique') {
    return {
      namespace: base.namespace,
      name: base.name,
      targetLabel: resolution.label,
      timeoutSeconds: AUTHENTICATED_CHAT_APPROVAL_TIMEOUT_SECONDS,
      inputs: base.inputs,
      ...resolution.approvalTarget,
    }
  }

  if (resolution.kind === 'ambiguous' && base.targetLabel) {
    const labeledResolution = await resolveEffectiveWorkflowTarget(
      params.client,
      context,
      base.name,
      base.targetLabel
    )
    if (labeledResolution.kind === 'unique') {
      return {
        namespace: base.namespace,
        name: base.name,
        targetLabel: labeledResolution.label,
        timeoutSeconds: AUTHENTICATED_CHAT_APPROVAL_TIMEOUT_SECONDS,
        inputs: base.inputs,
        ...labeledResolution.approvalTarget,
      }
    }
  }

  if (resolution.kind === 'none' && base.nameFromSourceMessage) {
    const unavailable = await workflowNameUnavailableResponse({
      client: params.client,
      context,
      workflowName: base.name,
    })
    if (unavailable) return unavailable
  }

  return nonUniqueEffectiveTargetResponse(base.name, resolution)
}
