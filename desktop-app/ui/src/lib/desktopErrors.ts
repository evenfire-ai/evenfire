const HCC_DESKTOP_STATUS_MESSAGE =
  'Desktop is unavailable because the backend readiness check failed. Refresh port-forwards and verify HCC/rpc-proxy desktop health before retrying.'

export function getDesktopErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '')
  const normalized = raw.toLowerCase()

  if (
    normalized.includes('hcc status check failed') ||
    normalized.includes('hcc readiness check failed') ||
    (/ 502\b/.test(normalized) && normalized.includes('desktop:getstatus'))
  ) {
    return HCC_DESKTOP_STATUS_MESSAGE
  }

  if (normalized.includes('desktop not running')) {
    return 'Desktop is not running for this agent.'
  }

  return raw || 'Desktop failed to open.'
}
