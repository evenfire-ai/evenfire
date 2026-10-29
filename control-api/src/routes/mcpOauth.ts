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
  RemoteOAuthSpecIncoherentError,
  assertRemoteOAuthSpecCoherent,
  buildMcpServerGrantKey,
  readCrUid,
  readOAuthLane,
  resolveServerOAuth,
  resolveServerOAuthSubject,
} from '../oauth/mcpServerOAuthSpec.js'
import { getAccessTokenReactive } from '../oauth/reactiveTokenHelper.js'
import { type OAuthGrantKey, oauthGrantExists } from '../oauth/store.js'
import { type Logger, rootLogger } from '../observability/logger.js'
import { mcpOauthBrokerDeniedTotal } from '../observability/metrics.js'
import {
  type ResolvedHostBinding,
  checkBrokerCallerLineage,
  hasContextIdMismatch,
  hostAccessForUser,
  isCanonicalUuid,
  isLive,
  isValidK8sName,
  resolveBrokerHostBinding,
} from '../services/access/brokerHostBinding.js'
import { isK8sResourceNotFound } from '../services/access/mcpInvocable.js'
import { K8sNotFoundError } from '../services/resourceService.js'
import {
  type McpHostControlClaims,
  mcpHostRateLimitBucketKey,
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
 * Binding: the body only names the mcp-server and, for per-user servers, the
 * end user. Everything else comes from the authenticated caller:
 *   - The control JWT must belong to a host-context-controller Host
 *     (`hostRefs[0]` + `host_uid`), and that Host must be live with the same
 *     uid, so a token cannot outlive or be replayed against a recreated Host.
 *   - The Context is the Host's `spec.contextRef`, never a body field: a
 *     caller cannot name another Context to obtain its shared token.
 *   - The mcp-server must be in that Context's allowlist (exact match, as
 *     host-context-controller applies it), enabled and live. Anything else
 *     answers the same 404 as a missing server, read before the CR is fetched,
 *     so the broker is no existence oracle across Contexts.
 *   - A per-user token requires the body `userId` to be an active user who
 *     enters this Host (directly or through an active team). The `userId`
 *     itself is still asserted by mcp-host, not proven by a signature here.
 *   - `oauthClientId` is derived from the McpServer's `spec.oauth.id`, NEVER
 *     from the request body.
 *
 * Flavor dispatch — read from the server's `spec.oauth.grantScope`:
 *   - `user`    → grant key `(server, userId)`   — per-user identity.
 *   - `context` → grant key `(server, contextRef)` — shared identity.
 * Both branches ship in v1; the `context` branch is governed/exercised by U6.
 */

export interface McpServerResource {
  metadata?: { name?: string; namespace?: string; uid?: string; deletionTimestamp?: unknown }
  spec?: {
    enabled?: unknown
    auth?: { type?: unknown }
    oauth?: McpServerOAuthDecl
    // `spec.contextRef` is REQUIRED + singular on the CRD ("the context this
    // server belongs to", mcpserver.yaml). It is the AUTHORITATIVE Context of a
    // context-identity server — the shared grant coordinate — never the body.
    contextRef?: unknown
  }
}

/**
 * The owner metadata the refresh engine reads. `uid` is the installation identity
 * a grant was sealed with; it is kept only when it is a non-empty string, so a
 * malformed value can never equal a sealed grant's uid.
 */
function ownerMetadata(server: McpServerResource): RecipeWithOAuthClients['metadata'] {
  const md = server.metadata
  if (!md) return undefined
  const uid = readCrUid(server)
  return { name: md.name, namespace: md.namespace, ...(uid ? { uid } : {}) }
}

/**
 * Normalize a McpServer's single `spec.oauth` object into the
 * `{ spec: { oauthClients: [decl] } }` shape the owner-agnostic broker +
 * refresh path (`getAccessToken`) already consume. Returns null when the server
 * is not an OAuth server (no `spec.oauth`), so callers fail closed.
 */
