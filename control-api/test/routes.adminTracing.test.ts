import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAdminTracingRouter } from '../src/routes/admin/tracing/index.js'

const PAGE = {
  events: [],
  nextCursor: 'next-cursor',
  capturedHighWatermark: '42',
}

const OPERATIONS_SNAPSHOT = {
  generatedAt: '2026-07-13T12:00:00.000Z',
  instanceStartedAt: '2026-07-13T11:00:00.000Z',
  scope: 'control-api-instance' as const,
  health: 'healthy' as const,
  limits: {
    bodyBytes: 524_288,
    eventsPerRequest: 100,
    maxInFlight: 32,
    ingestPoolMax: 4,
    readPoolMax: 3,
    poolConnectionTimeoutMs: 2_000,
    ingestStatementTimeoutMs: 5_000,
    readStatementTimeoutMs: 2_000,
    recentErrorSeconds: 300,
  },
  ingestion: {
    acceptedEvents: 0,
    replayedEvents: 0,
    rejectedEvents: 0,
    conflictingEvents: 0,
    admissionRequests: 0,
    admissionRejected: 0,
    inFlight: 0,
  },
  pools: [],
  errors: [],
}

function appWithReader() {
  const reader = { read: vi.fn().mockResolvedValue(PAGE) }
  const costReader = {
    read: vi.fn().mockResolvedValue({ ok: true }),
    listScopes: vi.fn().mockResolvedValue({ scopes: [], truncated: false }),
  }
  const operationsReader = { read: vi.fn().mockResolvedValue(OPERATIONS_SNAPSHOT) }
  const app = express()
  app.use(createAdminTracingRouter(reader, costReader as never, operationsReader))
  return { app, reader, costReader, operationsReader }
}

