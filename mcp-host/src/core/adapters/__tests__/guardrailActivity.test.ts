/**
 * Guardrail-input-transparency — Phase A capture (spec §3, §5.1, §12.5).
 *
 * Measurement: HookedLlmPort attributes each source's signed token delta per LLM
 * call, skips no-op steps, records same-size rewrites as `changed`, and drops the
 * whole record on an estimator fault without affecting the turn. The measurement
 * tests inject a deterministic chars counter; one test exercises the production
 * `chars/4` default (dense-content-appropriate; the prose word-heuristic would
 * sign-flip on JSON/CSV — see estimateInputTokens).
 * Aggregation: ConversationManager.recordGuardrailActivity sums across a turn's
 * calls per source (§2.3 — the regression that matters most).
 */
import { describe, expect, it, vi } from 'vitest'
import { ConversationManager } from '../../conversation/conversation'
import type { BuiltinStep } from '../../guardrails/llm/builtinChain'
import type { LlmPort } from '../../interfaces'
import type {
  ChatMessage,
  Conversation,
  ToolCompletionRequest,
  TurnGuardrailActivity,
} from '../../types'
import { HookedLlmPort } from '../hookedLlmPort'

/** Deterministic counter injected by the measurement tests: total NON-system
 *  string-content chars (production defaults to a chars/4 estimate). */
function nonSystemChars(req: ToolCompletionRequest): number {
  return (req.messages ?? [])
    .filter(m => m.role !== 'system')
    .reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0)
}

function innerPort() {
  const completeWithTools = vi.fn(
    async () => ({ content: 'ok', tool_calls: null, usage: {}, finish_reason: 'stop' }) as never
  )
  const inner = {
    modelName: () => 'm',
    getTokenCounter: () => ({}) as never,
    complete: async () => ({}) as never,
    completeWithTools,
  } as unknown as LlmPort
  return { inner, completeWithTools }
}

function capture() {
  const records: TurnGuardrailActivity[] = []
  return { sink: (r: TurnGuardrailActivity) => records.push(r), records }
}

const msg = (content: string): ChatMessage => ({ role: 'user', content })
const req = (content: string): ToolCompletionRequest =>
  ({ messages: [msg(content)], tools: [] }) as unknown as ToolCompletionRequest

