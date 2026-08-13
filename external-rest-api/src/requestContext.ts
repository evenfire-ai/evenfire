import type { NextFunction, Request } from 'express'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isIP } from 'node:net'

type ExternalRequestContext = { clientIp: string | null }
const storage = new AsyncLocalStorage<ExternalRequestContext>()

function trustedClientIp(req: Request): string | null {
  const ip = req.ip?.trim() || req.socket.remoteAddress?.trim() || ''
  return ip && isIP(ip) !== 0 ? ip : null
}

/** Install the proxy-attested client identity for every external-rest route. */
export function withExternalRequestContext(req: Request, _res: unknown, next: NextFunction): void {
  storage.run({ clientIp: trustedClientIp(req) }, next)
}

export function currentExternalClientIp(): string | null {
  return storage.getStore()?.clientIp ?? null
}
