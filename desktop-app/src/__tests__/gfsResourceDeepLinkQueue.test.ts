import { describe, expect, it } from 'vitest'
import { buildGfsResourceDeepLink, parseGfsResourceDeepLink } from '../gfsDeepLinks.js'
import { GfsResourceDeepLinkQueue } from '../gfsResourceDeepLinkQueue.js'

function parseProducedUri(uri: string) {
  const target = parseGfsResourceDeepLink(buildGfsResourceDeepLink(uri))
  if (!target) throw new Error('The shared producer rejected the GFS resource URI fixture')
  return target
}

describe('GfsResourceDeepLinkQueue', () => {
  it('canonicalizes identity, coalesces pending duplicates and acknowledges by id', () => {
    const queue = new GfsResourceDeepLinkQueue()
    const first = queue.enqueue(parseProducedUri('gfs://main/0123456789abcdef0123456789ABCDEF'))
    const duplicate = queue.enqueue(parseProducedUri('gfs://main/0123456789abcdef0123456789abcdef'))

    expect(first).toEqual({ id: 1, uri: 'gfs://main/0123456789abcdef0123456789abcdef' })
    expect(duplicate).toEqual(first)
    queue.acknowledge(first.id)
    expect(queue.list()).toEqual([])
  })

  it('bounds queued links and rejects malformed resource identities', () => {
    const queue = new GfsResourceDeepLinkQueue(2)
    queue.enqueue(parseProducedUri('gfs://main/00000000000000000000000000000001'))
    queue.enqueue(parseProducedUri('gfs://main/00000000000000000000000000000002'))
    queue.enqueue(parseProducedUri('gfs://main/00000000000000000000000000000003'))

    expect(queue.list().map(item => item.uri)).toEqual([
      'gfs://main/00000000000000000000000000000002',
      'gfs://main/00000000000000000000000000000003',
    ])
    expect(() => queue.enqueue({ uri: 'gfs://main/../secret' })).toThrow(
      'Invalid GFS resource deep link'
    )
  })

  it('keeps IDs monotonic across a clear and returns the next accepted ID', () => {
    const queue = new GfsResourceDeepLinkQueue()
    const first = queue.enqueue(parseProducedUri('gfs://main/00000000000000000000000000000001'))

    expect(queue.clear()).toBe(first.id + 1)
    const next = queue.enqueue(parseProducedUri('gfs://main/00000000000000000000000000000002'))
    expect(next.id).toBe(first.id + 1)
    expect(queue.list()).toEqual([next])
  })
})
