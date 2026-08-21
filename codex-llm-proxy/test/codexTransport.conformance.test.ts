import { hashCodexCompletionRequestV1 } from '@clerum/llm-provider-attempt-contract'
import { describe, expect, it, vi } from 'vitest'
import { CodexTransportError, streamCodexCompletion } from '../src/codexTransport.js'
import type { RedeemAttemptSuccess } from '../src/controlApiClient.js'
import { CODEX_COMPLETIONS_ORIGIN } from '../src/originPolicy.js'

const REQUEST = {
  schemaVersion: 'codex-completion-request.v1' as const,
  requestId: 'req-001',
  idempotencyKey: 'idem-001',
  provider: 'codex-subscription' as const,
  model: 'gpt-5.1',
  messages: [{ role: 'user' as const, content: 'hello' }],
}

const REQUEST_HASH = hashCodexCompletionRequestV1(REQUEST)

function accessTokenFor(label: string): string {
  const encoded = Buffer.from(
    JSON.stringify({
      sub: label,
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_live_1' },
    })
  ).toString('base64url')
  return `hdr.${encoded}.sig`
}

function redeemSuccess(overrides: Partial<RedeemAttemptSuccess> = {}): RedeemAttemptSuccess {
  return {
    accessToken: accessTokenFor('live'),
    transport: {
      protocolVersion: 'codex-subscription-transport.v1',
      completionsOrigin: CODEX_COMPLETIONS_ORIGIN,
      catalogOrigin: 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0',
      operation: 'completion_stream',
      servedModel: 'gpt-5.1',
      maxStreamDurationMs: 300_000,
    },
    expiryClass: 'short_lived',
    attemptReceipt: 'a'.repeat(64),
    ...overrides,
  }
}

function sseResponse(frames: string[], status = 200, headers: Record<string, string> = {}): Response {
  return new Response(frames.join(''), {
    status,
    headers: { 'content-type': 'text/event-stream', ...headers },
  })
}

