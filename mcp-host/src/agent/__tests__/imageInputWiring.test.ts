/**
 * Issue #654 — the LIVE wiring of the image-input guard.
 *
 * The guard itself is covered elsewhere (`core/adapters/__tests__/
 * llmPortAdapter.imageInput.test.ts`, `llm/__tests__/imageInput.test.ts`,
 * `llm/__tests__/imageInputTransport.test.ts`, `llm/__tests__/
 * claudeToolImageWire.test.ts`). This suite covers what those cannot: which
 * resolver instance actually reaches the port each production call site builds,
 * and what the resumed turn does when the capability changed while the approval
 * was pending.
 *
 * Boundary: the tool-use loop is mocked because it is the one component that
 * would otherwise execute real tools. Everything under test stays real —
 * `AgentStateMachine` → `TaskExecutor` → `LlmPortAdapter` → the provider stub.
 * Where the loop would dispatch to the model, these tests call the loop config's
 * real `reasoning` port (the production `defaultReasoningPort` the executor
 * built), which is the same object the real loop calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmPortAdapter } from '../../core/adapters/llmPortAdapter'
import { LlmError, LlmErrorCode } from '../../core/errors'
import { executeSingleTool, runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { appendToolResults } from '../../core/orchestration/toolUseLoopMessages'
import {
  type Attachment,
  type ChatMessage,
  FinishReason,
  type ReasoningContext,
  type RespondResult,
} from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { ImageInputResolver } from '../../llm/imageInput'
import { MessageQueue } from '../../queue/messageQueue'
import type { Task, TaskError } from '../../queue/types'
import { AgentStateMachine } from '../stateMachine'

vi.mock('../../config', () => ({
  config: {
    devMode: true,
    enableApproval: true,
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

vi.mock('../../core/orchestration/toolUseLoop', () => ({
  runToolUseLoop: vi.fn(),
  executeSingleTool: vi.fn(),
  validateToolLinkages: vi.fn(),
  extractInputPreview: vi.fn(() => 'ls'),
  buildOutputPreview: vi.fn((content: string) =>
    content
      ? {
          headLines: String(content).split('\n').slice(0, 3),
          tailLines: [],
          totalLines: String(content).split('\n').length,
          truncated: false,
        }
      : undefined
  ),
}))

const EVIDENCE = {
  source: 'curated' as const,
  reference: 'https://docs.z.ai/guides/vlm/glm-5.3-flash',
  checkedAt: '2026-09-16T00:00:00Z',
}

const IMAGE_B64 = 'QUJD'
const SESSION_KEY = 'user-1:rpc:wiring-session:default'

function usage() {
  return { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
}

function stubProvider(type: string) {
  return {
    completeSingleTurn: vi.fn(async (_messages: ChatMessage[], _options?: unknown) => ({
      content: 'ok',
      usage: usage(),
      finish_reason: FinishReason.Stop,
    })),
    completeSingleTurnWithTools: vi.fn(
      async (_messages: ChatMessage[], _tools: unknown[], _options?: unknown) => ({
        content: 'ok',
        tool_calls: [],
        usage: usage(),
        finish_reason: FinishReason.Stop,
      })
    ),
    getProviderType: () => type,
  }
}

type StubProvider = ReturnType<typeof stubProvider>

function imageMessage(role: ChatMessage['role'] = 'user'): ChatMessage {
  return {
    role,
    content: 'look at this',
    contentParts: [
      { type: 'text', text: 'look at this' },
      { type: 'image', mimeType: 'image/png', data: IMAGE_B64 },
    ],
  }
}

function imageTask(
  channelId = 'chat-image'
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
      attachments: [
        {
          id: 'att-1',
          kind: 'image',
          mimeType: 'image/png',
          encoding: 'base64',
          dataBase64: IMAGE_B64,
        },
      ],
    },
    priority: 'normal',
    status: 'pending',
    conversationHistory: [{ role: 'user', content: 'look at this', timestamp: new Date() }],
    responseCallback,
    createdAt: new Date(),
  } as unknown as Task & { responseCallback: ReturnType<typeof vi.fn> }
}

interface LoopConfigLike {
  reasoning: { respondWithTools: (context: ReasoningContext) => Promise<RespondResult> }
}

/**
 * What the real loop does with the config it is handed: it asks the reasoning
 * port for the next model turn. Calling the same object keeps the assertion on
 * the production path (reasoning port → adapter → guard → provider).
 */
