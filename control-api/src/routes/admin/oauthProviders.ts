import { Router } from 'express'
import { asyncHandler } from '../../http/asyncHandler.js'
import { getCredentialManifest, isKnownOAuthProvider } from '../../oauth/providers.js'

/**
 * Admin router for OAuth provider metadata consumed by the install-from-UI
 * wizard (Slice 1, S1-U2). Today it serves only the per-provider credential
 * manifest; the `POST /admin/oauth/discover` prefill endpoint (D-A6) lands here
 * in Slice 3 alongside the `'generic'` adapter.
 */
export function createAdminOauthProvidersRouter(): Router {
  const router = Router()

  // GET /admin/oauth/providers/:id/credential-manifest
  // Returns the credential-form field list for a baked provider so control-ui
  // can render the install form. 404 for an unknown provider id — Slice 1 only
  // serves the 8 baked adapters (isKnownOAuthProvider is the single source of
  // truth, derived from ADAPTERS).
  router.get(
    '/admin/oauth/providers/:id/credential-manifest',
    asyncHandler(async (req, res) => {
      const id = req.params.id
      if (!isKnownOAuthProvider(id)) {
        res.status(404).json({ error: `Unknown OAuth provider "${id}"` })
        return
      }
      res.status(200).json({ provider: id, fields: getCredentialManifest(id) })
    })
  )

  return router
}
