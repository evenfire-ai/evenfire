import { describe, expect, it, vi } from 'vitest'
import {
  hashGrokCompletionRequestV1,
  parseGrokCompletionRequestV1,
} from '@clerum/grok-provider-attempt-contract'
import type { RedeemAttemptSuccess } from '../src/controlApiClient.js'
import {
  GROK_UPSTREAM_TEMPERATURE_PROBE_CONFIRMED,
  GrokTransportError,
  type StreamGrokCompletionInput,
  streamGrokCompletion,
} from '../src/grokTransport.js'
import { GROK_COMPLETIONS_ORIGIN } from '../src/originPolicy.js'

const REQUEST = {
  schemaVersion: 'grok-completion-request.v1' as const,
  requestId: 'req-001',
  idempotencyKey: 'idem-001',
  provider: 'grok-subscription' as const,
  model: 'gpt-5.1',
  messages: [{ role: 'user' as const, content: 'hello' }],
}

type FetchInput = string | URL | Request

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name]
}

const REQUEST_HASH = hashGrokCompletionRequestV1(REQUEST)

function accessTokenFor(label: string): string {
  const encoded = Buffer.from(
    JSON.stringify({
      sub: label,
      'https://api.x.ai/auth': { grok_account_id: 'acct_live_1' },
    })
  ).toString('base64url')
  return `hdr.${encoded}.sig`
}

function redeemSuccess(overrides: Partial<RedeemAttemptSuccess> = {}): RedeemAttemptSuccess {
  return {
    accessToken: accessTokenFor('live'),
    transport: {
      protocolVersion: 'grok-subscription-transport.v1',
      completionsOrigin: GROK_COMPLETIONS_ORIGIN,
      catalogOrigin: 'https://cli-chat-proxy.grok.com/v1/models',
      operation: 'completion_stream',
      servedModel: 'gpt-5.1',
      maxStreamDurationMs: 300_000,
    },
    expiryClass: 'short_lived',
    attemptReceipt: 'a'.repeat(64),
    ...overrides,
  }
}

function sseResponse(
  frames: string[],
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(frames.join(''), {
    status,
    headers: { 'content-type': 'text/event-stream', ...headers },
  })
}

