// The leftover removal is replaced by a promise the test controls, so this
// needs its own file: a module mock applies to every test of the file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { LlmErrorCode } from '../../core/errors'
import type { SingleTurnProvider } from '../../llm'
import { logger } from '../../logger'
import type { McpClientConnection } from '../stepRouter'
import { WorkflowService } from '../workflowService'

const removal = vi.hoisted(() => ({
  calls: 0,
  // Set by each test: what the next removal call returns.
  next: (): Promise<void> => Promise.resolve(),
}))

vi.mock('../stepSpillover', async importOriginal => {
  const actual = await importOriginal<typeof import('../stepSpillover')>()
  return {
    ...actual,
    removeLeftoverStepSpillover: (): Promise<void> => {
      removal.calls += 1
      return removal.next()
    },
  }
})

const NEVER = (): Promise<void> => new Promise<void>(() => undefined)

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}

function textProvider(): SingleTurnProvider {
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  return {
    completeSingleTurn: vi
      .fn()
      .mockResolvedValue({ content: 'done', usage, finish_reason: 'stop' }),
    completeSingleTurnWithTools: vi
      .fn()
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [{ name: 'srv__read', arguments: {} }],
        usage,
        finish_reason: 'tool_use',
      })
      .mockResolvedValue({ content: 'done', tool_calls: null, usage, finish_reason: 'stop' }),
    getProviderType: () => 'openai',
    classifyError: vi.fn(() => ({
      code: LlmErrorCode.ApiCallFailed,
      retryable: true,
      message: 'mock',
    })),
  }
}

function mcpClient(result: string): McpClientConnection {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([{ name: 'read', description: '' }]),
    callTool: vi.fn().mockResolvedValue({ content: result, isError: false }),
    disconnect: vi.fn().mockResolvedValue(undefined),
  }
}

function service(llm: SingleTurnProvider, client = mcpClient('small')): WorkflowService {
  const svc = new WorkflowService('test-recipe', {
    llmFactory: () => llm,
    mcpClientFactory: () => client,
  })
  svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'sk-123' })
  return svc
}

function providerCalls(llm: SingleTurnProvider): number {
  return (
    vi.mocked(llm.completeSingleTurn).mock.calls.length +
    vi.mocked(llm.completeSingleTurnWithTools).mock.calls.length
  )
}

// A step that never returns fails the assertion below instead of the test timeout.
const PENDING = 'still pending'
function settledWithin<T>(p: Promise<T>, ms: number): Promise<T | typeof PENDING> {
  return Promise.race([p, new Promise<typeof PENDING>(r => setTimeout(() => r(PENDING), ms))])
}

function caughtErrors(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(call => call[1] === 'Step caught error').length
}

const SERVERS = [{ name: 'srv', url: 'http://srv' }]

let outputDir: string

beforeEach(async () => {
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-spillover-wait-'))
  vi.stubEnv('CLERUM_OUTPUT_DIR', outputDir)
  removal.calls = 0
  removal.next = () => Promise.resolve()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await fs.rm(outputDir, { recursive: true, force: true })
})

