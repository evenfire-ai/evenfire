import { beforeEach, describe, expect, it } from 'vitest'
import type {
  AdministrativeEventSubmitterPrincipalV1,
  InfrastructureTelemetrySubmitterPrincipalV1,
} from '../src/middleware/tracingSubmitterAuth.js'
import type { TracingSubmissionResult as RouteTracingSubmissionResult } from '../src/routes/internal/agentRunEvents.js'
import {
  AdministrativeEventService,
  AdministrativePrincipalBindingInvariantError,
} from '../src/services/tracing/administrativeEvents.js'
import {
  AgentRunEventService,
  AgentRunPrincipalBindingInvariantError,
  type McpHostRuntimeAgentRunPrincipalV1,
} from '../src/services/tracing/agentRunEvents.js'
import {
  TracingIdempotencyConflictError,
  UnsafeTracingInputError,
  assertSafeEventPayload,
} from '../src/services/tracing/append.js'
import type {
  AgentRunEventInputV1,
  TracingTransactionRunner,
} from '../src/services/tracing/contracts.js'
import { CONTROL_API_LOCAL_ADMINISTRATIVE_PRINCIPAL_V1 } from '../src/services/tracing/controlApiLocalAdministrativeBindingResolver.js'
import {
  InfrastructurePrincipalBindingInvariantError,
  InfrastructureTelemetryEventService,
} from '../src/services/tracing/infrastructureTelemetryEvents.js'
import {
  EVENT_ID,
  type Harness,
  NOW,
  acceptedDb,
  adminBinding,
  adminInput,
  adminPrincipal,
  agentBinding,
  agentInput,
  agentPrincipal,
  harness,
  infraBinding,
  infraInput,
  infraPrincipal,
} from './services.tracingFixtures.js'

