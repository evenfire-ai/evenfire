import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import type { K8sGateway } from '../src/k8s.js'

// Grant presence runs through the REAL `oauthGrantExists` (key derivation,
// install-identity fence, SQL). Only the pg boundary is mocked: `db.query`
// hands back a promise the test settles by hand, so the test controls how many
// lookups are in flight and in which order they resolve.
const loggerMock = vi.hoisted(() => {
  const error = vi.fn()
  const noop = vi.fn()
  const child = () => ({ error, info: noop, warn: noop, debug: noop, trace: noop, fatal: noop })
  return { error, rootLogger: { child, error, info: noop, warn: noop, debug: noop } }
})
vi.mock('../src/observability/logger.js', () => ({ rootLogger: loggerMock.rootLogger }))

const { resolveConnectorsForAgents, resolveInvocableMcpServersForContexts } =
  await import('../src/services/access/mcpInvocable.js')

const NS = 'mcp-server'
const HOSTS_NS = 'mcp-host'
const USER = 'user-caller'
const BOUND = 4

type Resource = Record<string, unknown>

interface PendingQuery {
  /** `oauth_grants.recipe_name` — the McpServer name. */
  server: string
  /** `context_id` for a shared lookup, the caller id for a user lookup. */
  coordinate: string
  settle: (granted: boolean) => void
  fail: (err: Error) => void
}

/** A pg client whose every query stays pending until the test settles it. */
function deferredDb() {
  const pending: PendingQuery[] = []
  let inFlight = 0
  let maxInFlight = 0
  const db: DbClient = {
    query: ((_sql: string, params: unknown[]) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise((resolve, reject) => {
        pending.push({
          server: String(params[2]),
          coordinate: String(params[3]),
          settle: granted => {
            inFlight -= 1
            resolve({ rows: granted ? [{ '?column?': 1 }] : [], rowCount: granted ? 1 : 0 })
          },
          fail: err => {
            inFlight -= 1
            reject(err)
          },
        })
      })
    }) as DbClient['query'],
  }
  return {
    db,
    pending,
    get inFlight() {
      return inFlight
    },
    get maxInFlight() {
      return maxInFlight
    },
  }
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/**
 * Settle lookups one at a time, newest first, until `done` resolves; `decide`
 * picks each lookup's outcome. Asserts the in-flight bound after every step.
 */
async function drain<T>(
  harness: ReturnType<typeof deferredDb>,
  done: Promise<T>,
  decide: (q: PendingQuery) => void
): Promise<T> {
  let finished = false
  void done.then(
    () => (finished = true),
    () => (finished = true)
  )
  for (let guard = 0; guard < 1000 && !finished; guard++) {
    await flush()
    expect(harness.inFlight).toBeLessThanOrEqual(BOUND)
    const next = harness.pending.pop()
    if (next) decide(next)
  }
  return done
}

function gateway(resources: {
  contexts?: Resource[]
  mcpservers?: Resource[]
  hosts?: Resource[]
}) {
  return {
    listResource: vi.fn(
      async (plural: string) => resources[plural as keyof typeof resources] ?? []
    ),
    getResource: vi.fn(async (plural: string, name: string) => {
      const found =
        plural === 'hosts'
          ? resources.hosts?.find(r => (r.metadata as { name?: string }).name === name)
          : undefined
      if (!found) throw Object.assign(new Error('not-found'), { statusCode: 404 })
      return found
    }),
    createResource: vi.fn(),
    updateResource: vi.fn(),
    deleteResource: vi.fn(),
  } as unknown as K8sGateway
}

const host = (name: string, contextRef: string) => ({
  metadata: { name, namespace: HOSTS_NS },
  spec: { contextRef },
})

const ctx = (name: string, servers: string[]) => ({
  metadata: { name },
  spec: { contextId: name, mcpServers: servers },
})

const oauthServer = (name: string, grantScope: 'user' | 'context') => ({
  metadata: { name, uid: `uid-${name}` },
  spec: {
    enabled: true,
    auth: { type: 'oauth' },
    transport: { url: `http://${name}.${NS}.svc:3000/mcp` },
    oauth: { id: `${name}-client`, provider: 'google', grantScope },
  },
})

const statusByName = (connectors: Array<{ name: string; status: string }>) =>
  Object.fromEntries(connectors.map(c => [c.name, c.status]))

afterEach(() => {
  loggerMock.error.mockReset()
})

// Three Contexts share four context-scoped servers plus one user-scoped
// server: 3×4 shared lookups + 1 user lookup = 13 distinct grant checks.
const SHARED = ['s-a', 's-b', 's-c', 's-d']
const CONTEXTS = ['ctx-1', 'ctx-2', 'ctx-3']
const fleet = () => ({
  hosts: CONTEXTS.map((c, i) => host(`agent-${i + 1}`, c)),
  contexts: CONTEXTS.map(c => ctx(c, [...SHARED, 'u-mail'])),
  mcpservers: [...SHARED.map(s => oauthServer(s, 'context')), oauthServer('u-mail', 'user')],
})
// Grants exist only for (ctx-1, s-a), (ctx-2, s-b), (ctx-3, *) and the user server.
const granted = (q: PendingQuery) =>
  q.server === 'u-mail' ||
  q.coordinate === 'ctx-3' ||
  (q.coordinate === 'ctx-1' && q.server === 's-a') ||
  (q.coordinate === 'ctx-2' && q.server === 's-b')

