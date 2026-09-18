import express from 'express'
import { extractAuthToken, requireRpcAuth, requireScope } from '../middleware/auth.js'
import { resolveArtifactReadHostConnectionForUser } from '../services/mcpProxyService.js'
import { resolveArtifactReadHostConnectionForUser as fakeClient } from '../services/fakeMcpProxyService.js'
import { requireScope as fakeScope } from '../middleware/fakeAuth.js'

type ArtifactRequest = express.Request & { auth?: { sub: string }; artifactReadHost?: { url: string } }

const resolveArtifactReadHost = async (req: ArtifactRequest, _res: express.Response, next: express.NextFunction) => {
  const auth = req.auth!
  const hostRef = String(req.params.hostRef || '').trim()
  req.artifactReadHost = await resolveArtifactReadHostConnectionForUser(auth.sub, hostRef, extractAuthToken(req))
  next()
}

const fakeResolveArtifactHost = async (req: ArtifactRequest, _res: express.Response, next: express.NextFunction) => {
  const auth = req.auth!
  req.artifactReadHost = await resolveArtifactReadHostConnectionForUser(auth.sub, 'host-a', extractAuthToken(req))
  next()
}

const wrongEndpointResolver = async (req: ArtifactRequest, _res: express.Response, next: express.NextFunction) => {
  const auth = req.auth!
  req.artifactReadHost = await fakeClient(auth.sub, 'host-a', extractAuthToken(req))
  next()
}

const fallbackArtifactResolver = async (req: ArtifactRequest, _res: express.Response, next: express.NextFunction) => {
  const auth = req.auth!
  try {
    req.artifactReadHost = await resolveArtifactReadHostConnectionForUser(auth.sub, 'host-a', extractAuthToken(req))
  } catch {
    req.artifactReadHost = await fakeClient(auth.sub, 'host-a', extractAuthToken(req))
  }
  next()
}

export function createRpcRouter() {
  const router = express.Router()
  router.get('/rpc/unrelated', requireRpcAuth, requireScope('host:task:read'), async (_req, res) => {
    await fetch('https://host.example/v1/runtime/unrelated')
    res.sendStatus(200)
  })
  router.get('/rpc/hosts/:hostRef/artifacts/wrong-scope', requireRpcAuth, requireScope('host:status:read'), resolveArtifactReadHost, async (_req, res) => {
    await fetch('https://host.example/v1/runtime/artifacts')
    res.sendStatus(200)
  })
  router.get('/rpc/hosts/:hostRef/artifacts/fake-scope', requireRpcAuth, fakeScope('host:task:read'), resolveArtifactReadHost, async (_req, res) => {
    await fetch('https://host.example/v1/runtime/artifacts')
    res.sendStatus(200)
  })
  router.get('/rpc/hosts/:hostRef/artifacts', requireRpcAuth, requireScope('host:task:read'), resolveArtifactReadHost, async (_req, res) => {
    await fetch('https://host.example/v1/runtime/artifacts')
    res.sendStatus(200)
  })
  router.get('/rpc/hosts/:hostRef/artifacts/:filename/download', requireRpcAuth, requireScope('host:task:read'), (_req, _res, next) => next(), resolveArtifactReadHost, async (_req, res) => {
    await fetch('https://host.example/v1/runtime/artifacts/download')
    res.sendStatus(200)
  })
  router.get('/rpc/hosts/:hostRef/artifacts', requireRpcAuth, requireScope('host:task:read'), fakeResolveArtifactHost, async (_req, res) => {
    await fetch('https://host.example/v1/runtime/artifacts')
    res.sendStatus(200)
  })
  router.get('/rpc/hosts/:hostRef/artifacts/:filename/download', requireRpcAuth, requireScope('host:task:read'), (_req, _res, next) => next(), wrongEndpointResolver, async (_req, res) => {
    await fetch('https://host.example/v1/runtime/artifacts/download')
    res.sendStatus(200)
  })
  router.get('/rpc/hosts/:hostRef/artifacts', requireRpcAuth, requireScope('host:task:read'), fallbackArtifactResolver, async (_req, res) => {
    await fetch('https://host.example/v1/runtime/artifacts')
    res.sendStatus(200)
  })
  router.get('/rpc/hosts/:hostRef/artifacts/:filename/download', requireRpcAuth, requireScope('host:task:read'), (_req, _res, next) => next(), async (_req, res) => {
    await fetch('https://host.example/v1/runtime/artifacts/download')
    res.sendStatus(200)
  })
  return router
}
