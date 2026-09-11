// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import {
  type SemanticShortcutBinding,
  bindingMatchesInput,
  formatDesktopShortcut,
} from '../../../src/desktopCommands'
import { CommandPalette } from '../components/CommandPalette'
import { SettingsPage } from '../pages/SettingsPage'

vi.mock('@contexts/AuthContext', () => ({
  useAuthContext: () => ({
    email: 'user@example.com',
    me: { email: 'user@example.com', name: 'User' },
    runtimeConfigState: {
      configured: false,
      isLocalhost: false,
      selectorVisible: false,
      activeOptionId: null,
      envKey: 'test',
      storagePath: '/test',
      options: [],
    },
  }),
}))

beforeEach(() => {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      socialChannels: {
        getSummary: vi.fn(async () => ({ accounts: [], targets: [] })),
      },
    },
  })
})

afterEach(() => {
  cleanup()
  delete (window as { clerum?: unknown }).clerum
})

const modShiftF: SemanticShortcutBinding = { key: 'f', modifier: 'mod', shift: true }

describe('Desktop shortcut labels', () => {
  it('renders Shift text from the authoritative formatter without changing matching', () => {
    expect(formatDesktopShortcut(modShiftF, 'darwin')).toBe('⌘ Shift F')
    expect(formatDesktopShortcut(modShiftF, 'win32')).toBe('Ctrl+Shift+F')
    expect(formatDesktopShortcut({ key: 'Tab', modifier: 'control', shift: true }, 'darwin')).toBe(
      '⌃ Shift Tab'
    )
    expect(formatDesktopShortcut({ key: 'f', modifier: 'mod' }, 'darwin')).toBe('⌘F')
    expect(formatDesktopShortcut({ key: 'f', modifier: 'mod' }, 'win32')).toBe('Ctrl+F')
    expect(formatDesktopShortcut({ key: ',', modifier: 'mod' }, 'darwin')).toBe('⌘,')
    expect(formatDesktopShortcut({ key: ',', modifier: 'mod' }, 'win32')).toBe('Ctrl+,')
    expect(formatDesktopShortcut({ key: 'Tab', modifier: 'control' }, 'darwin')).toBe('⌃Tab')
    expect(formatDesktopShortcut({ key: 'Tab', modifier: 'control' }, 'win32')).toBe('Ctrl+Tab')

    expect(
      bindingMatchesInput(
        modShiftF,
        {
          alt: false,
          control: false,
          isComposing: false,
          key: 'f',
          meta: true,
          shift: true,
          type: 'keyDown',
        },
        'darwin'
      )
    ).toBe(true)
  })

  it('renders textual Shift in the command palette', () => {
    render(
      <CommandPalette
        platform="darwin"
        isEligible={() => true}
        onClose={vi.fn()}
        onExecute={vi.fn()}
      />
    )
    expect(screen.getAllByText('⌘ Shift F').length).toBeGreaterThan(0)
    expect(screen.queryByText(/⇧/)).toBeNull()
  })

  it('renders textual Shift in Settings shortcuts', () => {
    Object.defineProperty(window.navigator, 'platform', { configurable: true, value: 'MacIntel' })
    render(
      <SettingsPage
        channelNotificationPreferences={{
          channelFallbackEnabled: false,
          preferredMedium: null,
          verifiedMedia: [],
        }}
        channelNotificationPreferencesLoading={false}
        channelNotificationPreferencesSaving={false}
        desktopNotificationPermission="default"
        notificationSettings={{ desktop: 'when_app_unfocused', inApp: 'always', soundVolume: 50 }}
        onNotificationSoundVolumeChange={vi.fn()}
        onNotify={vi.fn()}
        onPlayNotificationSoundPreview={vi.fn()}
        onSaveChannelNotificationPreferences={vi.fn(async () => undefined)}
        onSaveNotificationSettings={vi.fn(async () => 'default')}
        onThemeModeChange={vi.fn()}
        shortcutsFocusRequestId={1}
        themeMode="dark"
      />
    )
    expect(screen.getAllByText('⌘ Shift F').length).toBeGreaterThan(0)
    expect(screen.queryByText(/⇧/)).toBeNull()
  })
})
