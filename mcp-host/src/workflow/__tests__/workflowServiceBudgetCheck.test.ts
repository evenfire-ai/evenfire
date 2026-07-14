import { afterEach, describe, expect, it, vi } from 'vitest'
import { BudgetClient } from '../../budget/budgetClient'
import type { BudgetCheckRequest } from '../../budget/types'
import { config as appConfig } from '../../config'
import { LlmErrorCode } from '../../core/errors'
import type { SingleTurnProvider } from '../../llm'
import type { McpClientConnection, McpClientFactory } from '../stepRouter'
import type { McpHostRuntimeAuth } from '../userApprovalRequester'
import { WorkflowService } from '../workflowService'

// Canonical workflow run id (UUID prefix) so usage-reporting validation passes
// when a UsageReporter is wired; budget tests below omit the reporter, so this
// is only used to populate task_ref / attribution.
const workflowExecutionId =
  '11111111-1111-4111-8111-111111111111:my-recipe:2026-05-09T00:00:00.000Z'
const workflowTeamId = '22222222-2222-4222-8222-222222222222'
const workflowUserId = '33333333-3333-4333-8333-333333333333'

function mockRuntimeAuth(
  recipeName: string,
  recipeNamespace = 'sandbox-recipes',
  hostRef = `${recipeNamespace}/${recipeName}`
): McpHostRuntimeAuth {
  return {
    accessToken: 'a',
    refreshToken: 'r',
    baseUrl: 'http://gw',
    hostRef,
    recipeName,
    recipeNamespace,
  }
}

function mockLlmProvider(content = 'final answer'): SingleTurnProvider {
  return {
    completeSingleTurn: vi.fn().mockResolvedValue({
      content,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      finish_reason: 'stop',
    }),
    completeSingleTurnWithTools: vi.fn().mockResolvedValue({
      content,
      tool_calls: null,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      finish_reason: 'stop',
    }),
    getProviderType: () => 'openai',
    classifyError: vi.fn(() => ({
      code: LlmErrorCode.ApiCallFailed,
      retryable: true,
      message: 'mock',
    })),
  }
}

function mockMcpClient(tools: Array<{ name: string }> = []): McpClientConnection {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools.map(t => ({ name: t.name, description: '' }))),
    callTool: vi
      .fn()
      .mockImplementation((name: string) =>
        Promise.resolve({ content: `result-${name}`, isError: false })
      ),
    disconnect: vi.fn().mockResolvedValue(undefined),
  }
}

function mockMcpFactory(): McpClientFactory {
  return () => mockMcpClient()
}

interface FetchTrace {
  checkBodies: BudgetCheckRequest[]
  releaseBodies: Array<Record<string, unknown>>
  fetchImpl: typeof fetch
}

/**
 * Routes /budgets/check and /budgets/release. `verdict` is the JSON returned for
 * a check; pass `'throw'` to simulate a transport failure (fail-open path).
 */
function makeBudgetFetch(verdict: Record<string, unknown> | 'throw'): FetchTrace {
  const checkBodies: BudgetCheckRequest[] = []
  const releaseBodies: Array<Record<string, unknown>> = []
  const fetchImpl = vi.fn().mockImplementation((url: string, init: { body: string }) => {
    if (url.endsWith('/budgets/check')) {
      checkBodies.push(JSON.parse(init.body) as BudgetCheckRequest)
      if (verdict === 'throw') return Promise.reject(new Error('network down'))
      return Promise.resolve({ ok: true, status: 200, json: async () => verdict })
    }
    if (url.endsWith('/budgets/release')) {
      releaseBodies.push(JSON.parse(init.body) as Record<string, unknown>)
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ released: 1 }) })
    }
    return Promise.reject(new Error(`unexpected url: ${url}`))
  })
  return { checkBodies, releaseBodies, fetchImpl: fetchImpl as unknown as typeof fetch }
}

function makeService(
  budgetClient: BudgetClient | null,
  llm = mockLlmProvider()
): { svc: WorkflowService; llm: SingleTurnProvider } {
  const svc = new WorkflowService('my-recipe-12345', {
    llmFactory: () => llm,
    mcpClientFactory: mockMcpFactory(),
    runtimeAuth: mockRuntimeAuth('my-recipe'),
    budgetClient,
  })
  svc.configure({
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'sk-123',
    llmSecretName: 'chatllm-api-keys',
  })
  return { svc, llm }
}