describe('computeGrantPresenceByContext — bounded concurrent grant lookups', () => {
  it('connectors rail: issues several lookups at once, never more than the bound, same classification', async () => {
    const h = deferredDb()
    const done = resolveConnectorsForAgents(
      gateway(fleet()),
      {
        mcpServersNamespace: NS,
        contextsNamespace: NS,
        hostsNamespace: HOSTS_NS,
        agentNames: ['agent-1', 'agent-2', 'agent-3'],
        userId: USER,
      },
      h.db
    )

    await flush()
    await flush()
    // Before ANY lookup settles, more than one is already in flight.
    expect(h.pending.length).toBe(BOUND)

    const agents = await drain(h, done, q => q.settle(granted(q)))
    expect(h.maxInFlight).toBe(BOUND)

    expect(agents.map(a => [a.contextRef, statusByName(a.connectors)])).toEqual([
      [
        'ctx-1',
        {
          's-a': 'authorized',
          's-b': 'requires_setup',
          's-c': 'requires_setup',
          's-d': 'requires_setup',
          'u-mail': 'authorized',
        },
      ],
      [
        'ctx-2',
        {
          's-a': 'requires_setup',
          's-b': 'authorized',
          's-c': 'requires_setup',
          's-d': 'requires_setup',
          'u-mail': 'authorized',
        },
      ],
      [
        'ctx-3',
        {
          's-a': 'authorized',
          's-b': 'authorized',
          's-c': 'authorized',
          's-d': 'authorized',
          'u-mail': 'authorized',
        },
      ],
    ])
  })

  it('rpc-proxy rail: issues several lookups at once, never more than the bound, same invocable list', async () => {
    const h = deferredDb()
    const g = gateway(fleet())
    const done = resolveInvocableMcpServersForContexts(g, NS, ['ctx-1', 'ctx-2'], USER, h.db, NS)

    await flush()
    await flush()
    expect(h.pending.length).toBe(BOUND)

    // Only ctx-1/ctx-2 are scoped: s-c and s-d have grants in neither.
    const list = await drain(h, done, q => q.settle(granted(q)))
    expect(h.maxInFlight).toBe(BOUND)
    expect(list.map(s => s.name)).toEqual(['s-a', 's-b', 'u-mail'])
  })

  it('a DB error on one (Context, server) pair excludes only that pair; concurrent siblings still resolve', async () => {
    const h = deferredDb()
    const done = resolveConnectorsForAgents(
      gateway(fleet()),
      {
        mcpServersNamespace: NS,
        contextsNamespace: NS,
        hostsNamespace: HOSTS_NS,
        agentNames: ['agent-1', 'agent-2', 'agent-3'],
        userId: USER,
      },
      h.db
    )

    // Every pair has a grant, but the (ctx-2, s-c) read fails.
    const agents = await drain(h, done, q =>
      q.coordinate === 'ctx-2' && q.server === 's-c'
        ? q.fail(new Error('connection terminated'))
        : q.settle(true)
    )

    const byContext = Object.fromEntries(
      agents.map(a => [a.contextRef, statusByName(a.connectors)])
    )
    expect(byContext['ctx-2']).toEqual({
      's-a': 'authorized',
      's-b': 'authorized',
      's-c': 'requires_setup',
      's-d': 'authorized',
      'u-mail': 'authorized',
    })
    // The same server in other Contexts is unaffected.
    expect(byContext['ctx-1']['s-c']).toBe('authorized')
    expect(byContext['ctx-3']['s-c']).toBe('authorized')

    expect(loggerMock.error).toHaveBeenCalledTimes(1)
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ mcpServerName: 's-c', contextName: 'ctx-2' }),
      'grant-presence check failed; server excluded'
    )
  })

  it('rpc-proxy rail: a failing pair is excluded but another Context still grants the same server', async () => {
    const h = deferredDb()
    const done = resolveInvocableMcpServersForContexts(
      gateway(fleet()),
      NS,
      ['ctx-1', 'ctx-2'],
      USER,
      h.db,
      NS
    )

    // s-c: ctx-1 read fails, ctx-2 has the grant → still invocable via ctx-2.
    // s-d: ctx-1 read fails, ctx-2 has no grant → excluded (fail-closed).
    const list = await drain(h, done, q => {
      if (q.coordinate === 'ctx-1' && (q.server === 's-c' || q.server === 's-d')) {
        q.fail(new Error('statement timeout'))
        return
      }
      q.settle(q.server !== 's-d')
    })

    expect(list.map(s => s.name)).toEqual(['s-a', 's-b', 's-c', 'u-mail'])
    expect(loggerMock.error).toHaveBeenCalledTimes(2)
  })
})