describe('governed family append SQL', () => {
  it('accepts an HCC runtime Host claim that differs from the broker recipe identity', async () => {
    const h = harness()
    acceptedDb(h.query)
    const principal = {
      ...(agentPrincipal as McpHostRuntimeAgentRunPrincipalV1),
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
      hostRefs: ['chatllm-stateless'],
    }

    await expect(
      new AgentRunEventService({ transaction: h.transaction }).append(
        principal,
        {
          ...agentBinding,
          recipeNamespace: 'mcp-host',
          recipeName: 'standalone',
          hostRef: 'chatllm-stateless',
        },
        agentInput
      )
    ).resolves.toMatchObject({ kind: 'accepted' })
  })

  it.each([
    {
      table: 'agent_run_events',
      family: 'agent_run',
      expectedCasts: ['::uuid', '::text[]', '::jsonb', '::timestamptz'],
      invoke: (transaction: TracingTransactionRunner) =>
        new AgentRunEventService({
          transaction,
          now: () => new Date(NOW),
          newEventId: () => EVENT_ID,
        }).append(agentPrincipal, agentBinding, agentInput),
    },
    {
      table: 'administrative_events',
      family: 'administrative',
      expectedCasts: ['::uuid', '::jsonb', '::timestamptz'],
      invoke: (transaction: TracingTransactionRunner) =>
        new AdministrativeEventService({
          transaction,
          now: () => new Date(NOW),
          newEventId: () => EVENT_ID,
        }).append(adminPrincipal, adminBinding, adminInput),
    },
    {
      table: 'infrastructure_telemetry_events',
      family: 'infrastructure_telemetry',
      expectedCasts: ['::uuid', '::bigint', '::numeric', '::jsonb', '::timestamptz'],
      invoke: (transaction: TracingTransactionRunner) =>
        new InfrastructureTelemetryEventService({
          transaction,
          now: () => new Date(NOW),
          newEventId: () => EVENT_ID,
        }).append(infraPrincipal, infraBinding, infraInput),
    },
  ])('appends $family and its stream pointer in one CTE', async entry => {
    const h = harness()
    acceptedDb(h.query)

    const result = await entry.invoke(h.transaction)
    const routeResult: RouteTracingSubmissionResult = result

    expect(result).toMatchObject({ kind: 'accepted', family: entry.family, streamSequence: '41' })
    expect(routeResult).toEqual(expect.objectContaining({ accepted: 1, replayed: 0 }))
    expect(h.transactionSpy).toHaveBeenCalledTimes(1)
    expect(h.query).toHaveBeenCalledTimes(3)
    const lockSql = String(h.query.mock.calls[0][0])
    const insertSql = String(h.query.mock.calls[2][0])
    expect(lockSql).toContain('pg_advisory_xact_lock')
    expect(insertSql).toContain(`INSERT INTO ${entry.table}`)
    expect(insertSql).toContain('INSERT INTO governed_event_stream')
    expect(insertSql).toContain('inserted_family AS')
    expect(insertSql).toContain('inserted_stream AS')
    entry.expectedCasts.forEach(cast => expect(insertSql).toContain(cast))
  })

  it.each([
    {
      family: 'agent_run',
      principal: agentPrincipal,
      sourceEventId: agentInput.sourceEventId,
      sourceIdentityColumn: 'source_event_id',
      invoke: (transaction: TracingTransactionRunner) =>
        new AgentRunEventService({
          transaction,
          now: () => new Date(NOW),
          newEventId: () => EVENT_ID,
        }).append(agentPrincipal, agentBinding, agentInput),
    },
    {
      family: 'administrative',
      principal: adminPrincipal,
      sourceEventId: adminInput.sourceEventId,
      sourceIdentityColumn: 'source_event_id',
      invoke: (transaction: TracingTransactionRunner) =>
        new AdministrativeEventService({
          transaction,
          now: () => new Date(NOW),
          newEventId: () => EVENT_ID,
        }).append(adminPrincipal, adminBinding, adminInput),
    },
    {
      family: 'infrastructure_telemetry',
      principal: infraPrincipal,
      sourceEventId: infraInput.sourceEventId,
      sourceIdentityColumn: 'source_occurrence_id',
      invoke: (transaction: TracingTransactionRunner) =>
        new InfrastructureTelemetryEventService({
          transaction,
          now: () => new Date(NOW),
          newEventId: () => EVENT_ID,
        }).append(infraPrincipal, infraBinding, infraInput),
    },
  ])('uses the exact $family source identity for lock and replay lookup', async entry => {
    const h = harness()
    acceptedDb(h.query)

    await entry.invoke(h.transaction)

    const lockIdentities = h.query.mock.calls[0][1]?.[0]
    const lookupSql = String(h.query.mock.calls[1][0])
    const lookupParams = h.query.mock.calls[1][1] as unknown[]
    const identity = JSON.stringify([
      entry.family,
      entry.principal.sourceService,
      entry.principal.kind,
      entry.sourceEventId,
      ...(entry.family === 'agent_run'
        ? [agentInput.eventType, agentBinding.runId]
        : entry.family === 'administrative'
          ? [adminInput.kind, adminBinding.operationId, adminBinding.targetRef]
          : [
              infraInput.telemetryType,
              infraBinding.workloadRef,
              infraBinding.metadataGeneration,
              null,
              null,
            ]),
    ])
    expect(lockIdentities).toEqual([identity])
    expect(lookupSql).toContain('f.source_service = r.source_service')
    expect(lookupSql).toContain('f.source_kind = r.source_kind')
    expect(lookupSql).toContain('f.idempotency_key = r.idempotency_key')
    expect(lookupParams[0]).toBe(entry.family)
    expect(JSON.parse(String(lookupParams[1]))).toEqual([
      {
        batch_index: 0,
        source_service: entry.principal.sourceService,
        source_kind: entry.principal.kind,
        source_event_id: entry.sourceEventId,
        idempotency_key: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ])
  })

  it('supports an existing caller transaction without opening another one', async () => {
    const h = harness()
    acceptedDb(h.query)
    const service = new AdministrativeEventService({
      transaction: h.transaction,
      now: () => new Date(NOW),
      newEventId: () => EVENT_ID,
    })

    await service.appendInTransaction(h.db, adminPrincipal, adminBinding, adminInput)

    expect(h.transactionSpy).not.toHaveBeenCalled()
    expect(h.query).toHaveBeenCalledTimes(3)
  })

  it('persists server-derived Control UI administrator authority for new local events', async () => {
    const h = harness()
    acceptedDb(h.query)
    const operatorId = '22222222-2222-4222-8222-222222222222'

    await new AdministrativeEventService({
      transaction: h.transaction,
      now: () => new Date(NOW),
      newEventId: () => EVENT_ID,
    }).append(
      CONTROL_API_LOCAL_ADMINISTRATIVE_PRINCIPAL_V1,
      {
        action: 'permission_grant',
        outcome: 'committed',
        operatorSub: operatorId,
        operationId: null,
        relatedRunId: null,
        requestId: null,
        targetType: 'permission',
        targetRef: 'workflow_recipe:sandbox-recipes/example',
        environment: 'test',
        tenantId: null,
        teamId: null,
        namespace: 'sandbox-recipes',
        sourceAuditRef: null,
      },
      {
        kind: 'service_action',
        sourceEventId: 'local-admin-event-1',
        occurredAt: NOW,
      }
    )

    const [sql, params] = h.query.mock.calls[2] as [string, unknown[]]
    const batchColumns = /WITH batch_values \(([^)]+)\)/.exec(sql)?.[1]?.split(',') ?? []
    const values = new Map(batchColumns.map((column, index) => [column.trim(), params[index]]))
    expect(values.get('operator_sub')).toBe(operatorId)
    expect(values.get('operator_user_id')).toBe(operatorId)
    expect(values.get('identity_issuer')).toEqual(expect.any(String))
    expect(values.get('resource_aud')).toEqual(expect.any(String))
    expect(values.get('authorization_decision')).toBe('allow')
    expect(values.get('decision_actor_sub')).toBe(operatorId)
  })
})

