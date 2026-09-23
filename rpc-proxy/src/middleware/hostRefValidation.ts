import type { Request, RequestHandler, Response } from 'express'

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

export const requireValidHostRef: RequestHandler = (req, res, next) => {
  if (validateHostRef(req, res)) next()
}
