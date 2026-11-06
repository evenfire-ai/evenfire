/**
 * The periodic sweep of shared OAuth grants whose Context no longer enables the
 * server, or no longer exists. Its rows are covered against a real Postgres in
 * `oauth.contextGrant.purge.scenarios.realPostgres.integration.test.ts`; this
 * suite covers what does not depend on SQL semantics: when it refuses to
 * delete at all, how a failed statement is contained, overlap, the timer and
 * its configuration.
 *
 * The database is a recorder: the sweep's statements are counted and their
 * parameters read; every statement answers "no row matched". The Context list
 * comes from the MockGateway.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import { MockGateway } from './mockGateway.js'

const log = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}))
vi.mock('../src/observability/logger.js', () => ({
  rootLogger: {
    child: () => log,
    debug: log.debug,
    info: log.info,
    warn: log.warn,
    error: log.error,
  },
}))

const { runSharedGrantSweep, startOauthSharedGrantSweepCron, stopOauthSharedGrantSweepCron } =
  await import('../src/services/oauthSharedGrantSweepCron.js')

const CTX_NS = 'contexts-ns'
const MCP_NS = 'mcp-servers-ns'
const CLOCK = '2026-10-29 06:44:55.668123+00'

type Recorded = { text: string; values: unknown[] }

function recorder(fail?: (stmt: Recorded) => boolean) {
  const statements: Recorded[] = []
  const db: DbClient = {
    query: async (text, values = []) => {
      const stmt = { text, values }
      statements.push(stmt)
      if (fail?.(stmt)) throw new Error('statement failed')
      if (/now\(\)/i.test(text) && !/DELETE/i.test(text)) {
        return { rows: [{ tick_start: CLOCK }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  }
  const deletes = () => statements.filter(s => /DELETE FROM oauth_grants/.test(s.text))
  const perContext = () => deletes().filter(s => /NOT \(recipe_name = ANY/.test(s.text))
  const missing = () => deletes().filter(s => /NOT \(context_id = ANY/.test(s.text))
  return { db, statements, deletes, perContext, missing }
}

async function gatewayWith(contexts: Array<{ name: string; servers: string[] }>) {
  const gateway = new MockGateway(CTX_NS)
  for (const c of contexts) {
    await gateway.createResource(
      'contexts',
      { metadata: { name: c.name }, spec: { contextId: c.name, mcpServers: c.servers } },
      CTX_NS
    )
  }
  return gateway
}

function deps(gateway: unknown, db: DbClient) {
  return {
    gateway: gateway as never,
    db,
    contextsNamespace: CTX_NS,
    mcpServersNamespace: MCP_NS,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  stopOauthSharedGrantSweepCron()
  vi.useRealTimers()
})

describe('runSharedGrantSweep', () => {
  it('lists the Contexts of the contexts namespace and deletes, per live Context, with its allowlist and under the mcp-servers namespace', async () => {
    const gateway = await gatewayWith([
      { name: 'c1', servers: ['drive'] },
      { name: 'c2', servers: [] },
    ])
    const list = vi.spyOn(gateway, 'listResource')
    const rec = recorder()

    await runSharedGrantSweep(deps(gateway, rec.db))

    expect(list).toHaveBeenCalledWith('contexts', CTX_NS)
    expect(rec.perContext().map(s => [s.values[0], s.values[1], s.values[2]])).toEqual([
      [MCP_NS, 'c1', ['drive']],
      [MCP_NS, 'c2', []],
    ])
    expect(rec.missing().map(s => [s.values[0], s.values[1]])).toEqual([[MCP_NS, ['c1', 'c2']]])
    // One clock read, then at most one statement per Context plus one.
    expect(rec.statements).toHaveLength(1 + 2 + 1)
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ contexts: 2, purged: 0, failed: 0 }),
      expect.any(String)
    )
  })

  it('every delete is fenced to rows written before the tick read the database clock', async () => {
    const gateway = await gatewayWith([{ name: 'c1', servers: [] }])
    const rec = recorder()

    await runSharedGrantSweep(deps(gateway, rec.db))

    expect(rec.statements[0].text).toMatch(/SELECT now\(\)/i)
    expect(rec.perContext()[0].values[3]).toBe(CLOCK)
    expect(rec.missing()[0].values[2]).toBe(CLOCK)
  })

  describe('no delete at all when the Context list cannot be trusted', () => {
    it('the list throws: no delete, a warning, and the sweep does not throw', async () => {
      const rec = recorder()
      const gateway = {
        listResource: vi.fn(async () => {
          throw Object.assign(new Error('apiserver unavailable'), { code: 503 })
        }),
      }

      await expect(runSharedGrantSweep(deps(gateway, rec.db))).resolves.toBeDefined()

      expect(rec.deletes()).toHaveLength(0)
      expect(log.warn).toHaveBeenCalled()
    })

    it('the list is empty: no delete and a warning', async () => {
      const rec = recorder()
      const gateway = await gatewayWith([])

      await runSharedGrantSweep(deps(gateway, rec.db))

      expect(rec.deletes()).toHaveLength(0)
      expect(log.warn).toHaveBeenCalled()
    })
  })

  it('a Context being deleted counts as gone: no statement of its own and not among the existing ones', async () => {
    const gateway = await gatewayWith([
      { name: 'c1', servers: ['drive'] },
      { name: 'c2', servers: ['drive'] },
    ])
    gateway.markDeleting('contexts', 'c2', CTX_NS)
    const rec = recorder()

    await runSharedGrantSweep(deps(gateway, rec.db))

    expect(rec.perContext().map(s => s.values[1])).toEqual(['c1'])
    expect(rec.missing().map(s => s.values[1])).toEqual([['c1']])
  })

  it('a failed statement is logged and the tick goes on with the next one', async () => {
    const gateway = await gatewayWith([
      { name: 'c1', servers: [] },
      { name: 'c2', servers: [] },
    ])
    const rec = recorder(s => s.values[1] === 'c1')

    await expect(runSharedGrantSweep(deps(gateway, rec.db))).resolves.toBeDefined()

    expect(rec.perContext().map(s => s.values[1])).toEqual(['c1', 'c2'])
    expect(rec.missing()).toHaveLength(1)
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ contexts: 2, failed: 1 }),
      expect.any(String)
    )
  })

  it('a tick that finds another one in flight is skipped without touching the database', async () => {
    const gateway = await gatewayWith([{ name: 'c1', servers: [] }])
    let releaseList!: () => void
    const parked = new Promise<void>(resolve => (releaseList = resolve))
    const slowGateway = {
      listResource: async (plural: string, ns?: string) => {
        await parked
        return gateway.listResource(plural as never, ns)
      },
    }
    const first = recorder()
    const second = recorder()

    const running = runSharedGrantSweep(deps(slowGateway, first.db))
    await runSharedGrantSweep(deps(gateway, second.db))
    releaseList()
    await running

    expect(second.statements).toHaveLength(0)
    expect(log.debug).toHaveBeenCalled()
    expect(first.perContext()).toHaveLength(1)

    // The flag is released afterwards: the next tick runs.
    const third = recorder()
    await runSharedGrantSweep(deps(gateway, third.db))
    expect(third.perContext()).toHaveLength(1)
  })
})

describe('startOauthSharedGrantSweepCron', () => {
  it('runs on the interval and is idempotent to start', async () => {
    vi.useFakeTimers()
    const gateway = await gatewayWith([{ name: 'c1', servers: [] }])
    const rec = recorder()

    startOauthSharedGrantSweepCron(deps(gateway, rec.db), 1000)
    startOauthSharedGrantSweepCron(deps(gateway, rec.db), 1000)

    await vi.advanceTimersByTimeAsync(3000)
    expect(rec.perContext()).toHaveLength(3)
  })

  it('stops cleanly', async () => {
    vi.useFakeTimers()
    const gateway = await gatewayWith([{ name: 'c1', servers: [] }])
    const rec = recorder()
    startOauthSharedGrantSweepCron(deps(gateway, rec.db), 1000)
    await vi.advanceTimersByTimeAsync(1000)

    stopOauthSharedGrantSweepCron()
    await vi.advanceTimersByTimeAsync(5000)

    expect(rec.perContext()).toHaveLength(1)
  })
})
