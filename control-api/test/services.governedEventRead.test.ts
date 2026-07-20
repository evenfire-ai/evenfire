import { describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import type {
  GovernedEventReadRepositoryV1,
  GovernedEventReadRowV1,
} from '../src/services/tracing/contracts.js'
import {
  GovernedEventReadService,
  GovernedReadInvalidQueryError,
  GovernedReadScopeMismatchError,
} from '../src/services/tracing/governedEventReadService.js'
import { PostgresGovernedEventReadRepository } from '../src/services/tracing/postgresGovernedEventReadRepository.js'

const readDurationObserve = vi.hoisted(() => vi.fn())

vi.mock('../src/observability/metrics.js', () => ({
  governedTraceReadDurationSeconds: { observe: readDurationObserve },
}))

const ROW: GovernedEventReadRowV1 = {
  streamSequence: '5',
  eventFamily: 'agent_run',
  eventId: 'event-5',
  schemaVersion: 1,
  occurredAt: '2026-07-10T09:00:00.000Z',
  ingestedAt: '2026-07-10T09:00:01.000Z',
  correlationRef: 'run-1',
  sessionId: 'session-1',
  actorKind: 'human_via_agent',
  actorSub: 'user-1',
  serviceOrAgentSub: 'agent-1',
  initiatingHumanSub: 'user-1',
  actingAgentSub: 'agent-1',
  resourceAud: 'mcp://host-1',
  effectiveScopes: ['tools:read'],
  authorizationDecision: 'allow',
  tokenExchangeId: 'exchange-1',
  eventType: 'run_start',
  outcome: 'started',
  targetType: 'run',
  targetRef: 'run-1',
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'chatllm',
  hostRef: 'sandbox-recipes/chatllm',
  operatorUserId: null,
  operatorPrincipalId: null,
  operatorPrincipalKind: 'system',
  operatorDisplayName: null,
  delegatedActorSub: null,
  sourceKind: 'mcp_host_runtime',
  sourceService: 'mcp-host',
  serviceSub: 'mcp-host/standalone',
  targetUserId: null,
  targetUserSub: null,
  targetUserDisplayName: null,
  teamId: null,
  targetTeamDisplayName: null,
  telemetryType: null,
  reasonCode: null,
  clusterName: null,
  namespace: null,
  workloadKind: null,
  workloadRef: null,
  controller: null,
  payload: {
    summary: 'run started',
    rawPrompt: 'must-not-be-released',
    costUsd: 99,
  },
}

describe('PostgresGovernedEventReadRepository', () => {
  it('materializes a bounded stream page before joining the normalized view', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          stream_sequence: '5',
          event_family: 'agent_run',
          event_id: 'event-5',
          schema_version: 1,
          occurred_at: ROW.occurredAt,
          ingested_at: ROW.ingestedAt,
          correlation_ref: 'run-1',
          session_id: 'session-1',
          actor_kind: 'human_via_agent',
          actor_sub: 'user-1',
          service_or_agent_sub: 'agent-1',
          initiating_human_sub: 'user-1',
          acting_agent_sub: 'agent-1',
          resource_aud: 'mcp://host-1',
          effective_scopes: ['tools:read'],
          authorization_decision: 'allow',
          token_exchange_id: 'exchange-1',
          event_type: 'run_start',
          outcome: 'started',
          target_type: 'run',
          target_ref: 'run-1',
          recipe_namespace: 'sandbox-recipes',
          recipe_name: 'chatllm',
          host_ref: 'sandbox-recipes/chatllm',
          operator_user_id: null,
          operator_principal_id: null,
          operator_principal_kind: 'system',
          operator_display_name: null,
          team_id: null,
          target_team_display_name: null,
          payload: ROW.payload,
        },
      ],
      rowCount: 1,
    })
    const repository = new PostgresGovernedEventReadRepository({ query } as DbClient)

    const rows = await repository.readAfter({
      scope: {
        kind: 'workflow_run',
        runId: 'run-1',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'chatllm',
      },
      families: ['agent_run'],
      order: 'oldest',
      afterSequence: '0',
      highWatermark: '10',
      limit: 25,
      occurredFrom: null,
      occurredTo: null,
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sessionId: 'session-1',
      initiatingHumanSub: 'user-1',
      actingAgentSub: 'agent-1',
      resourceAud: 'mcp://host-1',
      effectiveScopes: ['tools:read'],
      authorizationDecision: 'allow',
      tokenExchangeId: 'exchange-1',
    })
    const [sql, params] = query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('WITH stream_page AS MATERIALIZED')
    expect(sql).toContain('LEFT JOIN teams target_team')
    expect(sql.indexOf('FROM governed_event_stream')).toBeLessThan(
      sql.indexOf('JOIN governed_event_read_v1')
    )
    expect(sql).toContain('s.run_id =')
    expect(sql).toContain('ORDER BY s.stream_sequence ASC')
    expect(sql).toContain('LIMIT')
    expect(sql).toContain('LEFT JOIN infrastructure_telemetry_events telemetry')
    expect(sql).toContain('LEFT JOIN control_admin_users operator_admin')
    expect(sql).toContain('agent.session_id')
    expect(sql).toContain("'ready_replicas', telemetry.ready_replicas")
    expect(sql).toContain("'cpu_usage_core_seconds', telemetry.cpu_usage_core_seconds")
    expect(params.at(-1)).toBe(25)
  })

  it('rejects repository limits above the hard page bound', async () => {
    const repository = new PostgresGovernedEventReadRepository({ query: vi.fn() } as DbClient)
    await expect(
      repository.readAfter({
        scope: { kind: 'stream' },
        families: ['agent_run'],
        order: 'oldest',
        afterSequence: '0',
        highWatermark: '10',
        limit: 201,
        occurredFrom: null,
        occurredTo: null,
      })
    ).rejects.toThrow('between 1 and 200')
  })

  it('uses a descending boundary for latest-first repository pages', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    const repository = new PostgresGovernedEventReadRepository({ query } as DbClient)

    await repository.readAfter({
      scope: { kind: 'stream' },
      families: ['infrastructure_telemetry'],
      order: 'latest',
      afterSequence: '11',
      highWatermark: '10',
      limit: 25,
      occurredFrom: null,
      occurredTo: null,
    })

    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toContain('s.stream_sequence < $1::bigint')
    expect(sql).toContain('ORDER BY s.stream_sequence DESC')
    expect(sql).not.toContain('s.stream_sequence > $1::bigint')
  })
})

