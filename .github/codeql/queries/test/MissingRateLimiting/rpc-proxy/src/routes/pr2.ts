import express from 'express'
import fs from 'node:fs'
import { requireRpcAuth, requireScope } from '../middleware/auth'
import { rejectUnadmittedV2DerivedView } from '../routeActionBindingV2'
import { tokenDeclaresV2 } from '../userDelegationV2'

const router = express.Router()

function isV2ViewRequest(req: any): boolean {
  return Boolean(req.userDelegationV2 && req.authorizedActionV2)
}

function v2ViewAuthority(req: any, res: any, next: () => void): void {
  if (!tokenDeclaresV2(req.token)) {
    next()
    return
  }
  requireRpcAuth(req, res, () =>
    rejectUnadmittedV2DerivedView(req, res, () => requireScope('sandbox:ui:view')(req, res, next))
  )
}

function requireV2Delegation(req: any, res: any, next: () => void): void {
  if (!isV2ViewRequest(req)) {
    res.status(401).json({ error: 'v2_delegation_required' })
    return
  }
  next()
}

router.all('/safe-v2-only-view', v2ViewAuthority, requireV2Delegation, (_req, res) => {
  fs.writeFileSync('/tmp/evenfire-codeql-v2-only', 'protected')
  res.sendStatus(204)
})

router.all('/unsafe-v2-legacy-pass-through', v2ViewAuthority, (_req, res) => {
  fs.writeFileSync('/tmp/evenfire-codeql-v2-pass-through', 'protected')
  res.sendStatus(204)
})

// Session-open keeps its legacy handler after the v2-only rejection gate, so
// the route remains reportable for legacy work.
router.post(
  '/desktop/:hostRef/session',
  requireRpcAuth,
  rejectUnadmittedV2DerivedView,
  requireScope('desktop:view'),
  (_req, res) => {
    fs.writeFileSync('/tmp/evenfire-codeql-session-legacy-fallthrough', 'legacy')
    res.sendStatus(204)
  }
)

router.post(
  '/sandbox-ui/:recipeNs/:recipeName/session',
  requireRpcAuth,
  rejectUnadmittedV2DerivedView,
  requireScope('sandbox:ui:view'),
  (_req, res) => {
    fs.writeFileSync('/tmp/evenfire-codeql-sandbox-session-legacy-fallthrough', 'legacy')
    res.sendStatus(204)
  }
)

// Reconnect is unavailable to both request classes: the canonical gate rejects
// declared-v2 callers, then requireV2Delegation rejects legacy callers.
router.post(
  '/desktop/:hostRef/reconnect',
  requireRpcAuth,
  rejectUnadmittedV2DerivedView,
  requireScope('desktop:view'),
  requireV2Delegation,
  (_req, res) => {
    fs.writeFileSync('/tmp/evenfire-codeql-direct-v2-reconnect', 'legacy-only')
    res.sendStatus(204)
  }
)

router.post(
  '/sandbox-ui/:recipeNs/:recipeName/reconnect',
  requireRpcAuth,
  rejectUnadmittedV2DerivedView,
  requireScope('sandbox:ui:view'),
  requireV2Delegation,
  (_req, res) => {
    fs.writeFileSync('/tmp/evenfire-codeql-direct-sandbox-reconnect', 'legacy-only')
    res.sendStatus(204)
  }
)

// Unsafe variants must remain reported: unrelated route, wrong scope, a
// conditional wrapper that can bypass the gate, and late gate.
router.post(
  '/desktop/:hostRef/session-copy',
  requireRpcAuth,
  rejectUnadmittedV2DerivedView,
  requireScope('desktop:view'),
  (_req, res) => {
    fs.writeFileSync('/tmp/evenfire-codeql-unbound-v2-gate', 'unprotected')
    res.sendStatus(204)
  }
)

router.post(
  '/sandbox-ui/:recipeNs/:recipeName/session',
  requireRpcAuth,
  rejectUnadmittedV2DerivedView,
  requireScope('desktop:view'),
  (_req, res) => {
    fs.writeFileSync('/tmp/evenfire-codeql-wrong-policy-v2-gate', 'unprotected')
    res.sendStatus(204)
  }
)

router.post(
  '/desktop/:hostRef/reconnect',
  requireRpcAuth,
  (req, res, next) => {
    if (req.skipGate) next()
    else rejectUnadmittedV2DerivedView(req, res, next)
  },
  requireScope('desktop:view'),
  (_req, res) => {
    fs.writeFileSync('/tmp/evenfire-codeql-conditional-v2-gate', 'unprotected')
    res.sendStatus(204)
  }
)

router.post(
  '/sandbox-ui/:recipeNs/:recipeName/reconnect',
  requireRpcAuth,
  requireScope('sandbox:ui:view'),
  (_req, res) => {
    fs.writeFileSync('/tmp/evenfire-codeql-late-v2-gate', 'unprotected')
    res.sendStatus(204)
  },
  rejectUnadmittedV2DerivedView
)

export default router
