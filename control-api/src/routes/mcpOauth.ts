import { type NextFunction, type Request, type Response, Router } from 'express'
import { config } from '../config.js'
import { pool } from '../db.js'
import { K8sGateway } from '../k8s.js'
import { rateLimitMiddleware } from '../middleware/rateLimitMiddleware.js'
import {
  type OwnerDeclReader,
  RecipeNotFoundError,
  type RecipeWithOAuthClients,
  SecretNotFoundError,
  type SecretReader,
} from '../oauth/callback.js'
import { deriveOAuthEncryptionKey } from '../oauth/encryption.js'
import { integrationNotConfigured, isSecretNotFound } from '../oauth/integrationNotConfigured.js'
import { type McpServerOAuthDecl, resolveServerOAuth } from '../oauth/mcpServerOAuthSpec.js'
import type { OAuthGrantKey } from '../oauth/store.js'
import { getAccessToken } from '../oauth/tokenHelper.js'
import { K8sNotFoundError } from '../services/resourceService.js'
import {
  type McpHostControlClaims,
  verifyMcpHostControlJwt,
} from '../utils/auth/mcpHostJwtToken.js'
import { extractBearerToken } from '../utils/extractBearerToken.js'

/**
 * OAuth mcp-server broker route (U1, spec §U1).
 *
 * `POST /api/v1/mcp-oauth/user-token` — mcp-host exchanges its EXISTING
 * control JWT (host-bound, `typ:'service'`, RS256, rotated with the runtime
 * Secret) for a fresh per-connection provider access token, so the LLM can call
 * an OAuth mcp-server tool with `Authorization: Bearer <token>`. Refresh tokens
 * and the encryption key never leave control-api (invariant §1.1.2).
 *
 * Gate: the control JWT + scope `oauth:user-token`. No new static credential
 * and no new broker-token minting infra (the híbrido design, §U1).
 *
 * Identity provenance:
 *   - `oauthClientId` is derived from the McpServer's `spec.oauth.id`, NEVER
 *     from the request body.
 *   - `userId` / `contextId` ride the request body. This is the accepted pattern
 *     of the mutually-authenticated mcp-host ↔ control-api seam (same as
 *     `routes/internal/oauth.ts`): the caller is authenticated by its control
 *     JWT and asserts, over that trusted channel, which end-user session /
 *     Context pod the token is for. control-api authorizes the grant against the
 *     forwarded `userId`/`contextId` (defense in depth — a wrong value simply
 *     resolves to `no_grant`). It is therefore INCORRECT to say "userId is never
 *     a body param" here.
 *
 * Flavor dispatch — read from the server's `spec.oauth.grantScope`:
 *   - `user`    → grant key `(server, userId)`   — per-user identity.
 *   - `context` → grant key `(server, contextId)` — shared identity.
 * Both branches ship in v1; the `context` branch is governed/exercised by U6.
 */

interface McpServerResource {
  metadata?: { name?: string; namespace?: string }
  spec?: {
    auth?: { type?: unknown }
    oauth?: McpServerOAuthDecl
    // `spec.contextRef` is REQUIRED + singular on the CRD ("the context this
    // server belongs to", mcpserver.yaml). It is the AUTHORITATIVE Context of a
    // context-identity server — the shared grant coordinate — never the body.
    contextRef?: unknown
  }
}

/**
 * Normalize a McpServer's single `spec.oauth` object into the
 * `{ spec: { oauthClients: [decl] } }` shape the owner-agnostic broker +
 * refresh path (`getAccessToken`) already consume. Returns null when the server
 * is not an OAuth server (no `spec.oauth`), so callers fail closed.
 */
function normalizeMcpServerOwnerDecl(server: McpServerResource): RecipeWithOAuthClients | null {
  const oauth = server.spec?.oauth
  if (!oauth || typeof oauth.id !== 'string' || typeof oauth.provider !== 'string') return null
  const clientIdRef = oauth.clientIdRef
  const clientSecretRef = oauth.clientSecretRef
  if (
    !clientIdRef ||
    typeof clientIdRef.name !== 'string' ||
    typeof clientIdRef.key !== 'string' ||
    !clientSecretRef ||
    typeof clientSecretRef.name !== 'string' ||
    typeof clientSecretRef.key !== 'string'
  ) {
    return null
  }
  return {
    metadata: server.metadata,
    spec: {
      oauthClients: [
        {
          id: oauth.id,
          provider: oauth.provider,
          clientIdRef: { name: clientIdRef.name, key: clientIdRef.key },
          clientSecretRef: { name: clientSecretRef.name, key: clientSecretRef.key },
          scopes: Array.isArray(oauth.scopes)
            ? oauth.scopes.filter((s): s is string => typeof s === 'string')
            : undefined,
          backgroundAccess: oauth.backgroundAccess === true,
        },
      ],
    },
  }
}

// DNS-1123 subdomain, the shape a k8s resource name takes. Reject anything else
// up front so a malformed `mcpServerName` (e.g. "Foo/Bar") becomes a 400 rather
// than surfacing a non-404 apiserver error as a 500.
const K8S_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
function isValidK8sName(name: string): boolean {
  return name.length > 0 && name.length <= 253 && K8S_NAME_RE.test(name)
}