export function normalizeMcpServerOwnerDecl(
  server: McpServerResource
): RecipeWithOAuthClients | null {
  const oauth = server.spec?.oauth
  if (!oauth) return null
  const lane = readOAuthLane(oauth)
  // Remote lane (`source:'remote'`): delegate to the SHARED subject resolver so the
  // refresh reader reads the remote client (public / DCR / pre-registered)
  // IDENTICALLY to the mint + callback (D4 — no drift). The remote decl carries the
  // pinned routing + secretSource that `getAccessToken` branches on.
  if (lane === 'remote') {
    const resolved = resolveServerOAuthSubject(server, 'token')
    if (!resolved) return null
    return { metadata: ownerMetadata(server), spec: { oauthClients: [resolved.decl] } }
  }
  // Generic self-hosted lane (`source:'generic'`, DEC-28): delegate to the SAME
  // subject resolver (D4 — no drift with mint + callback) so the refresh reader
  // gets the pinned `generic` routing + secretSource that `getAccessToken`
  // branches on.
  if (lane === 'generic') {
    const resolved = resolveServerOAuthSubject(server, 'token')
    if (!resolved) return null
    return { metadata: ownerMetadata(server), spec: { oauthClients: [resolved.decl] } }
  }
  // Baked lane (unchanged; a public baked client is tolerated per E-19.2).
  if (typeof oauth.id !== 'string' || typeof oauth.provider !== 'string') return null
  const clientIdRef = oauth.clientIdRef
  if (!clientIdRef || typeof clientIdRef.name !== 'string' || typeof clientIdRef.key !== 'string') {
    return null
  }
  // clientSecretRef is optional (E-19.2, public client): ABSENT (null/undefined)
  // ⇒ public client (decl carries `clientSecretRef: undefined`); PRESENT-but-
  // malformed stays fail-closed (null) — a half-declared secret ref is a config
  // error, not a public client. `!= null` (not `!== undefined`) so a JSON-null
  // ref from the untrusted CR is treated as absent, never dereferenced.
  const clientSecretRef = oauth.clientSecretRef
  let normalizedSecretRef: { name: string; key: string } | undefined
  if (clientSecretRef != null) {
    if (typeof clientSecretRef.name !== 'string' || typeof clientSecretRef.key !== 'string') {
      return null
    }
    normalizedSecretRef = { name: clientSecretRef.name, key: clientSecretRef.key }
  }
  return {
    metadata: ownerMetadata(server),
    spec: {
      oauthClients: [
        {
          id: oauth.id,
          provider: oauth.provider,
          clientIdRef: { name: clientIdRef.name, key: clientIdRef.key },
          clientSecretRef: normalizedSecretRef,
          scopes: Array.isArray(oauth.scopes)
            ? oauth.scopes.filter((s): s is string => typeof s === 'string')
            : undefined,
          backgroundAccess: oauth.backgroundAccess === true,
        },
      ],
    },
  }
}

type BrokerDenialReason =
  | 'lineage'
  | 'unauthenticated'
  | 'host_not_bound'
  | 'server_not_found'
  | 'context_ref_mismatch'
  | 'no_grant'
  | 'unavailable'

// Fixed bodies: denials must not vary with what was found, and a 503 never
// forwards the apiserver or DB error (an RBAC 403 from Kubernetes would
// otherwise reach the client through the shared error handler).
const HOST_NOT_BOUND = { error: 'host_not_bound' }
const SERVER_NOT_FOUND = { error: 'server_not_found' }
const STATE_UNAVAILABLE = { error: 'host_state_unavailable' }
const NO_GRANT = { error: 'no_grant' }

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

/**
 * The coordinates of one untrusted batch entry, echoed back exactly as they
 * arrived so the consumer correlates by tuple. A non-string `mcpServerName`
 * cannot address a server and echoes as ''.
 */