describe('streamGrokCompletion', () => {
  it('does not read further upstream bytes while the frame consumer is back-pressured', async () => {
    const encoder = new TextEncoder()
    const events = [
      'data: {"type":"response.output_text.delta","delta":"one"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"two"}\n\n',
      'data: {"type":"response.completed","response":{"usage":{}}}\n\n',
    ]
    let pulls = 0
    const fetchFn = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const next = events[pulls]
            pulls += 1
            if (next === undefined) controller.close()
            else controller.enqueue(encoder.encode(next))
          },
        },
        { highWaterMark: 0 }
      )
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    let releaseDrain: (() => void) | undefined
    const drained = new Promise<void>(resolve => {
      releaseDrain = resolve
    })
    const frames: unknown[] = []
    const pending = streamGrokCompletion({
      executionTicket: 'ticket-drain',
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket: {
        jti: 'jti-drain',
        hostRef: 'research-host',
        model: REQUEST.model,
        requestHash: REQUEST_HASH,
        providerAttemptId: 'att-drain',
      },
      redeem: async () => redeemSuccess(),
      finalize: vi.fn(async () => ({
        providerAttemptId: 'att-drain',
        outcome: 'success' as const,
        duplicate: false,
      })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
      onFrame: frame => {
        frames.push(frame)
        // First frame fills the client buffer; later frames are accepted.
        return frames.length === 1 ? drained : undefined
      },
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(frames).toEqual([{ type: 'text', text: 'one' }])
    expect(pulls).toBe(1)
    releaseDrain?.()
    const result = await pending
    expect(result.outcome).toBe('success')
    expect(frames).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ])
  })

  // Live xAI (probed 2026-09-18) answers 426 with
  // "Your Grok CLI version (none) is outdated..." when the caller presents no
  // accepted client version. Retrying cannot fix it, so it must not look like
  // a transient outage.
  it('maps an upstream 426 to a non-retryable client_upgrade_required error', async () => {
    const redeem = vi.fn(async () => redeemSuccess())
    const finalize = vi.fn(async () => ({
      providerAttemptId: 'att-426',
      outcome: 'error' as const,
      duplicate: false,
    }))
    const fetchFn = vi.fn(async (_url: FetchInput, _init?: RequestInit) => ({
      ok: false,
      status: 426,
      body: null,
      headers: new Headers(),
      text: async () =>
        '{"error":"Your Grok CLI version (none) is outdated. Please update to version 0.1.202 or later."}',
    })) as unknown as typeof fetch
    const pending = streamGrokCompletion({
      executionTicket: 'ticket-426',
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket: {
        jti: 'jti-426',
        hostRef: 'research-host',
        model: REQUEST.model,
        requestHash: REQUEST_HASH,
        providerAttemptId: 'att-426',
      },
      redeem,
      finalize,
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    await expect(pending).rejects.toMatchObject({
      code: 'client_upgrade_required',
      message: expect.stringMatching(/newer Grok client version/i),
    })
    expect(redeem).toHaveBeenCalled()
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({ receipt: expect.objectContaining({ outcome: 'error' }) })
    )
  })

  it('does not redeem when the client aborted before the attempt was dispatched', async () => {
    const redeem = vi.fn(async () => redeemSuccess())
    const finalize = vi.fn(async () => ({
      providerAttemptId: 'att-pre-abort',
      outcome: 'canceled' as const,
      duplicate: false,
    }))
    const fetchFn = vi.fn(async (_url: FetchInput, _init?: RequestInit) =>
      sseResponse(['data: {"type":"response.completed","response":{"usage":{}}}\n\n'])
    )
    const abort = new AbortController()
    abort.abort()
    const result = await streamGrokCompletion({
      executionTicket: 'ticket-pre-abort',
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket: {
        jti: 'jti-pre-abort',
        hostRef: 'research-host',
        model: REQUEST.model,
        requestHash: REQUEST_HASH,
        providerAttemptId: 'att-pre-abort',
      },
      signal: abort.signal,
      redeem,
      finalize,
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    expect(result.outcome).toBe('canceled')
    expect(redeem).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(finalize).not.toHaveBeenCalled()
  })

  it.each(['response.failed', 'unterminated'])(
    'does not emit partial tool calls after %s',
    async terminal => {
      const emitted: Array<{ type: string }> = []
      const frames = [
        'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"partial","name":"lookup","arguments":"{}"}}\n\n',
      ]
      if (terminal !== 'unterminated')
        frames.push(`data: ${JSON.stringify({ type: terminal })}\n\n`)
      const pending = streamGrokCompletion({
        executionTicket: 'ticket-partial',
        requestHash: REQUEST_HASH,
        request: REQUEST,
        ticket: {
          jti: 'jti-partial',
          hostRef: 'research-host',
          model: REQUEST.model,
          requestHash: REQUEST_HASH,
          providerAttemptId: 'att-partial',
        },
        redeem: vi.fn(async () => redeemSuccess()),
        finalize: vi.fn(async () => ({
          providerAttemptId: 'att-partial',
          outcome: 'success' as const,
          duplicate: false,
        })),
        fetchFn: vi.fn(async (_url: FetchInput, _init?: RequestInit) => sseResponse(frames)),
        lookup: async () => [{ address: '1.2.3.4', family: 4 }],
        onFrame: frame => {
          emitted.push(frame)
        },
      })
      if (terminal === 'unterminated') expect((await pending).outcome).toBe('unknown')
      else await expect(pending).rejects.toThrow(/upstream response failed/)
      expect(emitted).toEqual([])
    }
  )
  it.each([64, 65])(
    'validates the complete %s-call response before emitting executable calls',
    async count => {
      const emitted: Array<{ type: string }> = []
      const finalize = vi.fn(async () => ({
        providerAttemptId: 'att-bound',
        outcome: 'success' as const,
        duplicate: false,
      }))
      const frames = Array.from(
        { length: count },
        (_, index) =>
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            item: { type: 'function_call', id: `call-${index}`, name: 'lookup', arguments: '{}' },
          })}\n\n`
      )
      frames.push('data: {"type":"response.completed"}\n\n')
      const pending = streamGrokCompletion({
        executionTicket: 'ticket-bound',
        requestHash: REQUEST_HASH,
        request: REQUEST,
        ticket: {
          jti: 'jti-bound',
          hostRef: 'research-host',
          model: REQUEST.model,
          requestHash: REQUEST_HASH,
          providerAttemptId: 'att-bound',
        },
        redeem: vi.fn(async () => redeemSuccess()),
        finalize,
        fetchFn: vi.fn(async (_url: FetchInput, _init?: RequestInit) => sseResponse(frames)),
        lookup: async () => [{ address: '1.2.3.4', family: 4 }],
        onFrame: frame => {
          emitted.push(frame)
        },
      })
      if (count === 64) {
        expect((await pending).outcome).toBe('success')
        expect(emitted.filter(frame => frame.type === 'tool_call')).toHaveLength(64)
      } else {
        await expect(pending).rejects.toThrow(/tool calls exceed 64/)
        // The code, not only the message: the message is unchanged by the
        // taxonomy work, so a message-only assertion passes either way.
        await expect(pending).rejects.toMatchObject({
          code: 'tool_call_limit_exceeded',
          details: { limit: 64, observed: 65 },
        })
        expect(emitted.filter(frame => frame.type === 'tool_call')).toHaveLength(0)
        expect(finalize).toHaveBeenCalledWith(
          expect.objectContaining({ receipt: expect.objectContaining({ outcome: 'error' }) })
        )
      }
    }
  )
  it('reports the buffered-frame limit when one call id repeats past the budget', async () => {
    // Every item carries no id, so upsertPendingTool collapses them onto the
    // single key 'tool' and `pending.size` stays 1. The arguments are complete
    // JSON, so the `output_item.added` branch emits on each frame and
    // `toolFrames` is what grows. Only the buffered-frame guard can fire here.
    const emitted: Array<{ type: string }> = []
    const finalize = vi.fn(async () => ({
      providerAttemptId: 'att-bound',
      outcome: 'success' as const,
      duplicate: false,
    }))
    const frames = Array.from(
      { length: 65 },
      () =>
        `data: ${JSON.stringify({
          type: 'response.output_item.added',
          item: { type: 'function_call', name: 'lookup', arguments: '{}' },
        })}\n\n`
    )
    frames.push('data: {"type":"response.completed"}\n\n')
    const pending = streamGrokCompletion({
      executionTicket: 'ticket-bound',
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket: {
        jti: 'jti-bound',
        hostRef: 'research-host',
        model: REQUEST.model,
        requestHash: REQUEST_HASH,
        providerAttemptId: 'att-bound',
      },
      redeem: vi.fn(async () => redeemSuccess()),
      finalize,
      fetchFn: vi.fn(async (_url: FetchInput, _init?: RequestInit) => sseResponse(frames)),
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
      onFrame: frame => {
        emitted.push(frame)
      },
    })
    await expect(pending).rejects.toMatchObject({
      code: 'tool_call_limit_exceeded',
      details: { limit: 64, observed: 65 },
    })
    expect(emitted.filter(frame => frame.type === 'tool_call')).toHaveLength(0)
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({ receipt: expect.objectContaining({ outcome: 'error' }) })
    )
  })
  it('reports the pending-call limit as soon as the budget is exceeded mid-stream', async () => {
    // Distinct ids with empty arguments: nothing is ever complete JSON, so no
    // frame is emitted and `toolFrames` stays at 0 while `pending` grows. Only
    // the pending-map guard can fire here, and it must fire during the stream —
    // the trailing text proves it did, because the post-stream drain would
    // deliver that text first.
    const emitted: Array<{ type: string }> = []
    const finalize = vi.fn(async () => ({
      providerAttemptId: 'att-bound',
      outcome: 'success' as const,
      duplicate: false,
    }))
    const frames = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'before' })}\n\n`,
      ...Array.from(
        { length: 65 },
        (_, index) =>
          `data: ${JSON.stringify({
            type: 'response.output_item.added',
            item: { type: 'function_call', id: `call-${index}`, name: 'lookup', arguments: '' },
          })}\n\n`
      ),
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'after' })}\n\n`,
    ]
    const pending = streamGrokCompletion({
      executionTicket: 'ticket-bound',
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket: {
        jti: 'jti-bound',
        hostRef: 'research-host',
        model: REQUEST.model,
        requestHash: REQUEST_HASH,
        providerAttemptId: 'att-bound',
      },
      redeem: vi.fn(async () => redeemSuccess()),
      finalize,
      fetchFn: vi.fn(async (_url: FetchInput, _init?: RequestInit) => sseResponse(frames)),
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
      onFrame: frame => {
        emitted.push(frame)
      },
    })
    await expect(pending).rejects.toMatchObject({
      code: 'tool_call_limit_exceeded',
      details: { limit: 64, observed: 65 },
    })
    expect(emitted.filter(frame => frame.type === 'tool_call')).toHaveLength(0)
    // Liveness witness and mutation detector in one: the leading text proves
    // the stream was read, and the absence of the trailing text proves the
    // throw happened at the 65th pending call rather than after the stream.
    expect(emitted.filter(frame => frame.type === 'text')).toEqual([{ type: 'text', text: 'before' }])
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({ receipt: expect.objectContaining({ outcome: 'error' }) })
    )
  })
  it('validates ticket bindings before redeem and maps stream frames including tool-call data', async () => {
    const redeem = vi.fn(async () => redeemSuccess())
    const finalize = vi.fn(async () => ({
      providerAttemptId: 'att-1',
      outcome: 'success' as const,
      duplicate: false,
    }))
    const frames: unknown[] = []
    const fetchFn = vi.fn(async (url: FetchInput, _init?: RequestInit) => {
      expect(url).toBe(GROK_COMPLETIONS_ORIGIN)
      return sseResponse([
        'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
        'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"call-1","name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}\n\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
      ])
    })

    const result = await streamGrokCompletion({
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
      onFrame: frame => {
        frames.push(frame)
      },
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
    expect(String(headerOf(fetchFn.mock.calls[0]?.[1], 'authorization'))).toContain(
      accessTokenFor('live')
    )
    // xAI gates on a client version; we send it under an Evenfire identity.
    expect(String(headerOf(fetchFn.mock.calls[0]?.[1], 'user-agent'))).toMatch(
      /^evenfire-grok-subscription grok-build\/\d+\.\d+\.\d+/
    )
    expect(String(headerOf(fetchFn.mock.calls[0]?.[1], 'x-grok-client-version'))).toMatch(
      /^\d+\.\d+\.\d+/
    )
    expect(headerOf(fetchFn.mock.calls[0]?.[1], 'x-grok-client-identifier')).toBe('evenfire')
    expect(headerOf(fetchFn.mock.calls[0]?.[1], 'x-xai-token-auth')).toBe('xai-grok-cli')
    expect(String(JSON.stringify(fetchFn.mock.calls[0]?.[1]?.headers))).not.toContain('grok-shell')
    expect(headerOf(fetchFn.mock.calls[0]?.[1], 'openai-beta')).toBeUndefined()
    expect(String(fetchFn.mock.calls[0]?.[1]?.body)).toContain('"store":false')
  })

  it('flushes a completed event that arrives without a trailing blank line', async () => {
    const fetchFn = vi.fn(async (_url: FetchInput, _init?: RequestInit) =>
      sseResponse([
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
      ])
    )
    const result = await streamGrokCompletion({
      executionTicket: 'ticket-1',
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket: {
        jti: 'jti-residual',
        hostRef: 'research-host',
        model: 'gpt-5.1',
        requestHash: REQUEST_HASH,
        providerAttemptId: 'att-1',
      },
      redeem: async () => redeemSuccess(),
      finalize: vi.fn(async () => ({
        providerAttemptId: 'att-1',
        outcome: 'success' as const,
        duplicate: false,
      })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    expect(result.outcome).toBe('success')
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 1 })
  })

  it('parses CRLF-delimited SSE frames', async () => {
    const fetchFn = vi.fn(async (_url: FetchInput, _init?: RequestInit) =>
      sseResponse([
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":5}}}\r\n\r\n',
      ])
    )
    const result = await streamGrokCompletion({
      executionTicket: 'ticket-1',
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket: {
        jti: 'jti-crlf',
        hostRef: 'research-host',
        model: 'gpt-5.1',
        requestHash: REQUEST_HASH,
        providerAttemptId: 'att-1',
      },
      redeem: async () => redeemSuccess(),
      finalize: vi.fn(async () => ({
        providerAttemptId: 'att-1',
        outcome: 'success' as const,
        duplicate: false,
      })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    expect(result.outcome).toBe('success')
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 5 })
  })

  it('maps upstream 402/403 to provider_unavailable', async () => {
    const fetchFn = vi.fn(
      async (_url: FetchInput, _init?: RequestInit) => new Response('paywall', { status: 403 })
    )
    await expect(
      streamGrokCompletion({
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
          outcome: 'error' as const,
          duplicate: false,
        })),
        fetchFn,
        lookup: async () => [{ address: '1.2.3.4', family: 4 }],
      })
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
  })

  it('rejects a mutated requestHash before redeem', async () => {
    const redeem = vi.fn()
    await expect(
      streamGrokCompletion({
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
    ).rejects.toMatchObject({
      code: 'request_hash_mismatch',
    } satisfies Partial<GrokTransportError>)
    expect(redeem).not.toHaveBeenCalled()
  })

  it('rejects a served-model mismatch and loopback redirects', async () => {
    await expect(
      streamGrokCompletion({
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
          redeemSuccess({ transport: { ...redeemSuccess().transport, servedModel: 'other' } }),
        finalize: vi.fn(async () => ({
          providerAttemptId: 'att-1',
          outcome: 'error' as const,
          duplicate: false,
        })),
        fetchFn: vi.fn(),
      })
    ).rejects.toMatchObject({ code: 'model_not_allowed' })

    const fetchFn = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://${['127', '0', '0', '1'].join('.')}/steal` },
        })
    )
    await expect(
      streamGrokCompletion({
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
          outcome: 'error' as const,
          duplicate: false,
        })),
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
          headers: { location: GROK_COMPLETIONS_ORIGIN },
        })
      }
      return sseResponse(['data: {"type":"response.completed","response":{"usage":{}}}\n\n'])
    })
    const result = await streamGrokCompletion({
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
        outcome: 'success' as const,
        duplicate: false,
      })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    expect(result.outcome).toBe('success')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('maps upstream 401 to connection_unavailable instead of origin_denied', async () => {
    await expect(
      streamGrokCompletion({
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
          outcome: 'error' as const,
          duplicate: false,
        })),
        fetchFn: vi.fn(
          async (_url: FetchInput, _init?: RequestInit) => new Response('denied', { status: 401 })
        ),
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
    const result = await streamGrokCompletion({
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
    const fetchFn = vi.fn(async (_url: FetchInput, _init?: RequestInit) =>
      sseResponse(['data: {"type":"response.completed","response":{"usage":{}}}\n\n'])
    )
    const ticket = {
      jti: 'jti-1',
      hostRef: 'research-host',
      model: 'gpt-5.1',
      requestHash: REQUEST_HASH,
      providerAttemptId: 'att-1',
    }
    await streamGrokCompletion({
      executionTicket: 't-a',
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket,
      redeem,
      finalize: vi.fn(async () => ({
        providerAttemptId: 'att-1',
        outcome: 'success' as const,
        duplicate: false,
      })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    await streamGrokCompletion({
      executionTicket: 't-b',
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket,
      redeem,
      finalize: vi.fn(async () => ({
        providerAttemptId: 'att-1',
        outcome: 'success' as const,
        duplicate: false,
      })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    expect(tokens).toEqual(['t-a', 't-b'])
    expect(String(headerOf(fetchFn.mock.calls[0]?.[1], 'authorization'))).toContain(
      accessTokenFor('t-a')
    )
    expect(String(headerOf(fetchFn.mock.calls[1]?.[1], 'authorization'))).toContain(
      accessTokenFor('t-b')
    )
  })

  it('does not retry after an ambiguous upstream response', async () => {
    const fetchFn = vi.fn(async (_url: FetchInput, _init?: RequestInit) =>
      sseResponse(['data: {"type":"response.output_text.delta","delta":"partial"}\n\n'])
    )
    const result = await streamGrokCompletion({
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
        outcome: 'unknown' as const,
        duplicate: false,
      })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    expect(result.outcome).toBe('unknown')
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('maps system, tool history, and generation hints into the Responses payload', async () => {
    const request = {
      schemaVersion: 'grok-completion-request.v1' as const,
      requestId: 'req-001',
      idempotencyKey: 'idem-001',
      provider: 'grok-subscription' as const,
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
      tools: Array.from({ length: 250 }, (_, index) => ({
        name: index === 0 ? 'echo' : `approved_tool_${index}`,
        description: `Approved tool ${index}`,
        parameters: { type: 'object', properties: { x: { type: 'integer' } } },
      })),
      generation: { toolChoice: 'auto' as const },
      transportHints: { promptCacheKey: 'sess-1' },
    }
    const requestHash = hashGrokCompletionRequestV1(request)
    const fetchFn = vi.fn(async (_url: FetchInput, _init?: RequestInit) =>
      sseResponse(['data: {"type":"response.completed","response":{"usage":{}}}\n\n'])
    )
    await streamGrokCompletion({
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
        outcome: 'success' as const,
        duplicate: false,
      })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body.instructions).toBe('be brief')
    expect(body.store).toBe(false)
    expect(body.tools).toEqual(
      request.tools.map(tool => ({ type: 'function', ...tool, strict: false }))
    )
    expect(body.parallel_tool_calls).toBe(true)
    expect(body.tool_choice).toBe('auto')
    expect(body.prompt_cache_key).toBe('sess-1')
    expect(body.input).toEqual([
      { role: 'user', content: 'hello' },
      { type: 'function_call', call_id: 'call-1', name: 'echo', arguments: '{"x":1}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'ok' },
    ])
    expect(body).not.toHaveProperty('max_output_tokens')
    expect(body).not.toHaveProperty('temperature')
  })

  it.each([
    { name: 'service.with.dots__read', mode: 'alias' },
    { name: `generated_server_${'x'.repeat(140)}__read`, mode: 'alias' },
    { name: '工具@read record', mode: 'alias' },
    { name: 'history@removed tool', mode: 'history-only' },
    { name: 'service.with.dots__read', mode: 'canonical-echo' },
  ])('roundtrips $name ($mode) without changing authorization identity', async ({ name, mode }) => {
    const request = {
      ...REQUEST,
      ...(mode === 'history-only'
        ? {}
        : { tools: [{ name, description: 'Read one record', parameters: { type: 'object' } }] }),
      messages: [
        ...REQUEST.messages,
        {
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ id: 'previous', name, arguments: {} }],
        },
        { role: 'tool' as const, content: 'previous result', toolCallId: 'previous', name },
      ],
    }
    const requestHash = hashGrokCompletionRequestV1(request)
    expect(parseGrokCompletionRequestV1(request).ok).toBe(true)
    const original = structuredClone(request)
    const emitted: unknown[] = []
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const wireName = body.input.find(
        (item: { type?: string }) => item.type === 'function_call'
      ).name
      if (mode === 'history-only') expect(body.tools).toBeUndefined()
      else expect(body.tools[0].name).toBe(wireName)
      expect(wireName).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
      expect(wireName).not.toBe(name)
      expect(body.input.find((item: { type?: string }) => item.type === 'function_call').name).toBe(
        wireName
      )
      expect(
        body.input.find((item: { type?: string }) => item.type === 'function_call_output')
      ).toEqual({
        type: 'function_call_output',
        call_id: 'previous',
        output: 'previous result',
      })
      return sseResponse([
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            id: 'item-new',
            call_id: 'new-call',
            name: mode === 'canonical-echo' ? name : wireName,
            arguments: '{}',
          },
        })}\n\n`,
        'data: {"type":"response.completed","response":{"usage":{}}}\n\n',
      ])
    })
    const result = await streamGrokCompletion({
      executionTicket: 'ticket-name-map',
      requestHash,
      request,
      ticket: {
        jti: 'name-map',
        hostRef: 'research-host',
        model: request.model,
        requestHash,
        providerAttemptId: 'att-name-map',
      },
      redeem: async () => redeemSuccess(),
      finalize: async () => ({
        providerAttemptId: 'att-name-map',
        outcome: 'success' as const,
        duplicate: false,
      }),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
      onFrame: frame => {
        emitted.push(frame)
      },
    })
    expect(result.outcome).toBe('success')
    expect(emitted).toContainEqual({ type: 'tool_call', id: 'new-call', name, arguments: {} })
    expect(request).toEqual(original)
    expect(hashGrokCompletionRequestV1(request)).toBe(requestHash)
  })

  it('rejects an unregistered alias in a completed stream before emitting any calls', async () => {
    const emitted: unknown[] = []
    const finalize = vi.fn(async () => ({
      providerAttemptId: 'att-unknown-alias',
      outcome: 'error' as const,
      duplicate: false,
    }))
    const request = {
      ...REQUEST,
      tools: [{ name: 'known.read', description: 'Read a record', parameters: { type: 'object' } }],
    }
    const requestHash = hashGrokCompletionRequestV1(request)
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      return sseResponse([
        ...[body.tools[0].name, '__grok_tool_unregistered'].map(
          (name, index) =>
            `data: ${JSON.stringify({
              type: 'response.output_item.done',
              item: { type: 'function_call', id: `call-${index}`, name, arguments: '{}' },
            })}\n\n`
        ),
        'data: {"type":"response.completed"}\n\n',
      ])
    })
    await expect(
      streamGrokCompletion({
        executionTicket: 'ticket-unknown-alias',
        requestHash,
        request,
        ticket: {
          jti: 'unknown-alias',
          hostRef: 'research-host',
          model: request.model,
          requestHash,
          providerAttemptId: 'att-unknown-alias',
        },
        redeem: async () => redeemSuccess(),
        finalize,
        fetchFn,
        lookup: async () => [{ address: '1.2.3.4', family: 4 }],
        onFrame: frame => {
          emitted.push(frame)
        },
      })
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: 'upstream returned an unknown tool name',
    })
    expect(fetchFn).toHaveBeenCalledOnce()
    expect(emitted).toEqual([])
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        receipt: expect.objectContaining({ outcome: 'error' }),
      })
    )
  })

  it('omits Notify-like generation fields on the Responses wire', async () => {
    const fetchFn = vi.fn(async (_url: FetchInput, _init?: RequestInit) =>
      sseResponse(['data: {"type":"response.completed","response":{"usage":{}}}\n\n'])
    )
    await streamGrokCompletion({
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
        outcome: 'success' as const,
        duplicate: false,
      })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body.instructions).toBeUndefined()
    expect(body).not.toHaveProperty('max_output_tokens')
    expect(body).not.toHaveProperty('temperature')
    expect(body.store).toBe(false)
    expect(body.input).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('keeps analysis instructions, binds max_output_tokens, and withholds probe-gated temperature', async () => {
    const request = {
      ...REQUEST,
      messages: [
        { role: 'system' as const, content: 'review this repository' },
        { role: 'user' as const, content: 'findings' },
      ],
      generation: { maxOutputTokens: 4096, temperature: 0.2 },
    }
    const requestHash = hashGrokCompletionRequestV1(request)
    const fetchFn = vi.fn(async (_url: FetchInput, _init?: RequestInit) =>
      sseResponse(['data: {"type":"response.completed","response":{"usage":{}}}\n\n'])
    )
    await streamGrokCompletion({
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
        outcome: 'success' as const,
        duplicate: false,
      })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body.instructions).toBe('review this repository')
    expect(body.input).toEqual([{ role: 'user', content: 'findings' }])
    expect(body.max_output_tokens).toBe(4096)
    // B-M10: temperature stays in the authorize hash but is not sent upstream
    // until a live SuperGrok probe confirms /v1/responses accepts it.
    expect(GROK_UPSTREAM_TEMPERATURE_PROBE_CONFIRMED).toBe(false)
    expect(body).not.toHaveProperty('temperature')
    expect(hashGrokCompletionRequestV1(request)).toBe(requestHash)
    expect(body).not.toHaveProperty('text')
    expect(body).not.toHaveProperty('service_tier')
  })

  it('maps upstream 400 to invalid_request and finalizes error without usage', async () => {
    const finalize = vi.fn(
      async (_input: Parameters<StreamGrokCompletionInput['finalize']>[0]) => ({
        providerAttemptId: 'att-1',
        outcome: 'error' as const,
        duplicate: false,
      })
    )
    await expect(
      streamGrokCompletion({
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
        finalize,
        fetchFn: vi.fn(
          async (_url: FetchInput, _init?: RequestInit) =>
            new Response('bad request', { status: 400 })
        ),
        lookup: async () => [{ address: '1.2.3.4', family: 4 }],
      })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        receipt: expect.objectContaining({ outcome: 'error' }),
      })
    )
    expect(finalize.mock.calls[0]?.[0]?.receipt?.usage).toBeUndefined()
  })

  it('emits a tool call only after argument deltas complete', async () => {
    const frames: unknown[] = []
    const fetchFn = vi.fn(async (_url: FetchInput, _init?: RequestInit) =>
      sseResponse([
        'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"item-1","call_id":"call-9","name":"lookup","arguments":""}}\n\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"{\\"q\\":"}}\n\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"\\"x\\"}"}\n\n',
        'data: {"type":"response.function_call_arguments.done","item_id":"item-1","arguments":"{\\"q\\":\\"x\\"}"}\n\n',
        'data: {"type":"response.completed","response":{"usage":{}}}\n\n',
      ])
    )
    await streamGrokCompletion({
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
        outcome: 'success' as const,
        duplicate: false,
      })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
      onFrame: frame => {
        frames.push(frame)
      },
    })
    expect(frames).toEqual([
      { type: 'tool_call', id: 'call-9', name: 'lookup', arguments: { q: 'x' } },
    ])
  })
})
