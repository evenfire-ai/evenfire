import { describe, expect, it, vi } from 'vitest'
import type { DesktopShortcutInput } from '../desktopCommands.js'
import {
  type DesktopShortcutRoute,
  isStandardEditingShortcut,
  routeDesktopShortcut,
  wireHostDesktopShortcutRouting,
} from '../shortcutRouter.js'

function input(overrides: Partial<DesktopShortcutInput> = {}): DesktopShortcutInput {
  return {
    type: 'keyDown',
    key: 'f',
    control: false,
    meta: true,
    alt: false,
    shift: false,
    isAutoRepeat: false,
    isComposing: false,
    ...overrides,
  }
}

function route(source: 'host' | 'sandbox' = 'host'): DesktopShortcutRoute {
  const trustedRenderer = {
    id: 1,
    isDestroyed: () => false,
    isFocused: () => source === 'host',
    focus: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  }
  return {
    source,
    platform: 'darwin',
    sourceWebContents:
      source === 'host'
        ? trustedRenderer
        : {
            id: 2,
            isDestroyed: () => false,
            isFocused: () => true,
            focus: vi.fn(),
            on: vi.fn(),
            removeListener: vi.fn(),
            send: vi.fn(),
          },
    trustedRenderer,
  } as DesktopShortcutRoute
}

describe('main-process Desktop shortcut routing', () => {
  it('routes only from the actual focused WebContents', () => {
    const current = route('sandbox')
    current.isCurrentSource = () => true
    const preventDefault = vi.fn()
    expect(routeDesktopShortcut(current, { preventDefault }, input())).toBe(true)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(current.trustedRenderer.focus).toHaveBeenCalledOnce()
    expect(current.trustedRenderer.send).toHaveBeenCalledWith('shortcuts:command', {
      commandId: 'search.open',
      source: 'sandbox',
    })

    current.isCurrentSource = () => false
    expect(routeDesktopShortcut(current, { preventDefault }, input())).toBe(false)
    expect(current.trustedRenderer.send).toHaveBeenCalledTimes(1)
    expect(current.trustedRenderer.focus).toHaveBeenCalledTimes(1)
  })

  it('routes global and contextual search distinctly from sandbox focus', () => {
    const current = route('sandbox')
    routeDesktopShortcut(current, { preventDefault: vi.fn() }, input())
    routeDesktopShortcut(current, { preventDefault: vi.fn() }, input({ shift: true }))
    expect(current.trustedRenderer.send).toHaveBeenNthCalledWith(1, 'shortcuts:command', {
      commandId: 'search.open',
      source: 'sandbox',
    })
    expect(current.trustedRenderer.send).toHaveBeenNthCalledWith(2, 'shortcuts:command', {
      commandId: 'search.current',
      source: 'sandbox',
    })
  })

  it('removes a host shortcut listener when its owning window closes', () => {
    const webContents = {
      id: 1,
      isDestroyed: () => false,
      isFocused: () => true,
      focus: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(),
    }
    let closeListener: (() => void) | undefined
    const host = {
      webContents,
      once: vi.fn((_event: 'closed', listener: () => void) => {
        closeListener = listener
      }),
    }

    wireHostDesktopShortcutRouting(host)

    expect(webContents.on).toHaveBeenCalledOnce()
    expect(host.once).toHaveBeenCalledWith('closed', expect.any(Function))
    closeListener?.()
    expect(webContents.removeListener).toHaveBeenCalledWith(
      'before-input-event',
      expect.any(Function)
    )
  })

  it('does not intercept reserved, ordinary editing, IME, AltGr, or key-up input', () => {
    const current = route('host')
    const preventDefault = vi.fn()
    for (const candidate of [
      input({ key: 'q' }),
      input({ key: 'c' }),
      input({ isComposing: true }),
      input({ meta: false, control: true, alt: true }),
      input({ type: 'keyUp' }),
    ]) {
      expect(routeDesktopShortcut(current, { preventDefault }, candidate)).toBe(false)
    }
    expect(preventDefault).not.toHaveBeenCalled()
    expect(current.trustedRenderer.send).not.toHaveBeenCalled()
  })

  it.each([
    ['darwin', input({ key: 'a' })],
    ['darwin', input({ key: 'c' })],
    ['darwin', input({ key: 'x' })],
    ['darwin', input({ key: 'v' })],
    ['darwin', input({ key: 'z' })],
    ['darwin', input({ key: 'z', shift: true })],
    ['darwin', input({ key: 'ArrowLeft' })],
    ['win32', input({ key: 'a', meta: false, control: true })],
    ['win32', input({ key: 'c', meta: false, control: true })],
    ['win32', input({ key: 'x', meta: false, control: true })],
    ['win32', input({ key: 'v', meta: false, control: true })],
    ['win32', input({ key: 'y', meta: false, control: true })],
    ['win32', input({ key: 'Insert', meta: false, control: true })],
    ['win32', input({ key: 'Insert', meta: false, shift: true })],
    ['win32', input({ key: 'Delete', meta: false, shift: true })],
  ] as const)('leaves standard %s editing input to Chromium', (platform, candidate) => {
    expect(isStandardEditingShortcut(candidate, platform)).toBe(true)
    const current = route('host')
    current.platform = platform
    const preventDefault = vi.fn()
    expect(routeDesktopShortcut(current, { preventDefault }, candidate)).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(current.trustedRenderer.send).not.toHaveBeenCalled()
  })
})