describe('WorkflowService — P3 pre-step budget check', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    appConfig.budgetsEnabled = false
  })

  it('flag off: no-op, never calls the check, step executes', async () => {
    appConfig.budgetsEnabled = false
    const trace = makeBudgetFetch({ allowed: true })
    const client = new BudgetClient({
      baseUrl: 'http://gw',
      getAccessToken: () => 't',
      fetchImpl: trace.fetchImpl,
    })
    const { svc, llm } = makeService(client)

    const res = await svc.executeStep({
      stepId: 's1',
      instruction: 'hello',
      contextVars: { workflowExecutionId, workflowTeamId, workflowUserId },
    })

    expect(res.status).toBe('completed')
    expect(trace.checkBodies).toHaveLength(0)
    expect(llm.completeSingleTurn).toHaveBeenCalledTimes(1)
  })

  it('flag on + allowed: executes and sends source_kind=workflow + recipe_name + attribution', async () => {
    appConfig.budgetsEnabled = true
    const trace = makeBudgetFetch({ allowed: true })
    const client = new BudgetClient({
      baseUrl: 'http://gw',
      getAccessToken: () => 't',
      fetchImpl: trace.fetchImpl,
    })
    const { svc, llm } = makeService(client)

    const res = await svc.executeStep({
      stepId: 's1',
      instruction: 'hello',
      contextVars: { workflowExecutionId, workflowTeamId, workflowUserId },
    })

    expect(res.status).toBe('completed')
    expect(llm.completeSingleTurn).toHaveBeenCalledTimes(1)
    expect(trace.checkBodies).toHaveLength(1)
    expect(trace.checkBodies[0]).toMatchObject({
      host_ref: 'sandbox-recipes/my-recipe',
      context_ref: null,
      llm_secret_name: 'chatllm-api-keys',
      provider: 'openai',
      model: 'gpt-4o',
      source_kind: 'workflow',
      recipe_name: 'my-recipe',
      user_id: workflowUserId,
      team_id: workflowTeamId,
      cron_job_id: null,
    })
    expect(trace.checkBodies[0]?.task_ref).toContain('s1')
  })

  it('flag on + deny: step fails with budget_exceeded and the LLM is never called', async () => {
    appConfig.budgetsEnabled = true
    const trace = makeBudgetFetch({ allowed: false, reason: 'global_tokens_exceeded' })
    const client = new BudgetClient({
      baseUrl: 'http://gw',
      getAccessToken: () => 't',
      fetchImpl: trace.fetchImpl,
    })
    const { svc, llm } = makeService(client)

    const res = await svc.executeStep({
      stepId: 's1',
      instruction: 'hello',
      contextVars: { workflowExecutionId, workflowTeamId, workflowUserId },
    })

    expect(res.status).toBe('failed')
    expect(res.error).toContain('budget_exceeded')
    expect(res.error).toContain('global_tokens_exceeded')
    expect(trace.checkBodies).toHaveLength(1)
    expect(llm.completeSingleTurn).not.toHaveBeenCalled()
    expect(llm.completeSingleTurnWithTools).not.toHaveBeenCalled()
  })

  it('unpriced usage: warns budget_unpriced_usage with the pairs and still executes the step', async () => {
    appConfig.budgetsEnabled = true
    const unpriced = [
      { provider: 'openai', model: 'gpt-4o' },
      { provider: 'anthropic', model: 'claude-3-5-sonnet' },
    ]
    const trace = makeBudgetFetch({ allowed: true, unpriced })
    const client = new BudgetClient({
      baseUrl: 'http://gw',
      getAccessToken: () => 't',
      fetchImpl: trace.fetchImpl,
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { svc, llm } = makeService(client)

    const res = await svc.executeStep({
      stepId: 's1',
      instruction: 'hello',
      contextVars: { workflowExecutionId, workflowTeamId, workflowUserId },
    })

    expect(res.status).toBe('completed')
    expect(llm.completeSingleTurn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      '[WorkflowService] budget_unpriced_usage',
      expect.objectContaining({ stepId: 's1', recipe_name: 'my-recipe', pairs: unpriced })
    )
  })

  it('no unpriced field: does not warn budget_unpriced_usage', async () => {
    appConfig.budgetsEnabled = true
    const trace = makeBudgetFetch({ allowed: true })
    const client = new BudgetClient({
      baseUrl: 'http://gw',
      getAccessToken: () => 't',
      fetchImpl: trace.fetchImpl,
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { svc } = makeService(client)

    await svc.executeStep({
      stepId: 's1',
      instruction: 'hello',
      contextVars: { workflowExecutionId, workflowTeamId, workflowUserId },
    })

    expect(warn).not.toHaveBeenCalledWith(
      '[WorkflowService] budget_unpriced_usage',
      expect.anything()
    )
  })

  it('fail-open: a broken check lets the step proceed', async () => {
    appConfig.budgetsEnabled = true
    const trace = makeBudgetFetch('throw')
    const client = new BudgetClient({
      baseUrl: 'http://gw',
      getAccessToken: () => 't',
      fetchImpl: trace.fetchImpl,
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { svc, llm } = makeService(client)

    const res = await svc.executeStep({
      stepId: 's1',
      instruction: 'hello',
      contextVars: { workflowExecutionId, workflowTeamId, workflowUserId },
    })

    expect(res.status).toBe('completed')
    expect(llm.completeSingleTurn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
  })

  it('budgetClient=null: explicit disable is a no-op even with the flag on', async () => {
    appConfig.budgetsEnabled = true
    const { svc, llm } = makeService(null)
    const res = await svc.executeStep({
      stepId: 's1',
      instruction: 'hello',
      contextVars: { workflowExecutionId, workflowTeamId, workflowUserId },
    })
    expect(res.status).toBe('completed')
    expect(llm.completeSingleTurn).toHaveBeenCalledTimes(1)
  })

  it('P2b: releases a danger-zone reservation on step terminal via task_ref', async () => {
    appConfig.budgetsEnabled = true
    const trace = makeBudgetFetch({ allowed: true, reservationIds: ['res-1'] })
    const client = new BudgetClient({
      baseUrl: 'http://gw',
      getAccessToken: () => 't',
      fetchImpl: trace.fetchImpl,
    })
    const { svc } = makeService(client)

    const res = await svc.executeStep({
      stepId: 's1',
      instruction: 'hello',
      contextVars: { workflowExecutionId, workflowTeamId, workflowUserId },
    })
    // release() is fire-and-forget (not awaited on the step path); flush microtasks.
    await new Promise(resolve => setImmediate(resolve))

    expect(res.status).toBe('completed')
    expect(trace.releaseBodies).toHaveLength(1)
    expect(trace.releaseBodies[0]?.task_ref).toBe(trace.checkBodies[0]?.task_ref)
    // host_ref MUST match the check's (== JWT hostRefs[0]) so control-api binds
    // and host-scopes the drop to the reservation this step created.
    expect(trace.releaseBodies[0]?.host_ref).toBe(trace.checkBodies[0]?.host_ref)
    expect(trace.releaseBodies[0]?.host_ref).toBe('sandbox-recipes/my-recipe')
  })

  it('P2b: still releases the reservation when the step ends in FAILED', async () => {
    appConfig.budgetsEnabled = true
    const trace = makeBudgetFetch({ allowed: true, reservationIds: ['res-1'] })
    const client = new BudgetClient({
      baseUrl: 'http://gw',
      getAccessToken: () => 't',
      fetchImpl: trace.fetchImpl,
    })
    const llm = mockLlmProvider()
    const fail = new Error('llm down')
    ;(llm.completeSingleTurn as ReturnType<typeof vi.fn>).mockRejectedValue(fail)
    ;(llm.completeSingleTurnWithTools as ReturnType<typeof vi.fn>).mockRejectedValue(fail)
    ;(llm.classifyError as ReturnType<typeof vi.fn>).mockReturnValue({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      message: 'llm down',
    })
    const { svc } = makeService(client, llm)

    const res = await svc.executeStep({
      stepId: 's1',
      instruction: 'hello',
      contextVars: { workflowExecutionId, workflowTeamId, workflowUserId },
    })
    await new Promise(resolve => setImmediate(resolve))

    expect(res.status).toBe('failed')
    // The reservation must be freed on ANY terminal exit, not just completion.
    expect(trace.releaseBodies).toHaveLength(1)
    expect(trace.releaseBodies[0]?.task_ref).toBe(trace.checkBodies[0]?.task_ref)
  })

  it('no reservation: nothing is released on terminal', async () => {
    appConfig.budgetsEnabled = true
    const trace = makeBudgetFetch({ allowed: true })
    const client = new BudgetClient({
      baseUrl: 'http://gw',
      getAccessToken: () => 't',
      fetchImpl: trace.fetchImpl,
    })
    const { svc } = makeService(client)

    await svc.executeStep({
      stepId: 's1',
      instruction: 'hello',
      contextVars: { workflowExecutionId, workflowTeamId, workflowUserId },
    })
    await new Promise(resolve => setImmediate(resolve))

    expect(trace.releaseBodies).toHaveLength(0)
  })
})
