import { Router } from 'express'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { K8sGateway } from '../../k8s.js'
import { requireInternalService } from '../../middleware/internalServiceAuth.js'
import { buildAuthorizeUrl } from '../../oauth/authorizeUrlHelper.js'
import {
  type McpServerOAuthReader,
  type McpServerOAuthSubject,
  RecipeNotFoundError,
  type RecipeReader,
  type RecipeWithOAuthClients,
  SecretNotFoundError,
  type SecretReader,
} from '../../oauth/callback.js'
import { deriveOAuthEncryptionKey } from '../../oauth/encryption.js'
import { integrationNotConfigured, isSecretNotFound } from '../../oauth/integrationNotConfigured.js'
import {
  type McpServerOAuthSpecInput,
  resolveServerOAuthSubject,
} from '../../oauth/mcpServerOAuthSpec.js'
import { deleteOAuthGrant } from '../../oauth/store.js'
import { getAccessToken } from '../../oauth/tokenHelper.js'
import { K8sNotFoundError } from '../../services/resourceService.js'
import { buildPublicCallbackUrl } from '../external/oauthCallback.js'

// DNS-1123 subdomain — the shape a k8s resource name takes. Reject anything else
// up front so a malformed `mcpServerName` becomes a 400 rather than surfacing a
// non-404 apiserver error as a 500. (Mirrors routes/mcpOauth.ts.)
const K8S_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
function isValidK8sName(name: string): boolean {
  return name.length > 0 && name.length <= 253 && K8S_NAME_RE.test(name)
}

/** McpServer shape used to read `spec.auth.type` for the OAuth gate. */
interface McpServerAuthResource extends McpServerOAuthSpecInput {
  spec?: McpServerOAuthSpecInput['spec'] & { auth?: { type?: unknown } }
}

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

  // U5: resolver for OAuth McpServer subjects. Reads the CR from the mcp-servers
  // namespace (authoritative for oauthClientId / grantScope / contextRef).
  const mcpServerReader: McpServerOAuthReader = {
    async read(mcpServerName): Promise<McpServerOAuthSubject | null> {
      let server: McpServerAuthResource
      try {
        server = (await gateway.getResource(
          'mcpservers',
          mcpServerName,
          config.mcpServersNamespace
        )) as McpServerAuthResource
      } catch (err) {
        if (err instanceof K8sNotFoundError) return null
        throw err
      }
      const resolved = resolveServerOAuthSubject(server)
      if (!resolved) return null
      return { namespace: config.mcpServersNamespace, ...resolved }
    },
  }

  // ── U5: mint a fresh authorize-URL for an OAuth mcp-server, on click ──────
  //
  // rpc-proxy fronts this from the desktop "Connect <server>" surface. The
  // `userId` is derived by rpc-proxy from the session `auth.sub` and forwarded
  // over this mutually-authenticated seam (requireInternalService('rpc-proxy')),
  // exactly like the sandbox-ui endpoints above — it is NOT a client-controlled
  // param on any end-user surface (invariant §1.1.3, U1 must-fix note). Minting
  // fresh per click keeps the state's 600s TTL counting from the user's click
  // and binds the state to that initiator.
  //
  // `oauthClientId` + `grantScope` + the Context come from the McpServer CR
  // (authoritative), never the body. A body `contextId` for a context-identity
  // server is only cross-checked against `spec.contextRef` (defence in depth).
  router.post(
    '/internal/mcp-oauth/authorize-url',
    requireInternalService('rpc-proxy'),
    async (req, res, next) => {
      try {
        const { mcpServerName, userId, contextId } = (req.body ?? {}) as {
          mcpServerName?: unknown
          userId?: unknown
          contextId?: unknown
        }
        if (typeof mcpServerName !== 'string' || !isValidK8sName(mcpServerName)) {
          return res.status(400).json({ error: 'invalid_request' })
        }
        if (typeof userId !== 'string' || userId.length === 0) {
          return res.status(400).json({ error: 'invalid_request' })
        }
        if (contextId !== undefined && typeof contextId !== 'string') {
          return res.status(400).json({ error: 'invalid_request' })
        }

        // Read the server to derive oauthClientId + grant routing. Never trust
        // the body for these.
        let server: McpServerAuthResource
        try {
          server = (await gateway.getResource(
            'mcpservers',
            mcpServerName,
            config.mcpServersNamespace
          )) as McpServerAuthResource
        } catch (err) {
          if (err instanceof K8sNotFoundError) {
            return res.status(404).json({ error: 'server_not_found' })
          }
          throw err
        }

        const authType = server?.spec?.auth?.type
        const resolved = resolveServerOAuthSubject(server)
        if (authType !== 'oauth' || !resolved) {
          return res.status(400).json({ error: 'not_oauth_server' })
        }

        // Context-identity servers: the AUTHORITATIVE Context is spec.contextRef.
        // A body contextId, if present, must match it (cross-context guard).
        if (resolved.grantScope === 'context') {
          if (!resolved.contextRef) {
            return res.status(400).json({ error: 'server_missing_context' })
          }
          if (typeof contextId === 'string' && contextId !== resolved.contextRef) {
            return res.status(400).json({ error: 'context_mismatch' })
          }
        }

        const oauthClientId = resolved.decl.id
        const redirectUri = buildPublicCallbackUrl(req, oauthClientId, config.oauthCallbackBaseUrl)

        const result = await buildAuthorizeUrl(
          {
            subjectKind: 'mcp',
            mcpServerName,
            oauthClientId,
            // Initiator forwarded from the session by rpc-proxy (see note above).
            userId,
            // mcp reactive consent mints per-user-shaped states; grant-scope
            // routing (user vs shared) is resolved authoritatively on the
            // callback from spec.contextRef.
            grantKind: 'user',
            background: false,
            redirectUri,
          },
          {
            recipeReader,
            mcpServerReader,
            secretReader,
            stateSecret: config.oauthStateHmacSecret,
          }
        )

        switch (result.kind) {
          case 'ok':
            req.log?.info(
              {
                event: 'mcp_oauth_authorize_url_minted',
                mcpServerName,
                grantScope: resolved.grantScope,
                oauthClientId,
              },
              'mcp oauth authorize url minted'
            )
            return res.status(200).json({ authorizeUrl: result.authorizeUrl })
          case 'server_not_found':
          case 'recipe_not_found':
            return res.status(404).json({ error: 'server_not_found' })
          case 'unknown_oauth_client':
          case 'background_access_not_enabled':
            return res.status(400).json({ error: 'unknown_oauth_client' })
          case 'unsupported_provider':
            return res
              .status(400)
              .json({ error: 'unsupported_provider', provider: result.provider })
          case 'secret_missing':
            return res.status(503).json(integrationNotConfigured(oauthClientId, result.secret))
          default:
            // Exhaustiveness guard: a future BuildAuthorizeUrlResult kind must
            // never leave the request hanging without a response.
            result satisfies never
            return res.status(500).json({ error: 'internal_error' })
        }
      } catch (err) {
        next(err)
      }
    }
  )

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
