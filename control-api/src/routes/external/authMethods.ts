import { Router } from 'express'
import { config } from '../../config.js'
import { createExternalClientRateLimiters } from '../../middleware/externalClientIdentity.js'
import type { OidcProviderConfiguration } from '../../oidc/configuration.js'
import { defaultProvider, logConfigurationFailure } from './oidcProfileFlow.js'

/** The Profile UI page that starts a Desktop sign-in. */
export const DESKTOP_LOGIN_PATH = '/desktop-login'

export type ExternalAuthMethodsDependencies = Readonly<{
  getProvider?: () => OidcProviderConfiguration | undefined
}>

/**
 * `GET /external/auth/methods`: which sign-in methods Desktop offers. Password
 * always; `oidc` with its button label and the Profile UI page to open when
 * member sign-in is on. Never the issuer, tenant or client id.
 */
export function createExternalAuthMethodsRouter(
  dependencies: ExternalAuthMethodsDependencies = {}
): Router {
  const getProvider = dependencies.getProvider ?? defaultProvider
  const router = Router()
  const limits = createExternalClientRateLimiters(
    'auth_methods',
    config.approvalRlExternalClientIpPerMin,
    config.approvalRlExternalEdgePerMin
  )
  router.use('/external/auth/methods', ...limits)

  router.get('/external/auth/methods', (_req, res) => {
    let provider: OidcProviderConfiguration | undefined
    try {
      provider = getProvider()
    } catch (error) {
      // Not rethrown: password login keeps working while the OIDC configuration is
      // broken, and the OIDC routes answer 503 themselves.
      logConfigurationFailure(error)
      provider = undefined
    }
    if (!provider?.memberSignIn) {
      res.json({ methods: ['password'] })
      return
    }
    res.json({
      methods: ['password', 'oidc'],
      oidc: {
        label: provider.displayLabel,
        signInUrl: new URL(provider.redirectUri).origin + DESKTOP_LOGIN_PATH,
      },
    })
  })

  return router
}
