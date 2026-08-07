import { Router } from 'express'
import { config } from '../config.js'
import { pool } from '../db.js'
import { K8sGateway } from '../k8s.js'
import { requireBrokerToken } from '../middleware/brokerToken.js'
import { rateLimitMiddleware } from '../middleware/rateLimitMiddleware.js'
import {
  RecipeNotFoundError,
  type RecipeReader,
  type RecipeWithOAuthClients,
  SecretNotFoundError,
  type SecretReader,
} from '../oauth/callback.js'
import { deriveOAuthEncryptionKey } from '../oauth/encryption.js'
import { integrationNotConfigured, isSecretNotFound } from '../oauth/integrationNotConfigured.js'
import { listBackgroundUserGrants } from '../oauth/store.js'
import { getAccessToken } from '../oauth/tokenHelper.js'
import { K8sNotFoundError } from '../services/resourceService.js'

/**
 * Recipe OAuth broker route (Path B, spec §10).
 *
 * A background workload presents its mounted broker token and receives a fresh
 * provider access token for the recipe-owned `service` grant. The broker is a
 * thin auth boundary over `getAccessToken` — the refresh token and encryption
 * key never leave control-api.
 *
 * [SEC-3] `(recipeNamespace, recipeName)` is derived ONLY from the broker
 * token's `sub` claim (`req.recipe`, set by `requireBrokerToken`). `oauthClientId`
 * is the only value taken from the request body.
 */
