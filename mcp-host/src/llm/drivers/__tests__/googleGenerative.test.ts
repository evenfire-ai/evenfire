import { describe, expect, it, vi } from 'vitest'
import { LlmErrorCode } from '../../../core/errors'
import { type ChatMessage, FinishReason } from '../../../core/types'
import {
  type GeminiGenerateClient,
  GoogleGenerativeDriver,
  classifyGoogleError,
} from '../googleGenerative'

function mockClient(response: unknown): {
  client: GeminiGenerateClient
  generateContent: ReturnType<typeof vi.fn>
} {
  const generateContent = vi.fn(async () => response)
  return { client: { generateContent } as unknown as GeminiGenerateClient, generateContent }
}

describe('GoogleGenerativeDriver — provider type', () => {
  it('reports vertex', () => {
    const { client } = mockClient({})
    expect(new GoogleGenerativeDriver(client, 'gemini-2.5-pro').getProviderType()).toBe('vertex')
  })
})

describe('GoogleGenerativeDriver — text + system', () => {
  it('routes system messages to systemInstruction and returns text/usage', async () => {
    const { client, generateContent } = mockClient({
      candidates: [{ content: { parts: [{ text: 'Hello there' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4, totalTokenCount: 15 },
    })
    const driver = new GoogleGenerativeDriver(client, 'gemini-2.5-pro')

    const res = await driver.completeSingleTurn([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ])

    const req = generateContent.mock.calls[0][0]
    expect(req.config.systemInstruction).toBe('You are helpful.')
    expect(req.contents).toEqual([{ role: 'user', parts: [{ text: 'Hi' }] }])
    expect(res.content).toBe('Hello there')
    expect(res.usage).toEqual({ input_tokens: 11, output_tokens: 4, total_tokens: 15 })
    expect(res.finish_reason).toBe(FinishReason.Stop)
  })

  it('maps user contentParts images to inlineData', async () => {
    const { client, generateContent } = mockClient({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    })
    const driver = new GoogleGenerativeDriver(client, 'gemini-2.5-pro')
    await driver.completeSingleTurn([
      {
        role: 'user',
        content: 'see this',
        contentParts: [
          { type: 'text', text: 'see this' },
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        ],
      },
    ])
    const req = generateContent.mock.calls[0][0]
    expect(req.contents[0].parts).toEqual([
      { text: 'see this' },
      { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
    ])
  })
})

describe('GoogleGenerativeDriver — tool round-trip', () => {
  it('synthesizes opaque ids for functionCalls and reports ToolUse', async () => {
    const { client } = mockClient({
      candidates: [
        {
          content: {
            parts: [
              { text: 'let me search' },
              { functionCall: { name: 'search', args: { q: 'x' } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 30, totalTokenCount: 50 },
    })
    const driver = new GoogleGenerativeDriver(client, 'gemini-2.5-pro')

    const res = await driver.completeSingleTurnWithTools(
      [{ role: 'user', content: 'find x' }],
      [{ name: 'search', description: 'Search', parameters: { type: 'object' } }]
    )

    expect(res.content).toBe('let me search')
    expect(res.tool_calls).toHaveLength(1)
    expect(res.tool_calls![0]).toEqual({ id: 'call_0', name: 'search', arguments: { q: 'x' } })
    expect(res.finish_reason).toBe(FinishReason.ToolUse)
  })

  it('omits the tools field when there are no tools (Gemini rejects empty)', async () => {
    const { client, generateContent } = mockClient({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    })
    const driver = new GoogleGenerativeDriver(client, 'gemini-2.5-pro')
    await driver.completeSingleTurnWithTools([{ role: 'user', content: 'hi' }], [])
    expect(generateContent.mock.calls[0][0].config.tools).toBeUndefined()
  })

  it('translates an assistant tool_call turn and a tool result into contents (name recovered by id)', async () => {
    const { client, generateContent } = mockClient({
      candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
    })
    const driver = new GoogleGenerativeDriver(client, 'gemini-2.5-pro')
    const messages: ChatMessage[] = [
      { role: 'user', content: 'search x' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_0', name: 'search', arguments: { q: 'x' } }],
      },
      // Tool message WITHOUT `name` — the driver recovers it from the id→name map.
      { role: 'tool', content: 'found', tool_call_id: 'call_0' },
    ]
    await driver.completeSingleTurnWithTools(messages, [])

    const contents = generateContent.mock.calls[0][0].contents
    // assistant → role 'model' with functionCall
    const modelTurn = contents.find(
      (c: { role: string; parts: Array<{ functionCall?: unknown }> }) => c.role === 'model'
    )
    expect(modelTurn.parts[0].functionCall).toEqual({ name: 'search', args: { q: 'x' } })
    // tool → role 'user' functionResponse keyed by the recovered name
    const fnResp = contents
      .flatMap((c: { parts: Array<{ functionResponse?: { name: string } }> }) => c.parts)
      .find((p: { functionResponse?: { name: string } }) => p.functionResponse)
    expect(fnResp.functionResponse.name).toBe('search')
    expect(fnResp.functionResponse.response).toEqual({ result: 'found' })
  })
})

describe('GoogleGenerativeDriver — finish reasons', () => {
  it.each([
    ['STOP', FinishReason.Stop],
    ['MAX_TOKENS', FinishReason.Length],
    ['SAFETY', FinishReason.ContentFilter],
    ['SOMETHING_NEW', FinishReason.Unknown],
  ] as const)('maps %s → %s', async (reason, expected) => {
    const { client } = mockClient({
      candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: reason }],
    })
    const res = await new GoogleGenerativeDriver(client, 'gemini-2.5-pro').completeSingleTurn([
      { role: 'user', content: 'hi' },
    ])
    expect(res.finish_reason).toBe(expected)
  })
})

describe('classifyGoogleError', () => {
  it.each([
    [{ status: 429 }, LlmErrorCode.RateLimited, true],
    [{ status: 403 }, LlmErrorCode.AuthenticationFailed, false],
    [{ status: 401 }, LlmErrorCode.AuthenticationFailed, false],
    [{ status: 503 }, LlmErrorCode.ModelOverloaded, true],
    [{ status: 400 }, LlmErrorCode.ApiCallFailed, false],
  ] as const)('maps http status %o', (err, code, retryable) => {
    const c = classifyGoogleError(err)
    expect(c.code).toBe(code)
    expect(c.retryable).toBe(retryable)
  })

  it.each([
    ['RESOURCE_EXHAUSTED', LlmErrorCode.RateLimited, true],
    ['PERMISSION_DENIED', LlmErrorCode.AuthenticationFailed, false],
    ['UNAUTHENTICATED', LlmErrorCode.AuthenticationFailed, false],
    ['UNAVAILABLE', LlmErrorCode.ModelOverloaded, true],
    ['INVALID_ARGUMENT', LlmErrorCode.ApiCallFailed, false],
  ] as const)('maps gRPC status string %s', (status, code, retryable) => {
    const c = classifyGoogleError({ status })
    expect(c.code).toBe(code)
    expect(c.retryable).toBe(retryable)
  })

  it('falls back to ApiCallFailed(retryable) for an unrecognized shape', () => {
    const c = classifyGoogleError(new Error('socket hang up'))
    expect(c.code).toBe(LlmErrorCode.ApiCallFailed)
    expect(c.retryable).toBe(true)
    expect(c.message).toBe('socket hang up')
  })

  it('never throws', () => {
    expect(() => classifyGoogleError(null)).not.toThrow()
    expect(() => classifyGoogleError(undefined)).not.toThrow()
  })
})