function dispatchThroughReasoning(
  config: unknown,
  messages: ChatMessage[]
): Promise<RespondResult> {
  return (config as LoopConfigLike).reasoning.respondWithTools({
    messages,
    available_tools: [],
  })
}

/** The typed denial carried by a failed `RespondResult`, if any. */
function errorOf(result: RespondResult | undefined): LlmError | undefined {
  const failed = result as Extract<RespondResult, { type: 'error' }> | undefined
  return failed?.error as LlmError | undefined
}

describe('#654 image-input guard wiring', () => {
  let agent: AgentStateMachine
  let queue: MessageQueue
  let lifecycle: TaskLifecycle
  let provider: StubProvider

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runToolUseLoop).mockReset()
    vi.mocked(executeSingleTool).mockReset()
    queue = new MessageQueue()
    lifecycle = new TaskLifecycle()
    queue.setLifecycle(lifecycle)
    agent = new AgentStateMachine(queue, lifecycle, { autoStart: false })
    provider = stubProvider('openai')
    agent.setLLMProvider(provider as never, 'gpt-4o')
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as never)
    agent.start()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('threads the live resolver into the port the task loop is handed', async () => {
    const resolver = vi.fn<ImageInputResolver>(() => ({
      capability: { state: 'supported', evidence: EVIDENCE },
    }))
    agent.setImageInputResolver(resolver)

    let seenMessages: ChatMessage[] = []
    let seenResult: RespondResult | undefined
    vi.mocked(runToolUseLoop).mockImplementation(async (config, messages) => {
      seenMessages = messages
      seenResult = await dispatchThroughReasoning(config, messages)
      return { type: 'response', content: 'ok', usage: usage() }
    })

    const task = imageTask()
    await agent.executeTask(task)

    // The executor assembled the composer image onto the last user message…
    const last = seenMessages.at(-1)
    expect(last?.role).toBe('user')
    expect(last?.contentParts).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'image', mimeType: 'image/png', data: IMAGE_B64 },
    ])

    // …and the port behind that real reasoning call consulted the live catalog
    // for the exact pair before dispatching, instead of failing closed.
    expect(resolver).toHaveBeenCalledWith('openai', 'gpt-4o')
    expect(provider.completeSingleTurnWithTools).toHaveBeenCalledTimes(1)
    expect(seenResult?.type).toBe('text')

    // The image survived the adapter: the provider received the content parts
    // rather than a stripped text-only message.
    const sentMessages = provider.completeSingleTurnWithTools.mock.calls[0]?.[0] as ChatMessage[]
    expect(sentMessages.at(-1)?.contentParts).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'image', mimeType: 'image/png', data: IMAGE_B64 },
    ])

    expect(task.responseCallback).toHaveBeenCalledWith(expect.objectContaining({ response: 'ok' }))
  })

  it('leaves a text-only turn untouched, even with a cold resolver', async () => {
    // A resolver that knows nothing about the pair: `unknown`, not support.
    const resolver = vi.fn<ImageInputResolver>(() => ({
      capability: { state: 'unknown' },
    }))
    agent.setImageInputResolver(resolver)

    let seenResult: RespondResult | undefined
    vi.mocked(runToolUseLoop).mockImplementation(async (config, messages) => {
      seenResult = await dispatchThroughReasoning(config, messages)
      return { type: 'response', content: 'ok', usage: usage() }
    })

    const task = imageTask('chat-text')
    delete (task.sourceMessage as { attachments?: unknown }).attachments
    await agent.executeTask(task)

    expect(seenResult?.type).toBe('text')
    expect(provider.completeSingleTurnWithTools).toHaveBeenCalledTimes(1)
    // No image in the request → the guard never consults the catalog.
    expect(resolver).not.toHaveBeenCalled()
    expect(task.responseCallback).toHaveBeenCalledWith(expect.objectContaining({ response: 'ok' }))
  })

  it('refuses an image whose evidence expired instead of dropping it into a text-only turn', async () => {
    // A validity window that has closed: `checkedAt < validUntil <= now`. The
    // adapter reads the real clock, so the window is set well in the past.
    const resolver = vi.fn<ImageInputResolver>(() => ({
      capability: {
        state: 'supported',
        evidence: {
          ...EVIDENCE,
          checkedAt: '2026-01-01T00:00:00Z',
          validUntil: '2026-02-01T00:00:00Z',
        },
      },
    }))
    agent.setImageInputResolver(resolver)

    let seenResult: RespondResult | undefined
    vi.mocked(runToolUseLoop).mockImplementation(async (config, messages) => {
      seenResult = await dispatchThroughReasoning(config, messages)
      return { type: 'response', content: 'handled', usage: usage() }
    })

    await agent.executeTask(imageTask('chat-expired'))

    expect(seenResult?.type).toBe('error')
    const error = errorOf(seenResult)
    expect(error).toBeInstanceOf(LlmError)
    // Expired evidence degrades to `unknown`, never to a silent text-only send.
    expect(error?.code).toBe(LlmErrorCode.ImageInputUnknown)
    expect(error?.message).toContain('expired')
    expect(provider.completeSingleTurnWithTools).not.toHaveBeenCalled()
  })

  it('re-checks the pair when an approval resumes and never sends the image after a change', async () => {
    let state: 'supported' | 'unsupported' = 'supported'
    const resolver = vi.fn<ImageInputResolver>(() => ({
      capability: { state, evidence: EVIDENCE },
    }))
    agent.setImageInputResolver(resolver)

    let resumedMessages: ChatMessage[] = []
    let resumedResult: RespondResult | undefined
    vi.mocked(runToolUseLoop)
      // First pass: suspend for approval with a snapshot that already carries
      // the image (this is what the resumed turn replays verbatim).
      .mockImplementationOnce(async () => ({
        type: 'need_approval',
        approval: {
          request_id: 'req-1',
          tool_name: 'shell_exec',
          parameters: { command: 'ls' },
          description: 'Shell command',
          tool_call_id: 'tc_1',
          context_snapshot: [imageMessage()],
        },
      }))
      // Resume: dispatch through the SAME reasoning port the executor rebuilt.
      .mockImplementationOnce(async (config, messages) => {
        resumedMessages = messages
        resumedResult = await dispatchThroughReasoning(config, messages)
        return { type: 'response', content: 'done', usage: usage() }
      })
    vi.mocked(executeSingleTool).mockResolvedValue({
      tool_call_id: 'tc_1',
      name: 'shell_exec',
      content: '<tool_output tool="shell_exec">ok</tool_output>',
      is_error: false,
    })

    const task = imageTask('chat-approval')
    await agent.executeTask(task)
    expect(agent.getState()).toBe('waiting_approval')

    // The user's model lost image support while the approval was pending.
    const resolverCallsBefore = resolver.mock.calls.length
    const providerCallsBefore = provider.completeSingleTurnWithTools.mock.calls.length
    state = 'unsupported'

    await agent.handleApproval('user-1', 'req-1', false)
    await vi.waitFor(() => expect(task.responseCallback).toHaveBeenCalled())

    // The resumed attempt re-consulted the catalog for the same pair…
    expect(resolver.mock.calls.length).toBeGreaterThan(resolverCallsBefore)
    expect(resolver).toHaveBeenCalledWith('openai', 'gpt-4o')
    // …the request really carried the image (so the refusal is about the image,
    // not about an empty request)…
    expect(resumedMessages.some(m => m.contentParts?.some(p => p.type === 'image'))).toBe(true)
    // …and the provider was never called with it.
    expect(provider.completeSingleTurnWithTools.mock.calls.length).toBe(providerCallsBefore)
    expect(resumedResult?.type).toBe('error')
    expect(errorOf(resumedResult)?.code).toBe(LlmErrorCode.ImageInputUnsupported)
    expect(task.responseCallback).toHaveBeenCalled()
  })

  it('threads the live resolver into the manual /compact port', async () => {
    const resolver = vi.fn<ImageInputResolver>(() => ({
      capability: { state: 'supported', evidence: EVIDENCE },
    }))
    agent.setImageInputResolver(resolver)

    const cm = agent.getConversationManager()
    // The force-summarize tier keeps the last 5 turns, so the session needs more
    // than that before any turn is archived and the summarizer calls the port.
    const conv = await cm.getOrCreate(SESSION_KEY)
    for (let i = 0; i < 8; i++) {
      await cm.startTurn(conv, `user ${i}`, `task-${i}`)
      await cm.completeTurn(conv, `assistant ${i}`)
    }

    // Capture the adapter the compactor really uses.
    const compactPorts: LlmPortAdapter[] = []
    vi.spyOn(LlmPortAdapter.prototype, 'complete').mockImplementation(async function (
      this: LlmPortAdapter
    ) {
      if (!compactPorts.includes(this)) compactPorts.push(this)
      return {
        content: 'summary of the archived turns',
        usage: usage(),
        finish_reason: FinishReason.Stop,
      } as never
    })

    const result = await agent.compactSession({ sessionKey: SESSION_KEY })
    expect(result.kind).toBe('ok')
    expect(compactPorts).toHaveLength(1)

    // Contract note: today's compaction converts archived turns to markdown
    // text (`contextManager.ts` `formatTurnsAsMarkdown`) and sends a text-only
    // summarization request, so no archived image can reach this port. What is
    // asserted here is the WIRING: the port the compactor uses is the one
    // carrying the live resolver, and it enforces it for an image request.
    // The captured adapter is the compact port: same pair, and the injected
    // resolver is the one wired on the state machine.
    await compactPorts[0].completeWithTools({ messages: [imageMessage()], tools: [] })
    expect(resolver).toHaveBeenCalledWith('openai', 'gpt-4o')
    expect(provider.completeSingleTurnWithTools).toHaveBeenCalledTimes(1)
  })

  it('keeps an unwired compact port failing closed on images but not on text', async () => {
    // No `setImageInputResolver` call at all: a cold host.
    const cm = agent.getConversationManager()
    const conv = await cm.getOrCreate(SESSION_KEY)
    for (let i = 0; i < 8; i++) {
      await cm.startTurn(conv, `user ${i}`, `task-${i}`)
      await cm.completeTurn(conv, `assistant ${i}`)
    }

    const compactPorts: LlmPortAdapter[] = []
    vi.spyOn(LlmPortAdapter.prototype, 'complete').mockImplementation(async function (
      this: LlmPortAdapter
    ) {
      if (!compactPorts.includes(this)) compactPorts.push(this)
      return {
        content: 'summary of the archived turns',
        usage: usage(),
        finish_reason: FinishReason.Stop,
      } as never
    })

    // Compaction itself is text-only, so a cold catalog must not break it.
    const result = await agent.compactSession({ sessionKey: SESSION_KEY })
    expect(result.kind).toBe('ok')
    expect(compactPorts).toHaveLength(1)

    await expect(
      compactPorts[0].completeWithTools({ messages: [imageMessage()], tools: [] })
    ).rejects.toMatchObject({
      code: LlmErrorCode.ImageInputUnknown,
      retryable: false,
    })
    expect(provider.completeSingleTurnWithTools).not.toHaveBeenCalled()
  })

  it('a screenshot tool does not terminate a text-only task on an unverified model', async () => {
    // A cold catalog: the pair resolves to `unknown`, which refuses a USER
    // image. The task below never carries one — the image comes back from the
    // agent's own tool, and that must not end the task.
    const resolver = vi.fn<ImageInputResolver>(() => ({
      capability: { state: 'unknown' },
    }))
    agent.setImageInputResolver(resolver)

    const collectedAttachments: Attachment[] = []
    let seenResult: RespondResult | undefined
    vi.mocked(runToolUseLoop).mockImplementation(async (config, messages) => {
      // The real message builder, so the `imageOrigin` flag under test is the
      // one production writes rather than one this test invents.
      appendToolResults(
        messages,
        [
          {
            tool_call_id: 'tc_1',
            name: 'browser__screenshot',
            content: 'captured the page',
            is_error: false,
            attachments: [
              {
                id: 'shot-1',
                kind: 'image',
                mimeType: 'image/png',
                encoding: 'base64',
                dataBase64: IMAGE_B64,
                sourceTool: 'browser__screenshot',
              } as unknown as Attachment,
            ],
          },
        ],
        collectedAttachments
      )
      seenResult = await dispatchThroughReasoning(config, messages)
      return { type: 'response', content: 'ok', usage: usage(), attachments: collectedAttachments }
    })

    const task = imageTask('chat-tool-shot')
    delete (task.sourceMessage as { attachments?: unknown }).attachments
    await agent.executeTask(task)

    // Witness: the turn reached the model and came back as text, not as a
    // typed image refusal.
    expect(seenResult?.type).toBe('text')
    expect(errorOf(seenResult)).toBeUndefined()
    expect(provider.completeSingleTurnWithTools).toHaveBeenCalledTimes(1)
    expect(resolver).toHaveBeenCalledWith('openai', 'gpt-4o')

    // The screenshot was withheld from the wire and replaced by the notice.
    const sent = provider.completeSingleTurnWithTools.mock.calls[0]?.[0] as ChatMessage[]
    const screenshotMessage = sent.at(-1)
    expect(screenshotMessage?.contentParts).toBeUndefined()
    expect(screenshotMessage?.content).toContain('were not forwarded')

    // …and it still reaches the user as an attachment on the reply: withholding
    // is about what the MODEL can read, not about discarding the bytes.
    expect(collectedAttachments).toHaveLength(1)
    expect(task.responseCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        response: 'ok',
        attachments: [expect.objectContaining({ id: 'shot-1', kind: 'image' })],
      })
    )
  })
})

