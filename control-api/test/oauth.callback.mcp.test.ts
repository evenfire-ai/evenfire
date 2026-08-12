import { describe, expect, it, vi } from 'vitest'
import {
  type CallbackDeps,
  type CallbackInput,
  type McpServerOAuthReader,
  type McpServerOAuthSubject,
  RecipeNotFoundError,
  type RecipeReader,
  handleOAuthCallback,
} from '../src/oauth/callback.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { resolveServerOAuthSubject } from '../src/oauth/mcpServerOAuthSpec.js'
import { signOAuthState } from '../src/oauth/state.js'

/**
 * U5 — the mcp-subject OAuth callback. Fixtures are derived from the REAL
 * `signOAuthState` (T1: no hand-forged state) and the observable outcome asserted
 * is the persisted grant + the `source:'mcp'` return (T4), not intermediate calls.
 */

const STATE_SECRET = 'test-state-hmac-secret-32-bytes-padding'
const ENCRYPTION_KEY = deriveOAuthEncryptionKey(
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
)
const MCP_NS = 'mcp-server'
const REDIRECT_URI = 'https://control.example.com/api/v1/oauth-callback/google-drive'
const USER_ID = 'user-uuid-9'

function mcpState(overrides: Partial<Parameters<typeof signOAuthState>[1]> = {}): string {
  return signOAuthState(STATE_SECRET, {
    subjectKind: 'mcp',
    mcpServerName: 'gdrive',
    userId: USER_ID,
    oauthClientId: 'google-drive',
    grantKind: 'user',
    background: false,
    ...overrides,
  } as Parameters<typeof signOAuthState>[1])
}

function buildInput(overrides: Partial<CallbackInput> = {}): CallbackInput {
  return {
    oauthClientId: 'google-drive',
    code: 'AUTH_CODE',
    state: mcpState(),
    redirectUri: REDIRECT_URI,
    ...overrides,
  }
}

// The subject `decl` is derived from the REAL producer (`resolveServerOAuthSubject`)
// out of a raw McpServer fixture (T1) — not hand-built — so the callback is fed
// exactly the shape production wiring emits.
function gdriveSubject(
  opts: { grantScope?: 'user' | 'context'; contextRef?: string } = {}
): McpServerOAuthSubject {
  const rawServer = {
    metadata: { name: 'gdrive', namespace: MCP_NS },
    spec: {
      ...(opts.contextRef !== undefined ? { contextRef: opts.contextRef } : {}),
      auth: { type: 'oauth' },
      oauth: {
        id: 'google-drive',
        provider: 'google',
        clientIdRef: { name: 'google-creds', key: 'client-id' },
        clientSecretRef: { name: 'google-creds', key: 'client-secret' },
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        backgroundAccess: false,
        ...(opts.grantScope ? { grantScope: opts.grantScope } : {}),
      },
    },
  }
  const resolved = resolveServerOAuthSubject(rawServer)
  if (!resolved) throw new Error('fixture: resolveServerOAuthSubject returned null')
  return { namespace: MCP_NS, ...resolved }
}

interface StubDb {
  query: ReturnType<typeof vi.fn>
}

function buildDeps(opts: {
  subject?: McpServerOAuthSubject | null
  subjectError?: unknown
  /** Contexts the signed user belongs to (shared-bootstrap membership gate). Default: member of ctx-A. */
  memberContexts?: string[]
}): { deps: CallbackDeps; db: StubDb } {
  const db: StubDb = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }

  // A recipeReader that would explode if the mcp path ever hit it — proves the
  // dispatch never falls through to the recipe branch.
  const recipeReader: RecipeReader = {
    read: vi.fn(async () => {
      throw new Error('recipeReader must not be used for an mcp subject')
    }),
  }

  const mcpServerReader: McpServerOAuthReader = {
    read: vi.fn(async () => {
      if (opts.subjectError) throw opts.subjectError
      return opts.subject ?? null
    }),
  }

  const secretReader = {
    read: vi.fn(async () => ({ 'client-id': 'CID', 'client-secret': 'CSEC' })),
  }

  const fetchFn = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: 'GDRIVE-ACCESS',
      refresh_token: 'GDRIVE-REFRESH',
      expires_in: 3600,
      token_type: 'Bearer',
    }),
    text: async () => '',
  }))

  const memberContexts = opts.memberContexts ?? ['ctx-A']
  const userContextsReader = vi.fn(async () => ({ contextIds: memberContexts }))

  return {
    deps: {
      db: db as unknown as CallbackDeps['db'],
      recipeReader,
      mcpServerReader,
      userContextsReader,
      secretReader: secretReader as unknown as CallbackDeps['secretReader'],
      fetchFn: fetchFn as unknown as typeof fetch,
      stateSecret: STATE_SECRET,
      encryptionKey: ENCRYPTION_KEY,
    },
    db,
  }
}

