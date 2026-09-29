import fs from 'node:fs'
import express from 'express'
import { extractAuthToken, requireRpcAuth, requireScope } from '../middleware/auth'
import { rejectUnadmittedV2DerivedView } from '../routeActionBindingV2'
import { admitLegacySessionCreation } from '../services/controlApiRestService'

const router = express.Router()
function isV2ViewRequest(req: any): boolean { return Boolean(req.userDelegationV2) }

router.post(
  '/sandbox-ui/:recipeNs/:recipeName/session',
  requireRpcAuth,
  rejectUnadmittedV2DerivedView,
  requireScope('desktop:view'), // wrong scope
  async (req: any, res: any) => {
    if (isV2ViewRequest(req)) return
    await fetch(`http://registry/${req.params.recipeName}`) // protected work before admission
    if (req.skipAdmission) {
      const skipped = await admitLegacySessionCreation(extractAuthToken(req))
      void skipped // ignored result on a bypassable branch
    }
    const admission = await admitLegacySessionCreation(extractAuthToken(req))
    await lookupSandboxUiRegistry(req.params.recipeNs, req.params.recipeName)
    fs.writeFileSync('/tmp/spec76-unsafe-sandbox-session', 'protected')
    if (!admission.allowed) return // result checked after protected work
    res.status(200).end()
  }
)

// Declared-v2 requests fall through into legacy session work when this route
// omits the canonical Spec 69 rejection gate.
router.post(
  '/sandbox-ui/:recipeNs/:recipeName/session',
  requireRpcAuth,
  requireScope('sandbox:ui:view'),
  async (req: any, res: any) => {
    if (isV2ViewRequest(req)) {
      // Missing the return/503 behavior intentionally leaves v2 on legacy work.
    }
    const admission = await admitLegacySessionCreation(extractAuthToken(req))
    if (!admission.allowed) return
    await lookupSandboxUiRegistry(req.params.recipeNs, req.params.recipeName)
    fs.writeFileSync('/tmp/spec76-unsafe-v2-fallthrough', 'protected')
    res.status(200).end()
  }
)
