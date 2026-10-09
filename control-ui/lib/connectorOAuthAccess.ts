export type ConnectorOAuthAccessSpec = {
  contextRef?: unknown
  oauth?: unknown
}

export const CONTEXT_OAUTH_SCOPE_ERROR =
  'This connector uses a shared OAuth identity and can only be assigned to agents in its original access scope.'

export function isContextScopedOAuthConnector(spec: ConnectorOAuthAccessSpec | undefined): boolean {
  return (
    Boolean(spec?.oauth) &&
    typeof spec?.oauth === 'object' &&
    (spec.oauth as { grantScope?: unknown }).grantScope === 'context'
  )
}

export function canAssignConnectorToContext(
  spec: ConnectorOAuthAccessSpec | undefined,
  targetContextRef: string
): boolean {
  if (!isContextScopedOAuthConnector(spec)) return true
  const authoritativeContextRef = String(spec?.contextRef ?? '').trim()
  return Boolean(authoritativeContextRef) && targetContextRef === authoritativeContextRef
}

export function connectorContextAssignmentError(
  spec: ConnectorOAuthAccessSpec | undefined,
  targetContextRefs: readonly string[]
): string | undefined {
  return targetContextRefs.every(contextRef => canAssignConnectorToContext(spec, contextRef))
    ? undefined
    : CONTEXT_OAUTH_SCOPE_ERROR
}

export const SHARED_GRANT_REQUIRES_AGENT_ERROR =
  'A shared OAuth identity needs at least one agent. Select the agents that will share it, or choose Per user.'

/**
 * Grant-scope check for a new install into the selected agents' Contexts. A
 * shared (per-context) grant is consented by members of its Context, so it needs
 * at least one agent — a generated private scope has no member to consent — and
 * every selected agent must share that one Context.
 */
export function sharedGrantScopeError(
  grantScope: string,
  selectedContextRefs: readonly string[]
): string | undefined {
  if (grantScope !== 'context') return undefined
  if (selectedContextRefs.length === 0) return SHARED_GRANT_REQUIRES_AGENT_ERROR
  return connectorContextAssignmentError(
    { contextRef: selectedContextRefs[0], oauth: { grantScope } },
    selectedContextRefs
  )
}
