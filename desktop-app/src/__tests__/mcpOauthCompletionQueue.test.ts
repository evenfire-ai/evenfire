import { describe, expect, it, vi } from 'vitest'
import { McpOauthCompletionQueue } from '../mcpOauthCompletionQueue.js'

const A = { mcpServerName: 'monday', provider: 'google' }
const B = { mcpServerName: 'clickup', provider: 'clickup' }

describe('McpOauthCompletionQueue — U5 cold-start delivery (T5)', () => {
  it('delivers immediately when the renderer is ready (queue stays empty)', () => {
    const deliver = vi.fn().mockReturnValue(true)
    const queue = new McpOauthCompletionQueue(deliver)

    queue.submit(A)

    expect(deliver).toHaveBeenCalledOnce()
    expect(deliver).toHaveBeenCalledWith(A)
    expect(queue.pendingCount()).toBe(0)
  })

  it('a completion arriving BEFORE renderer-ready is queued, then delivered on drain (not lost)', () => {
    // deliver returns false while the renderer is not ready, true afterwards —
    // exactly the cold-start sequence (deep link before the ready handshake).
    let ready = false
    const deliver = vi.fn((_c: typeof A) => ready)
    const queue = new McpOauthCompletionQueue(deliver)

    // Cold start: deep link arrives before the renderer installs its listener.
    queue.submit(A)
    expect(queue.pendingCount()).toBe(1) // held, NOT swallowed
    expect(deliver).toHaveBeenCalledTimes(1) // one failed attempt

    // Renderer-ready handshake fires → drain flushes the held completion.
    ready = true
    queue.drain()

    expect(deliver).toHaveBeenLastCalledWith(A)
    expect(queue.pendingCount()).toBe(0)
  })

  it('queues multiple distinct completions across concurrent cold-start suspensions', () => {
    const deliver = vi.fn().mockReturnValue(false)
    const queue = new McpOauthCompletionQueue(deliver)

    queue.submit(A)
    queue.submit(B)
    expect(queue.pendingCount()).toBe(2)

    const delivered: Array<typeof A> = []
    const queue2Deliver = vi.fn((c: typeof A) => {
      delivered.push(c)
      return true
    })
    // Re-drain through a ready deliver by swapping behaviour: emulate readiness.
    deliver.mockImplementation(c => {
      queue2Deliver(c)
      return true
    })
    queue.drain()

    expect(delivered).toEqual([A, B])
    expect(queue.pendingCount()).toBe(0)
  })

  it('dedups an identical retried completion while queued', () => {
    const deliver = vi.fn().mockReturnValue(false)
    const queue = new McpOauthCompletionQueue(deliver)

    queue.submit(A)
    queue.submit(A)

    expect(queue.pendingCount()).toBe(1)
  })

  it('re-queues a completion the renderer still cannot accept mid-drain (never dropped)', () => {
    const deliver = vi.fn().mockReturnValue(false)
    const queue = new McpOauthCompletionQueue(deliver)

    queue.submit(A)
    queue.drain() // window died again → still not accepted

    expect(queue.pendingCount()).toBe(1)
  })

  it('L8b: an over-cap drop invokes onCapEvict with the OLDEST completion and the cap', () => {
    const deliver = vi.fn().mockReturnValue(false) // nothing accepted → everything queues
    const onCapEvict = vi.fn()
    const queue = new McpOauthCompletionQueue(deliver, 2, onCapEvict)

    const C = { mcpServerName: 'asana', provider: 'asana' }
    queue.submit(A) // [A]
    queue.submit(B) // [A, B]
    expect(onCapEvict).not.toHaveBeenCalled()
    queue.submit(C) // push → over cap → drop A (oldest)

    // The drop is now observable — it is NOT silent.
    expect(onCapEvict).toHaveBeenCalledOnce()
    expect(onCapEvict).toHaveBeenCalledWith(A, 2)
    expect(queue.pendingCount()).toBe(2)

    // Policy unchanged: the OLDEST (A) is gone, B and C survive.
    const delivered: Array<typeof A> = []
    deliver.mockImplementation(c => {
      delivered.push(c)
      return true
    })
    queue.drain()
    expect(delivered).toEqual([B, C])
  })

  it('L8b: the default cap-evict hook logs a warning (production observability)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const deliver = vi.fn().mockReturnValue(false)
    // Default onCapEvict (no injection) → must reach console.warn on a drop.
    const queue = new McpOauthCompletionQueue(deliver, 1)

    queue.submit(A) // [A]
    queue.submit(B) // over cap → drop A via the default warn hook

    expect(warn).toHaveBeenCalledOnce()
    const [message, context] = warn.mock.calls[0]!
    expect(String(message)).toContain('dropping oldest')
    // Non-sensitive context only: server/provider identity + cap, no URL/token.
    expect(context).toMatchObject({ mcpServerName: A.mcpServerName, provider: A.provider })
    warn.mockRestore()
  })
})
