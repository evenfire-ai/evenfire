// @vitest-environment jsdom
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { GFS_WATCH_DEBOUNCE_MS } from '@constants/gfsWatch'
import { ForwardingOwner, gfsWatchBridgeFor } from '@/gfs/__fixtures__/gfsWatchBridge'
import { type WatchHarnessLike, newWatchHarness } from '@/gfs/__fixtures__/mainWatchHarness'
import type { GfsWatchEvent } from '../../../../../src/types'
import { USER_A, key } from '../../../../../testSupport/gfsWatch/sessionTokens'
import { useGfsWatchSubscription } from '../useGfsWatchSubscription'

type Props = {
  keys: string[]
  userId: string | null
  sessionKey: string
  onEvent: (event: GfsWatchEvent) => void
}

function Subscriber(props: Props) {
  useGfsWatchSubscription(props)
  return null
}

const wait = (ms: number) =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })

let h: WatchHarnessLike
let owner: ForwardingOwner
let watch: ReturnType<typeof gfsWatchBridgeFor>

beforeEach(async () => {
  h = await (await newWatchHarness()).start()
  owner = new ForwardingOwner(1)
  h.owners.set(1, owner)
  watch = gfsWatchBridgeFor(h.client, owner)
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { gfsWatch: watch.bridge },
  })
})

afterEach(async () => {
  cleanup()
  delete (window as { clerum?: unknown }).clerum
  await h.stop()
})

const K1 = key('file', 1)
const K2 = key('dir', 2)
const K3 = key('dir', 3)

describe('useGfsWatchSubscription', () => {
  it('registers the window on mount with an empty list, without waiting for the debounce', async () => {
    await h.login(USER_A)
    render(<Subscriber keys={[]} userId={USER_A} sessionKey="s1" onEvent={vi.fn()} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(watch.requests).toEqual([{ keys: [], userId: USER_A }])
    expect(h.client.hasOwner(owner.id)).toBe(true)
  })

  it('sends only the settled list once the debounce elapses, and never the same list twice', async () => {
    await h.login(USER_A)
    const onEvent = vi.fn()
    const view = render(<Subscriber keys={[]} userId={USER_A} sessionKey="s1" onEvent={onEvent} />)
    await wait(0)
    view.rerender(<Subscriber keys={[K1]} userId={USER_A} sessionKey="s1" onEvent={onEvent} />)
    view.rerender(<Subscriber keys={[K1, K2]} userId={USER_A} sessionKey="s1" onEvent={onEvent} />)
    await wait(GFS_WATCH_DEBOUNCE_MS / 2)
    view.rerender(
      <Subscriber keys={[K1, K2, K3]} userId={USER_A} sessionKey="s1" onEvent={onEvent} />
    )
    await wait(GFS_WATCH_DEBOUNCE_MS / 2)
    expect(watch.requests).toHaveLength(1)
    await wait(GFS_WATCH_DEBOUNCE_MS)
    expect(watch.requests.slice(1)).toEqual([{ keys: [K1, K2, K3], userId: USER_A }])

    view.rerender(
      <Subscriber keys={[K1, K2, K3]} userId={USER_A} sessionKey="s1" onEvent={onEvent} />
    )
    await wait(GFS_WATCH_DEBOUNCE_MS * 2)
    expect(watch.requests).toHaveLength(2)
    await act(() => h.settle())
    expect(h.server.current()?.keys).toEqual(new Set([K1, K2, K3]))
  })

  it('H-B91: after a session change with the same list, main gets the list again and the stream carries it', async () => {
    await h.login(USER_A)
    const onEvent = vi.fn()
    const view = render(
      <Subscriber keys={[K1, K2]} userId={USER_A} sessionKey="s1" onEvent={onEvent} />
    )
    await wait(GFS_WATCH_DEBOUNCE_MS * 2)
    await act(() => h.settle())
    expect(h.server.current()?.keys).toEqual(new Set([K1, K2]))

    // Logout and login of the same user: main empties every window's list.
    await act(async () => {
      await h.publish(null)
      await h.login(USER_A)
    })
    expect(h.client.inspect().owners.get(1)?.keys).toEqual([])

    view.rerender(<Subscriber keys={[K1, K2]} userId={USER_A} sessionKey="s2" onEvent={onEvent} />)
    await wait(GFS_WATCH_DEBOUNCE_MS / 2)
    expect(watch.requests).toHaveLength(1)
    await wait(GFS_WATCH_DEBOUNCE_MS)
    expect(watch.requests.slice(1)).toEqual([{ keys: [K1, K2], userId: USER_A }])
    await act(() => h.settle())
    expect(h.server.current()?.keys).toEqual(new Set([K1, K2]))
  })

  it('under StrictMode, the discarded first registration does not leave main without the list', async () => {
    await h.login(USER_A)
    render(
      <StrictMode>
        <Subscriber keys={[K1, K2]} userId={USER_A} sessionKey="s1" onEvent={vi.fn()} />
      </StrictMode>
    )
    await wait(GFS_WATCH_DEBOUNCE_MS * 2)
    await act(() => h.settle())
    expect(h.client.inspect().owners.get(1)?.keys).toEqual([K1, K2])
    expect(h.server.current()?.keys).toEqual(new Set([K1, K2]))
  })

  it('learns from the registration answer that the session already expired', async () => {
    await h.login(USER_A)
    await h.subscribe([K1])
    h.server.frame({ type: 'stream.closing', reason: 'session_expired' })
    await h.settle()
    expect(h.client.inspect().latch).not.toBeNull()

    const onEvent = vi.fn()
    const late = new ForwardingOwner(2)
    h.owners.set(2, late)
    const lateWatch = gfsWatchBridgeFor(h.client, late)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfsWatch: lateWatch.bridge },
    })
    render(<Subscriber keys={[]} userId={USER_A} sessionKey="s1" onEvent={onEvent} />)
    await wait(0)
    expect(onEvent).toHaveBeenCalledWith({ type: 'sessionExpired' })
  })

  it('stops listening and empties its list on unmount', async () => {
    await h.login(USER_A)
    const onEvent = vi.fn()
    const view = render(
      <Subscriber keys={[K1]} userId={USER_A} sessionKey="s1" onEvent={onEvent} />
    )
    await wait(0)
    view.unmount()
    await wait(0)
    expect(watch.closes).toBe(1)
    expect(h.client.inspect().owners.get(1)?.keys).toEqual([])
  })
})
