import { afterEach, describe, expect, it, vi } from 'vitest'
import { BudgetClient } from '../../budget/budgetClient'
import type { BudgetCheckRequest } from '../../budget/types'
import { config as appConfig } from '../../config'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../queue'
import type { Task } from '../../queue/types'
import { AgentStateMachine } from '../stateMachine'

function makeMachine() {
  const queue = new MessageQueue()
  const machine = new AgentStateMachine(queue, new TaskLifecycle())
  return { machine, queue }
}

/** Minimal SingleTurnProvider stub exposing getProviderType. */
function stubProvider(providerType: string) {
  return { getProviderType: () => providerType } as unknown as Parameters<
    AgentStateMachine['setLLMProvider']
  >[0]
}

describe('AgentStateMachine.checkTaskBudget', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    appConfig.budgetsEnabled = false
  })

  it('is a no-op {allowed:true} with no network when the flag is off', async () => {
    appConfig.budgetsEnabled = false
    const { machine, queue } = makeMachine()
    const fetchImpl = vi.fn()
    const client = new BudgetClient({
      baseUrl: 'http://gw',
      getAccessToken: () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    machine.setLLMProvider(stubProvider('openai'), 'gpt-4o')
    machine.setBudgetCheck(client, () => ({
      host_ref: 'trader',
      context_ref: 'ctx',
      llm_secret_name: 'sec',
    }))

    const task = queue.createInternalTask('hi')
    const out = await machine.checkTaskBudget(task)

    expect(out).toEqual({ allowed: true })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('is a no-op when budgets are on but no client/host context is wired', async () => {
    appConfig.budgetsEnabled = true
    const { machine, queue } = makeMachine()
    machine.setLLMProvider(stubProvider('openai'), 'gpt-4o')
    const out = await machine.checkTaskBudget(queue.createInternalTask('hi'))
    expect(out).toEqual({ allowed: true })
  })

  it('builds the request body from host context + provider/model + task attribution', async () => {
    appConfig.budgetsEnabled = true
    const { machine, queue } = makeMachine()
    let captured: BudgetCheckRequest | undefined
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: { body: string }) => {
      captured = JSON.parse(init.body) as BudgetCheckRequest
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ allowed: true }) })
    })
    const client = new BudgetClient({
      baseUrl: 'http://gw',
      getAccessToken: () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    machine.setLLMProvider(stubProvider('claude'), 'claude-sonnet-4')
    machine.setBudgetCheck(client, () => ({
      host_ref: 'trader',
      context_ref: 'trader-context',
      llm_secret_name: 'anthropic-key',
    }))

    const task: Task = {
      ...queue.createInternalTask('hi'),
      source: 'cron',
      cronJobId: 'cron-9',
    }
    const out = await machine.checkTaskBudget(task)

    expect(out).toEqual({ allowed: true })
    expect(captured).toEqual({
      host_ref: 'trader',
      context_ref: 'trader-context',
      llm_secret_name: 'anthropic-key',
      provider: 'claude',
      model: 'claude-sonnet-4',
      source_kind: 'cron',
      user_id: null,
      team_id: null,
      recipe_name: null,
      cron_job_id: 'cron-9',
      // P2b (§5.4): stable task correlation for early reservation release.
      task_ref: task.id,
    })
  })

  it('returns the deny verdict from control-api', async () => {
    appConfig.budgetsEnabled = true
    const { machine, queue } = makeMachine()
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ allowed: false, reason: 'global_tokens_exceeded' }),
    })
    const client = new BudgetClient({
      baseUrl: 'http://gw',
      getAccessToken: () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    machine.setLLMProvider(stubProvider('openai'), 'gpt-4o')
    machine.setBudgetCheck(client, () => ({
      host_ref: 'trader',
      context_ref: 'ctx',
      llm_secret_name: 'sec',
    }))

    const out = await machine.checkTaskBudget(queue.createInternalTask('hi'))
    expect(out).toEqual({ allowed: false, reason: 'global_tokens_exceeded' })
  })
})

