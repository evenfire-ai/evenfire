import { describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import type { AgentRunEventSubmitterPrincipalV1 } from '../src/middleware/tracingSubmitterAuth.js'
import type { WorkflowAgentRunEventInputV1 } from '../src/services/tracing/contracts.js'
import {
  HostReferencedRunBindingResolver,
  WorkflowRunBindingResolver,
} from '../src/services/tracing/workflowRunBindingResolver.js'

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const TEAM_ID = '33333333-3333-4333-8333-333333333333'
const APPROVAL_ID = '44444444-4444-4444-8444-444444444444'

const principal: AgentRunEventSubmitterPrincipalV1 = {
  kind: 'wrc_internal_control',
  sourceService: 'workflow-recipes',
  serviceSub: 'wrc-provisioner',
  credentialId: 'test-principal',
  allowedEventTypes: ['run_start', 'run_end'],
}

function event(eventType: 'run_start' | 'run_end', runId = RUN_ID): WorkflowAgentRunEventInputV1 {
  return {
    eventType,
    runId,
    sourceEventId: `${eventType}-source`,
    occurredAt: '2026-07-11T10:00:00.000Z',
  }
}

function liveRow(overrides: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID,
    recipe_namespace: 'sandbox-recipes',
    recipe_name: 'daily-report',
    phase: 'Running',
    actor_type: 'user',
    actor_id: USER_ID,
    team_id: TEAM_ID,
    usage_team_id: 'usage-team',
    started_at: '2026-07-11T09:59:00.000Z',
    completed_at: null,
    approval_request_id: null,
    duration_ms: null,
    ...overrides,
  }
}

function resolverWith(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length })
  return {
    query,
    resolver: new WorkflowRunBindingResolver({ query } as DbClient, 'test'),
  }
}

