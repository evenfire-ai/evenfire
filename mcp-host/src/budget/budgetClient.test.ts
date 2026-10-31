import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../queue/types'
import type { IncomingMessage } from '../server'
import { BudgetClient, deriveBudgetAttribution } from './budgetClient'
import type { BudgetCheckRequest } from './types'

function makeRequest(overrides: Partial<BudgetCheckRequest> = {}): BudgetCheckRequest {
  return {
    host_ref: 'trader',
    context_ref: 'trader-context',
    llm_secret_name: 'openai-key',
    provider: 'openai',
    model: 'gpt-4o',
    source_kind: 'desktop',
    user_id: 'user-1',
    team_id: null,
    recipe_name: null,
    cron_job_id: null,
    ...overrides,
  }
}

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    source: 'internal',
    priority: 'normal',
    status: 'pending',
    conversationHistory: [],
    createdAt: new Date(),
    ...overrides,
  } as Task
}

function mkMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    channelType: 'rpc',
    channelId: 'c1',
    sender: 'user-uuid',
    content: 'hi',
    ...overrides,
  } as IncomingMessage
}

describe('BudgetClient.check', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('posts to /internal/budgets/check with the bearer token and returns the parsed verdict', async () => {
    const verdict = {
      allowed: true,
      maxTaskTokens: 5000,
      maxTaskCost: 1.5,
      price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, currency: 'USD' },
    }
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => verdict,
    })
    const client = new BudgetClient({
      baseUrl: 'http://gw.local/',
      getAccessToken: () => 'tok-123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const req = makeRequest()
    const out = await client.check(req)

    expect(out).toEqual(verdict)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://gw.local/api/v1/internal/budgets/check')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer tok-123')
    expect(JSON.parse(init.body)).toEqual(req)
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('fails open and warns when the response is non-200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    const client = new BudgetClient({
      baseUrl: 'http://gw.local',
      getAccessToken: () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const out = await client.check(makeRequest())

    expect(out).toEqual({ allowed: true })
    expect(warnSpy).toHaveBeenCalledWith(
      '[BudgetClient] budget_check_failed',
      expect.objectContaining({ reason: 'non_200', status: 500 })
    )
  })

  it('on 401 refreshes and RETRIES once; a deny on the retry is honored (not fail-open)', async () => {
    // The bug: a 401 (token rotation) used to fail open, letting a task escape an
    // exceeded budget. Now it refreshes + retries with the fresh token, so a real
    // deny on the retry must be returned verbatim.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ allowed: false, reason: 'monthly_cost_exceeded' }),
      })
    const tokens = ['stale', 'fresh']
    let i = 0
    const refreshOnUnauthorized = vi.fn().mockResolvedValue(undefined)
    const client = new BudgetClient({
      baseUrl: 'http://gw.local',
      getAccessToken: () => tokens[Math.min(i++, tokens.length - 1)],
      refreshOnUnauthorized,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const out = await client.check(makeRequest())

    expect(out).toEqual({ allowed: false, reason: 'monthly_cost_exceeded' })
    expect(refreshOnUnauthorized).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // Retry carried the refreshed token.
    expect(
      (fetchImpl.mock.calls[1][1] as { headers: Record<string, string> }).headers.authorization
    ).toBe('Bearer fresh')
  })

  it('fails open only when the post-refresh retry ALSO fails (401 twice)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) })
    const refreshOnUnauthorized = vi.fn().mockResolvedValue(undefined)
    const client = new BudgetClient({
      baseUrl: 'http://gw.local',
      getAccessToken: () => 't',
      refreshOnUnauthorized,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const out = await client.check(makeRequest())

    expect(out).toEqual({ allowed: true })
    expect(refreshOnUnauthorized).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(warnSpy).toHaveBeenCalledWith(
      '[BudgetClient] budget_check_failed',
      expect.objectContaining({ reason: 'unauthorized', status: 401 })
    )
  })

  it('fails open and warns when fetch throws (network error / timeout abort)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('aborted'))
    const client = new BudgetClient({
      baseUrl: 'http://gw.local',
      getAccessToken: () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const out = await client.check(makeRequest())

    expect(out).toEqual({ allowed: true })
    expect(warnSpy).toHaveBeenCalledWith(
      '[BudgetClient] budget_check_failed',
      expect.objectContaining({ reason: 'fetch_error', error: 'aborted' })
    )
  })

  it('fails open when a 200 body is malformed (no allowed boolean)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ reason: 'oops' }),
    })
    const client = new BudgetClient({
      baseUrl: 'http://gw.local',
      getAccessToken: () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const out = await client.check(makeRequest())

    expect(out).toEqual({ allowed: true })
    expect(warnSpy).toHaveBeenCalledWith(
      '[BudgetClient] budget_check_failed',
      expect.objectContaining({ reason: 'malformed_response' })
    )
  })

  it('preserves the informational `unpriced` field on the verdict (does not narrow it away)', async () => {
    const verdict = {
      allowed: true,
      unpriced: [
        { provider: 'openai', model: 'gpt-4o' },
        { provider: 'anthropic', model: 'claude-3-5-sonnet' },
      ],
    }
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => verdict,
    })
    const client = new BudgetClient({
      baseUrl: 'http://gw.local',
      getAccessToken: () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const out = await client.check(makeRequest())
    expect(out).toEqual(verdict)
    expect(out.unpriced).toHaveLength(2)
  })

  it('returns a deny verdict verbatim when allowed=false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ allowed: false, reason: 'monthly_cost_exceeded' }),
    })
    const client = new BudgetClient({
      baseUrl: 'http://gw.local',
      getAccessToken: () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const out = await client.check(makeRequest())
    expect(out).toEqual({ allowed: false, reason: 'monthly_cost_exceeded' })
  })
})

