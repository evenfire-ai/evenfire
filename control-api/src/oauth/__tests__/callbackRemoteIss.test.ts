import { describe, expect, it, vi } from 'vitest'
import type { PinnedRawResponse, PinnedTransport } from '../../http/pinnedFetch.js'
import type { DnsResolver } from '../../http/validateMcpServerSpec.js'
import {
  type CallbackDeps,
  type CallbackInput,
  type McpServerOAuthSubject,
  REMOTE_CALLBACK_CLIENT_SEGMENT,
  handleOAuthCallback,
} from '../callback.js'
// State is derived from the REAL producer (T1): never hand-write the signed
// wire format. `signOAuthState` is the same signer the authorize-URL path uses.
import { signOAuthState } from '../state.js'

/**
 * RFC 9207 issuer validation on the remote OAuth lane (H-1).
 *
 * The remote AS issuer is discovered and pinned on the McpServer CR
 * (`spec.oauth.issForCallback`), surfaced as `subject.decl.remote.issForCallback`.
 * The callback must read the authorization-response `iss` (`input.iss`) and, when
 * an issuer was advertised, require an exact match BEFORE the single-use auth-code
 * is exchanged — the AS mix-up defence. When no issuer was advertised the check is
 * skipped (fail-open by absence of producer data). These tests pin the observable
 * outcome (T4): a mismatch/absent `iss` short-circuits to `issuer_mismatch` with no
 * exchange and no persist; a match (or a not-advertised issuer) exchanges normally.
 */

const STATE_SECRET = 'test-state-secret-0123456789abcdef' // ≥ 32 chars
const ENCRYPTION_KEY = Buffer.alloc(32, 7) // AES-256-GCM key

const OAUTH_CLIENT_ID = 'remote-client'
const MCP_SERVER_NAME = 'remote-gdrive'
const USER_ID = 'user-42'
const ADVERTISED_ISS = 'https://as.example.test'
const TOKEN_ENDPOINT = 'https://as.example.test/token'
const AUTHORIZE_ENDPOINT = 'https://as.example.test/authorize'

/** A REMOTE (discovery-derived) OAuth subject. `public` secretSource ⇒ no Secret read. */
function remoteSubject(
  overrides: {
    issForCallback?: string
  } = {}
): McpServerOAuthSubject {
  return {
    namespace: 'mcp-servers',
    grantScope: 'user',
    decl: {
      id: OAUTH_CLIENT_ID,
      provider: 'remote',
      remote: {
        authorizationEndpoint: AUTHORIZE_ENDPOINT,
        tokenEndpoint: TOKEN_ENDPOINT,
        clientMode: 'public',
        bearerInBody: false,
        supportsRefresh: true,
        // Present iff advertised; `undefined` models an AS that did not carry `iss`.
        ...('issForCallback' in overrides ? { issForCallback: overrides.issForCallback } : {}),
      },
      secretSource: { kind: 'public' },
    },
  }
}

function signedMcpState(): string {
  return signOAuthState(STATE_SECRET, {
    subjectKind: 'mcp',
    mcpServerName: MCP_SERVER_NAME,
    userId: USER_ID,
    oauthClientId: OAUTH_CLIENT_ID,
    grantKind: 'user',
    background: false,
  })
}

function input(overrides: Partial<CallbackInput> = {}): CallbackInput {
  return {
    // Stable remote callback: the URL segment is the reserved constant, the real
    // client id rides the signed state.
    oauthClientId: REMOTE_CALLBACK_CLIENT_SEGMENT,
    code: 'auth-code-single-use',
    state: signedMcpState(),
    redirectUri: 'https://callback.example.test/api/v1/oauth-callback/remote',
    ...overrides,
  }
}

/** A pinned transport that returns a valid token response if the exchange is reached. */
function okPinnedTransport(): PinnedTransport {
  return vi.fn(
    async (): Promise<PinnedRawResponse> => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    })
  )
}