describe('HookedLlmPort guardrail-input measurement (§3)', () => {
  it('measures a built-in reduction as a negative delta and reports before/after', async () => {
    const { inner } = innerPort()
    const { sink, records } = capture()
    const long = 'a much longer user message here'
    const steps: BuiltinStep[] = [
      { sourceId: 'token-trim', shape: r => ({ ...r, messages: [msg('short')] }) },
    ]
    const hooked = new HookedLlmPort(inner, r => r, undefined, steps, sink, nonSystemChars)

    await hooked.completeWithTools(req(long))

    expect(records).toHaveLength(1)
    expect(records[0].tokensBefore).toBe(long.length)
    expect(records[0].tokensAfter).toBe('short'.length)
    expect(records[0].llmCalls).toBe(1)
    expect(records[0].changes).toEqual([
      {
        sourceId: 'token-trim',
        kind: 'builtin',
        deltaTokens: 'short'.length - long.length,
        changed: true,
        calls: 1,
      },
    ])
  })

  it('uses a chars/4 estimate by default and excludes system messages', async () => {
    const { inner } = innerPort()
    const { sink, records } = capture()
    // non-system 40 chars -> ceil(40/4)=10 ; rewritten to 8 chars -> 2. System excluded.
    const request = {
      messages: [{ role: 'system', content: 'S'.repeat(999) }, msg('X'.repeat(40))],
      tools: [],
    } as unknown as ToolCompletionRequest
    const steps: BuiltinStep[] = [
      {
        sourceId: 'token-trim',
        shape: r => ({ ...r, messages: [r.messages[0], msg('Y'.repeat(8))] }),
      },
    ]
    const hooked = new HookedLlmPort(inner, r => r, undefined, steps, sink) // default chars/4 estimator

    await hooked.completeWithTools(request)

    expect(records[0]).toMatchObject({ tokensBefore: 10, tokensAfter: 2 })
    expect(records[0].changes[0].deltaTokens).toBe(-8)
  })

  it('skips a no-op step entirely — it costs no count and no row (§3.2)', async () => {
    const { inner } = innerPort()
    const { sink, records } = capture()
    const counter = vi.fn(nonSystemChars)
    const steps: BuiltinStep[] = [
      { sourceId: 'prompt-shaping', shape: r => r }, // no-op: same object
      { sourceId: 'token-trim', shape: r => ({ ...r, messages: [msg('x')] }) },
    ]
    const hooked = new HookedLlmPort(inner, r => r, undefined, steps, sink, counter)

    await hooked.completeWithTools(req('hello world'))

    // begin() + the ONE acting step = 2 counts; the no-op adds nothing.
    expect(counter).toHaveBeenCalledTimes(2)
    expect(records[0].changes.map(c => c.sourceId)).toEqual(['token-trim'])
  })

  it('records a same-size rewrite as changed:true with delta 0 (D4)', async () => {
    const { inner } = innerPort()
    const { sink, records } = capture()
    const steps: BuiltinStep[] = [
      {
        sourceId: 'prompt-shaping',
        shape: r => ({ ...r, messages: r.messages.map(m => ({ ...m })) }),
      },
    ]
    const hooked = new HookedLlmPort(inner, r => r, undefined, steps, sink, nonSystemChars)

    await hooked.completeWithTools(req('unchanged'))

    expect(records[0].changes).toEqual([
      { sourceId: 'prompt-shaping', kind: 'builtin', deltaTokens: 0, changed: true, calls: 1 },
    ])
  })

  it('an estimator fault drops the record without affecting the turn (§3.4)', async () => {
    const { inner, completeWithTools } = innerPort()
    const { sink, records } = capture()
    const boom = () => {
      throw new Error('estimator boom')
    }
    const steps: BuiltinStep[] = [
      { sourceId: 'token-trim', shape: r => ({ ...r, messages: [msg('x')] }) },
    ]
    const hooked = new HookedLlmPort(inner, r => r, undefined, steps, sink, boom)

    const res = await hooked.completeWithTools(req('hello'))

    expect(res.content).toBe('ok') // turn completed normally
    expect(completeWithTools).toHaveBeenCalledTimes(1)
    expect(records).toHaveLength(0) // measurement dropped, no emit
  })

  it('runs NO measurement when no sink is wired (fast path unchanged)', async () => {
    const { inner } = innerPort()
    const counter = vi.fn(nonSystemChars)
    const hooked = new HookedLlmPort(
      inner,
      r => ({ ...r, temperature: 0.9 }),
      undefined,
      undefined,
      undefined,
      counter
    )
    await hooked.completeWithTools(req('hi'))
    expect(counter).not.toHaveBeenCalled()
  })
})

describe('ConversationManager.recordGuardrailActivity aggregation (§2.3)', () => {
  const conv = (): Conversation => ({ guardrailActivity: undefined }) as unknown as Conversation

  it('sums per-source deltas and calls across a multi-call turn', () => {
    const m = new ConversationManager()
    const c = conv()
    m.recordGuardrailActivity(c, {
      tokensBefore: 100,
      tokensAfter: 80,
      llmCalls: 1,
      changes: [
        { sourceId: 'token-trim', kind: 'builtin', deltaTokens: -20, changed: true, calls: 1 },
      ],
    })
    m.recordGuardrailActivity(c, {
      tokensBefore: 90,
      tokensAfter: 75,
      llmCalls: 1,
      changes: [
        { sourceId: 'token-trim', kind: 'builtin', deltaTokens: -15, changed: true, calls: 1 },
        { sourceId: 'compactor', kind: 'hook', deltaTokens: -5, changed: true, calls: 1 },
      ],
    })

    const a = c.guardrailActivity!
    expect(a.tokensBefore).toBe(190)
    expect(a.tokensAfter).toBe(155)
    expect(a.llmCalls).toBe(2)
    const trim = a.changes.find(x => x.sourceId === 'token-trim')!
    expect(trim.deltaTokens).toBe(-35)
    expect(trim.calls).toBe(2) // a naive "last call wins" would report 1
    const comp = a.changes.find(x => x.sourceId === 'compactor')!
    expect(comp).toMatchObject({ deltaTokens: -5, calls: 1 })
  })
})
