import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeClient = {
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
}

const fakePools = vi.hoisted(
  (): Array<{
    config: Record<string, unknown>
    connect: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
    totalCount: number
    idleCount: number
    waitingCount: number
  }> => []
)
const metricSpies = vi.hoisted(() => ({
  acquisitionObserve: vi.fn(),
  connectionsSet: vi.fn(),
  rejectionsInc: vi.fn(),
  statementTimeoutsInc: vi.fn(),
  recordOperationalError: vi.fn(),
}))

vi.mock('pg', () => ({
  Pool: class FakePool {
    config: Record<string, unknown>
    connect = vi.fn()
    end = vi.fn().mockResolvedValue(undefined)
    totalCount = 0
    idleCount = 0
    waitingCount = 0

    constructor(config: Record<string, unknown>) {
      this.config = config
      fakePools.push(this)
    }
  },
}))

vi.mock('../src/observability/metrics.js', () => ({
  governedTracePoolAcquisitionDurationSeconds: { observe: metricSpies.acquisitionObserve },
  governedTracePoolConnections: { set: metricSpies.connectionsSet },
  governedTracePoolRejectionsTotal: { inc: metricSpies.rejectionsInc },
  governedTracePoolStatementTimeoutsTotal: { inc: metricSpies.statementTimeoutsInc },
  recordGovernedTraceOperationalError: metricSpies.recordOperationalError,
}))

