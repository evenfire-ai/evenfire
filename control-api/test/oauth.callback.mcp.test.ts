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
import type { ContextMembershipDirectory } from '../src/services/access/contextMembership.js'
import {
  type ConsentAdmission,
  admitContexts,
  realConsentAdmission,
} from './fixtures/mcpConsentAdmission.js'
import { MockGateway } from './mockGateway.js'

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
    target: { kind: 'client', id: 'google-drive', redirectUri: REDIRECT_URI },
    code: 'AUTH_CODE',
    state: mcpState(),
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
  const resolved = resolveServerOAuthSubject(rawServer, 'consent')
  if (!resolved) throw new Error('fixture: resolveServerOAuthSubject returned null')
  return { namespace: MCP_NS, ...resolved }
}

interface StubDb {
  query: ReturnType<typeof vi.fn>
}

function buildDeps(opts: {
  subject?: McpServerOAuthSubject | null
  subjectError?: unknown
  /** Contexts whose servers the stand-in admission admits. Default: ctx-A. */
  memberContexts?: string[]
  /** Overrides the stand-in admission (e.g. the real rule over a MockGateway). */
  consentAdmission?: ConsentAdmission
}): { deps: CallbackDeps; db: StubDb; fetchFn: ReturnType<typeof vi.fn> } {
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

  const consentAdmission = opts.consentAdmission ?? admitContexts(opts.memberContexts ?? ['ctx-A'])

  return {
    deps: {
      db: db as unknown as CallbackDeps['db'],
      recipeReader,
      mcpServerReader,
      consentAdmission,
      secretReader: secretReader as unknown as CallbackDeps['secretReader'],
      fetchFn: fetchFn as unknown as typeof fetch,
      stateSecret: STATE_SECRET,
      encryptionKey: ENCRYPTION_KEY,
    },
    db,
    fetchFn,
  }
}

