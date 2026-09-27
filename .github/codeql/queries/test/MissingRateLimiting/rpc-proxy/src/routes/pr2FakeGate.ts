import express from 'express'
import fs from 'node:fs'
import { requireRpcAuth, requireScope } from '../middleware/auth'
import { rejectUnadmittedV2DerivedView as canonicalGate } from '../routeActionBindingV2'

const router = express.Router()

// Matching a local name is insufficient: this is not the canonical gate.
function rejectUnadmittedV2DerivedView(_req: any, _res: any, next: () => void): void {
  next()
}

router.post(
  '/desktop/:hostRef/session',
  requireRpcAuth,
  rejectUnadmittedV2DerivedView,
  requireScope('desktop:view'),
  (_req, res) => {
    fs.writeFileSync('/tmp/evenfire-codeql-fake-v2-gate', 'unprotected')
    res.sendStatus(204)
  }
)

// A same-named local v2 classifier that always succeeds does not reject
// legacy callers, even when wrapped in a same-shaped delegation guard.
function isV2ViewRequest(_req: any): boolean {
  return true
}

function requireV2Delegation(req: any, res: any, next: () => void): void {
  if (!isV2ViewRequest(req)) {
    res.status(401).json({ error: 'v2_delegation_required' })
    return
  }
  next()
}

router.post(
  '/desktop/:hostRef/reconnect',
  requireRpcAuth,
  canonicalGate,
  requireScope('desktop:view'),
  requireV2Delegation,
  (_req, res) => {
    fs.writeFileSync('/tmp/evenfire-codeql-fake-v2-classifier', 'unprotected')
    res.sendStatus(204)
  }
)

// Calling the guard but then unconditionally continuing does not dominate work.
router.post(
  '/desktop/:hostRef/session',
  requireRpcAuth,
  (req, res, next) => {
    canonicalGate(req, res, next)
    next()
  },
  requireScope('desktop:view'),
  (_req, res) => {
    fs.writeFileSync('/tmp/evenfire-codeql-ignored-v2-gate', 'unprotected')
    res.sendStatus(204)
  }
)

// Authentication and scope alone are not the declared-v2 consumer gate.
router.post(
  '/desktop/:hostRef/session',
  requireRpcAuth,
  requireScope('desktop:view'),
  (_req, res) => {
    fs.writeFileSync('/tmp/evenfire-codeql-auth-only-v2-route', 'unprotected')
    res.sendStatus(204)
  }
)

export default router
