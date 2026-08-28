import { type NextFunction, type Request, type Response, Router } from 'express'
import { config } from '../config.js'
import { pool } from '../db.js'
import type { DbClient } from '../db.js'
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
import {
  type McpServerOAuthDecl,
  buildMcpServerGrantKey,
  resolveServerOAuth,
} from '../oauth/mcpServerOAuthSpec.js'
import { type OAuthGrantKey, oauthGrantExists } from '../oauth/store.js'
import { getAccessToken } from '../oauth/tokenHelper.js'
import { type Logger, rootLogger } from '../observability/logger.js'
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

// Upper bound on the grant-existence batch. mcp-host caps its per-user OAuth
// partitions at OAUTH_USER_PARTITION_MAX=500, so one sweep never legitimately
// exceeds that; 1000 is generous headroom that still rejects an abusive payload.
const MAX_EXISTS_BATCH = 1000

/** One entry of a `POST /mcp-oauth/grants/exists` request. */
export interface GrantExistsQuery {
  mcpServerName: string
  /** End-user identity, for `grantScope='user'` servers. */
  userId?: string
  /**
   * Accepted for API fidelity but NEVER used to key a lookup — `context`
   * servers key by the server's authoritative `contextRef` (server-side). A
   * lying value therefore cannot change the answer (no body-trust).
   */
  contextId?: string
}

/**
 * One entry of the response. It ECHOES the query's coordinates so the consumer
 * (the mcp-host sweep) correlates by the tuple `(mcpServerName, userId)` /
 * `(mcpServerName, contextId)` rather than by array position — two per-user
 * partitions of the SAME server (different `userId`) must stay distinguishable.
 * `userId`/`contextId` are echoed exactly as the caller sent them: values the
 * caller itself supplied, so echoing them leaks nothing (confirmed in review).
 * Never a token, never the server's authoritative contextRef, never a key.
 */
export interface GrantExistsResult {
  mcpServerName: string
  userId?: string
  contextId?: string
  exists: boolean
}

export interface GrantExistenceDeps {
  db: DbClient
  gateway: K8sGateway
  mcpServersNamespace: string
  log?: Logger
}

/**
 * Batch grant-existence resolver for the hot-revocation poll-sweep (mini-spec
 * 13 §4.1). For each query it resolves the server's OAuth spec, derives the
 * grant key with the SAME `buildMcpServerGrantKey` the mint uses (D4), and
 * reports `oauthGrantExists` — a pure `SELECT 1`, never the token, never any
 * secret.
 *
 * Contract: STRICT 1:1 with the input — exactly one result per input entry, in
 * order, each echoing that entry's coordinates. Entries are per-entry untrusted
 * (`unknown`): a malformed one is NOT dropped (that would break positional and
 * tuple correlation) but yields a fail-open placeholder in its own slot.
 *
 * Fail-OPEN per query (§4.2 "fail-open transitorio"): ANY problem — malformed
 * entry, server not found (deleted CR), not an OAuth server, a missing grant
 * coordinate for the flavor, an apiserver blip, or a DB error — yields
 * `exists: true` for THAT entry, so a transient hiccup never provokes an
 * eviction. `exists: false` is returned ONLY when `oauthGrantExists` says so
 * definitively. For `context` servers the key is the server's authoritative
 * `contextRef` (server-side), never the body `contextId`.
 */
