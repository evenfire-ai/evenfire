import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hashGrokCompletionRequestV1,
  parseGrokCompletionRequestV1,
} from '@clerum/grok-provider-attempt-contract'
import {
  hashCodexCompletionRequestV1,
  parseCodexCompletionRequestV1,
} from '@clerum/llm-provider-attempt-contract'
import { CodexSubscriptionProvider } from '../codexSubscription'
import { GrokSubscriptionProvider } from '../grokSubscription'
import { CodexAuthorizeError } from '../providerAttemptAuthorizer'

// B-M1 / C-RP-015: mcp-host must hash exactly what control-api authorize and
// the proxies hash (the validated projection of the JSON wire request).

const uuid = vi.hoisted(() => ({ next: 0 }))
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto')
  return {
    ...actual,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid.next).padStart(12, '0')}`,
  }
})

function deps() {
  const authorize = vi.fn().mockResolvedValue({
    providerAttemptId: 'attempt-1',
    requestHash: 'f'.repeat(64),
    executionTicket: 'ticket-123456',
    expiresAt: '2026-08-20T10:00:00.000Z',
  })
  const stream = vi.fn().mockResolvedValue({ text: 'ok', toolCalls: [], outcome: 'success' })
  return {
    authorizer: { authorize },
    proxy: { stream },
    attemptContext: vi.fn(() => ({ policyRevision: 1, policyHash: 'b'.repeat(64) })),
    authorize,
    stream,
  }
}

const PROVIDERS = [
  {
    name: 'codex-subscription',
    model: 'gpt-5.3-codex',
    make: (wired: ReturnType<typeof deps>) =>
      new CodexSubscriptionProvider('gpt-5.3-codex', wired as never),
    serverHash: (wire: unknown) => {
      const parsed = parseCodexCompletionRequestV1(wire)
      if (!parsed.ok) throw new Error(parsed.message)
      return hashCodexCompletionRequestV1(parsed.value)
    },
    // Captured from the provider at a42dedf8, before canonical hashing.
    goldenToolsHash: 'ec9146face0ad4024b88c72906b47135e5cc986c64c700e8f1c3377dade3f4f2',
    goldenHistoryHash: 'e3c5a1f3317dd601c5aeab17c5b4914a180a5b40164059584004725701212cb2',
  },
  {
    name: 'grok-subscription',
    model: 'grok-4.6',
    make: (wired: ReturnType<typeof deps>) =>
      new GrokSubscriptionProvider('grok-4.6', wired as never),
    serverHash: (wire: unknown) => {
      const parsed = parseGrokCompletionRequestV1(wire)
      if (!parsed.ok) throw new Error(parsed.message)
      return hashGrokCompletionRequestV1(parsed.value)
    },
    // Captured from the provider at a42dedf8, before canonical hashing.
    goldenToolsHash: '507c127d04e04544ce92b2417e6d30c84033aef8609b501bfe305c1e61a526af',
    goldenHistoryHash: '76e9df10e95d15c489c713aa44a41163d8a346711ee97fdb9e53f4e575929b8e',
  },
] as const

/** What control-api computes from the authorize body it receives. */
function hashOnWire(p: (typeof PROVIDERS)[number], body: { request: unknown }): string {
  return p.serverHash(JSON.parse(JSON.stringify(body)).request)
}

const TOOLS = [
  {
    name: 'eventasks__read',
    description: 'Read a record',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
      required: ['id'],
    },
  },
]

describe.each(PROVIDERS)('$name request hashing', p => {
  beforeEach(() => {
    uuid.next = 0
  })

  it('keeps the pre-change digest for a well-formed tools + generation request', async () => {
    const wired = deps()
    await p.make(wired).completeSingleTurnWithTools([{ role: 'user', content: 'find it' }], TOOLS, {
      temperature: 0.2,
      max_tokens: 512,
      tool_choice: 'auto',
    })
    const body = wired.authorize.mock.calls[0][0]
    expect(body.requestHash).toBe(p.goldenToolsHash)
    expect(hashOnWire(p, body)).toBe(body.requestHash)
  })

  it('keeps the pre-change digest for a well-formed tool-call history request', async () => {
    const wired = deps()
    await p.make(wired).completeSingleTurnWithTools(
      [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'café 漢字 🎵' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-1', name: 'eventasks__read', arguments: { id: 'A-1' } }],
        },
        { role: 'tool', content: '{"ok":true}', tool_call_id: 'call-1', name: 'eventasks__read' },
      ],
      TOOLS
    )
    const body = wired.authorize.mock.calls[0][0]
    expect(body.requestHash).toBe(p.goldenHistoryHash)
    expect(hashOnWire(p, body)).toBe(body.requestHash)
  })

  it('agrees with the server hash when tool_choice is a tool name (empty generation)', async () => {
    const wired = deps()
    await p.make(wired).completeSingleTurnWithTools([{ role: 'user', content: 'hi' }], TOOLS, {
      tool_choice: 'eventasks__read',
    })
    const body = wired.authorize.mock.calls[0][0]
    expect(body.request).not.toHaveProperty('generation')
    expect(hashOnWire(p, body)).toBe(body.requestHash)
    // The proxy receives the same canonical request that was authorized.
    expect(wired.stream.mock.calls[0][0].request).toEqual(body.request)
  })

  it('fails an invalid request locally as a never-dispatched invalid_request', async () => {
    const wired = deps()
    const provider = p.make(wired)
    const attempt = provider.completeSingleTurn([{ role: 'user', content: 'hi' }], {
      temperature: 3,
    })
    await expect(attempt).rejects.toBeInstanceOf(CodexAuthorizeError)
    await expect(attempt).rejects.toMatchObject({ code: 'invalid_request' })
    expect(wired.authorize).not.toHaveBeenCalled()
    expect(wired.stream).not.toHaveBeenCalled()
    const classified = provider.classifyError(await attempt.catch(err => err))
    expect(classified.providerDispatched).toBe(false)
    expect(classified.retryable).toBe(false)
  })

  it('fails an over-deep tool schema locally without a stack overflow', async () => {
    let parameters: Record<string, unknown> = {}
    for (let i = 0; i < 150000; i++) parameters = { n: parameters }
    const wired = deps()
    const attempt = p
      .make(wired)
      .completeSingleTurnWithTools(
        [{ role: 'user', content: 'hi' }],
        [{ name: 'deep', description: 'deep', parameters }]
      )
    await expect(attempt).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(attempt).rejects.toThrow(/nesting depth/)
    expect(wired.authorize).not.toHaveBeenCalled()
  })
})
