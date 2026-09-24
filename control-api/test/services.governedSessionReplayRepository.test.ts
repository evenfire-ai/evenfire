import { describe, expect, it, vi } from 'vitest'
import { PostgresGovernedEventReadRepository } from '../src/services/tracing/postgresGovernedEventReadRepository.js'
import { PostgresGovernedSessionReplayRepository } from '../src/services/tracing/postgresGovernedSessionReplayRepository.js'

describe('PostgresGovernedSessionReplayRepository security boundaries', () => {
  it('resolves a verified event user profile without an unsafe UUID cast or direct binding', async () => {
    const userId = '22222222-2222-4222-8222-222222222222'
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          host_ref: 'host-a',
          session_id: 'session-a',
          first_occurred_at: '2026-07-14T09:00:00.000Z',
          last_occurred_at: '2026-07-14T10:00:00.000Z',
          origins: ['workflow_runtime'],
          run_count: 1,
          event_count: 1,
          latest_run_outcome: 'started',
          agent_subjects: ['agent-a'],
          human_subjects: [userId],
          human_user_ids: [userId],
          identity_issuers: ['control-api'],
          human_display_name: 'Verified User',
          event_human_verified: true,
          tool_calls: 0,
          distinct_tools: 0,
          internal_tool_calls: 0,
          mcp_server_tool_calls: 0,
          workflow_tool_calls: 0,
          unclassified_tool_calls: 0,
          observed_llm_calls: 2,
          metered_token_calls: 2,
          cache_reported_calls: 1,
          input_tokens: '120',
          output_tokens: '30',
          cache_read_tokens: '20',
          cache_write_tokens: '0',
          approvals_requested: 0,
          approvals_approved: 0,
          approvals_denied: 0,
          prompt_count: 0,
        },
      ],
    })
    const result = await new PostgresGovernedSessionReplayRepository({ query } as never).list({
      filters: {
        occurredFrom: '2026-07-14T00:00:00.000Z',
        occurredTo: '2026-07-15T00:00:00.000Z',
        outcome: [],
        sourceService: [],
        sessionId: [],
        hostRef: [],
        humanUserId: [],
        agentSub: [],
        origin: [],
        toolName: [],
        approvalState: [],
      },
      highWatermark: '10',
      after: null,
      limit: 20,
      promptState: 'enabled',
      order: 'latest',
    })

    const sql = String(query.mock.calls[0]![0])
    expect(sql).toContain("WHEN a.user_id ~* '^[0-9a-f]{8}")
    expect(sql).toContain('THEN a.user_id::uuid')
    expect(sql).toContain('b.user_id')
    expect(result.summaries[0]?.human).toMatchObject({
      status: 'verified',
      userId,
      displayName: 'Verified User',
    })
    expect(result.summaries[0]?.tokenUsage).toEqual({
      observedLlmCalls: 2,
      meteredCalls: 2,
      coverage: 'complete',
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      cacheReporting: 'partial',
      totalTokens: 150,
    })
  })

  it('constructs interaction safe fields from a positive allowlist', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          stream_sequence: '7',
          event_id: '11111111-1111-4111-8111-111111111111',
          run_id: '22222222-2222-4222-8222-222222222222',
          event_type: 'tool_call',
          occurred_at: '2026-07-14T10:00:00.000Z',
          outcome: 'failed',
          tool_name: 'shell.exec',
          approval_request_id: null,
          decision: 'deny',
          decision_actor_sub: null,
          safe_fields: {
            reason_code: 'policy_denied',
            error_class: 'password=hunter2',
            status: 'failed',
            summary: 'FORBIDDEN_SUMMARY_SENTINEL',
            detail_ref: 'FORBIDDEN_DETAIL_SENTINEL',
            provider_ref: 'FORBIDDEN_PROVIDER_SENTINEL',
            attempt: 1,
            config_hash: 'a'.repeat(64),
          },
        },
      ],
    })
    const interactions = await new PostgresGovernedSessionReplayRepository({
      query,
    } as never).readInteractions({
      hostRef: 'host-a',
      sessionId: 'session-a',
      highWatermark: '10',
      after: '0',
      limit: 20,
    })
    const sql = String(query.mock.calls[0]![0])
    expect(sql).toContain('jsonb_build_object')
    expect(sql).not.toContain('payload_metadata - ARRAY')
    expect(sql).not.toContain("'parameters'")
    expect(sql).not.toContain("'output'")
    expect(sql).not.toContain("'prompt'")
    expect(sql).not.toContain("'summary'")
    expect(sql).not.toContain("'detail_ref'")
    expect(sql).not.toContain("'provider_ref'")
    expect(sql).toContain("'reason_code'")
    expect(sql).toContain("'error_class'")
    expect(interactions[0]?.safeFields).toEqual({
      reason_code: 'policy_denied',
      status: 'failed',
      attempt: 1,
      config_hash: 'a'.repeat(64),
    })
    expect(JSON.stringify(interactions)).not.toMatch(/FORBIDDEN_|hunter2/)
  })

  it('preserves per-call cache reporting availability in token evolution points', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          stream_sequence: '8',
          event_id: '11111111-1111-4111-8111-111111111111',
          run_id: '22222222-2222-4222-8222-222222222222',
          occurred_at: '2026-07-14T10:00:00.000Z',
          provider: 'openai',
          model: 'gpt-5',
          source_kind: 'desktop',
          iteration: '1',
          input_tokens: '10',
          output_tokens: '5',
          cache_read_tokens: '0',
          cache_write_tokens: '0',
          cache_tokens_reported: 'false',
        },
      ],
    })
    const result = await new PostgresGovernedSessionReplayRepository({
      query,
    } as never).readTokenUsagePoints('host-a', 'session-a', '10')

    expect(String(query.mock.calls[0]![0])).toContain("payload_metadata->>'cache_tokens_reported'")
    expect(result).toEqual({
      pointsTruncated: false,
      points: [
        expect.objectContaining({
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheTokensReported: false,
        }),
      ],
    })
  })

  it('matches denied approval candidates before aggregating the complete session', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          host_ref: 'host-a',
          session_id: 'outside-first-page',
          first_occurred_at: '2026-07-14T09:00:00.000Z',
          last_occurred_at: '2026-07-14T10:00:00.000Z',
          origins: ['direct_chat'],
          run_count: 2,
          event_count: 7,
          latest_run_outcome: 'succeeded',
          agent_subjects: ['agent-a'],
          human_subjects: [],
          human_user_ids: [],
          identity_issuers: [],
          human_display_name: null,
          event_human_verified: false,
          tool_calls: 2,
          distinct_tools: 2,
          approvals_requested: 2,
          approvals_approved: 1,
          approvals_denied: 1,
          prompt_count: 0,
        },
      ],
    })
    const repository = new PostgresGovernedSessionReplayRepository({ query } as never)
    const result = await repository.list({
      filters: {
        occurredFrom: '2026-07-14T00:00:00.000Z',
        occurredTo: '2026-07-15T00:00:00.000Z',
        outcome: [],
        sourceService: [],
        sessionId: [],
        hostRef: [],
        humanUserId: [],
        agentSub: [],
        origin: [],
        toolName: ['shell.exec'],
        approvalState: ['denied'],
      },
      highWatermark: '10',
      after: null,
      limit: 20,
      promptState: 'enabled',
      order: 'latest',
    })

    const sql = String(query.mock.calls[0]![0])
    expect(sql).toContain('WITH candidate_sessions AS MATERIALIZED')
    expect(sql).toContain('FROM candidate_sessions candidates')
    expect(sql).toContain("bool_or(a.payload_metadata->>'tool_name' = ANY")
    expect(sql).toContain("bool_or(a.event_type = 'approval'")
    expect(sql.indexOf("a.event_type = 'approval'")).toBeLessThan(sql.indexOf('), grouped AS'))
    expect(sql.match(/bool_or\(a\.event_type = 'approval'/g)).toHaveLength(1)
    expect(result.summaries[0]).toMatchObject({
      sessionId: 'outside-first-page',
      runCount: 2,
      eventCount: 7,
      tools: { totalCalls: 2, distinctTools: 2 },
      approvals: { requested: 2, approved: 1, denied: 1 },
    })
  })

  it('paginates both session orders deterministically across equal timestamps', async () => {
    const row = (hostRef: string, sessionId: string, occurredAt: string) => ({
      host_ref: hostRef,
      session_id: sessionId,
      first_occurred_at: occurredAt,
      last_occurred_at: occurredAt,
      origins: ['direct_chat'],
      run_count: 1,
      event_count: 1,
      latest_run_outcome: 'succeeded',
      agent_subjects: [],
      human_subjects: [],
      human_user_ids: [],
      identity_issuers: [],
      human_display_name: null,
      event_human_verified: false,
      tool_calls: 0,
      distinct_tools: 0,
      internal_tool_calls: 0,
      mcp_server_tool_calls: 0,
      workflow_tool_calls: 0,
      unclassified_tool_calls: 0,
      observed_llm_calls: 0,
      metered_token_calls: 0,
      cache_reported_calls: 0,
      input_tokens: '0',
      output_tokens: '0',
      cache_read_tokens: '0',
      cache_write_tokens: '0',
      approvals_requested: 0,
      approvals_approved: 0,
      approvals_denied: 0,
      prompt_count: 0,
    })
    const earlier = '2026-07-14T09:00:00.000Z'
    const later = '2026-07-14T10:00:00.000Z'
    const filters = {
      occurredFrom: '2026-07-14T00:00:00.000Z',
      occurredTo: '2026-07-15T00:00:00.000Z',
      outcome: [],
      sourceService: [],
      sessionId: [],
      hostRef: [],
      humanUserId: [],
      agentSub: [],
      origin: [],
      toolName: [],
      approvalState: [],
    }

    for (const scenario of [
      {
        order: 'latest' as const,
        pages: [
          [row('host-z', 'session-z', later), row('host-b', 'session-b', earlier)],
          [row('host-a', 'session-a', earlier)],
        ],
        expected: ['host-z/session-z', 'host-b/session-b', 'host-a/session-a'],
        operator: '<',
        direction: 'DESC',
      },
      {
        order: 'oldest' as const,
        pages: [
          [row('host-a', 'session-a', earlier), row('host-b', 'session-b', earlier)],
          [row('host-z', 'session-z', later)],
        ],
        expected: ['host-a/session-a', 'host-b/session-b', 'host-z/session-z'],
        operator: '>',
        direction: 'ASC',
      },
    ]) {
      const query = vi
        .fn()
        .mockResolvedValueOnce({ rows: scenario.pages[0] })
        .mockResolvedValueOnce({ rows: scenario.pages[1] })
      const repository = new PostgresGovernedSessionReplayRepository({ query } as never)
      const first = await repository.list({
        filters,
        highWatermark: '10',
        after: null,
        limit: 2,
        promptState: 'disabled',
        order: scenario.order,
      })
      const second = await repository.list({
        filters,
        highWatermark: '10',
        after: first.anchors.at(-1)!,
        limit: 2,
        promptState: 'disabled',
        order: scenario.order,
      })

      expect(
        [...first.summaries, ...second.summaries].map(item => `${item.hostRef}/${item.sessionId}`)
      ).toEqual(scenario.expected)
      const secondSql = String(query.mock.calls[1]![0])
      expect(secondSql).toContain(`(last_occurred_at, host_ref, session_id) ${scenario.operator}`)
      expect(secondSql).toContain(
        `ORDER BY last_occurred_at ${scenario.direction}, host_ref ${scenario.direction}, session_id ${scenario.direction}`
      )
    }
  })

  it('attributes observed execution only through the canonical approval id', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    await new PostgresGovernedSessionReplayRepository({ query } as never).readApprovals(
      'host-a',
      'session-a',
      '10',
      'enabled'
    )
    const sql = String(query.mock.calls[0]![0])
    expect(sql).toContain('tc.approval_request_id=a.approval_request_id')
    expect(sql).toContain('tcs.stream_sequence <= $3::bigint')
    expect(sql).not.toContain('tc.occurred_at >= a.occurred_at')
    const workflowSql = String(query.mock.calls[1]![0])
    expect(workflowSql).toContain('linked_run.approval_request_id=war.id')
    expect(workflowSql).toContain('war.bound_workflow_run_id=session_runs.run_id')
    expect(`${sql}\n${workflowSql}`).not.toMatch(/ciphertext|nonce/)
  })

  it('selects typed administrative and infrastructure list columns without prompt ciphertext', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    await new PostgresGovernedEventReadRepository({ query } as never).readAfter({
      scope: { kind: 'stream' },
      families: ['administrative', 'infrastructure_telemetry'],
      order: 'latest',
      afterSequence: '11',
      highWatermark: '10',
      limit: 20,
      occurredFrom: null,
      occurredTo: null,
      filters: {},
    })
    const sql = String(query.mock.calls[0]![0])
    expect(sql).toContain('admin.operator_user_id::text')
    expect(sql).toContain('telemetry.telemetry_type')
    expect(sql).not.toMatch(/ciphertext|nonce/)
  })
})
