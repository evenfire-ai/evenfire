import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import { projectAcceptedUsageEvents } from '../src/services/tracing/usageProjection.js'
import type { LlmUsageEvent } from '../src/services/usageEvents.js'
import type { WorkflowRunBinding } from '../src/services/workflowRunBindingRepository.js'

const RUN_ID = '00000000-0000-4000-8000-000000000001'
const REQUEST_ID = '11111111-1111-4111-8111-111111111111'

function usage(source_kind: LlmUsageEvent['source_kind'] = 'workflow'): LlmUsageEvent {
  return {
    request_id: REQUEST_ID,
    ts: '2026-07-11T10:00:00.000Z',
    run_id: RUN_ID,
    host_ref: 'sandbox-recipes/example',
    context_ref: 'excluded-context',
    team_id: '22222222-2222-4222-8222-222222222222',
    provider: 'openai',
    model: 'gpt-4o',
    llm_secret_name: 'excluded-config-ref',
    source_kind,
    user_id: null,
    sender: 'excluded-sender',
    channel_type: 'excluded-channel',
    recipe_name: source_kind === 'workflow' ? 'example' : null,
    cron_job_id: null,
    task_id: 'excluded-task',
    iteration: 2,
    input_tokens: 120,
    output_tokens: 80,
    cache_read_tokens: 40,
    cache_write_tokens: 10,
    cache_tokens_reported: true,
  }
}

const binding: WorkflowRunBinding = {
  runId: RUN_ID,
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'example',
  phase: 'Running',
  actorType: 'autonomous',
  actorId: null,
  teamId: null,
  usageTeamId: '22222222-2222-4222-8222-222222222222',
  startedAt: '2026-07-11T09:59:00.000Z',
  completedAt: null,
  approvalRequestId: null,
  durationMs: null,
}

const db = { query: vi.fn() } as unknown as DbClient

function directRoot(origin: 'direct_chat' | 'channel_event' | 'api' = 'direct_chat') {
  return {
    run_id: RUN_ID,
    root_session_id: 'session-root',
    root_span_id: 'root-span',
    root_origin: origin,
    root_actor_medium:
      origin === 'channel_event' ? 'channel' : origin === 'direct_chat' ? 'desktop' : 'api',
    root_identity_issuer: null,
    root_actor_human_sub: null,
    root_agent_sub: 'mcp-host:trader',
    root_team_id: null,
    root_user_id: null,
    root_recipe_namespace: 'mcp-host',
    root_recipe_name: 'standalone',
    root_host_ref: 'trader',
    binding_host_ref: null,
    binding_session_id: null,
    binding_origin: null,
    binding_identity_issuer: null,
    binding_actor_human_sub: null,
    binding_user_id: null,
    binding_team_id: null,
  }
}

function directAttributionRow(overrides: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID,
    root_session_id: null,
    root_span_id: null,
    root_origin: null,
    root_actor_medium: null,
    root_identity_issuer: null,
    root_actor_human_sub: null,
    root_agent_sub: null,
    root_team_id: null,
    root_user_id: null,
    root_recipe_namespace: null,
    root_recipe_name: null,
    root_host_ref: null,
    binding_host_ref: 'trader',
    binding_session_id: 'desktop-session',
    binding_origin: 'direct_chat',
    binding_identity_issuer: 'https://issuer.example.test',
    binding_actor_human_sub: '44444444-4444-4444-8444-444444444444',
    binding_user_id: '44444444-4444-4444-8444-444444444444',
    binding_team_id: '55555555-5555-4555-8555-555555555555',
    ...overrides,
  }
}

