import { httpErrorStatus, isAuthorizationError } from './format'

export type AgentCatalogAvailability = 'ready' | 'checking' | 'error' | 'available' | 'unavailable'

export interface AgentCatalogAvailabilityInput {
  selectedAgent: string | null
  loading: boolean
  error: string | null
  catalogMatchesSession: boolean
  agentNames: readonly string[]
}

const ACCESS_CATALOG_REFRESH_IPC_PREFIX = "Error invoking remote method 'access:refreshCatalog': "
const ACCESS_CATALOG_HTTP_ERROR_PATTERN = /^Error: ([1-5]\d{2}) [^\r\n]*:/
const ACCESS_CATALOG_TRANSPORT_MESSAGES = [
  'TypeError: fetch failed',
  'TimeoutError: The operation was aborted due to timeout',
]

/** Read status only from requestJson's HTTP ApiError producer shape. */
function accessCatalogHttpErrorStatus(message: string): number | undefined {
  if (!message.startsWith(ACCESS_CATALOG_REFRESH_IPC_PREFIX)) return undefined
  const producerMessage = message.slice(ACCESS_CATALOG_REFRESH_IPC_PREFIX.length)
  const producerStatus = ACCESS_CATALOG_HTTP_ERROR_PATTERN.exec(producerMessage)?.[1]
  if (!producerStatus) return undefined

  const status = httpErrorStatus(message)
  return status === Number(producerStatus) ? status : undefined
}

/** Match only statusless transport messages emitted by the real catalog IPC producer. */
function isAccessCatalogTransportFailure(message: string): boolean {
  if (!message.startsWith(ACCESS_CATALOG_REFRESH_IPC_PREFIX)) return false
  return ACCESS_CATALOG_TRANSPORT_MESSAGES.includes(
    message.slice(ACCESS_CATALOG_REFRESH_IPC_PREFIX.length)
  )
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
    const status = accessCatalogHttpErrorStatus(input.error)
    if (status !== undefined) {
      const isServerFailure = status >= 500 && status < 600
      return hasConfirmedSelection && isServerFailure ? 'available' : 'error'
    }

    if (isAuthorizationError(input.error)) return 'error'
    const isTransportFailure = isAccessCatalogTransportFailure(input.error)
    return hasConfirmedSelection && isTransportFailure ? 'available' : 'error'
  }

  if (input.loading) {
    if (hasConfirmedSelection) return 'available'
    return 'checking'
  }
  if (!input.catalogMatchesSession) return 'checking'
  return hasConfirmedSelection ? 'available' : 'unavailable'
}
