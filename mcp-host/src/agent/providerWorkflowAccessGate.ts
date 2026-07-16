import type { IncomingMessage } from '../server/types'

export type ProviderWorkflowChannel = 'telegram' | 'slack' | 'teams'

export type ProviderWorkflowAccessDenialReason =
  | 'missing_provider_identity'
  | 'unverified_provider_identity'

export function isProviderWorkflowChannel(
  channelType: string | undefined
): channelType is ProviderWorkflowChannel {
  return channelType === 'telegram' || channelType === 'slack' || channelType === 'teams'
}

export function workflowAccessDeniedResponse(channelType: ProviderWorkflowChannel): string {
  if (channelType === 'slack') {
    return 'Could not verify this Slack workspace conversation for workflow access. Use the verified Slack workspace conversation connected to your Clerum account, then list workflows again.'
  }
  if (channelType === 'teams') {
    return 'Could not verify this Microsoft Teams conversation for workflow access. Use the verified Teams conversation connected to your Clerum account, then list workflows again.'
  }
  return 'Could not verify this Telegram conversation for workflow access. Use the verified Telegram conversation connected to your Clerum account, then list workflows again.'
}

export function workflowAccessDeniedResponseForMessage(
  message: IncomingMessage | undefined
): string | null {
  if (!message || !isProviderWorkflowChannel(message.channelType)) return null
  return workflowAccessDeniedResponse(message.channelType)
}

export function looksLikeWorkflowTriggerSuccess(content: string): boolean {
  const normalized = normalize(content)
  return (
    /\bworkflow\b[\s\S]{0,180}\b(triggered|started|submitted|queued)\b/.test(normalized) ||
    /\b(triggered|started|submitted|queued)\b[\s\S]{0,180}\bworkflow\b/.test(normalized)
  )
}

export function looksLikeWorkflowTriggerRequest(content: string): boolean {
  const normalized = normalize(content)
  const explicitNamedTriggerRequest =
    /\b(run|trigger|start|execute)\s+(?:the\s+)?(?:workflow\s+)?(?:recipe\s+)?named\s+[a-z0-9][a-z0-9._-]*\b/.test(
      normalized
    ) ||
    /\b(run|trigger|start|execute)\s+(?:the\s+)?(?:workflow\s+)?(?:recipe\s+)?[a-z0-9][a-z0-9._-]*-[a-z0-9._-]*\b/.test(
      normalized
    )

  if (looksLikeWorkflowListingRequest(normalized) && !explicitNamedTriggerRequest) return false

  return (
    explicitNamedTriggerRequest ||
    /\b(run|trigger|start|execute)\b[\s\S]{0,90}\b(workflow|workflow recipe|recipe named)\b/.test(
      normalized
    ) ||
    /\b(ejecuta|ejecutar|corre|correr|lanza|lanzar|inicia|iniciar)\b[\s\S]{0,90}\b(workflow|flujo|receta)\b/.test(
      normalized
    )
  )
}

export function looksLikeWorkflowAccessRequest(content: string): boolean {
  const normalized = normalize(content)
  if (!normalized) return false

  if (looksLikeWorkflowDefinitionQuestion(normalized)) return false

  return (
    looksLikeWorkflowListingRequest(normalized) ||
    looksLikeWorkflowTriggerRequest(normalized) ||
    looksLikeWorkflowDetailRequest(normalized) ||
    looksLikeWorkflowRunReadRequest(normalized) ||
    looksLikeWorkflowApprovalRequest(normalized)
  )
}

function normalize(content: string): string {
  return content.toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim()
}

function looksLikeWorkflowDefinitionQuestion(normalized: string): boolean {
  return (
    /^(what is|what are|explain|define|describe)\s+(a\s+|the\s+)?workflows?\??$/.test(normalized) ||
    /^(que es|que son|explica|define|describe)\s+(un\s+|los\s+|las\s+)?(workflow|workflows|flujo|flujos)\??$/.test(
      normalized
    )
  )
}

function looksLikeWorkflowListingRequest(normalized: string): boolean {
  return (
    /\b(list|show|see|view|display|get|find)\b[\s\S]{0,90}\b(available\s+)?workflow(s| recipes)?\b/.test(
      normalized
    ) ||
    /\bworkflow(s| recipes)?\b[\s\S]{0,90}\b(available|visible|can run|can trigger|i can run|i can trigger|list)\b/.test(
      normalized
    ) ||
    /\bwhat workflows\b[\s\S]{0,90}\b(available|can|visible|run|trigger)\b/.test(normalized) ||
    /\b(lista|listar|muestra|mostrar|ver|dame)\b[\s\S]{0,90}\b(workflows?|flujos?|recetas?)\b/.test(
      normalized
    ) ||
    /\b(workflows?|flujos?|recetas?)\b[\s\S]{0,90}\b(disponibles|puedo ejecutar|puedo correr|puedo lanzar)\b/.test(
      normalized
    )
  )
}

function looksLikeWorkflowDetailRequest(normalized: string): boolean {
  return (
    /\b(read|open|show|get|inspect)\b[\s\S]{0,90}\b(workflow|workflow recipe)\b/.test(normalized) ||
    /\bworkflow\b[\s\S]{0,90}\b(details|definition|inputs|schema|metadata)\b/.test(normalized)
  )
}

function looksLikeWorkflowRunReadRequest(normalized: string): boolean {
  return (
    /\bworkflow\b[\s\S]{0,110}\b(status|health|result|output|artifact|download|latest run|run)\b/.test(
      normalized
    ) ||
    /\b(status|health|result|output|artifact|download|latest run)\b[\s\S]{0,110}\bworkflow\b/.test(
      normalized
    )
  )
}

function looksLikeWorkflowApprovalRequest(normalized: string): boolean {
  return (
    /^\/(approve|deny|reject)\b/.test(normalized) ||
    /\b(approve|deny|reject|confirm)\b[\s\S]{0,90}\b(workflow|approval)\b/.test(normalized) ||
    /\b(aprobar|denegar|rechazar|confirmar)\b[\s\S]{0,90}\b(workflow|flujo|aprobacion)\b/.test(
      normalized
    )
  )
}