function parseGrantExistsEntry(raw: unknown): GrantExistsQuery {
  const entry = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const parsed: GrantExistsQuery = {
    mcpServerName: typeof entry.mcpServerName === 'string' ? entry.mcpServerName : '',
  }
  if (typeof entry.userId === 'string') parsed.userId = entry.userId
  if (typeof entry.contextId === 'string') parsed.contextId = entry.contextId
  return parsed
}

function echoGrantExistsEntry(entry: GrantExistsQuery, exists: boolean): GrantExistsResult {
  return { ...entry, exists }
}

export interface GrantExistenceDeps {
  db: DbClient
  gateway: Pick<K8sGateway, 'getResource'>
  /** The calling Host, already resolved live: every entry is judged against it. */
  binding: ResolvedHostBinding
  mcpServersNamespace: string
  log?: Logger
}

type BrokerRoute = 'user_token' | 'grants_exists'

function recordBrokerDenial(
  log: Logger,
  route: BrokerRoute,
  reason: BrokerDenialReason,
  context: Record<string, unknown>,
  level: 'warn' | 'debug' = 'warn'
): void {
  mcpOauthBrokerDeniedTotal.inc({ reason, route }, 1)
  log[level](
    { event: 'mcp_oauth_broker_denied', reason, route, ...context },
    'mcp oauth broker denied'
  )
}

/** What one mcp-server contributes to every entry that names it in a batch. */
type ServerVerdict =
  | { kind: 'deny'; reason: 'server_not_found' | 'context_ref_mismatch' }
  // Cannot be decided now, or nothing to evict: keep the partition. `cause` is
  // set only for a transient read failure, which is reported per entry.
  | { kind: 'error'; cause?: { err: unknown } }
  | { kind: 'resolved'; resolved: NonNullable<ReturnType<typeof resolveServerOAuth>> }

/**
 * Batch grant-existence resolver for the hot-revocation sweep, bound to the
 * calling Host (`deps.binding`). Each entry gets the `user-token` rules, but a
 * definitive denial answers `exists:false` (mcp-host evicts the partition) and
 * anything transient or undecidable answers `exists:true` (mcp-host keeps it):
 * an apiserver or DB blip must never disconnect a user.
 *
 *   - outside the Host Context's allowlist (exact match), being deleted or
 *     disabled → false; outside the allowlist the CR is never read;
 *   - allowlisted but the CR is gone → true: an uninstall in flight is not
 *     this sweep's to evict (the uninstall itself purges grants);
 *   - read error, not an OAuth server, a per-user entry without userId → true;
 *   - context-scope owned by another Context or without one → false;
 *   - per-user: non-UUID userId or a user who cannot enter the Host → false,
 *     a DB error checking that → true;
 *   - otherwise the store decides (`oauthGrantExists`, never the token).
 *
 * Strictly 1:1 and in order with the input, each result echoing its entry's
 * coordinates; a malformed entry gets a fail-open placeholder in its slot.
 * Every mcp-server is read once and every userId's Host access queried once
 * per batch; denials are logged and counted once per (reason, mcp-server).
 */
