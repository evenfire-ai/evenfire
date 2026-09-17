/**
 * Issue #654 — the Claude TOOL role is the one image position that travels
 * inside a `tool_result` block, and the only reason
 * `transportSupportsImageInput('claude', <tool-bearing op>, 'tool')` may answer
 * `true`. `mcp-host/src/llm/__tests__/imageInputTransport.test.ts` proves the
 * matrix for the ORDINARY `user` role only; this suite proves the tool-role cell
 * against the REAL `ClaudeProvider` serializer with the Anthropic SDK client
 * intercepted, so an authorized tool-role image cannot be dropped between the
 * guard and the wire, and a family that cannot carry it never reaches its SDK.
 *
 * Both tool-bearing Claude transports are covered (`completeWithTools` and the
 * cache-aware `completeWithToolsAndCache`) because the adapter chooses between
 * them at dispatch time and the chat loop can reach either.
 *
 * Coverage note: the loop's only tool-image producer (`appendToolResults` in
 * `core/orchestration/toolUseLoopMessages.ts`) currently relays collected tool
 * images on a separate `user` message, so this suite is what keeps the ROLE
 * MATRIX honest — `IMAGE_ROLES_BY_FAMILY.claude` authorizes `tool`, and the
 * serializer below really implements it — rather than a description of today's
 * loop shape.
 */
import { describe, expect, it, vi } from 'vitest'
import { LlmPortAdapter } from '../../core/adapters/llmPortAdapter'
import { LlmError, LlmErrorCode } from '../../core/errors'
import type { SystemPromptParts } from '../../core/reasoning/systemPrompt'
import type { ChatMessage } from '../../core/types'
import { ClaudeProvider } from '../claude'
import type { ImageInputResolver } from '../imageInput'
import { OpenAIProvider } from '../openai'

const EVIDENCE = {
  source: 'curated' as const,
  reference: 'https://docs.anthropic.com/en/docs/build-with-claude/vision',
  checkedAt: '2026-09-16T00:00:00Z',
}

/**
 * Canonical base64 for the bytes `ABC`. Real image bytes are not needed: the
 * adapter validates the encoding SHAPE, not the image, and these tests assert
 * structure on the wire. Keeping the fixture canonical keeps the guard's own
 * validation (which rejects non-canonical base64) out of the assertion path.
 */
const IMAGE_B64 = 'QUJD'
const TOOL_TEXT = 'tool output'

const allowResolver: ImageInputResolver = () => ({
  capability: { state: 'supported', evidence: EVIDENCE },
  policyAllowed: true,
})

function parts(): SystemPromptParts {
  return { stable: 'stable', context: 'context', stableHash: 'h1', contextHash: 'h2' }
}

/**
 * The real Claude tool-call sequence: the user attaches an image, the assistant
 * asks for a tool, and the tool returns a text block plus an image. The tool
 * result is the position under test.
 */
function toolImageConversation(): ChatMessage[] {
  return [
    {
      role: 'user',
      content: 'look at this',
      contentParts: [
        { type: 'text', text: 'look at this' },
        { type: 'image', mimeType: 'image/png', data: IMAGE_B64 },
      ],
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc_1', name: 'lookup', arguments: { q: 'x' } }],
    },
    {
      role: 'tool',
      content: TOOL_TEXT,
      tool_call_id: 'tc_1',
      name: 'lookup',
      contentParts: [
        { type: 'text', text: TOOL_TEXT },
        { type: 'image', mimeType: 'image/png', data: IMAGE_B64 },
      ],
    },
  ]
}

/** The same shape with a text-only tool result (the unchanged ordinary path). */
function toolTextConversation(): ChatMessage[] {
  return [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc_1', name: 'lookup', arguments: { q: 'x' } }],
    },
    { role: 'tool', content: TOOL_TEXT, tool_call_id: 'tc_1', name: 'lookup' },
  ]
}

