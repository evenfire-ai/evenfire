import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockGateway } from './mockGateway.js'

describe('tracing app wiring', () => {
  afterEach(() => {
    vi.doUnmock('../src/services/tracing/pools.js')
    vi.doUnmock('../src/services/tracing/routeSubmissionService.js')
    vi.doUnmock('../src/services/tracing/workflowRunBindingResolver.js')
    vi.resetModules()
  })

  it('resolves WRC bindings through the trace ingest pool, never the trace read pool', async () => {
    const traceIngestPool = { query: vi.fn() }
    const traceReadPool = { query: vi.fn() }
    const WorkflowRunBindingResolver = vi.fn(function WorkflowRunBindingResolverMock() {})
    const HostReferencedRunBindingResolver = vi.fn(
      function HostReferencedRunBindingResolverMock() {}
    )
    const AgentRunBindingResolverChain = vi.fn(function AgentRunBindingResolverChainMock() {})
    const RouteTracingSubmissionService = vi.fn(function RouteTracingSubmissionServiceMock(this: {
      submit: ReturnType<typeof vi.fn>
    }) {
      this.submit = vi.fn()
    })

    vi.doMock('../src/services/tracing/pools.js', () => ({
      getTracingPools: () => ({ traceIngestPool, traceReadPool }),
      withTraceIngestTransaction: vi.fn(),
    }))
    vi.doMock('../src/services/tracing/workflowRunBindingResolver.js', () => ({
      WorkflowRunBindingResolver,
      HostReferencedRunBindingResolver,
      AgentRunBindingResolverChain,
    }))
    vi.doMock('../src/services/tracing/routeSubmissionService.js', () => ({
      RouteTracingSubmissionService,
    }))

    const { createApp } = await import('../src/app.js')
    createApp(new MockGateway('mcp-server') as never)

    expect(WorkflowRunBindingResolver).toHaveBeenCalledOnce()
    const resolverDb = WorkflowRunBindingResolver.mock.calls[0]![0]
    await resolverDb.query('SELECT 1')
    expect(traceIngestPool.query).toHaveBeenCalledWith('SELECT 1', undefined)
    expect(traceReadPool.query).not.toHaveBeenCalled()
    expect(RouteTracingSubmissionService).toHaveBeenCalledWith(
      expect.objectContaining({ agentRunBindingResolver: expect.anything() })
    )
  })
})