describe('streamCodexCompletion', () => {
  it('validates ticket bindings before redeem and maps stream frames including tool-call data', async () => {
    const redeem = vi.fn(async () => redeemSuccess())
    const finalize = vi.fn(async () => ({
      providerAttemptId: 'att-1',
      outcome: 'success' as const,
      duplicate: false,
    }))
    const frames: unknown[] = []
    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toBe(CODEX_COMPLETIONS_ORIGIN)
      return sseResponse([
        'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
        'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"call-1","name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}\n\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
      ])
    })

    const result = await streamCodexCompletion({
      executionTicket: 'ticket-1',
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket: {
        jti: '11111111-1111-4111-8111-111111111111',
        hostRef: 'research-host',
        model: 'gpt-5.1',
        requestHash: REQUEST_HASH,
        providerAttemptId: 'att-1',
      },
      redeem,
      finalize,
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
      onFrame: frame => frames.push(frame),
    })

    expect(redeem).toHaveBeenCalledOnce()
    expect(fetchFn).toHaveBeenCalledOnce()
    expect(frames).toEqual(
      expect.arrayContaining([
        { type: 'text', text: 'hi' },
        { type: 'tool_call', id: 'call-1', name: 'lookup', arguments: { q: 'x' } },
      ])
    )
    expect(result.outcome).toBe('success')
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 })
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptReceipt: 'a'.repeat(64),
        receipt: expect.objectContaining({ outcome: 'success', requestHash: REQUEST_HASH }),
      })
    )
    expect(String(fetchFn.mock.calls[0]?.[1]?.headers?.['authorization'])).toContain(accessTokenFor('live'))
    expect(fetchFn.mock.calls[0]?.[1]?.headers?.['originator']).toBe('evenfire')
    expect(fetchFn.mock.calls[0]?.[1]?.headers?.['openai-beta']).toBe('responses=v1')
    expect(fetchFn.mock.calls[0]?.[1]?.headers?.['session_id']).toBe('req-001')
    expect(fetchFn.mock.calls[0]?.[1]?.headers?.['chatgpt-account-id']).toBe('acct_live_1')
    expect(String(fetchFn.mock.calls[0]?.[1]?.body)).toContain('"store":false')
  })

  it('uses the redeemed ChatGPT account id when the access token is opaque', async () => {
    const fetchFn = vi.fn(async () =>
      sseResponse(['data: {"type":"response.completed","response":{"usage":{}}}\n\n'])
    )
    await streamCodexCompletion({
      executionTicket: 'ticket-1',
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket: {
        jti: 'jti-1',
        hostRef: 'research-host',
        model: 'gpt-5.1',
        requestHash: REQUEST_HASH,
        providerAttemptId: 'att-1',
      },
      redeem: async () =>
        redeemSuccess({ accessToken: 'opaque-token', chatgptAccountId: 'acct_from_id_token' }),
      finalize: vi.fn(async () => ({
        providerAttemptId: 'att-1',
        outcome: 'success',
        duplicate: false,
      })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    expect(fetchFn.mock.calls[0]?.[1]?.headers?.['chatgpt-account-id']).toBe('acct_from_id_token')
  })

  it('refuses to fetch completions when the access token has no ChatGPT account id', async () => {
    const fetchFn = vi.fn()
    await expect(
      streamCodexCompletion({
        executionTicket: 'ticket-1',
        requestHash: REQUEST_HASH,
        request: REQUEST,
        ticket: {
          jti: 'jti-1',
          hostRef: 'research-host',
          model: 'gpt-5.1',
          requestHash: REQUEST_HASH,
          providerAttemptId: 'att-1',
        },
        redeem: async () => redeemSuccess({ accessToken: 'opaque-token' }),
        finalize: vi.fn(async () => ({
          providerAttemptId: 'att-1',
          outcome: 'error',
          duplicate: false,
        })),
        fetchFn,
        lookup: async () => [{ address: '1.2.3.4', family: 4 }],
      })
    ).rejects.toMatchObject({ code: 'connection_unavailable' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects a mutated requestHash before redeem', async () => {
    const redeem = vi.fn()
    await expect(
      streamCodexCompletion({
        executionTicket: 'ticket-1',
        requestHash: 'f'.repeat(64),
        request: REQUEST,
        ticket: {
          jti: 'jti-1',
          hostRef: 'research-host',
          model: 'gpt-5.1',
          requestHash: REQUEST_HASH,
          providerAttemptId: 'att-1',
        },
        redeem,
        finalize: vi.fn(),
        fetchFn: vi.fn(),
      })
    ).rejects.toMatchObject({ code: 'request_hash_mismatch' } satisfies Partial<CodexTransportError>)
    expect(redeem).not.toHaveBeenCalled()
  })

  it('rejects a served-model mismatch and loopback redirects', async () => {
    await expect(
      streamCodexCompletion({
        executionTicket: 'ticket-1',
        requestHash: REQUEST_HASH,
        request: REQUEST,
        ticket: {
          jti: 'jti-1',
          hostRef: 'research-host',
          model: 'gpt-5.1',
          requestHash: REQUEST_HASH,
          providerAttemptId: 'att-1',
        },
        redeem: async () => redeemSuccess({ transport: { ...redeemSuccess().transport, servedModel: 'other' } }),
        finalize: vi.fn(async () => ({ providerAttemptId: 'att-1', outcome: 'error', duplicate: false })),
        fetchFn: vi.fn(),
      })
    ).rejects.toMatchObject({ code: 'model_not_allowed' })

    const fetchFn = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: `https://${['127', '0', '0', '1'].join('.')}/steal` },
      })
    )
    await expect(
      streamCodexCompletion({
        executionTicket: 'ticket-1',
        requestHash: REQUEST_HASH,
        request: REQUEST,
        ticket: {
          jti: 'jti-1',
          hostRef: 'research-host',
          model: 'gpt-5.1',
          requestHash: REQUEST_HASH,
          providerAttemptId: 'att-1',
        },
        redeem: async () => redeemSuccess(),
        finalize: vi.fn(async () => ({ providerAttemptId: 'att-1', outcome: 'error', duplicate: false })),
        fetchFn,
        lookup: async () => [{ address: '1.2.3.4', family: 4 }],
      })
    ).rejects.toMatchObject({ code: 'origin_denied' })
  })

  it('follows one frozen same-origin redirect then streams', async () => {
    const fetchFn = vi.fn(async () => {
      if (fetchFn.mock.calls.length === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: CODEX_COMPLETIONS_ORIGIN },
        })
      }
      return sseResponse(['data: {"type":"response.completed","response":{"usage":{}}}\n\n'])
    })
    const result = await streamCodexCompletion({
      executionTicket: 'ticket-1',
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket: {
        jti: 'jti-1',
        hostRef: 'research-host',
        model: 'gpt-5.1',
        requestHash: REQUEST_HASH,
        providerAttemptId: 'att-1',
      },
      redeem: async () => redeemSuccess(),
      finalize: vi.fn(async () => ({ providerAttemptId: 'att-1', outcome: 'success', duplicate: false })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    expect(result.outcome).toBe('success')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('maps upstream 401 to connection_unavailable instead of origin_denied', async () => {
    await expect(
      streamCodexCompletion({
        executionTicket: 'ticket-1',
        requestHash: REQUEST_HASH,
        request: REQUEST,
        ticket: {
          jti: 'jti-1',
          hostRef: 'research-host',
          model: 'gpt-5.1',
          requestHash: REQUEST_HASH,
          providerAttemptId: 'att-1',
        },
        redeem: async () => redeemSuccess(),
        finalize: vi.fn(async () => ({ providerAttemptId: 'att-1', outcome: 'error', duplicate: false })),
        fetchFn: vi.fn(async () => new Response('denied', { status: 401 })),
        lookup: async () => [{ address: '1.2.3.4', family: 4 }],
      })
    ).rejects.toMatchObject({ code: 'connection_unavailable' })
  })

  it('finalizes canceled after the first frame and treats finalize 500 as idempotent retry', async () => {
    const abort = new AbortController()
    const finalize = vi
      .fn()
      .mockRejectedValueOnce(new Error('finalize 500'))
      .mockResolvedValueOnce({ providerAttemptId: 'att-1', outcome: 'canceled', duplicate: true })
    const fetchFn = vi.fn(async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"x"}\n\n')
          )
          setTimeout(() => controller.close(), 20)
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    })

    const frames: unknown[] = []
    const result = await streamCodexCompletion({
      executionTicket: 'ticket-1',
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket: {
        jti: 'jti-1',
        hostRef: 'research-host',
        model: 'gpt-5.1',
        requestHash: REQUEST_HASH,
        providerAttemptId: 'att-1',
      },
      signal: abort.signal,
      redeem: async () => redeemSuccess(),
      finalize,
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
      onFrame: frame => {
        frames.push(frame)
        abort.abort()
      },
    })
    expect(frames[0]).toEqual({ type: 'text', text: 'x' })
    expect(result.outcome).toBe('canceled')
    expect(finalize).toHaveBeenCalledTimes(2)
    expect(finalize.mock.calls[0]?.[0]?.receipt.outcome).toBe('canceled')
  })

  it('does not reuse a redeemed access token across requests', async () => {
    const tokens: string[] = []
    const redeem = vi.fn(async (input: { executionTicket: string }) => {
      tokens.push(input.executionTicket)
      return redeemSuccess({ accessToken: accessTokenFor(input.executionTicket) })
    })
    const fetchFn = vi.fn(async () =>
      sseResponse(['data: {"type":"response.completed","response":{"usage":{}}}\n\n'])
    )
    const ticket = {
      jti: 'jti-1',
      hostRef: 'research-host',
      model: 'gpt-5.1',
      requestHash: REQUEST_HASH,
      providerAttemptId: 'att-1',
    }
    await streamCodexCompletion({
      executionTicket: 't-a',
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket,
      redeem,
      finalize: vi.fn(async () => ({ providerAttemptId: 'att-1', outcome: 'success', duplicate: false })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    await streamCodexCompletion({
      executionTicket: 't-b',
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket,
      redeem,
      finalize: vi.fn(async () => ({ providerAttemptId: 'att-1', outcome: 'success', duplicate: false })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    expect(tokens).toEqual(['t-a', 't-b'])
    expect(String(fetchFn.mock.calls[0]?.[1]?.headers?.['authorization'])).toContain(accessTokenFor('t-a'))
    expect(String(fetchFn.mock.calls[1]?.[1]?.headers?.['authorization'])).toContain(accessTokenFor('t-b'))
  })

  it('does not retry after an ambiguous upstream response', async () => {
    const fetchFn = vi.fn(async () => sseResponse(['data: {"type":"response.output_text.delta","delta":"partial"}\n\n']))
    const result = await streamCodexCompletion({
      executionTicket: 'ticket-1',
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket: {
        jti: 'jti-1',
        hostRef: 'research-host',
        model: 'gpt-5.1',
        requestHash: REQUEST_HASH,
        providerAttemptId: 'att-1',
      },
      redeem: async () => redeemSuccess(),
      finalize: vi.fn(async () => ({ providerAttemptId: 'att-1', outcome: 'unknown', duplicate: false })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    expect(result.outcome).toBe('unknown')
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('maps system, tool history, and generation hints into the Responses payload', async () => {
    const request = {
      schemaVersion: 'codex-completion-request.v1' as const,
      requestId: 'req-001',
      idempotencyKey: 'idem-001',
      provider: 'codex-subscription' as const,
      model: 'gpt-5.1',
      messages: [
        { role: 'system' as const, content: 'be brief' },
        { role: 'user' as const, content: 'hello' },
        {
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ id: 'call-1', name: 'echo', arguments: { x: 1 } }],
        },
        { role: 'tool' as const, content: 'ok', toolCallId: 'call-1' },
      ],
      tools: [{ name: 'echo', description: 'echo', parameters: {} }],
      generation: { toolChoice: 'auto' as const },
      transportHints: { promptCacheKey: 'sess-1' },
    }
    const requestHash = hashCodexCompletionRequestV1(request)
    const fetchFn = vi.fn(async () =>
      sseResponse(['data: {"type":"response.completed","response":{"usage":{}}}\n\n'])
    )
    await streamCodexCompletion({
      executionTicket: 'ticket-1',
      requestHash,
      request,
      ticket: {
        jti: 'jti-1',
        hostRef: 'research-host',
        model: 'gpt-5.1',
        requestHash,
        providerAttemptId: 'att-1',
      },
      redeem: async () => redeemSuccess(),
      finalize: vi.fn(async () => ({
        providerAttemptId: 'att-1',
        outcome: 'success',
        duplicate: false,
      })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body.instructions).toBe('be brief')
    expect(body.store).toBe(false)
    expect(body.tool_choice).toBe('auto')
    expect(body.prompt_cache_key).toBe('sess-1')
    expect(body.input).toEqual([
      { role: 'user', content: 'hello' },
      { type: 'function_call', call_id: 'call-1', name: 'echo', arguments: '{"x":1}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'ok' },
    ])
  })

  it('emits a tool call only after argument deltas complete', async () => {
    const frames: unknown[] = []
    const fetchFn = vi.fn(async () =>
      sseResponse([
        'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"item-1","call_id":"call-9","name":"lookup","arguments":""}}\n\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"{\\"q\\":"}}\n\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"\\"x\\"}"}\n\n',
        'data: {"type":"response.function_call_arguments.done","item_id":"item-1","arguments":"{\\"q\\":\\"x\\"}"}\n\n',
        'data: {"type":"response.completed","response":{"usage":{}}}\n\n',
      ])
    )
    await streamCodexCompletion({
      executionTicket: 'ticket-1',
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket: {
        jti: 'jti-1',
        hostRef: 'research-host',
        model: 'gpt-5.1',
        requestHash: REQUEST_HASH,
        providerAttemptId: 'att-1',
      },
      redeem: async () => redeemSuccess(),
      finalize: vi.fn(async () => ({
        providerAttemptId: 'att-1',
        outcome: 'success',
        duplicate: false,
      })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
      onFrame: frame => frames.push(frame),
    })
    expect(frames).toEqual([{ type: 'tool_call', id: 'call-9', name: 'lookup', arguments: { q: 'x' } }])
  })
})
