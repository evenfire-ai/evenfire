const TRANSIENT_TEAM_CONTEXT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown error')
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const record = error as { code?: unknown; cause?: { code?: unknown } }
  return String(record.code || record.cause?.code || '').toUpperCase()
}

export function isTransientSandboxUiTeamContextError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase()
  if (
    /\b(400|401|403|404)\b/.test(message) ||
    message.includes('access denied') ||
    message.includes('authenticat') ||
    message.includes('forbidden') ||
    message.includes('not a member') ||
    message.includes('permission') ||
    message.includes('select a team') ||
    message.includes('teamid is required') ||
    message.includes('validation')
  ) {
    return false
  }

  const code = errorCode(error)
  if (TRANSIENT_TEAM_CONTEXT_ERROR_CODES.has(code)) return true

  return (
    message.includes('connection refused') ||
    message.includes('connection reset') ||
    message.includes('fetch failed') ||
    message.includes('network error') ||
    message.includes('socket hang up') ||
    message.includes('temporarily unavailable') ||
    message.includes('timed out') ||
    message.includes('timeout')
  )
}
