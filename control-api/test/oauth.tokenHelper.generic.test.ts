import { describe, expect, it, vi } from 'vitest'
import type { PinnedRawResponse, PinnedTransportInput } from '../src/http/pinnedFetch.js'
import { resolveServerOAuthSubject } from '../src/oauth/mcpServerOAuthSpec.js'
import * as store from '../src/oauth/store.js'
import { getAccessToken } from '../src/oauth/tokenHelper.js'

/**
 * S3.2 / DEC-28 + D-8 — the GENERIC refresh goes through the IP-pinned transport
 * (never `fetchFn`), targets the pinned refreshEndpoint, and a
 * `supportsRefresh:false` server NEVER attempts a refresh (fail-closed →
 * `no_grant` → the desktop re-consents). The owner decl is produced by the REAL
 * `resolveServerOAuthSubject`.
 */

const ENCRYPTION_KEY = Buffer.alloc(32)
const TOKEN_ENDPOINT = 'https://idp.example.com/token'
const REFRESH_ENDPOINT = 'https://idp.example.com/refresh'
const VALIDATED_IP = '93.184.216.34'
const CLIENT_ID = 'my-generic-client'

function genericOwnerDecl(supportsRefresh: boolean, refreshEndpoint?: string) {
  const resolved = resolveServerOAuthSubject({
    spec: {
      contextRef: 'ctx-A',
      oauth: {
        source: 'generic',
        id: CLIENT_ID,
        authorizationEndpoint: 'https://idp.example.com/authorize',
        tokenEndpoint: TOKEN_ENDPOINT,
        refreshEndpoint,
        resource: 'https://api.example.com',
        tokenRequestFormat: 'form',
        tokenAuthMethod: 'body',
        scopeSeparator: 'space',
        sendScope: true,
        usePkce: true,
        includeResponseType: true,
        supportsRefresh,
        grantScope: 'user',
        scopes: ['read'],
      },
    },
  })
  if (!resolved) throw new Error('fixture: generic resolve returned null')
  return { spec: { oauthClients: [resolved.decl] } }
}

function staleGrant() {
  return {
    provider: 'generic',
    accessToken: 'OLD-AT',
    refreshToken: 'GEN-RT',
    accessTokenExpiresAt: new Date(Date.now() - 60_000),
  } as unknown as Awaited<ReturnType<typeof store.getOAuthGrant>>
}

function recordingTransport(responseJson: string) {
  const calls: { url: string; connectedIP?: string; body?: string }[] = []
  const transport = async (input: PinnedTransportInput): Promise<PinnedRawResponse> => {
    let connectedIP: string | undefined
    input.lookup(
      'idp.example.com',
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
  recipeName: 'gen-server',
  userId: 'user-9',
  oauthClientId: CLIENT_ID,
}

describe('getAccessToken — generic refresh is IP-pinned (DEC-17)', () => {
  it('refreshes a stale generic grant via pinnedTransport to the validated IP, not fetchFn', async () => {
    vi.spyOn(store, 'getOAuthGrant').mockResolvedValue(staleGrant())
    const refreshSpy = vi
      .spyOn(store, 'refreshOAuthGrantTokens')
      .mockResolvedValue({ updated: true } as never)
    const { transport, calls } = recordingTransport(
      JSON.stringify({ access_token: 'NEW-AT', expires_in: 3600 })
    )
    const fetchFn = vi.fn(async () => {
      throw new Error('generic refresh must NOT use fetchFn')
    })

    const result = await getAccessToken(KEY, {
      db: { query: async () => ({ rows: [] }) } as never,
      recipeReader: { read: async () => genericOwnerDecl(true) },
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
    expect(calls[0].body).toContain('grant_type=refresh_token')
    expect(refreshSpy).toHaveBeenCalledWith(
      expect.anything(),
      ENCRYPTION_KEY,
      expect.objectContaining({ provider: 'generic' })
    )
    vi.restoreAllMocks()
  })

  it('targets the pinned refreshEndpoint when set (defaults to tokenEndpoint otherwise)', async () => {
    vi.spyOn(store, 'getOAuthGrant').mockResolvedValue(staleGrant())
    vi.spyOn(store, 'refreshOAuthGrantTokens').mockResolvedValue({ updated: true } as never)
    const { transport, calls } = recordingTransport(JSON.stringify({ access_token: 'NEW-AT' }))

    await getAccessToken(KEY, {
      db: { query: async () => ({ rows: [] }) } as never,
      recipeReader: { read: async () => genericOwnerDecl(true, REFRESH_ENDPOINT) },
      secretReader: { read: async () => ({}) },
      fetchFn: (async () => {
        throw new Error('nope')
      }) as unknown as typeof fetch,
      encryptionKey: ENCRYPTION_KEY,
      resolveDns: async () => [VALIDATED_IP],
      pinnedTransport: transport,
    })

    expect(calls[0].url).toBe(REFRESH_ENDPOINT)
    vi.restoreAllMocks()
  })
})

describe('getAccessToken — generic no-refresh is fail-closed (D-8)', () => {
  it('never attempts a refresh when supportsRefresh=false (returns no_grant)', async () => {
    vi.spyOn(store, 'getOAuthGrant').mockResolvedValue(staleGrant())
    const { transport, calls } = recordingTransport('{}')

    const result = await getAccessToken(KEY, {
      db: { query: async () => ({ rows: [] }) } as never,
      recipeReader: { read: async () => genericOwnerDecl(false) },
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
