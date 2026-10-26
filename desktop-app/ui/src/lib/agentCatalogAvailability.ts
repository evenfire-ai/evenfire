import { httpErrorStatus, isAuthorizationError, isNetworkError } from './format'

export type AgentCatalogAvailability = 'ready' | 'checking' | 'error' | 'available' | 'unavailable'

export interface AgentCatalogAvailabilityInput {
  selectedAgent: string | null
  loading: boolean
  error: string | null
  catalogMatchesSession: boolean
  agentNames: readonly string[]
}

/** Resolve composer availability without reusing a mismatched catalog as current-team authority. */
export function resolveAgentCatalogAvailability(
  input: AgentCatalogAvailabilityInput
): AgentCatalogAvailability {
  const selectedAgent = input.selectedAgent
  if (!selectedAgent) return 'ready'

  const hasConfirmedSelection =
    input.catalogMatchesSession && input.agentNames.includes(selectedAgent)
  if (input.error !== null) {
    if (isAuthorizationError(input.error)) return 'error'

    const status = httpErrorStatus(input.error)
    const isServerFailure = status !== undefined && status >= 500 && status < 600
    const isTransientFailure = isNetworkError(input.error) || isServerFailure
    return hasConfirmedSelection && isTransientFailure ? 'available' : 'error'
  }

  if (input.loading) {
    if (hasConfirmedSelection) return 'available'
    return 'checking'
  }
  if (!input.catalogMatchesSession) return 'checking'
  return hasConfirmedSelection ? 'available' : 'unavailable'
}