describe('BudgetClient.release', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('posts to /internal/budgets/release with the bearer token and returns the parsed result', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ released: 2 }),
    })
    const client = new BudgetClient({
      baseUrl: 'http://gw.local/',
      getAccessToken: () => 'tok-123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const out = await client.release({ task_ref: 't1', host_ref: 'trader' })

    expect(out).toEqual({ released: 2 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://gw.local/api/v1/internal/budgets/release')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer tok-123')
    // host_ref MUST travel in the POST body (control-api binds/scopes the drop to it).
    expect(JSON.parse(init.body)).toEqual({ task_ref: 't1', host_ref: 'trader' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('fails open with {released:0} and warns when the response is non-200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    const client = new BudgetClient({
      baseUrl: 'http://gw.local',
      getAccessToken: () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const out = await client.release({ task_ref: 't1', host_ref: 'trader' })

    expect(out).toEqual({ released: 0 })
    expect(warnSpy).toHaveBeenCalledWith(
      '[BudgetClient] budget_release_failed',
      expect.objectContaining({ reason: 'non_200', status: 500, task_ref: 't1' })
    )
  })

  it('fails open and triggers a refresh on 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) })
    const refreshOnUnauthorized = vi.fn().mockResolvedValue(undefined)
    const client = new BudgetClient({
      baseUrl: 'http://gw.local',
      getAccessToken: () => 't',
      refreshOnUnauthorized,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const out = await client.release({ reservationId: 'r1', host_ref: 'trader' })

    expect(out).toEqual({ released: 0 })
    expect(refreshOnUnauthorized).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2) // retried once after refresh
    expect(warnSpy).toHaveBeenCalledWith(
      '[BudgetClient] budget_release_failed',
      expect.objectContaining({ reason: 'unauthorized', status: 401, reservationId: 'r1' })
    )
  })

  it('on 401 refreshes and RETRIES once; a released result on the retry is honored', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ released: 2 }) })
    const refreshOnUnauthorized = vi.fn().mockResolvedValue(undefined)
    const client = new BudgetClient({
      baseUrl: 'http://gw.local',
      getAccessToken: () => 't',
      refreshOnUnauthorized,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const out = await client.release({ task_ref: 't1', host_ref: 'trader' })

    expect(out).toEqual({ released: 2 })
    expect(refreshOnUnauthorized).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('fails open and warns when fetch throws (network error / timeout abort)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('aborted'))
    const client = new BudgetClient({
      baseUrl: 'http://gw.local',
      getAccessToken: () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const out = await client.release({ task_ref: 't1', host_ref: 'trader' })

    expect(out).toEqual({ released: 0 })
    expect(warnSpy).toHaveBeenCalledWith(
      '[BudgetClient] budget_release_failed',
      expect.objectContaining({ reason: 'fetch_error', error: 'aborted' })
    )
  })

  it('fails open when a 200 body is malformed (no released number)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })
    const client = new BudgetClient({
      baseUrl: 'http://gw.local',
      getAccessToken: () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const out = await client.release({ task_ref: 't1', host_ref: 'trader' })

    expect(out).toEqual({ released: 0 })
    expect(warnSpy).toHaveBeenCalledWith(
      '[BudgetClient] budget_release_failed',
      expect.objectContaining({ reason: 'malformed_response' })
    )
  })
})

describe('deriveBudgetAttribution', () => {
  it.each([
    ['direct', null],
    ['team', '33333333-3333-4333-8333-333333333333'],
  ] as const)(
    'uses the selected %s path and ignores spoofed legacy team metadata',
    (pathKind, effectiveTeamId) => {
      const task = mkTask({
        source: 'channel',
        sourceMessage: mkMessage({
          sender: 'spoofed-user',
          metadata: { teamId: 'spoofed-team' },
          authorityV2: {
            version: 2,
            userId: '11111111-1111-4111-8111-111111111111',
            sid: '22222222-2222-4222-8222-222222222222',
            sessionVersion: 4,
            delegationJti: '44444444-4444-4444-8444-444444444444',
            operationId: 'chat.message.invoke',
            resource: {
              environmentId: 'cluster.local/evenfire',
              type: 'host',
              canonicalId: 'host:mcp-host/chatllm',
              logicalId: 'mcp-host/chatllm',
              displayName: 'chatllm',
            },
            target: {
              hostRef: 'mcp-host/chatllm',
              channelType: 'rpc',
              channelId: 'chatllm',
              messageId: '55555555-5555-4555-8555-555555555555',
            },
            targetHash: `ath2_${'a'.repeat(43)}`,
            accessPathId: `ap1_${'b'.repeat(43)}`,
            authorizationRevision: `ar1_${'c'.repeat(43)}`,
            pathKind,
            effectiveTeamId,
            behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
          },
        }),
      })
      expect(deriveBudgetAttribution(task)).toMatchObject({
        source_kind: 'desktop',
        user_id: '11111111-1111-4111-8111-111111111111',
        team_id: effectiveTeamId,
      })
    }
  )

  it('maps a desktop (rpc) task to source_kind=desktop with user_id + team_id', () => {
    const task = mkTask({
      source: 'channel',
      sourceMessage: mkMessage({
        channelType: 'rpc',
        sender: 'user-uuid',
        metadata: { teamId: '  team-xyz  ' },
      }),
    })
    expect(deriveBudgetAttribution(task)).toEqual({
      source_kind: 'desktop',
      user_id: 'user-uuid',
      team_id: 'team-xyz',
      recipe_name: null,
      cron_job_id: null,
    })
  })

  it('maps a third-party channel task to source_kind=channel with no identity', () => {
    const task = mkTask({
      source: 'channel',
      sourceMessage: mkMessage({ channelType: 'telegram', sender: '12345' }),
    })
    expect(deriveBudgetAttribution(task)).toEqual({
      source_kind: 'channel',
      user_id: null,
      team_id: null,
      recipe_name: null,
      cron_job_id: null,
    })
  })

  it('maps a cron task to source_kind=cron with cron_job_id', () => {
    const task = mkTask({ source: 'cron', cronJobId: 'cron-7' })
    expect(deriveBudgetAttribution(task)).toEqual({
      source_kind: 'cron',
      user_id: null,
      team_id: null,
      recipe_name: null,
      cron_job_id: 'cron-7',
    })
  })

  it('maps an internal task to source_kind=desktop', () => {
    const task = mkTask({ source: 'internal' })
    expect(deriveBudgetAttribution(task).source_kind).toBe('desktop')
  })
})