export function createRecipeOauthRouter(gateway: K8sGateway): Router {
  const router = Router()
  const encryptionKey = deriveOAuthEncryptionKey(config.oauthEncryptionKey)

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

  router.post(
    '/recipe-oauth/token',
    requireBrokerToken,
    // Per-recipe token bucket — keyed off the broker token's recipe binding so
    // one looping workload cannot exhaust control-api workers or the provider's
    // rate limit for everyone. `req.recipe` is set by requireBrokerToken above.
    rateLimitMiddleware({
      bucketType: 'recipe_oauth_broker',
      maxPerMinute: config.oauthBrokerRlPerMin,
      getBucketKey: req =>
        req.recipe ? `recipe-oauth:${req.recipe.namespace}/${req.recipe.name}` : null,
    }),
    async (req, res, next) => {
      const { namespace: recipeNamespace, name: recipeName } = req.recipe!
      try {
        const oauthClientId = (req.body ?? {}).oauthClientId
        if (typeof oauthClientId !== 'string' || oauthClientId.length === 0) {
          return res.status(400).json({ error: 'invalid_request' })
        }

        // [SEC-3] Confirm the client is declared with `backgroundAccess: true` on
        // THIS recipe before the grant lookup. A recipe predating the field reads
        // as `undefined` → fail closed.
        let recipe: RecipeWithOAuthClients | null
        try {
          recipe = await recipeReader.read(recipeName, recipeNamespace)
        } catch (err) {
          if (err instanceof RecipeNotFoundError) {
            return res.status(404).json({ error: 'recipe_not_found' })
          }
          throw err
        }
        if (!recipe) {
          return res.status(404).json({ error: 'recipe_not_found' })
        }
        const clientDecl = recipe.spec?.oauthClients?.find(c => c.id === oauthClientId)
        if (!clientDecl || clientDecl.backgroundAccess !== true) {
          return res.status(400).json({ error: 'unknown_oauth_client' })
        }

        const result = await getAccessToken(
          {
            grantKind: 'service',
            recipeNamespace,
            recipeName,
            oauthClientId,
          },
          {
            db: { query: (text, values) => pool.query(text, values) },
            recipeReader,
            secretReader,
            fetchFn: (input, init) => fetch(input, init),
            encryptionKey,
          }
        )

        const audit = (outcome: string) =>
          req.log?.info(
            {
              event: 'recipe_oauth_token_issued',
              recipeNamespace,
              recipeName,
              oauthClientId,
              outcome,
            },
            'recipe oauth token issued'
          )

        switch (result.kind) {
          case 'ok':
            audit('ok')
            return res.status(200).json({
              accessToken: result.accessToken,
              expiresAt: result.expiresAt?.toISOString() ?? null,
            })
          case 'no_grant':
            audit('no_grant')
            return res.status(404).json({ error: 'no_grant' })
          case 'recipe_not_found':
            audit('recipe_not_found')
            return res.status(404).json({ error: 'recipe_not_found' })
          case 'unknown_oauth_client':
            audit('unknown_oauth_client')
            return res.status(400).json({ error: 'unknown_oauth_client' })
          case 'unsupported_provider':
            audit('unsupported_provider')
            return res
              .status(400)
              .json({ error: 'unsupported_provider', provider: result.provider })
          case 'secret_missing':
            audit('integration_not_configured')
            return res.status(503).json(integrationNotConfigured(oauthClientId, result.secret))
          case 'refresh_failed':
            audit('refresh_failed')
            return res
              .status(502)
              .json({ error: 'refresh_failed', status: result.status, detail: result.detail })
        }
      } catch (err) {
        next(err)
      }
    }
  )

  /**
   * Per-user broker route (SEC-5): resolve a background-consented user grant.
   *
   * Body: `{ oauthClientId: string, userId: string }`
   * Recipe identity ONLY from `req.recipe` (broker token `sub`). `userId` is a
   * consent-bounded lookup key; absent/non-consented → uniform 404 `no_grant`.
   */
  router.post(
    '/recipe-oauth/user-token',
    requireBrokerToken,
    rateLimitMiddleware({
      bucketType: 'recipe_oauth_broker',
      maxPerMinute: config.oauthBrokerRlPerMin,
      getBucketKey: req =>
        req.recipe ? `recipe-oauth-user:${req.recipe.namespace}/${req.recipe.name}` : null,
    }),
    async (req, res, next) => {
      // [SEC-5] recipe identity ONLY from the broker token sub; userId is a
      // consent-bounded lookup key; getAccessToken requires background=true.
      const { namespace: recipeNamespace, name: recipeName } = req.recipe!
      try {
        const oauthClientId = (req.body ?? {}).oauthClientId
        const userId = (req.body ?? {}).userId
        if (
          typeof oauthClientId !== 'string' ||
          oauthClientId.length === 0 ||
          typeof userId !== 'string' ||
          userId.length === 0
        ) {
          return res.status(400).json({ error: 'invalid_request' })
        }

        let recipe: RecipeWithOAuthClients | null
        try {
          recipe = await recipeReader.read(recipeName, recipeNamespace)
        } catch (err) {
          if (err instanceof RecipeNotFoundError) {
            return res.status(404).json({ error: 'recipe_not_found' })
          }
          throw err
        }
        if (!recipe) return res.status(404).json({ error: 'recipe_not_found' })
        const clientDecl = recipe.spec?.oauthClients?.find(c => c.id === oauthClientId)
        if (!clientDecl || clientDecl.backgroundAccess !== true) {
          return res.status(400).json({ error: 'unknown_oauth_client' })
        }

        const result = await getAccessToken(
          {
            grantKind: 'user',
            recipeNamespace,
            recipeName,
            userId,
            oauthClientId,
            requireBackground: true,
          },
          {
            db: { query: (text, values) => pool.query(text, values) },
            recipeReader,
            secretReader,
            fetchFn: (input, init) => fetch(input, init),
            encryptionKey,
          }
        )

        const audit = (outcome: string) =>
          req.log?.info(
            {
              event: 'recipe_oauth_user_token_issued',
              recipeNamespace,
              recipeName,
              userId,
              oauthClientId,
              outcome,
            },
            'recipe oauth user token issued'
          )

        switch (result.kind) {
          case 'ok':
            audit('ok')
            return res.status(200).json({
              accessToken: result.accessToken,
              expiresAt: result.expiresAt?.toISOString() ?? null,
            })
          case 'no_grant':
            audit('no_grant')
            return res.status(404).json({ error: 'no_grant' })
          case 'recipe_not_found':
            audit('recipe_not_found')
            return res.status(404).json({ error: 'recipe_not_found' })
          case 'unknown_oauth_client':
            audit('unknown_oauth_client')
            return res.status(400).json({ error: 'unknown_oauth_client' })
          case 'unsupported_provider':
            audit('unsupported_provider')
            return res
              .status(400)
              .json({ error: 'unsupported_provider', provider: result.provider })
          case 'secret_missing':
            audit('integration_not_configured')
            return res.status(503).json(integrationNotConfigured(oauthClientId, result.secret))
          case 'refresh_failed':
            audit('refresh_failed')
            return res
              .status(502)
              .json({ error: 'refresh_failed', status: result.status, detail: result.detail })
        }
      } catch (err) {
        next(err)
      }
    }
  )

  /**
   * Enumeration route (SEC-6): list userIds with background-consented grants.
   *
   * Query: `?oauthClientId=<id>`
   * Returns `{ users: string[] }`, scoped to the calling recipe + client only.
   * Recipe identity ONLY from `req.recipe` (broker token `sub`).
   */
  router.get(
    '/recipe-oauth/users',
    requireBrokerToken,
    rateLimitMiddleware({
      bucketType: 'recipe_oauth_broker',
      maxPerMinute: config.oauthBrokerRlPerMin,
      getBucketKey: req =>
        req.recipe ? `recipe-oauth-users:${req.recipe.namespace}/${req.recipe.name}` : null,
    }),
    async (req, res, next) => {
      // [SEC-6] recipe identity from the broker token sub; returns only THIS
      // recipe's consenting userIds for the named (backgroundAccess) client.
      const { namespace: recipeNamespace, name: recipeName } = req.recipe!
      try {
        const oauthClientId = req.query.oauthClientId
        if (typeof oauthClientId !== 'string' || oauthClientId.length === 0) {
          return res.status(400).json({ error: 'invalid_request' })
        }

        let recipe: RecipeWithOAuthClients | null
        try {
          recipe = await recipeReader.read(recipeName, recipeNamespace)
        } catch (err) {
          if (err instanceof RecipeNotFoundError) {
            return res.status(404).json({ error: 'recipe_not_found' })
          }
          throw err
        }
        const clientDecl = recipe?.spec?.oauthClients?.find(c => c.id === oauthClientId)
        if (!clientDecl || clientDecl.backgroundAccess !== true) {
          return res.status(400).json({ error: 'unknown_oauth_client' })
        }

        const users = await listBackgroundUserGrants(
          { query: (text, values) => pool.query(text, values) },
          { recipeNamespace, recipeName, oauthClientId }
        )

        req.log?.info(
          {
            event: 'recipe_oauth_users_listed',
            recipeNamespace,
            recipeName,
            oauthClientId,
            count: users.length,
          },
          'recipe oauth users listed'
        )
        return res.status(200).json({ users })
      } catch (err) {
        next(err)
      }
    }
  )

  return router
}
