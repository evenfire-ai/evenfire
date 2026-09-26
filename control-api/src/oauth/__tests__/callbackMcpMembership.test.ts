import { describe, expect, it, vi } from 'vitest'
import {
  type CallbackDeps,
  type CallbackInput,
  type McpServerOAuthSubject,
  handleOAuthCallback,
} from '../callback.js'
// State is derived from the REAL producer (T1): never hand-write the signed
// wire format. `signOAuthState` is the same signer the authorize-URL path uses.
import { signOAuthState } from '../state.js'

/**
 * Guards-before-exchange ordering for the mcp context-scoped callback (R3-L1).
 *
 * The fix moves the `server_missing_context` + `context_membership_denied`
 * guards ahead of `exchangeAuthCode`, so a user removed from the Context during
 * the mint→callback window is rejected WITHOUT burning the single-use auth-code
 * (no token exchange, no secret read). These tests pin that: the `fetchFn` /
 * `secretReader` spies must stay untouched on the denied path, while the
 * happy paths (context member + per-user) still exchange and persist.
 */

const STATE_SECRET = 'test-state-secret-0123456789abcdef' // ≥ 32 chars
const ENCRYPTION_KEY = Buffer.alloc(32, 7) // AES-256-GCM key

const OAUTH_CLIENT_ID = 'google-client'
const MCP_SERVER_NAME = 'gdrive'
const USER_ID = 'user-42'
const CONTEXT_REF = 'ctx-1'

function mcpSubject(overrides: Partial<McpServerOAuthSubject> = {}): McpServerOAuthSubject {
  return {
    namespace: 'mcp-servers',
    grantScope: 'context',
    contextRef: CONTEXT_REF,
    decl: {
      id: OAUTH_CLIENT_ID,
      provider: 'google',
      clientIdRef: { name: 'oauth-secret', key: 'client_id' },
      clientSecretRef: { name: 'oauth-secret', key: 'client_secret' },
    },
    ...overrides,
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

function input(): CallbackInput {
  return {
    oauthClientId: OAUTH_CLIENT_ID,
    code: 'auth-code-single-use',
    state: signedMcpState(),
    redirectUri: 'https://example.test/oauth/callback',
  }
}

/** A provider token-exchange response that would succeed if reached. */
function okTokenFetch() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      token_type: 'Bearer',
    }),
  })) as unknown as typeof fetch
}

function buildDeps(
  opts: {
    subject?: McpServerOAuthSubject
    contextIds?: string[]
    fetchFn?: typeof fetch
    secretReader?: CallbackDeps['secretReader']
    db?: CallbackDeps['db']
    userContextsReader?: CallbackDeps['userContextsReader']
  } = {}
): CallbackDeps {
  const secretReader =
    opts.secretReader ??
    ({
      read: vi.fn(async () => ({ client_id: 'cid', client_secret: 'csec' })),
    } as unknown as CallbackDeps['secretReader'])
  const db =
    opts.db ??
    ({
      query: vi.fn(async () => ({ rowCount: 1, rows: [{ id: 'grant-1' }] })),
    } as unknown as CallbackDeps['db'])
  const userContextsReader =
    opts.userContextsReader ?? vi.fn(async () => ({ contextIds: opts.contextIds ?? [] }))
  return {
    db,
    recipeReader: { read: vi.fn(async () => null) },
    secretReader,
    mcpServerReader: { read: vi.fn(async () => opts.subject ?? mcpSubject()) },
    userContextsReader,
    fetchFn: opts.fetchFn ?? okTokenFetch(),
    stateSecret: STATE_SECRET,
    encryptionKey: ENCRYPTION_KEY,
  }
}

