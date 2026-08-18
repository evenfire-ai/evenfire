/**
 * Guardrail-input-transparency — Phase A capture (spec §3, §5.1, §12.5).
 *
 * Measurement: HookedLlmPort attributes each source's signed token delta per LLM
 * call, skips no-op steps, records same-size rewrites as `changed`, and drops the
 * whole record on a tokenizer fault without affecting the turn.
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

/** Deterministic stand-in for the tokenizer: total chars across string content. */
function chars(msgs: ChatMessage[]): number {
  return msgs.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0)
}

function innerPort(countSync: (m: ChatMessage[]) => number = chars) {
  const countFn = vi.fn((m: ChatMessage[]) => countSync(m))
  const completeWithTools = vi.fn(
    async () => ({ content: 'ok', tool_calls: null, usage: {}, finish_reason: 'stop' }) as never
  )
  const inner = {
    modelName: () => 'm',
    getTokenCounter: () => ({ countSync: countFn }) as never,
    complete: async () => ({}) as never,
    completeWithTools,
  } as unknown as LlmPort
  return { inner, countFn, completeWithTools }
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
    const hooked = new HookedLlmPort(inner, r => r, undefined, steps, sink)

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

  it('skips a no-op step entirely — it costs no count and no row (§3.2)', async () => {
    const { inner, countFn } = innerPort()
    const { sink, records } = capture()
    const steps: BuiltinStep[] = [
      { sourceId: 'prompt-shaping', shape: r => r }, // no-op: same object
      { sourceId: 'token-trim', shape: r => ({ ...r, messages: [msg('x')] }) },
    ]
    const hooked = new HookedLlmPort(inner, r => r, undefined, steps, sink)

    await hooked.completeWithTools(req('hello world'))

    // begin() + the ONE acting step = 2 counts; the no-op adds nothing.
    expect(countFn).toHaveBeenCalledTimes(2)
    expect(records[0].changes.map(c => c.sourceId)).toEqual(['token-trim'])
  })

  it('records a same-size rewrite as changed:true with delta 0 (D4)', async () => {
    const { inner } = innerPort()
    const { sink, records } = capture()
    // New object, identical content → count unchanged but request replaced.
    const steps: BuiltinStep[] = [
      {
        sourceId: 'prompt-shaping',
        shape: r => ({ ...r, messages: r.messages.map(m => ({ ...m })) }),
      },
    ]
    const hooked = new HookedLlmPort(inner, r => r, undefined, steps, sink)

    await hooked.completeWithTools(req('unchanged'))

    expect(records[0].changes).toEqual([
      { sourceId: 'prompt-shaping', kind: 'builtin', deltaTokens: 0, changed: true, calls: 1 },
    ])
  })

  it('a tokenizer fault drops the record without affecting the turn (§3.4)', async () => {
    const { inner, completeWithTools } = innerPort(() => {
      throw new Error('tokenizer boom')
    })
    const { sink, records } = capture()
    const steps: BuiltinStep[] = [
      { sourceId: 'token-trim', shape: r => ({ ...r, messages: [msg('x')] }) },
    ]
    const hooked = new HookedLlmPort(inner, r => r, undefined, steps, sink)

    const res = await hooked.completeWithTools(req('hello'))

    expect(res.content).toBe('ok') // turn completed normally
    expect(completeWithTools).toHaveBeenCalledTimes(1)
    expect(records).toHaveLength(0) // measurement dropped, no emit
  })

  it('runs NO measurement when no sink is wired (fast path unchanged)', async () => {
    const { inner, countFn } = innerPort()
    const hooked = new HookedLlmPort(inner, r => ({ ...r, temperature: 0.9 }))
    await hooked.completeWithTools(req('hi'))
    expect(countFn).not.toHaveBeenCalled()
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
