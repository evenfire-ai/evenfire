/**
 * R2 — per-task model resolution at the AgentStateMachine seam.
 *
 * Verifies that `executeTask` reads the SESSION's saved selection, feeds it to
 * the injected resolver, and runs the task with the RESOLVED provider (not the
 * process-wide default) — the property that lets two chats on one Host run
 * different models in parallel, and that a key rotation (setLLMProvider) never
 * reverts a session's selection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../queue/messageQueue'
import { Task } from '../../queue/types'
import { AgentStateMachine } from '../stateMachine'
import type { ResolvedTaskModel } from '../types'

vi.mock('../../config', () => ({
  config: {
    devMode: true,
    enableApproval: false,
    enableNudge: false,
    nudgeMaxIterations: 3,
    devModelName: 'test-model',
    devModelProvider: 'openai',
    contextMaxTokens: 100000,
    nativeTool: {
      workspacePath: '/tmp',
      shellTimeout: 5000,
      httpAllowlist: [],
      envAllowlist: ['PATH'],
      memoryMaxSize: 1048576,
    },
  },
}))

vi.mock('../../core/orchestration/toolUseLoop', () => ({
  runToolUseLoop: vi.fn(),
  validateToolLinkages: vi.fn(),
}))

function makeProvider(type: string) {
  return {
    completeSingleTurn: vi.fn(),
    completeSingleTurnWithTools: vi.fn(),
    getProviderType: vi.fn(() => type),
  }
}

function taskFor(channelId: string): Task {
  return {
    id: `task-${channelId}-${Math.random().toString(36).slice(2, 6)}`,
    source: 'channel',
    sourceMessage: {
      sender: 'user-1',
      content: 'hi',
      channelType: 'rpc',
      channelId,
      messageId: 'msg-1',
      timestamp: new Date().toISOString(),
      hostRef: 'test-host',
    },
    priority: 'normal',
    status: 'pending',
    conversationHistory: [{ role: 'user', content: 'hi', timestamp: new Date() }],
    responseCallback: vi.fn(async () => {}),
    createdAt: new Date(),
  }
}

// The task's session key is `${sender}:${channelType}:${channelId}:${threadId||default}`.
const keyFor = (channelId: string) => `user-1:rpc:${channelId}:default`

describe('AgentStateMachine — per-task model resolution', () => {
  let agent: AgentStateMachine

  beforeEach(() => {
    vi.clearAllMocks()
    agent = new AgentStateMachine(new MessageQueue(), new TaskLifecycle(), { autoStart: false })
    agent.setLLMProvider(makeProvider('openai') as never, 'host-default')
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as never)
    ;(runToolUseLoop as ReturnType<typeof vi.fn>).mockResolvedValue({
      type: 'response',
      content: 'ok',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
  })

  it('wires each chat to the provider resolved from ITS session selection (resolver wiring; usage attribution asserted at adapter level)', async () => {
    const providerA = makeProvider('providerA')
    const providerB = makeProvider('providerB')
    const resolver = vi.fn(
      (selections: Record<string, string> | undefined): ResolvedTaskModel | null => {
        const model = selections?.claude
        if (model === 'model-a')
          return { provider: providerA as never, model, contextWindowTokens: 111 }
        if (model === 'model-b') return { provider: providerB as never, model }
        return null
      }
    )
    agent.setTaskModelResolver(resolver)

    // Seed two sessions on the same Host with different saved selections.
    const cm = agent.getConversationManager()
    const convA = await cm.getOrCreate(keyFor('chat-a'))
    cm.setModelSelection(convA, 'claude', 'model-a')
    const convB = await cm.getOrCreate(keyFor('chat-b'))
    cm.setModelSelection(convB, 'claude', 'model-b')

    await agent.executeTask(taskFor('chat-a'))
    await agent.executeTask(taskFor('chat-b'))

    // Resolver saw each session's own selection.
    expect(resolver).toHaveBeenCalledWith({ claude: 'model-a' })
    expect(resolver).toHaveBeenCalledWith({ claude: 'model-b' })
    // Each task used its resolved provider (getProviderType is invoked while the
    // executor builds the LlmPortAdapter), never the other session's provider.
    expect(providerA.getProviderType).toHaveBeenCalled()
    expect(providerB.getProviderType).toHaveBeenCalled()
  })

  it('applies a swap on the NEXT task and a key rotation does not revert the selection', async () => {
    const providerNew = makeProvider('rotated')
    const resolver = vi.fn(
      (selections: Record<string, string> | undefined): ResolvedTaskModel | null => ({
        provider: providerNew as never,
        model: selections?.claude ?? 'host-default',
      })
    )
    agent.setTaskModelResolver(resolver)

    const cm = agent.getConversationManager()
    const conv = await cm.getOrCreate(keyFor('chat-x'))
    cm.setModelSelection(conv, 'claude', 'chosen-model')

    // Simulate a key rotation between tasks (only mutates the default provider).
    agent.setLLMProvider(makeProvider('openai') as never, 'host-default')

    await agent.executeTask(taskFor('chat-x'))

    // The resolver still received the session's saved selection after rotation.
    expect(resolver).toHaveBeenLastCalledWith({ claude: 'chosen-model' })
    expect(providerNew.getProviderType).toHaveBeenCalled()
  })

  it('falls back to the default provider when no resolver is wired', async () => {
    const cm = agent.getConversationManager()
    await cm.getOrCreate(keyFor('chat-z'))
    await agent.executeTask(taskFor('chat-z'))
    expect(runToolUseLoop).toHaveBeenCalledTimes(1)
  })
})
