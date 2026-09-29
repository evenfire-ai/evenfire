import fs from 'node:fs'
import express from 'express'
import { extractAuthToken, requireRpcAuth, requireScope } from '../middleware/auth.js'
import { rejectUnadmittedV2DerivedView } from '../routeActionBindingV2.js'
import { admitLegacySessionCreation } from '../services/controlApiRestService.js'

const router = express.Router()

function isV2ViewRequest(req: any): boolean {
  return Boolean(req.userDelegationV2)
}

router.post(
  '/sandbox-ui/:recipeNs/:recipeName/session',
  requireRpcAuth,
  rejectUnadmittedV2DerivedView,
  requireScope('sandbox:ui:view'),
  async (req: any, res: any) => {
    if (isV2ViewRequest(req)) return
    if (!isCanonicalSandboxSessionRef(req.params.recipeNs, req.params.recipeName)) {
      res.status(400).json({ error: 'invalid_recipe_ref' })
      return
    }
    const admission = await admitLegacySessionCreation(extractAuthToken(req))
    if (!admission.allowed) {
      res.status(503).json({ error: 'rate_limit_unavailable' })
      return
    }
    await lookupSandboxUiRegistry(req.params.recipeNs, req.params.recipeName)
    fs.writeFileSync('/tmp/spec76-safe-sandbox-session', 'protected')
    res.status(200).json({ ok: true })
  }
)
