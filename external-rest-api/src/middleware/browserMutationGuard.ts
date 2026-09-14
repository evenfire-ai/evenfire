import type { NextFunction, Request, Response } from 'express'
import { config } from '../config.js'
import { publicCorrelationId } from '../http/publicApiError.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const SAFE_FETCH_SITES = new Set(['same-origin', 'same-site'])

function configuredOrigins(): Set<string> {
  if (config.corsOrigin === '*') {
    try {
      return new Set([new URL(config.publicBaseUrl).origin])
    } catch {
      return new Set()
    }
  }
  return new Set(config.corsOrigin)
}

function hasBearer(req: Request): boolean {
  return /^bearer\s+\S+/i.test(String(req.header('authorization') || '').trim())
}

function isBrowserMutation(req: Request): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase()) || hasBearer(req)) return false
  return Boolean(req.header('origin') || req.header('sec-fetch-site') || req.header('cookie'))
}

export function requireTrustedBrowserMutation(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!isBrowserMutation(req)) {
    next()
    return
  }

  const origin = String(req.header('origin') || '').trim()
  const fetchSite = String(req.header('sec-fetch-site') || '')
    .trim()
    .toLowerCase()
  if (
    !origin ||
    !configuredOrigins().has(origin) ||
    (fetchSite && !SAFE_FETCH_SITES.has(fetchSite))
  ) {
    res.status(403).json({
      error: {
        code: 'forbidden',
        message: 'The browser request origin is not allowed.',
        correlationId: publicCorrelationId(req),
        retryable: false,
      },
    })
    return
  }

  next()
}
