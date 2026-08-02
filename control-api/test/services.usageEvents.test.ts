import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ingestUsageEvents, validateUsageEvent } from '../src/services/usageEvents.js'

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}))

const VALID_EVENT = {
  request_id: '11111111-1111-4111-8111-111111111111',
  ts: '2026-04-29T10:00:00.000Z',
  run_id: null,
  host_ref: 'trader',
  context_ref: 'trader-context',
  team_id: '11111111-1111-4111-8111-111111111111',
  provider: 'openai',
  model: 'gpt-4o',
  llm_secret_name: 'openai-key',
  source_kind: 'desktop',
  user_id: '22222222-2222-4222-8222-222222222222',
  sender: null,
  channel_type: null,
  recipe_name: null,
  cron_job_id: null,
  task_id: 'task-1',
  iteration: 0,
  input_tokens: 120,
  output_tokens: 80,
  cache_read_tokens: 40,
  cache_write_tokens: 10,
  prompt_bridge_metadata: null,
}

describe('validateUsageEvent', () => {
  it('accepts a fully-populated valid event', () => {
    expect(validateUsageEvent(VALID_EVENT)).not.toBeNull()
  })

  it('rejects when request_id is not a UUID', () => {
    expect(validateUsageEvent({ ...VALID_EVENT, request_id: 'not-a-uuid' })).toBeNull()
  })

  it('rejects when ts is unparseable', () => {
    expect(validateUsageEvent({ ...VALID_EVENT, ts: 'never' })).toBeNull()
  })

  it('rejects when source_kind is not in the enum', () => {
    expect(validateUsageEvent({ ...VALID_EVENT, source_kind: 'sms' })).toBeNull()
  })

  it('rejects malformed team_id snapshots', () => {
    expect(validateUsageEvent({ ...VALID_EVENT, team_id: 'team-a' })).toBeNull()
  })

  it('accepts the control-plane admin usage team bucket', () => {
    expect(validateUsageEvent({ ...VALID_EVENT, team_id: 'control-plane-admin-ui' })).not.toBeNull()
  })

  it('accepts the control-plane admin usage actor key', () => {
    expect(
      validateUsageEvent({
        ...VALID_EVENT,
        user_id: 'admin-ui/11111111-1111-4111-8111-111111111111',
      })
    ).not.toBeNull()
  })

  it('rejects malformed user_id snapshots', () => {
    expect(validateUsageEvent({ ...VALID_EVENT, user_id: 'user-a' })).toBeNull()
  })

  it('requires canonical run id and secret snapshots for workflow usage', () => {
    const workflowEvent = {
      ...VALID_EVENT,
      source_kind: 'workflow',
      run_id: '00000000-0000-4000-8000-000000000001',
      host_ref: 'sandbox-recipes/e2e-recipe',
      context_ref: null,
      recipe_name: 'e2e-recipe',
      task_id: '00000000-0000-4000-8000-000000000001:e2e-recipe:2026-05-09T00:00:00.000Z',
    }
    expect(validateUsageEvent(workflowEvent)).not.toBeNull()
    expect(validateUsageEvent({ ...workflowEvent, run_id: null })).toBeNull()
    expect(
      validateUsageEvent({
        ...workflowEvent,
        run_id: '00000000-0000-4000-8000-000000000002',
      })
    ).toBeNull()
    expect(validateUsageEvent({ ...workflowEvent, task_id: 'e2e-recipe:now' })).toBeNull()
    expect(validateUsageEvent({ ...workflowEvent, llm_secret_name: null })).toBeNull()
  })

  it('rejects negative token counts', () => {
    expect(validateUsageEvent({ ...VALID_EVENT, input_tokens: -5 })).toBeNull()
  })

  it('rejects non-integer token counts', () => {
    expect(validateUsageEvent({ ...VALID_EVENT, output_tokens: 1.5 })).toBeNull()
  })

  it('coerces empty-string optionals to null', () => {
    const ev = validateUsageEvent({
      ...VALID_EVENT,
      sender: '   ',
      recipe_name: '',
    })
    expect(ev).not.toBeNull()
    expect(ev?.sender).toBeNull()
    expect(ev?.recipe_name).toBeNull()
  })

  it('rejects when host_ref is missing', () => {
    expect(validateUsageEvent({ ...VALID_EVENT, host_ref: '' })).toBeNull()
  })

  it('parses cache token counts when present', () => {
    const ev = validateUsageEvent(VALID_EVENT)
    expect(ev?.cache_read_tokens).toBe(40)
    expect(ev?.cache_write_tokens).toBe(10)
    expect(ev?.cache_tokens_reported).toBe(true)
  })

  it('distinguishes a reported cache zero from an omitted cache measurement', () => {
    const ev = validateUsageEvent({
      ...VALID_EVENT,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    })
    expect(ev?.cache_tokens_reported).toBe(true)
  })

  it('defaults cache token counts to 0 when absent', () => {
    const { cache_read_tokens, cache_write_tokens, ...withoutCache } = VALID_EVENT
    void cache_read_tokens
    void cache_write_tokens
    const ev = validateUsageEvent(withoutCache)
    expect(ev).not.toBeNull()
    expect(ev?.cache_read_tokens).toBe(0)
    expect(ev?.cache_write_tokens).toBe(0)
    expect(ev?.cache_tokens_reported).toBe(false)
  })

  it('rejects negative cache token counts', () => {
    expect(validateUsageEvent({ ...VALID_EVENT, cache_read_tokens: -1 })).toBeNull()
    expect(validateUsageEvent({ ...VALID_EVENT, cache_write_tokens: -1 })).toBeNull()
  })

  it('rejects non-integer cache token counts', () => {
    expect(validateUsageEvent({ ...VALID_EVENT, cache_read_tokens: 1.5 })).toBeNull()
    expect(validateUsageEvent({ ...VALID_EVENT, cache_write_tokens: 1.5 })).toBeNull()
  })

  it('accepts bounded promptBridge target attribution and rejects malformed metadata', () => {
    const ev = validateUsageEvent({
      ...VALID_EVENT,
      prompt_bridge_metadata: {
        target_ref: 'zai-primary',
        credential_slot: 'zai-api-key',
        fallback_used: true,
        attempt_count: 2,
      },
    })
    expect(ev?.prompt_bridge_metadata).toEqual({
      target_ref: 'zai-primary',
      credential_slot: 'zai-api-key',
      fallback_used: true,
      attempt_count: 2,
    })
    expect(
      validateUsageEvent({
        ...VALID_EVENT,
        prompt_bridge_metadata: { target_ref: 'zai-primary', fallback_used: true },
      })
    ).toBeNull()
  })
})

