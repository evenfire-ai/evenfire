import { Request } from 'express'

export function extractBearerToken(req: Request): string {
  const raw = String(req.header('authorization') || '').trim()
  if (/^bearer\s+/i.test(raw)) {
    return raw.replace(/^bearer\s+/i, '').trim()
  }
  return ''
}
