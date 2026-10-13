import { describe, expect, it, vi } from 'vitest'
import { buildGfsResourceDeepLink, parseGfsResourceDeepLink } from '../gfsDeepLinks.js'
import {
  GfsResourceDeepLinkQueue,
  createLogoutWithGfsResourceDeepLinkClear,
} from '../gfsResourceDeepLinkQueue.js'

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

  it('clears the prior principal at logout and retains links accepted afterward', async () => {
    const queue = new GfsResourceDeepLinkQueue()
    const userALink = queue.enqueue(parseProducedUri('gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))
    const logout = vi.fn(async () => undefined)
    const logoutAndClear = createLogoutWithGfsResourceDeepLinkClear(queue, logout)

    await logoutAndClear()
    expect(logout).toHaveBeenCalledOnce()
    expect(queue.list()).toEqual([])

    const userBLink = queue.enqueue(parseProducedUri('gfs://main/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'))
    expect(userBLink.id).toBeGreaterThan(userALink.id)
    expect(queue.list()).toEqual([userBLink])
  })

  it('clears links activated while the logout operation is pending', async () => {
    const queue = new GfsResourceDeepLinkQueue()
    let finishLogout!: () => void
    const logout = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishLogout = resolve
        })
    )
    const logoutAndClear = createLogoutWithGfsResourceDeepLinkClear(queue, logout)
    const logoutOperation = logoutAndClear()

    expect(logout).toHaveBeenCalledOnce()
    const inFlightPrincipalLink = queue.enqueue(
      parseProducedUri('gfs://main/cccccccccccccccccccccccccccccccc')
    )
    expect(queue.list()).toEqual([inFlightPrincipalLink])

    finishLogout()
    await logoutOperation
    expect(queue.list()).toEqual([])

    const postLogoutLink = queue.enqueue(
      parseProducedUri('gfs://main/dddddddddddddddddddddddddddddddd')
    )
    expect(queue.list()).toEqual([postLogoutLink])
  })
})
