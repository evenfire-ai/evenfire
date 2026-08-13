import { describe, expect, it } from 'vitest'
import {
  DESKTOP_COMMANDS,
  type DesktopShortcutInput,
  desktopBindingCollisionKey,
  formatDesktopShortcut,
  getDesktopCommand,
  matchDesktopCommand,
} from '../desktopCommands.js'

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

describe('Desktop command registry', () => {
  it('has unique stable IDs and no binding collisions within a source', () => {
    expect(new Set(DESKTOP_COMMANDS.map(command => command.id)).size).toBe(DESKTOP_COMMANDS.length)
    for (const source of ['host', 'sandbox'] as const) {
      const keys = DESKTOP_COMMANDS.filter(
        command => command.defaultBinding && command.sources.includes(source)
      ).map(command => desktopBindingCollisionKey(command.defaultBinding!))
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  it('keeps reserved Electron and OS roles outside the registry', () => {
    const keys = new Set(
      DESKTOP_COMMANDS.flatMap(command =>
        command.defaultBinding ? [desktopBindingCollisionKey(command.defaultBinding)] : []
      )
    )
    for (const reserved of ['mod+q', 'mod+h', 'mod+m', 'mod+p', 'mod+r']) {
      expect(keys.has(reserved)).toBe(false)
    }
  })

  it('formats and matches Command on macOS and Ctrl on Windows', () => {
    const binding = getDesktopCommand('search.current').defaultBinding!
    expect(formatDesktopShortcut(binding, 'darwin')).toBe('⌘⇧F')
    expect(formatDesktopShortcut(binding, 'win32')).toBe('Ctrl+Shift+F')
    expect(matchDesktopCommand(input({ shift: true }), 'darwin', 'host')?.id).toBe('search.current')
    expect(
      matchDesktopCommand(input({ meta: false, control: true, shift: true }), 'win32', 'sandbox')
        ?.id
    ).toBe('search.current')
  })

  it('ignores repeat, composition, AltGr-like input, and wrong platform modifiers', () => {
    expect(matchDesktopCommand(input({ isAutoRepeat: true }), 'darwin', 'host')).toBeNull()
    expect(matchDesktopCommand(input({ isComposing: true }), 'darwin', 'host')).toBeNull()
    expect(
      matchDesktopCommand(input({ meta: false, control: true, alt: true }), 'win32', 'host')
    ).toBeNull()
    expect(matchDesktopCommand(input({ meta: false, control: true }), 'darwin', 'host')).toBeNull()
  })

  it('maps Mod+9 to last-tab semantics rather than a ninth-index command', () => {
    expect(matchDesktopCommand(input({ key: '9' }), 'darwin', 'host')?.id).toBe('tabs.selectLast')
    expect(DESKTOP_COMMANDS.some(command => command.id === 'tabs.select9')).toBe(false)
  })
})
