const STATIC_AUTH_TYPES = new Set(['bearer', 'basic', 'apiKey'])

export function connectorAuthenticationLabel(authType: unknown): string {
  if (authType === 'oauth') return 'OAuth'
  if (typeof authType === 'string' && STATIC_AUTH_TYPES.has(authType)) {
    return 'Static credentials'
  }
  if (authType == null || authType === 'none') return 'No authentication'
  return 'Other'
}
