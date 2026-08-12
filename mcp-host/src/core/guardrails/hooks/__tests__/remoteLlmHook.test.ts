/**
 * RemoteLlmHook `/v1` response→contributor mapping (spec §8.1), focusing on the
 * security invariants: response-capability enforcement (F4), system-prompt
 * immutability (N4), subtractive actions (N5), and fail-posture (§8.6).
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolCompletionRequest } from '../../../types'
import { RemoteLlmHook } from '../remoteLlmHook'
import type { HookDescriptor, HookFetcher, HookHttpResult } from '../types'

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

const fetcher =
  (result: HookHttpResult): HookFetcher =>
  async () =>
    result
const req = (messages: ChatMessage[] = []): ToolCompletionRequest => ({ messages, tools: [] })

describe('pre_call', () => {
  it('reject + may_deny → deny', async () => {
    const h = new RemoteLlmHook(
      desc({ capabilities: ['may_deny'] }),
      fetcher({ status: 200, body: { action: 'reject', code: 'pii' }, unavailable: false })
    )
    expect((await h.preCall(req()))?.decision).toBe('deny')
  })

  it('reject WITHOUT may_deny → downgraded to no_decision (F4)', async () => {
    const h = new RemoteLlmHook(
      desc({ capabilities: [] }),
      fetcher({ status: 200, body: { action: 'reject', code: 'pii' }, unavailable: false })
    )
    expect((await h.preCall(req()))?.decision).toBe('no_decision')
  })

  it('continue + patch + may_rewrite → rewrite (system-role messages stripped, N4)', async () => {
    const patch = {
      messages: [
        { role: 'system', content: 'evil' },
        { role: 'user', content: 'hi' },
      ],
      params: { temperature: 0.1 },
    }
    const h = new RemoteLlmHook(
      desc({ capabilities: ['may_rewrite'] }),
      fetcher({ status: 200, body: { action: 'continue', patch }, unavailable: false })
    )
    const c = await h.preCall(req())
    expect(c?.rewrite?.messages.every(m => m.role !== 'system')).toBe(true)
    expect(c?.rewrite?.messages).toHaveLength(1)
    expect(c?.rewrite?.temperature).toBe(0.1)
  })

  it('continue + patch WITHOUT may_rewrite → patch dropped (F4)', async () => {
    const h = new RemoteLlmHook(
      desc({ capabilities: [] }),
      fetcher({
        status: 200,
        body: { action: 'continue', patch: { params: { temperature: 0.9 } } },
        unavailable: false,
      })
    )
    expect(await h.preCall(req())).toBeNull()
  })
})

describe('pre_call non-conforming → fail-mode (§8.1)', () => {
  it('non-200 with may_deny → deny (never a silent allow)', async () => {
    const h = new RemoteLlmHook(
      desc({ capabilities: ['may_deny'] }),
      fetcher({ status: 418, body: {}, unavailable: false })
    )
    expect((await h.preCall(req()))?.decision).toBe('deny')
  })
  it('200 with no valid action + may_deny → deny', async () => {
    const h = new RemoteLlmHook(
      desc({ capabilities: ['may_deny'] }),
      fetcher({ status: 200, body: { nonsense: true }, unavailable: false })
    )
    expect((await h.preCall(req()))?.decision).toBe('deny')
  })
})

describe('moderate', () => {
  it('200 → pass (no contribution)', async () => {
    const h = new RemoteLlmHook(
      desc({ capabilities: ['may_deny'] }),
      fetcher({ status: 200, body: {}, unavailable: false })
    )
    expect(await h.moderate(req())).toBeNull()
  })
  it('4xx + may_deny → deny', async () => {
    const h = new RemoteLlmHook(
      desc({ capabilities: ['may_deny'] }),
      fetcher({ status: 422, body: { code: 'blocked' }, unavailable: false })
    )
    expect((await h.moderate(req()))?.decision).toBe('deny')
  })
})

describe('on_error', () => {
  it('recover + may_substitute_result → text-only substitute (N5: tool_calls dropped)', async () => {
    const h = new RemoteLlmHook(
      desc({ capabilities: ['may_substitute_result'] }),
      fetcher({
        status: 200,
        body: {
          action: 'recover',
          response: { content: 'safe', tool_calls: [{ id: 'x', name: 'rm', arguments: {} }] },
        },
        unavailable: false,
      })
    )
    const c = await h.onError(req(), new Error('boom'))
    expect(c?.substitute?.content).toBe('safe')
    expect(c?.substitute?.tool_calls).toBeNull() // injected tool_calls are dropped
  })
  it('recover WITHOUT may_substitute_result → no recovery', async () => {
    const h = new RemoteLlmHook(
      desc({ capabilities: [] }),
      fetcher({
        status: 200,
        body: { action: 'recover', response: { content: 'x' } },
        unavailable: false,
      })
    )
    expect(await h.onError(req(), new Error('boom'))).toBeNull()
  })
})

describe('fail-posture (§8.6)', () => {
  it('unavailable + failMode closed + may_deny → deny hook_unavailable', async () => {
    const h = new RemoteLlmHook(
      desc({ capabilities: ['may_deny'], failMode: 'closed' }),
      fetcher({ status: 0, body: undefined, unavailable: true })
    )
    const c = await h.moderate(req())
    expect(c?.decision).toBe('deny')
    expect(c?.reasonCode).toBe('hook_unavailable')
  })
  it('unavailable + failMode open → no contribution', async () => {
    const h = new RemoteLlmHook(
      desc({ capabilities: ['may_deny'], failMode: 'open' }),
      fetcher({ status: 0, body: undefined, unavailable: true })
    )
    expect(await h.moderate(req())).toBeNull()
  })
})

describe('lifecycle scoping', () => {
  it('a point the hook does not subscribe to → null', async () => {
    const h = new RemoteLlmHook(
      desc({ lifecyclePoints: ['moderate'] }),
      fetcher({ status: 200, body: { action: 'reject' }, unavailable: false })
    )
    expect(await h.preCall(req())).toBeNull()
  })
})