export function createMcpOauthRouter(gateway: K8sGateway): Router {
  const router = Router()
  const encryptionKey = deriveOAuthEncryptionKey(config.oauthEncryptionKey)

  // OwnerDeclReader for McpServers: reads the CR from the mcp-servers namespace
  // and normalizes `spec.oauth` → oauthClients shape. Used by getAccessToken on
  // the refresh path so it stays owner-agnostic.
  const ownerDeclReader: OwnerDeclReader = {
    async read(name): Promise<RecipeWithOAuthClients | null> {
      try {
        const server = (await gateway.getResource(
          'mcpservers',
          name,
          config.mcpServersNamespace
        )) as McpServerResource
        return normalizeMcpServerOwnerDecl(server)
      } catch (err) {
        if (err instanceof K8sNotFoundError) {
          throw new RecipeNotFoundError(`mcpserver ${config.mcpServersNamespace}/${name} not found`)
        }
        throw err
      }
    },
  }

  // Secrets (client_id / client_secret) live in the mcp-servers namespace, NOT
  // the sandbox-recipes namespace.
  const secretReader: SecretReader = {
    async read(name, namespace): Promise<Record<string, string>> {
      try {
        const raw = (await gateway.getSecret(name, namespace)) as { data?: Record<string, string> }
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

  // Verify the mcp-host control JWT and stash the claims so the rate limiter can
  // key off the caller before the handler runs.
  function requireControlCaller(req: Request, res: Response, next: NextFunction): void {
    const bearer = extractBearerToken(req)
    if (!bearer || bearer.length > 4096) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const claims = verifyMcpHostControlJwt(bearer)
    if (!claims) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    res.locals.mcpHostControl = claims
    next()
  }

  router.post(
    '/mcp-oauth/user-token',
    requireControlCaller,
    rateLimitMiddleware({
      bucketType: 'mcp_oauth_broker',
      maxPerMinute: config.oauthBrokerRlPerMin,
      getBucketKey: req => {
        const claims = req.res?.locals?.mcpHostControl as McpHostControlClaims | undefined
        return claims ? `mcp-oauth:${claims.sub}` : 'mcp-oauth:unknown'
      },
    }),
    async (req, res, next) => {
      const claims = res.locals.mcpHostControl as McpHostControlClaims | undefined
      // Scope gate: the control JWT must carry `oauth:user-token`.
      if (!claims || !claims.scopes.includes('oauth:user-token')) {
        return res.status(403).json({ error: 'insufficient_scope' })
      }

      try {
        const body = (req.body ?? {}) as {
          mcpServerName?: unknown
          userId?: unknown
          contextId?: unknown
        }
        const mcpServerName = body.mcpServerName
        const userId = body.userId
        const contextId = body.contextId
        if (typeof mcpServerName !== 'string' || !isValidK8sName(mcpServerName)) {
          return res.status(400).json({ error: 'invalid_request' })
        }

        // Read the McpServer to derive `oauthClientId` + `grantScope` from the
        // server's declaration — never from the body.
        let server: McpServerResource | null
        try {
          server = (await gateway.getResource(
            'mcpservers',
            mcpServerName,
            config.mcpServersNamespace
          )) as McpServerResource
        } catch (err) {
          if (err instanceof K8sNotFoundError) {
            return res.status(404).json({ error: 'server_not_found' })
          }
          throw err
        }

        const authType = server?.spec?.auth?.type
        const resolved = resolveServerOAuth(server)
        if (authType !== 'oauth' || !resolved) {
          return res.status(400).json({ error: 'not_oauth_server' })
        }

        // Bifurcate by grantScope read from the server.
        let key: OAuthGrantKey
        if (resolved.grantScope === 'context') {
          // AUTHORITATIVE Context = server.spec.contextRef, NEVER the body.
          // Trusting a body contextId would let a caller with the scope request
          // {server, contextId: <someone else's Context>} and receive that
          // Context's shared token (cross-context token theft). The body value,
          // if present, is only cross-checked against the authoritative one.
          const authoritativeContextId = resolved.contextRef
          if (!authoritativeContextId) {
            // A context-identity server MUST carry contextRef (CRD-required).
            // Fail closed if it somehow doesn't.
            return res.status(400).json({ error: 'server_missing_context' })
          }
          if (typeof contextId === 'string' && contextId !== authoritativeContextId) {
            return res.status(400).json({ error: 'context_mismatch' })
          }
          key = {
            grantKind: 'shared',
            ownerKind: 'mcpserver',
            recipeNamespace: config.mcpServersNamespace,
            recipeName: mcpServerName,
            contextId: authoritativeContextId,
            oauthClientId: resolved.oauthClientId,
          }
        } else {
          if (typeof userId !== 'string' || userId.length === 0) {
            return res.status(400).json({ error: 'invalid_request' })
          }
          key = {
            grantKind: 'user',
            ownerKind: 'mcpserver',
            recipeNamespace: config.mcpServersNamespace,
            recipeName: mcpServerName,
            userId,
            oauthClientId: resolved.oauthClientId,
          }
        }

        // Interactive live-session path — a human session is present, so
        // background consent is NOT required here (requireBackground: false).
        const result = await getAccessToken(
          { ...key, requireBackground: false },
          {
            db: { query: (text, values) => pool.query(text, values) },
            recipeReader: ownerDeclReader,
            secretReader,
            fetchFn: (input, init) => fetch(input, init),
            encryptionKey,
          }
        )

        const audit = (outcome: string) =>
          req.log?.info(
            {
              event: 'mcp_oauth_user_token_issued',
              mcpServerName,
              grantScope: resolved.grantScope,
              oauthClientId: resolved.oauthClientId,
              outcome,
            },
            'mcp oauth user token issued'
          )

        switch (result.kind) {
          case 'ok':
            audit('ok')
            return res.status(200).json({
              token: result.accessToken,
              expiresAt: result.expiresAt?.toISOString() ?? null,
            })
          case 'no_grant':
            audit('no_grant')
            return res.status(404).json({ error: 'no_grant' })
          case 'recipe_not_found':
            audit('server_not_found')
            return res.status(404).json({ error: 'server_not_found' })
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
            return res
              .status(503)
              .json(integrationNotConfigured(resolved.oauthClientId, result.secret))
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

  return router
}
