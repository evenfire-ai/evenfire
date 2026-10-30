import { beforeAll, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import type { PinnedRawResponse, PinnedTransportInput } from '../src/http/pinnedFetch.js'
import { type DiscoveryResult, discoverRemoteOAuth } from '../src/oauth/discovery.js'
import { resolveServerOAuthSubject } from '../src/oauth/mcpServerOAuthSpec.js'
import * as store from '../src/oauth/store.js'
import { getAccessToken } from '../src/oauth/tokenHelper.js'
import { buildRemoteOAuthSpec } from '../src/routes/admin/remoteMcp.js'
import { normalizeMcpServerOwnerDecl } from '../src/routes/mcpOauth.js'
import {
  type InstalledMcpServer,
  WORKIQ_GUID_SCOPE,
  installWorkIqServer,
  seedContext,
} from './fixtures/perServerInstall.js'
import { PILOTS, makeDiscoveryTransport } from './fixtures/remoteOAuthDiscovery.js'
import { MockGateway } from './mockGateway.js'

/**
 * C4/DEC-17 + D-8 — the REMOTE refresh goes through the IP-pinned transport (never
 * `fetchFn`), and a `supportsRefresh:false` server NEVER attempts a refresh
 * (derived from the pinned metadata flag, fail-closed → `no_grant` → the desktop
 * re-consents). The owner decl is produced by the REAL `resolveServerOAuthSubject`.
 */

const ENCRYPTION_KEY = Buffer.alloc(32)
const TOKEN_ENDPOINT = 'https://mcp.notion.com/token'
const VALIDATED_IP = '93.184.216.34'
const CLIENT_ID = 'https://control.example.com/api/v1/.well-known/evenfire-mcp-client'

// Real Notion discovery: CIMD without RFC 9207. A CIMD client there (the shape a CR
// installed before the per-server callback carries) is refused at consent, but a grant it
// already holds keeps refreshing: the refresh reader resolves in the `token` phase.
let notion: DiscoveryResult

beforeAll(async () => {
  const outcome = await discoverRemoteOAuth(PILOTS.notion.mcpUrl, {
    transport: makeDiscoveryTransport(PILOTS.notion),
    resolveDns: async () => [VALIDATED_IP],
  })
  if (!outcome.ok) throw new Error(`fixture discovery failed: ${outcome.error.kind}`)
  notion = outcome.result
})

function remoteOwnerDecl(supportsRefresh: boolean) {
  const oauth = buildRemoteOAuthSpec(notion, {
    clientMode: 'public',
    grantScope: 'user',
    cimdClientId: CLIENT_ID,
  })
  expect(oauth.issForCallback).toBeUndefined()
  expect(oauth.tokenEndpoint).toBe(TOKEN_ENDPOINT)
  // `supportsRefresh` follows the AS metadata (true for Notion); the `false` case is the
  // same block with the flag flipped, as for an AS that advertises no refresh grant.
  const resolved = resolveServerOAuthSubject(
    { spec: { contextRef: 'ctx-A', oauth: { ...oauth, supportsRefresh } } },
    'token'
  )
  if (!resolved) throw new Error('fixture: remote resolve returned null')
  return { spec: { oauthClients: [resolved.decl] } }
}

function staleGrant() {
  return {
    provider: 'remote',
    accessToken: 'OLD-AT',
    refreshToken: 'REMOTE-RT',
    accessTokenExpiresAt: new Date(Date.now() - 60_000), // already expired
  } as unknown as Awaited<ReturnType<typeof store.getOAuthGrant>>
}

function recordingTransport(responseJson: string) {
  const calls: { url: string; connectedIP?: string; body?: string }[] = []
  const transport = async (input: PinnedTransportInput): Promise<PinnedRawResponse> => {
    let connectedIP: string | undefined
    input.lookup(
      'mcp.notion.com',
      { all: true } as never,
      ((err, addrs) => {
        if (!err && Array.isArray(addrs)) connectedIP = addrs[0]?.address
      }) as never
    )
    calls.push({ url: input.url, connectedIP, body: input.body })
    return { status: 200, headers: { 'content-type': 'application/json' }, bodyText: responseJson }
  }
  return { transport, calls }
}

const KEY = {
  grantKind: 'user' as const,
  recipeNamespace: 'mcp-server',
  recipeName: 'notion-remote',
  userId: 'user-9',
  oauthClientId: CLIENT_ID,
}

describe('getAccessToken — remote refresh is IP-pinned (DEC-17)', () => {
  it('refreshes a stale remote grant via pinnedTransport, connects to the validated IP, not fetchFn', async () => {
    vi.spyOn(store, 'getOAuthGrant').mockResolvedValue(staleGrant())
    const refreshSpy = vi
      .spyOn(store, 'refreshOAuthGrantTokens')
      .mockResolvedValue({ updated: true } as never)
    const { transport, calls } = recordingTransport(
      JSON.stringify({ access_token: 'NEW-AT', expires_in: 3600 })
    )
    const fetchFn = vi.fn(async () => {
      throw new Error('remote refresh must NOT use fetchFn')
    })

    const result = await getAccessToken(KEY, {
      db: { query: async () => ({ rows: [] }) } as never,
      recipeReader: { read: async () => remoteOwnerDecl(true) },
      secretReader: { read: async () => ({}) },
      fetchFn: fetchFn as unknown as typeof fetch,
      encryptionKey: ENCRYPTION_KEY,
      resolveDns: async () => [VALIDATED_IP],
      pinnedTransport: transport,
    })

    expect(result).toEqual({ kind: 'ok', accessToken: 'NEW-AT', expiresAt: expect.any(Date) })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(TOKEN_ENDPOINT)
    expect(calls[0].connectedIP).toBe(VALIDATED_IP)
    // I6: without a profile the body is the pre-profile one — resource, never scope.
    expect(calls[0].body).toBe(
      `grant_type=refresh_token&refresh_token=REMOTE-RT&client_id=${encodeURIComponent(CLIENT_ID)}&resource=${encodeURIComponent(notion.resource)}`
    )
    expect(refreshSpy).toHaveBeenCalledWith(
      expect.anything(),
      ENCRYPTION_KEY,
      expect.objectContaining({ provider: 'remote' })
    )
    vi.restoreAllMocks()
  })
})

describe('getAccessToken — no-refresh derived from metadata (D-8, fail-closed)', () => {
  it('never attempts a refresh when supportsRefresh=false (returns no_grant)', async () => {
    vi.spyOn(store, 'getOAuthGrant').mockResolvedValue(staleGrant())
    const { transport, calls } = recordingTransport('{}')

    const result = await getAccessToken(KEY, {
      db: { query: async () => ({ rows: [] }) } as never,
      recipeReader: { read: async () => remoteOwnerDecl(false) },
      secretReader: { read: async () => ({}) },
      fetchFn: (async () => {
        throw new Error('no refresh must be attempted')
      }) as unknown as typeof fetch,
      encryptionKey: ENCRYPTION_KEY,
      pinnedTransport: transport,
    })

    expect(result).toEqual({ kind: 'no_grant' })
    expect(calls).toHaveLength(0)
    vi.restoreAllMocks()
  })
})

describe('getAccessToken — entra-v2 refresh wire (I5, I7)', () => {
  const ENTRA_TOKEN_ENDPOINT =
    'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/oauth2/v2.0/token'
  let workIq: InstalledMcpServer
  // The gateway the install wrote to: the client Secret is read from it, as written.
  let gateway: MockGateway

  beforeAll(async () => {
    gateway = new MockGateway(config.mcpServersNamespace)
    await seedContext(gateway, config.contextsNamespace, 'ctx-a')
    workIq = await installWorkIqServer({ scopes: [WORKIQ_GUID_SCOPE], gateway })
  })

  async function refreshWith(server: InstalledMcpServer) {
    vi.spyOn(store, 'getOAuthGrant').mockResolvedValue(staleGrant())
    vi.spyOn(store, 'refreshOAuthGrantTokens').mockResolvedValue({ updated: true } as never)
    const { transport, calls } = recordingTransport(
      JSON.stringify({ access_token: 'NEW-AT', expires_in: 3600 })
    )
    const owner = normalizeMcpServerOwnerDecl(server as never)
    if (!owner) throw new Error('fixture: the Work IQ CR did not resolve')
    const result = await getAccessToken(
      { ...KEY, recipeName: server.metadata.name, oauthClientId: String(server.spec.oauth.id) },
      {
        db: { query: async () => ({ rows: [] }) } as never,
        recipeReader: { read: async () => owner },
        secretReader: {
          async read(name, namespace) {
            const raw = (await gateway.getSecret(name, namespace)) as {
              data?: Record<string, string>
            }
            return Object.fromEntries(
              Object.entries(raw.data ?? {}).map(([k, v]) => [
                k,
                Buffer.from(v, 'base64').toString(),
              ])
            )
          },
        },
        fetchFn: (async () => {
          throw new Error('remote refresh must NOT use fetchFn')
        }) as unknown as typeof fetch,
        encryptionKey: ENCRYPTION_KEY,
        resolveDns: async () => [VALIDATED_IP],
        pinnedTransport: transport,
      }
    )
    vi.restoreAllMocks()
    return { result, calls }
  }

  it('the POSTed refresh body carries scope with offline_access and no resource', async () => {
    expect(workIq.spec.oauth.resource).toBe('https://workiq.svc.cloud.microsoft/mcp')
    const { result, calls } = await refreshWith(workIq)
    expect(result).toMatchObject({ kind: 'ok', accessToken: 'NEW-AT' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(ENTRA_TOKEN_ENDPOINT)
    const body = new URLSearchParams(calls[0].body ?? '')
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('client_id')).toBe(String(workIq.spec.oauth.id))
    expect(body.get('client_secret')).toBe('entra-client-secret')
    expect(body.get('scope')).toBe(`${WORKIQ_GUID_SCOPE} offline_access`)
    expect(body.has('resource')).toBe(false)
    expect(calls[0].body).not.toContain('resource=')
  })

  it('a CR edited to drop offline_access still refreshes with it', async () => {
    const edited: InstalledMcpServer = {
      ...workIq,
      spec: { ...workIq.spec, oauth: { ...workIq.spec.oauth, scopes: [WORKIQ_GUID_SCOPE] } },
    }
    const { calls } = await refreshWith(edited)
    expect(new URLSearchParams(calls[0].body ?? '').get('scope')).toBe(
      `${WORKIQ_GUID_SCOPE} offline_access`
    )
  })
})
