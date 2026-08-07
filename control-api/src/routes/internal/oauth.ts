import { Router } from 'express'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { K8sGateway } from '../../k8s.js'
import { requireInternalService } from '../../middleware/internalServiceAuth.js'
import { buildAuthorizeUrl } from '../../oauth/authorizeUrlHelper.js'
import {
  RecipeNotFoundError,
  type RecipeReader,
  type RecipeWithOAuthClients,
  SecretNotFoundError,
  type SecretReader,
} from '../../oauth/callback.js'
import { deriveOAuthEncryptionKey } from '../../oauth/encryption.js'
import { integrationNotConfigured, isSecretNotFound } from '../../oauth/integrationNotConfigured.js'
import { deleteOAuthGrant } from '../../oauth/store.js'
import { getAccessToken } from '../../oauth/tokenHelper.js'
import { K8sNotFoundError } from '../../services/resourceService.js'

/**
 * Internal OAuth helper endpoints. rpc-proxy fronts these from the
 * embed-facing routes (slice 6) — the cookie-derived user identity is passed
 * here as a body param. requireInternalService('rpc-proxy') gates the
 * service-token boundary; rpc-proxy is the sole authorized caller.
 *
 * Spec §9.9.
 */
export function createInternalOAuthRouter(gateway: K8sGateway): Router {
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
    '/internal/sandbox-ui/oauth/authorize-url',
    requireInternalService('rpc-proxy'),
    async (req, res, next) => {
      try {
        const { recipeNs, recipeName, oauthClientId, userId, redirectUri, background } =
          req.body ?? {}
        if (
          typeof recipeNs !== 'string' ||
          typeof recipeName !== 'string' ||
          typeof oauthClientId !== 'string' ||
          typeof userId !== 'string' ||
          typeof redirectUri !== 'string'
        ) {
          return res.status(400).json({ error: 'invalid_request' })
        }
        if (background !== undefined && typeof background !== 'boolean') {
          return res.status(400).json({ error: 'invalid_request' })
        }
        if (recipeNs !== config.sandboxNamespace) {
          return res.status(400).json({ error: 'invalid_recipe_namespace' })
        }

        const result = await buildAuthorizeUrl(
          {
            recipeNamespace: recipeNs,
            recipeName,
            oauthClientId,
            userId,
            // [SEC-1] The embed path mints user grants only. `service` grants
            // are reachable solely through the admin connect route.
            grantKind: 'user',
            background: background === true,
            redirectUri,
          },
          { recipeReader, secretReader, stateSecret: config.oauthStateHmacSecret }
        )

        switch (result.kind) {
          case 'ok':
            return res.status(200).json({ authorizeUrl: result.authorizeUrl })
          case 'recipe_not_found':
            return res.status(404).json({ error: 'recipe_not_found' })
          case 'unknown_oauth_client':
            return res.status(400).json({ error: 'unknown_oauth_client' })
          case 'background_access_not_enabled':
            // Unreachable on the embed path (grantKind is always 'user'), but
            // the switch must be exhaustive over BuildAuthorizeUrlResult.
            return res.status(400).json({ error: 'unknown_oauth_client' })
          case 'unsupported_provider':
            return res
              .status(400)
              .json({ error: 'unsupported_provider', provider: result.provider })
          case 'secret_missing':
            return res.status(503).json(integrationNotConfigured(oauthClientId, result.secret))
        }
      } catch (err) {
        next(err)
      }
    }
  )

  router.post(
    '/internal/sandbox-ui/oauth/token',
    requireInternalService('rpc-proxy'),
    async (req, res, next) => {
      try {
        const { recipeNs, recipeName, oauthClientId, userId } = req.body ?? {}
        if (
          typeof recipeNs !== 'string' ||
          typeof recipeName !== 'string' ||
          typeof oauthClientId !== 'string' ||
          typeof userId !== 'string'
        ) {
          return res.status(400).json({ error: 'invalid_request' })
        }
        if (recipeNs !== config.sandboxNamespace) {
          return res.status(400).json({ error: 'invalid_recipe_namespace' })
        }

        const result = await getAccessToken(
          {
            grantKind: 'user',
            recipeNamespace: recipeNs,
            recipeName,
            oauthClientId,
            userId,
          },
          {
            db: { query: (text, values) => pool.query(text, values) },
            recipeReader,
            secretReader,
            fetchFn: (input, init) => fetch(input, init),
            encryptionKey,
          }
        )

        switch (result.kind) {
          case 'ok':
            return res.status(200).json({
              accessToken: result.accessToken,
              expiresAt: result.expiresAt?.toISOString() ?? null,
            })
          case 'no_grant':
            return res.status(404).json({ error: 'no_grant' })
          case 'recipe_not_found':
            return res.status(404).json({ error: 'recipe_not_found' })
          case 'unknown_oauth_client':
            return res.status(400).json({ error: 'unknown_oauth_client' })
          case 'unsupported_provider':
            return res
              .status(400)
              .json({ error: 'unsupported_provider', provider: result.provider })
          case 'secret_missing':
            return res.status(503).json(integrationNotConfigured(oauthClientId, result.secret))
          case 'refresh_failed':
            return res
              .status(502)
              .json({ error: 'refresh_failed', status: result.status, detail: result.detail })
        }
      } catch (err) {
        next(err)
      }
    }
  )

  router.delete(
    '/internal/sandbox-ui/oauth/grant',
    requireInternalService('rpc-proxy'),
    async (req, res, next) => {
      try {
        const { recipeNs, recipeName, oauthClientId, userId } = req.body ?? {}
        if (
          typeof recipeNs !== 'string' ||
          typeof recipeName !== 'string' ||
          typeof oauthClientId !== 'string' ||
          typeof userId !== 'string'
        ) {
          return res.status(400).json({ error: 'invalid_request' })
        }
        if (recipeNs !== config.sandboxNamespace) {
          return res.status(400).json({ error: 'invalid_recipe_namespace' })
        }

        // Idempotent: a no-op delete returns 204. We intentionally do not
        // surface "no grant existed" as a distinct status to avoid
        // leaking which (recipe, oauthClient) pairs the user has connected.
        await deleteOAuthGrant(
          { query: (text, values) => pool.query(text, values) },
          {
            grantKind: 'user',
            recipeNamespace: recipeNs,
            recipeName,
            userId,
            oauthClientId,
          }
        )
        return res.status(204).end()
      } catch (err) {
        next(err)
      }
    }
  )

  return router
}
