import { describe, expect, it, vi } from 'vitest'
import type { PinnedRawResponse, PinnedTransportInput } from '../src/http/pinnedFetch.js'
import {
  type CallbackDeps,
  type CallbackInput,
  type McpServerOAuthReader,
  type McpServerOAuthSubject,
  handleOAuthCallback,
} from '../src/oauth/callback.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { resolveServerOAuthSubject } from '../src/oauth/mcpServerOAuthSpec.js'
import { signOAuthState } from '../src/oauth/state.js'

/**
 * C4/DEC-17 — the REMOTE auth-code exchange goes through the IP-pinned
 * `pinnedFetch`, never `fetchFn`, closing the H2 DNS-rebinding TOCTOU on the
 * discovery-derived token endpoint. Baked stays on `fetchFn`, byte-identical.
 *
 * T3 (rebinding): the remote path resolves+validates the token host ONCE and pins
 * the socket to that IP. This test asserts the connected IP equals the validated
 * IP AND that `pinnedTransport` (not `fetchFn`) was used. Against `baf12e1fa` the
 * remote exchange DOES NOT EXIST (`resolveServerOAuthSubject` returns null for
 * `source:'remote'`, so the callback returns `server_not_found`), so the pinned
 * transport is never invoked and this assertion fails.
 *
 * The remote CR bytes are inline (not from `buildRemoteOAuthSpec`) ON PURPOSE:
 * this file must compile+run against the parent SHA where that producer export
 * does not exist. The producer-derived T1 coverage lives in
 * `oauth.mcpServerOAuthSpec.remote.test.ts`; here the REAL producers exercised are
 * `resolveServerOAuthSubject` (the decl) and `pinnedFetch` (the pin).
 */

const STATE_SECRET = 'test-state-hmac-secret-32-bytes-padding'
const ENCRYPTION_KEY = deriveOAuthEncryptionKey(
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
)
const MCP_NS = 'mcp-server'
const VALIDATED_IP = '93.184.216.34'
const TOKEN_ENDPOINT = 'https://mcp.notion.com/token'

// Shape `buildRemoteOAuthSpec` emits for a CIMD-public remote server (kept inline
// so this file runs against the parent SHA — see file docstring).
function remoteServerCr() {
  return {
    metadata: { name: 'notion-remote', namespace: MCP_NS },
    spec: {
      contextRef: 'ctx-A',
      auth: { type: 'oauth' },
      oauth: {
        source: 'remote',
        id: 'https://control.example.com/api/v1/.well-known/evenfire-mcp-client',
        clientMode: 'public',
        authorizationEndpoint: 'https://mcp.notion.com/authorize',
        tokenEndpoint: TOKEN_ENDPOINT,
        issuer: 'https://mcp.notion.com',
        resource: 'https://mcp.notion.com',
        grantScope: 'user',
        scopes: ['read'],
        bearerInBody: false,
        supportsRefresh: true,
      },
    },
  }
}

const REMOTE_CLIENT_ID = remoteServerCr().spec.oauth.id

/** Real reader → real `resolveServerOAuthSubject` (null at parent for remote). */
function remoteReader(): McpServerOAuthReader {
  return {
    read: vi.fn(async () => {
      const resolved = resolveServerOAuthSubject(remoteServerCr())
      if (!resolved) return null
      return { namespace: MCP_NS, ...resolved } as McpServerOAuthSubject
    }),
  }
}

/** A pinned transport that records the URL + the IP the socket would connect to. */
function recordingTransport(responseJson: string, status = 200) {
  const calls: {
    url: string
    connectedIP?: string
    body?: string
    headers: Record<string, string>
  }[] = []
  const transport = async (input: PinnedTransportInput): Promise<PinnedRawResponse> => {
    let connectedIP: string | undefined
    input.lookup(
      'mcp.notion.com',
      { all: true } as never,
      ((err, addrs) => {
        if (!err && Array.isArray(addrs)) connectedIP = addrs[0]?.address
      }) as never
    )
    calls.push({ url: input.url, connectedIP, body: input.body, headers: input.headers })
    return { status, headers: { 'content-type': 'application/json' }, bodyText: responseJson }
  }
  return { transport, calls }
}

function remoteState() {
  // The signed state binds the REAL client id; the URL segment is the reserved
  // stable `remote` (CIMD/DCR register one fixed redirect_uri).
  return signOAuthState(STATE_SECRET, {
    subjectKind: 'mcp',
    mcpServerName: 'notion-remote',
    userId: 'user-9',
    oauthClientId: REMOTE_CLIENT_ID,
    grantKind: 'user',
    background: false,
  } as Parameters<typeof signOAuthState>[1])
}