describe('WorkflowRunBindingResolver', () => {
  it('loads a live run with parameterized SQL and derives the root binding', async () => {
    const { query, resolver } = resolverWith([liveRow()])

    const binding = await resolver.resolve(principal, event('run_start'))

    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]![0]).toContain('FROM workflow_runs wr')
    expect(query.mock.calls[0]![0]).toContain('FROM workflow_runs_audit wra')
    expect(query.mock.calls[0]![0]).toContain('$1::uuid')
    expect(query.mock.calls[0]![1]).toEqual([[RUN_ID]])
    expect(binding).toMatchObject({
      runId: RUN_ID,
      origin: 'workflow_runtime',
      parentSpanId: null,
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'daily-report',
      actorHumanSub: USER_ID,
      userId: USER_ID,
      teamId: 'usage-team',
      outcome: 'started',
      environment: 'test',
    })
    expect(binding?.spanId).toMatch(/^[0-9a-f]{64}$/)
  })

  it('loads an archived terminal run and links run_end to the deterministic root', async () => {
    const { resolver } = resolverWith([
      liveRow({
        phase: 'Failed',
        actor_type: 'admin',
        completed_at: '2026-07-11T10:00:00.000Z',
        duration_ms: '60000',
      }),
    ])

    const end = await resolver.resolve(principal, event('run_end'))
    const start = await resolverWith([liveRow()]).resolver.resolve(principal, event('run_start'))

    expect(end).toMatchObject({
      origin: 'workflow_runtime',
      outcome: 'failed',
      durationMs: 60000,
      actorHumanSub: USER_ID,
    })
    expect(end?.parentSpanId).toBe(start?.spanId)
    expect(end?.spanId).not.toBe(end?.parentSpanId)
  })

  it('resolves one and one hundred workflow events with one database query', async () => {
    for (const count of [1, 100]) {
      const { query, resolver } = resolverWith([liveRow()])
      const events = Array.from({ length: count }, (_, index) =>
        event(
          'run_start',
          index === 0 ? RUN_ID : `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
        )
      )

      const bindings = await resolver.resolveMany(principal, events)

      expect(query).toHaveBeenCalledOnce()
      expect(bindings).toHaveLength(count)
    }
  })

  it.each([
    ['invalid UUID', event('run_start', 'not-a-uuid'), []],
    ['missing row', event('run_start'), []],
    ['mismatched row id', event('run_start'), [liveRow({ run_id: USER_ID })]],
    [
      'start before admission',
      event('run_start'),
      [liveRow({ phase: 'Pending', started_at: null })],
    ],
    ['end before terminal phase', event('run_end'), [liveRow()]],
  ])('fails closed for %s', async (_label, input, rows) => {
    const { query, resolver } = resolverWith(rows)
    await expect(resolver.resolve(principal, input)).resolves.toBeNull()
    if (input.runId === 'not-a-uuid') expect(query).not.toHaveBeenCalled()
  })

  it('rejects a non-WRC principal without querying the database', async () => {
    const { query, resolver } = resolverWith([liveRow()])
    const nonWrc = {
      ...principal,
      kind: 'mcp_host_runtime',
    } as unknown as AgentRunEventSubmitterPrincipalV1

    await expect(resolver.resolve(nonWrc, event('run_start'))).resolves.toBeNull()
    expect(query).not.toHaveBeenCalled()
  })
})

describe('HostReferencedRunBindingResolver', () => {
  const runtimePrincipal = {
    kind: 'mcp_host_runtime',
    sourceService: 'mcp-host',
    serviceSub: 'mcp-host/standalone',
    credentialId: 'runtime-1',
    hostRefs: ['chatllm-stateless'],
    recipeNamespace: 'mcp-host',
    recipeName: 'standalone',
    allowedEventTypes: ['run_start', 'llm_call', 'tool_call', 'approval', 'token_usage', 'run_end'],
  } as const

  it('derives Host and span authority for a run root and timestamped LLM occurrence', async () => {
    const getResource = vi.fn().mockResolvedValue({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'Host',
      metadata: { name: 'chatllm-stateless', namespace: 'mcp-host' },
    })
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const bindings = await new HostReferencedRunBindingResolver(
      { getResource },
      { query },
      'test'
    ).resolveMany(runtimePrincipal, [
      {
        ...event('run_start'),
        sourceEventId: 'task:task-1:start',
        hostRef: 'chatllm-stateless',
        origin: 'direct_chat',
        sessionId: 's-1',
      },
      {
        ...event('llm_call'),
        sourceEventId: 'task:task-1:llm:1784041199000-0',
        hostRef: 'chatllm-stateless',
        origin: 'direct_chat',
        sessionId: 's-1',
      },
    ])
    expect(bindings[0]).toMatchObject({
      runId: RUN_ID,
      hostRef: 'chatllm-stateless',
      origin: 'direct_chat',
      agentSub: 'mcp-host:chatllm-stateless',
      actorHumanSub: null,
      sessionId: 's-1',
      outcome: 'started',
      parentSpanId: null,
    })
    expect(bindings[1]).toMatchObject({
      runId: RUN_ID,
      hostRef: 'chatllm-stateless',
      outcome: 'succeeded',
    })
    expect(getResource).toHaveBeenCalledWith('hosts', 'chatllm-stateless', 'mcp-host')
  })

  it('rejects a foreign Host reference before reading Kubernetes', async () => {
    const getResource = vi.fn()
    const query = vi.fn()
    await expect(
      new HostReferencedRunBindingResolver({ getResource }, { query }).resolve(runtimePrincipal, {
        ...event('run_start'),
        sourceEventId: 'task:task-1:start',
        hostRef: 'mcp-host/other',
        origin: 'api',
      })
    ).resolves.toBeNull()
    expect(getResource).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it('labels direct approval outcomes as authenticated legacy-gate decisions', async () => {
    const getResource = vi.fn().mockResolvedValue({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'Host',
      metadata: { name: 'chatllm-stateless', namespace: 'mcp-host' },
    })
    const query = vi.fn().mockImplementation((sql: string) =>
      Promise.resolve({
        rows: sql.includes('governed_run_attribution_bindings')
          ? [
              {
                run_id: RUN_ID,
                host_ref: 'chatllm-stateless',
                session_id: 's-1',
                origin: 'direct_chat',
                identity_issuer: 'https://issuer.example.test',
                actor_human_sub: 'human-subject',
                user_id: USER_ID,
                team_id: TEAM_ID,
              },
            ]
          : [
              {
                source_event_id: 'task:task-1:start',
                run_id: RUN_ID,
                host_ref: 'chatllm-stateless',
                origin: 'direct_chat',
                session_id: 's-1',
              },
            ],
      })
    )

    const binding = await new HostReferencedRunBindingResolver(
      { getResource },
      { query },
      'test'
    ).resolve(runtimePrincipal, {
      eventType: 'approval',
      runId: RUN_ID,
      approvalRequestId: APPROVAL_ID,
      sourceEventId: `task:task-1:approval:${APPROVAL_ID}:approved`,
      occurredAt: '2026-07-11T10:01:00.000Z',
      hostRef: 'chatllm-stateless',
      origin: 'direct_chat',
      sessionId: 's-1',
      payload: { status: 'approved' },
    })

    expect(binding).toMatchObject({
      outcome: 'approved',
      decision: 'allow',
      decisionSourceKind: 'legacy_gate',
      decisionSourceRef: `task:task-1:approval:${APPROVAL_ID}:approved`,
      decisionActorSub: 'human-subject',
    })
  })

  it('uses the immutable binding for identity and preserves canonical tool approval correlation', async () => {
    const getResource = vi.fn().mockResolvedValue({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'Host',
      metadata: { name: 'chatllm-stateless', namespace: 'mcp-host' },
    })
    const query = vi.fn().mockImplementation((sql: string) =>
      Promise.resolve({
        rows: sql.includes('governed_run_attribution_bindings')
          ? [
              {
                run_id: RUN_ID,
                host_ref: 'chatllm-stateless',
                session_id: 's-1',
                origin: 'direct_chat',
                identity_issuer: 'https://issuer.example.test',
                actor_human_sub: 'human-subject',
                user_id: USER_ID,
                team_id: TEAM_ID,
              },
            ]
          : [
              {
                source_event_id: 'task:task-1:start',
                run_id: RUN_ID,
                host_ref: 'chatllm-stateless',
                origin: 'direct_chat',
                session_id: 's-1',
              },
            ],
      })
    )

    const binding = await new HostReferencedRunBindingResolver(
      { getResource },
      { query },
      'test'
    ).resolve(runtimePrincipal, {
      eventType: 'tool_call',
      runId: RUN_ID,
      approvalRequestId: APPROVAL_ID,
      sourceEventId: 'task:task-1:tool:tc-approved',
      occurredAt: '2026-07-11T10:02:00.000Z',
      hostRef: 'chatllm-stateless',
      origin: 'direct_chat',
      sessionId: 's-1',
      payload: { status: 'succeeded', tool_name: 'shell_exec' },
    })

    expect(binding).toMatchObject({
      identityIssuer: 'https://issuer.example.test',
      actorHumanSub: 'human-subject',
      userId: USER_ID,
      teamId: TEAM_ID,
      approvalRequestId: APPROVAL_ID,
    })
  })

  it('rejects an event whose host/session/origin contradicts the immutable binding', async () => {
    const getResource = vi.fn().mockResolvedValue({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'Host',
      metadata: { name: 'chatllm-stateless', namespace: 'mcp-host' },
    })
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          run_id: RUN_ID,
          host_ref: 'chatllm-stateless',
          session_id: 'different-session',
          origin: 'direct_chat',
          identity_issuer: 'https://issuer.example.test',
          actor_human_sub: 'human-subject',
          user_id: USER_ID,
          team_id: TEAM_ID,
        },
      ],
    })

    await expect(
      new HostReferencedRunBindingResolver({ getResource }, { query }, 'test').resolve(
        runtimePrincipal,
        {
          ...event('run_start'),
          sourceEventId: 'task:task-1:start',
          hostRef: 'chatllm-stateless',
          origin: 'direct_chat',
          sessionId: 's-1',
        }
      )
    ).resolves.toBeNull()
  })

  it('rejects direct approval evidence whose source occurrence contradicts its payload', async () => {
    const getResource = vi.fn().mockResolvedValue({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'Host',
      metadata: { name: 'chatllm-stateless', namespace: 'mcp-host' },
    })
    const query = vi.fn().mockImplementation((sql: string) =>
      Promise.resolve({
        rows: sql.includes('governed_run_attribution_bindings')
          ? []
          : [
              {
                source_event_id: 'task:task-1:start',
                run_id: RUN_ID,
                host_ref: 'chatllm-stateless',
                origin: 'direct_chat',
                session_id: 's-1',
              },
            ],
      })
    )

    await expect(
      new HostReferencedRunBindingResolver({ getResource }, { query }, 'test').resolve(
        runtimePrincipal,
        {
          eventType: 'approval',
          runId: RUN_ID,
          approvalRequestId: APPROVAL_ID,
          sourceEventId: `task:task-1:approval:${APPROVAL_ID}:denied`,
          occurredAt: '2026-07-11T10:01:00.000Z',
          hostRef: 'chatllm-stateless',
          origin: 'direct_chat',
          sessionId: 's-1',
          payload: { status: 'approved' },
        }
      )
    ).resolves.toBeNull()
  })
})