describe('admin tracing read routes', () => {
  it('returns the bounded in-memory operations snapshot without caching it', async () => {
    const { app, operationsReader, reader, costReader } = appWithReader()

    const response = await request(app).get('/admin/tracing/operations').expect(200)

    expect(response.body).toEqual(OPERATIONS_SNAPSHOT)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(operationsReader.read).toHaveBeenCalledOnce()
    expect(reader.read).not.toHaveBeenCalled()
    expect(costReader.read).not.toHaveBeenCalled()
  })

  it('maps recent-run search to an agent-run stream query and forwards the opaque cursor', async () => {
    const { app, reader } = appWithReader()

    await request(app)
      .get('/admin/tracing/runs')
      .query({
        limit: '25',
        cursor: 'opaque-cursor-v1',
        occurredFrom: '2026-07-01T00:00:00.000Z',
        occurredTo: '2026-07-02T00:00:00.000Z',
        order: 'latest',
      })
      .expect(200)
      .expect(PAGE)

    expect(reader.read).toHaveBeenCalledWith({
      scope: { kind: 'stream' },
      families: ['agent_run'],
      limit: 25,
      cursor: 'opaque-cursor-v1',
      occurredFrom: '2026-07-01T00:00:00.000Z',
      occurredTo: '2026-07-02T00:00:00.000Z',
      order: 'latest',
    })
  })

  it('maps workflow and encoded host detail paths to relationship-bound run scopes', async () => {
    const { app, reader } = appWithReader()

    await request(app)
      .get('/admin/tracing/workflows/sandbox-recipes/chatllm/runs/run-workflow-1')
      .expect(200)
    await request(app)
      .get('/admin/tracing/hosts/sandbox-recipes%2Fchatllm/runs/run-host-1')
      .query({ cursor: 'opaque-host-cursor' })
      .expect(200)

    expect(reader.read).toHaveBeenNthCalledWith(1, {
      scope: {
        kind: 'workflow_run',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'chatllm',
        runId: 'run-workflow-1',
      },
      families: ['agent_run'],
    })
    expect(reader.read).toHaveBeenNthCalledWith(2, {
      scope: { kind: 'host_run', hostRef: 'sandbox-recipes/chatllm', runId: 'run-host-1' },
      families: ['agent_run'],
      cursor: 'opaque-host-cursor',
    })
  })

  it('maps event workload searches to a workload scope and an explicit family filter', async () => {
    const { app, reader } = appWithReader()

    await request(app)
      .get('/admin/tracing/events')
      .query({
        workloadRef: 'mcp-server/chatllm',
        families: 'infrastructure_telemetry',
        occurredFrom: '2026-07-01T00:00:00.000Z',
        occurredTo: '2026-07-02T00:00:00.000Z',
      })
      .expect(200)

    expect(reader.read).toHaveBeenCalledWith({
      scope: { kind: 'workload', workloadRef: 'mcp-server/chatllm' },
      families: ['infrastructure_telemetry'],
      occurredFrom: '2026-07-01T00:00:00.000Z',
      occurredTo: '2026-07-02T00:00:00.000Z',
    })
  })

  it('rejects unbounded administrative and infrastructure exploration', async () => {
    const { app, reader } = appWithReader()

    await request(app)
      .get('/admin/tracing/events')
      .query({ families: 'administrative' })
      .expect(400)

    expect(reader.read).not.toHaveBeenCalled()
  })

  it('rejects arbitrary enum predicates before reaching the repository', async () => {
    const { app, reader } = appWithReader()

    await request(app)
      .get('/admin/tracing/events')
      .query({
        families: 'infrastructure_telemetry',
        occurredFrom: '2026-07-01T00:00:00.000Z',
        occurredTo: '2026-07-02T00:00:00.000Z',
        workloadKind: 'raw SQL expression',
      })
      .expect(400)

    expect(reader.read).not.toHaveBeenCalled()
  })

  it('rejects out-of-range limits and unscoped run identifiers before reading', async () => {
    const { app, reader } = appWithReader()

    await request(app).get('/admin/tracing/runs').query({ limit: '201' }).expect(400)
    await request(app).get('/admin/tracing/runs').query({ runId: 'not-a-scope' }).expect(400)
    await request(app).get('/admin/tracing/runs').query({ order: 'random' }).expect(400)

    expect(reader.read).not.toHaveBeenCalled()
  })

  it('maps typed reader cursor errors to HTTP 400', async () => {
    const readerError = Object.assign(
      new Error('governed event cursor does not belong to this query'),
      {
        code: 'governed_read_invalid_query',
        status: 400,
        statusCode: 400,
      }
    )
    const reader = { read: vi.fn().mockRejectedValue(readerError) }
    const costReader = { read: vi.fn().mockResolvedValue({ ok: true }) }
    const app = express()
    app.use(createAdminTracingRouter(reader, costReader as never))

    await request(app)
      .get('/admin/tracing/runs')
      .query({ cursor: 'cursor-from-other-query' })
      .expect(400)
      .expect({
        error: 'invalid_query',
        detail: 'governed event cursor does not belong to this query',
      })
  })

  it('parses bounded infrastructure-cost dimensions before reading', async () => {
    const { app, reader, costReader } = appWithReader()

    await request(app)
      .get('/admin/tracing/costs/infrastructure')
      .query({
        period: 'week',
        anchorDate: '2026-07-11',
        valuation: 'estimated',
        basis: 'requested_capacity',
        cloudProvider: 'gcp',
        cloudProjectId: 'project-1',
        clusterLocation: 'europe-west1',
        clusterName: 'cluster-1',
        environment: 'test',
        namespace: 'control-plane',
        workloadKind: 'Deployment',
        workloadRef: 'control-api',
        currency: 'USD',
      })
      .expect(200)
      .expect({ ok: true })

    expect(costReader.read).toHaveBeenCalledWith({
      period: 'week',
      periodStartUtc: '2026-07-06',
      periodEndUtc: '2026-07-13',
      valuation: 'estimated',
      basis: 'requested_capacity',
      dimensions: {
        cloudProvider: 'gcp',
        cloudProjectId: 'project-1',
        clusterLocation: 'europe-west1',
        clusterName: 'cluster-1',
        environment: 'test',
        namespace: 'control-plane',
        workloadKind: 'Deployment',
        workloadRef: 'control-api',
        currency: 'USD',
      },
    })
    expect(reader.read).not.toHaveBeenCalled()
  })

  it('lists persisted infrastructure cost scopes without accepting caller filters', async () => {
    const { app, costReader } = appWithReader()
    const catalog = {
      scopes: [
        {
          dimensions: {
            cloudProvider: 'gcp',
            cloudProjectId: 'project-1',
            clusterLocation: 'europe-west1',
            clusterName: 'cluster-1',
            environment: 'test',
            namespace: 'control-plane',
            workloadKind: 'Deployment',
            workloadRef: 'control-api',
            currency: 'USD',
          },
          firstUtcDay: '2026-07-01',
          lastUtcDay: '2026-07-11',
          availableValuations: ['estimated'],
          latestAsOfUtc: '2026-07-12T00:00:00.000Z',
          billingExportWatermark: null,
          billingLagHours: null,
        },
      ],
      truncated: false,
    }
    costReader.listScopes.mockResolvedValue(catalog)

    await request(app).get('/admin/tracing/costs/infrastructure/scopes').expect(200).expect(catalog)
    await request(app)
      .get('/admin/tracing/costs/infrastructure/scopes')
      .query({ cloudProjectId: 'caller-controlled' })
      .expect(400)

    expect(costReader.listScopes).toHaveBeenCalledOnce()
    expect(costReader.read).not.toHaveBeenCalled()
  })

  it('rejects unsupported infrastructure-cost query shape before reading', async () => {
    const { app, costReader } = appWithReader()

    await request(app)
      .get('/admin/tracing/costs/infrastructure')
      .query({
        period: 'day',
        anchorDate: '2026-07-11',
        cloudProvider: 'gcp',
        cloudProjectId: 'project-1',
        clusterLocation: 'europe-west1',
        clusterName: 'cluster-1',
        environment: 'test',
        namespace: 'control-plane',
        workloadKind: 'Deployment',
        workloadRef: 'control-api',
        currency: 'USD',
        sql: 'drop table infrastructure_cost_daily',
      })
      .expect(400)

    expect(costReader.read).not.toHaveBeenCalled()
  })
})
