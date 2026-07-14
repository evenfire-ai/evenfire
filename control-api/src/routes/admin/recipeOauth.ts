import { Router } from 'express'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { RFC1123_RE } from '../../http/rfc1123.js'
import { K8sGateway } from '../../k8s.js'
import { UiAuthedRequest } from '../../middleware/controlUIAuth.js'
import { buildAuthorizeUrl } from '../../oauth/authorizeUrlHelper.js'
import {
  RecipeNotFoundError,
  type RecipeReader,
  type RecipeWithOAuthClients,
  SecretNotFoundError,
  type SecretReader,
} from '../../oauth/callback.js'
import { integrationNotConfigured, isSecretNotFound } from '../../oauth/integrationNotConfigured.js'
import { deleteOAuthGrant, listUserGrantsForClient, oauthGrantExists } from '../../oauth/store.js'
import { K8sNotFoundError } from '../../services/resourceService.js'
import { buildPublicCallbackUrl } from '../external/oauthCallback.js'

/**
 * Admin-only "connect for the recipe" routes (Path B — spec §8.3 / §8.4).
 *
 * Mint, inspect, and revoke recipe-scoped `service` OAuth grants. The router is
 * mounted under `/admin/*`, so `requireAuthForControlUI` (app.ts) has already
 * authenticated the caller as a control-ui admin.
 *
 * [SEC-1] This is the ONLY route that issues a `grantKind: 'service'` authorize
 * URL. The embed `/oauth/authorize-url` path hard-pins `'user'`.
 */

// WorkflowRecipe CRDs always live in sandbox-recipes (design invariant — see
// routes/admin/recipes.ts), so the recipe namespace is not a path param.
const RECIPE_CRD_NAMESPACE = config.sandboxNamespace
const BASE = '/admin/recipes'

function dbClient() {
  return { query: (text: string, values?: unknown[]) => pool.query(text, values) }
}

