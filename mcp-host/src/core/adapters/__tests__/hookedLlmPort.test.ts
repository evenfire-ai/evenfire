/**
 * HookedLlmPort tests (spec §7): main-lane shaping on completeWithTools, aux-lane
 * passthrough on complete, and inert wrapping when no built-ins are configured.
 */
import { describe, expect, it, vi } from 'vitest'
import { type FetchLike, type HookDescriptor, buildLlmLaneHooks } from '../../guardrails'
import type { LlmPort } from '../../interfaces'
import type { ToolCompletionRequest } from '../../types'
import { HookedLlmPort, maybeWrapHookedLlmPort } from '../hookedLlmPort'

function fakePort(): LlmPort & {
  lastToolReq?: ToolCompletionRequest
  complete: ReturnType<typeof vi.fn>
} {
  const p = {
    lastToolReq: undefined as ToolCompletionRequest | undefined,
    modelName: () => 'm',
    getTokenCounter: () => ({}) as never,
    complete: vi.fn(async () => ({ content: 'aux', usage: {}, finish_reason: 'stop' }) as never),
    completeWithTools: vi.fn(async (r: ToolCompletionRequest) => {
      p.lastToolReq = r
      return { content: 'main', tool_calls: null, usage: {}, finish_reason: 'stop' } as never
    }),
  }
  return p as LlmPort & { lastToolReq?: ToolCompletionRequest; complete: ReturnType<typeof vi.fn> }
}

describe('HookedLlmPort', () => {
  it('applies main-lane shaping on completeWithTools', async () => {
    const inner = fakePort()
    const hooked = new HookedLlmPort(inner, r => ({ ...r, temperature: 0.2 }))
    await hooked.completeWithTools({ messages: [], tools: [] })
    expect(inner.lastToolReq?.temperature).toBe(0.2)
  })

  it('passes complete (aux lane) through unshaped', async () => {
    const inner = fakePort()
    const hooked = new HookedLlmPort(inner, r => ({ ...r, temperature: 0.2 }))
    await hooked.complete({ messages: [] })
    expect(inner.complete).toHaveBeenCalledTimes(1)
  })

  it('delegates modelName', () => {
    const hooked = new HookedLlmPort(fakePort(), r => r)
    expect(hooked.modelName()).toBe('m')
  })
})