describe('governed append idempotency', () => {
  let h: Harness
  let persistedDigest: string | null

  beforeEach(() => {
    h = harness()
    persistedDigest = null
    h.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 }
      if (sql.includes('LEFT JOIN governed_event_stream')) {
        return persistedDigest
          ? {
              rows: [
                {
                  batch_index: 0,
                  event_id: EVENT_ID,
                  payload_sha256: persistedDigest,
                  ingested_at: NOW,
                  stream_sequence: '7',
                },
              ],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 }
      }
      if (sql.includes('WHERE FALSE')) return { rows: [], rowCount: 0 }
      persistedDigest = String(params?.[9])
      return {
        rows: [
          {
            batch_index: 0,
            event_id: EVENT_ID,
            payload_sha256: persistedDigest,
            ingested_at: NOW,
            stream_sequence: '7',
          },
        ],
        rowCount: 1,
      }
    })
  })

  it('replays the same family/source-service/source-kind/source-event-id and digest', async () => {
    const service = new AgentRunEventService({
      transaction: h.transaction,
      now: () => new Date(NOW),
      newEventId: () => EVENT_ID,
    })

    await expect(service.append(agentPrincipal, agentBinding, agentInput)).resolves.toMatchObject({
      kind: 'accepted',
      accepted: 1,
      replayed: 0,
    })
    await expect(service.append(agentPrincipal, agentBinding, agentInput)).resolves.toMatchObject({
      kind: 'replayed',
      accepted: 0,
      replayed: 1,
      eventId: EVENT_ID,
      streamSequence: '7',
    })

    const inserts = h.query.mock.calls.filter(call => String(call[0]).includes('inserted_family'))
    expect(inserts).toHaveLength(1)
  })

  it('signals conflict when the same identity has a different digest', async () => {
    const service = new AgentRunEventService({
      transaction: h.transaction,
      now: () => new Date(NOW),
      newEventId: () => EVENT_ID,
    })
    await service.append(agentPrincipal, agentBinding, agentInput)

    await expect(
      service.append(agentPrincipal, agentBinding, {
        ...agentInput,
        payload: { detail_ref: 'different-task' },
      })
    ).rejects.toBeInstanceOf(TracingIdempotencyConflictError)
  })

  it('coalesces an identical reconcile outcome observed at a later time', async () => {
    const service = new InfrastructureTelemetryEventService({
      transaction: h.transaction,
      now: () => new Date(NOW),
      newEventId: () => EVENT_ID,
    })
    const input = {
      ...infraInput,
      sourceEventId: 'hcc-reconcile-outcome:stable-effective-result',
      telemetryType: 'reconcile_outcome' as const,
      payload: { status: 'succeeded', phase: 'deployed', state: 'ready' },
    }

    await expect(service.append(infraPrincipal, infraBinding, input)).resolves.toMatchObject({
      kind: 'accepted',
    })
    await expect(
      service.append(infraPrincipal, infraBinding, {
        ...input,
        occurredAt: '2026-07-10T10:05:00.000Z',
      })
    ).resolves.toMatchObject({ kind: 'replayed' })
  })

  it('does not collide events from different source services with the same kind and source event id', async () => {
    const secondServicePrincipal = { ...agentPrincipal, sourceService: 'mcp-host-secondary' }
    const lockIdentities: string[] = []
    h.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        lockIdentities.push(String(params?.[0]))
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('LEFT JOIN governed_event_stream')) return { rows: [], rowCount: 0 }
      return {
        rows: [
          {
            batch_index: 0,
            event_id: EVENT_ID,
            payload_sha256: 'a'.repeat(64),
            ingested_at: NOW,
            stream_sequence: '7',
          },
        ],
        rowCount: 1,
      }
    })
    const service = new AgentRunEventService({
      transaction: h.transaction,
      now: () => new Date(NOW),
      newEventId: () => EVENT_ID,
    })

    await expect(service.append(agentPrincipal, agentBinding, agentInput)).resolves.toMatchObject({
      kind: 'accepted',
    })
    await expect(
      service.append(secondServicePrincipal, agentBinding, agentInput)
    ).resolves.toMatchObject({
      kind: 'accepted',
    })

    expect(lockIdentities).toEqual([
      JSON.stringify([
        'agent_run',
        agentPrincipal.sourceService,
        agentPrincipal.kind,
        agentInput.sourceEventId,
        agentInput.eventType,
        agentBinding.runId,
      ]),
      JSON.stringify([
        'agent_run',
        secondServicePrincipal.sourceService,
        secondServicePrincipal.kind,
        agentInput.sourceEventId,
        agentInput.eventType,
        agentBinding.runId,
      ]),
    ])
    const lookups = h.query.mock.calls.filter(call =>
      String(call[0]).includes('LEFT JOIN governed_event_stream')
    )
    expect(lookups.map(call => [call[1]?.[0], JSON.parse(String(call[1]?.[1]))])).toEqual([
      [
        'agent_run',
        [
          {
            batch_index: 0,
            source_service: agentPrincipal.sourceService,
            source_kind: agentPrincipal.kind,
            source_event_id: agentInput.sourceEventId,
            idempotency_key: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
        ],
      ],
      [
        'agent_run',
        [
          {
            batch_index: 0,
            source_service: secondServicePrincipal.sourceService,
            source_kind: secondServicePrincipal.kind,
            source_event_id: agentInput.sourceEventId,
            idempotency_key: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
        ],
      ],
    ])
  })
})

