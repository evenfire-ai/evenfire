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

  it('names a bridged tool result after the clerum__tool_call functionCall, not the real tool', async () => {
    const { client, generateContent } = mockClient({
      candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
    })
    const driver = new GoogleGenerativeDriver(client, 'gemini-2.5-pro')
    const bridged = { name: 'clerum__generate_pptx', arguments: { title: 'Deck' } }
    const messages: ChatMessage[] = [
      { role: 'user', content: 'make a deck' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_bridge', name: 'clerum__tool_call', arguments: bridged }],
      },
      // The loop names a bridged result after the REAL tool it executed.
      {
        role: 'tool',
        name: 'clerum__generate_pptx',
        content: 'File generated: deck.pptx (pptx)',
        tool_call_id: 'call_bridge',
      },
      // Witness: a result whose id matches no functionCall keeps its own name.
      { role: 'tool', name: 'orphan_tool', content: 'orphan', tool_call_id: 'unknown' },
    ]
    await driver.completeSingleTurnWithTools(messages, [])

    const contents = generateContent.mock.calls[0][0].contents
    const call = contents
      .flatMap((c: { parts: Array<{ functionCall?: { name: string } }> }) => c.parts)
      .find((p: { functionCall?: { name: string } }) => p.functionCall)
    const responses = contents
      .flatMap((c: { parts: Array<{ functionResponse?: { name: string } }> }) => c.parts)
      .filter((p: { functionResponse?: { name: string } }) => p.functionResponse)
      .map((p: { functionResponse: { name: string } }) => p.functionResponse.name)
    expect(call.functionCall).toEqual({ name: 'clerum__tool_call', args: bridged })
    expect(responses).toEqual(['clerum__tool_call', 'orphan_tool'])
  })

  it('names each result after its own turn when the driver reuses call ids across turns', async () => {
    const callResponse = (name: string) => ({
      candidates: [
        { content: { parts: [{ functionCall: { name, args: {} } }] }, finishReason: 'STOP' },
      ],
    })
    const { client, generateContent } = mockClient({
      candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
    })
    generateContent
      .mockResolvedValueOnce(callResponse('web_search'))
      .mockResolvedValueOnce(callResponse('file_read'))
    const driver = new GoogleGenerativeDriver(client, 'gemini-2.5-pro')

    // Drive three real turns, appending history the way the tool loop does.
    const history: ChatMessage[] = [{ role: 'user', content: 'research and read' }]
    const results: Record<string, string> = {
      web_search: 'search result',
      file_read: 'file content',
    }
    const mintedIds: string[] = []
    for (let turn = 0; turn < 2; turn++) {
      const res = await driver.completeSingleTurnWithTools(history, [])
      const toolCalls = res.tool_calls ?? []
      expect(toolCalls).toHaveLength(1)
      mintedIds.push(toolCalls[0].id)
      history.push({ role: 'assistant', content: '', tool_calls: toolCalls })
      history.push({
        role: 'tool',
        name: toolCalls[0].name,
        content: results[toolCalls[0].name],
        tool_call_id: toolCalls[0].id,
      })
    }
    await driver.completeSingleTurnWithTools(history, [])

    // Witness: the driver really minted the same id in both turns.
    expect(mintedIds).toEqual(['call_0', 'call_0'])
    const wire = generateContent.mock.calls[2][0].contents.flatMap(
      (c: {
        parts: Array<{
          functionCall?: { name: string }
          functionResponse?: { name: string; response: { result: string } }
        }>
      }) =>
        c.parts.flatMap(p =>
          p.functionCall
            ? [`call:${p.functionCall.name}`]
            : p.functionResponse
              ? [`resp:${p.functionResponse.name}=${p.functionResponse.response.result}`]
              : []
        )
    )
    expect(wire).toEqual([
      'call:web_search',
      'resp:web_search=search result',
      'call:file_read',
      'resp:file_read=file content',
    ])
  })

  it('resolves an id only against the preceding assistant turn', async () => {
    const { client, generateContent } = mockClient({
      candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
    })
    const driver = new GoogleGenerativeDriver(client, 'gemini-2.5-pro')
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_0', name: 'search', arguments: {} }],
      },
      { role: 'tool', name: 'search', content: 'r1', tool_call_id: 'call_0' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', name: 'file_read', arguments: {} }],
      },
      // Witness: an id of this turn resolves through the map.
      { role: 'tool', content: 'r2', tool_call_id: 'call_1' },
      // `call_0` belongs to the earlier turn, not this one: the message keeps its own name.
      { role: 'tool', name: 'late_result', content: 'r3', tool_call_id: 'call_0' },
    ]
    await driver.completeSingleTurnWithTools(messages, [])

    const responses = generateContent.mock.calls[0][0].contents
      .flatMap((c: { parts: Array<{ functionResponse?: { name: string } }> }) => c.parts)
      .filter((p: { functionResponse?: { name: string } }) => p.functionResponse)
      .map((p: { functionResponse: { name: string } }) => p.functionResponse.name)
    expect(responses).toEqual(['search', 'file_read', 'late_result'])
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
    [{ status: 404 }, LlmErrorCode.ModelNotAvailable, false],
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
    ['NOT_FOUND', LlmErrorCode.ModelNotAvailable, false],
    ['UNAVAILABLE', LlmErrorCode.ModelOverloaded, true],
    ['INVALID_ARGUMENT', LlmErrorCode.ApiCallFailed, false],
  ] as const)('maps gRPC status string %s', (status, code, retryable) => {
    const c = classifyGoogleError({ status })
    expect(c.code).toBe(code)
    expect(c.retryable).toBe(retryable)
  })

  it('propagates httpStatus for a numeric-status error', () => {
    const c = classifyGoogleError({ status: 404, message: 'model gone' })
    expect(c.code).toBe(LlmErrorCode.ModelNotAvailable)
    expect(c.httpStatus).toBe(404)
  })

  it('propagates the gRPC status string as providerCode', () => {
    const c = classifyGoogleError({ status: 'NOT_FOUND', message: 'model gone' })
    expect(c.code).toBe(LlmErrorCode.ModelNotAvailable)
    expect(c.providerCode).toBe('NOT_FOUND')
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
