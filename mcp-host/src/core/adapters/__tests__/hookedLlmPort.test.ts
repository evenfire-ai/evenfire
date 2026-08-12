/**
 * HookedLlmPort tests (spec §7): main-lane shaping on completeWithTools, aux-lane
 * passthrough on complete, and inert wrapping when no built-ins are configured.
 */
import { describe, expect, it, vi } from 'vitest'
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
