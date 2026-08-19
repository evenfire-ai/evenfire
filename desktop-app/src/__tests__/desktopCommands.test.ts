import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import {
  DESKTOP_COMMANDS,
  type DesktopShortcutInput,
  desktopBindingCollisionKey,
  getDesktopCommand,
  isDesktopCommandEligible,
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
  it('keeps the sandboxed main preload self-contained and synchronized with command IDs', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'src', 'preload.ts'), 'utf8')
    const syntax = ts.createSourceFile('preload.ts', source, ts.ScriptTarget.Latest, false)
    const relativeValueImports = syntax.statements
      .filter(ts.isImportDeclaration)
      .filter(statement => {
        const specifier = ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : ''
        return specifier.startsWith('.') && !statement.importClause?.isTypeOnly
      })
      .map(statement => statement.getText(syntax))
    expect(relativeValueImports).toEqual([])
    for (const command of DESKTOP_COMMANDS) {
      expect(source, `preload is missing ${command.id}`).toContain(`'${command.id}'`)
    }
  })

  it('has unique stable IDs and no binding collisions within a source', () => {
    expect(new Set(DESKTOP_COMMANDS.map(command => command.id)).size).toBe(DESKTOP_COMMANDS.length)
    for (const platform of ['darwin', 'win32'] as const) {
      for (const source of ['host', 'sandbox'] as const) {
        const keys = DESKTOP_COMMANDS.filter(
          command => command.defaultBinding && command.sources.includes(source)
        ).map(command => desktopBindingCollisionKey(command.defaultBinding!, platform))
        expect(new Set(keys).size).toBe(keys.length)
      }
    }
  })

  it('keeps reserved Electron and OS roles outside the registry', () => {
    const macKeys = new Set(
      DESKTOP_COMMANDS.flatMap(command =>
        command.defaultBinding ? [desktopBindingCollisionKey(command.defaultBinding, 'darwin')] : []
      )
    )
    for (const reserved of ['meta+q', 'meta+h', 'meta+m', 'meta+p', 'meta+r', 'meta+Tab']) {
      expect(macKeys.has(reserved)).toBe(false)
    }
  })

  it('matches Command on macOS and Ctrl on Windows', () => {
    expect(matchDesktopCommand(input({ shift: true }), 'darwin', 'host')?.id).toBe('search.current')
    expect(
      matchDesktopCommand(input({ meta: false, control: true, shift: true }), 'win32', 'sandbox')
        ?.id
    ).toBe('search.current')
  })

  it('binds only Open Settings in the approved core palette action set', () => {
    expect(matchDesktopCommand(input({ key: ',' }), 'darwin', 'sandbox')?.id).toBe('settings.open')
    for (const id of [
      'auth.logout',
      'navigate.chat',
      'navigate.apps',
      'navigate.agents',
      'notifications.open',
    ] as const) {
      expect(getDesktopCommand(id).defaultBinding).toBeNull()
      expect(getDesktopCommand(id).visibleInSettings).toBe(false)
    }
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

  it('binds the chat switcher to Mod+E, gated on a mounted app, without colliding', () => {
    const switcher = getDesktopCommand('chat.switcher')
    expect(switcher.defaultBinding).toEqual({ key: 'e', modifier: 'mod' })
    expect(switcher.eligibility).toBe('app-mounted')
    expect(matchDesktopCommand(input({ key: 'e' }), 'darwin', 'host')?.id).toBe('chat.switcher')
    expect(matchDesktopCommand(input({ key: 'e', meta: false, control: true }), 'win32', 'host')?.id).toBe(
      'chat.switcher'
    )
  })

  it('uses Control for tab cycling on macOS to avoid the reserved Command+Tab app switcher', () => {
    expect(
      matchDesktopCommand(input({ key: 'Tab', meta: false, control: true }), 'darwin', 'host')?.id
    ).toBe('tabs.next')
    expect(matchDesktopCommand(input({ key: 'Tab' }), 'darwin', 'host')).toBeNull()
  })

  it('enables commands from the same registry context used by keyboard and palette actions', () => {
    const context = {
      tabCount: 1,
      searchableContent: false,
      composerAvailable: false,
      appMounted: false,
      conversationOriginAvailable: false,
      applicationBusy: false,
    }
    expect(isDesktopCommandEligible(getDesktopCommand('tabs.select1'), context)).toBe(true)
    expect(isDesktopCommandEligible(getDesktopCommand('tabs.select2'), context)).toBe(false)
    expect(isDesktopCommandEligible(getDesktopCommand('tabs.next'), context)).toBe(false)
    expect(isDesktopCommandEligible(getDesktopCommand('search.current'), context)).toBe(false)
    expect(isDesktopCommandEligible(getDesktopCommand('composer.focus'), context)).toBe(false)
    expect(isDesktopCommandEligible(getDesktopCommand('search.open'), context)).toBe(true)
    expect(isDesktopCommandEligible(getDesktopCommand('auth.logout'), context)).toBe(true)
    expect(
      isDesktopCommandEligible(getDesktopCommand('auth.logout'), {
        ...context,
        applicationBusy: true,
      })
    ).toBe(false)
    expect(isDesktopCommandEligible(getDesktopCommand('app.refresh'), context)).toBe(false)
    expect(
      isDesktopCommandEligible(getDesktopCommand('app.refresh'), { ...context, appMounted: true })
    ).toBe(true)
    expect(
      isDesktopCommandEligible(getDesktopCommand('app.backToConversation'), {
        ...context,
        appMounted: true,
        conversationOriginAvailable: true,
      })
    ).toBe(true)
  })

  it('keeps every approved contextual palette action unbound', () => {
    for (const id of [
      'navigate.plugins',
      'navigate.contexts',
      'navigate.teams',
      'navigate.connectors',
      'navigate.files',
      'sidebar.toggle',
      'app.refresh',
      'app.backToApps',
      'app.backToConversation',
    ] as const) {
      const command = getDesktopCommand(id)
      expect(command.defaultBinding).toBeNull()
      expect(command.visibleInPalette).toBe(true)
      expect(command.visibleInSettings).toBe(false)
    }
  })
})
