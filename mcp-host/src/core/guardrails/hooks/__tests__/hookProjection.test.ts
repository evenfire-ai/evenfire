/**
 * `projectForHook` content projection (spec §8.4/§8.7): scope-not-scrub, the
 * system prompt is never exposed, and `pre_call` splits metadata vs content.
 */
import { describe, expect, it } from 'vitest'
import {
  type ChatMessage,
  FinishReason,
  type ToolCompletionRequest,
  type ToolCompletionResponse,
} from '../../../types'
import { projectForHook } from '../hookProjection'
import type { HookDescriptor } from '../types'

const desc = (over: Partial<HookDescriptor> = {}): HookDescriptor => ({
  id: 'h',
  endpoint: 'http://svc',
  path: '/',
  lifecyclePoints: ['pre_call', 'moderate', 'post_call', 'on_error'],
  capabilities: [],
  failMode: 'closed',
  order: 100,
  ...over,
})

const messages: ChatMessage[] = [
  { role: 'system', content: 'PROPRIETARY SYSTEM PROMPT' },
  { role: 'user', content: 'hello world' },
]

const request = (): ToolCompletionRequest =>
  ({
    messages,
    tools: [{ name: 'search' }] as unknown as ToolCompletionRequest['tools'],
    temperature: 0.4,
    max_tokens: 256,
    tool_choice: 'auto',
    signal: new AbortController().signal,
    usageContext: {
      some: 'internal-attribution',
    } as unknown as ToolCompletionRequest['usageContext'],
    systemPromptParts: {
      parts: ['secret'],
    } as unknown as ToolCompletionRequest['systemPromptParts'],
  }) as ToolCompletionRequest

const response = (): ToolCompletionResponse => ({
  content: 'answer',
  tool_calls: null,
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  finish_reason: FinishReason.Stop,
})

describe('pre_call projection', () => {
  it('metadata flavor → NO messages, keeps params + tool schemas', () => {
    const body = projectForHook(desc({ contentAccess: 'metadata' }), 'pre_call', {
      request: request(),
    }) as Record<string, unknown>
    expect(body.messages).toBeUndefined()
    expect(body.temperature).toBe(0.4)
    expect(body.max_tokens).toBe(256)
    expect(body.tool_choice).toBe('auto')
    expect(body.tools).toBeDefined()
  })

  it('content flavor → includes NON-system messages', () => {
    const body = projectForHook(desc({ contentAccess: 'content' }), 'pre_call', {
      request: request(),
    }) as Record<string, unknown>
    const msgs = body.messages as ChatMessage[]
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
  })

  it('absent contentAccess defaults to content (messages included)', () => {
    const body = projectForHook(desc(), 'pre_call', { request: request() }) as Record<
      string,
      unknown
    >
    expect((body.messages as ChatMessage[]).length).toBe(1)
  })
})

describe('system prompt is never exposed (any point, any flavor)', () => {
  for (const contentAccess of ['metadata', 'content', undefined] as const) {
    it(`pre_call (${contentAccess ?? 'absent'}) drops system-role + systemPromptParts + internal fields`, () => {
      const body = projectForHook(desc({ contentAccess }), 'pre_call', {
        request: request(),
      }) as Record<string, unknown>
      expect(body.systemPromptParts).toBeUndefined()
      expect(body.signal).toBeUndefined()
      expect(body.usageContext).toBeUndefined()
      const msgs = (body.messages as ChatMessage[] | undefined) ?? []
      expect(msgs.some(m => m.role === 'system')).toBe(false)
    })
  }

  it('moderate strips the system prompt but keeps user content', () => {
    const body = projectForHook(desc(), 'moderate', { request: request() }) as Record<
      string,
      unknown
    >
    expect(body.systemPromptParts).toBeUndefined()
    const msgs = body.messages as ChatMessage[]
    expect(msgs.every(m => m.role !== 'system')).toBe(true)
    expect(msgs[0].content).toBe('hello world')
  })
})

describe('post_call / on_error projection', () => {
  it('post_call sends only response{content,tool_calls,finish_reason} + usage', () => {
    const body = projectForHook(desc(), 'post_call', { response: response() }) as Record<
      string,
      unknown
    >
    expect(Object.keys(body).sort()).toEqual(['response', 'usage'])
    const r = body.response as Record<string, unknown>
    expect(Object.keys(r).sort()).toEqual(['content', 'finish_reason', 'tool_calls'])
  })

  it('on_error sends the projected request (no system) + the error', () => {
    const body = projectForHook(desc(), 'on_error', {
      request: request(),
      error: { code: 'boom' },
    }) as Record<string, unknown>
    expect(body.error).toEqual({ code: 'boom' })
    const req = body.request as Record<string, unknown>
    expect(req.systemPromptParts).toBeUndefined()
    expect((req.messages as ChatMessage[]).every(m => m.role !== 'system')).toBe(true)
  })

  it('on_error projects ONLY {code,message,retryable}, dropping provider/cause/status, and redacts the message', () => {
    const err = {
      code: 'LLM_RATE_LIMITED',
      message: 'rate limited; Authorization: Bearer sk-abc123secret',
      retryable: true,
      provider: 'openai',
      status: 429,
      cause: { headers: { 'x-request-id': 'req_leak' }, response: {} },
    }
    const body = projectForHook(desc(), 'on_error', { request: request(), error: err }) as Record<
      string,
      unknown
    >
    const e = body.error as Record<string, unknown>
    expect(Object.keys(e).sort()).toEqual(['code', 'message', 'retryable'])
    expect(e.code).toBe('LLM_RATE_LIMITED')
    expect(e.retryable).toBe(true)
    // provider / status / cause (→ headers/request metadata) are never forwarded.
    expect(e.provider).toBeUndefined()
    expect(e.status).toBeUndefined()
    expect(e.cause).toBeUndefined()
    // Secrets in the free-text message are redacted.
    expect(e.message as string).not.toContain('sk-abc123secret')
    expect(e.message as string).toContain('[redacted]')
  })

  it('on_error recovers a real Error message (Error.prototype.message is non-enumerable)', () => {
    const err = Object.assign(new Error('upstream failed'), { code: 'X' })
    const body = projectForHook(desc(), 'on_error', { request: request(), error: err }) as Record<
      string,
      unknown
    >
    // A naive {...err} spread would drop `message` entirely; projectError reads it by access.
    expect((body.error as Record<string, unknown>).message).toBe('upstream failed')
  })
})
