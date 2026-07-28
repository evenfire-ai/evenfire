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

  it('clears pending links when the authenticated identity changes', () => {
    const queue = new SandboxUiDeepLinkQueue()
    queue.enqueue({ appRef: 'ns/app' })
    queue.clear()
    expect(queue.list()).toEqual([])
    expect(queue.enqueue({ appRef: 'ns/app' }).id).toBe(2)
  })

  it('keeps the newest bounded set of links', () => {
    const queue = new SandboxUiDeepLinkQueue(2)
    queue.enqueue({ appRef: 'ns/one' })
    queue.enqueue({ appRef: 'ns/two' })
    queue.enqueue({ appRef: 'ns/three' })
    expect(queue.list().map(item => item.appRef)).toEqual(['ns/two', 'ns/three'])
  })

  it('moves a repeated unacknowledged target to the newest queue position', () => {
    const queue = new SandboxUiDeepLinkQueue(3)
    const first = queue.enqueue({ appRef: 'ns/one' })
    queue.enqueue({ appRef: 'ns/two' })

    expect(queue.enqueue({ appRef: 'ns/one' })).toEqual(first)
    expect(queue.list().map(item => item.appRef)).toEqual(['ns/two', 'ns/one'])
  })
})