describe('ingestUsageEvents', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset()
  })

  it('returns zeros when given an empty batch and does not query the DB', async () => {
    const result = await ingestUsageEvents([])
    expect(result).toEqual({ accepted: 0, duplicates: 0, rejected: 0 })
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('counts schema-rejected events without sending them to the DB', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    const result = await ingestUsageEvents([
      { ...VALID_EVENT, request_id: 'bad-uuid' },
      { ...VALID_EVENT, source_kind: 'unknown-kind' },
    ])
    expect(result).toEqual({ accepted: 0, duplicates: 0, rejected: 2 })
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('counts inserted rows as accepted and the gap as duplicates', async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [
        { request_id: VALID_EVENT.request_id },
        { request_id: '22222222-2222-4222-8222-222222222222' },
      ],
      rowCount: 2,
    })
    const result = await ingestUsageEvents([
      VALID_EVENT,
      { ...VALID_EVENT, request_id: '22222222-2222-4222-8222-222222222222' },
      { ...VALID_EVENT, request_id: '33333333-3333-4333-8333-333333333333' },
    ])
    expect(result).toEqual({ accepted: 2, duplicates: 1, rejected: 0 })
  })

  it('emits a parameterized INSERT ... ON CONFLICT DO NOTHING', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ request_id: VALID_EVENT.request_id }], rowCount: 1 })
    await ingestUsageEvents([VALID_EVENT])
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO usage_events')
    expect(sql).toContain('ON CONFLICT (request_id) DO NOTHING')
    expect(sql).toContain('RETURNING request_id')
    expect(sql).toContain('cache_read_tokens')
    expect(sql).toContain('cache_write_tokens')
    expect(sql).toContain('cache_tokens_reported')
    expect(params).toContain(VALID_EVENT.request_id)
    expect(params).toContain(VALID_EVENT.run_id)
    expect(params).toContain(VALID_EVENT.host_ref)
    expect(params).toContain(VALID_EVENT.team_id)
    expect(params).toContain(VALID_EVENT.input_tokens)
    expect(params).toContain(VALID_EVENT.cache_read_tokens)
    expect(params).toContain(VALID_EVENT.cache_write_tokens)
    expect(params.at(-2)).toBe(true)
    expect(params.at(-1)).toBeNull()
    // 23 columns per event (single event => 23 bound params).
    expect(params).toHaveLength(23)
  })

  it('mixes valid + invalid + duplicate accounting in a single call', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ request_id: VALID_EVENT.request_id }], rowCount: 1 })
    const result = await ingestUsageEvents([
      VALID_EVENT,
      { ...VALID_EVENT, request_id: '22222222-2222-4222-8222-222222222222' },
      { ...VALID_EVENT, request_id: 'bad-uuid' },
      'not-an-object',
    ])
    expect(result).toEqual({ accepted: 1, duplicates: 1, rejected: 2 })
  })
})