describe('handleOAuthCallback — mcp context membership guard (R3-L1)', () => {
  it('denies a non-member WITHOUT exchanging the auth-code or reading secrets', async () => {
    const fetchFn = okTokenFetch()
    const secretReader = {
      read: vi.fn(async () => ({ client_id: 'cid', client_secret: 'csec' })),
    } as unknown as CallbackDeps['secretReader']
    const deps = buildDeps({
      subject: mcpSubject({ grantScope: 'context', contextRef: CONTEXT_REF }),
      contextIds: [], // user is NOT a member of ctx-1
      fetchFn,
      secretReader,
    })

    const result = await handleOAuthCallback(input(), deps)

    // Observable outcome (T4).
    expect(result.kind).toBe('context_membership_denied')
    // The heart of the fix (R3-L1): the single-use auth-code is NOT burned.
    expect(fetchFn).not.toHaveBeenCalled()
    expect(secretReader.read).not.toHaveBeenCalled()
    // And nothing was persisted.
    expect(deps.db.query as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('rejects a context grant with no contextRef WITHOUT exchanging the auth-code', async () => {
    // The sibling guard the same reorder moved ahead of the exchange (F2): a
    // context-scoped server with no authoritative contextRef must also short
    // out before `exchangeAuthCode`, never burning the single-use code.
    const fetchFn = okTokenFetch()
    const secretReader = {
      read: vi.fn(async () => ({ client_id: 'cid', client_secret: 'csec' })),
    } as unknown as CallbackDeps['secretReader']
    const deps = buildDeps({
      subject: mcpSubject({ grantScope: 'context', contextRef: undefined }),
      fetchFn,
      secretReader,
    })

    const result = await handleOAuthCallback(input(), deps)

    expect(result.kind).toBe('server_missing_context')
    expect(fetchFn).not.toHaveBeenCalled()
    expect(secretReader.read).not.toHaveBeenCalled()
    expect(deps.db.query as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('bootstraps a shared grant for a Context member (happy path, no regression)', async () => {
    const fetchFn = okTokenFetch()
    const deps = buildDeps({
      subject: mcpSubject({ grantScope: 'context', contextRef: CONTEXT_REF }),
      contextIds: [CONTEXT_REF], // member
      fetchFn,
    })

    const result = await handleOAuthCallback(input(), deps)

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.source).toBe('mcp')
      expect(result.mcpServerName).toBe(MCP_SERVER_NAME)
      expect(result.userId).toBe(USER_ID)
    }
    // Exchange ran and the shared grant was persisted (bootstrap INSERT).
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const query = deps.db.query as ReturnType<typeof vi.fn>
    expect(query).toHaveBeenCalledTimes(1)
    expect(String(query.mock.calls[0][0])).toContain('INSERT INTO oauth_grants')
    expect(String(query.mock.calls[0][0])).toContain("'shared'")
  })

  it('per-user grant path is intact: exchange runs and upsert persists', async () => {
    const fetchFn = okTokenFetch()
    const userContextsReader = vi.fn(async () => ({ contextIds: [] }))
    const deps = buildDeps({
      subject: mcpSubject({ grantScope: 'user', contextRef: undefined }),
      fetchFn,
      userContextsReader,
    })

    const result = await handleOAuthCallback(input(), deps)

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.source).toBe('mcp')
    }
    expect(fetchFn).toHaveBeenCalledTimes(1)
    // The per-user path never consults the membership reader (its key IS the user).
    expect(userContextsReader).not.toHaveBeenCalled()
    const query = deps.db.query as ReturnType<typeof vi.fn>
    expect(query).toHaveBeenCalledTimes(1)
    expect(String(query.mock.calls[0][0])).toContain('INSERT INTO oauth_grants')
    expect(String(query.mock.calls[0][0])).toContain("'user'")
  })

  // R3-H5 (D-T3): the subject's CR uid seals the grant so a same-name reinstall's
  // teardown never purges this installation's consent.
  it('seals a shared bootstrap grant with the subject cr_uid', async () => {
    const deps = buildDeps({
      subject: mcpSubject({ grantScope: 'context', contextRef: CONTEXT_REF, crUid: 'uid-live-cr' }),
      contextIds: [CONTEXT_REF],
    })

    const result = await handleOAuthCallback(input(), deps)
    expect(result.kind).toBe('ok')

    const query = deps.db.query as ReturnType<typeof vi.fn>
    const [sql, values] = query.mock.calls[0]
    expect(String(sql)).toContain('INSERT INTO oauth_grants')
    expect(String(sql)).toContain("'shared'")
    // cr_uid is the last positional param of the shared INSERT.
    expect((values as unknown[]).at(-1)).toBe('uid-live-cr')
  })

  it('seals a per-user grant with the subject cr_uid', async () => {
    const deps = buildDeps({
      subject: mcpSubject({ grantScope: 'user', contextRef: undefined, crUid: 'uid-live-cr' }),
      userContextsReader: vi.fn(async () => ({ contextIds: [] })),
    })

    const result = await handleOAuthCallback(input(), deps)
    expect(result.kind).toBe('ok')

    const query = deps.db.query as ReturnType<typeof vi.fn>
    const [sql, values] = query.mock.calls[0]
    expect(String(sql)).toContain('INSERT INTO oauth_grants')
    expect(String(sql)).toContain("'user'")
    // cr_uid is the last positional param of the user INSERT.
    expect((values as unknown[]).at(-1)).toBe('uid-live-cr')
  })

  // A grant with NO subject cr_uid (a legacy/authorize-url path that never read a
  // live CR) persists cr_uid NULL — never crashes, and stays purgeable by any teardown.
  it('persists cr_uid NULL when the subject carries no uid', async () => {
    const deps = buildDeps({
      subject: mcpSubject({ grantScope: 'user', contextRef: undefined, crUid: undefined }),
      userContextsReader: vi.fn(async () => ({ contextIds: [] })),
    })

    const result = await handleOAuthCallback(input(), deps)
    expect(result.kind).toBe('ok')

    const query = deps.db.query as ReturnType<typeof vi.fn>
    const [, values] = query.mock.calls[0]
    expect((values as unknown[]).at(-1)).toBeNull()
  })
})
