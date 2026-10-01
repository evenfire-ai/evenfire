import express from 'express'
import {
  bindHostRpcScope,
  extractAuthToken,
  requireHostRpcPreflightScope,
  requireRpcAuth,
  runHostRpcPreflightCheckpoint,
} from '../middleware/auth.js'
import { jsonBody } from '../middleware/chatJsonBody.js'
import { chatJsonBody } from '../middleware/chatJsonBody.js'
import { admitLegacyHostRpcRequest } from '../services/hostRpcAdmission.js'
import { resolveHostConnectionForUser } from '../services/mcpProxyService.js'

const router = express.Router()
router.post(
  '/rpc/hosts/:hostRef/model',
  requireRpcAuth,
  jsonBody,
  requireHostRpcPreflightScope('host:model:write'),
  async (req: any, res: any) => {
    const { hostRef } = getHostRpcPreflight(req)
    if (!(await admitLegacyHostRpcRequest(req, res, hostRef))) return
    const host = await resolveHostConnectionForUser(req.auth!.sub, req.params.hostRef)
    const response = await fetch(`${host.url}/v1/runtime/model`)
    res.status(response.status).send(await response.text())
  }
)

router.post(
  '/rpc/hosts/:hostRef/messages',
  requireRpcAuth,
  chatJsonBody,
  bindHostRpcScope('host:message:invoke'),
  runHostRpcPreflightCheckpoint,
  async (req: any, res: any) => {
    const host = await resolveHostConnectionForUser(
      req.auth!.sub,
      runtimeHostEdgeContext(req, { messageResolution: true })
    )
    const response = await fetch(`${host.url}/v1/runtime/messages`)
    res.status(response.status).send(await response.text())
  }
)

function runtimeHostEdgeContext(_req: any, options: any): any {
  return options
}

function getHostRpcPreflight(req: any): any {
  return { hostRef: req.params.hostRef }
}

export default router
