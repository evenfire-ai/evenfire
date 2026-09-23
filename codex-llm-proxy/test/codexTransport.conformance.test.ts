import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import {
  hashCodexCompletionRequest,
  hashCodexCompletionRequestV1,
  parseCodexCompletionRequest,
  parseCodexCompletionRequestV1,
} from '@clerum/llm-provider-attempt-contract'
import {
  CodexTransportError,
  type StreamCodexCompletionInput,
  streamCodexCompletion,
} from '../src/codexTransport.js'
import type { RedeemAttemptSuccess } from '../src/controlApiClient.js'
import { CODEX_COMPLETIONS_ORIGIN } from '../src/originPolicy.js'
import { ToolNameMap } from '../src/toolNameMap.js'
import { eventaskUpdateTool, optionalMcpTools, webSearchTool } from './fixtures/optionalMcpTools.js'
import {
  UPSTREAM_CONTEXT_ERROR_EVENT,
  UPSTREAM_CONTEXT_FAILED_EVENT,
  UPSTREAM_CONTEXT_OVERFLOW_FRAMES,
  sseFrame,
} from './fixtures/upstreamContextOverflow.js'

const { declaredHeaderPng } = createRequire(import.meta.url)(
  '../../packages/llm-provider-attempt-contract/testImageFixtures.cjs'
) as { declaredHeaderPng: (width: number, height: number) => Buffer }

const REQUEST = {
  schemaVersion: 'codex-completion-request.v1' as const,
  requestId: 'req-001',
  idempotencyKey: 'idem-001',
  provider: 'codex-subscription' as const,
  model: 'gpt-5.1',
  messages: [{ role: 'user' as const, content: 'hello' }],
}

type FetchInput = string | URL | Request

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name]
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
      maxStreamDurationMs: 1_800_000,
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

