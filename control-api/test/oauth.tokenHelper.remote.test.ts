import { describe, expect, it, vi } from 'vitest'
import type { PinnedRawResponse, PinnedTransportInput } from '../src/http/pinnedFetch.js'
import { resolveServerOAuthSubject } from '../src/oauth/mcpServerOAuthSpec.js'
import * as store from '../src/oauth/store.js'
import { getAccessToken } from '../src/oauth/tokenHelper.js'

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

function remoteOwnerDecl(supportsRefresh: boolean) {
  const resolved = resolveServerOAuthSubject({
    spec: {
      contextRef: 'ctx-A',
      oauth: {
        source: 'remote',
        id: CLIENT_ID,
        clientMode: 'public',
        authorizationEndpoint: 'https://mcp.notion.com/authorize',
        tokenEndpoint: TOKEN_ENDPOINT,
        issuer: 'https://mcp.notion.com',
        resource: 'https://mcp.notion.com',
        grantScope: 'user',
        scopes: ['read'],
        bearerInBody: false,
        supportsRefresh,
      },
    },
  })
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
    expect(calls[0].body).toContain('grant_type=refresh_token')
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
