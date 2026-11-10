import { type Request, Router } from 'express'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { K8sGateway } from '../../k8s.js'
import { requireInternalService } from '../../middleware/internalServiceAuth.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
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
import {
  type IntegrationNotConfiguredBody,
  integrationNotConfigured,
  isSecretNotFound,
} from '../../oauth/integrationNotConfigured.js'
import {
  type McpServerOAuthSpecInput,
  RemoteOAuthSpecIncoherentError,
  type ResolvedServerOAuthSubject,
  buildMcpServerGrantKey,
  resolveServerOAuth,
  resolveServerOAuthSubject,
} from '../../oauth/mcpServerOAuthSpec.js'
import {
  buildPerServerRedirectUri,
  resolvePerServerRegistration,
} from '../../oauth/perServerRegistration.js'
import { getAccessTokenReactive } from '../../oauth/reactiveTokenHelper.js'
import {
  buildRemoteRedirectUri,
  isBareOrigin,
  isValidRemoteServerNameSegment,
  remoteCallbackVariant,
} from '../../oauth/remoteCallback.js'
import { deleteOAuthGrant } from '../../oauth/store.js'
// `isValidK8sName` (DNS-1123 subdomain) rejects a malformed name up front, so it
// becomes a 400 rather than a non-404 apiserver error surfacing as a 500. It is
// deliberately wider than the per-server callback segment (an RFC 1123 label):
// these routes serve every OAuth lane, and only a per-server remote server needs
// its name to fit in a URL segment — that narrower rule is applied where its
// redirect URI is built.
import { isValidK8sName } from '../../services/access/brokerHostBinding.js'
import {
  userHasContextEnablingMcpServer,
  userReachesContext,
} from '../../services/access/mcpInvocable.js'
import { K8sNotFoundError } from '../../services/resourceService.js'
import {
  buildPublicCallbackUrl,
  normalizeConfiguredOrigin,
  resolveCallbackOrigin,
} from '../external/oauthCallback.js'

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

  // Rate limiter for the two U5 mcp-oauth internal routes (authorize-url mint +
  // grant delete). Both sit behind `requireInternalService('rpc-proxy')`, so the
  // sole caller is the already-trusted rpc-proxy; each request is user-driven (a
  // Connect / Disconnect click) and carries the initiator `userId`. Key the
  // bucket by that `userId` so one noisy user does not starve others on the
  // honest path — rpc-proxy derives `userId` from the session `auth.sub`, so this
  // is fairness among forwarded users, NOT a hard boundary against a compromised
  // rpc-proxy (that actor is already trusted by this seam). Fall back to the
  // service identity when no valid `userId` is present. Mirrors the custom
  // `rateLimitMiddleware` on the sibling broker routes (routes/mcpOauth.ts) — a
  // distributed, Postgres-backed limiter. Reuses the `oauthBrokerRlPerMin`
  // per-minute VALUE (default 60/min) but a SEPARATE bucket (`mcp_oauth_internal`
  // type + `mcp-oauth-internal:` key prefix), generous for click-driven traffic.
  const rpcOauthRateLimit = () =>
    rateLimitMiddleware({
      bucketType: 'mcp_oauth_internal',
      maxPerMinute: config.oauthBrokerRlPerMin,
      getBucketKey: req => {
        const uid =
          typeof req.body?.userId === 'string' && req.body.userId.length > 0
            ? req.body.userId
            : (req.internalService?.name ?? 'unknown')
        return `mcp-oauth-internal:${uid}`
      },
      onBackendUnavailable: 'process-memory',
    })

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
  // namespace (authoritative for oauthClientId / grantScope).
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
      const resolved = resolveServerOAuthSubject(server, 'consent')
      if (!resolved) return null
      return { namespace: config.mcpServersNamespace, ...resolved }
    },
  }

  /**
   * The redirect URI an mcp-server's authorize URL carries — the one its client
   * registered at the AS, which the callback replays on the token exchange:
   *   - baked/generic: `/oauth-callback/<oauthClientId>`;
   *   - remote, shared (AS returns RFC 9207 `iss`): `/oauth-callback/remote`;
   *   - remote, per-server: `/oauth-callback/remote/<name>[/<installNonce>]`, the nonce
   *     read from the `dynamic_clients` row bound to this CR.
   * Per-server fails closed without a configured bare origin: the AS compares the URI
   * byte-for-byte, and a request-Host fallback would depend on how the caller reached
   * us. Minting for a server whose callback would reject the code is refused here
   * rather than after the user has consented.
   */
  async function mintRedirectUri(
    req: Request,
    subject: ResolvedServerOAuthSubject,
    mcpServerName: string
  ): Promise<{ ok: true; redirectUri: string } | { ok: false; status: number; body: object }> {
    const remote = subject.decl.remote
    if (!remote) {
      return {
        ok: true,
        redirectUri: buildPublicCallbackUrl(req, subject.decl.id, config.oauthCallbackBaseUrl),
      }
    }
    if (remoteCallbackVariant(remote) === 'shared') {
      return {
        ok: true,
        redirectUri: buildRemoteRedirectUri({
          origin: resolveCallbackOrigin(req, config.oauthCallbackBaseUrl),
          variant: 'shared',
        }),
      }
    }
    // Only a CR written outside the install can carry a name that is not a label; its
    // callback route would never match, so there is no URI to mint.
    if (!isValidRemoteServerNameSegment(mcpServerName)) {
      return { ok: false, status: 400, body: { error: 'invalid_request' } }
    }
    const origin = normalizeConfiguredOrigin(config.oauthCallbackBaseUrl)
    if (origin === null || !isBareOrigin(origin)) {
      req.log?.error(
        { event: 'remote_oauth_per_server_callback_unconfigured', mcpServerName },
        'per-server remote consent requires a configured public callback base URL (bare origin)'
      )
      return { ok: false, status: 503, body: { error: 'callback_base_url_unconfigured' } }
    }
    const registration = await resolvePerServerRegistration(
      { query: (text, values) => pool.query(text, values) },
      { namespace: config.mcpServersNamespace, decl: subject.decl, crUid: subject.crUid },
      mcpServerName
    )
    if (!registration) {
      // Same contract as any other missing client credential, but there is no Secret to
      // create: the DCR client is only (re)registered by installing the server again.
      return {
        ok: false,
        status: 503,
        body: {
          error: 'integration_not_configured',
          integration: subject.decl.id,
          hint: `reinstall the remote MCP server ${mcpServerName} to register its OAuth client again`,
        } satisfies IntegrationNotConfiguredBody,
      }
    }
    return {
      ok: true,
      redirectUri: buildPerServerRedirectUri(origin, mcpServerName, registration),
    }
  }

  /**
   * The body `contextId` of a context-scope request, shape-checked before any
   * read. The type was already checked for every flavor; here it must name a
   * Context: absent or empty is the caller forgetting it, anything that is not a
   * resource name is malformed (and would otherwise reach the apiserver).
   */
  function requireContextId(
    contextId: string | undefined
  ): { ok: true; contextId: string } | { ok: false; body: { error: string } } {
    if (contextId === undefined || contextId.length === 0) {
      return { ok: false, body: { error: 'context_required' } }
    }
    if (!isValidK8sName(contextId)) return { ok: false, body: { error: 'invalid_request' } }
    return { ok: true, contextId }
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
  // `oauthClientId` + `grantScope` come from the McpServer CR (authoritative),
  // never the body. For a context-identity server the body `contextId` names
  // the Context the grant is for; it is admitted only after the access gate
  // below and is then signed into the state. For a per-user server the body
  // `contextId` is ignored beyond its type.
  router.post(
    '/internal/mcp-oauth/authorize-url',
    requireInternalService('rpc-proxy'),
    rpcOauthRateLimit(),
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
        let subject: ReturnType<typeof resolveServerOAuthSubject> = null
        let incoherent: RemoteOAuthSpecIncoherentError | undefined
        try {
          subject = resolveServerOAuthSubject(server, 'consent')
        } catch (err) {
          if (!(err instanceof RemoteOAuthSpecIncoherentError)) throw err
          incoherent = err
        }
        // An incoherent remote server is refused only after the membership gate, so
        // a non-member learns nothing about its configuration; until then the gates
        // run on its grant coordinate, derived by the same rule.
        const coord = subject ?? (incoherent ? resolveServerOAuth(server) : null)
        if (authType !== 'oauth' || !coord) {
          return res.status(400).json({ error: 'not_oauth_server' })
        }

        // Access gate, failing EARLY (before sending the user to the provider),
        // by flavor:
        //   - `context`: the grant belongs to the Context named in the body. It
        //     must exist, be live, allowlist the server, and be reached by the
        //     user (directly or through an assigned agent's Host), because the
        //     resulting shared grant is planted for that whole Context. Every
        //     access denial is the same 403, so the mint reveals nothing about
        //     which Contexts exist or what they enable. The `contextId` shape
        //     check runs before the gate, so its 400 does reveal that the
        //     server is `context`-scope — accepted: that is server
        //     configuration, and existence (404) and oauth-ness (400) were
        //     already answered before the gate.
        //   - `user`: the grant is keyed by (user, server) and serves every
        //     Context that enables the server, so the user must reach at least
        //     one Context whose `spec.mcpServers` allowlist names it — directly
        //     (`user_contexts`) or through an assigned agent's Host — which is
        //     every Context the flat catalog or the connectors panel resolves
        //     for them.
        // Either way, connect shares the `mcp:server:invoke` scope with invoke,
        // so without this gate any user could start consent for (and enumerate)
        // integrations none of their Contexts expose.
        //
        // Deliberately NOT resolveInvocableMcpServersForContexts: that applies
        // the grant-presence gate, which filters out servers WITHOUT a grant —
        // exactly the ones connect exists to bootstrap (chicken-and-egg). The
        // callback re-checks the same rules before exchanging the code.
        let grantContextId: string | undefined
        if (coord.grantScope === 'context') {
          const requested = requireContextId(contextId)
          if (!requested.ok) return res.status(400).json(requested.body)
          const reaches = await userReachesContext({
            gateway,
            contextsNamespace: config.contextsNamespace,
            hostsNamespace: config.hostsNamespace,
            userId,
            contextName: requested.contextId,
            mcpServerName,
            requireAllowlist: true,
          })
          if (!reaches) {
            return res.status(403).json({ error: 'context_membership_denied' })
          }
          grantContextId = requested.contextId
        } else {
          const enabled = await userHasContextEnablingMcpServer({
            gateway,
            contextsNamespace: config.contextsNamespace,
            hostsNamespace: config.hostsNamespace,
            userId,
            mcpServerName,
          })
          if (!enabled) {
            return res.status(403).json({ error: 'context_membership_denied' })
          }
        }
        if (incoherent) throw incoherent
        const resolved = subject
        if (!resolved) return res.status(400).json({ error: 'not_oauth_server' })

        const oauthClientId = resolved.decl.id
        const redirect = await mintRedirectUri(req, resolved, mcpServerName)
        if (!redirect.ok) return res.status(redirect.status).json(redirect.body)
        const redirectUri = redirect.redirectUri

        const result = await buildAuthorizeUrl(
          {
            subjectKind: 'mcp',
            mcpServerName,
            oauthClientId,
            // Initiator forwarded from the session by rpc-proxy (see note above).
            userId,
            // mcp reactive consent mints per-user-shaped states; grant-scope
            // routing (user vs shared) is resolved authoritatively on the
            // callback from the CR's grantScope.
            grantKind: 'user',
            background: false,
            redirectUri,
            ...(grantContextId !== undefined ? { contextId: grantContextId } : {}),
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
                ...(grantContextId !== undefined ? { contextName: grantContextId } : {}),
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
        if (err instanceof RemoteOAuthSpecIncoherentError) {
          return res.status(409).json({ error: err.code, reason: err.reason })
        }
        next(err)
      }
    }
  )

  // ── U4 (spec 11): revoke an OAuth mcp-server grant from the desktop panel ──
  //
  // End-user "Disconnect <server>". rpc-proxy fronts this and forwards the
  // session `userId` (auth.sub) over the mutually-authenticated seam
  // (requireInternalService('rpc-proxy')) — NEVER a client-controlled param.
  // `oauthClientId` + `grantScope` are derived from the McpServer CR, never the
  // body. For a context-identity server the Context is
  // the body `contextId`, used only after the gate below has validated it
  // against the caller's own access.
  //
  // Authorization BY FLAVOR:
  //   - `user`    → the caller may only delete their OWN grant — the key is
  //     built on the forwarded `userId`. For an END-USER a cross-user delete is
  //     structurally impossible, because rpc-proxy derives `userId` from the
  //     session `auth.sub` and never from the body; control-api trusts that on
  //     the service-token seam (it does not re-verify the identity itself). No
  //     Context membership is required: the key already confines the delete to
  //     the caller, and a user who has left every Context must still be able to
  //     revoke the token they granted.
  //   - `context` → the body `contextId` names the Context whose shared grant
  //     is revoked; any user who reaches that live Context (directly or through
  //     an assigned agent's Host) may revoke it → blast-radius: the WHOLE
  //     Context is disconnected, and no other Context's grant of the same
  //     server. The Context's allowlist is NOT required: revoking never widens
  //     access, and a member must be able to remove a grant the Context stopped
  //     enabling. Fail-closed: no contextId, or a caller who does not reach it,
  //     is rejected.
  //
  // Existence (404) and oauth-ness (400) are answered before either branch, for
  // every caller. A server with no usable OAuth id is rejected — the grant is
  // NEVER deleted blindly.
  //
  // Idempotent: deleting a grant that does not exist returns 204 (matching the
  // sandbox-ui grant delete below). We deliberately do NOT surface "no grant
  // existed" as a distinct status — the desktop treats disconnect as idempotent,
  // and a 404 would leak which (server, user/context) pairs are connected.
  router.delete(
    '/internal/mcp-oauth/grant',
    requireInternalService('rpc-proxy'),
    rpcOauthRateLimit(),
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

        // Read the server to derive the grant coordinate. Never trust the body.
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
        // `resolveServerOAuth` (not …Subject): revoke only needs the grant
        // coordinate (oauthClientId + grantScope), not the
        // client-secret refs — `resolveServerOAuth` never reads the Secret, so
        // there is no reason to require the fuller subject here. Gate on
        // `auth.type==='oauth'` to stay aligned with the U1 classifier /
        // grant-presence gate.
        const resolved = authType === 'oauth' ? resolveServerOAuth(server) : null
        if (!resolved) {
          return res.status(400).json({ error: 'not_oauth_server' })
        }

        let grantContextId: string | undefined
        if (resolved.grantScope === 'context') {
          const requested = requireContextId(contextId)
          if (!requested.ok) return res.status(400).json(requested.body)
          const reaches = await userReachesContext({
            gateway,
            contextsNamespace: config.contextsNamespace,
            hostsNamespace: config.hostsNamespace,
            userId,
            contextName: requested.contextId,
            mcpServerName,
            requireAllowlist: false,
          })
          if (!reaches) {
            return res.status(403).json({ error: 'context_membership_denied' })
          }
          grantContextId = requested.contextId
        }

        // Build the flavored delete key from the SAME source of truth the
        // grant-presence gate reads by (D4/F2). null ⇒ fail-closed.
        const key = buildMcpServerGrantKey(resolved, {
          mcpServersNamespace: config.mcpServersNamespace,
          mcpServerName,
          userId,
          contextId: grantContextId,
        })
        if (!key) {
          // Unreachable: `buildMcpServerGrantKey` returns null only without the
          // flavor's coordinate, and both were validated non-empty above. Fail
          // closed defensively rather than delete against a malformed key — with
          // the generic `invalid_request` (mirrors the token mint's null-key
          // guard, routes/mcpOauth.ts).
          return res.status(400).json({ error: 'invalid_request' })
        }

        const deletedRows = await deleteOAuthGrant(
          { query: (text, values) => pool.query(text, values) },
          key
        )

        // Audit trail (sensitive: a revocation). Structured, pino-redacted; no
        // tokens/secrets are read or logged here. `userId` is the acting
        // principal, `contextName` the grant's Context (present only for the
        // `context` flavor; a per-user grant has none), and `deleted` records
        // whether a row was actually removed (false on an idempotent no-op) so
        // the audit trail is honest about what happened.
        req.log?.info(
          {
            event: 'mcp_oauth_grant_revoked',
            mcpServerName,
            grantScope: resolved.grantScope,
            oauthClientId: resolved.oauthClientId,
            userId,
            ...(grantContextId !== undefined ? { contextName: grantContextId } : {}),
            deleted: deletedRows > 0,
          },
          'mcp oauth grant revoked'
        )
        return res.status(204).end()
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

        const result = await getAccessTokenReactive(
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
