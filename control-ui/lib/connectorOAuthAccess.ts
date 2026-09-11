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
