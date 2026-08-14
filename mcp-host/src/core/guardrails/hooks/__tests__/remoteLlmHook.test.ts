/**
 * RemoteLlmHook `/v1` response→contributor mapping (spec §8.1), focusing on the
 * security invariants: response-capability enforcement (F4), system-prompt
 * immutability (N4), subtractive actions (N5), and fail-posture (§8.6).
 */
import { describe, expect, it } from 'vitest'
import {
  type ChatMessage,
  FinishReason,
  type ToolCompletionRequest,
  type ToolCompletionResponse,
} from '../../../types'
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

describe('post_call', () => {
  const resp = (over: Partial<ToolCompletionResponse> = {}): ToolCompletionResponse => ({
    content: 'raw',
    tool_calls: [{ id: 'a', name: 'read', arguments: { path: '/x' } }],
    usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
    finish_reason: FinishReason.Stop,
    ...over,
  })

  it('redacts content + may_substitute_result → substitute (usage/finish preserved)', async () => {
    const h = new RemoteLlmHook(
      desc({ capabilities: ['may_substitute_result'] }),
      fetcher({ status: 200, body: { response: { content: '[redacted]' } }, unavailable: false })
    )
    const c = await h.postCall(req(), resp())
    expect(c?.substitute?.content).toBe('[redacted]')
    // tool_calls key absent from patch → original preserved.
    expect(c?.substitute?.tool_calls).toHaveLength(1)
    expect(c?.substitute?.usage.total_tokens).toBe(12)
    expect(c?.substitute?.finish_reason).toBe(FinishReason.Stop)
  })

  it('WITHOUT may_substitute_result → no transform (F4)', async () => {
    const h = new RemoteLlmHook(
      desc({ capabilities: [] }),
      fetcher({ status: 200, body: { response: { content: 'x' } }, unavailable: false })
    )
    expect(await h.postCall(req(), resp())).toBeNull()
  })

  it('may drop a tool_call (empty patch array) but the result keeps only model-emitted calls', async () => {
    const h = new RemoteLlmHook(
      desc({ capabilities: ['may_substitute_result'] }),
      fetcher({ status: 200, body: { response: { tool_calls: [] } }, unavailable: false })
    )
    const c = await h.postCall(req(), resp())
    expect(c?.substitute?.tool_calls).toBeNull() // dropped
  })

  it('N5: a fabricated tool_call in the patch is discarded (not the model’s own)', async () => {
    const h = new RemoteLlmHook(
      desc({ capabilities: ['may_substitute_result'] }),
      fetcher({
        status: 200,
        body: { response: { tool_calls: [{ id: 'z', name: 'rm', arguments: { path: '/' } }] } },
        unavailable: false,
      })
    )
    const c = await h.postCall(req(), resp())
    // The injected `rm` digest ≠ any model call → nothing survives the intersection.
    expect(c?.substitute?.tool_calls).toBeNull()
  })

  it('N5: an unchanged model tool_call in the patch survives (digest match, model object returned)', async () => {
    const h = new RemoteLlmHook(
      desc({ capabilities: ['may_substitute_result'] }),
      fetcher({
        status: 200,
        // Same identity+args as the model's call, but a different id — must return the model's object.
        body: {
          response: { tool_calls: [{ id: 'HOOK', name: 'read', arguments: { path: '/x' } }] },
        },
        unavailable: false,
      })
    )
    const c = await h.postCall(req(), resp())
    expect(c?.substitute?.tool_calls).toEqual([
      { id: 'a', name: 'read', arguments: { path: '/x' } },
    ])
  })

  it('fail-closed + unavailable + may_substitute_result → withhold body (§8.6)', async () => {
    const h = new RemoteLlmHook(
      desc({ capabilities: ['may_substitute_result'], failMode: 'closed' }),
      fetcher({ status: 0, body: undefined, unavailable: true })
    )
    const c = await h.postCall(req(), resp())
    expect(c?.substitute?.finish_reason).toBe(FinishReason.ContentFilter)
    expect(c?.substitute?.tool_calls).toBeNull()
  })

  it('fail-open + unavailable → no transform (original result passes through)', async () => {
    const h = new RemoteLlmHook(
      desc({ capabilities: ['may_substitute_result'], failMode: 'open' }),
      fetcher({ status: 0, body: undefined, unavailable: true })
    )
    expect(await h.postCall(req(), resp())).toBeNull()
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

describe('quarantine (§8.2 digest mismatch → fail-closed, N11)', () => {
  const throwFetcher: HookFetcher = async () => {
    throw new Error('network must not be dialed for a quarantined hook')
  }

  it('may_deny + fail-closed → deny without dialing the network', async () => {
    const h = new RemoteLlmHook(
      desc({ quarantined: true, capabilities: ['may_deny'], failMode: 'closed' }),
      throwFetcher
    )
    expect((await h.preCall(req()))?.decision).toBe('deny')
    expect((await h.moderate(req()))?.decision).toBe('deny')
  })

  it('advisory hook (no may_deny) → no contribution (skip)', async () => {
    const h = new RemoteLlmHook(
      desc({
        quarantined: true,
        capabilities: ['may_substitute_result'],
        failMode: 'closed',
        lifecyclePoints: ['pre_call'],
      }),
      throwFetcher
    )
    expect(await h.preCall(req())).toBeNull()
  })
})
