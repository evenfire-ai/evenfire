import { Router } from 'express'
import { K8sGateway } from '../../k8s.js'
import {
  requireInternalService,
  requireInternalToken,
} from '../../middleware/internalServiceAuth.js'
import { handleMicrosoftIdentityProviderCallback } from '../external/identityProviderCallback.js'
import { createOAuthCallbackHandler } from '../external/oauthCallback.js'

export function createInternalAuthCallbackRouter(gateway: K8sGateway): Router {
  const router = Router()
  const authProxyOnly = [requireInternalToken, requireInternalService('auth-proxy')]

  router.get(
    '/internal/auth-callback/oauth-callback/:oauthClientId',
    ...authProxyOnly,
    createOAuthCallbackHandler(gateway)
  )
  router.get(
    '/internal/auth-callback/identity-provider-callback/microsoft',
    ...authProxyOnly,
    handleMicrosoftIdentityProviderCallback
  )

  return router
}
