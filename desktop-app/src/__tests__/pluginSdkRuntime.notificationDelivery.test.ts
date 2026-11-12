import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Notification } from 'electron'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppService } from '../appService.js'
import type { PluginSdkDataSource } from '../pluginSdkCapabilities.js'

vi.mock('electron', async () => {
  const { EventEmitter: MockEventEmitter } = await import('node:events')
  class RuntimeNotification extends MockEventEmitter {
    static readonly instances: RuntimeNotification[] = []
    static readonly isSupported = vi.fn(() => true)
    readonly show = vi.fn()

    constructor(readonly options: { title: string; body?: string }) {
      super()
      RuntimeNotification.instances.push(this)
    }
  }
  return {
    app: { isReady: vi.fn(() => false), getPath: vi.fn(() => '/unused') },
    BrowserWindow: class {},
    Notification: RuntimeNotification,
  }
})

class FakeNotification extends EventEmitter {
  readonly show = vi.fn()
}

type RuntimeNotification = EventEmitter & {
  options: { title: string; body?: string }
  show: ReturnType<typeof vi.fn>
}

function runtimeNotifications(): RuntimeNotification[] {
  return (Notification as unknown as { instances: RuntimeNotification[] }).instances
}

let PluginSdkRuntime: typeof import('../pluginSdkRuntime.js').PluginSdkRuntime
let showNotificationAndAwaitDelivery: typeof import('../pluginSdkRuntime.js').showNotificationAndAwaitDelivery
const tempDirs: string[] = []

beforeAll(async () => {
  const runtime = await import('../pluginSdkRuntime.js')
  PluginSdkRuntime = runtime.PluginSdkRuntime
  showNotificationAndAwaitDelivery = runtime.showNotificationAndAwaitDelivery
})

afterEach(async () => {
  runtimeNotifications().length = 0
  vi.useRealTimers()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
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

  it('resolves false when no native outcome ever arrives', async () => {
    vi.useFakeTimers()
    const notification = new FakeNotification()
    let settled = false
    const pending = showNotificationAndAwaitDelivery(notification as never).then(value => {
      settled = true
      return value
    })

    await vi.advanceTimersByTimeAsync(9_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe(false)
    expect(settled).toBe(true)
    expect(notification.show).toHaveBeenCalledOnce()
    expect(notification.listenerCount('show')).toBe(0)
    expect(notification.listenerCount('failed')).toBe(0)
  })
})

describe('PluginSdkRuntime notification delivery mapping', () => {
  async function createNotificationSource(): Promise<PluginSdkDataSource> {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'evenfire-plugin-notification-'))
    tempDirs.push(userDataDir)
    const runtime = new PluginSdkRuntime({
      service: {} as unknown as AppService,
      getMainWindow: () => null,
      userDataDir,
    })
    return (runtime as unknown as { dataSource(): PluginSdkDataSource }).dataSource()
  }

  function latestNotification(): RuntimeNotification {
    const notification = runtimeNotifications().at(-1)
    if (!notification) throw new Error('runtime notification was not created')
    return notification
  }

  it('maps a native failed outcome to reason failed', async () => {
    const source = await createNotificationSource()
    const pending = source.showPluginNotification({
      pluginId: 'plugin-1',
      pluginTitle: 'Demo Plugin',
      title: 'Hello',
      body: 'World',
    })
    const notification = latestNotification()

    expect(notification.options).toEqual(
      expect.objectContaining({ title: 'Demo Plugin — Hello', body: 'World' })
    )
    expect(notification.show).toHaveBeenCalledOnce()
    notification.emit('failed', new Event('failed'), 'unsigned app')
    await expect(pending).resolves.toEqual({ delivered: false, reason: 'failed' })
  })

  it('maps a native shown outcome to delivered', async () => {
    const source = await createNotificationSource()
    const pending = source.showPluginNotification({
      pluginId: 'plugin-1',
      pluginTitle: 'Demo Plugin',
      title: 'Hello',
      body: 'World',
    })
    const notification = latestNotification()

    expect(notification.options).toEqual(
      expect.objectContaining({ title: 'Demo Plugin — Hello', body: 'World' })
    )
    expect(notification.show).toHaveBeenCalledOnce()
    notification.emit('show')
    await expect(pending).resolves.toEqual({ delivered: true })
  })
})