function remoteInput(): CallbackInput {
  return {
    oauthClientId: 'remote', // stable segment, not the client id
    code: 'AUTH_CODE',
    state: remoteState(),
    redirectUri: 'https://control.example.com/api/v1/oauth-callback/remote',
  }
}

describe('handleOAuthCallback — remote exchange is IP-pinned (DEC-17, T3)', () => {
  it('exchanges via pinnedTransport, connects to the validated IP, never touches fetchFn', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }
    const fetchFn = vi.fn(async () => {
      throw new Error('remote lane must NOT use fetchFn (DEC-17)')
    })
    const { transport, calls } = recordingTransport(
      JSON.stringify({ access_token: 'REMOTE-AT', refresh_token: 'REMOTE-RT', expires_in: 3600 })
    )

    const deps: CallbackDeps = {
      db: db as unknown as CallbackDeps['db'],
      recipeReader: { read: vi.fn(async () => null) },
      mcpServerReader: remoteReader(),
      userContextsReader: vi.fn(async () => ({ contextIds: ['ctx-A'] })),
      secretReader: { read: vi.fn(async () => ({})) } as unknown as CallbackDeps['secretReader'],
      fetchFn: fetchFn as unknown as typeof fetch,
      stateSecret: STATE_SECRET,
      encryptionKey: ENCRYPTION_KEY,
      resolveDns: async () => [VALIDATED_IP],
      pinnedTransport: transport,
    }

    const result = await handleOAuthCallback(remoteInput(), deps)

    // Observable outcome: a grant was persisted with provider 'remote'.
    expect(result.kind).toBe('ok')
    expect(fetchFn).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    // T3 core: the socket connected to the IP the kernel validated — no re-resolve.
    expect(calls[0].url).toBe(TOKEN_ENDPOINT)
    expect(calls[0].connectedIP).toBe(VALIDATED_IP)
    // Public client → form body carries client_id + PKCE verifier, no client_secret.
    expect(calls[0].headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(calls[0].headers['content-length']).toBe(String(Buffer.byteLength(calls[0].body ?? '')))
    expect(calls[0].body).toContain(`client_id=${encodeURIComponent(REMOTE_CLIENT_ID)}`)
    expect(calls[0].body).toContain('code_verifier=')
    expect(calls[0].body).not.toContain('client_secret=')

    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO oauth_grants')
    expect(params[0]).toBe('mcpserver')
    expect(params[4]).toBe(REMOTE_CLIENT_ID)
    expect(params[5]).toBe('remote') // provider label
  })
})

describe('baked mcp exchange stays on fetchFn (byte-identical, T5c)', () => {
  it('uses fetchFn and never the pinned transport for a baked server', async () => {
    const bakedServer = {
      metadata: { name: 'gdrive', namespace: MCP_NS },
      spec: {
        contextRef: 'ctx-A',
        auth: { type: 'oauth' },
        oauth: {
          id: 'google-drive',
          provider: 'google',
          clientIdRef: { name: 'google-creds', key: 'client-id' },
          clientSecretRef: { name: 'google-creds', key: 'client-secret' },
          scopes: ['drive'],
          backgroundAccess: false,
        },
      },
    }
    const resolved = resolveServerOAuthSubject(bakedServer)
    if (!resolved) throw new Error('fixture: baked resolve returned null')
    const subject = { namespace: MCP_NS, ...resolved } as McpServerOAuthSubject

    const db = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
      text: async () => '',
    }))
    const pinnedTransport = vi.fn(async () => {
      throw new Error('baked lane must NOT use pinnedTransport')
    })

    const deps: CallbackDeps = {
      db: db as unknown as CallbackDeps['db'],
      recipeReader: { read: vi.fn(async () => null) },
      mcpServerReader: { read: vi.fn(async () => subject) },
      userContextsReader: vi.fn(async () => ({ contextIds: ['ctx-A'] })),
      secretReader: {
        read: vi.fn(async () => ({ 'client-id': 'CID', 'client-secret': 'CSEC' })),
      } as unknown as CallbackDeps['secretReader'],
      fetchFn: fetchFn as unknown as typeof fetch,
      stateSecret: STATE_SECRET,
      encryptionKey: ENCRYPTION_KEY,
      pinnedTransport,
    }

    const input: CallbackInput = {
      oauthClientId: 'google-drive',
      code: 'AUTH_CODE',
      state: signOAuthState(STATE_SECRET, {
        subjectKind: 'mcp',
        mcpServerName: 'gdrive',
        userId: 'user-9',
        oauthClientId: 'google-drive',
        grantKind: 'user',
        background: false,
      } as Parameters<typeof signOAuthState>[1]),
      redirectUri: 'https://control.example.com/api/v1/oauth-callback/google-drive',
    }

    const result = await handleOAuthCallback(input, deps)
    expect(result.kind).toBe('ok')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(pinnedTransport).not.toHaveBeenCalled()
  })
})