describe('server-owned tracing fields', () => {
  it('accepts a bounded administrator label but rejects arbitrary display text', () => {
    expect(() => assertSafeEventPayload({ target_label: 'deleted_admin' })).not.toThrow()
    expect(() => assertSafeEventPayload({ target_label: 'Deleted admin with spaces' })).toThrow(
      UnsafeTracingInputError
    )
  })

  it('accepts bounded non-human target principals and rejects unsafe references', () => {
    expect(() =>
      assertSafeEventPayload({
        target_principal_kind: 'host',
        target_principal_ref: 'host:1st:mcp-host/chatllm',
      })
    ).not.toThrow()
    expect(() =>
      assertSafeEventPayload({
        target_principal_kind: 'host',
        target_principal_ref: 'host with spaces',
      })
    ).toThrow(UnsafeTracingInputError)
    expect(() =>
      assertSafeEventPayload({
        target_principal_kind: 'host',
        target_principal_ref: 'context:wrong-kind',
      })
    ).toThrow(UnsafeTracingInputError)
    expect(() => assertSafeEventPayload({ target_principal_kind: 'host' })).toThrow(
      UnsafeTracingInputError
    )
  })

  it.each(['sourceService', 'operatorSub', 'cost', 'currency'])(
    'rejects client field %s before starting a transaction',
    async field => {
      const h = harness()
      const service = new AgentRunEventService({ transaction: h.transaction })
      const malicious = { ...agentInput, [field]: 'caller-value' } as AgentRunEventInputV1

      await expect(service.append(agentPrincipal, agentBinding, malicious)).rejects.toBeInstanceOf(
        UnsafeTracingInputError
      )
      expect(h.transactionSpy).not.toHaveBeenCalled()
    }
  )

  it('persists service and actor identity only from server parameters', async () => {
    const h = harness()
    acceptedDb(h.query)
    const service = new AgentRunEventService({
      transaction: h.transaction,
      now: () => new Date(NOW),
      newEventId: () => EVENT_ID,
    })

    await service.append(agentPrincipal, agentBinding, agentInput)

    const params = h.query.mock.calls[2][1] as unknown[]
    expect(params).toContain(agentPrincipal.sourceService)
    expect(params).toContain(agentBinding.agentSub)
    expect(JSON.stringify(params)).not.toContain('caller-value')
  })
})

