import { beforeAll, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('electron', () => ({
  app: { isReady: vi.fn(() => false), getPath: vi.fn(() => '/unused') },
  BrowserWindow: class {},
  Notification: class {},
}))

class FakeNotification extends EventEmitter {
  readonly show = vi.fn()
}

let showNotificationAndAwaitDelivery: typeof import('../pluginSdkRuntime.js').showNotificationAndAwaitDelivery

beforeAll(async () => {
  const runtime = await import('../pluginSdkRuntime.js')
  showNotificationAndAwaitDelivery = runtime.showNotificationAndAwaitDelivery
})

describe('showNotificationAndAwaitDelivery', () => {
  it('stays pending until the native displayed outcome', async () => {
    const notification = new FakeNotification()
    let settled = false
    const pending = showNotificationAndAwaitDelivery(notification as never).then(value => {
      settled = true
      return value
    })

    expect(notification.show).toHaveBeenCalledOnce()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    notification.emit('show')
    await expect(pending).resolves.toBe(true)
    expect(settled).toBe(true)
    expect(notification.listenerCount('show')).toBe(0)
    expect(notification.listenerCount('failed')).toBe(0)
  })

  it('resolves false when the native notification fails', async () => {
    const notification = new FakeNotification()
    const pending = showNotificationAndAwaitDelivery(notification as never)

    expect(notification.show).toHaveBeenCalledOnce()
    notification.emit('failed', new Event('failed'), 'unsigned app')
    await expect(pending).resolves.toBe(false)
    expect(notification.listenerCount('show')).toBe(0)
    expect(notification.listenerCount('failed')).toBe(0)
  })

  it('resolves false when show throws synchronously', async () => {
    const notification = new FakeNotification()
    notification.show.mockImplementation(() => {
      throw new Error('native show failed')
    })

    await expect(showNotificationAndAwaitDelivery(notification as never)).resolves.toBe(false)
    expect(notification.show).toHaveBeenCalledOnce()
    expect(notification.listenerCount('show')).toBe(0)
    expect(notification.listenerCount('failed')).toBe(0)
  })
})
