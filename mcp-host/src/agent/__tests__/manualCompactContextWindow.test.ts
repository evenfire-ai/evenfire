/**
 * #731 R3-4 — the manual /compact path resolves the context window the same
 * way a task does: the catalog value, else the subscription default, else
 * `CLERUM_CONTEXT_MAX_TOKENS`.
 *
 * Boundary: `PressureContextManager` stays real; a subclass only records the
 * window it was built with. The summarizer call is stubbed at the adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmPortAdapter } from '../../core/adapters/llmPortAdapter'
import { FinishReason } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../queue/messageQueue'
import { AgentStateMachine } from '../stateMachine'

const { builtWindows } = vi.hoisted(() => ({ builtWindows: [] as Array<number | undefined> }))

vi.mock('../../core/extensions/contextManager', async importOriginal => {
  const actual = await importOriginal<typeof import('../../core/extensions/contextManager')>()
  class RecordingPressureContextManager extends actual.PressureContextManager {
    constructor(...args: ConstructorParameters<typeof actual.PressureContextManager>) {
      super(...args)
      builtWindows.push(args[0])
    }
  }
  return { ...actual, PressureContextManager: RecordingPressureContextManager }
})

vi.mock('../../config', () => ({
  config: {
    devMode: true,
    enableApproval: false,
    enableNudge: false,
    nudgeMaxIterations: 3,
    devModelName: 'test-model',
    devModelProvider: 'openai',
    contextMaxTokens: 100000,
    tokenizerOffline: true,
    tokenizerDryrun: false,
    compactionStructuredSummary: false,
    promptCacheEnabled: false,
    nativeTool: {
      workspacePath: '/tmp',
      shellTimeout: 5000,
      httpAllowlist: [],
      envAllowlist: ['PATH'],
      memoryMaxSize: 1048576,
    },
  },
}))

function usage() {
  return { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
}

function stubProvider(type: string) {
  return {
    completeSingleTurn: vi.fn(async () => ({
      content: 'ok',
      usage: usage(),
      finish_reason: FinishReason.Stop,
    })),
    completeSingleTurnWithTools: vi.fn(async () => ({
      content: 'ok',
      tool_calls: [],
      usage: usage(),
      finish_reason: FinishReason.Stop,
    })),
    getProviderType: () => type,
  }
}

describe('manual /compact context window (#731 R3-4)', () => {
  let agent: AgentStateMachine

  beforeEach(() => {
    builtWindows.length = 0
    const queue = new MessageQueue()
    const lifecycle = new TaskLifecycle()
    queue.setLifecycle(lifecycle)
    agent = new AgentStateMachine(queue, lifecycle, { autoStart: false })
    agent.setLLMProvider(stubProvider('openai') as never, 'gpt-4o')
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as never)
    agent.start()
    vi.spyOn(LlmPortAdapter.prototype, 'complete').mockResolvedValue({
      content: 'summary of the archived turns',
      usage: usage(),
      finish_reason: FinishReason.Stop,
    } as never)
  })

  afterEach(async () => {
    await agent.stop()
    vi.restoreAllMocks()
  })

  async function compactWith(providerType: string, contextWindowTokens?: number) {
    agent.setTaskModelResolver(() => ({
      provider: stubProvider(providerType) as never,
      model: 'model-under-test',
      contextWindowTokens,
    }))
    const sessionKey = `user-1:rpc:${providerType}-${contextWindowTokens ?? 'none'}:default`
    const cm = agent.getConversationManager()
    const conv = await cm.getOrCreate(sessionKey)
    for (let i = 0; i < 8; i++) {
      await cm.startTurn(conv, `user ${i}`, `task-${i}`)
      await cm.completeTurn(conv, `assistant ${i}`)
    }
    return agent.compactSession({ sessionKey })
  }

  it('T-R3-4g builds the manual compactor with the resolved window', async () => {
    expect((await compactWith('codex-subscription')).kind).toBe('ok')
    expect((await compactWith('grok-subscription', 500_000)).kind).toBe('ok')
    expect((await compactWith('openai')).kind).toBe('ok')
    // One compactor per call, in call order.
    expect(builtWindows).toEqual([256_000, 500_000, 100_000])
  })
})
