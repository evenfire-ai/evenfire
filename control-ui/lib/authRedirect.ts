import { CONTROL_ROUTES } from '@constants/routes'

const LOGIN_PATH = CONTROL_ROUTES.login
const RETURN_PATH_BASE = 'http://control-ui.local'

export function sanitizeControlUiReturnPath(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//')) return null

  try {
    const url = new URL(trimmed, RETURN_PATH_BASE)
    if (url.origin !== RETURN_PATH_BASE) return null
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return null
  }
}

export function getCurrentControlUiPath(): string {
  if (typeof window === 'undefined') return LOGIN_PATH

  if (window.location.pathname === LOGIN_PATH) {
    const currentNext = new URLSearchParams(window.location.search).get('next')
    const sanitizedNext = sanitizeControlUiReturnPath(currentNext)
    if (sanitizedNext) return sanitizedNext
  }

  const current = sanitizeControlUiReturnPath(
    `${window.location.pathname || LOGIN_PATH}${window.location.search || ''}${
      window.location.hash || ''
    }`
  )
  return current || LOGIN_PATH
}

export function buildControlUiLoginPath(returnTo: string | null | undefined): string {
  const safeReturnTo = sanitizeControlUiReturnPath(returnTo)
  if (!safeReturnTo || safeReturnTo === LOGIN_PATH) return LOGIN_PATH

  return CONTROL_ROUTES.loginWith({ next: safeReturnTo })
}
