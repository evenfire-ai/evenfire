export type AgentCatalogAvailability = 'ready' | 'checking' | 'error' | 'available' | 'unavailable'

export interface AgentCatalogAvailabilityInput {
  selectedAgent: string | null
  loading: boolean
  error: string | null
  catalogMatchesSession: boolean
  agentNames: readonly string[]
}

/** Resolve the composer state without treating stale catalog data as current-team authority. */
export function resolveAgentCatalogAvailability(
  input: AgentCatalogAvailabilityInput
): AgentCatalogAvailability {
  if (!input.selectedAgent) return 'ready'
  if (input.loading) return 'checking'
  if (input.error !== null) return 'error'
  if (!input.catalogMatchesSession) return 'checking'
  return input.agentNames.includes(input.selectedAgent) ? 'available' : 'unavailable'
}