export function createAdminRecipeOauthRouter(gateway: K8sGateway): Router {
  const router = Router()

  const recipeReader: RecipeReader = {
    async read(name, namespace): Promise<RecipeWithOAuthClients | null> {
      try {
        return (await gateway.getResource(
          'workflowrecipes',
          name,
          namespace
        )) as RecipeWithOAuthClients
      } catch (err) {
        if (err instanceof K8sNotFoundError) {
          throw new RecipeNotFoundError(`recipe ${namespace}/${name} not found`)
        }
        throw err
      }
    },
  }

  const secretReader: SecretReader = {
    async read(name, namespace): Promise<Record<string, string>> {
      try {
        const raw = (await gateway.getSecret(name, namespace)) as {
          data?: Record<string, string>
        }
        const decoded: Record<string, string> = {}
        for (const [k, v] of Object.entries(raw.data ?? {})) {
          decoded[k] = Buffer.from(v, 'base64').toString('utf8')
        }
        return decoded
      } catch (err) {
        if (isSecretNotFound(err)) {
          throw new SecretNotFoundError(`secret ${namespace}/${name} not found`)
        }
        throw err
      }
    },
  }

  // Recipe names and oauthClient ids are both RFC1123 labels.
  function validParams(name: string, oauthClientId: string): boolean {
    return RFC1123_RE.test(name) && RFC1123_RE.test(oauthClientId)
  }

  // POST /admin/recipes/:name/oauth/:oauthClientId/connect
  // Mints a `service` authorize URL the admin opens in a browser to connect a
  // third-party account FOR THE RECIPE (no end-user). Returns { authorizeUrl }.
  router.post(
    `${BASE}/:name/oauth/:oauthClientId/connect`,
    asyncHandler(async (req: UiAuthedRequest, res) => {
      const { name, oauthClientId } = req.params
      if (!validParams(name, oauthClientId)) {
        res.status(400).json({ error: 'invalid_request' })
        return
      }
      const adminUserId = req.adminAuth?.sub
      if (!adminUserId) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }

      const redirectUri = buildPublicCallbackUrl(req, oauthClientId, config.oauthCallbackBaseUrl)
      const result = await buildAuthorizeUrl(
        {
          recipeNamespace: RECIPE_CRD_NAMESPACE,
          recipeName: name,
          oauthClientId,
          // The initiating admin — recorded in the signed state for audit only;
          // a service grant is recipe-owned and stores no user_id.
          userId: adminUserId,
          grantKind: 'service',
          redirectUri,
        },
        { recipeReader, secretReader, stateSecret: config.oauthStateHmacSecret }
      )

      switch (result.kind) {
        case 'ok':
          console.log(
            JSON.stringify({
              event: 'oauth_service_connect_initiated',
              recipeNamespace: RECIPE_CRD_NAMESPACE,
              recipeName: name,
              oauthClientId,
              adminUserId,
            })
          )
          res.status(200).json({ authorizeUrl: result.authorizeUrl })
          return
        case 'recipe_not_found':
          res.status(404).json({ error: 'recipe_not_found' })
          return
        case 'unknown_oauth_client':
          res.status(400).json({ error: 'unknown_oauth_client' })
          return
        case 'background_access_not_enabled':
          res.status(400).json({ error: 'background_access_not_enabled' })
          return
        case 'unsupported_provider':
          res.status(400).json({ error: 'unsupported_provider', provider: result.provider })
          return
        case 'secret_missing':
          res.status(503).json(integrationNotConfigured(oauthClientId, result.secret))
          return
      }
    })
  )

  // GET /admin/recipes/:name/oauth/:oauthClientId/status
  // Lightweight connected/disconnected check for the Integrations tab — does
  // not decrypt tokens.
  router.get(
    `${BASE}/:name/oauth/:oauthClientId/status`,
    asyncHandler(async (req: UiAuthedRequest, res) => {
      const { name, oauthClientId } = req.params
      if (!validParams(name, oauthClientId)) {
        res.status(400).json({ error: 'invalid_request' })
        return
      }
      const connected = await oauthGrantExists(dbClient(), {
        grantKind: 'service',
        recipeNamespace: RECIPE_CRD_NAMESPACE,
        recipeName: name,
        oauthClientId,
      })
      res.status(200).json({ connected })
    })
  )

  // DELETE /admin/recipes/:name/oauth/:oauthClientId/grant — Disconnect.
  // Idempotent: 204 whether or not a grant existed (no information leak).
  // Drops the local row; the broker fails closed on the next call. Provider-
  // side revocation is intentionally not attempted (spec §16).
  router.delete(
    `${BASE}/:name/oauth/:oauthClientId/grant`,
    asyncHandler(async (req: UiAuthedRequest, res) => {
      const { name, oauthClientId } = req.params
      if (!validParams(name, oauthClientId)) {
        res.status(400).json({ error: 'invalid_request' })
        return
      }
      const adminUserId = req.adminAuth?.sub
      if (!adminUserId) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      await deleteOAuthGrant(dbClient(), {
        grantKind: 'service',
        recipeNamespace: RECIPE_CRD_NAMESPACE,
        recipeName: name,
        oauthClientId,
      })
      console.log(
        JSON.stringify({
          event: 'oauth_service_grant_deleted',
          recipeNamespace: RECIPE_CRD_NAMESPACE,
          recipeName: name,
          oauthClientId,
          adminUserId,
        })
      )
      res.status(204).end()
    })
  )

  // GET /admin/recipes/:name/oauth/:oauthClientId/user-grants
  // Read-only list of all users who have a grant for this (recipe, client).
  // Namespace is forced to RECIPE_CRD_NAMESPACE — never taken from the request.
  router.get(
    `${BASE}/:name/oauth/:oauthClientId/user-grants`,
    asyncHandler(async (req: UiAuthedRequest, res) => {
      const { name, oauthClientId } = req.params
      if (!validParams(name, oauthClientId)) {
        res.status(400).json({ error: 'invalid_request' })
        return
      }
      const users = await listUserGrantsForClient(dbClient(), {
        recipeNamespace: RECIPE_CRD_NAMESPACE,
        recipeName: name,
        oauthClientId,
      })
      res.status(200).json({
        users: users.map(u => ({ ...u, updatedAt: u.updatedAt.toISOString() })),
      })
    })
  )

  // DELETE /admin/recipes/:name/oauth/:oauthClientId/user-grants/:userId
  // Force-revoke one user's grant (admin oversight).
  // Namespace is forced to RECIPE_CRD_NAMESPACE — never taken from the request.
  // Idempotent: 204 whether or not a row existed.
  router.delete(
    `${BASE}/:name/oauth/:oauthClientId/user-grants/:userId`,
    asyncHandler(async (req: UiAuthedRequest, res) => {
      const { name, oauthClientId, userId } = req.params
      if (!validParams(name, oauthClientId)) {
        res.status(400).json({ error: 'invalid_request' })
        return
      }
      const adminUserId = req.adminAuth?.sub
      if (!adminUserId) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      await deleteOAuthGrant(dbClient(), {
        grantKind: 'user',
        recipeNamespace: RECIPE_CRD_NAMESPACE,
        recipeName: name,
        userId: String(userId),
        oauthClientId,
      })
      console.log(
        JSON.stringify({
          event: 'oauth_user_grant_force_revoked',
          recipeNamespace: RECIPE_CRD_NAMESPACE,
          recipeName: name,
          oauthClientId,
          targetUserId: userId,
          adminUserId,
        })
      )
      res.status(204).end()
    })
  )

  return router
}