describe('AgentStateMachine — P2b early reservation release on terminal', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    appConfig.budgetsEnabled = false
  })

  /** Wire a machine whose budget check returns the given verdict, run the check,
   *  then drive the task to the given terminal status; resolves the captured
   *  release request bodies (one per release call observed). */
  async function runCheckThenTerminal(opts: {
    verdict: Record<string, unknown>
    terminal: 'completed' | 'failed' | 'cancelled'
  }): Promise<{ releaseBodies: unknown[]; releaseUrls: string[] }> {
    appConfig.budgetsEnabled = true
    const queue = new MessageQueue()
    const lifecycle = new TaskLifecycle()
    queue.setLifecycle(lifecycle)
    const machine = new AgentStateMachine(queue, lifecycle)
    machine.setLLMProvider(stubProvider('openai'), 'gpt-4o')

    const releaseBodies: unknown[] = []
    const releaseUrls: string[] = []
    const fetchImpl = vi.fn().mockImplementation((url: string, init: { body: string }) => {
      if (String(url).endsWith('/budgets/check')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => opts.verdict })
      }
      // /budgets/release
      releaseUrls.push(String(url))
      releaseBodies.push(JSON.parse(init.body))
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ released: 1 }) })
    })
    const client = new BudgetClient({
      baseUrl: 'http://gw',
      getAccessToken: () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    machine.setBudgetCheck(client, () => ({
      host_ref: 'trader',
      context_ref: 'ctx',
      llm_secret_name: 'sec',
    }))

    const task = queue.createInternalTask('hi')
    lifecycle.register(task)
    lifecycle.transition(task.id, 'processing', 'dispatched')

    await machine.checkTaskBudget(task)

    if (opts.terminal === 'completed') queue.completeTask(task)
    else if (opts.terminal === 'failed')
      queue.failTask(task, { code: 'X', message: 'm', retryable: false, provider: 'openai' })
    else lifecycle.transition(task.id, 'cancelled', 'user_requested')

    // Let the fire-and-forget release microtask settle.
    await new Promise(r => setImmediate(r))
    return { releaseBodies, releaseUrls }
  }

  it('releases by task_ref when the verdict carried reservationIds and the task completes', async () => {
    const { releaseBodies, releaseUrls } = await runCheckThenTerminal({
      verdict: { allowed: true, reservationIds: ['res-1'] },
      terminal: 'completed',
    })
    expect(releaseBodies).toHaveLength(1)
    // host_ref MUST match the one the check sent (getHostBudgetContext → 'trader')
    // so control-api's claim-binding + host-scoping matches the reservation.
    expect(releaseBodies[0]).toEqual({ task_ref: expect.any(String), host_ref: 'trader' })
    expect(releaseUrls[0]).toBe('http://gw/api/v1/internal/budgets/release')
  })

  it('also releases when the task FAILS (terminal branch covers errors)', async () => {
    const { releaseBodies } = await runCheckThenTerminal({
      verdict: { allowed: true, reservationIds: ['res-1'] },
      terminal: 'failed',
    })
    expect(releaseBodies).toHaveLength(1)
  })

  it('also releases when the task is CANCELLED', async () => {
    const { releaseBodies } = await runCheckThenTerminal({
      verdict: { allowed: true, reservationIds: ['res-1'] },
      terminal: 'cancelled',
    })
    expect(releaseBodies).toHaveLength(1)
  })

  it('does NOT release when the verdict had no reservationIds (no danger-zone reservation)', async () => {
    const { releaseBodies } = await runCheckThenTerminal({
      verdict: { allowed: true },
      terminal: 'completed',
    })
    expect(releaseBodies).toHaveLength(0)
  })

  it('does NOT release when the verdict had an empty reservationIds array', async () => {
    const { releaseBodies } = await runCheckThenTerminal({
      verdict: { allowed: true, reservationIds: [] },
      terminal: 'completed',
    })
    expect(releaseBodies).toHaveLength(0)
  })

  it('flag OFF: never sends task_ref and never releases (total no-op)', async () => {
    appConfig.budgetsEnabled = false
    const queue = new MessageQueue()
    const lifecycle = new TaskLifecycle()
    queue.setLifecycle(lifecycle)
    const machine = new AgentStateMachine(queue, lifecycle)
    machine.setLLMProvider(stubProvider('openai'), 'gpt-4o')

    const fetchImpl = vi.fn()
    const client = new BudgetClient({
      baseUrl: 'http://gw',
      getAccessToken: () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    machine.setBudgetCheck(client, () => ({
      host_ref: 'trader',
      context_ref: 'ctx',
      llm_secret_name: 'sec',
    }))

    const task = queue.createInternalTask('hi')
    lifecycle.register(task)
    lifecycle.transition(task.id, 'processing', 'dispatched')
    await machine.checkTaskBudget(task)
    queue.completeTask(task)
    await new Promise(r => setImmediate(r))

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('release fail-open: a throwing release never surfaces an error on the terminal path', async () => {
    appConfig.budgetsEnabled = true
    const queue = new MessageQueue()
    const lifecycle = new TaskLifecycle()
    queue.setLifecycle(lifecycle)
    const machine = new AgentStateMachine(queue, lifecycle)
    machine.setLLMProvider(stubProvider('openai'), 'gpt-4o')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/budgets/check')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ allowed: true, reservationIds: ['res-1'] }),
        })
      }
      return Promise.reject(new Error('release boom'))
    })
    const client = new BudgetClient({
      baseUrl: 'http://gw',
      getAccessToken: () => 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    machine.setBudgetCheck(client, () => ({
      host_ref: 'trader',
      context_ref: 'ctx',
      llm_secret_name: 'sec',
    }))

    const task = queue.createInternalTask('hi')
    lifecycle.register(task)
    lifecycle.transition(task.id, 'processing', 'dispatched')
    await machine.checkTaskBudget(task)

    // completeTask drives the terminal transition; it must not throw despite the
    // failing release fired by the subscriber.
    expect(() => queue.completeTask(task)).not.toThrow()
    await new Promise(r => setImmediate(r))
    expect(lifecycle.getStatus(task.id)).toBe('completed')
  })
})

describe('AgentStateMachine.handleBudgetDenied', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('delivers a budget error via responseCallback and drives the task to failed', async () => {
    const queue = new MessageQueue()
    const lifecycle = new TaskLifecycle()
    queue.setLifecycle(lifecycle) // queue.failTask must transition the SAME lifecycle
    const machine = new AgentStateMachine(queue, lifecycle)
    machine.setLLMProvider(stubProvider('openai'), 'gpt-4o')

    const responseCallback = vi.fn().mockResolvedValue(undefined)
    const task = queue.createInternalTask('hi')
    task.responseCallback = responseCallback
    lifecycle.register(task)
    lifecycle.transition(task.id, 'processing', 'dispatched')

    const failed: unknown[] = []
    machine.on('task:failed', e => failed.push(e))

    machine.handleBudgetDenied(task, 'monthly_cost_exceeded')
    await new Promise(r => setImmediate(r))

    expect(responseCallback).toHaveBeenCalledTimes(1)
    const payload = responseCallback.mock.calls[0][0]
    expect(payload.error.code).toBe('BUDGET_EXCEEDED')
    expect(payload.error.message).toMatch(/consumption budget/i)
    expect(payload.error.retryable).toBe(false)
    expect(payload.error.provider).toBe('openai')
    expect(lifecycle.getStatus(task.id)).toBe('failed')
    expect(failed).toHaveLength(1)
  })
})
