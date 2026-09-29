import fs from 'node:fs'
import express from 'express'
import { extractAuthToken, requireRpcAuth, requireScope } from '../middleware/auth'
import { rejectUnadmittedV2DerivedView } from '../routeActionBindingV2'
import { admitLegacySessionCreation } from '../services/controlApiRestService'

const router = express.Router()
function isV2ViewRequest(req: any): boolean { return Boolean(req.userDelegationV2) }

async function openOrReconnect(req: any, res: any, admitLegacySession = false): Promise<void> {
  if (admitLegacySession && !isV2ViewRequest(req)) {
    if (req.skipAdmission) {
      await fetch(`http://hcc/desktop/${req.params.hostRef}`)
      return
    }
    const admission = await admitLegacySessionCreation(extractAuthToken(req))
    if (!admission.allowed) return
  }
  await fetch(`http://hcc/desktop/${req.params.hostRef}`)
  fs.writeFileSync('/tmp/spec76-unsafe-desktop-session', 'protected')
  res.status(200).end()
}

router.post(
  '/desktop/:hostRef/session',
  requireRpcAuth,
  rejectUnadmittedV2DerivedView,
  requireScope('desktop:view'),
  async (req: any, res: any) => openOrReconnect(req, res, true)
)
