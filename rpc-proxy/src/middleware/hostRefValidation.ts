import type { Request, RequestHandler, Response } from 'express'
import {
  authorizeDeferredHostRouteActionV2,
  bindDeferredHostRouteActionV2,
} from '../routeActionBindingV2.js'
import type { AuthedRequest } from './auth.js'

// Mirrors the authoritative Control API Host-create metadata.name contract.
// Express has already decoded the captured segment; do not normalize it.
export const HOST_REF_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export function validateHostRef(req: Request, res: Response): boolean {
  const hostRef = req.params.hostRef
  if (typeof hostRef !== 'string' || !HOST_REF_RE.test(hostRef)) {
    res.status(400).json({ error: 'Invalid hostRef' })
    return false
  }
  return true
}

/** Completes the approved auth/local-bind → W1 → remote-checkpoint sequence. */
export async function validateHostRefAndAuthorize(
  req: AuthedRequest,
  res: Response
): Promise<boolean> {
  if (req.deferHostV2Checkpoint && !bindDeferredHostRouteActionV2(req, res)) return false
  if (!validateHostRef(req, res)) return false
  if (req.deferHostV2Checkpoint) {
    return authorizeDeferredHostRouteActionV2(req, res)
  }
  return true
}

export const requireValidHostRef: RequestHandler = (req, res, next) => {
  void validateHostRefAndAuthorize(req as AuthedRequest, res).then(valid => {
    if (valid) next()
  })
}
