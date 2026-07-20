import { describe, expect, it, vi } from 'vitest'
import { LlmErrorCode } from '../../../core/errors'
import { type ChatMessage, FinishReason } from '../../../core/types'
import {
  type BedrockConverseClient,
  BedrockConverseDriver,
  classifyBedrockError,
} from '../bedrockConverse'

function mockClient(response: unknown): {
  client: BedrockConverseClient
  converse: ReturnType<typeof vi.fn>
} {
  const converse = vi.fn(async () => response)
  return { client: { converse } as unknown as BedrockConverseClient, converse }
}

const MODEL = 'anthropic.claude-sonnet-4-6-v1:0'

describe('BedrockConverseDriver — provider type', () => {
  it('reports bedrock', () => {
    const { client } = mockClient({})
    expect(new BedrockConverseDriver(client, MODEL).getProviderType()).toBe('bedrock')
  })
})

describe('BedrockConverseDriver — text + system', () => {
  it('routes system messages to the system block list and returns text/usage', async () => {
    const { client, converse } = mockClient({
      output: { message: { content: [{ text: 'Hi back' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    })
    const driver = new BedrockConverseDriver(client, MODEL)

    const res = await driver.completeSingleTurn([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'Hi' },
    ])

    const req = converse.mock.calls[0][0]
    expect(req.modelId).toBe(MODEL)
    expect(req.system).toEqual([{ text: 'Be terse.' }])
    expect(req.messages).toEqual([{ role: 'user', content: [{ text: 'Hi' }] }])
    expect(res.content).toBe('Hi back')
    expect(res.usage).toEqual({ input_tokens: 12, output_tokens: 5, total_tokens: 17 })
    expect(res.finish_reason).toBe(FinishReason.Stop)
  })

  it('maps user contentParts images to Converse image blocks (base64 → bytes)', async () => {
    const { client, converse } = mockClient({
      output: { message: { content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
    })
    const driver = new BedrockConverseDriver(client, MODEL)
    await driver.completeSingleTurn([
      {
        role: 'user',
        content: 'look',
        contentParts: [
          { type: 'text', text: 'look' },
          { type: 'image', mimeType: 'image/png', data: Buffer.from('PNG').toString('base64') },
        ],
      },
    ])
    const block = converse.mock.calls[0][0].messages[0].content[1]
    expect(block.image.format).toBe('png')
    expect(Buffer.from(block.image.source.bytes).toString()).toBe('PNG')
  })
})

describe('BedrockConverseDriver — tool round-trip', () => {
  it('emits toolConfig and returns toolUse with its opaque toolUseId', async () => {
    const { client, converse } = mockClient({
      output: {
        message: {
          content: [
            { text: 'searching' },
            { toolUse: { toolUseId: 'tu_abc', name: 'search', input: { q: 'x' } } },
          ],
        },
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 20, outputTokens: 30, totalTokens: 50 },
    })
    const driver = new BedrockConverseDriver(client, MODEL)

    const res = await driver.completeSingleTurnWithTools(
      [{ role: 'user', content: 'find x' }],
      [{ name: 'search', description: 'Search', parameters: { type: 'object' } }]
    )

    const req = converse.mock.calls[0][0]
    expect(req.toolConfig.tools[0].toolSpec).toEqual({
      name: 'search',
      description: 'Search',
      inputSchema: { json: { type: 'object' } },
    })
    expect(res.content).toBe('searching')
    expect(res.tool_calls).toEqual([{ id: 'tu_abc', name: 'search', arguments: { q: 'x' } }])
    expect(res.finish_reason).toBe(FinishReason.ToolUse)
  })

  it('omits toolConfig when there are no tools', async () => {
    const { client, converse } = mockClient({
      output: { message: { content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
    })
    await new BedrockConverseDriver(client, MODEL).completeSingleTurnWithTools(
      [{ role: 'user', content: 'hi' }],
      []
    )
    expect(converse.mock.calls[0][0].toolConfig).toBeUndefined()
  })

  it('groups consecutive tool results into ONE user message (Converse requirement)', async () => {
    const { client, converse } = mockClient({
      output: { message: { content: [{ text: 'done' }] } },
      stopReason: 'end_turn',
    })
    const driver = new BedrockConverseDriver(client, MODEL)
    const messages: ChatMessage[] = [
      { role: 'user', content: 'do both' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tu_1', name: 'a', arguments: {} },
          { id: 'tu_2', name: 'b', arguments: {} },
        ],
      },
      { role: 'tool', content: 'result A', tool_call_id: 'tu_1' },
      { role: 'tool', content: 'result B', tool_call_id: 'tu_2' },
    ]
    await driver.completeSingleTurnWithTools(messages, [])

    const msgs = converse.mock.calls[0][0].messages
    const toolResultMsgs = msgs.filter((m: { content: Array<{ toolResult?: unknown }> }) =>
      m.content.every(c => c.toolResult)
    )
    expect(toolResultMsgs).toHaveLength(1)
    expect(toolResultMsgs[0].role).toBe('user')
    expect(toolResultMsgs[0].content).toHaveLength(2)
    expect(toolResultMsgs[0].content[0].toolResult.toolUseId).toBe('tu_1')
    expect(toolResultMsgs[0].content[1].toolResult.toolUseId).toBe('tu_2')
  })
})

describe('BedrockConverseDriver — abort signal threading', () => {
  it('forwards options.signal to the client on completeSingleTurn', async () => {
    const { client, converse } = mockClient({
      output: { message: { content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
    })
    const controller = new AbortController()
    await new BedrockConverseDriver(client, MODEL).completeSingleTurn(
      [{ role: 'user', content: 'hi' }],
      { signal: controller.signal }
    )
    expect(converse.mock.calls[0][1]).toEqual({ signal: controller.signal })
  })

  it('forwards options.signal to the client on completeSingleTurnWithTools', async () => {
    const { client, converse } = mockClient({
      output: { message: { content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
    })
    const controller = new AbortController()
    await new BedrockConverseDriver(client, MODEL).completeSingleTurnWithTools(
      [{ role: 'user', content: 'hi' }],
      [],
      { signal: controller.signal }
    )
    expect(converse.mock.calls[0][1]).toEqual({ signal: controller.signal })
  })

  it('rejects an in-flight call when the signal aborts (SDK honors abortSignal)', async () => {
    // A client that respects the abortSignal the driver threads through, the
    // way the AWS SDK v3 `send(command, { abortSignal })` does.
    const client: BedrockConverseClient = {
      converse: (_input, options) =>
        new Promise((_resolve, reject) => {
          const signal = options?.signal
          if (signal?.aborted) {
            reject(new Error('aborted'))
            return
          }
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    }
    const controller = new AbortController()
    const promise = new BedrockConverseDriver(client, MODEL).completeSingleTurn(
      [{ role: 'user', content: 'hi' }],
      { signal: controller.signal }
    )
    controller.abort()
    await expect(promise).rejects.toThrow('aborted')
  })
})

describe('BedrockConverseDriver — finish reasons', () => {
  it.each([
    ['end_turn', FinishReason.Stop],
    ['stop_sequence', FinishReason.Stop],
    ['max_tokens', FinishReason.Length],
    ['tool_use', FinishReason.ToolUse],
    ['content_filtered', FinishReason.ContentFilter],
    ['future', FinishReason.Unknown],
  ] as const)('maps %s → %s', async (reason, expected) => {
    const { client } = mockClient({
      output: { message: { content: [{ text: 'x' }] } },
      stopReason: reason,
    })
    const res = await new BedrockConverseDriver(client, MODEL).completeSingleTurn([
      { role: 'user', content: 'hi' },
    ])
    expect(res.finish_reason).toBe(expected)
  })
})

describe('classifyBedrockError', () => {
  it.each([
    ['ThrottlingException', LlmErrorCode.RateLimited, true],
    ['AccessDeniedException', LlmErrorCode.AuthenticationFailed, false],
    ['UnrecognizedClientException', LlmErrorCode.AuthenticationFailed, false],
    ['ServiceQuotaExceededException', LlmErrorCode.InsufficientQuota, false],
    ['ValidationException', LlmErrorCode.ApiCallFailed, false],
    ['ServiceUnavailableException', LlmErrorCode.ModelOverloaded, true],
    ['InternalServerException', LlmErrorCode.ModelOverloaded, true],
    ['ModelTimeoutException', LlmErrorCode.ModelOverloaded, true],
  ] as const)('maps modeled exception %s', (name, code, retryable) => {
    const c = classifyBedrockError({ name, message: 'boom' })
    expect(c.code).toBe(code)
    expect(c.retryable).toBe(retryable)
    expect(c.message).toBe('boom')
  })

  it('falls back to the HTTP status in $metadata when the name is unmodeled', () => {
    const c = classifyBedrockError({
      name: 'SomeNewException',
      message: 'x',
      $metadata: { httpStatusCode: 429 },
    })
    expect(c.code).toBe(LlmErrorCode.RateLimited)
    expect(c.retryable).toBe(true)
  })

  it('falls back to ApiCallFailed(retryable) for an unrecognized shape', () => {
    const c = classifyBedrockError(new Error('socket hang up'))
    expect(c.code).toBe(LlmErrorCode.ApiCallFailed)
    expect(c.retryable).toBe(true)
  })

  it('never throws', () => {
    expect(() => classifyBedrockError(null)).not.toThrow()
    expect(() => classifyBedrockError(undefined)).not.toThrow()
  })
})
