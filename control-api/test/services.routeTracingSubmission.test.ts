import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import type {
  AdministrativeEventSubmitterPrincipalV1,
  AgentRunEventSubmitterPrincipalV1,
} from '../src/middleware/tracingSubmitterAuth.js'
import {
  governedTraceAcceptedTotal,
  governedTraceConflictingTotal,
  governedTraceLastErrorTimestampSeconds,
  governedTraceOperationalErrorsTotal,
  governedTraceRejectedTotal,
  governedTraceReplayedTotal,
} from '../src/observability/metrics.js'
import type { AdministrativeEventSubmissionService } from '../src/routes/internal/administrativeEvents.js'
import type { AgentRunEventSubmissionService } from '../src/routes/internal/agentRunEvents.js'
import type { InfrastructureTelemetryEventSubmissionService } from '../src/routes/internal/infrastructureTelemetryEvents.js'
import {
  TracingIdempotencyConflictError,
  UnsafeTracingInputError,
} from '../src/services/tracing/append.js'
import type {
  GovernedAppendResult,
  TracingTransactionRunner,
} from '../src/services/tracing/contracts.js'
import {
  RouteTracingSubmissionService,
  TracingBindingUnavailableError,
} from '../src/services/tracing/routeSubmissionService.js'
import { NOW, adminBinding, agentBinding, agentInput } from './services.tracingFixtures.js'

const workflowPrincipal: AgentRunEventSubmitterPrincipalV1 = {
  kind: 'wrc_internal_control',
  sourceService: 'workflow-recipes',
  serviceSub: 'wrc-provisioner',
  credentialId: 'test-principal',
  allowedEventTypes: ['run_start', 'run_end'],
}
const workflowInput = {
  ...agentInput,
  runId: agentBinding.runId,
}
const administrativePrincipal = {
  kind: 'hcc_internal_control',
  sourceService: 'host-context-controller',
  serviceSub: 'hcc-provisioner',
  credentialId: 'test-principal',
  allowedKinds: ['linked_outcome'],
} as const satisfies AdministrativeEventSubmitterPrincipalV1
const administrativeInput = {
  sourceEventId: 'administrative-1',
  occurredAt: NOW,
  kind: 'linked_outcome',
}

function appendResult(kind: 'accepted' | 'replayed'): GovernedAppendResult {
  return {
    kind,
    accepted: kind === 'accepted' ? 1 : 0,
    replayed: kind === 'replayed' ? 1 : 0,
    family: 'agent_run',
    eventId: '11111111-1111-4111-8111-111111111111',
    streamSequence: '41',
    payloadSha256: 'a'.repeat(64),
    ingestedAt: NOW,
  }
}

function transactionHarness() {
  const db = { query: vi.fn() } as DbClient
  const transactionSpy = vi.fn(async (work: (client: DbClient) => Promise<unknown>) => work(db))
  return {
    db,
    transactionSpy,
    transaction: transactionSpy as TracingTransactionRunner,
  }
}

