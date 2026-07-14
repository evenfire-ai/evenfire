import type { Request, Response } from 'express'

export const CONTROL_UI_ADMIN_SESSION_COOKIE = 'control_ui_admin_session'

function isSecureRequest(req: Request): boolean {
  return process.env.NODE_ENV === 'production' || req.protocol === 'https'
}

// Kept in sync with external-rest-api/src/sessionCookie.ts. The services ship
// separately, so avoid depending on a cross-service source file at runtime.
export function readCookie(req: Request, name: string): string {
  const raw = String(req.header('cookie') || '')
  if (!raw) return ''

  for (const part of raw.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=')
    if (rawName !== name) continue
    try {
      return decodeURIComponent(rawValue.join('='))
    } catch {
      return rawValue.join('=')
    }
  }
  return ''
}

export function setHttpOnlySessionCookie(
  req: Request,
  res: Response,
  name: string,
  token: string,
  maxAgeSeconds: number
): void {
  res.cookie(name, token, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  })
}

export function clearHttpOnlySessionCookie(req: Request, res: Response, name: string): void {
  res.clearCookie(name, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'lax',
    path: '/',
  })
}
