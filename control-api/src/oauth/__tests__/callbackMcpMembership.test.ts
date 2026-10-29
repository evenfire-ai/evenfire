import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockPoolQuery = vi.fn()
vi.mock('../../db.js', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}))

const { config } = await import('../../config.js')
const { handleOAuthCallback } = await import('../callback.js')
const { signOAuthState } = await import('../state.js')
const { buildOAuthCallbackDeps } = await import('../../routes/external/oauthCallback.js')
const { MockGateway } = await import('../../../test/mockGateway.js')
const { membership, seedAgentHost, seedAllowlistedContext } =
  await import('../../../test/fixtures/contextAllowlist.js')

type CallbackInput = import('../callback.js').CallbackInput

/**
 * Guards-before-exchange ordering for the mcp callback (R3-L1), through the
 * production dependency wiring (`buildOAuthCallbackDeps`): the subject is
 * resolved from the McpServer CR by the real reader, access by the same rules
 * the mint applies, and only the provider fetch is replaced.
 *
 * A user who lost access during the mint→callback window is rejected WITHOUT
 * burning the single-use auth-code (no token exchange, no write). The `context`
 * flavor checks the Context signed into the state (live, allowlisting the
 * server, reached by the user directly or through an assigned agent's Host);
 * the `user` flavor checks that some Context the user reaches still enables
 * the server.
 */

const NS = config.mcpServersNamespace
const OAUTH_CLIENT_ID = 'google-client'
const SERVER = 'gdrive'
const USER_ID = '44444444-4444-4444-8444-444444444444'
const CONTEXT = 'ctx-1'

function okTokenFetch() {
  return vi.fn(async () =>
    Response.json({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      token_type: 'Bearer',
    })
  ) as unknown as typeof fetch
}

async function installServer(
  gateway: InstanceType<typeof MockGateway>,
  grantScope: 'user' | 'context'
): Promise<string> {
  const created = (await gateway.createResource(
    'mcpservers',
    {
      metadata: { name: SERVER },
      spec: {
        transport: { type: 'streamableHttp', url: 'https://gdrive.example.com/mcp' },
        auth: { type: 'oauth' },
        oauth: {
          id: OAUTH_CLIENT_ID,
          provider: 'google',
          clientIdRef: { name: 'oauth-secret', key: 'client_id' },
          clientSecretRef: { name: 'oauth-secret', key: 'client_secret' },
          grantScope,
        },
      },
    },
    NS
  )) as { metadata: { uid: string } }
  gateway.seedSecret('oauth-secret', NS, {
    data: {
      client_id: Buffer.from('cid').toString('base64'),
      client_secret: Buffer.from('csec').toString('base64'),
    },
  })
  return created.metadata.uid
}

function input(contextId?: string): CallbackInput {
  return {
    target: { kind: 'client', id: OAUTH_CLIENT_ID, redirectUri: 'https://example.test/cb' },
    code: 'auth-code-single-use',
    state: signOAuthState(config.oauthStateHmacSecret, {
      subjectKind: 'mcp',
      mcpServerName: SERVER,
      userId: USER_ID,
      oauthClientId: OAUTH_CLIENT_ID,
      grantKind: 'user',
      background: false,
      ...(contextId !== undefined ? { contextId } : {}),
    }),
  }
}

function grantWrites(): Array<[string, unknown[]]> {
  return mockPoolQuery.mock.calls.filter(
    ([sql]) => typeof sql === 'string' && sql.includes('oauth_grants')
  ) as Array<[string, unknown[]]>
}

