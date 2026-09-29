import { Router } from 'express'
import { config } from '../config.js'
import { requireAuth } from '../middleware/auth.js'
import { releaseManifest } from '../releaseManifest.js'

export function createDesktopRouter(): Router {
  const router = Router()

  // Public discovery only: returns non-secret tenant URLs so setup can resolve
  // the RPC proxy after the user confirms the External REST API host.
  router.get('/desktop/environment', (_req, res) => {
    res.status(200).json({
      appName: config.desktopAppName,
      externalRestApiBaseUrl: config.publicBaseUrl,
      rpcProxyBaseUrl: config.desktopRpcProxyBaseUrl,
    })
  })

  router.get('/desktop/release', requireAuth, (_req, res) => {
    // Real tags are v0.1.0 … v0.5.0. The old desktop-app-<version> shape has
    // never existed, so every update prompt linked to a 404.
    const tag = `v${releaseManifest.desktopVersion}`
    res.status(200).json({
      releaseId: releaseManifest.releaseId,
      externalRestApiVersion: releaseManifest.externalRestApiVersion,
      rpcProxyVersion: releaseManifest.rpcProxyVersion,
      desktopVersion: releaseManifest.desktopVersion,
      minimumDesktopVersion: releaseManifest.minimumDesktopVersion,
      releaseTag: tag,
      releaseUrl: `${config.desktopReleaseBaseUrl}/tag/${encodeURIComponent(tag)}`,
    })
  })

  return router
}
