import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import type { GetOAuthGrantInput } from '../src/oauth/store.js'
import { MockGateway } from './mockGateway.js'

// The resolver calls the REAL `oauthGrantExists`, whose SQL is covered by the
// store's own suites (incl. the real-Postgres integration test). Here we mock
// ONLY that boolean existence check to drive grant-presence deterministically,
// and assert (1) the resolver queries the RIGHT grant coordinate per flavor and
// (2) the OBSERVABLE resolved list (T4). importActual keeps every other store
// export real so the rest of the import graph is undisturbed.
const grantExists = vi.fn<(db: unknown, input: GetOAuthGrantInput) => Promise<boolean>>()
vi.mock('../src/oauth/store.js', async importActual => {
  const actual = await importActual<typeof import('../src/oauth/store.js')>()
  return {
    ...actual,
    oauthGrantExists: (db: unknown, input: GetOAuthGrantInput) => grantExists(db, input),
  }
})

// The resolver logs the fail-closed exclusion through the pino child logger
// (`rootLogger.child({ module: 'mcpInvocable' })` — see mcpInvocable.ts:41,286),
// not console.*. Capture the child's `.error` so the fail-closed-logging
// assertion is real (the mock's child ignores its bindings, so every module
// child shares this one `error` spy).
const loggerMock = vi.hoisted(() => {
  const error = vi.fn()
  const noop = vi.fn()
  const child = () => ({ error, info: noop, warn: noop, debug: noop, trace: noop, fatal: noop })
  return { error, rootLogger: { child, error, info: noop, warn: noop, debug: noop } }
})
vi.mock('../src/observability/logger.js', () => ({ rootLogger: loggerMock.rootLogger }))

const { resolveInvocableMcpServersForContexts } =
  await import('../src/services/access/mcpInvocable.js')

const NS = 'mcp-server'
const CALLER = 'user-caller'
// A DB error is simulated by the mock rejecting; the wrapper never touches SQL.
const DB: DbClient = { query: async () => ({ rows: [], rowCount: 0 }) }

function seedContext(g: MockGateway, contextId: string, servers: string[]): void {
  void g.createResource(
    'contexts',
    { metadata: { name: contextId }, spec: { contextId, mcpServers: servers } },
    NS
  )
}

function seedOauthServer(
  g: MockGateway,
  opts: {
    name: string
    grantScope?: 'user' | 'context'
    contextRef?: string
    oauthId?: string | undefined
  }
): void {
  void g.createResource(
    'mcpservers',
    {
      metadata: { name: opts.name },
      spec: {
        enabled: true,
        auth: { type: 'oauth' },
        transport: { url: `http://${opts.name}.${NS}.svc:3000/mcp` },
        ...(opts.contextRef !== undefined ? { contextRef: opts.contextRef } : {}),
        oauth: {
          ...(opts.oauthId === undefined ? {} : { id: opts.oauthId }),
          provider: 'google',
          ...(opts.grantScope ? { grantScope: opts.grantScope } : {}),
        },
      },
    },
    NS
  )
}

function seedNoneServer(g: MockGateway, name: string): void {
  void g.createResource(
    'mcpservers',
    {
      metadata: { name },
      spec: {
        enabled: true,
        auth: { type: 'none' },
        transport: { url: `http://${name}.${NS}.svc:3000/mcp` },
      },
    },
    NS
  )
}

const names = (list: Array<{ name: string }>) => list.map(s => s.name)

beforeEach(() => {
  grantExists.mockReset()
})

describe('resolveInvocableMcpServersForContexts — rpc-proxy grant-presence gate (user flavor)', () => {
  it('excludes an OAuth user-server with NO grant, includes it once the grant exists', async () => {
    const g = new MockGateway(NS)
    seedContext(g, 'ctx-1', ['gdrive'])
    seedOauthServer(g, {
      name: 'gdrive',
      grantScope: 'user',
      contextRef: 'ctx-1',
      oauthId: 'google-drive',
    })

    // No grant.
    grantExists.mockResolvedValue(false)
    expect(
      names(await resolveInvocableMcpServersForContexts(g, NS, ['ctx-1'], CALLER, DB))
    ).toEqual([])

    // Grant present.
    grantExists.mockResolvedValue(true)
    expect(
      names(await resolveInvocableMcpServersForContexts(g, NS, ['ctx-1'], CALLER, DB))
    ).toEqual(['gdrive'])
  })

  it('queries the USER grant coordinate keyed by the caller userId + server name', async () => {
    const g = new MockGateway(NS)
    seedContext(g, 'ctx-1', ['gdrive'])
    seedOauthServer(g, {
      name: 'gdrive',
      grantScope: 'user',
      contextRef: 'ctx-1',
      oauthId: 'google-drive',
    })
    grantExists.mockResolvedValue(true)

    await resolveInvocableMcpServersForContexts(g, NS, ['ctx-1'], CALLER, DB)

    expect(grantExists).toHaveBeenCalledTimes(1)
    expect(grantExists.mock.calls[0][1]).toEqual({
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'gdrive',
      userId: CALLER,
      oauthClientId: 'google-drive',
    })
  })

  it('defaults an OAuth server without grantScope to the user flavor', async () => {
    const g = new MockGateway(NS)
    seedContext(g, 'ctx-1', ['gdrive'])
    seedOauthServer(g, { name: 'gdrive', contextRef: 'ctx-1', oauthId: 'google-drive' }) // no grantScope
    grantExists.mockResolvedValue(true)

    await resolveInvocableMcpServersForContexts(g, NS, ['ctx-1'], CALLER, DB)
    expect(grantExists.mock.calls[0][1]).toMatchObject({ grantKind: 'user', userId: CALLER })
  })
})