const CLAUDE_OK = {
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
}
const OPENAI_OK = {
  choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

type WireBlock = {
  type: string
  text?: string
  tool_use_id?: string
  content?: WireBlock[] | string
  source?: { type?: string; media_type?: string; data?: string }
  cache_control?: unknown
}
type WireMessage = { role: string; content: string | WireBlock[] }
type WirePayload = { messages?: WireMessage[]; system?: WireBlock[] }

function blocksOf(content: string | WireBlock[] | undefined): WireBlock[] | undefined {
  return Array.isArray(content) ? content : undefined
}

function wireMessages(wire: unknown): WireMessage[] {
  return (wire as WirePayload).messages ?? []
}

/** The `tool_result` blocks on the wire, flattened across messages. */
function toolResultBlocks(wire: unknown): WireBlock[] {
  const blocks: WireBlock[] = []
  for (const message of wireMessages(wire)) {
    for (const block of blocksOf(message.content) ?? []) {
      if (block.type === 'tool_result') blocks.push(block)
    }
  }
  return blocks
}

/** Every `image` block on the wire, at message level or nested in a tool result. */
function imageBlocks(wire: unknown): WireBlock[] {
  const blocks: WireBlock[] = []
  const pushImages = (list: WireBlock[] | undefined): void => {
    for (const block of list ?? []) if (block.type === 'image') blocks.push(block)
  }
  for (const message of wireMessages(wire)) {
    const content = blocksOf(message.content)
    pushImages(content)
    for (const block of content ?? []) {
      if (block.type === 'tool_result') pushImages(blocksOf(block.content))
    }
  }
  return blocks
}

function claudeAdapter(
  create: ReturnType<typeof vi.fn>,
  model: string,
  resolver: ImageInputResolver
): { adapter: LlmPortAdapter; provider: ClaudeProvider } {
  const provider = new ClaudeProvider({ messages: { create } } as never, model)
  const adapter = new LlmPortAdapter(
    provider,
    model,
    'claude',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    resolver
  )
  return { adapter, provider }
}

describe('#654 Claude tool-role image serialization (real serializer)', () => {
  it('carries the tool image inside a tool_result block through completeWithTools', async () => {
    const create = vi.fn(async (_input: unknown) => CLAUDE_OK)
    const resolver = vi.fn(allowResolver)
    const { adapter } = claudeAdapter(create, 'claude-sonnet-4-6', resolver)

    await adapter.completeWithTools({ messages: toolImageConversation(), tools: [] })

    // The guard ran against the real pair…
    expect(resolver).toHaveBeenCalledWith('claude', 'claude-sonnet-4-6')
    // …the image was NOT silently removed…
    expect(create).toHaveBeenCalledTimes(1)
    const wire = create.mock.calls[0]?.[0]

    const toolResults = toolResultBlocks(wire)
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0].tool_use_id).toBe('tc_1')
    // …and the tool result really is the multi-block form, not the string form.
    expect(toolResults[0].content).toEqual([
      { type: 'text', text: TOOL_TEXT },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMAGE_B64 } },
    ])

    // The user-role image from the same request is present too, so the
    // assertion above is about the tool block rather than an empty request.
    expect(imageBlocks(wire)).toHaveLength(2)
  })

  it('carries the tool image through the cache-aware tool method and keeps cache_control', async () => {
    const create = vi.fn(async (_input: unknown) => CLAUDE_OK)
    const { adapter, provider } = claudeAdapter(create, 'claude-sonnet-4-6', allowResolver)
    const cacheSpy = vi.spyOn(provider, 'completeSingleTurnWithToolsAndCache')
    const legacySpy = vi.spyOn(provider, 'completeSingleTurnWithTools')

    await adapter.completeWithTools({
      messages: toolImageConversation(),
      tools: [],
      systemPromptParts: parts(),
    })

    // The cache-aware arm is the one that really ran…
    expect(cacheSpy).toHaveBeenCalledTimes(1)
    expect(legacySpy).not.toHaveBeenCalled()

    const wire = create.mock.calls[0]?.[0]
    // …it still emits the tool_result image…
    expect(toolResultBlocks(wire)).toHaveLength(1)
    expect(imageBlocks(wire)).toHaveLength(2)
    // …and it kept the cache markers that distinguish it from the legacy path.
    const system = (wire as WirePayload).system ?? []
    expect(system.length).toBeGreaterThan(0)
    expect(system.every(block => block.cache_control)).toBe(true)
  })

  it('refuses a tool-role image on a family whose wire has no tool-image position', async () => {
    const create = vi.fn(async (_input: unknown) => OPENAI_OK)
    const provider = new OpenAIProvider({ chat: { completions: { create } } } as never, 'gpt-4o')
    const adapter = new LlmPortAdapter(
      provider,
      'gpt-4o',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      allowResolver
    )

    await expect(
      adapter.completeWithTools({ messages: toolImageConversation(), tools: [] })
    ).rejects.toMatchObject({
      code: LlmErrorCode.ImageInputUnsupported,
      retryable: false,
      provider: 'openai',
    })
    // Role admission is a real decision, not a label: nothing reached the SDK.
    expect(create).not.toHaveBeenCalled()
  })

  it('keeps a text-only tool result in the plain string form (the branch images change)', async () => {
    const create = vi.fn(async (_input: unknown) => CLAUDE_OK)
    const { adapter } = claudeAdapter(create, 'claude-sonnet-4-6', allowResolver)

    await adapter.completeWithTools({ messages: toolTextConversation(), tools: [] })

    const toolResults = toolResultBlocks(create.mock.calls[0]?.[0])
    expect(toolResults).toHaveLength(1)
    // Without `contentParts` the serializer keeps `msg.content`, which is what
    // makes the array form above evidence of the image path specifically.
    expect(toolResults[0].content).toBe(TOOL_TEXT)
    expect(imageBlocks(create.mock.calls[0]?.[0])).toHaveLength(0)
  })

  it('surfaces the denial as a typed terminal error and never classifies it', async () => {
    // The refusal must not be handed to `classifyError`, which would make it
    // retryable and turn one rejected image into a retry storm.
    const create = vi.fn(async (_input: unknown) => CLAUDE_OK)
    const provider = new ClaudeProvider({ messages: { create } } as never, 'claude-sonnet-4-6')
    const classifyError = vi.spyOn(provider, 'classifyError')
    const adapter = new LlmPortAdapter(
      provider,
      'claude-sonnet-4-6',
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({ capability: { state: 'unsupported', evidence: EVIDENCE }, policyAllowed: true })
    )

    let error: unknown
    try {
      await adapter.completeWithTools({ messages: toolImageConversation(), tools: [] })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).retryable).toBe(false)
    expect((error as LlmError).code).toBe(LlmErrorCode.ImageInputUnsupported)
    expect(classifyError).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })
})