describe('GovernedEventReadService', () => {
  it('captures one high watermark, applies family field policy, and emits an opaque cursor', async () => {
    const repository: GovernedEventReadRepositoryV1 = {
      captureHighWatermark: vi.fn().mockResolvedValue('10'),
      readAfter: vi.fn().mockResolvedValue([ROW]),
    }
    const service = new GovernedEventReadService(repository)

    const first = await service.read({ scope: { kind: 'stream' }, limit: 1 })

    expect(first.events[0].payload).toEqual({ summary: 'run started' })
    expect(first.nextCursor).toBeTruthy()
    expect(first.nextCursor).not.toContain('run-1')
    expect(first.capturedHighWatermark).toBe('10')

    await service.read({ scope: { kind: 'stream' }, limit: 1, cursor: first.nextCursor! })
    expect(repository.captureHighWatermark).toHaveBeenCalledTimes(1)
    expect(repository.readAfter).toHaveBeenLastCalledWith(
      expect.objectContaining({
        afterSequence: '5',
        highWatermark: '10',
        limit: 1,
        order: 'oldest',
      })
    )
    expect(readDurationObserve).toHaveBeenCalledWith({ family: 'mixed' }, expect.any(Number))
  })

  it('records one bounded family label when a read selects one family', async () => {
    const repository: GovernedEventReadRepositoryV1 = {
      captureHighWatermark: vi.fn().mockResolvedValue('10'),
      readAfter: vi.fn().mockResolvedValue([ROW]),
    }
    const service = new GovernedEventReadService(repository)

    await service.read({ scope: { kind: 'stream' }, families: ['agent_run'] })

    expect(readDurationObserve).toHaveBeenLastCalledWith(
      { family: 'agent_run' },
      expect.any(Number)
    )
  })

  it('reads newest pages backward from the captured high watermark', async () => {
    const repository: GovernedEventReadRepositoryV1 = {
      captureHighWatermark: vi.fn().mockResolvedValue('10'),
      readAfter: vi.fn().mockResolvedValue([
        { ...ROW, streamSequence: '10', eventId: 'event-10' },
        { ...ROW, streamSequence: '9', eventId: 'event-9' },
      ]),
    }
    const service = new GovernedEventReadService(repository)

    const page = await service.read({
      scope: { kind: 'stream' },
      families: ['infrastructure_telemetry'],
      order: 'latest',
      limit: 2,
    })

    expect(repository.readAfter).toHaveBeenCalledWith(
      expect.objectContaining({ afterSequence: '11', highWatermark: '10', order: 'latest' })
    )
    expect(page.events.map(event => event.streamSequence)).toEqual(['10', '9'])
    expect(page.nextCursor).toBeTruthy()
  })

  it('releases only the operator-safe infrastructure capacity evidence', async () => {
    const infrastructureRow: GovernedEventReadRowV1 = {
      ...ROW,
      eventFamily: 'infrastructure_telemetry',
      eventType: 'usage_sample',
      targetRef: 'control-plane/control-api',
      payload: {
        ready_replicas: 2,
        desired_replicas: 3,
        cpu_request_cores: 1,
        cpu_usage_core_seconds: 75,
        interval_start: '2026-07-10T09:00:00.000Z',
        interval_end: '2026-07-10T09:01:00.000Z',
        summary: 'capacity sample',
        raw_node_name: 'must-not-be-released',
      },
    }
    const repository: GovernedEventReadRepositoryV1 = {
      captureHighWatermark: vi.fn().mockResolvedValue('10'),
      readAfter: vi.fn().mockResolvedValue([infrastructureRow]),
    }
    const service = new GovernedEventReadService(repository)

    const page = await service.read({
      scope: { kind: 'stream' },
      families: ['infrastructure_telemetry'],
    })

    expect(page.events[0]?.payload).toEqual({
      ready_replicas: 2,
      desired_replicas: 3,
      cpu_request_cores: 1,
      cpu_usage_core_seconds: 75,
      interval_start: '2026-07-10T09:00:00.000Z',
      interval_end: '2026-07-10T09:01:00.000Z',
      summary: 'capacity sample',
    })
  })

  it('releases the safe permission classification needed by the administrative list', async () => {
    const administrativeRow: GovernedEventReadRowV1 = {
      ...ROW,
      eventFamily: 'administrative',
      eventType: 'permission_grant',
      targetType: 'permission',
      targetRef: 'agent:agent-1',
      payload: {
        resource_class: 'agent_access',
        status: 'granted',
        count: 1,
        raw_permission: 'must-not-be-released',
      },
    }
    const repository: GovernedEventReadRepositoryV1 = {
      captureHighWatermark: vi.fn().mockResolvedValue('10'),
      readAfter: vi.fn().mockResolvedValue([administrativeRow]),
    }
    const service = new GovernedEventReadService(repository)

    const page = await service.read({
      scope: { kind: 'stream' },
      families: ['administrative'],
    })

    expect(page.events[0]?.payload).toEqual({
      resource_class: 'agent_access',
      status: 'granted',
      count: 1,
    })
  })

  it('rejects invalid or query-mismatched cursors as typed bad requests', async () => {
    const repository: GovernedEventReadRepositoryV1 = {
      captureHighWatermark: vi.fn().mockResolvedValue('10'),
      readAfter: vi.fn().mockResolvedValue([ROW]),
    }
    const service = new GovernedEventReadService(repository)

    await expect(
      service.read({ scope: { kind: 'stream' }, cursor: 'not-base64-json' })
    ).rejects.toBeInstanceOf(GovernedReadInvalidQueryError)

    const first = await service.read({ scope: { kind: 'stream' }, limit: 1 })
    await expect(
      service.read({
        scope: { kind: 'stream' },
        families: ['agent_run'],
        cursor: first.nextCursor!,
      })
    ).rejects.toMatchObject({
      code: 'governed_read_invalid_query',
      status: 400,
      message: 'governed event cursor does not belong to this query',
    })
  })

  it('rejects a run-id lookup without workflow or host relationship scope', async () => {
    const repository: GovernedEventReadRepositoryV1 = {
      captureHighWatermark: vi.fn(),
      readAfter: vi.fn(),
    }
    const service = new GovernedEventReadService(repository)

    await expect(
      service.read({ scope: { kind: 'run_id', runId: 'run-1' } } as never)
    ).rejects.toThrow('runId cannot be queried without')
    expect(repository.captureHighWatermark).not.toHaveBeenCalled()
  })

  it('fails closed when hydrated workflow rows do not match the scoped recipe', async () => {
    const repository: GovernedEventReadRepositoryV1 = {
      captureHighWatermark: vi.fn().mockResolvedValue('10'),
      readAfter: vi.fn().mockResolvedValue([{ ...ROW, recipeName: 'other-recipe' }]),
    }
    const service = new GovernedEventReadService(repository)

    await expect(
      service.read({
        scope: {
          kind: 'workflow_run',
          runId: 'run-1',
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'chatllm',
        },
      })
    ).rejects.toBeInstanceOf(GovernedReadScopeMismatchError)
  })

  it('rejects pages above 200 and time windows above 31 days before repository access', async () => {
    const repository: GovernedEventReadRepositoryV1 = {
      captureHighWatermark: vi.fn(),
      readAfter: vi.fn(),
    }
    const service = new GovernedEventReadService(repository)

    await expect(service.read({ scope: { kind: 'stream' }, limit: 201 })).rejects.toThrow(
      'between 1 and 200'
    )
    await expect(
      service.read({
        scope: { kind: 'stream' },
        occurredFrom: '2026-01-01T00:00:00.000Z',
        occurredTo: '2026-03-01T00:00:00.000Z',
      })
    ).rejects.toThrow('at most 31 days')
    expect(repository.captureHighWatermark).not.toHaveBeenCalled()
  })
})