export async function resolveBatchGrantExistence(
  deps: GrantExistenceDeps,
  queries: readonly unknown[]
): Promise<GrantExistsResult[]> {
  const log = deps.log ?? rootLogger
  const { binding } = deps
  const results: GrantExistsResult[] = []

  type Denial = {
    reason: BrokerDenialReason
    mcpServerName: string
    entries: number
    warn: boolean
    detail: Record<string, unknown>
  }
  const denials = new Map<string, Denial>()
  // Called once per affected entry; the first call's detail (stage, err) is kept.
  const noteDenial = (
    reason: BrokerDenialReason,
    mcpServerName: string,
    opts: { warn?: boolean; detail?: Record<string, unknown> } = {}
  ) => {
    const warn = opts.warn ?? true
    const key = `${reason}\u0000${mcpServerName}`
    const seen = denials.get(key)
    if (seen) {
      seen.entries += 1
      seen.warn ||= warn
    } else {
      denials.set(key, { reason, mcpServerName, entries: 1, warn, detail: opts.detail ?? {} })
    }
  }

  const serverVerdicts = new Map<string, ServerVerdict>()
  const serverVerdict = async (name: string): Promise<ServerVerdict> => {
    const memo = serverVerdicts.get(name)
    if (memo) return memo
    const verdict = await readServerVerdict(name)
    serverVerdicts.set(name, verdict)
    return verdict
  }
  const readServerVerdict = async (name: string): Promise<ServerVerdict> => {
    if (!binding.allowlist.includes(name)) return { kind: 'deny', reason: 'server_not_found' }
    let server: McpServerResource
    try {
      server = (await deps.gateway.getResource(
        'mcpservers',
        name,
        deps.mcpServersNamespace
      )) as McpServerResource
    } catch (err) {
      if (isK8sResourceNotFound(err)) {
        log.warn(
          { mcpServerName: name },
          'grant-existence: allowlisted server not found; fail-open'
        )
        return { kind: 'error' }
      }
      return { kind: 'error', cause: { err } }
    }
    if (!server || !isLive(server.metadata) || server.spec?.enabled === false) {
      return { kind: 'deny', reason: 'server_not_found' }
    }
    const resolved = resolveServerOAuth(server)
    if (server.spec?.auth?.type !== 'oauth' || !resolved) {
      log.warn(
        { mcpServerName: name },
        'grant-existence: server not resolvable as oauth; fail-open'
      )
      return { kind: 'error' }
    }
    if (resolved.grantScope === 'context' && resolved.contextRef !== binding.contextName) {
      return { kind: 'deny', reason: 'context_ref_mismatch' }
    }
    return { kind: 'resolved', resolved }
  }

  type Access = { kind: 'allowed' } | { kind: 'denied' } | { kind: 'error'; err: unknown }
  const userAccess = new Map<string, Access>()
  const accessFor = async (userId: string): Promise<Access> => {
    const memo = userAccess.get(userId)
    if (memo) return memo
    let access: Access
    try {
      access = { kind: await hostAccessForUser(deps.db, userId, binding.hostName) }
    } catch (err) {
      access = { kind: 'error', err }
    }
    userAccess.set(userId, access)
    return access
  }

  for (const raw of queries) {
    const entry = parseGrantExistsEntry(raw)
    const { mcpServerName, userId } = entry
    const echo = (exists: boolean) => echoGrantExistsEntry(entry, exists)

    if (!mcpServerName || !isValidK8sName(mcpServerName)) {
      log.warn({ mcpServerName }, 'grant-existence: malformed query entry; fail-open (exists:true)')
      results.push(echo(true))
      continue
    }

    const verdict = await serverVerdict(mcpServerName)
    if (verdict.kind === 'deny') {
      noteDenial(verdict.reason, mcpServerName)
      results.push(echo(false))
      continue
    }
    if (verdict.kind === 'error') {
      if (verdict.cause) {
        noteDenial('unavailable', mcpServerName, {
          detail: { stage: 'mcp_server', err: verdict.cause.err },
        })
      }
      results.push(echo(true))
      continue
    }
    const { resolved } = verdict

    if (resolved.grantScope === 'user') {
      if (!userId) {
        results.push(echo(true))
        continue
      }
      if (!isCanonicalUuid(userId)) {
        // Channel senders reach here on every sweep by design: debug only.
        noteDenial('no_grant', mcpServerName, { warn: false })
        results.push(echo(false))
        continue
      }
      const access = await accessFor(userId)
      if (access.kind === 'error') {
        noteDenial('unavailable', mcpServerName, {
          detail: { stage: 'user_access', err: access.err },
        })
        results.push(echo(true))
        continue
      }
      if (access.kind === 'denied') {
        noteDenial('no_grant', mcpServerName)
        results.push(echo(false))
        continue
      }
    }

    const key = buildMcpServerGrantKey(resolved, {
      mcpServerName,
      mcpServersNamespace: deps.mcpServersNamespace,
      userId,
    })
    if (!key) {
      // Unreachable: a context server without contextRef was denied above and a
      // per-user entry without userId answered already. Keep the partition.
      results.push(echo(true))
      continue
    }
    try {
      results.push(echo(await oauthGrantExists(deps.db, key)))
    } catch (err) {
      log.warn({ err, mcpServerName }, 'grant-existence check failed; fail-open (exists:true)')
      results.push(echo(true))
    }
  }

  for (const { reason, mcpServerName, entries, warn, detail } of denials.values()) {
    recordBrokerDenial(
      log,
      'grants_exists',
      reason,
      { host: binding.hostName, mcpServerName, entries, ...detail },
      warn ? 'warn' : 'debug'
    )
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
        // Standalone 1st-party hosts all share sub=<hostsNamespace>/standalone,
        // so keying by sub would collapse every standalone host into one bucket.
        // The verified principal keys standalone hosts by hostRefs[0] instead,
        // keeping each host isolated.
        return (
          mcpHostRateLimitBucketKey('mcp-oauth', claims, 'mcp-oauth:unknown') ?? 'mcp-oauth:unknown'
        )
      },
      onBackendUnavailable: 'process-memory',
    }),
    async (req, res, next) => {
      const claims = res.locals.mcpHostControl as McpHostControlClaims | undefined
      // Scope gate: the control JWT must carry `oauth:user-token`.
      if (!claims || !claims.scopes.includes('oauth:user-token')) {
        return res.status(403).json({ error: 'insufficient_scope' })
      }
      const log = req.log ?? rootLogger
      const deny = (
        reason: BrokerDenialReason,
        status: number,
        body: Record<string, string>,
        context: Record<string, unknown> = {},
        level: 'warn' | 'debug' = 'warn'
      ) => {
        recordBrokerDenial(log, 'user_token', reason, context, level)
        return res.status(status).json(body)
      }

      const lineage = checkBrokerCallerLineage(claims, config)
      if (lineage.kind === 'lineage') {
        return deny('lineage', 403, HOST_NOT_BOUND, { sub: claims.sub })
      }
      if (lineage.kind === 'unauthenticated') {
        return deny('unauthenticated', 401, { error: 'Unauthorized' }, { host: claims.hostRefs[0] })
      }
      const hostName = lineage.hostName

      try {
        const body = (req.body ?? {}) as {
          mcpServerName?: unknown
          userId?: unknown
        }
        const mcpServerName = body.mcpServerName
        const userId = body.userId
        if (typeof mcpServerName !== 'string' || !isValidK8sName(mcpServerName)) {
          return res.status(400).json({ error: 'invalid_request' })
        }
        const where = { host: hostName, mcpServerName }

        const binding = await resolveBrokerHostBinding(gateway, hostName, lineage.hostUid, config)
        if (binding.kind === 'denied') return deny('host_not_bound', 403, HOST_NOT_BOUND, where)
        if (binding.kind === 'unavailable') {
          return deny('unavailable', 503, STATE_UNAVAILABLE, {
            ...where,
            stage: 'host_binding',
            err: binding.cause,
          })
        }
        // Debug, not warn: the broker never keys on spec.contextId, and this
        // fires on every mint for every Host of the Context.
        if (hasContextIdMismatch(binding.ctx)) {
          log.debug(
            { event: 'context_id_mismatch', host: hostName, context: binding.ctx.metadata?.name },
            'context spec.contextId differs from its name'
          )
        }

        // Allowlist before the CR read: a server outside this Host's Context
        // must cost the same as one that does not exist.
        if (!binding.allowlist.includes(mcpServerName)) {
          return deny('server_not_found', 404, SERVER_NOT_FOUND, where)
        }
        let server: McpServerResource
        try {
          server = (await gateway.getResource(
            'mcpservers',
            mcpServerName,
            config.mcpServersNamespace
          )) as McpServerResource
        } catch (err) {
          if (isK8sResourceNotFound(err)) {
            return deny('server_not_found', 404, SERVER_NOT_FOUND, where)
          }
          return deny('unavailable', 503, STATE_UNAVAILABLE, {
            ...where,
            stage: 'mcp_server',
            err,
          })
        }
        if (!server || !isLive(server.metadata) || server.spec?.enabled === false) {
          return deny('server_not_found', 404, SERVER_NOT_FOUND, where)
        }

        const authType = server.spec?.auth?.type
        const resolved = resolveServerOAuth(server)
        if (authType !== 'oauth' || !resolved) {
          return res.status(400).json({ error: 'not_oauth_server' })
        }

        // Context-scope: the server's owner must be this Host's Context. Checked
        // before remote coherence so a foreign owner gets the uniform 404, not
        // a 409 that would reveal its spec. Any body `contextId` is ignored.
        if (resolved.grantScope === 'context' && resolved.contextRef !== binding.contextName) {
          return deny('context_ref_mismatch', 404, SERVER_NOT_FOUND, where)
        }

        // Checked up front, not only through the refresh reader: a still-fresh
        // access token is served without ever reading the owner declaration.
        assertRemoteOAuthSpecCoherent(server, 'token')

        // Bifurcate by grantScope read from the server. The KEY comes from the
        // shared derivation (`buildMcpServerGrantKey`, D4) so the mint, the
        // rpc-proxy grant-presence gate and the grant-existence sweep never
        // drift.
        let userForKey: string | undefined
        if (resolved.grantScope === 'user') {
          if (typeof userId !== 'string' || userId.length === 0) {
            return res.status(400).json({ error: 'invalid_request' })
          }
          // A user who cannot enter this Host looks exactly like one who never
          // connected the server.
          let access: 'allowed' | 'denied'
          try {
            access = await hostAccessForUser(pool, userId, hostName)
          } catch (err) {
            return deny('unavailable', 503, STATE_UNAVAILABLE, {
              ...where,
              stage: 'user_access',
              err,
            })
          }
          if (access === 'denied') {
            // Channel senders (Slack, email, Telegram ids) are not users.id and
            // reach here on every mint by design; only an entitled-looking id
            // that cannot enter the Host is worth a warning.
            return isCanonicalUuid(userId)
              ? deny('no_grant', 404, NO_GRANT, { ...where, cause: 'no_host_access' })
              : deny('no_grant', 404, NO_GRANT, { ...where, cause: 'non_uuid_user_id' }, 'debug')
          }
          userForKey = userId
        }
        const key: OAuthGrantKey | null = buildMcpServerGrantKey(resolved, {
          mcpServerName,
          mcpServersNamespace: config.mcpServersNamespace,
          userId: userForKey,
        })
        if (!key) {
          // Unreachable: the guards above already rejected the null cases (a
          // context server without contextRef never equals the Host's Context).
          // Fail closed defensively rather than mint against a malformed key.
          return res.status(400).json({ error: 'invalid_request' })
        }

        // Interactive live-session path — a human session is present, so
        // background consent is NOT required here (requireBackground: false).
        const result = await getAccessTokenReactive(
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
        if (err instanceof RemoteOAuthSpecIncoherentError) {
          return res.status(409).json({ error: err.code, reason: err.reason })
        }
        next(err)
      }
    }
  )

  // Batch grant-existence sweep. mcp-host asks, in the cadence
  // of the poll it already runs, whether its live OAuth partitions still have a
  // grant, and evicts the ones answered with a strict `exists:false`. Same
  // kill-switch, caller gate, rate-limit bucket and scope as user-token, and the
  // same Host binding. mcp-host treats ANY non-200 as "keep everything", so
  // only caller-level failures (scope, lineage, a token to renew) are errors:
  // a Host that no longer binds answers 200 with every entry false, and a
  // binding that cannot be read answers 200 with every entry true. Returns only
  // `{ mcpServerName, userId?, contextId?, exists }` — never a token or a key.
  router.post(
    '/mcp-oauth/grants/exists',
    requireBrokerEnabled,
    requireControlCaller,
    rateLimitMiddleware({
      bucketType: 'mcp_oauth_broker',
      maxPerMinute: config.oauthBrokerRlPerMin,
      getBucketKey: req => {
        const claims = req.res?.locals?.mcpHostControl as McpHostControlClaims | undefined
        // Standalone 1st-party hosts all share sub=<hostsNamespace>/standalone,
        // so keying by sub would collapse every standalone host into one bucket.
        // The verified principal keys standalone hosts by hostRefs[0] instead,
        // keeping each host isolated.
        return (
          mcpHostRateLimitBucketKey('mcp-oauth', claims, 'mcp-oauth:unknown') ?? 'mcp-oauth:unknown'
        )
      },
      onBackendUnavailable: 'process-memory',
    }),
    async (req, res, next) => {
      const claims = res.locals.mcpHostControl as McpHostControlClaims | undefined
      if (!claims || !claims.scopes.includes('oauth:user-token')) {
        return res.status(403).json({ error: 'insufficient_scope' })
      }
      const log = req.log ?? rootLogger

      // wrc tokens never call this endpoint; a 403 is harmless. A token
      // without host_uid gets 401 so mcp-host renews it.
      const lineage = checkBrokerCallerLineage(claims, config)
      if (lineage.kind === 'lineage') {
        recordBrokerDenial(log, 'grants_exists', 'lineage', { sub: claims.sub })
        return res.status(403).json(HOST_NOT_BOUND)
      }
      if (lineage.kind === 'unauthenticated') {
        recordBrokerDenial(log, 'grants_exists', 'unauthenticated', { host: claims.hostRefs[0] })
        return res.status(401).json({ error: 'Unauthorized' })
      }
      const hostName = lineage.hostName

      const body = (req.body ?? {}) as { queries?: unknown }
      if (!Array.isArray(body.queries)) {
        return res.status(400).json({ error: 'invalid_request' })
      }
      if (body.queries.length > MAX_EXISTS_BATCH) {
        return res.status(400).json({ error: 'batch_too_large' })
      }
      const queries: unknown[] = body.queries
      if (queries.length === 0) return res.status(200).json({ results: [] })
      const everyEntry = (exists: boolean) => ({
        results: queries.map(raw => echoGrantExistsEntry(parseGrantExistsEntry(raw), exists)),
      })

      try {
        const binding = await resolveBrokerHostBinding(gateway, hostName, lineage.hostUid, config)
        if (binding.kind === 'denied') {
          mcpOauthBrokerDeniedTotal.inc({ reason: 'host_not_bound', route: 'grants_exists' }, 1)
          log.warn(
            { event: 'broker_batch_denied', host: hostName, entries: queries.length },
            'grant-existence batch denied: Host not bound'
          )
          return res.status(200).json(everyEntry(false))
        }
        if (binding.kind === 'unavailable') {
          recordBrokerDenial(log, 'grants_exists', 'unavailable', {
            host: hostName,
            stage: 'host_binding',
            err: binding.cause,
          })
          return res.status(200).json(everyEntry(true))
        }
        const results = await resolveBatchGrantExistence(
          {
            db: { query: (text, values) => pool.query(text, values) },
            gateway,
            binding,
            mcpServersNamespace: config.mcpServersNamespace,
            log,
          },
          queries
        )
        return res.status(200).json({ results })
      } catch (err) {
        next(err)
      }
    }
  )

  return router
}