describe('handleOAuthCallback — mcp access guards before the exchange (R3-L1)', () => {
  let gateway: InstanceType<typeof MockGateway>
  let fetchFn: typeof fetch

  beforeEach(() => {
    gateway = new MockGateway(NS)
    mockPoolQuery.mockReset()
    fetchFn = okTokenFetch()
  })

  function deps() {
    return { ...buildOAuthCallbackDeps(gateway as never), fetchFn }
  }

  describe('context flavor', () => {
    beforeEach(async () => {
      await installServer(gateway, 'context')
      await seedAllowlistedContext(gateway, CONTEXT, [SERVER], config.contextsNamespace)
    })

    it('denies a user who does not reach the signed Context WITHOUT exchanging', async () => {
      membership(mockPoolQuery, { contexts: {} })

      const result = await handleOAuthCallback(input(CONTEXT), deps())

      expect(result.kind).toBe('context_membership_denied')
      expect(fetchFn).not.toHaveBeenCalled()
      expect(grantWrites()).toHaveLength(0)
    })

    it('denies when the signed Context no longer allowlists the server WITHOUT exchanging', async () => {
      membership(mockPoolQuery, { contexts: { [USER_ID]: ['ctx-2'] } })
      await seedAllowlistedContext(gateway, 'ctx-2', [], config.contextsNamespace)

      const result = await handleOAuthCallback(input('ctx-2'), deps())

      expect(result.kind).toBe('context_membership_denied')
      expect(fetchFn).not.toHaveBeenCalled()
      expect(grantWrites()).toHaveLength(0)
    })

    it('refuses a state that names no Context as outdated WITHOUT exchanging or reading', async () => {
      membership(mockPoolQuery, { contexts: { [USER_ID]: [CONTEXT] } })

      const result = await handleOAuthCallback(input(), deps())

      expect(result.kind).toBe('oauth_state_outdated')
      expect(fetchFn).not.toHaveBeenCalled()
      expect(mockPoolQuery).not.toHaveBeenCalled()
    })

    it('bootstraps the shared grant of the signed Context for a direct member', async () => {
      membership(mockPoolQuery, { contexts: { [USER_ID]: [CONTEXT] } }, () =>
        Promise.resolve({ rows: [{ id: 'grant-1' }], rowCount: 1 })
      )

      const result = await handleOAuthCallback(input(CONTEXT), deps())

      expect(result.kind).toBe('ok')
      if (result.kind === 'ok') {
        expect(result.source).toBe('mcp')
        expect(result.mcpServerName).toBe(SERVER)
        expect(result.userId).toBe(USER_ID)
      }
      expect(fetchFn).toHaveBeenCalledTimes(1)
      const writes = grantWrites()
      expect(writes).toHaveLength(1)
      expect(writes[0][0]).toContain('INSERT INTO oauth_grants')
      expect(writes[0][0]).toContain("'shared'")
      // Same-uid conflict no-ops (first consent wins); a different uid is replaced.
      expect(writes[0][0]).toContain('DO UPDATE SET')
      expect(writes[0][0]).toContain('oauth_grants.cr_uid IS DISTINCT FROM EXCLUDED.cr_uid')
      // owner_kind, recipe_namespace, recipe_name, context_id, oauth_client_id, bootstrapper
      expect(writes[0][1].slice(0, 6)).toEqual([
        'mcpserver',
        NS,
        SERVER,
        CONTEXT,
        OAUTH_CLIENT_ID,
        USER_ID,
      ])
    })

    it('bootstraps for a user who reaches the signed Context only through an agent', async () => {
      await seedAgentHost(gateway, 'host-1', CONTEXT)
      membership(mockPoolQuery, { agents: { [USER_ID]: ['host-1'] } }, () =>
        Promise.resolve({ rows: [{ id: 'grant-1' }], rowCount: 1 })
      )

      const result = await handleOAuthCallback(input(CONTEXT), deps())

      expect(result.kind).toBe('ok')
      expect(grantWrites()[0][1][3]).toBe(CONTEXT)
    })

    it('seals the shared grant with the uid of the CR it read', async () => {
      const uid = (
        (await gateway.getResource('mcpservers', SERVER, NS)) as {
          metadata: { uid: string }
        }
      ).metadata.uid
      membership(mockPoolQuery, { contexts: { [USER_ID]: [CONTEXT] } }, () =>
        Promise.resolve({ rows: [{ id: 'grant-1' }], rowCount: 1 })
      )

      const result = await handleOAuthCallback(input(CONTEXT), deps())

      expect(result.kind).toBe('ok')
      // cr_uid is the last positional param of the shared INSERT.
      expect(grantWrites()[0][1].at(-1)).toBe(uid)
    })

    it('fails closed WITHOUT exchanging when no context access reader is wired', async () => {
      membership(mockPoolQuery, { contexts: { [USER_ID]: [CONTEXT] } })
      const { contextAccessReader: _unwired, ...rest } = deps()

      const result = await handleOAuthCallback(input(CONTEXT), rest)

      expect(result.kind).toBe('context_membership_denied')
      expect(fetchFn).not.toHaveBeenCalled()
    })
  })

  describe('user flavor', () => {
    let uid: string
    beforeEach(async () => {
      uid = await installServer(gateway, 'user')
    })

    it('an enabled user exchanges and upserts, sealed with the CR uid', async () => {
      await seedAllowlistedContext(gateway, CONTEXT, [SERVER], config.contextsNamespace)
      membership(mockPoolQuery, { contexts: { [USER_ID]: [CONTEXT] } }, () =>
        Promise.resolve({ rows: [{ id: 'grant-1' }], rowCount: 1 })
      )

      const result = await handleOAuthCallback(input(), deps())

      expect(result.kind).toBe('ok')
      expect(fetchFn).toHaveBeenCalledTimes(1)
      const writes = grantWrites()
      expect(writes).toHaveLength(1)
      expect(writes[0][0]).toContain('INSERT INTO oauth_grants')
      expect(writes[0][0]).toContain("'user'")
      expect(writes[0][1].at(-1)).toBe(uid)
    })

    it('a Context signed into the state plays no part in the per-user flavor', async () => {
      await seedAllowlistedContext(gateway, CONTEXT, [SERVER], config.contextsNamespace)
      membership(mockPoolQuery, { contexts: { [USER_ID]: [CONTEXT] } }, () =>
        Promise.resolve({ rows: [{ id: 'grant-1' }], rowCount: 1 })
      )

      const result = await handleOAuthCallback(input('nowhere'), deps())

      expect(result.kind).toBe('ok')
    })

    it('no Context of the user enables the server → denied WITHOUT exchanging', async () => {
      await seedAllowlistedContext(gateway, CONTEXT, ['another-server'], config.contextsNamespace)
      membership(mockPoolQuery, { contexts: { [USER_ID]: [CONTEXT] } })

      const result = await handleOAuthCallback(input(), deps())

      expect(result.kind).toBe('context_membership_denied')
      expect(fetchFn).not.toHaveBeenCalled()
      expect(grantWrites()).toHaveLength(0)
    })

    it('fails closed WITHOUT exchanging when no access reader is wired', async () => {
      await seedAllowlistedContext(gateway, CONTEXT, [SERVER], config.contextsNamespace)
      membership(mockPoolQuery, { contexts: { [USER_ID]: [CONTEXT] } })
      const { userServerAccessReader: _unwired, ...rest } = deps()

      const result = await handleOAuthCallback(input(), rest)

      expect(result.kind).toBe('context_membership_denied')
      expect(fetchFn).not.toHaveBeenCalled()
    })
  })

  // Pins current behaviour for a subject read from a CR without `metadata.uid`,
  // which a real apiserver never returns: the callback persists cr_uid NULL
  // instead of failing closed. Such a row is still purgeable by any teardown, but
  // the readers only serve it to a baked key of the same provider.
  it('persists cr_uid NULL for a subject read from a CR without a uid (current behaviour)', async () => {
    await installServer(gateway, 'user')
    const cr = (await gateway.getResource('mcpservers', SERVER, NS)) as {
      metadata: Record<string, unknown>
    }
    delete cr.metadata.uid
    await seedAllowlistedContext(gateway, CONTEXT, [SERVER], config.contextsNamespace)
    membership(mockPoolQuery, { contexts: { [USER_ID]: [CONTEXT] } }, () =>
      Promise.resolve({ rows: [{ id: 'grant-1' }], rowCount: 1 })
    )

    const result = await handleOAuthCallback(input(), deps())

    expect(result.kind).toBe('ok')
    expect(grantWrites()[0][1].at(-1)).toBeNull()
  })
})