describe('handleOAuthCallback — mcp subject (U5)', () => {
  it('persists a per-user grant keyed by (mcpserver owner, userId) and returns source:mcp', async () => {
    const { deps, db } = buildDeps({ subject: gdriveSubject({ grantScope: 'user' }) })
    const result = await handleOAuthCallback(buildInput(), deps)

    expect(result).toEqual({
      kind: 'ok',
      provider: 'google',
      userId: USER_ID,
      grantKind: 'user',
      backgroundRequested: false,
      backgroundEnabled: false,
      source: 'mcp',
    })

    expect(db.query).toHaveBeenCalledTimes(1)
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO oauth_grants')
    expect(sql).toContain(
      'ON CONFLICT (owner_kind, recipe_namespace, recipe_name, user_id, oauth_client_id)'
    )
    // owner_kind, ns, name, userId, oauthClientId — the mcp-server owner coords.
    expect(params[0]).toBe('mcpserver')
    expect(params[1]).toBe(MCP_NS)
    expect(params[2]).toBe('gdrive')
    expect(params[3]).toBe(USER_ID)
    expect(params[4]).toBe('google-drive')
    expect(params[5]).toBe('google') // provider
    expect(typeof params[6]).toBe('string')
    expect((params[6] as string).startsWith('v1.')).toBe(true) // encrypted access token
  })

  it('context server: bootstraps a SHARED grant keyed by the authoritative contextRef, user_id NULL', async () => {
    const { deps, db } = buildDeps({
      subject: gdriveSubject({ grantScope: 'context', contextRef: 'ctx-A' }),
    })
    const result = await handleOAuthCallback(buildInput(), deps)
    expect(result.kind).toBe('ok')

    expect(db.query).toHaveBeenCalledTimes(1)
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]]
    // The shared bootstrap INSERT … ON CONFLICT DO NOTHING (first-wins).
    expect(sql).toContain('INSERT INTO oauth_grants')
    expect(sql).toContain("'shared'")
    expect(sql).toContain('DO NOTHING')
    // owner_kind, ns, name, context_id(=contextRef), oauthClientId, bootstrappedBy
    expect(params[0]).toBe('mcpserver')
    expect(params[1]).toBe(MCP_NS)
    expect(params[2]).toBe('gdrive')
    expect(params[3]).toBe('ctx-A') // authoritative context, from the subject not the state
    expect(params[4]).toBe('google-drive')
    expect(params[5]).toBe(USER_ID) // bootstrapped_by = the signed initiator
  })

  it('context server: a NON-member of the Context is denied (403) and NO shared grant is written', async () => {
    // Signed user consents, but is not a member of the server's contextRef.
    const { deps, db } = buildDeps({
      subject: gdriveSubject({ grantScope: 'context', contextRef: 'ctx-A' }),
      memberContexts: ['ctx-other', 'ctx-else'], // NOT ctx-A
    })
    const result = await handleOAuthCallback(buildInput(), deps)
    expect(result.kind).toBe('context_membership_denied')
    // Observable outcome (T4): the shared row was never inserted.
    expect(db.query).not.toHaveBeenCalled()
  })

  it('context server: fails closed when no userContextsReader is wired', async () => {
    const { deps, db } = buildDeps({
      subject: gdriveSubject({ grantScope: 'context', contextRef: 'ctx-A' }),
    })
    const result = await handleOAuthCallback(buildInput(), {
      ...deps,
      userContextsReader: undefined,
    })
    expect(result.kind).toBe('context_membership_denied')
    expect(db.query).not.toHaveBeenCalled()
  })

  it('context server WITHOUT contextRef fails closed (server_missing_context), no persist', async () => {
    const { deps, db } = buildDeps({
      subject: gdriveSubject({ grantScope: 'context', contextRef: undefined }),
    })
    const result = await handleOAuthCallback(buildInput(), deps)
    expect(result.kind).toBe('server_missing_context')
    expect(db.query).not.toHaveBeenCalled()
  })

  it('unknown server → server_not_found (reader returns null)', async () => {
    const { deps, db } = buildDeps({ subject: null })
    const result = await handleOAuthCallback(buildInput(), deps)
    expect(result.kind).toBe('server_not_found')
    expect(db.query).not.toHaveBeenCalled()
  })

  it('reader throwing RecipeNotFoundError → server_not_found', async () => {
    const { deps } = buildDeps({ subjectError: new RecipeNotFoundError('gone') })
    const result = await handleOAuthCallback(buildInput(), deps)
    expect(result.kind).toBe('server_not_found')
  })

  it('rejects when the callback-path oauthClientId disagrees with the signed state', async () => {
    const { deps } = buildDeps({ subject: gdriveSubject() })
    const result = await handleOAuthCallback(buildInput({ oauthClientId: 'other' }), deps)
    expect(result.kind).toBe('invalid_state')
  })

  it('fails closed when no mcpServerReader is wired', async () => {
    const { deps } = buildDeps({ subject: gdriveSubject() })
    const result = await handleOAuthCallback(buildInput(), { ...deps, mcpServerReader: undefined })
    expect(result.kind).toBe('server_not_found')
  })
})