describe('route tracing submission facade', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('satisfies all three route services and appends a batch in one transaction', async () => {
    const h = transactionHarness()
    const resolve = vi.fn().mockResolvedValue(agentBinding)
    const appendManyInTransaction = vi
      .fn()
      .mockResolvedValue([appendResult('accepted'), appendResult('accepted')])
    const service = new RouteTracingSubmissionService({
      transaction: h.transaction,
      agentRunBindingResolver: { resolve },
      agentRunEventAppender: { appendManyInTransaction },
    })

    const agentRoute: AgentRunEventSubmissionService = service
    const administrativeRoute: AdministrativeEventSubmissionService = service
    const infrastructureRoute: InfrastructureTelemetryEventSubmissionService = service
    expect([agentRoute, administrativeRoute, infrastructureRoute]).toEqual([
      service,
      service,
      service,
    ])

    await expect(
      agentRoute.submit({
        principal: workflowPrincipal,
        events: [{ ...workflowInput }, { ...workflowInput, sourceEventId: 'activity-2' }],
      })
    ).resolves.toEqual({ accepted: 2, replayed: 0 })

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(h.transactionSpy).toHaveBeenCalledTimes(1)
    expect(appendManyInTransaction).toHaveBeenCalledOnce()
    expect(appendManyInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.any(Function) }),
      workflowPrincipal,
      expect.any(Array)
    )
    expect(
      appendManyInTransaction.mock.calls[0]![2].map(entry => entry.input.sourceEventId)
    ).toEqual(['activity-1', 'activity-2'])
    expect(appendManyInTransaction.mock.calls[0]![2].map(entry => entry.input.runId)).toEqual([
      undefined,
      undefined,
    ])
  })

  it('returns accepted and replayed totals from family append results', async () => {
    const h = transactionHarness()
    const appendManyInTransaction = vi
      .fn()
      .mockResolvedValue([appendResult('accepted'), appendResult('replayed')])
    const service = new RouteTracingSubmissionService({
      transaction: h.transaction,
      agentRunBindingResolver: { resolve: vi.fn().mockResolvedValue(agentBinding) },
      agentRunEventAppender: { appendManyInTransaction },
    })

    await expect(
      service.submit({
        principal: workflowPrincipal,
        events: [{ ...workflowInput }, { ...workflowInput, sourceEventId: 'activity-2' }],
      })
    ).resolves.toEqual({ accepted: 1, replayed: 1 })
  })

  it('uses the resolver batch path once for a multi-event agent submission', async () => {
    const h = transactionHarness()
    const resolve = vi.fn()
    const resolveMany = vi.fn().mockResolvedValue([agentBinding, agentBinding])
    const appendManyInTransaction = vi
      .fn()
      .mockResolvedValue([appendResult('accepted'), appendResult('accepted')])
    const service = new RouteTracingSubmissionService({
      transaction: h.transaction,
      agentRunBindingResolver: { resolve, resolveMany },
      agentRunEventAppender: { appendManyInTransaction },
    })

    await expect(
      service.submit({
        principal: workflowPrincipal,
        events: [{ ...workflowInput }, { ...workflowInput, sourceEventId: 'activity-2' }],
      })
    ).resolves.toEqual({ accepted: 2, replayed: 0 })

    expect(resolveMany).toHaveBeenCalledOnce()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('fails closed when an administrative batch resolver returns the wrong size', async () => {
    const h = transactionHarness()
    const appendManyInTransaction = vi.fn()
    const service = new RouteTracingSubmissionService({
      transaction: h.transaction,
      administrativeOperationBindingResolver: {
        resolve: vi.fn(),
        resolveMany: vi.fn().mockResolvedValue([]),
      },
      administrativeEventAppender: { appendManyInTransaction },
    })

    await expect(
      service.submit({ principal: administrativePrincipal, events: [administrativeInput] })
    ).rejects.toThrow('trusted operation binding resolver returned an unexpected batch size')
    expect(h.transactionSpy).not.toHaveBeenCalled()
    expect(appendManyInTransaction).not.toHaveBeenCalled()
  })

  it('records accepted and replayed events with only bounded trace labels after commit', async () => {
    const accepted = vi.spyOn(governedTraceAcceptedTotal, 'inc')
    const replayed = vi.spyOn(governedTraceReplayedTotal, 'inc')
    const h = transactionHarness()
    const appendManyInTransaction = vi
      .fn()
      .mockResolvedValue([appendResult('accepted'), appendResult('replayed')])
    const service = new RouteTracingSubmissionService({
      transaction: h.transaction,
      agentRunBindingResolver: { resolve: vi.fn().mockResolvedValue(agentBinding) },
      agentRunEventAppender: { appendManyInTransaction },
    })

    await service.submit({
      principal: workflowPrincipal,
      events: [
        { ...workflowInput },
        { ...workflowInput, eventType: 'run_end', sourceEventId: 'activity-2' },
      ],
    })

    expect(accepted).toHaveBeenCalledWith(
      { family: 'agent_run', source: 'workflow-recipes', type: 'run_start' },
      1
    )
    expect(replayed).toHaveBeenCalledWith(
      { family: 'agent_run', source: 'workflow-recipes', type: 'run_end' },
      1
    )
  })

  it('records rejected conflict events without placing trace identifiers in labels', async () => {
    const rejected = vi.spyOn(governedTraceRejectedTotal, 'inc')
    const conflicting = vi.spyOn(governedTraceConflictingTotal, 'inc')
    const lastError = vi.spyOn(governedTraceLastErrorTimestampSeconds, 'set')
    const h = transactionHarness()
    const service = new RouteTracingSubmissionService({
      transaction: h.transaction,
      agentRunBindingResolver: { resolve: vi.fn().mockResolvedValue(agentBinding) },
      agentRunEventAppender: {
        appendManyInTransaction: vi
          .fn()
          .mockRejectedValue(
            new TracingIdempotencyConflictError(
              'agent_run',
              'wrc_internal_control',
              workflowInput.sourceEventId
            )
          ),
      },
    })

    await expect(
      service.submit({ principal: workflowPrincipal, events: [{ ...workflowInput }] })
    ).rejects.toBeInstanceOf(TracingIdempotencyConflictError)

    expect(rejected).toHaveBeenCalledWith({
      family: 'agent_run',
      source: 'workflow-recipes',
      type: 'run_start',
    })
    expect(conflicting).toHaveBeenCalledWith({
      family: 'agent_run',
      source: 'workflow-recipes',
      type: 'run_start',
    })
    expect(lastError).toHaveBeenCalledWith(
      { scope: 'agent_run', reason: 'idempotency_conflict' },
      expect.any(Number)
    )
    expect(lastError).not.toHaveBeenCalledWith(
      { scope: 'agent_run', reason: 'event_rejected' },
      expect.any(Number)
    )
    expect(JSON.stringify(conflicting.mock.calls)).not.toContain(workflowInput.runId)
  })

  it('does not start a transaction or append when a binding resolver rejects', async () => {
    const rejected = vi.spyOn(governedTraceRejectedTotal, 'inc')
    const lastError = vi.spyOn(governedTraceLastErrorTimestampSeconds, 'set')
    const operationalError = vi.spyOn(governedTraceOperationalErrorsTotal, 'inc')
    const h = transactionHarness()
    const resolverError = new Error('trusted lookup failed')
    const appendManyInTransaction = vi.fn()
    const service = new RouteTracingSubmissionService({
      transaction: h.transaction,
      agentRunBindingResolver: { resolve: vi.fn().mockRejectedValue(resolverError) },
      agentRunEventAppender: { appendManyInTransaction },
    })

    await expect(
      service.submit({ principal: workflowPrincipal, events: [{ ...workflowInput }] })
    ).rejects.toBe(resolverError)
    expect(h.transactionSpy).not.toHaveBeenCalled()
    expect(appendManyInTransaction).not.toHaveBeenCalled()
    expect(rejected).toHaveBeenCalledWith({
      family: 'agent_run',
      source: 'workflow-recipes',
      type: 'run_start',
    })
    expect(operationalError).toHaveBeenCalledWith({
      scope: 'agent_run',
      reason: 'submission_failed',
    })
    expect(lastError).toHaveBeenCalledWith(
      { scope: 'agent_run', reason: 'submission_failed' },
      expect.any(Number)
    )
  })

  it('fails closed with a typed 403 error when no trusted resolver is configured', async () => {
    const rejected = vi.spyOn(governedTraceRejectedTotal, 'inc')
    const lastError = vi.spyOn(governedTraceLastErrorTimestampSeconds, 'set')
    const h = transactionHarness()
    const appendManyInTransaction = vi.fn()
    const service = new RouteTracingSubmissionService({
      transaction: h.transaction,
      agentRunEventAppender: { appendManyInTransaction },
    })

    const failure = service.submit({ principal: workflowPrincipal, events: [{ ...workflowInput }] })
    await expect(failure).rejects.toMatchObject({
      name: 'TracingBindingUnavailableError',
      code: 'tracing_binding_unavailable',
      status: 403,
      statusCode: 403,
      bindingKind: 'run',
      eventIndex: 0,
    })
    await expect(failure).rejects.toBeInstanceOf(TracingBindingUnavailableError)
    expect(h.transactionSpy).not.toHaveBeenCalled()
    expect(appendManyInTransaction).not.toHaveBeenCalled()
    expect(rejected).toHaveBeenCalledWith({
      family: 'agent_run',
      source: 'workflow-recipes',
      type: 'run_start',
    })
    expect(lastError).toHaveBeenCalledWith(
      { scope: 'agent_run', reason: 'event_rejected' },
      expect.any(Number)
    )
  })

  it.each([
    ['identity', { agentSub: 'body-controlled-agent' }],
    ['binding', { operationId: adminBinding.operationId }],
    ['money', { cost: 1.25 }],
  ])('rejects server-owned %s authority from the body before resolution', async (_kind, extra) => {
    const rejected = vi.spyOn(governedTraceRejectedTotal, 'inc')
    const lastError = vi.spyOn(governedTraceLastErrorTimestampSeconds, 'set')
    const h = transactionHarness()
    const resolve = vi.fn().mockResolvedValue(agentBinding)
    const appendManyInTransaction = vi.fn()
    const service = new RouteTracingSubmissionService({
      transaction: h.transaction,
      agentRunBindingResolver: { resolve },
      agentRunEventAppender: { appendManyInTransaction },
    })

    await expect(
      service.submit({
        principal: workflowPrincipal,
        events: [{ ...workflowInput, ...extra }],
      })
    ).rejects.toBeInstanceOf(UnsafeTracingInputError)
    expect(resolve).not.toHaveBeenCalled()
    expect(h.transactionSpy).not.toHaveBeenCalled()
    expect(appendManyInTransaction).not.toHaveBeenCalled()
    expect(rejected).toHaveBeenCalledWith({
      family: 'agent_run',
      source: 'workflow-recipes',
      type: 'run_start',
    })
    expect(lastError).toHaveBeenCalledWith(
      { scope: 'agent_run', reason: 'event_rejected' },
      expect.any(Number)
    )
  })
})