export async function resolveBatchGrantExistence(
  deps: GrantExistenceDeps,
  queries: readonly unknown[]
): Promise<GrantExistsResult[]> {
  const log = deps.log ?? rootLogger
  const results: GrantExistsResult[] = []
  for (const raw of queries) {
    const entry = (raw && typeof raw === 'object' ? raw : {}) as {
      mcpServerName?: unknown
      userId?: unknown
      contextId?: unknown
    }
    // Echo the caller-supplied coordinates exactly as they arrived (a non-string
    // `mcpServerName` cannot address a server, so it echoes as ''). One `echo()`
    // per iteration guarantees `results.length === queries.length`.
    const mcpServerName = typeof entry.mcpServerName === 'string' ? entry.mcpServerName : ''
    const userId = typeof entry.userId === 'string' ? entry.userId : undefined
    const contextId = typeof entry.contextId === 'string' ? entry.contextId : undefined
    const echo = (exists: boolean): GrantExistsResult => {
      const r: GrantExistsResult = { mcpServerName, exists }
      if (userId !== undefined) r.userId = userId
      if (contextId !== undefined) r.contextId = contextId
      return r
    }

    // Malformed name → cannot address a server; fail-open placeholder in slot.
    if (!mcpServerName || !isValidK8sName(mcpServerName)) {
      log.warn({ mcpServerName }, 'grant-existence: malformed query entry; fail-open (exists:true)')
      results.push(echo(true))
      continue
    }

    try {
      const server = (await deps.gateway.getResource(
        'mcpservers',
        mcpServerName,
        deps.mcpServersNamespace
      )) as McpServerResource
      const resolved = resolveServerOAuth(server)
      if (!resolved) {
        // Not an OAuth server / no usable oauth id → ambiguous, fail-open.
        log.warn({ mcpServerName }, 'grant-existence: server not resolvable as oauth; fail-open')
        results.push(echo(true))
        continue
      }
      const key = buildMcpServerGrantKey(resolved, {
        mcpServerName,
        mcpServersNamespace: deps.mcpServersNamespace,
        userId,
      })
      if (!key) {
        // Missing the coordinate the flavor needs (no userId for a user server,
        // no contextRef for a context server) → ambiguous, fail-open.
        log.warn(
          { mcpServerName, grantScope: resolved.grantScope },
          'grant-existence: missing grant coordinate; fail-open'
        )
        results.push(echo(true))
        continue
      }
      results.push(echo(await oauthGrantExists(deps.db, key)))
    } catch (err) {
      // Server not found (deleted CR), apiserver blip, or DB error — all
      // transient/ambiguous. Fail-open: never evict a live partition on a hiccup.
      log.warn({ err, mcpServerName }, 'grant-existence check failed; fail-open (exists:true)')
      results.push(echo(true))
    }
  }
  return results
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

  // Fail-closed kill-switch (finding R1-H1). While the OAuth mcp-server broker
  // is disabled the endpoint must look ABSENT — a 404 before any auth or token
  // work, not a 403 — so it cannot serve provider tokens in production until the
  // U4 mcp-host runtime lands. Read at request time so the flag is honored
  // without a restart in tests; default is OFF (config.mcpOauthBrokerEnabled).
  function requireBrokerEnabled(_req: Request, res: Response, next: NextFunction): void {
    if (!config.mcpOauthBrokerEnabled) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    next()
  }

  router.post(
    '/mcp-oauth/user-token',
    requireBrokerEnabled,
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

        // Bifurcate by grantScope read from the server. The KEY comes from the
        // shared derivation (`buildMcpServerGrantKey`, D4) so the mint, the
        // rpc-proxy grant-presence gate and the grant-existence sweep never
        // drift. The mint keeps its own request-validation guards, which map to
        // specific error codes the shared builder's null return cannot express.
        let userForKey: string | undefined
        if (resolved.grantScope === 'context') {
          // AUTHORITATIVE Context = server.spec.contextRef, NEVER the body.
          // Trusting a body contextId would let a caller with the scope request
          // {server, contextId: <someone else's Context>} and receive that
          // Context's shared token (cross-context token theft). The body value,
          // if present, is only cross-checked against the authoritative one.
          if (!resolved.contextRef) {
            // A context-identity server MUST carry contextRef (CRD-required).
            // Fail closed if it somehow doesn't.
            return res.status(400).json({ error: 'server_missing_context' })
          }
          if (typeof contextId === 'string' && contextId !== resolved.contextRef) {
            return res.status(400).json({ error: 'context_mismatch' })
          }
        } else {
          if (typeof userId !== 'string' || userId.length === 0) {
            return res.status(400).json({ error: 'invalid_request' })
          }
          userForKey = userId
        }
        const key: OAuthGrantKey | null = buildMcpServerGrantKey(resolved, {
          mcpServerName,
          mcpServersNamespace: config.mcpServersNamespace,
          userId: userForKey,
        })
        if (!key) {
          // Unreachable: the guards above already rejected the null cases. Fail
          // closed defensively rather than mint against a malformed key.
          return res.status(400).json({ error: 'invalid_request' })
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

  // Batch grant-existence sweep (mini-spec 13 §4.1 / §4.3). mcp-host asks, in the
  // cadence of the poll it already runs, whether its live per-user OAuth
  // partitions still have a grant, and evicts the ones that do not. MIRROR of
  // `user-token` in the FULL gate + key derivation, but batch + read-only: same
  // kill-switch, same `requireControlCaller`, the SAME `mcp_oauth_broker` rate
  // limiter keyed by caller, and the SAME `oauth:user-token` scope (no new scope
  // — that would force re-issuing control JWTs, §5). Each result echoes its
  // query's coordinates so the consumer correlates by tuple, not position;
  // returns ONLY `{ mcpServerName, userId?, contextId?, exists }` — never a
  // token, the authoritative contextRef, or a key.
  router.post(
    '/mcp-oauth/grants/exists',
    requireBrokerEnabled,
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
      if (!claims || !claims.scopes.includes('oauth:user-token')) {
        return res.status(403).json({ error: 'insufficient_scope' })
      }

      const body = (req.body ?? {}) as { queries?: unknown }
      if (!Array.isArray(body.queries)) {
        return res.status(400).json({ error: 'invalid_request' })
      }
      if (body.queries.length > MAX_EXISTS_BATCH) {
        return res.status(400).json({ error: 'batch_too_large' })
      }

      try {
        // Per-entry untrusted, but 1:1 with the input: the resolver validates
        // each entry, never drops one, and emits a fail-open placeholder in the
        // slot of any malformed/unresolvable entry.
        const results = await resolveBatchGrantExistence(
          {
            db: { query: (text, values) => pool.query(text, values) },
            gateway,
            mcpServersNamespace: config.mcpServersNamespace,
            log: req.log ?? rootLogger,
          },
          body.queries
        )
        return res.status(200).json({ results })
      } catch (err) {
        next(err)
      }
    }
  )

  return router
}
