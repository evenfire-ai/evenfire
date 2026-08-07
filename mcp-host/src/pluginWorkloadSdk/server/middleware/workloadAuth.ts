import type { NextFunction, Request, Response } from 'express'
import { timingSafeEqual } from 'crypto'
import { PluginWorkloadError } from '../../domain/errors'

/**
 * Workload token extraction and validation (plan §3.1).
 *
 * Plugin workloads authenticate with a per-caller bearer token injected by the
 * WRC reconciler (Phase 3.6). The SDK server loads all allowed tokens from the
 * recipe Secret volume and derives the immutable callerRef from the token
 * match — never from a client-controlled header.
 *
 * This is a pod-boundary check, not the authorization decision — control-api
 * authorizes every call against the recipe grant regardless.
 */

declare global {
  namespace Express {
    interface Request {
      pluginWorkloadCallerRef?: string
    }
  }
}

function tokensMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function createWorkloadAuthMiddleware(workloadTokens: ReadonlyMap<string, string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? ''
    const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
    if (!provided || workloadTokens.size === 0) {
      const err = new PluginWorkloadError('unauthorized', 'invalid or missing workload token')
      res.status(err.httpStatus).json(err.toBody())
      return
    }

    for (const [expectedToken, callerRef] of workloadTokens.entries()) {
      if (!tokensMatch(expectedToken, provided)) continue
      req.pluginWorkloadCallerRef = callerRef
      next()
      return
    }

    const err = new PluginWorkloadError('unauthorized', 'invalid or missing workload token')
    res.status(err.httpStatus).json(err.toBody())
  }
}