/** Fixed public IPv4 so the token endpoint host passes the SSRF kernel. */
function publicResolveDns(): DnsResolver {
  return vi.fn(async () => ['93.184.216.34'])
}

function buildDeps(
  opts: {
    subject?: McpServerOAuthSubject
    pinnedTransport?: PinnedTransport
    resolveDns?: DnsResolver
    db?: CallbackDeps['db']
  } = {}
): CallbackDeps {
  const db =
    opts.db ??
    ({
      query: vi.fn(async () => ({ rowCount: 1, rows: [{ id: 'grant-1' }] })),
    } as unknown as CallbackDeps['db'])
  return {
    db,
    recipeReader: { read: vi.fn(async () => null) },
    secretReader: {
      // Public client ⇒ never read; a call here would be a regression.
      read: vi.fn(async () => ({}) as Record<string, string>),
    } as unknown as CallbackDeps['secretReader'],
    mcpServerReader: { read: vi.fn(async () => opts.subject ?? remoteSubject()) },
    // Remote lane never touches globalThis fetch (DEC-17); a call is a regression.
    fetchFn: vi.fn() as unknown as typeof fetch,
    stateSecret: STATE_SECRET,
    encryptionKey: ENCRYPTION_KEY,
    resolveDns: opts.resolveDns ?? publicResolveDns(),
    pinnedTransport: opts.pinnedTransport ?? okPinnedTransport(),
  }
}

describe('handleOAuthCallback — remote lane RFC 9207 iss validation (H-1)', () => {
  it('rejects a mismatched iss WITHOUT exchanging the auth-code or persisting', async () => {
    const pinnedTransport = okPinnedTransport()
    const deps = buildDeps({
      subject: remoteSubject({ issForCallback: ADVERTISED_ISS }),
      pinnedTransport,
    })

    const result = await handleOAuthCallback(input({ iss: 'https://evil.example.test' }), deps)

    // Observable outcome (T4).
    expect(result.kind).toBe('issuer_mismatch')
    // The single-use code is NOT burned and nothing is persisted.
    expect(pinnedTransport).not.toHaveBeenCalled()
    expect(deps.db.query as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('rejects an absent iss when an issuer was advertised (fail closed)', async () => {
    const pinnedTransport = okPinnedTransport()
    const deps = buildDeps({
      subject: remoteSubject({ issForCallback: ADVERTISED_ISS }),
      pinnedTransport,
    })

    const result = await handleOAuthCallback(input({ iss: undefined }), deps)

    expect(result.kind).toBe('issuer_mismatch')
    expect(pinnedTransport).not.toHaveBeenCalled()
    expect(deps.db.query as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('accepts a matching iss: exchange runs once and the grant is persisted', async () => {
    const pinnedTransport = okPinnedTransport()
    const deps = buildDeps({
      subject: remoteSubject({ issForCallback: ADVERTISED_ISS }),
      pinnedTransport,
    })

    const result = await handleOAuthCallback(input({ iss: ADVERTISED_ISS }), deps)

    expect(result.kind).toBe('ok')
    expect(pinnedTransport).toHaveBeenCalledTimes(1)
    const query = deps.db.query as ReturnType<typeof vi.fn>
    expect(query).toHaveBeenCalledTimes(1)
    expect(String(query.mock.calls[0][0])).toContain('INSERT INTO oauth_grants')
  })

  it('skips the check when no issuer was advertised: exchange proceeds', async () => {
    const pinnedTransport = okPinnedTransport()
    // Subject WITHOUT issForCallback (AS did not advertise `iss`) + absent input.iss.
    const deps = buildDeps({
      subject: remoteSubject(),
      pinnedTransport,
    })

    const result = await handleOAuthCallback(input({ iss: undefined }), deps)

    expect(result.kind).toBe('ok')
    expect(pinnedTransport).toHaveBeenCalledTimes(1)
    const query = deps.db.query as ReturnType<typeof vi.fn>
    expect(query).toHaveBeenCalledTimes(1)
    expect(String(query.mock.calls[0][0])).toContain('INSERT INTO oauth_grants')
  })
})
