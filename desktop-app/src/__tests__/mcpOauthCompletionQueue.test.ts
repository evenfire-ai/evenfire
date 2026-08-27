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
})