describe('installed hooks (end-to-end via HookedLlmPort)', () => {
  const dscr = (over: Partial<HookDescriptor>): HookDescriptor => ({
    id: 'h',
    endpoint: 'http://svc',
    path: '/',
    lifecyclePoints: [],
    capabilities: [],
    failMode: 'closed',
    order: 100,
    ...over,
  })

  it('a moderate deny returns a graceful refusal and aborts the in-flight call (§7.1)', async () => {
    const inner = fakePort()
    const moderateDeny: FetchLike = async url => ({
      status: url.endsWith('/v1/moderate') ? 422 : 200,
      text: async () => '{"code":"moderation_blocked"}',
    })
    const hooks = buildLlmLaneHooks(
      [dscr({ lifecyclePoints: ['moderate'], capabilities: ['may_deny'] })],
      {
        getAuthToken: () => '',
        fetchImpl: moderateDeny,
      }
    )
    const hooked = new HookedLlmPort(inner, r => r, hooks)
    const res = await hooked.completeWithTools({ messages: [], tools: [] })
    // Graceful: a normal Stop completion with a first-party refusal message, so
    // the turn completes instead of failing as LLM_CONTENT_FILTERED.
    expect(res.finish_reason).toBe('stop')
    expect(res.content).toBe(
      "I can't help with that — the request was flagged by a content policy."
    )
    expect(res.tool_calls).toBeNull()
    // Concurrent: the call is launched, then the moderation deny aborts it.
    expect(vi.mocked(inner.completeWithTools)).toHaveBeenCalledTimes(1)
    expect(inner.lastToolReq?.signal?.aborted).toBe(true)
  })

  it('a pre_call reject returns a graceful refusal without calling the model', async () => {
    const inner = fakePort()
    const preReject: FetchLike = async () => ({
      status: 200,
      text: async () => '{"action":"reject","code":"jailbreak_blocked"}',
    })
    const hooks = buildLlmLaneHooks(
      [dscr({ lifecyclePoints: ['pre_call'], capabilities: ['may_deny'] })],
      { getAuthToken: () => '', fetchImpl: preReject }
    )
    const hooked = new HookedLlmPort(inner, r => r, hooks)
    const res = await hooked.completeWithTools({ messages: [], tools: [] })
    expect(res.finish_reason).toBe('stop')
    expect(res.content).toBe("I can't comply with that request.")
    expect(vi.mocked(inner.completeWithTools)).not.toHaveBeenCalled()
  })

  it('moderation runs concurrently with the call; a pass proceeds to the result', async () => {
    const inner = fakePort()
    const moderatePass: FetchLike = async () => ({ status: 200, text: async () => '{}' })
    const hooks = buildLlmLaneHooks(
      [dscr({ lifecyclePoints: ['moderate'], capabilities: ['may_deny'] })],
      { getAuthToken: () => '', fetchImpl: moderatePass }
    )
    const hooked = new HookedLlmPort(inner, r => r, hooks)
    const res = await hooked.completeWithTools({ messages: [], tools: [] })
    expect(res.content).toBe('main')
    expect(inner.lastToolReq?.signal?.aborted).toBe(false) // not aborted on the happy path
  })

  it("the caller's abort signal still cancels the call under concurrent moderation", async () => {
    const inner = fakePort()
    const moderatePass: FetchLike = async () => ({ status: 200, text: async () => '{}' })
    const hooks = buildLlmLaneHooks(
      [dscr({ lifecyclePoints: ['moderate'], capabilities: ['may_deny'] })],
      { getAuthToken: () => '', fetchImpl: moderatePass }
    )
    const hooked = new HookedLlmPort(inner, r => r, hooks)
    const outer = new AbortController()
    outer.abort() // caller already cancelled
    await hooked.completeWithTools({ messages: [], tools: [], signal: outer.signal })
    expect(inner.lastToolReq?.signal?.aborted).toBe(true) // linked through to the call
  })

  it('a pre_call rewrite reaches the inner port', async () => {
    const inner = fakePort()
    const preCallRewrite: FetchLike = async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({ action: 'continue', patch: { params: { temperature: 0.1 } } }),
    })
    const hooks = buildLlmLaneHooks(
      [dscr({ lifecyclePoints: ['pre_call'], capabilities: ['may_rewrite'], failMode: 'open' })],
      {
        getAuthToken: () => '',
        fetchImpl: preCallRewrite,
      }
    )
    const hooked = new HookedLlmPort(inner, r => r, hooks)
    await hooked.completeWithTools({ messages: [], tools: [] })
    expect(inner.lastToolReq?.temperature).toBe(0.1)
  })

  it('a post_call hook redacts the model result', async () => {
    const inner = fakePort()
    const redact: FetchLike = async url => ({
      status: 200,
      text: async () =>
        url.endsWith('/v1/post_call') ? '{"response":{"content":"[redacted]"}}' : '{}',
    })
    const hooks = buildLlmLaneHooks(
      [dscr({ lifecyclePoints: ['post_call'], capabilities: ['may_substitute_result'] })],
      { getAuthToken: () => '', fetchImpl: redact }
    )
    const hooked = new HookedLlmPort(inner, r => r, hooks)
    const res = await hooked.completeWithTools({ messages: [], tools: [] })
    expect(res.content).toBe('[redacted]') // inner returned "main"
  })

  it('an on_error recover substitutes a safe result when the model call throws', async () => {
    const inner = fakePort()
    inner.completeWithTools = vi.fn(async () => {
      throw new Error('upstream 500')
    })
    const recover: FetchLike = async url => ({
      status: 200,
      text: async () =>
        url.endsWith('/v1/on_error') ? '{"action":"recover","response":{"content":"safe"}}' : '{}',
    })
    const hooks = buildLlmLaneHooks(
      [dscr({ lifecyclePoints: ['on_error'], capabilities: ['may_substitute_result'] })],
      { getAuthToken: () => '', fetchImpl: recover }
    )
    const hooked = new HookedLlmPort(inner, r => r, hooks)
    const res = await hooked.completeWithTools({ messages: [], tools: [] })
    expect(res.content).toBe('safe')
    expect(res.tool_calls).toBeNull()
  })

  it('the model error surfaces when no on_error hook recovers', async () => {
    const inner = fakePort()
    inner.completeWithTools = vi.fn(async () => {
      throw new Error('upstream 500')
    })
    const hooked = new HookedLlmPort(
      inner,
      r => r,
      buildLlmLaneHooks([], { getAuthToken: () => '' })
    )
    await expect(hooked.completeWithTools({ messages: [], tools: [] })).rejects.toThrow(
      'upstream 500'
    )
  })
})

describe('maybeWrapHookedLlmPort', () => {
  it('returns the port unchanged when no built-ins (inert)', () => {
    const inner = fakePort()
    expect(maybeWrapHookedLlmPort(inner, undefined)).toBe(inner)
    expect(maybeWrapHookedLlmPort(inner, { builtins: [] })).toBe(inner)
  })

  it('wraps when built-ins are configured', () => {
    const inner = fakePort()
    const wrapped = maybeWrapHookedLlmPort(inner, {
      builtins: [{ type: 'prompt-shaping', config: { temperature: 0.1 } }],
    })
    expect(wrapped).not.toBe(inner)
    expect(wrapped).toBeInstanceOf(HookedLlmPort)
  })
})