/**
 * The decision must also surface as a structured task error when it reaches the
 * executor's failure path, so the channel reader sees a code it can act on.
 */
describe('#654 image-input denial is a structured task error', () => {
  let agent: AgentStateMachine
  let provider: StubProvider

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runToolUseLoop).mockReset()
    vi.mocked(executeSingleTool).mockReset()
    const queue = new MessageQueue()
    const lifecycle = new TaskLifecycle()
    queue.setLifecycle(lifecycle)
    agent = new AgentStateMachine(queue, lifecycle, { autoStart: false })
    provider = stubProvider('openai')
    agent.setLLMProvider(provider as never, 'gpt-4o')
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as never)
    agent.start()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('delivers LLM_IMAGE_INPUT_UNSUPPORTED to the response callback', async () => {
    agent.setImageInputResolver(() => ({
      capability: { state: 'unsupported', evidence: EVIDENCE },
    }))

    // The real loop turns a reasoning error into the loop's error result.
    vi.mocked(runToolUseLoop).mockImplementation(async config => {
      const result = await dispatchThroughReasoning(config, [imageMessage()])
      if (result.type === 'error') throw result.error
      return { type: 'response', content: 'unexpected', usage: usage() }
    })

    const task = imageTask('chat-task-error')
    await agent.executeTask(task)

    expect(task.responseCallback).toHaveBeenCalledTimes(1)
    const delivered = task.responseCallback.mock.calls[0][0] as { error?: TaskError }
    expect(delivered.error?.code).toBe(LlmErrorCode.ImageInputUnsupported)
    expect(delivered.error?.retryable).toBe(false)
    expect(delivered.error?.provider).toBe('openai')
    expect(provider.completeSingleTurnWithTools).not.toHaveBeenCalled()
  })
})
