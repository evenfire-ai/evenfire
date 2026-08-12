/**
 * LLM-lane built-in chain tests (spec §7.2): prompt-shaping param forcing + order.
 */
import { describe, expect, it } from 'vitest'
import type { ToolCompletionRequest } from '../../../types'
import { buildLlmBuiltinChain } from '../builtinChain'

const req = (): ToolCompletionRequest => ({ messages: [], tools: [] })

describe('buildLlmBuiltinChain', () => {
  it('identity shaper when no built-ins (no-config compatibility)', () => {
    const r = req()
    expect(buildLlmBuiltinChain(undefined)(r)).toEqual(r)
    expect(buildLlmBuiltinChain([])(r)).toEqual(r)
  })

  it('prompt-shaping forces temperature/max_tokens/tool_choice', () => {
    const shape = buildLlmBuiltinChain([
      { type: 'prompt-shaping', config: { temperature: 0.1, maxTokens: 500, toolChoice: 'auto' } },
    ])
    const out = shape(req())
    expect(out.temperature).toBe(0.1)
    expect(out.max_tokens).toBe(500)
    expect(out.tool_choice).toBe('auto')
  })

  it('applies built-ins in ascending order', () => {
    const shape = buildLlmBuiltinChain([
      { type: 'prompt-shaping', order: 20, config: { temperature: 0.9 } },
      { type: 'prompt-shaping', order: 10, config: { temperature: 0.1, maxTokens: 100 } },
    ])
    const out = shape(req())
    expect(out.temperature).toBe(0.9) // order 20 (later) wins for temperature
    expect(out.max_tokens).toBe(100) // only order 10 set it
  })

  it('does not mutate the input request', () => {
    const shape = buildLlmBuiltinChain([{ type: 'prompt-shaping', config: { temperature: 0.5 } }])
    const r = req()
    shape(r)
    expect(r.temperature).toBeUndefined()
  })

  it('skips unknown built-in types', () => {
    const r = req()
    expect(buildLlmBuiltinChain([{ type: 'token-trim' }])(r)).toEqual(r) // not yet implemented → no-op
  })
})