describe('handleOAuthCallback — mcp subject (U5)', () => {
  it('persists a per-user grant keyed by (mcpserver owner, userId) and returns source:mcp', async () => {
    const { deps, db } = buildDeps({
      subject: gdriveSubject({ grantScope: 'user', contextRef: 'ctx-A' }),
    })
    const result = await handleOAuthCallback(buildInput(), deps)

    expect(result).toEqual({
      kind: 'ok',
      provider: 'google',
      userId: USER_ID,
      grantKind: 'user',
      backgroundRequested: false,
      backgroundEnabled: false,
      source: 'mcp',
      mcpServerName: 'gdrive',
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
    // The shared bootstrap INSERT … ON CONFLICT DO UPDATE fenced by cr_uid (R3-H5):
    // same-uid conflict no-ops (first-wins), a different uid / legacy row is replaced.
    expect(sql).toContain('INSERT INTO oauth_grants')
    expect(sql).toContain("'shared'")
    expect(sql).toContain('DO UPDATE SET')
    expect(sql).toContain('oauth_grants.cr_uid IS DISTINCT FROM EXCLUDED.cr_uid')
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

  it.each(['user', 'context'] as const)(
    '%s server: fails closed when no consentAdmission is wired',
    async grantScope => {
      const { deps, db, fetchFn } = buildDeps({
        subject: gdriveSubject({ grantScope, contextRef: 'ctx-A' }),
      })
      const result = await handleOAuthCallback(buildInput(), {
        ...deps,
        consentAdmission: undefined,
      })
      expect(result.kind).toBe('context_membership_denied')
      expect(fetchFn).not.toHaveBeenCalled()
      expect(db.query).not.toHaveBeenCalled()
    }
  )

  it('passes the server name, grant scope and authoritative contextRef to admission', async () => {
    const consentAdmission = admitContexts(['ctx-A'])
    const { deps } = buildDeps({
      subject: gdriveSubject({ grantScope: 'user', contextRef: 'ctx-A' }),
      consentAdmission,
    })
    await handleOAuthCallback(buildInput(), deps)
    expect(consentAdmission).toHaveBeenCalledWith(USER_ID, {
      name: 'gdrive',
      grantScope: 'user',
      contextRef: 'ctx-A',
    })
  })

  // PR #1004: the per-user callback re-checks the mint's admission (agent
  // exposure) BEFORE the token exchange, so a consent minted for a user who
  // has since lost the exposing agent never burns the code or persists a grant.
  describe('per-user admission follows agent exposure (PR #1004)', () => {
    const HOSTS_NS = 'mcp-host'
    const SERVERS_NS = 'mcp-server'

    function world(opts: {
      userAgents?: string[]
      teams?: string[]
      teamAgents?: string[]
      contexts: Record<string, string[]>
      hosts: Record<string, string>
    }) {
      const gateway = new MockGateway()
      for (const [name, contextRef] of Object.entries(opts.hosts)) {
        void gateway.createResource('hosts', { metadata: { name }, spec: { contextRef } }, HOSTS_NS)
      }
      for (const [contextId, mcpServers] of Object.entries(opts.contexts)) {
        void gateway.createResource(
          'contexts',
          { metadata: { name: contextId }, spec: { contextId, mcpServers } },
          SERVERS_NS
        )
      }
      const directory: ContextMembershipDirectory = {
        getUserContexts: vi.fn(async (userId: string) => ({ userId, contextIds: [] })),
        getUserAgents: vi.fn(async (userId: string) => ({
          userId,
          agentNames: opts.userAgents ?? [],
        })),
        listTeams: vi.fn(async (_userId: string, currentTeamId: string) => ({
          currentTeamId,
          items: (opts.teams ?? []).map(id => ({ id, name: id, role: 'member' })),
        })),
        getTeamAgents: vi.fn(async (teamId: string) => ({
          teamId,
          agentNames: opts.teamAgents ?? [],
        })),
      }
      return { gateway, admission: realConsentAdmission(gateway as never, directory) }
    }

    const ownerSubject = () => gdriveSubject({ grantScope: 'user', contextRef: 'ctx-owner' })

    it('admits a user granted only agent B, whose Context lists the server', async () => {
      const { admission } = world({
        userAgents: ['agent-b'],
        hosts: { 'agent-b': 'ctx-b' },
        contexts: { 'ctx-owner': ['gdrive'], 'ctx-b': ['gdrive'] },
      })
      const { deps, db } = buildDeps({ subject: ownerSubject(), consentAdmission: admission })
      const result = await handleOAuthCallback(buildInput(), deps)
      expect(result.kind).toBe('ok')
      expect(String(db.query.mock.calls[0][0])).toContain('INSERT INTO oauth_grants')
    })

    it('admits a user whose active team is granted agent B', async () => {
      const { admission } = world({
        teams: ['team-1'],
        teamAgents: ['agent-b'],
        hosts: { 'agent-b': 'ctx-b' },
        contexts: { 'ctx-b': ['gdrive'] },
      })
      const { deps } = buildDeps({ subject: ownerSubject(), consentAdmission: admission })
      expect((await handleOAuthCallback(buildInput(), deps)).kind).toBe('ok')
    })

    it('denies an outsider WITHOUT exchanging the code or persisting', async () => {
      const { admission } = world({
        userAgents: ['agent-c'],
        hosts: { 'agent-c': 'ctx-c' },
        contexts: { 'ctx-owner': ['gdrive'], 'ctx-c': ['notion'] },
      })
      const { deps, db, fetchFn } = buildDeps({
        subject: ownerSubject(),
        consentAdmission: admission,
      })
      const result = await handleOAuthCallback(buildInput(), deps)
      expect(result.kind).toBe('context_membership_denied')
      expect(fetchFn).not.toHaveBeenCalled()
      expect(db.query).not.toHaveBeenCalled()
    })

    it('denies a private install until agent B is assigned the connector, then admits', async () => {
      const { gateway, admission } = world({
        userAgents: ['agent-b'],
        hosts: { 'agent-b': 'ctx-b' },
        contexts: { 'ctx-owner': ['gdrive'], 'ctx-b': [] },
      })
      const denied = buildDeps({ subject: ownerSubject(), consentAdmission: admission })
      expect((await handleOAuthCallback(buildInput(), denied.deps)).kind).toBe(
        'context_membership_denied'
      )
      expect(denied.db.query).not.toHaveBeenCalled()

      await gateway.mutateResource(
        'contexts',
        'ctx-b',
        current => ({ spec: { ...(current.spec as object), mcpServers: ['gdrive'] } }),
        SERVERS_NS
      )
      const admitted = buildDeps({ subject: ownerSubject(), consentAdmission: admission })
      expect((await handleOAuthCallback(buildInput(), admitted.deps)).kind).toBe('ok')
    })
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
    const result = await handleOAuthCallback(
      buildInput({ target: { kind: 'client', id: 'other', redirectUri: REDIRECT_URI } }),
      deps
    )
    expect(result.kind).toBe('invalid_state')
  })

  it('fails closed when no mcpServerReader is wired', async () => {
    const { deps } = buildDeps({ subject: gdriveSubject() })
    const result = await handleOAuthCallback(buildInput(), { ...deps, mcpServerReader: undefined })
    expect(result.kind).toBe('server_not_found')
  })
})
