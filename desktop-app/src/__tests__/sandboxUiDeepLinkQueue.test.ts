import { describe, expect, it } from 'vitest'
import { SandboxUiDeepLinkQueue } from '../sandboxUiDeepLinkQueue.js'

describe('SandboxUiDeepLinkQueue', () => {
  it('deduplicates semantic targets and acknowledges the matching envelope', () => {
    const queue = new SandboxUiDeepLinkQueue()
    const first = queue.enqueue({ appRef: 'ns/app', path: '/inbox', teamId: 'team-1' })
    expect(first.id).toBe(1)
    expect(queue.enqueue({ appRef: 'NS/APP', path: '/inbox', teamId: 'team-1' })).toEqual(first)
    queue.acknowledge(first.id)
    expect(queue.list()).toEqual([])
  })

  it('replays an earlier link when its ack fails and a newer link is acknowledged', async () => {
    const queue = new SandboxUiDeepLinkQueue()
    const first = queue.enqueue({ appRef: 'ns/first' })
    const second = queue.enqueue({ appRef: 'ns/second' })
    const acknowledge = async (id: number) => {
      if (id === first.id) throw new Error('Renderer acknowledgement failed')
      queue.acknowledge(id)
    }

    await expect(acknowledge(first.id)).rejects.toThrow('Renderer acknowledgement failed')
    await acknowledge(second.id)

    const replayedLinks = queue.list()
    expect(replayedLinks).toEqual([first])
  })

  it('clears pending links when the authenticated identity changes', () => {
    const queue = new SandboxUiDeepLinkQueue()
    queue.enqueue({ appRef: 'ns/app' })
    queue.clear()
    expect(queue.list()).toEqual([])
    expect(queue.enqueue({ appRef: 'ns/app' }).id).toBe(2)
  })

  it('returns a monotonic floor so links admitted after invalidation survive that reset', () => {
    const queue = new SandboxUiDeepLinkQueue()
    const prior = queue.enqueue({ appRef: 'ns/prior' })

    const minimumId = queue.clear()
    const postInvalidation = queue.enqueue({ appRef: 'ns/after' })

    expect(minimumId).toBe(prior.id + 1)
    expect(queue.list()).toEqual([postInvalidation])
    expect(postInvalidation.id).toBe(minimumId)
  })

  it('keeps the newest bounded set of links', () => {
    const queue = new SandboxUiDeepLinkQueue(2)
    queue.enqueue({ appRef: 'ns/one' })
    queue.enqueue({ appRef: 'ns/two' })
    queue.enqueue({ appRef: 'ns/three' })
    expect(queue.list().map(item => item.appRef)).toEqual(['ns/two', 'ns/three'])
  })

  it('keeps a repeated unacknowledged target in its original FIFO position', () => {
    const queue = new SandboxUiDeepLinkQueue(3)
    const first = queue.enqueue({ appRef: 'ns/one' })
    queue.enqueue({ appRef: 'ns/two' })

    expect(queue.enqueue({ appRef: 'ns/one' })).toEqual(first)
    expect(queue.list().map(item => item.appRef)).toEqual(['ns/one', 'ns/two'])
  })
})
