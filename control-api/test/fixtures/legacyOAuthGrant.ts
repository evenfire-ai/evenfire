/**
 * Fixtures for unsealed (legacy, `cr_uid IS NULL`) mcp-server grants and for the
 * same-name reinstalls that meet them.
 *
 * Every artefact comes from its real producer (T1):
 *   - CRs are created in the `MockGateway` (which assigns each installation its
 *     uid, as the apiserver does). Their `spec.oauth` comes from the install
 *     builders (`buildGenericOAuthSpec`, `buildRemoteOAuthSpec` over a real
 *     `discoverRemoteOAuth` result); baked specs are the CRD shape the registry
 *     writes (`id` + `provider` + both refs).
 *   - Legacy rows are written by the producers the pod that predates install
 *     identity ran on consent: the provider adapter's token parse and the store
 *     primitive, with `cr_uid` NULL because that pod never read `metadata.uid`.
 *     This build's callback refuses such a consent, so it cannot write them.
 *   - Current consents run the real callback on a state from the real mint.
 *   - Reader keys come from `resolveServerOAuth` + `buildMcpServerGrantKey` over
 *     the CR the gateway returns.
 */
import { config } from '../../src/config.js'
import type { DbClient } from '../../src/db.js'
import type { PinnedTransport } from '../../src/http/pinnedFetch.js'
import {
  type CallbackTarget,
  type McpServerOAuthSubject,
  handleOAuthCallback,
} from '../../src/oauth/callback.js'
import { type DiscoveryResult, discoverRemoteOAuth } from '../../src/oauth/discovery.js'
import {
  type McpServerOAuthSpecInput,
  buildMcpServerGrantKey,
  resolveServerOAuth,
  resolveServerOAuthSubject,
} from '../../src/oauth/mcpServerOAuthSpec.js'
import { getOAuthProviderAdapter, isKnownOAuthProvider } from '../../src/oauth/providers.js'
import {
  type OAuthGrantKey,
  bootstrapSharedOAuthGrant,
  upsertOAuthGrant,
} from '../../src/oauth/store.js'
import { buildGenericOAuthSpec } from '../../src/routes/admin/registryGenericOauth.js'
import { buildRemoteOAuthSpec } from '../../src/routes/admin/remoteMcp.js'
import type { MockGateway } from '../mockGateway.js'
import { mintMcpState } from './mcpOAuthState.js'
import { PILOTS, makeDiscoveryTransport } from './remoteOAuthDiscovery.js'

export const NS = config.mcpServersNamespace
export const CONTEXT = 'ctx-legacy'
/** The `oauth.id` every installation of the colliding server declares. */
export const OAUTH_ID = 'shared-client'
export const VALIDATED_IP = '93.184.216.34'
export const GENERIC_TOKEN_ENDPOINT = 'https://idp.example.com/token'

const STATE_SECRET = 'legacy-grant-fixture-state-secret-0123456789'

export type ServerCR = McpServerOAuthSpecInput & { metadata: { uid: string; name: string } }
export type OAuthSpec = Record<string, unknown>

/** Baked `spec.oauth`: a platform provider adapter with K8s client credentials. */
export function bakedOAuth(provider: string, grantScope: 'user' | 'context'): OAuthSpec {
  return {
    id: OAUTH_ID,
    provider,
    clientIdRef: { name: `${provider}-creds`, key: 'client-id' },
    clientSecretRef: { name: `${provider}-creds`, key: 'client-secret' },
    scopes: ['read'],
    grantScope,
  }
}

/** Generic self-hosted `spec.oauth`, public client, exactly as the install writes it. */
export function genericOAuth(grantScope: 'user' | 'context'): OAuthSpec {
  return buildGenericOAuthSpec({
    id: OAUTH_ID,
    knobs: {
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: GENERIC_TOKEN_ENDPOINT,
      tokenRequestFormat: 'form',
      tokenAuthMethod: 'body',
      scopeSeparator: 'space',
      sendScope: true,
      usePkce: true,
      includeResponseType: true,
      supportsRefresh: true,
    },
    scopes: ['read'],
    grantScope,
  })
}

/**
 * A real discovery result for a remote MCP server. The sentry pilot advertises
 * RFC 9207 `iss`, which remote consent requires.
 */
export async function remoteDiscovery(): Promise<DiscoveryResult> {
  const outcome = await discoverRemoteOAuth(PILOTS.sentry.mcpUrl, {
    transport: makeDiscoveryTransport(PILOTS.sentry),
    resolveDns: async () => [VALIDATED_IP],
  })
  if (!outcome.ok) throw new Error(`fixture discovery failed: ${outcome.error.kind}`)
  return outcome.result
}