describe('WorkflowService step spillover — waiting for the leftover removal', () => {
  it.each([
    ['enabled', undefined],
    ['disabled', 'false'],
  ])('fails with step-timeout when the removal never settles (%s)', async (_label, enabled) => {
    if (enabled !== undefined) vi.stubEnv('CLERUM_WORKFLOW_TOOL_SPILLOVER_ENABLED', enabled)
    removal.next = NEVER
    const llm = textProvider()

    const res = await settledWithin(
      service(llm).executeStep({ stepId: 'review', instruction: 'go', timeoutSeconds: 0.05 }),
      2000
    )

    expect(res).toMatchObject({ stepId: 'review', status: 'failed', error: 'step-timeout' })
    // Witness: the step reached the removal; it did not fail earlier.
    expect(removal.calls).toBe(1)
    expect(providerCalls(llm)).toBe(0)
  })

  it('fails with the caller reason when the caller aborts during the wait', async () => {
    removal.next = NEVER
    const llm = textProvider()
    const controller = new AbortController()
    setTimeout(() => controller.abort('client-disconnected'), 20)

    const res = await settledWithin(
      service(llm).executeStep({ stepId: 'review', instruction: 'go' }, undefined, {
        signal: controller.signal,
      }),
      2000
    )

    expect(res).toMatchObject({ status: 'failed', error: 'client-disconnected' })
    expect(removal.calls).toBe(1)
    expect(providerCalls(llm)).toBe(0)
  })

  it('returns the abort reason of a step aborted before the wait, without waiting or writing', async () => {
    removal.next = NEVER
    const errorLog = vi.spyOn(logger, 'error')
    const llm = textProvider()
    const controller = new AbortController()
    controller.abort('client-disconnected')

    const res = await settledWithin(
      service(llm, mcpClient('L'.repeat(100 * 1024))).executeStep(
        { stepId: 'review', instruction: 'go', mcpServers: SERVERS },
        undefined,
        { signal: controller.signal }
      ),
      2000
    )

    expect(res).toMatchObject({ status: 'failed', error: 'client-disconnected', toolsCalled: [] })
    expect(removal.calls).toBe(1)
    expect(providerCalls(llm)).toBe(0)
    expect(await fs.readdir(outputDir)).toEqual([])
    // Same path as a step aborted before its first iteration: the loop's abort
    // check, not the catch block.
    expect(caughtErrors(errorLog)).toBe(0)
  })

  it('keeps failing later steps on their own timeout while the removal is pending, and shares it', async () => {
    removal.next = NEVER
    const llm = textProvider()
    const svc = service(llm)

    const first = await settledWithin(
      svc.executeStep({ stepId: 'one', instruction: 'go', timeoutSeconds: 0.05 }),
      2000
    )
    const second = await settledWithin(
      svc.executeStep({ stepId: 'two', instruction: 'go', timeoutSeconds: 0.05 }),
      2000
    )

    expect(first).toMatchObject({ stepId: 'one', status: 'failed', error: 'step-timeout' })
    expect(second).toMatchObject({ stepId: 'two', status: 'failed', error: 'step-timeout' })
    expect(removal.calls).toBe(1)
  })

  it('runs a later step once the removal that outlived the first step settles', async () => {
    const gate = deferred()
    removal.next = () => gate.promise
    const llm = textProvider()
    const svc = service(llm)

    const first = await settledWithin(
      svc.executeStep({ stepId: 'one', instruction: 'go', timeoutSeconds: 0.05 }),
      2000
    )
    expect(first).toMatchObject({ status: 'failed', error: 'step-timeout' })

    gate.resolve()
    const second = await settledWithin(svc.executeStep({ stepId: 'two', instruction: 'go' }), 2000)
    expect(second).toMatchObject({ stepId: 'two', status: 'completed' })
    expect(removal.calls).toBe(1)
  })

  it('does not call the provider or write a spill file before the removal settles', async () => {
    const gate = deferred()
    removal.next = () => gate.promise
    const llm = textProvider()
    const client = mcpClient('L'.repeat(100 * 1024))
    const pending = service(llm, client).executeStep({
      stepId: 'review',
      instruction: 'go',
      mcpServers: SERVERS,
    })

    // The step is parked on the removal: its servers are connected and listed,
    // and nothing after the wait has run.
    await vi.waitFor(() => expect(client.listTools).toHaveBeenCalledTimes(1))
    await new Promise(r => setTimeout(r, 30))
    expect(providerCalls(llm)).toBe(0)
    expect(await fs.readdir(outputDir)).toEqual([])

    gate.resolve()
    const res = await settledWithin(pending, 2000)
    // Witness for the two negative checks above: the same step goes on to call
    // the provider and to spill once the removal settles.
    expect(res).toMatchObject({ status: 'completed' })
    expect(providerCalls(llm)).toBe(2)
    expect(client.callTool).toHaveBeenCalledTimes(1)
    const secondCall = vi.mocked(llm.completeSingleTurnWithTools).mock.calls[1]![0] as Array<{
      content: string
    }>
    expect(
      secondCall.some(m => m.content.includes('"spillover_ref":"spillover://review/i1c0.json"'))
    ).toBe(true)
    expect(removal.calls).toBe(1)
  })
})
