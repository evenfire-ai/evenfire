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
 *   - Legacy rows are written by the real consent callback (`handleOAuthCallback`),
 *     so `provider` is whatever `exchangeAuthCode` persists. The only thing
 *     simulated is the pod that predates install identity: its subject reader
 *     never read `metadata.uid`, so the callback persists `cr_uid` NULL.
 *   - Reader keys come from `resolveServerOAuth` + `buildMcpServerGrantKey` over
 *     the CR the gateway returns.
 */
import { vi } from 'vitest'
import { config } from '../../src/config.js'
import type { DbClient } from '../../src/db.js'
import type { PinnedTransport } from '../../src/http/pinnedFetch.js'
import { type McpServerOAuthSubject, handleOAuthCallback } from '../../src/oauth/callback.js'
import { type DiscoveryResult, discoverRemoteOAuth } from '../../src/oauth/discovery.js'
import {
  type McpServerOAuthSpecInput,
  buildMcpServerGrantKey,
  resolveServerOAuth,
  resolveServerOAuthSubject,
} from '../../src/oauth/mcpServerOAuthSpec.js'
import { signOAuthState } from '../../src/oauth/state.js'
import type { OAuthGrantKey } from '../../src/oauth/store.js'
import { buildGenericOAuthSpec } from '../../src/routes/admin/registryGenericOauth.js'
import { buildRemoteOAuthSpec } from '../../src/routes/admin/remoteMcp.js'
import type { MockGateway } from '../mockGateway.js'
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
        contextRef: CONTEXT,
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

function consentInput(name: string, userId: string) {
  return {
    oauthClientId: OAUTH_ID,
    code: `code-${name}-${userId}`,
    state: signOAuthState(STATE_SECRET, {
      subjectKind: 'mcp',
      mcpServerName: name,
      userId,
      oauthClientId: OAUTH_ID,
      grantKind: 'user',
      background: false,
    }),
    redirectUri: `https://control.example.com/api/v1/oauth-callback/${OAUTH_ID}`,
  }
}

/**
 * Consent through the real callback as a pod WITHOUT install identity did: the CR
 * currently in the gateway (baked) is read as that pod read it, without its uid.
 * The flavor follows the CR's `grantScope` (user → `upsertOAuthGrant`, context →
 * `bootstrapSharedOAuthGrant` with `userId` as bootstrapper).
 */
export async function legacyConsent(
  db: DbClient,
  encryptionKey: Buffer,
  gateway: MockGateway,
  name: string,
  userId: string,
  tokens: ConsentTokens
): Promise<void> {
  const fetchFn = vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => tokenResponse(tokens),
        text: async () => JSON.stringify(tokenResponse(tokens)),
      }) as Response
  )
  const result = await handleOAuthCallback(consentInput(name, userId), {
    db,
    recipeReader: { read: async () => null },
    secretReader: { read: async () => ({ 'client-id': 'CID', 'client-secret': 'CSEC' }) },
    mcpServerReader: {
      async read(serverName): Promise<McpServerOAuthSubject | null> {
        const cr = (await gateway.getResource('mcpservers', serverName, NS)) as ServerCR
        const { uid: _preIdentityPodNeverReadIt, ...metadata } = cr.metadata
        const resolved = resolveServerOAuthSubject({ ...cr, metadata })
        return resolved ? { namespace: NS, ...resolved } : null
      },
    },
    userContextsReader: async () => ({ contextIds: [CONTEXT] }),
    fetchFn: fetchFn as unknown as typeof fetch,
    stateSecret: STATE_SECRET,
    encryptionKey,
  })
  if (result.kind !== 'ok') throw new Error(`fixture: legacy consent failed: ${result.kind}`)
  if (fetchFn.mock.calls.length !== 1) throw new Error('fixture: baked exchange did not run')
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
  const result = await handleOAuthCallback(
    { ...consentInput(name, userId), iss },
    {
      db,
      recipeReader: { read: async () => null },
      secretReader: { read: async () => ({}) },
      mcpServerReader: {
        async read(serverName): Promise<McpServerOAuthSubject | null> {
          const cr = (await gateway.getResource('mcpservers', serverName, NS)) as ServerCR
          const resolved = resolveServerOAuthSubject(cr)
          return resolved ? { namespace: NS, ...resolved } : null
        },
      },
      userContextsReader: async () => ({ contextIds: [CONTEXT] }),
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
