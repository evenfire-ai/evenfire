import express from 'express'
import fs from 'node:fs'
import { requireRpcAuth } from '../middleware/auth.js'
import { resolveArtifactReadHostConnectionForUser } from '../services/fakeMcpProxyService.js'

const router = express.Router()
const localBuckets = new Map<string, number>()

// Unsafe: wrong endpoint, wrong service helper, client selector key, and local-only storage.
const resolveArtifactReadHost = async (req: any, _res: any, next: () => void) => {
  const host = await resolveArtifactReadHostConnectionForUser(req.params.hostRef)
  localBuckets.set(req.params.hostRef, Date.now())
  if (req.query.enabled) await localBuckets.get(req.params.hostRef)
  next() // Unsafe: ignores the failed/conditional admission result.
  return host
}

router.get(
  '/rpc/hosts/:hostRef/artifacts',
  requireRpcAuth,
  resolveArtifactReadHost,
  async (_req: any, res: any) => {
    const files = await fetch('http://mcp-host/v1/runtime/artifacts')
    fs.readFileSync('/tmp/unadmitted-artifact')
    res.status(200).send(await files.text())
  }
)

// Unsafe: wrong route class; a name-compatible fake is not canonical admission.
router.get('/rpc/hosts/:hostRef/artifact-list', requireRpcAuth, async (_req: any, res: any) => {
  const files = await fetch('http://mcp-host/v1/runtime/artifacts')
  fs.readFileSync('/tmp/unadmitted-artifact')
  res.status(200).send(await files.text())
})

// Unsafe: body/download path applies a local, bypassable admission after protected work.
router.get(
  '/rpc/hosts/:hostRef/artifacts/:filename/download',
  requireRpcAuth,
  async (req: any, res: any) => {
    fs.readFileSync(`/tmp/${req.params.filename}`)
    if (req.query.admit) localBuckets.set(req.params.filename, Date.now())
    res.status(200).end()
  }
)
