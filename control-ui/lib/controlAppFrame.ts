const PUBLIC_CONTROL_UI_PREFIXES = [
  '/admin-email-confirmations',
  '/admin-invitations',
  '/admin-password-resets',
] as const

export function isPublicControlUiPath(pathname: string): boolean {
  if (pathname === '/') return true
  return PUBLIC_CONTROL_UI_PREFIXES.some(
    prefix => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
}