describe('projectAcceptedUsageEvents', () => {
  beforeEach(() => {
    vi.mocked(db.query).mockReset()
  })
  it('projects one stored-bound workflow usage event with an exact safe payload', async () => {
    const appendBatch = vi.fn().mockResolvedValue([])
    const projected = await projectAcceptedUsageEvents(
      db,
      [usage()],
      new Map([[RUN_ID, binding]]),
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'example',
        hostRef: 'sandbox-recipes/example',
        environment: 'test',
      },
      {
        appendBatch,
        now: () => new Date('2026-07-11T10:00:01.000Z'),
        newEventId: () => '33333333-3333-4333-8333-333333333333',
      }
    )

    expect(projected).toBe(1)
    expect(appendBatch).toHaveBeenCalledOnce()
    const pending = appendBatch.mock.calls[0]?.[1][0]
    expect(pending).toMatchObject({
      family: 'agent_run',
      sourceService: 'mcp-host',
      sourceKind: 'mcp_host_runtime',
      sourceEventId: REQUEST_ID,
      stream: { runId: RUN_ID, teamId: binding.usageTeamId },
    })
    const payloadColumn = pending.familyColumns.find(
      (column: { name: string }) => column.name === 'payload_metadata'
    )
    expect(JSON.parse(payloadColumn.value)).toEqual({
      request_ref: expect.stringMatching(/^[0-9a-f]{64}$/),
      provider: 'openai',
      model: 'gpt-4o',
      source_kind: 'workflow',
      input_tokens: 120,
      output_tokens: 80,
      cache_read_tokens: 40,
      cache_write_tokens: 10,
      cache_tokens_reported: true,
      iteration: 2,
    })
    const serialized = JSON.stringify(pending)
    for (const excluded of [
      'excluded-sender',
      'excluded-channel',
      'excluded-task',
      'excluded-context',
      'excluded-config-ref',
    ]) {
      expect(serialized).not.toContain(excluded)
    }
  })

  it('projects accepted desktop usage with submitter context and exact safe payload', async () => {
    const appendBatch = vi.fn()
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [directRoot()], rowCount: 1 })
    const projected = await projectAcceptedUsageEvents(
      db,
      [usage('desktop')],
      new Map(),
      {
        recipeNamespace: 'mcp-host',
        recipeName: 'standalone',
        hostRef: 'trader',
        environment: 'test',
      },
      {
        appendBatch,
        now: () => new Date('2026-07-11T10:00:01.000Z'),
        newEventId: () => '33333333-3333-4333-8333-333333333333',
      }
    )

    expect(projected).toBe(1)
    expect(appendBatch).toHaveBeenCalledOnce()
    const pending = appendBatch.mock.calls[0]?.[1][0]
    expect(pending).toMatchObject({
      family: 'agent_run',
      sourceService: 'mcp-host',
      sourceKind: 'mcp_host_runtime',
      sourceEventId: REQUEST_ID,
      stream: { runId: RUN_ID, teamId: null },
    })
    expect(
      pending.familyColumns.find((column: { name: string }) => column.name === 'origin')?.value
    ).toBe('direct_chat')
    expect(
      pending.familyColumns.find((column: { name: string }) => column.name === 'host_ref')?.value
    ).toBe('trader')
    const payloadColumn = pending.familyColumns.find(
      (column: { name: string }) => column.name === 'payload_metadata'
    )
    expect(JSON.parse(payloadColumn.value)).toEqual({
      request_ref: expect.stringMatching(/^[0-9a-f]{64}$/),
      provider: 'openai',
      model: 'gpt-4o',
      source_kind: 'desktop',
      input_tokens: 120,
      output_tokens: 80,
      cache_read_tokens: 40,
      cache_write_tokens: 10,
      cache_tokens_reported: true,
      iteration: 2,
    })
    const serialized = JSON.stringify(pending)
    for (const excluded of [
      'excluded-sender',
      'excluded-channel',
      'excluded-task',
      'excluded-context',
      'excluded-config-ref',
    ]) {
      expect(serialized).not.toContain(excluded)
    }
  })

  it('skips accepted non-workflow usage without a run id', async () => {
    const appendBatch = vi.fn()
    const event = usage('channel')
    event.run_id = null
    const projected = await projectAcceptedUsageEvents(
      db,
      [event],
      new Map(),
      {
        recipeNamespace: 'mcp-host',
        recipeName: 'standalone',
        hostRef: 'trader',
      },
      { appendBatch }
    )

    expect(projected).toBe(0)
    expect(appendBatch).not.toHaveBeenCalled()
  })

  it('does not project non-workflow identity without a persisted run root', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const appendBatch = vi.fn()
    const projected = await projectAcceptedUsageEvents(
      db,
      [{ ...usage('desktop'), team_id: '99999999-9999-4999-8999-999999999999' }],
      new Map(),
      { recipeNamespace: 'mcp-host', recipeName: 'standalone', hostRef: 'trader' },
      { appendBatch }
    )
    expect(projected).toBe(0)
    expect(appendBatch).not.toHaveBeenCalled()
  })

  it('projects direct usage from the immutable attribution binding before run_start arrives', async () => {
    const appendBatch = vi.fn().mockResolvedValue([])
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [directAttributionRow()], rowCount: 1 })

    const projected = await projectAcceptedUsageEvents(
      db,
      [usage('desktop')],
      new Map(),
      { recipeNamespace: 'mcp-host', recipeName: 'standalone', hostRef: 'trader' },
      {
        appendBatch,
        now: () => new Date('2026-07-11T10:00:01.000Z'),
        newEventId: () => '33333333-3333-4333-8333-333333333333',
      }
    )

    expect(projected).toBe(1)
    expect(vi.mocked(db.query).mock.calls[0]?.[0]).toContain(
      'LEFT JOIN governed_run_attribution_bindings'
    )
    const pending = appendBatch.mock.calls[0]?.[1][0]
    const columns = new Map(
      pending.familyColumns.map((column: { name: string; value: unknown }) => [
        column.name,
        column.value,
      ])
    )
    expect(columns.get('session_id')).toBe('desktop-session')
    expect(columns.get('identity_issuer')).toBe('https://issuer.example.test')
    expect(columns.get('actor_human_sub')).toBe('44444444-4444-4444-8444-444444444444')
    expect(columns.get('user_id')).toBe('44444444-4444-4444-8444-444444444444')
    expect(columns.get('team_id')).toBe('55555555-5555-4555-8555-555555555555')
    expect(columns.get('parent_span_id')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('enriches a matching run_start from the immutable direct attribution binding', async () => {
    const appendBatch = vi.fn().mockResolvedValue([])
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        directAttributionRow({
          ...directRoot(),
          binding_host_ref: 'trader',
          binding_session_id: 'session-root',
          binding_origin: 'direct_chat',
          binding_identity_issuer: 'https://issuer.example.test',
          binding_actor_human_sub: '44444444-4444-4444-8444-444444444444',
          binding_user_id: '44444444-4444-4444-8444-444444444444',
          binding_team_id: '55555555-5555-4555-8555-555555555555',
        }),
      ],
      rowCount: 1,
    })

    await projectAcceptedUsageEvents(
      db,
      [usage('desktop')],
      new Map(),
      { recipeNamespace: 'mcp-host', recipeName: 'standalone', hostRef: 'trader' },
      { appendBatch }
    )

    const columns = new Map(
      appendBatch.mock.calls[0]?.[1][0].familyColumns.map(
        (column: { name: string; value: unknown }) => [column.name, column.value]
      )
    )
    expect(columns.get('identity_issuer')).toBe('https://issuer.example.test')
    expect(columns.get('actor_human_sub')).toBe('44444444-4444-4444-8444-444444444444')
  })

  it('rejects contradictory run_start and immutable attribution facts', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        directAttributionRow({
          ...directRoot(),
          binding_host_ref: 'trader',
          binding_session_id: 'different-session',
          binding_origin: 'direct_chat',
          binding_identity_issuer: 'https://issuer.example.test',
          binding_actor_human_sub: '44444444-4444-4444-8444-444444444444',
          binding_user_id: '44444444-4444-4444-8444-444444444444',
          binding_team_id: '55555555-5555-4555-8555-555555555555',
        }),
      ],
      rowCount: 1,
    })

    await expect(
      projectAcceptedUsageEvents(
        db,
        [usage('desktop')],
        new Map(),
        { recipeNamespace: 'mcp-host', recipeName: 'standalone', hostRef: 'trader' },
        { appendBatch: vi.fn() }
      )
    ).rejects.toMatchObject({ status: 409, code: 'direct_run_binding_conflict' })
  })

  it('derives non-workflow origin and actor from the persisted run root', async () => {
    const appendBatch = vi.fn()
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [directRoot('channel_event')],
      rowCount: 1,
    })
    const events = [
      { event: usage('channel'), requestId: '11111111-1111-4111-8111-111111111112' },
      { event: usage('cron'), requestId: '11111111-1111-4111-8111-111111111113' },
      { event: usage('unknown'), requestId: '11111111-1111-4111-8111-111111111114' },
    ]
    for (const item of events) item.event.request_id = item.requestId

    const projected = await projectAcceptedUsageEvents(
      db,
      events.map(item => item.event),
      new Map(),
      {
        recipeNamespace: 'mcp-host',
        recipeName: 'standalone',
        hostRef: 'trader',
      },
      {
        appendBatch,
        now: () => new Date('2026-07-11T10:00:01.000Z'),
        newEventId: () => '33333333-3333-4333-8333-333333333333',
      }
    )

    expect(projected).toBe(3)
    const pending = appendBatch.mock.calls[0]?.[1]
    const columnsBySource = new Map(
      pending.map(
        (event: {
          sourceEventId: string
          familyColumns: Array<{ name: string; value: unknown }>
        }) => [event.sourceEventId, event.familyColumns]
      )
    )
    expect(
      columnsBySource.get(events[0].requestId)?.find(column => column.name === 'origin')?.value
    ).toBe('channel_event')
    expect(
      columnsBySource.get(events[0].requestId)?.find(column => column.name === 'actor_medium')
        ?.value
    ).toBe('channel')
    expect(
      columnsBySource.get(events[1].requestId)?.find(column => column.name === 'origin')?.value
    ).toBe('channel_event')
    expect(
      columnsBySource.get(events[1].requestId)?.find(column => column.name === 'actor_medium')
        ?.value
    ).toBe('channel')
    expect(
      columnsBySource.get(events[2].requestId)?.find(column => column.name === 'origin')?.value
    ).toBe('channel_event')
    expect(
      columnsBySource.get(events[2].requestId)?.find(column => column.name === 'actor_medium')
        ?.value
    ).toBe('channel')
  })

  it('fails closed when accepted workflow usage lacks its stored run binding', async () => {
    await expect(
      projectAcceptedUsageEvents(
        db,
        [usage()],
        new Map(),
        {
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'example',
          hostRef: 'sandbox-recipes/example',
        },
        { appendBatch: vi.fn() }
      )
    ).rejects.toThrow('has no trusted run binding')
  })
})
