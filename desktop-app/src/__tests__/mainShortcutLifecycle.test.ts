import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { DesktopShortcutInput } from '../desktopCommands.js'
import { type DesktopShortcutHost, wireHostDesktopShortcutRouting } from '../shortcutRouter.js'

class FakeWebContents extends EventEmitter {
  readonly focus = vi.fn()
  readonly send = vi.fn()

  constructor(readonly id: number) {
    super()
  }

  isDestroyed(): boolean {
    return false
  }

  isFocused(): boolean {
    return true
  }
}

class FakeBrowserWindow extends EventEmitter {
  constructor(readonly webContents: FakeWebContents) {
    super()
  }
}

function shortcutInput(): DesktopShortcutInput {
  return {
    type: 'keyDown',
    key: 'f',
    control: process.platform !== 'darwin',
    meta: process.platform === 'darwin',
    alt: false,
    shift: false,
    isAutoRepeat: false,
    isComposing: false,
  }
}

function createHost(id: number): FakeBrowserWindow {
  return new FakeBrowserWindow(new FakeWebContents(id))
}

describe('main window shortcut lifecycle', () => {
  it('owns one routable listener until close and gives a recreated window a fresh listener', () => {
    const firstWindow = createHost(1)
    const firstWebContents = firstWindow.webContents
    const firstRemoveListener = vi.spyOn(firstWebContents, 'removeListener')

    wireHostDesktopShortcutRouting(firstWindow as unknown as DesktopShortcutHost)

    expect(firstWebContents.listenerCount('before-input-event')).toBe(1)
    const firstListener = firstWebContents.listeners('before-input-event')[0]
    const firstEvent = { preventDefault: vi.fn() }
    firstWebContents.emit('before-input-event', firstEvent, shortcutInput())

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce()
    expect(firstWebContents.send).toHaveBeenCalledExactlyOnceWith('shortcuts:command', {
      commandId: 'search.open',
      source: 'host',
    })

    firstWindow.emit('closed')
    firstWindow.emit('closed')

    expect(firstRemoveListener).toHaveBeenCalledExactlyOnceWith('before-input-event', firstListener)
    expect(firstWebContents.listenerCount('before-input-event')).toBe(0)
    firstWebContents.emit('before-input-event', { preventDefault: vi.fn() }, shortcutInput())
    expect(firstWebContents.send).toHaveBeenCalledOnce()

    const secondWindow = createHost(2)
    const secondWebContents = secondWindow.webContents
    wireHostDesktopShortcutRouting(secondWindow as unknown as DesktopShortcutHost)

    expect(secondWebContents.listenerCount('before-input-event')).toBe(1)
    expect(secondWebContents.listeners('before-input-event')[0]).not.toBe(firstListener)
    secondWebContents.emit('before-input-event', { preventDefault: vi.fn() }, shortcutInput())

    expect(secondWebContents.send).toHaveBeenCalledExactlyOnceWith('shortcuts:command', {
      commandId: 'search.open',
      source: 'host',
    })
  })
})
