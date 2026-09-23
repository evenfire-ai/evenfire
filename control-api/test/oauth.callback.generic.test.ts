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
 * S3.2 / DEC-28 + DEC-17 — the GENERIC auth-code exchange goes through the
 * IP-pinned `pinnedFetch`, never `fetchFn` (the operator-supplied endpoint is
 * attacker-influenced). T5 invariants: a PUBLIC generic client sends NO
 * client_secret; a CONFIDENTIAL client sends the client_secret read from the k8s
 * Secret; the token POST connects to the validated IP and is never re-resolved.
 *
 * The CR bytes are inline: there is no install-producer for the generic carril in
 * scope, so `spec.oauth` here is apiserver-stored CR data (the resolver's input).
 * The REAL producers exercised are `resolveServerOAuthSubject` (the decl),
 * `buildAdapterFromConfig` (the request) and `pinnedFetch` (the pin).
 */

const STATE_SECRET = 'test-state-hmac-secret-32-bytes-padding'
const ENCRYPTION_KEY = deriveOAuthEncryptionKey(
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
)
const MCP_NS = 'mcp-server'
const VALIDATED_IP = '93.184.216.34'
const TOKEN_ENDPOINT = 'https://idp.example.com/token'
const CLIENT_ID = 'my-generic-client'

function genericCr(confidential: boolean) {
  const oauth: Record<string, unknown> = {
    source: 'generic',
    id: CLIENT_ID,
    authorizationEndpoint: 'https://idp.example.com/authorize',
    tokenEndpoint: TOKEN_ENDPOINT,
    resource: 'https://api.example.com',
    tokenRequestFormat: 'form',
    tokenAuthMethod: 'body',
    scopeSeparator: 'space',
    sendScope: true,
    usePkce: true,
    includeResponseType: true,
    supportsRefresh: true,
    grantScope: 'user',
    scopes: ['read'],
  }
  if (confidential) {
    oauth.clientIdRef = { name: 'gen-creds', key: 'client_id' }
    oauth.clientSecretRef = { name: 'gen-creds', key: 'client_secret' }
  }
  return {
    metadata: { name: 'gen-server', namespace: MCP_NS },
    spec: { contextRef: 'ctx-A', auth: { type: 'oauth' }, oauth },
  }
}

function genericReader(confidential: boolean): McpServerOAuthReader {
  return {
    read: vi.fn(async () => {
      const resolved = resolveServerOAuthSubject(genericCr(confidential))
      if (!resolved) return null
      return { namespace: MCP_NS, ...resolved } as McpServerOAuthSubject
    }),
  }
}

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
      'idp.example.com',
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

function genericInput(): CallbackInput {
  return {
    oauthClientId: CLIENT_ID,
    code: 'AUTH_CODE',
    state: signOAuthState(STATE_SECRET, {
      subjectKind: 'mcp',
      mcpServerName: 'gen-server',
      userId: 'user-9',
      oauthClientId: CLIENT_ID,
      grantKind: 'user',
      background: false,
    } as Parameters<typeof signOAuthState>[1]),
    redirectUri: 'https://control.example.com/api/v1/oauth-callback/my-generic-client',
  }
}

function baseDeps(overrides: Partial<CallbackDeps>): CallbackDeps {
  return {
    db: {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
    } as unknown as CallbackDeps['db'],
    recipeReader: { read: vi.fn(async () => null) },
    userContextsReader: vi.fn(async () => ({ contextIds: ['ctx-A'] })),
    fetchFn: (async () => {
      throw new Error('generic lane must NOT use fetchFn (DEC-17)')
    }) as unknown as typeof fetch,
    stateSecret: STATE_SECRET,
    encryptionKey: ENCRYPTION_KEY,
    ...overrides,
  } as CallbackDeps
}

describe('handleOAuthCallback — generic exchange is IP-pinned (DEC-17)', () => {
  it('PUBLIC: pinned POST to the validated IP, no client_secret, never fetchFn', async () => {
    const { transport, calls } = recordingTransport(
      JSON.stringify({ access_token: 'GEN-AT', refresh_token: 'GEN-RT', expires_in: 3600 })
    )
    const fetchFn = vi.fn(async () => {
      throw new Error('generic lane must NOT use fetchFn')
    })
    const db = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }
    const deps = baseDeps({
      db: db as unknown as CallbackDeps['db'],
      mcpServerReader: genericReader(false),
      secretReader: { read: vi.fn(async () => ({})) } as unknown as CallbackDeps['secretReader'],
      fetchFn: fetchFn as unknown as typeof fetch,
      resolveDns: async () => [VALIDATED_IP],
      pinnedTransport: transport,
    })

    const result = await handleOAuthCallback(genericInput(), deps)

    expect(result.kind).toBe('ok')
    expect(fetchFn).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(TOKEN_ENDPOINT)
    expect(calls[0].connectedIP).toBe(VALIDATED_IP)
    expect(calls[0].body).toContain(`client_id=${CLIENT_ID}`)
    expect(calls[0].body).toContain('code_verifier=')
    expect(calls[0].body).not.toContain('client_secret=')

    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO oauth_grants')
    expect(params[4]).toBe(CLIENT_ID)
    expect(params[5]).toBe('generic') // provider label
  })

  it('CONFIDENTIAL: sends the client_secret read from the k8s Secret', async () => {
    const { transport, calls } = recordingTransport(
      JSON.stringify({ access_token: 'GEN-AT', expires_in: 3600 })
    )
    const secretReader = {
      read: vi.fn(async (name: string) => {
        if (name === 'gen-creds') return { client_id: 'REAL-CID', client_secret: 'REAL-SECRET' }
        return {}
      }),
    }
    const deps = baseDeps({
      mcpServerReader: genericReader(true),
      secretReader: secretReader as unknown as CallbackDeps['secretReader'],
      resolveDns: async () => [VALIDATED_IP],
      pinnedTransport: transport,
    })

    const result = await handleOAuthCallback(genericInput(), deps)

    expect(result.kind).toBe('ok')
    expect(calls).toHaveLength(1)
    expect(calls[0].connectedIP).toBe(VALIDATED_IP)
    // The confidential client_id/secret come from the Secret, not oauth.id.
    expect(calls[0].body).toContain('client_id=REAL-CID')
    expect(calls[0].body).toContain('client_secret=REAL-SECRET')
  })
})
