import { Router } from 'express'
import { registerGfsGrantRoutes } from './grants.js'
import { registerGfsProvisionerTokenRoute } from './provisionerToken.js'
import { registerGfsProxyRoute } from './proxy.js'
import { registerGfsResolveRoutes } from './resolve.js'
import { registerGfsResourceRoutes } from './resources.js'
import { registerGfsSeedRoute } from './seed.js'
import { registerGfsShareRoutes } from './shares.js'
import { registerGfsTokenRoute } from './token.js'
import { registerGfsTreeRoutes } from './tree.js'
import { registerLegacyStandaloneGrantReportRoute } from './legacyStandaloneGrants.js'

/**
 * gfs (Global File System) router — mounted under /api/v1 BEFORE the internal
 * service-token gate, with control-ui auth applied per route (same pattern as
 * the registry and workflows admin routers). P1 exposes the human token mint
 * plus the operator read surface (resolve, by-path); tree/proxy follow.
 */
export function createGfsRouter(): Router {
  const router = Router()
  registerGfsTokenRoute(router)
  registerGfsProvisionerTokenRoute(router)
  registerGfsResolveRoutes(router)
  registerGfsTreeRoutes(router)
  registerGfsSeedRoute(router)
  registerGfsGrantRoutes(router)
  registerLegacyStandaloneGrantReportRoute(router)
  registerGfsShareRoutes(router)
  registerGfsResourceRoutes(router)
  registerGfsProxyRoute(router)
  return router
}
