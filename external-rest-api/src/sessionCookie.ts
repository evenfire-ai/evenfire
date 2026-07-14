import type { Request, Response } from 'express'
import { config } from './config.js'

export const PROFILE_SESSION_COOKIE = 'profile_session'

function isSecureRequest(req: Request): boolean {
  return process.env.NODE_ENV === 'production' || req.protocol === 'https'
}

// Kept in sync with control-api/src/utils/auth/sessionCookies.ts. The services
// ship separately, so avoid depending on a cross-service source file at runtime.
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

export function setProfileSessionCookie(req: Request, res: Response, token: string): void {
  res.cookie(PROFILE_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'lax',
    path: '/',
    maxAge: config.profileSessionCookieTtlSeconds * 1000,
  })
}

export function clearProfileSessionCookie(req: Request, res: Response): void {
  res.clearCookie(PROFILE_SESSION_COOKIE, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'lax',
    path: '/',
  })
}
