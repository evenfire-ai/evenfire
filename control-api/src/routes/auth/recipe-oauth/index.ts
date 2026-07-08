import { Router } from 'express'
import { K8sGateway } from '../../../k8s.js'
import { createAuthRecipeOauthIssueRoutes } from './issue.routes.js'

export function createAuthRecipeOauthRoutes(gateway: K8sGateway): Router {
  const router = Router()
  router.use(createAuthRecipeOauthIssueRoutes(gateway))
  return router
}
