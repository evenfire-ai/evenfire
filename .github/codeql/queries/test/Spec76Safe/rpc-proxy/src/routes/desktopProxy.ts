import fs from 'node:fs'
import express from 'express'
import { extractAuthToken, requireRpcAuth, requireScope } from '../middleware/auth.js'
import { rejectUnadmittedV2DerivedView } from '../routeActionBindingV2.js'
import { admitLegacySessionCreation } from '../services/controlApiRestService.js'

const router = express.Router()

function isV2ViewRequest(req: any): boolean {
  return Boolean(req.userDelegationV2)
}

async function openOrReconnect(req: any, res: any, admitLegacySession = false): Promise<void> {
  if (admitLegacySession && !isV2ViewRequest(req)) {
    const admission = await admitLegacySessionCreation(extractAuthToken(req))
    if (!admission.allowed) {
      res.status(503).json({ error: 'rate_limit_unavailable' })
      return
    }
  }
  await fetch(`http://hcc/desktop/${req.params.hostRef}`)
  fs.writeFileSync('/tmp/spec76-safe-desktop-session', 'protected')
  res.status(200).json({ ok: true })
}

router.post(
  '/desktop/:hostRef/session',
  requireRpcAuth,
  rejectUnadmittedV2DerivedView,
  requireScope('desktop:view'),
  async (req: any, res: any) => {
    await openOrReconnect(req, res, true)
  }
)