describe('service-level principal and binding invariants', () => {
  const wrcAgent = {
    kind: 'wrc_internal_control',
    sourceService: 'workflow-recipes',
    serviceSub: 'wrc-provisioner',
    credentialId: 'wrc-agent',
    allowedEventTypes: ['run_start', 'run_end'],
  } as const
  const hccAdmin = {
    kind: 'hcc_internal_control',
    sourceService: 'host-context-controller',
    serviceSub: 'hcc-provisioner',
    credentialId: 'hcc-admin',
    allowedKinds: ['linked_outcome'],
  } as const satisfies AdministrativeEventSubmitterPrincipalV1
  const wrcInfra = {
    kind: 'wrc_internal_control',
    sourceService: 'workflow-recipes',
    serviceSub: 'wrc-provisioner',
    credentialId: 'wrc-infra',
    resourceAuthority: 'wrc_managed',
    allowedTelemetryTypes: infraPrincipal.allowedTelemetryTypes,
  } as const satisfies InfrastructureTelemetrySubmitterPrincipalV1

  it.each([
    [
      'WRC lifecycle outside workflow runtime',
      AgentRunPrincipalBindingInvariantError,
      (h: Harness) =>
        new AgentRunEventService({ transaction: h.transaction }).append(
          wrcAgent,
          agentBinding,
          agentInput
        ),
    ],
    [
      'mcp-host namespace mismatch',
      AgentRunPrincipalBindingInvariantError,
      (h: Harness) =>
        new AgentRunEventService({ transaction: h.transaction }).append(
          agentPrincipal as McpHostRuntimeAgentRunPrincipalV1,
          { ...agentBinding, recipeNamespace: 'other' },
          agentInput
        ),
    ],
    [
      'mcp-host recipe mismatch',
      AgentRunPrincipalBindingInvariantError,
      (h: Harness) =>
        new AgentRunEventService({ transaction: h.transaction }).append(
          agentPrincipal as McpHostRuntimeAgentRunPrincipalV1,
          { ...agentBinding, recipeName: 'other' },
          agentInput
        ),
    ],
    [
      'mcp-host host mismatch',
      AgentRunPrincipalBindingInvariantError,
      (h: Harness) =>
        new AgentRunEventService({ transaction: h.transaction }).append(
          agentPrincipal as McpHostRuntimeAgentRunPrincipalV1,
          { ...agentBinding, hostRef: 'sandbox-recipes/other' },
          agentInput
        ),
    ],
    [
      'mcp-host host claim mismatch',
      AgentRunPrincipalBindingInvariantError,
      (h: Harness) =>
        new AgentRunEventService({ transaction: h.transaction }).append(
          {
            ...agentPrincipal,
            hostRefs: ['sandbox-recipes/other'],
          } as McpHostRuntimeAgentRunPrincipalV1,
          agentBinding,
          agentInput
        ),
    ],
    [
      'mcp-host workflow origin',
      AgentRunPrincipalBindingInvariantError,
      (h: Harness) =>
        new AgentRunEventService({ transaction: h.transaction }).append(
          agentPrincipal as McpHostRuntimeAgentRunPrincipalV1,
          { ...agentBinding, origin: 'workflow_runtime' },
          agentInput
        ),
    ],
    [
      'HCC service action',
      AdministrativePrincipalBindingInvariantError,
      (h: Harness) =>
        new AdministrativeEventService({ transaction: h.transaction }).append(
          hccAdmin,
          adminBinding,
          { ...adminInput, kind: 'service_action' }
        ),
    ],
    [
      'HCC outcome without operation',
      AdministrativePrincipalBindingInvariantError,
      (h: Harness) =>
        new AdministrativeEventService({ transaction: h.transaction }).append(
          hccAdmin,
          { ...adminBinding, operationId: null },
          adminInput
        ),
    ],
    [
      'WRC administrative intent',
      AdministrativePrincipalBindingInvariantError,
      (h: Harness) =>
        new AdministrativeEventService({ transaction: h.transaction }).append(
          adminPrincipal,
          adminBinding,
          { ...adminInput, kind: 'intent' }
        ),
    ],
    [
      'HCC WorkflowRecipe telemetry',
      InfrastructurePrincipalBindingInvariantError,
      (h: Harness) =>
        new InfrastructureTelemetryEventService({ transaction: h.transaction }).append(
          infraPrincipal,
          { ...infraBinding, kubernetesKind: 'WorkflowRecipe' },
          infraInput
        ),
    ],
    [
      'WRC Host telemetry',
      InfrastructurePrincipalBindingInvariantError,
      (h: Harness) =>
        new InfrastructureTelemetryEventService({ transaction: h.transaction }).append(
          wrcInfra,
          infraBinding,
          infraInput
        ),
    ],
  ])('rejects %s before transaction', async (_label, ErrorType, invoke) => {
    const h = harness()
    await expect(invoke(h)).rejects.toBeInstanceOf(ErrorType)
    expect(h.transactionSpy).not.toHaveBeenCalled()
  })

  it('accepts valid WRC bindings and derives HCC source identity from the principal', async () => {
    const agentHarness = harness()
    const adminHarness = harness()
    const hccHarness = harness()
    const infraHarness = harness()
    acceptedDb(agentHarness.query)
    acceptedDb(adminHarness.query)
    acceptedDb(hccHarness.query)
    acceptedDb(infraHarness.query)
    await new AgentRunEventService({ transaction: agentHarness.transaction }).append(
      wrcAgent,
      { ...agentBinding, origin: 'workflow_runtime' },
      agentInput
    )
    await new AdministrativeEventService({ transaction: adminHarness.transaction }).append(
      adminPrincipal,
      adminBinding,
      { ...adminInput, kind: 'service_action' }
    )
    await new AdministrativeEventService({ transaction: hccHarness.transaction }).append(
      hccAdmin,
      adminBinding,
      adminInput
    )
    expect(hccHarness.query.mock.calls[2][1]).toContain(hccAdmin.sourceService)
    expect(hccHarness.query.mock.calls[2][1]).toContain(hccAdmin.serviceSub)
    await new InfrastructureTelemetryEventService({ transaction: infraHarness.transaction }).append(
      wrcInfra,
      { ...infraBinding, kubernetesKind: 'WorkflowRecipe' },
      infraInput
    )
  })

  it('accepts typed lookup references without allowing top-level authority fields', async () => {
    const accepted = harness()
    acceptedDb(accepted.query)
    await expect(
      new InfrastructureTelemetryEventService({ transaction: accepted.transaction }).append(
        infraPrincipal,
        infraBinding,
        {
          ...infraInput,
          hostLookupReference: { name: 'chatllm', namespace: 'mcp-host', generation: 1 },
        }
      )
    ).resolves.toMatchObject({ kind: 'accepted' })

    const rejected = harness()
    await expect(
      new InfrastructureTelemetryEventService({ transaction: rejected.transaction }).append(
        infraPrincipal,
        infraBinding,
        { ...infraInput, namespace: 'mcp-host' } as typeof infraInput
      )
    ).rejects.toThrow('input.namespace')
    expect(rejected.transactionSpy).not.toHaveBeenCalled()
  })

  it('rejects invalid infrastructure interval timestamps before opening a transaction', async () => {
    const h = harness()
    await expect(
      new InfrastructureTelemetryEventService({ transaction: h.transaction }).append(
        infraPrincipal,
        infraBinding,
        {
          ...infraInput,
          telemetryType: 'capacity_sample',
          intervalStart: 'not-a-timestamp',
          intervalEnd: NOW,
        }
      )
    ).rejects.toThrow('intervalStart must be an ISO timestamp')
    expect(h.transactionSpy).not.toHaveBeenCalled()
  })
})
