import { Router } from 'express'
import { K8sGateway } from '../../k8s.js'
import { createAuthMcpHostRoutes } from './mcp-host/index.js'
import { createAuthRecipeOauthRoutes } from './recipe-oauth/index.js'

export function createAuthRoutes(gateway: K8sGateway): Router {
  const router = Router()
  router.use(createAuthMcpHostRoutes())
  router.use(createAuthRecipeOauthRoutes(gateway))
  return router
}