/** Remote public `spec.oauth` whose client id collides with the legacy one. */
export function remoteOAuth(discovery: DiscoveryResult, grantScope: 'user' | 'context'): OAuthSpec {
  const oauth = buildRemoteOAuthSpec(discovery, {
    clientMode: 'public',
    grantScope,
    cimdClientId: OAUTH_ID,
  })
  if (oauth.supportsRefresh !== true) throw new Error('fixture: remote pilot must support refresh')
  return oauth as unknown as OAuthSpec
}

/** Install `name` with `oauth` and return the CR as the gateway stores it. */
export async function installServer(
  gateway: MockGateway,
  name: string,
  oauth: OAuthSpec
): Promise<ServerCR> {
  await gateway.createResource(
    'mcpservers',
    {
      metadata: { name },
      spec: {
        enabled: true,
        auth: { type: 'oauth' },
        transport: { url: `http://${name}.${NS}.svc:3000/mcp` },
        oauth,
      },
    },
    NS
  )
  return (await gateway.getResource('mcpservers', name, NS)) as ServerCR
}

/** Uninstall `name` (without purging grants) and install it again with `oauth`. */
export async function reinstallServer(
  gateway: MockGateway,
  name: string,
  oauth: OAuthSpec
): Promise<ServerCR> {
  await gateway.deleteResource('mcpservers', name, NS)
  return installServer(gateway, name, oauth)
}

/** The reader key exactly as the token broker / grant gate / sweep derive it. */
export function readerKey(server: ServerCR, userId?: string): OAuthGrantKey {
  const resolved = resolveServerOAuth(server)
  if (!resolved) throw new Error('fixture: server did not resolve as OAuth')
  const key = buildMcpServerGrantKey(resolved, {
    mcpServerName: server.metadata.name,
    mcpServersNamespace: NS,
    userId,
    contextId: CONTEXT,
  })
  if (!key) throw new Error('fixture: no grant key')
  return key
}

export interface ConsentTokens {
  accessToken: string
  refreshToken: string
  /** Seconds; anything under the 60s reactive buffer is already due for refresh. */
  expiresIn: number
}

function tokenResponse(tokens: ConsentTokens) {
  return {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expires_in: tokens.expiresIn,
    token_type: 'Bearer',
  }
}

/**
 * The consent request as the authorize-URL mint signs it today (the real mint, over
 * the CR currently in the gateway): a context-scope server's state carries the
 * Context it was validated for, a per-user one carries none.
 */
async function consentInput(
  gateway: MockGateway,
  name: string,
  userId: string,
  server: ServerCR,
  target?: CallbackTarget
) {
  const contextScoped =
    (server.spec as { oauth?: { grantScope?: unknown } }).oauth?.grantScope === 'context'
  return {
    target: target ?? {
      kind: 'client' as const,
      id: OAUTH_ID,
      redirectUri: `https://control.example.com/api/v1/oauth-callback/${OAUTH_ID}`,
    },
    code: `code-${name}-${userId}`,
    state: await mintMcpState(
      {
        mcpServerReader: currentSubjectReader(gateway),
        secretReader: { read: async () => ({ 'client-id': 'CID' }) },
      },
      STATE_SECRET,
      {
        mcpServerName: name,
        userId,
        oauthClientId: OAUTH_ID,
        ...(contextScoped ? { contextId: CONTEXT } : {}),
      }
    ),
  }
}

/** The production subject reader (uid included) over the gateway. */
function currentSubjectReader(gateway: MockGateway) {
  return {
    async read(serverName: string): Promise<McpServerOAuthSubject | null> {
      const cr = (await gateway.getResource('mcpservers', serverName, NS)) as ServerCR
      const resolved = resolveServerOAuthSubject(cr, 'consent')
      return resolved ? { namespace: NS, ...resolved } : null
    },
  }
}

/**
 * The grant a pod WITHOUT install identity persisted on consent: the CR currently in
 * the gateway (baked) read as that pod read it, without its uid, so the row is
 * written with `cr_uid` NULL.
 *
 * This build's callback can no longer produce such a row (it refuses any consent
 * whose installation it cannot identify), so the fixture runs the two producers
 * that pod's persistence step ran: the provider adapter parses the token response
 * and the store primitive writes it, with the same coordinates the callback passes
 * (user → `upsertOAuthGrant`, context → `bootstrapSharedOAuthGrant` keyed by
 * `buildMcpServerGrantKey`, `userId` as bootstrapper).
 */
