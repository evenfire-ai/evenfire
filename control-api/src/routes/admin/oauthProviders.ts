import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../../http/asyncHandler.js'
import { validateOAuthEndpointUrl } from '../../http/validateMcpServerSpec.js'
import {
  buildGenericDiscoveryPrefill,
  discoverAuthorizationServerMetadata,
} from '../../oauth/discovery.js'
import { discoveryHttpStatus } from '../../oauth/discoveryHttpStatus.js'
import {
  getCredentialManifest,
  getGenericCredentialManifest,
  isKnownOAuthProvider,
} from '../../oauth/providers.js'
import { rootLogger } from '../../observability/logger.js'

const log = rootLogger.child({ module: 'admin-oauth-providers' })

const discoverBodySchema = z.object({ url: z.string().min(1) })

/**
 * Injectable dependency for the generic discovery endpoint (test seam only).
 * Production leaves it undefined → the real IP-pinned `discoverAuthorizationServerMetadata`
 * is used; tests inject a wrapper that supplies a `transport`/`resolveDns` so the pin
 * runs with no real network.
 */
export interface AdminOauthProvidersDeps {
  discover?: typeof discoverAuthorizationServerMetadata
}

/**
 * Admin router for OAuth provider metadata consumed by the install-from-UI wizard.
 * Serves the per-provider credential manifest (baked + generic) and the generic
 * discovery-as-prefill endpoint (D-A6, E-19.5).
 */
export function createAdminOauthProvidersRouter(deps: AdminOauthProvidersDeps = {}): Router {
  const router = Router()
  const discover = deps.discover ?? discoverAuthorizationServerMetadata

  // GET /admin/oauth/providers/:id/credential-manifest
  // Returns the credential-form field list so control-ui can render the install form.
  // 'generic' is served (confidential manifest) BEFORE the baked gate; every other
  // unknown id 404s (isKnownOAuthProvider is the single source of truth for baked).
  router.get(
    '/admin/oauth/providers/:id/credential-manifest',
    asyncHandler(async (req, res) => {
      const id = req.params.id
      if (id === 'generic') {
        res.status(200).json({ provider: 'generic', fields: getGenericCredentialManifest() })
        return
      }
      if (!isKnownOAuthProvider(id)) {
        res.status(404).json({ error: `Unknown OAuth provider "${id}"` })
        return
      }
      res.status(200).json({ provider: id, fields: getCredentialManifest(id) })
    })
  )

  // POST /admin/oauth/discover — dry-run generic AS discovery, no writes (D-A6/E-19.5).
  router.post(
    '/admin/oauth/discover',
    asyncHandler(async (req, res) => {
      const parsed = discoverBodySchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: 'url is required' })
        return
      }
      const { url } = parsed.data

      // Kernel §4: the admin-typed URL is untrusted input of origin — validate before
      // any fetch (discovery also kernel-guards internally, but a clean 400 here gives
      // the wizard immediate, field-level feedback).
      const kernelErrors = await validateOAuthEndpointUrl(url, 'url')
      if (kernelErrors.length > 0) {
        res.status(400).json({ error: kernelErrors[0].message, errors: kernelErrors })
        return
      }

      const outcome = await discover(url, { logger: log })
      if (!outcome.ok) {
        log.warn({ discovery: outcome.error.kind }, 'generic discovery (dry-run) failed')
        res
          .status(discoveryHttpStatus(outcome.error))
          .json({ error: 'discovery_failed', detail: outcome.error })
        return
      }

      res.status(200).json(buildGenericDiscoveryPrefill(outcome.result))
    })
  )

  return router
}
