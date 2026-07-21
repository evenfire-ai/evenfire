import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { installAdaptiveSystemIcon, resolveSystemIconPath } from './systemIcon.js'

describe('systemIcon', () => {
  it('resolves the matching light and dark assets', () => {
    expect(path.basename(resolveSystemIconPath('/icons', false))).toBe('icon-light.png')
    expect(path.basename(resolveSystemIconPath('/icons', true))).toBe('icon-dark.png')
  })

  it('updates existing and newly created Windows and Linux windows', () => {
    let darkMode = false
    let themeUpdated: (() => void) | undefined
    let windowCreated:
      | ((window: { isDestroyed(): boolean; setIcon(icon: string): void }) => void)
      | undefined
    const firstWindow = { isDestroyed: () => false, setIcon: vi.fn() }
    const secondWindow = { isDestroyed: () => false, setIcon: vi.fn() }

    installAdaptiveSystemIcon({
      assetsDirectory: '/icons',
      getAllWindows: () => [firstWindow],
      onThemeUpdated: listener => {
        themeUpdated = listener
      },
      onWindowCreated: listener => {
        windowCreated = listener
      },
      platform: 'win32',
      shouldUseDarkColors: () => darkMode,
    })

    expect(path.basename(firstWindow.setIcon.mock.calls[0]?.[0] ?? '')).toBe('icon-light.png')

    darkMode = true
    themeUpdated?.()
    windowCreated?.(secondWindow)

    expect(path.basename(firstWindow.setIcon.mock.calls[1]?.[0] ?? '')).toBe('icon-dark.png')
    expect(path.basename(secondWindow.setIcon.mock.calls[0]?.[0] ?? '')).toBe('icon-dark.png')
  })

  it('updates the macOS Dock without applying unsupported window icons', () => {
    const setDockIcon = vi.fn()
    const setWindowIcon = vi.fn()

    installAdaptiveSystemIcon({
      assetsDirectory: '/icons',
      getAllWindows: () => [{ isDestroyed: () => false, setIcon: setWindowIcon }],
      onThemeUpdated: () => {},
      onWindowCreated: () => {},
      platform: 'darwin',
      setDockIcon,
      shouldUseDarkColors: () => true,
    })

    expect(path.basename(setDockIcon.mock.calls[0]?.[0] ?? '')).toBe('icon-dark.png')
    expect(setWindowIcon).not.toHaveBeenCalled()
  })

  it('does not update destroyed windows', () => {
    const setIcon = vi.fn()

    installAdaptiveSystemIcon({
      assetsDirectory: '/icons',
      getAllWindows: () => [{ isDestroyed: () => true, setIcon }],
      onThemeUpdated: () => {},
      onWindowCreated: () => {},
      platform: 'linux',
      shouldUseDarkColors: () => false,
    })

    expect(setIcon).not.toHaveBeenCalled()
  })
})