export async function legacyConsent(
  db: DbClient,
  encryptionKey: Buffer,
  gateway: MockGateway,
  name: string,
  userId: string,
  tokens: ConsentTokens
): Promise<void> {
  const cr = (await gateway.getResource('mcpservers', name, NS)) as ServerCR
  const { uid: _preIdentityPodNeverReadIt, ...metadata } = cr.metadata
  const subject = resolveServerOAuthSubject({ ...cr, metadata }, 'consent')
  if (!subject) throw new Error('fixture: legacy server did not resolve as OAuth')
  if (subject.crUid !== undefined) throw new Error('fixture: legacy subject carries a uid')
  const provider = subject.decl.provider
  if (!isKnownOAuthProvider(provider)) throw new Error('fixture: legacy consent must be baked')
  const parsed = getOAuthProviderAdapter(provider).parseTokenResponse(tokenResponse(tokens))

  if (subject.grantScope === 'context') {
    const key = buildMcpServerGrantKey(subject.coordinate, {
      mcpServerName: name,
      mcpServersNamespace: NS,
      contextId: CONTEXT,
    })
    if (!key || key.grantKind !== 'shared') throw new Error('fixture: no shared grant key')
    await bootstrapSharedOAuthGrant(db, encryptionKey, {
      ownerKind: key.ownerKind,
      recipeNamespace: key.recipeNamespace,
      recipeName: key.recipeName,
      contextId: key.contextId,
      oauthClientId: key.oauthClientId,
      bootstrappedByUserId: userId,
      provider,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      accessTokenExpiresInSec: parsed.expiresIn,
      crUid: key.crUid,
    })
    return
  }
  await upsertOAuthGrant(db, encryptionKey, {
    grantKind: 'user',
    ownerKind: 'mcpserver',
    recipeNamespace: NS,
    recipeName: name,
    userId,
    oauthClientId: subject.decl.id,
    provider,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    accessTokenExpiresInSec: parsed.expiresIn,
    crUid: subject.crUid,
  })
}

/**
 * Consent through the real callback as this build does (the production subject
 * reader, uid included) on the CR currently in the gateway. Remote/generic
 * exchanges go through `transport`; a baked exchange would use no transport.
 */
export async function currentConsent(
  db: DbClient,
  encryptionKey: Buffer,
  gateway: MockGateway,
  name: string,
  userId: string,
  transport: PinnedTransport,
  /** RFC 9207 `iss` of the authorization response; the remote lane requires it. */
  iss?: string
): Promise<void> {
  // Each lane's own callback URL, as its authorize URL registers it: a remote server
  // always consents on a remote URI (the shared one here, as `iss` is supplied).
  const cr = (await gateway.getResource('mcpservers', name, NS)) as ServerCR
  const target: CallbackTarget | undefined =
    (cr.spec as { oauth?: { source?: unknown } }).oauth?.source === 'remote'
      ? { kind: 'remote-shared', origin: 'https://control.example.com' }
      : undefined
  const result = await handleOAuthCallback(
    { ...(await consentInput(gateway, name, userId, cr, target)), iss },
    {
      db,
      recipeReader: { read: async () => null },
      secretReader: { read: async () => ({}) },
      mcpServerReader: currentSubjectReader(gateway),
      contextAccessReader: async () => true,
      userServerAccessReader: async () => true,
      fetchFn: (async () => {
        throw new Error('remote/generic consent must not use fetchFn')
      }) as unknown as typeof fetch,
      stateSecret: STATE_SECRET,
      encryptionKey,
      resolveDns: async () => [VALIDATED_IP],
      pinnedTransport: transport,
    }
  )
  if (result.kind !== 'ok') throw new Error(`fixture: consent failed: ${result.kind}`)
}

export interface RecordedPost {
  url: string
  body: string
}

/**
 * The network edge of `pinnedFetch` for remote/generic token endpoints: records
 * every POST and answers with fresh tokens, the way an AS that still accepts the
 * presented refresh token would.
 */
export function recordingTokenTransport(response: { accessToken: string; refreshToken: string }): {
  transport: PinnedTransport
  posts: RecordedPost[]
} {
  const posts: RecordedPost[] = []
  const transport: PinnedTransport = async input => {
    posts.push({ url: input.url, body: input.body ?? '' })
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({
        access_token: response.accessToken,
        refresh_token: response.refreshToken,
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    }
  }
  return { transport, posts }
}
