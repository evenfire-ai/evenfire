/**
 * Issue #654 — a visual send is PINNED to the (provider, model) the user's UI
 * validated. `IncomingMessage.imageModel` is server-owned; when it is present
 * the task must run on exactly that pair or fail, never silently run the image
 * under another model and never silently fall back to the Host default.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { MessageQueue } from '../../queue/messageQueue'
import type { Task, TaskError } from '../../queue/types'
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

function taskFor(
  channelId: string,
  imageModel?: { provider: string; model: string }
): Task & { responseCallback: ReturnType<typeof vi.fn> } {
  const responseCallback = vi.fn(async () => {})
  return {
    id: `task-${channelId}-${Math.random().toString(36).slice(2, 6)}`,
    source: 'channel',
    sourceMessage: {
      sender: 'user-1',
      content: 'look at this',
      channelType: 'rpc',
      channelId,
      messageId: 'msg-1',
      timestamp: new Date().toISOString(),
      hostRef: 'test-host',
      ...(imageModel ? { imageModel } : {}),
    },
    priority: 'normal',
    status: 'pending',
    conversationHistory: [{ role: 'user', content: 'look at this', timestamp: new Date() }],
    responseCallback,
    createdAt: new Date(),
  } as unknown as Task & { responseCallback: ReturnType<typeof vi.fn> }
}

const VISUAL = { provider: 'zai', model: 'glm-5.3-flash' }

describe('#654 AgentStateMachine — visual selection pinning', () => {
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

  it('drives the resolver with the snapshot, ignoring the session selection', async () => {
    const provider = makeProvider('zai')
    const resolver = vi.fn(
      (selections: Record<string, string> | undefined): ResolvedTaskModel | null =>
        selections?.[VISUAL.provider] === VISUAL.model
          ? { provider: provider as never, model: VISUAL.model }
          : null
    )
    agent.setTaskModelResolver(resolver)

    // The session's own (older) selection must NOT be what a pinned image uses.
    const cm = agent.getConversationManager()
    const conv = await cm.getOrCreate('user-1:rpc:chat-visual:default')
    cm.setModelSelection(conv, 'openai', 'gpt-4o')

    await agent.executeTask(taskFor('chat-visual', VISUAL))

    expect(resolver).toHaveBeenCalledWith({ [VISUAL.provider]: VISUAL.model })
    expect(runToolUseLoop).toHaveBeenCalledTimes(1)
    expect(provider.getProviderType).toHaveBeenCalled()
  })

  it('runs normally when no snapshot is present (text path unchanged)', async () => {
    const resolver = vi.fn(
      (): ResolvedTaskModel | null => null // resolution unavailable → Host default
    )
    agent.setTaskModelResolver(resolver)

    await agent.executeTask(taskFor('chat-text'))

    expect(runToolUseLoop).toHaveBeenCalledTimes(1)
  })

  it('fails the task when the resolver serves a DIFFERENT pair than the snapshot', async () => {
    const other = makeProvider('openai')
    agent.setTaskModelResolver(() => ({ provider: other as never, model: 'gpt-4o' }))
    const task = taskFor('chat-mismatch', VISUAL)

    await agent.executeTask(task)

    expect(runToolUseLoop).not.toHaveBeenCalled()
    expect(task.responseCallback).toHaveBeenCalledTimes(1)
    const error = task.responseCallback.mock.calls[0][0].error as TaskError
    expect(error.code).toBe('LLM_MODEL_NOT_AVAILABLE')
    expect(error.retryable).toBe(false)
    expect(error.provider).toBe('openai')
    expect(error.message).toContain('zai/glm-5.3-flash')
  })

  it('fails closed when the pinned model cannot be resolved (no Host-default redirect)', async () => {
    agent.setTaskModelResolver(() => null)
    const task = taskFor('chat-unresolvable', VISUAL)

    await agent.executeTask(task)

    expect(runToolUseLoop).not.toHaveBeenCalled()
    const error = task.responseCallback.mock.calls[0][0].error as TaskError
    expect(error.code).toBe('LLM_MODEL_NOT_AVAILABLE')
    expect(error.message).toContain('zai/glm-5.3-flash')
  })

  it('fails closed when the resolver THROWS for a pinned visual task', async () => {
    agent.setTaskModelResolver(() => {
      throw new Error('catalog unavailable')
    })
    const task = taskFor('chat-throw', VISUAL)

    await agent.executeTask(task)

    expect(runToolUseLoop).not.toHaveBeenCalled()
    const error = task.responseCallback.mock.calls[0][0].error as TaskError
    expect(error.code).toBe('LLM_MODEL_NOT_AVAILABLE')
    expect(error.provider).toBe(VISUAL.provider)
  })

  it('keeps the existing Host-default fallback for a THROWING resolver on a text task', async () => {
    agent.setTaskModelResolver(() => {
      throw new Error('catalog unavailable')
    })
    const task = taskFor('chat-throw-text')

    await agent.executeTask(task)

    expect(runToolUseLoop).toHaveBeenCalledTimes(1)
    // Delivered as a normal response — the failed resolution must not surface
    // as an error for a text-only task.
    const delivered = task.responseCallback.mock.calls[0][0] as {
      error?: TaskError
      response?: string
    }
    expect(delivered.error).toBeUndefined()
    expect(delivered.response).toBe('ok')
  })

  it('accepts a snapshot that matches the Host default when no resolver is wired', async () => {
    const task = taskFor('chat-default', { provider: 'openai', model: 'host-default' })

    await agent.executeTask(task)

    expect(runToolUseLoop).toHaveBeenCalledTimes(1)
  })

  it('ignores a malformed snapshot instead of pinning a partial pair', async () => {
    const task = taskFor('chat-malformed')
    ;(task.sourceMessage as { imageModel?: unknown }).imageModel = { provider: 'zai' }

    await agent.executeTask(task)

    expect(runToolUseLoop).toHaveBeenCalledTimes(1)
  })
})