describe('resolveInvocableMcpServersForContexts — context (shared) flavor', () => {
  it('queries the SHARED coordinate keyed by the server contextRef, DECOUPLED from the caller userId', async () => {
    const g = new MockGateway(NS)
    seedContext(g, 'ctx-team', ['gdrive-shared'])
    seedOauthServer(g, {
      name: 'gdrive-shared',
      grantScope: 'context',
      contextRef: 'ctx-authoritative',
      oauthId: 'google-drive',
    })
    grantExists.mockResolvedValue(true)

    const out = await resolveInvocableMcpServersForContexts(g, NS, ['ctx-team'], CALLER, DB)

    expect(names(out)).toEqual(['gdrive-shared'])
    const key = grantExists.mock.calls[0][1]
    expect(key).toEqual({
      grantKind: 'shared',
      ownerKind: 'mcpserver',
      recipeNamespace: NS,
      recipeName: 'gdrive-shared',
      contextId: 'ctx-authoritative', // server's spec.contextRef, NOT the scoped ctx-team
      oauthClientId: 'google-drive',
    })
    // Shared key must not carry a userId — invocability is team-wide.
    expect(key).not.toHaveProperty('userId')
  })

  it('is invocable for a caller with NO user grant once the shared grant exists', async () => {
    const g = new MockGateway(NS)
    seedContext(g, 'ctx-team', ['gdrive-shared'])
    seedOauthServer(g, {
      name: 'gdrive-shared',
      grantScope: 'context',
      contextRef: 'ctx-team',
      oauthId: 'google-drive',
    })
    // The mock only answers 'shared' queries true; a 'user' query would be false.
    grantExists.mockImplementation(async (_db, input) => input.grantKind === 'shared')

    expect(
      names(await resolveInvocableMcpServersForContexts(g, NS, ['ctx-team'], CALLER, DB))
    ).toEqual(['gdrive-shared'])
  })
})

describe('resolveInvocableMcpServersForContexts — fail-closed + non-oauth', () => {
  it('never grant-gates a `none` server (always invocable, no oauthGrantExists call)', async () => {
    const g = new MockGateway(NS)
    seedContext(g, 'ctx-1', ['plain'])
    seedNoneServer(g, 'plain')

    const out = await resolveInvocableMcpServersForContexts(g, NS, ['ctx-1'], CALLER, DB)
    expect(names(out)).toEqual(['plain'])
    expect(grantExists).not.toHaveBeenCalled()
  })

  it('excludes a context-flavor server missing contextRef (fail-closed, no query issued)', async () => {
    const g = new MockGateway(NS)
    seedContext(g, 'ctx-1', ['ctx-server'])
    seedOauthServer(g, { name: 'ctx-server', grantScope: 'context', oauthId: 'google-drive' }) // no contextRef
    grantExists.mockResolvedValue(true)

    const out = await resolveInvocableMcpServersForContexts(g, NS, ['ctx-1'], CALLER, DB)
    expect(names(out)).toEqual([])
    expect(grantExists).not.toHaveBeenCalled()
  })

  it('excludes an OAuth server with no usable oauth.id (fail-closed, no query issued)', async () => {
    const g = new MockGateway(NS)
    seedContext(g, 'ctx-1', ['no-id'])
    seedOauthServer(g, {
      name: 'no-id',
      grantScope: 'user',
      contextRef: 'ctx-1',
      oauthId: undefined,
    })
    grantExists.mockResolvedValue(true)

    const out = await resolveInvocableMcpServersForContexts(g, NS, ['ctx-1'], CALLER, DB)
    expect(names(out)).toEqual([])
    expect(grantExists).not.toHaveBeenCalled()
  })

  it('a DB error on one server excludes ONLY that server; the request still resolves the rest', async () => {
    const g = new MockGateway(NS)
    seedContext(g, 'ctx-1', ['broken', 'plain', 'good'])
    seedOauthServer(g, {
      name: 'broken',
      grantScope: 'user',
      contextRef: 'ctx-1',
      oauthId: 'google-drive',
    })
    seedNoneServer(g, 'plain')
    seedOauthServer(g, {
      name: 'good',
      grantScope: 'user',
      contextRef: 'ctx-1',
      oauthId: 'google-drive',
    })

    grantExists.mockImplementation(async (_db, input) => {
      if (input.recipeName === 'broken') throw new Error('db down')
      return true // 'good'
    })

    const out = await resolveInvocableMcpServersForContexts(g, NS, ['ctx-1'], CALLER, DB)
    // Observable outcome (T4): 'broken' excluded (fail-closed on its DB error),
    // 'plain' (none) + 'good' survive. Sorted.
    expect(names(out)).toEqual(['good', 'plain'])
    // Fail-closed exclusions must be LOUD: the DB error on 'broken' is logged
    // via the module's pino child `log.error` (mcpInvocable.ts:286). Assert it
    // fires with the offending server + err, so a silent-swallow regression
    // (dropping the log.error) turns this test red.
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ mcpServerName: 'broken', err: expect.any(Error) }),
      expect.stringContaining('grant-presence check failed')
    )
  })
})