describe('streamCodexCompletion', () => {
  it('maps an over-dimension image to payload_too_large before redeem', async () => {
    const request = {
      schemaVersion: 'codex-completion-request.v2' as const,
      requestId: 'req-over-dimension',
      idempotencyKey: 'idem-over-dimension',
      provider: 'codex-subscription' as const,
      model: 'gpt-5.1',
      messages: [
        {
          role: 'user' as const,
          content: 'look',
          contentParts: [
            { type: 'text' as const, text: 'look' },
            {
              type: 'image' as const,
              mimeType: 'image/png' as const,
              data: declaredHeaderPng(3000, 3000).toString('base64'),
              source: { kind: 'attachment' as const, attachmentId: 'att-1', messageId: 'msg-1' },
            },
          ],
        },
      ],
    }
    const redeem = vi.fn()
    await expect(
      streamCodexCompletion({
        maxDeadlineMs: 1_800_000,
        executionTicket: 'visual-ticket',
        requestHash: 'a'.repeat(64),
        request,
        ticket: {
          jti: 'visual-ticket',
          hostRef: 'research-host',
          model: request.model,
          requestHash: 'a'.repeat(64),
          providerAttemptId: 'visual-attempt',
        },
        redeem,
        finalize: vi.fn(),
        fetchFn: vi.fn(),
      })
    ).rejects.toMatchObject({
      code: 'payload_too_large',
      message: expect.stringMatching(/image dimension exceeds 2048/),
    })
    expect(redeem).not.toHaveBeenCalled()
  })

  it.each(['png', 'jpeg'] as const)(
    'projects authorized %s parts without leaking provenance upstream',
    async format => {
      const fixtures = JSON.parse(
        readFileSync(
          new URL(
            '../../packages/llm-provider-attempt-contract/fixtures/visual-requests.json',
            import.meta.url
          ),
          'utf8'
        )
      ) as Record<
        string,
        {
          messages: Array<{
            contentParts: Array<{
              type: string
              text?: string
              mimeType?: string
              data?: string
            }>
          }>
        }
      >
      const parsed = parseCodexCompletionRequest({ ...fixtures[format], model: REQUEST.model })
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) throw new Error(parsed.message)
      const request = parsed.value
      const requestHash = hashCodexCompletionRequest(request)
      const fetchFn = vi.fn<typeof fetch>(async () =>
        sseResponse(['data: {"type":"response.completed"}\n\n'])
      )
      const redeem = vi.fn(async () => redeemSuccess())
      const finalize = vi.fn(async () => ({
        providerAttemptId: 'visual-attempt',
        outcome: 'success' as const,
        duplicate: false,
      }))
      const input: StreamCodexCompletionInput = {
        maxDeadlineMs: 1_800_000,
        executionTicket: 'visual-ticket',
        requestHash,
        request,
        ticket: {
          jti: 'visual-ticket',
          hostRef: 'research-host',
          model: request.model,
          requestHash,
          providerAttemptId: 'visual-attempt',
        },
        redeem,
        finalize,
        fetchFn,
        lookup: async () => [{ address: '1.2.3.4', family: 4 }],
      }
      await expect(streamCodexCompletion({ ...input, deadlineMs: 1000 })).rejects.toMatchObject({
        code: 'invalid_request',
      })
      expect(redeem).not.toHaveBeenCalled()
      expect(fetchFn).not.toHaveBeenCalled()
      await streamCodexCompletion(input)
      const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))
      const sourceParts = fixtures[format].messages[0].contentParts
      expect(body.input[0].content).toEqual(
        sourceParts.map(
          (part: { type: string; text?: string; mimeType?: string; data?: string }) =>
            part.type === 'text'
              ? { type: 'input_text', text: part.text }
              : {
                  type: 'input_image',
                  image_url: `data:${part.mimeType};base64,${part.data}`,
                  detail: 'high',
                }
        )
      )
      expect(JSON.stringify(body)).not.toContain('attachmentId')
      expect(finalize).toHaveBeenCalledOnce()
    }
  )

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
    const pending = streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
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
    const result = await streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
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

  it('preserves real MCP optional schemas with explicit non-strict upstream tools', async () => {
    const request = {
      ...REQUEST,
      tools: optionalMcpTools.map(tool => ({
        ...structuredClone(tool),
        // Exercise existing aliasing with the second real schema.
        name: tool === webSearchTool ? 'web.search__web_search' : tool.name,
      })),
    }
    const original = structuredClone(request)
    const requestHash = hashCodexCompletionRequestV1(request)
    const fetchFn = vi.fn(async (_url: FetchInput, _init?: RequestInit) =>
      sseResponse(['data: {"type":"response.completed"}\n\n'])
    )
    await streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
      executionTicket: 'ticket-optionality',
      requestHash,
      request,
      ticket: {
        jti: 'jti-optionality',
        hostRef: 'research-host',
        model: REQUEST.model,
        requestHash,
        providerAttemptId: 'att-optionality',
      },
      redeem: async () => redeemSuccess(),
      finalize: vi.fn(async () => ({
        providerAttemptId: 'att-optionality',
        outcome: 'success' as const,
        duplicate: false,
      })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    expect(fetchFn).toHaveBeenCalledOnce()
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))
    const names = new ToolNameMap(request.tools.map(tool => tool.name))
    expect(body.tools).toHaveLength(2)
    expect(body.tools).toEqual(
      request.tools.map(tool => ({
        type: 'function',
        name: names.toWire(tool.name),
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
      }))
    )
    expect(body.tools[0].parameters.required).toEqual(['key', 'actor'])
    expect(body.tools[1].parameters.required).toEqual(['query'])
    expect(request).toEqual(original)
    expect(hashCodexCompletionRequestV1(request)).toBe(requestHash)
  })

  it.each([
    {
      label: 'absent optional fields',
      tool: eventaskUpdateTool,
      args: { key: 'BUG-1', actor: 'test-agent', description: 'Updated description' },
    },
    {
      label: 'explicit null',
      tool: eventaskUpdateTool,
      args: { key: 'BUG-1', actor: 'test-agent', dueDate: null },
    },
    {
      label: 'empty array',
      tool: eventaskUpdateTool,
      args: { key: 'BUG-1', actor: 'test-agent', labels: [] },
    },
    { label: 'empty arguments', tool: eventaskUpdateTool, args: {} },
    {
      label: 'wrong object type',
      tool: eventaskUpdateTool,
      args: { key: 'BUG-1', actor: 'test-agent', labels: {} },
    },
    {
      label: 'unknown property',
      tool: eventaskUpdateTool,
      args: { key: 'BUG-1', actor: 'test-agent', unexpected: true },
    },
    {
      label: 'contradictory labels',
      tool: eventaskUpdateTool,
      args: { key: 'BUG-1', actor: 'test-agent', labels: [], addLabels: [], removeLabels: [] },
    },
    {
      label: 'plugin default not requested',
      tool: webSearchTool,
      args: { query: 'MCP optional parameters' },
    },
  ])('does not repair or default provider arguments: $label', async ({ tool, args }) => {
    // Even invalid provider output must reach normal host/plugin validation
    // unchanged; the transport must never silently make a call look valid.
    const canonical = `plugin.v2__${tool.name}`
    const names = new ToolNameMap([canonical])
    const request = { ...REQUEST, tools: [{ ...tool, name: canonical }] }
    const requestHash = hashCodexCompletionRequestV1(request)
    const frames: unknown[] = []
    await streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
      executionTicket: 'ticket-arguments',
      requestHash,
      request,
      ticket: {
        jti: 'jti-arguments',
        hostRef: 'research-host',
        model: REQUEST.model,
        requestHash,
        providerAttemptId: 'att-arguments',
      },
      redeem: async () => redeemSuccess(),
      finalize: vi.fn(async () => ({
        providerAttemptId: 'att-arguments',
        outcome: 'success' as const,
        duplicate: false,
      })),
      fetchFn: vi.fn(async (_url: FetchInput, _init?: RequestInit) =>
        sseResponse([
          `data: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call-optional', name: names.toWire(canonical), arguments: JSON.stringify(args) } })}\n\n`,
          'data: {"type":"response.completed"}\n\n',
        ])
      ),
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
      onFrame: frame => {
        frames.push(frame)
      },
    })
    expect(frames).toEqual([
      { type: 'tool_call', id: 'call-optional', name: canonical, arguments: args },
    ])
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
      const pending = streamCodexCompletion({
        maxDeadlineMs: 1_800_000,
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

  // #731 — an upstream context-window refusal is a property of this request.
  // The transport keeps the upstream code so the Host does not retry it as an
  // outage. Each event carries the code in a different place; either is enough.
  function failingStream(frames: string[], attempt: string) {
    const finalize = vi.fn(async () => ({
      providerAttemptId: attempt,
      outcome: 'error' as const,
      duplicate: false,
    }))
    const fetchFn = vi.fn(async (_url: FetchInput, _init?: RequestInit) => sseResponse(frames))
    const pending = streamCodexCompletion({
      executionTicket: `ticket-${attempt}`,
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket: {
        jti: `jti-${attempt}`,
        hostRef: 'research-host',
        model: REQUEST.model,
        requestHash: REQUEST_HASH,
        providerAttemptId: attempt,
      },
      maxDeadlineMs: 300_000,
      redeem: vi.fn(async () => redeemSuccess()),
      finalize,
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    return { pending, finalize, fetchFn }
  }

  it.each([
    { events: 'the transcribed error + response.failed pair', frames: UPSTREAM_CONTEXT_OVERFLOW_FRAMES },
    { events: 'the error event alone', frames: [sseFrame(UPSTREAM_CONTEXT_ERROR_EVENT)] },
    { events: 'the response.failed event alone', frames: [sseFrame(UPSTREAM_CONTEXT_FAILED_EVENT)] },
  ])('T-R7-2a maps $events to context_length_exceeded', async ({ frames }) => {
    const { pending, finalize, fetchFn } = failingStream(frames, 'att-context')
    await expect(pending).rejects.toMatchObject({
      name: 'CodexTransportError',
      code: 'context_length_exceeded',
    })
    // Witness: the upstream stream was fetched and the attempt finalized as an error.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({ receipt: expect.objectContaining({ outcome: 'error' }) })
    )
  })

  // Controls: only `context_length_exceeded` is forwarded. A failure without a
  // code, or with any other upstream code, stays a provider outage, so an
  // upstream string never becomes a Host-visible code by itself.
  it.each([
    { events: 'response.failed without an error code', event: { type: 'response.failed' } },
    {
      events: 'response.failed with another upstream code',
      event: { type: 'response.failed', response: { error: { code: 'server_error' } } },
    },
    {
      events: 'an error event with another upstream code',
      event: { type: 'error', error: { code: 'rate_limit_exceeded' } },
    },
  ])('T-R7-2b keeps $events as provider_unavailable', async ({ event }) => {
    const { pending, fetchFn } = failingStream([sseFrame(event)], 'att-other')
    await expect(pending).rejects.toMatchObject({
      name: 'CodexTransportError',
      code: 'provider_unavailable',
      message: 'upstream response failed',
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it.each([256, 257])(
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
      const pending = streamCodexCompletion({
        maxDeadlineMs: 1_800_000,
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
      if (count === 256) {
        expect((await pending).outcome).toBe('success')
        expect(emitted.filter(frame => frame.type === 'tool_call')).toHaveLength(256)
      } else {
        await expect(pending).rejects.toMatchObject({
          name: 'CodexTransportError',
          code: 'tool_call_limit_exceeded',
          message: 'tool calls exceed 256',
          details: { limit: 256, observed: 257 },
        })
        expect(emitted.filter(frame => frame.type === 'tool_call')).toHaveLength(0)
        expect(finalize).toHaveBeenCalledWith(
          expect.objectContaining({ receipt: expect.objectContaining({ outcome: 'error' }) })
        )
      }
    }
  )
  it('validates ticket bindings before redeem and maps stream frames including tool-call data', async () => {
    const redeem = vi.fn(async () => redeemSuccess())
    const finalize = vi.fn(async () => ({
      providerAttemptId: 'att-1',
      outcome: 'success' as const,
      duplicate: false,
    }))
    const frames: unknown[] = []
    const fetchFn = vi.fn(async (url: FetchInput, _init?: RequestInit) => {
      expect(url).toBe(CODEX_COMPLETIONS_ORIGIN)
      return sseResponse([
        'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
        'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"call-1","name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}\n\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
      ])
    })

    const result = await streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
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
    expect(headerOf(fetchFn.mock.calls[0]?.[1], 'originator')).toBe('evenfire')
    expect(headerOf(fetchFn.mock.calls[0]?.[1], 'openai-beta')).toBe('responses=v1')
    expect(headerOf(fetchFn.mock.calls[0]?.[1], 'session_id')).toBe('req-001')
    expect(headerOf(fetchFn.mock.calls[0]?.[1], 'chatgpt-account-id')).toBe('acct_live_1')
    expect(String(fetchFn.mock.calls[0]?.[1]?.body)).toContain('"store":false')
  })

  it('flushes a completed event that arrives without a trailing blank line', async () => {
    const fetchFn = vi.fn(async (_url: FetchInput, _init?: RequestInit) =>
      sseResponse([
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
      ])
    )
    const result = await streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
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
    const result = await streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
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

  it('uses the redeemed ChatGPT account id when the access token is opaque', async () => {
    const fetchFn = vi.fn(async (_url: FetchInput, _init?: RequestInit) =>
      sseResponse(['data: {"type":"response.completed","response":{"usage":{}}}\n\n'])
    )
    await streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
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
        outcome: 'success' as const,
        duplicate: false,
      })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    expect(headerOf(fetchFn.mock.calls[0]?.[1], 'chatgpt-account-id')).toBe('acct_from_id_token')
  })

  it('keeps the redeemed ChatGPT account id when the access token JWT names another account', async () => {
    const fetchFn = vi.fn(async (_url: FetchInput, _init?: RequestInit) =>
      sseResponse(['data: {"type":"response.completed","response":{"usage":{}}}\n\n'])
    )
    await streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
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
        redeemSuccess({
          accessToken: accessTokenFor('other-account'),
          chatgptAccountId: 'acct_stored',
        }),
      finalize: vi.fn(async () => ({
        providerAttemptId: 'att-1',
        outcome: 'success' as const,
        duplicate: false,
      })),
      fetchFn,
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    expect(headerOf(fetchFn.mock.calls[0]?.[1], 'chatgpt-account-id')).toBe('acct_stored')
  })

  it('refuses to fetch completions when the access token has no ChatGPT account id', async () => {
    const fetchFn = vi.fn()
    await expect(
      streamCodexCompletion({
        maxDeadlineMs: 1_800_000,
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
    ).rejects.toMatchObject({ code: 'connection_unavailable' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects a mutated requestHash before redeem', async () => {
    const redeem = vi.fn()
    await expect(
      streamCodexCompletion({
        maxDeadlineMs: 1_800_000,
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
    } satisfies Partial<CodexTransportError>)
    expect(redeem).not.toHaveBeenCalled()
  })

  it('rejects a served-model mismatch and loopback redirects', async () => {
    await expect(
      streamCodexCompletion({
        maxDeadlineMs: 1_800_000,
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
      streamCodexCompletion({
        maxDeadlineMs: 1_800_000,
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

  it('calls onRedeemed once, after a matching redeem and before the upstream fetch', async () => {
    const ticket = {
      jti: 'jti-redeemed',
      hostRef: 'research-host',
      model: REQUEST.model,
      requestHash: REQUEST_HASH,
      providerAttemptId: 'att-redeemed',
    }
    const finalize = vi.fn(async () => ({
      providerAttemptId: 'att-redeemed',
      outcome: 'success' as const,
      duplicate: false,
    }))
    const order: string[] = []
    await streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
      executionTicket: 'ticket-redeemed',
      requestHash: REQUEST_HASH,
      request: REQUEST,
      ticket,
      redeem: async () => {
        order.push('redeem')
        return redeemSuccess()
      },
      onRedeemed: () => order.push('onRedeemed'),
      finalize,
      fetchFn: vi.fn(async () => {
        order.push('fetch')
        return sseResponse(['data: {"type":"response.completed","response":{"usage":{}}}\n\n'])
      }),
      lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    })
    expect(order).toEqual(['redeem', 'onRedeemed', 'fetch'])

    // A denied redeem and a served-model mismatch never start the heartbeat.
    const denied = vi.fn(async (): Promise<RedeemAttemptSuccess> => {
      throw new Error('no_grant')
    })
    const mismatched = vi.fn(async () =>
      redeemSuccess({ transport: { ...redeemSuccess().transport, servedModel: 'other' } })
    )
    const onRedeemed = vi.fn()
    for (const redeem of [denied, mismatched]) {
      await expect(
        streamCodexCompletion({
          maxDeadlineMs: 1_800_000,
          executionTicket: 'ticket-redeemed',
          requestHash: REQUEST_HASH,
          request: REQUEST,
          ticket,
          redeem,
          onRedeemed,
          finalize,
          fetchFn: vi.fn(),
          lookup: async () => [{ address: '1.2.3.4', family: 4 }],
        })
      ).rejects.toThrow()
    }
    // Witness: both redeems ran, so the path that could call onRedeemed was entered.
    expect(denied).toHaveBeenCalledTimes(1)
    expect(mismatched).toHaveBeenCalledTimes(1)
    expect(onRedeemed).not.toHaveBeenCalled()
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
      maxDeadlineMs: 1_800_000,
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
      streamCodexCompletion({
        maxDeadlineMs: 1_800_000,
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
    let upstreamCanceled = false
    const fetchFn = vi.fn(async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"x"}\n\n')
          )
          setTimeout(() => {
            if (!upstreamCanceled) controller.close()
          }, 20)
        },
        cancel() {
          upstreamCanceled = true
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    })

    const frames: unknown[] = []
    const result = await streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
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
    expect(upstreamCanceled).toBe(true)
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
    await streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
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
    await streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
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
    const result = await streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
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
      tools: Array.from({ length: 250 }, (_, index) => ({
        name: index === 0 ? 'echo' : `approved_tool_${index}`,
        description: `Approved tool ${index}`,
        parameters: { type: 'object', properties: { x: { type: 'integer' } } },
      })),
      generation: { toolChoice: 'auto' as const },
      transportHints: { promptCacheKey: 'sess-1' },
    }
    const requestHash = hashCodexCompletionRequestV1(request)
    const fetchFn = vi.fn(async (_url: FetchInput, _init?: RequestInit) =>
      sseResponse(['data: {"type":"response.completed","response":{"usage":{}}}\n\n'])
    )
    await streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
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
    const requestHash = hashCodexCompletionRequestV1(request)
    expect(parseCodexCompletionRequestV1(request).ok).toBe(true)
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
    const result = await streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
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
    expect(hashCodexCompletionRequestV1(request)).toBe(requestHash)
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
    const requestHash = hashCodexCompletionRequestV1(request)
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      return sseResponse([
        ...[body.tools[0].name, '__codex_tool_unregistered'].map(
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
      streamCodexCompletion({
        maxDeadlineMs: 1_800_000,
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
    await streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
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

  it('keeps analysis instructions but omits max_output_tokens and temperature', async () => {
    const request = {
      ...REQUEST,
      messages: [
        { role: 'system' as const, content: 'review this repository' },
        { role: 'user' as const, content: 'findings' },
      ],
      generation: { maxOutputTokens: 4096, temperature: 0.2 },
    }
    const requestHash = hashCodexCompletionRequestV1(request)
    const fetchFn = vi.fn(async (_url: FetchInput, _init?: RequestInit) =>
      sseResponse(['data: {"type":"response.completed","response":{"usage":{}}}\n\n'])
    )
    await streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
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
    expect(body).not.toHaveProperty('max_output_tokens')
    expect(body).not.toHaveProperty('temperature')
  })

  it('maps upstream 400 to invalid_request and finalizes error without usage', async () => {
    const finalize = vi.fn(
      async (_input: Parameters<StreamCodexCompletionInput['finalize']>[0]) => ({
        providerAttemptId: 'att-1',
        outcome: 'error' as const,
        duplicate: false,
      })
    )
    await expect(
      streamCodexCompletion({
        maxDeadlineMs: 1_800_000,
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

  // R9-6 (L-9): a context-window refusal can also arrive as a plain HTTP error
  // before any stream starts. The recorded trace carries the SSE events; this
  // HTTP body wraps the same error object in `{ error }` (not recorded).
  describe('non-success upstream bodies (R9-6)', () => {
    const contextErrorBody = JSON.stringify({ error: UPSTREAM_CONTEXT_ERROR_EVENT.error })

    function streamWith(response: () => Response) {
      const finalize = vi.fn(
        async (_input: Parameters<StreamCodexCompletionInput['finalize']>[0]) => ({
          providerAttemptId: 'att-1',
          outcome: 'error' as const,
          duplicate: false,
        })
      )
      const pending = streamCodexCompletion({
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
        maxDeadlineMs: 300_000,
        redeem: async () => redeemSuccess(),
        finalize,
        fetchFn: vi.fn(async (_url: FetchInput, _init?: RequestInit) => response()),
        lookup: async () => [{ address: '1.2.3.4', family: 4 }],
      })
      return { pending, finalize }
    }

    it('T-R9-6a maps an HTTP 400 whose error.code is context_length_exceeded to context_length_exceeded', async () => {
      const { pending, finalize } = streamWith(
        () =>
          new Response(contextErrorBody, {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
      )
      await expect(pending).rejects.toMatchObject({ code: 'context_length_exceeded' })
      expect(finalize).toHaveBeenCalledWith(
        expect.objectContaining({ receipt: expect.objectContaining({ outcome: 'error' }) })
      )
    })

    it('T-R9-6b maps the same body on a 5xx to context_length_exceeded', async () => {
      const { pending } = streamWith(() => new Response(contextErrorBody, { status: 500 }))
      await expect(pending).rejects.toMatchObject({ code: 'context_length_exceeded' })
    })

    it('T-R9-6c keeps the status mapping for every other error body', async () => {
      const other = JSON.stringify({ error: { code: 'rate_limit_exceeded' } })
      await expect(
        streamWith(() => new Response(other, { status: 400 })).pending
      ).rejects.toMatchObject({ code: 'invalid_request' })
      await expect(
        streamWith(() => new Response(other, { status: 429 })).pending
      ).rejects.toMatchObject({ code: 'provider_unavailable' })
      await expect(
        streamWith(() => new Response(contextErrorBody, { status: 401 })).pending
      ).rejects.toMatchObject({ code: 'connection_unavailable' })
      await expect(
        streamWith(() => new Response('{"error":', { status: 400 })).pending
      ).rejects.toMatchObject({ code: 'invalid_request' })
    })

    it('T-R9-6d reads a bounded prefix of an endless error body and keeps the status mapping', async () => {
      const chunk = new TextEncoder().encode(`{"pad":"${'x'.repeat(1024)}`)
      let pulled = 0
      let canceled = false
      // highWaterMark 0: nothing is pulled until a reader asks for it.
      const endless = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulled += chunk.byteLength
            controller.enqueue(chunk)
          },
          cancel() {
            canceled = true
          },
        },
        { highWaterMark: 0 }
      )
      const { pending } = streamWith(() => new Response(endless, { status: 400 }))
      await expect(pending).rejects.toMatchObject({ code: 'invalid_request' })
      // Witness: the body was read, and the read stopped at a bound.
      expect(pulled).toBeGreaterThan(0)
      expect(canceled).toBe(true)
      expect(pulled).toBeLessThan(1024 * 1024)
    })
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
    await streamCodexCompletion({
      maxDeadlineMs: 1_800_000,
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

  describe('malformed tool-call arguments fail closed', () => {
    const sse = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`
    const textBefore = sse({ type: 'response.output_text.delta', delta: 'before' })
    const completed = sse({ type: 'response.completed', response: { usage: {} } })
    const openCall = sse({
      type: 'response.output_item.added',
      item: {
        type: 'function_call',
        id: 'item-1',
        call_id: 'call-9',
        name: 'lookup',
        arguments: '',
      },
    })
    const truncatedDelta = sse({
      type: 'response.function_call_arguments.delta',
      item_id: 'item-1',
      delta: '{"q":',
    })

    async function runUpstream(events: string[], options: { abortOnFrame?: boolean } = {}) {
      const frames: Array<{ type: string }> = []
      const abort = new AbortController()
      const fetchFn = vi.fn(async (_url: FetchInput, _init?: RequestInit) => sseResponse(events))
      const finalize = vi.fn(
        async (input: Parameters<StreamCodexCompletionInput['finalize']>[0]) => ({
          providerAttemptId: 'att-1',
          outcome: input.receipt.outcome,
          duplicate: false,
        })
      )
      const settled = await streamCodexCompletion({
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
        maxDeadlineMs: 300_000,
        redeem: async () => redeemSuccess(),
        finalize,
        fetchFn,
        lookup: async () => [{ address: '1.2.3.4', family: 4 }],
        onFrame: frame => {
          frames.push(frame)
          if (options.abortOnFrame) abort.abort()
        },
      }).then(
        result => ({ rejected: false as const, result }),
        (error: unknown) => ({ rejected: true as const, error })
      )
      return { settled, frames, fetchFn, finalize }
    }

    async function expectRefused(events: string[]) {
      const { settled, frames, fetchFn, finalize } = await runUpstream(events)
      // Liveness: the upstream was called and its stream was consumed far enough
      // to deliver the text that precedes the call. Without these, "no tool_call
      // frame" below would also hold for a transport that never ran.
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(frames).toContainEqual({ type: 'text', text: 'before' })
      // The defect: the malformed call became an executable call with `{}`.
      expect(frames.filter(frame => frame.type === 'tool_call')).toEqual([])
      expect(settled).toMatchObject({
        rejected: true,
        error: { name: 'CodexTransportError', code: 'invalid_tool_arguments' },
      })
      expect(finalize).toHaveBeenCalledTimes(1)
      expect(finalize.mock.calls[0]?.[0]?.receipt.outcome).toBe('error')
    }

    it.each([
      ['truncated JSON', '{"q":'],
      ['a JSON value that is not an object', '[1,2]'],
    ])(
      'refuses a function_call closed by response.output_item.done with %s as arguments',
      async (_label, rawArguments) => {
        await expectRefused([
          textBefore,
          sse({
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              id: 'item-1',
              call_id: 'call-9',
              name: 'lookup',
              arguments: rawArguments,
            },
          }),
          completed,
        ])
      }
    )

    it('refuses a call whose argument deltas never complete before the stream ends', async () => {
      await expectRefused([textBefore, openCall, truncatedDelta, completed])
    })

    // A closed call is the whole call, so empty `arguments` there mean "no
    // parameters", not "truncated". An unclosed call gives no such guarantee.
    async function expectAcceptedWithoutParameters(events: string[]) {
      const { settled, frames, fetchFn, finalize } = await runUpstream(events)
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(settled).toMatchObject({ rejected: false, result: { outcome: 'success' } })
      // Exactly one call, with no parameters: the positive frame is the witness.
      expect(frames).toEqual([
        { type: 'text', text: 'before' },
        { type: 'tool_call', id: 'call-9', name: 'lookup', arguments: {} },
      ])
      expect(finalize).toHaveBeenCalledTimes(1)
      expect(finalize.mock.calls[0]?.[0]?.receipt.outcome).toBe('success')
    }

    it.each([
      ['an empty string', ''],
      ['a whitespace-only string', ' \n '],
    ])(
      'accepts a function_call closed by response.output_item.done with %s as arguments as a call with no parameters',
      async (_label, rawArguments) => {
        await expectAcceptedWithoutParameters([
          textBefore,
          sse({
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              id: 'item-1',
              call_id: 'call-9',
              name: 'lookup',
              arguments: rawArguments,
            },
          }),
          completed,
        ])
      }
    )

    it('accepts a call opened with empty arguments and closed by response.function_call_arguments.done with none', async () => {
      await expectAcceptedWithoutParameters([
        textBefore,
        openCall,
        sse({ type: 'response.function_call_arguments.done', item_id: 'item-1', arguments: '' }),
        completed,
      ])
    })

    it.each([
      ['an empty string', ''],
      ['a whitespace-only string', ' \n '],
    ])(
      'refuses a call whose truncated deltas are closed by a done event with %s as arguments',
      async (_label, rawArguments) => {
        await expectRefused([
          textBefore,
          openCall,
          truncatedDelta,
          sse({
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              id: 'item-1',
              call_id: 'call-9',
              name: 'lookup',
              arguments: rawArguments,
            },
          }),
          completed,
        ])
      }
    )

    // R9-9 (L-12): the positive twin of the case above. A blank close carries
    // nothing new, so complete deltas survive it and the call runs with them.
    const closeWith: Record<string, (rawArguments: string) => string> = {
      'response.output_item.done': rawArguments =>
        sse({
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            id: 'item-1',
            call_id: 'call-9',
            name: 'lookup',
            arguments: rawArguments,
          },
        }),
      'response.function_call_arguments.done': rawArguments =>
        sse({
          type: 'response.function_call_arguments.done',
          item_id: 'item-1',
          arguments: rawArguments,
        }),
    }
    it.each([
      ['response.output_item.done', 'an empty string', ''],
      ['response.output_item.done', 'a whitespace-only string', ' \n '],
      ['response.function_call_arguments.done', 'an empty string', ''],
      ['response.function_call_arguments.done', 'a whitespace-only string', ' \n '],
    ])(
      'T-R9-9a keeps complete argument deltas when %s closes the call with %s',
      async (event, _label, rawArguments) => {
        const { settled, frames, fetchFn, finalize } = await runUpstream([
          textBefore,
          openCall,
          truncatedDelta,
          sse({ type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '"x"}' }),
          closeWith[event]!(rawArguments),
          completed,
        ])
        expect(fetchFn).toHaveBeenCalledTimes(1)
        expect(settled).toMatchObject({ rejected: false, result: { outcome: 'success' } })
        expect(frames).toEqual([
          { type: 'text', text: 'before' },
          { type: 'tool_call', id: 'call-9', name: 'lookup', arguments: { q: 'x' } },
        ])
        expect(finalize).toHaveBeenCalledTimes(1)
        expect(finalize.mock.calls[0]?.[0]?.receipt.outcome).toBe('success')
      }
    )

    it('refuses a call opened with empty arguments and never closed before the stream ends', async () => {
      await expectRefused([textBefore, openCall, completed])
    })

    // A canceled or failed stream also ends with its open call truncated. That
    // truncation is a consequence of the stream's own outcome, so the outcome
    // wins over the arguments refusal.
    it('keeps a client cancel that lands mid-arguments as canceled', async () => {
      const { settled, frames, fetchFn, finalize } = await runUpstream(
        [openCall, truncatedDelta, textBefore],
        { abortOnFrame: true }
      )
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(frames).toEqual([{ type: 'text', text: 'before' }])
      expect(settled).toMatchObject({ rejected: false, result: { outcome: 'canceled' } })
      expect(finalize).toHaveBeenCalledTimes(1)
      expect(finalize.mock.calls[0]?.[0]?.receipt.outcome).toBe('canceled')
    })

    it('reports an upstream failure that lands mid-arguments as provider_unavailable', async () => {
      const { settled, frames, fetchFn, finalize } = await runUpstream([
        textBefore,
        openCall,
        truncatedDelta,
        sse({ type: 'response.failed', response: {} }),
      ])
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(frames).toEqual([{ type: 'text', text: 'before' }])
      expect(settled).toMatchObject({
        rejected: true,
        error: { name: 'CodexTransportError', code: 'provider_unavailable' },
      })
      expect(finalize).toHaveBeenCalledTimes(1)
      expect(finalize.mock.calls[0]?.[0]?.receipt.outcome).toBe('error')
    })
  })
})

const TEXT_DELTA = 'data: {"type":"response.output_text.delta","delta":"x"}\n\n'
const COMPLETED = 'data: {"type":"response.completed","response":{"usage":{}}}\n\n'

/**
 * An upstream body that ignores `init.signal`, like a socket that stays open
 * while sending nothing. Only a transport that races each read against its own
 * timers can end an attempt reading from it.
 */
function upstreamBody(chunks: Array<{ afterMs: number; text: string } | 'stall'>): {
  fetchFn: typeof fetch
  cancel: ReturnType<typeof vi.fn>
} {
  const encoder = new TextEncoder()
  const cancel = vi.fn()
  const fetchFn = vi.fn(async () => {
    let index = 0
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const next = chunks[index]
          index += 1
          if (next === undefined) {
            controller.close()
            return
          }
          if (next === 'stall') {
            await new Promise<never>(() => undefined)
            return
          }
          await new Promise(resolve => setTimeout(resolve, next.afterMs))
          controller.enqueue(encoder.encode(next.text))
        },
        cancel,
      },
      { highWaterMark: 0 }
    )
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  return { fetchFn, cancel }
}

function attemptInput(
  overrides: Partial<StreamCodexCompletionInput>
): StreamCodexCompletionInput & { finalize: ReturnType<typeof vi.fn> } {
  const finalize = vi.fn(async (_input: Parameters<StreamCodexCompletionInput['finalize']>[0]) => ({
    providerAttemptId: 'att-timeouts',
    outcome: 'error' as const,
    duplicate: false,
  }))
  return {
    executionTicket: 'ticket-timeouts',
    requestHash: REQUEST_HASH,
    request: REQUEST,
    ticket: {
      jti: 'jti-timeouts',
      hostRef: 'research-host',
      model: REQUEST.model,
      requestHash: REQUEST_HASH,
      providerAttemptId: 'att-timeouts',
    },
    maxDeadlineMs: 300_000,
    redeem: async () => redeemSuccess(),
    finalize,
    fetchFn: upstreamBody([]).fetchFn,
    lookup: async () => [{ address: '1.2.3.4', family: 4 }],
    ...overrides,
  } as StreamCodexCompletionInput & { finalize: ReturnType<typeof vi.fn> }
}

function finalizedOutcome(finalize: ReturnType<typeof vi.fn>): unknown {
  expect(finalize).toHaveBeenCalledTimes(1)
  return (finalize.mock.calls[0]?.[0] as { receipt: { outcome: string } }).receipt.outcome
}

describe('streamCodexCompletion upstream timeouts', () => {
  it('ends a stalled upstream stream at the idle timeout with a typed provider_unavailable', async () => {
    const upstream = upstreamBody([{ afterMs: 0, text: TEXT_DELTA }, 'stall'])
    const input = attemptInput({ fetchFn: upstream.fetchFn, upstreamIdleTimeoutMs: 50 })
    const frames: unknown[] = []
    const error = await streamCodexCompletion({ ...input, onFrame: frame => void frames.push(frame) }).then(
      () => undefined,
      (err: unknown) => err
    )
    expect(frames).toEqual([{ type: 'text', text: 'x' }])
    expect(error).toBeInstanceOf(CodexTransportError)
    expect(error).toMatchObject({
      code: 'provider_unavailable',
      message: 'upstream stream idle timeout',
      details: { idleTimeoutMs: 50 },
    })
    expect(finalizedOutcome(input.finalize)).toBe('error')
    expect(upstream.cancel).toHaveBeenCalledTimes(1)
  }, 2_000)

  it('keeps the attempt alive while upstream chunks arrive inside the idle window', async () => {
    const chunks = Array.from({ length: 6 }, () => ({ afterMs: 30, text: TEXT_DELTA }))
    const upstream = upstreamBody([...chunks, { afterMs: 30, text: COMPLETED }])
    const input = attemptInput({ fetchFn: upstream.fetchFn, upstreamIdleTimeoutMs: 50 })
    const result = await streamCodexCompletion(input)
    expect(result.outcome).toBe('success')
    expect(finalizedOutcome(input.finalize)).toBe('success')
  }, 2_000)

  it('ends a still-active upstream stream at the total cap with stream_duration_exceeded', async () => {
    const endless = Array.from({ length: 200 }, () => ({ afterMs: 10, text: TEXT_DELTA }))
    const upstream = upstreamBody(endless)
    const input = attemptInput({
      fetchFn: upstream.fetchFn,
      maxDeadlineMs: 150,
      upstreamIdleTimeoutMs: 1_000,
    })
    const error = await streamCodexCompletion(input).then(
      () => undefined,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(CodexTransportError)
    expect(error).toMatchObject({
      code: 'stream_duration_exceeded',
      message: 'upstream stream exceeded maxStreamDurationMs',
      details: { limitMs: 150 },
    })
    expect(finalizedOutcome(input.finalize)).toBe('error')
  }, 2_000)

  it('reports a client abort during a stalled stream as canceled, not as a timeout', async () => {
    const upstream = upstreamBody([{ afterMs: 0, text: TEXT_DELTA }, 'stall'])
    const abort = new AbortController()
    const input = attemptInput({
      fetchFn: upstream.fetchFn,
      signal: abort.signal,
      maxDeadlineMs: 1_000,
      upstreamIdleTimeoutMs: 1_000,
    })
    setTimeout(() => abort.abort(), 50)
    const result = await streamCodexCompletion(input)
    expect(result.outcome).toBe('canceled')
    expect(finalizedOutcome(input.finalize)).toBe('canceled')
    expect(upstream.cancel).toHaveBeenCalledTimes(1)
  }, 2_000)
})

describe('streamCodexCompletion deadline validation', () => {
  // The redeem consumes the single-use ticket, so a deadline that cannot be
  // served must be refused before it, while there is no receipt to finalize.
  it('rejects an invalid deadline before redeeming the ticket', async () => {
    const redeem = vi.fn(async () => redeemSuccess())
    const fetchFn = vi.fn()
    const input = attemptInput({
      deadlineMs: 0,
      redeem,
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    // Witness: the rejection names the deadline check, so the path ran.
    await expect(streamCodexCompletion(input)).rejects.toMatchObject({
      name: 'RequestLimitError',
      message: 'deadline is invalid',
    })
    expect(redeem).not.toHaveBeenCalled()
    expect(input.finalize).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