describe('tracing pool isolation', () => {
  beforeEach(() => {
    vi.resetModules()
    fakePools.length = 0
    delete process.env.TRACING_INGEST_POOL_MAX
    delete process.env.TRACING_READ_POOL_MAX
    delete process.env.TRACING_MAINTENANCE_POOL_MAX
    delete process.env.TRACING_INGEST_PG_CONNECTION_STRING
    delete process.env.TRACING_READ_PG_CONNECTION_STRING
    delete process.env.TRACING_MAINTENANCE_PG_CONNECTION_STRING
    process.env.CONTROL_API_PG_CONNECTION_STRING = 'postgresql://localhost/tracing_test'
    metricSpies.acquisitionObserve.mockReset()
    metricSpies.connectionsSet.mockReset()
    metricSpies.rejectionsInc.mockReset()
    metricSpies.statementTimeoutsInc.mockReset()
    metricSpies.recordOperationalError.mockReset()
  })

  it('creates independent bounded ingest and read request pools without maintenance', async () => {
    process.env.TRACING_INGEST_POOL_MAX = '5'
    process.env.TRACING_READ_POOL_MAX = '4'
    const { createTracingPools } = await import('../src/services/tracing/pools.js')
    const PoolClass = (await import('pg')).Pool
    const pools = createTracingPools(PoolClass)

    expect(pools.traceIngestPool).not.toBe(pools.traceReadPool)
    expect(fakePools).toHaveLength(2)
    expect(fakePools.at(-2)?.config.max).toBe(5)
    expect(fakePools.at(-1)?.config.max).toBe(4)
    expect(fakePools.at(-2)?.config.statement_timeout).toBe(5_000)
    expect(fakePools.at(-1)?.config.statement_timeout).toBe(2_000)
    expect(fakePools.at(-2)?.config.connectionString).toBe('postgresql://localhost/tracing_test')
    expect(fakePools.at(-1)?.config.connectionString).toBe('postgresql://localhost/tracing_test')
  })

  it('uses role-specific tracing connection strings when provided', async () => {
    process.env.TRACING_INGEST_PG_CONNECTION_STRING = 'postgresql://runtime/ingest'
    process.env.TRACING_READ_PG_CONNECTION_STRING = 'postgresql://runtime/read'
    const { createTracingPools } = await import('../src/services/tracing/pools.js')
    const PoolClass = (await import('pg')).Pool

    createTracingPools(PoolClass)

    expect(fakePools).toHaveLength(2)
    expect(fakePools.at(-2)?.config.connectionString).toBe('postgresql://runtime/ingest')
    expect(fakePools.at(-1)?.config.connectionString).toBe('postgresql://runtime/read')
  })

  it('can create only the maintenance pool for the trace maintenance worker', async () => {
    process.env.TRACING_MAINTENANCE_PG_CONNECTION_STRING = 'postgresql://runtime/maintenance'
    const { getTraceMaintenancePool } = await import('../src/services/tracing/pools.js')

    const pool = getTraceMaintenancePool()

    expect(fakePools).toHaveLength(1)
    expect(pool).toBe(fakePools[0])
    expect(fakePools[0]?.config.connectionString).toBe('postgresql://runtime/maintenance')
    expect(fakePools[0]?.config.max).toBe(1)
  })

  it('closes and resets the maintenance pool during worker shutdown', async () => {
    process.env.TRACING_MAINTENANCE_PG_CONNECTION_STRING = 'postgresql://runtime/maintenance'
    const { closeTraceMaintenancePool, getTraceMaintenancePool } =
      await import('../src/services/tracing/pools.js')

    const firstPool = getTraceMaintenancePool()
    await closeTraceMaintenancePool()

    expect(firstPool.end).toHaveBeenCalledOnce()
    expect(getTraceMaintenancePool()).not.toBe(firstPool)
    expect(fakePools).toHaveLength(2)
  })

  it('requires an explicit maintenance connection string', async () => {
    const { createTraceMaintenancePool, getTraceMaintenancePool } =
      await import('../src/services/tracing/pools.js')
    const PoolClass = (await import('pg')).Pool

    expect(() => createTraceMaintenancePool(PoolClass)).toThrow(
      'TRACING_MAINTENANCE_PG_CONNECTION_STRING is required'
    )
    expect(() => getTraceMaintenancePool()).toThrow(
      'TRACING_MAINTENANCE_PG_CONNECTION_STRING is required'
    )
    expect(fakePools).toHaveLength(0)
  })

  it('commits and releases an ingest connection on success', async () => {
    const { getTracingPools, withTraceIngestTransaction } =
      await import('../src/services/tracing/pools.js')
    const { traceIngestPool } = getTracingPools()
    const client: FakeClient = { query: vi.fn().mockResolvedValue({}), release: vi.fn() }
    vi.mocked(traceIngestPool.connect).mockResolvedValue(client as never)

    await expect(withTraceIngestTransaction(async () => 'done')).resolves.toBe('done')
    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN')
    expect(client.query).toHaveBeenNthCalledWith(2, 'COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
    expect(metricSpies.acquisitionObserve).toHaveBeenCalledWith(
      { pool: 'ingest' },
      expect.any(Number)
    )
    expect(metricSpies.rejectionsInc).not.toHaveBeenCalled()
    expect(metricSpies.connectionsSet).toHaveBeenCalledWith({ pool: 'ingest', state: 'waiting' }, 0)
  })

  it('rolls back and releases an ingest connection on failure', async () => {
    const { getTracingPools, withTraceIngestTransaction } =
      await import('../src/services/tracing/pools.js')
    const { traceIngestPool } = getTracingPools()
    const client: FakeClient = { query: vi.fn().mockResolvedValue({}), release: vi.fn() }
    vi.mocked(traceIngestPool.connect).mockResolvedValue(client as never)

    await expect(
      withTraceIngestTransaction(async () => {
        throw new Error('append failed')
      })
    ).rejects.toThrow('append failed')
    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN')
    expect(client.query).toHaveBeenNthCalledWith(2, 'ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('records a read-pool rejection when acquisition fails', async () => {
    const { getTracingPools, withTraceReadTransaction } =
      await import('../src/services/tracing/pools.js')
    const { traceReadPool } = getTracingPools()
    vi.mocked(traceReadPool.connect).mockRejectedValue(new Error('pool exhausted'))

    await expect(withTraceReadTransaction(async () => 'unreachable')).rejects.toThrow(
      'pool exhausted'
    )
    expect(metricSpies.acquisitionObserve).toHaveBeenCalledWith(
      { pool: 'read' },
      expect.any(Number)
    )
    expect(metricSpies.rejectionsInc).toHaveBeenCalledWith({ pool: 'read' })
    expect(metricSpies.recordOperationalError).toHaveBeenCalledWith('pool', 'pool_rejected')
  })

  it('publishes a live waiter while a read-pool acquisition is pending', async () => {
    const { getTracingPools, withTraceReadTransaction } =
      await import('../src/services/tracing/pools.js')
    const { traceReadPool } = getTracingPools()
    const client: FakeClient = { query: vi.fn().mockResolvedValue({}), release: vi.fn() }
    let resolveConnection!: (client: FakeClient) => void
    const pendingConnection = new Promise<FakeClient>(resolve => {
      resolveConnection = resolve
    })
    const livePool = traceReadPool as unknown as {
      waitingCount: number
      connect: ReturnType<typeof vi.fn>
    }
    livePool.waitingCount = 1
    livePool.connect.mockReturnValue(pendingConnection)

    const transaction = withTraceReadTransaction(async () => 'done')

    expect(metricSpies.connectionsSet).toHaveBeenCalledWith({ pool: 'read', state: 'waiting' }, 1)
    livePool.waitingCount = 0
    resolveConnection(client)
    await expect(transaction).resolves.toBe('done')
    expect(metricSpies.connectionsSet).toHaveBeenLastCalledWith(
      { pool: 'read', state: 'waiting' },
      0
    )
  })

  it('records statement timeout cancellation separately from pool acquisition rejection', async () => {
    const { getTracingPools, withTraceReadTransaction } =
      await import('../src/services/tracing/pools.js')
    const { traceReadPool } = getTracingPools()
    const client: FakeClient = { query: vi.fn().mockResolvedValue({}), release: vi.fn() }
    vi.mocked(traceReadPool.connect).mockResolvedValue(client as never)

    await expect(
      withTraceReadTransaction(async () => {
        throw Object.assign(new Error('canceling statement due to statement timeout'), {
          code: '57014',
        })
      })
    ).rejects.toThrow('statement timeout')

    expect(metricSpies.statementTimeoutsInc).toHaveBeenCalledWith({ pool: 'read' })
    expect(metricSpies.recordOperationalError).toHaveBeenCalledWith('read', 'statement_timeout')
    expect(metricSpies.rejectionsInc).not.toHaveBeenCalled()
  })

  it('keeps maintenance failures out of the ingest/read operations snapshot signal', async () => {
    process.env.TRACING_MAINTENANCE_PG_CONNECTION_STRING = 'postgresql://runtime/maintenance'
    const { getTraceMaintenancePool, withTraceMaintenanceClient } =
      await import('../src/services/tracing/pools.js')
    const maintenancePool = getTraceMaintenancePool()
    vi.mocked(maintenancePool.connect).mockRejectedValue(new Error('maintenance pool unavailable'))

    await expect(withTraceMaintenanceClient(async () => 'unreachable')).rejects.toThrow(
      'maintenance pool unavailable'
    )

    expect(metricSpies.rejectionsInc).toHaveBeenCalledWith({ pool: 'maintenance' })
    expect(metricSpies.recordOperationalError).not.toHaveBeenCalled()
  })
})
