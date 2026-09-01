// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SidebarNav } from '../SidebarNav'
import type { SidebarNavProps } from '../SidebarNav/types'

// SidebarNav pulls from four contexts. Mock each module so we only render
// the logo block without standing up real providers, and so we never hit the
// "must be used within Provider" guards.
vi.mock('@contexts/AuthContext', () => ({
  useAuthContext: () => ({
    busy: false,
    me: { name: 'Test User', email: 'test@clerum.io' },
    handleLogout: vi.fn(),
  }),
}))
vi.mock('@contexts/ChatListContext', () => ({
  useChatListContext: () => ({
    activeChatId: null,
    latestChatSessions: [],
    latestChatSessionsLoading: false,
  }),
}))
vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => ({
    handleRenameChatForAgent: vi.fn(),
    handleDeleteChatForAgent: vi.fn(),
  }),
}))
vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => ({
    selectedAgent: null,
    handleSelectChatAgent: vi.fn(),
  }),
}))

function baseProps(overrides: Partial<SidebarNavProps> = {}): SidebarNavProps {
  return {
    navItem: 'chat',
    collapsed: false,
    activeSandboxUiApp: null,
    availableSandboxUiApps: [],
    onCollapsedChange: vi.fn(),
    onNewChat: vi.fn(),
    onOpenSandboxUiApp: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  }
}

describe('SidebarNav logo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // jsdom does not implement matchMedia; SidebarNav reads it to detect the
    // mobile viewport. Stub it as a non-matching desktop viewport.
    if (!window.matchMedia) {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: vi.fn().mockImplementation((query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      })
    }
  })

  afterEach(() => {
    cleanup()
  })

  it('renders both theme lockup variants when expanded', () => {
    const { container } = render(<SidebarNav {...baseProps({ collapsed: false })} />)

    const light = container.querySelector<HTMLImageElement>('.sidebar-logo-lockup--light')
    const dark = container.querySelector<HTMLImageElement>('.sidebar-logo-lockup--dark')

    expect(light).not.toBeNull()
    expect(light?.getAttribute('src')).toBe('./logotype-light.svg')
    // Light variant is decorative; only the dark variant carries the brand name.
    expect(light?.getAttribute('alt')).toBe('')

    expect(dark).not.toBeNull()
    expect(dark?.getAttribute('src')).toBe('./logotype-dark.svg')
    expect(dark?.getAttribute('alt')).toBe('Evenfire')
  })

  it('still renders the square logo.svg mark (toggled by CSS, not the DOM)', () => {
    const { container } = render(<SidebarNav {...baseProps({ collapsed: true })} />)
    const mark = container.querySelector<HTMLImageElement>('.sidebar-logo-mark')
    expect(mark).not.toBeNull()
    expect(mark?.getAttribute('src')).toBe('./logo.svg')
    expect(mark?.getAttribute('alt')).toBe('')
  })

  it('does not render the legacy text wordmark', () => {
    const { container } = render(<SidebarNav {...baseProps()} />)
    expect(container.querySelector('.sidebar-logo-text')).toBeNull()
    expect(container.querySelector('.sidebar-logo-copy')).toBeNull()
  })

  it('renders Files as a top-level nav item labelled Files (not under Resources)', () => {
    render(<SidebarNav {...baseProps()} />)

    // Files is always visible as a primary nav destination — no menu opening needed.
    const filesItem = screen.getByTestId('nav-files')
    expect(filesItem.textContent).toContain('Files')
    expect(filesItem.textContent).not.toContain('Global File System')

    // Files is no longer nested under the Settings → Resources submenu.
    fireEvent.click(screen.getByTestId('nav-settings-menu'))
    expect(screen.getByTestId('nav-data-menu').textContent).not.toContain('Global File System')
  })

  it('mounts the paperclip SVG used by Control UI Global File System', () => {
    const { container } = render(<SidebarNav {...baseProps()} />)
    const filesLink = container.querySelector('[data-testid="nav-files"]')
    const icon = filesLink?.querySelector('.ui-nav-item__icon svg')
    expect(icon).toBeTruthy()
    expect(icon?.getAttribute('viewBox')).toBe('0 0 24 24')
    // Keep the Desktop Files item visually aligned with Control UI's
    // Global File System paperclip icon.
    expect(icon?.querySelector('path')?.getAttribute('d')).toContain(
      'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49'
    )
  })

  it('routes a controlled palette request through desktop collapse behavior', () => {
    const onCollapsedChange = vi.fn()
    const { rerender } = render(
      <SidebarNav {...baseProps({ onCollapsedChange, toggleRequestId: 0 })} />
    )

    rerender(<SidebarNav {...baseProps({ onCollapsedChange, toggleRequestId: 1 })} />)

    expect(onCollapsedChange).toHaveBeenCalledWith(true)
  })

  it('routes a controlled palette request through the mobile drawer behavior', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      query =>
        ({
          matches: true,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as MediaQueryList
    )
    const onCollapsedChange = vi.fn()
    const { container, rerender } = render(
      <SidebarNav {...baseProps({ onCollapsedChange, toggleRequestId: 0 })} />
    )

    rerender(<SidebarNav {...baseProps({ onCollapsedChange, toggleRequestId: 1 })} />)

    expect(container.querySelector('.left-nav')?.classList.contains('mobile-open')).toBe(true)
    expect(onCollapsedChange).not.toHaveBeenCalled()
  })
})

describe('SidebarNav new-chat affordance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    if (!window.matchMedia) {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: vi.fn().mockImplementation((query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      })
    }
  })

  afterEach(() => {
    cleanup()
  })

  it('routes the new-chat button through the dedicated new-chat owner', () => {
    const onSelect = vi.fn()
    const onNewChat = vi.fn()
    render(<SidebarNav {...baseProps({ navItem: 'chat', onSelect })} onNewChat={onNewChat} />)

    const newChatBtn = screen.getByTestId('nav-new-chat')
    expect(newChatBtn).not.toBeNull()
    expect(newChatBtn.getAttribute('title')).toBe('New chat')

    fireEvent.click(newChatBtn)
    expect(onNewChat).toHaveBeenCalledOnce()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('renders exactly one new-chat button (on the chat nav row)', () => {
    // The chat nav item is always present in primaryItems, so the new-chat
    // affordance is rendered while expanded, regardless of which nav item is active.
    const { container } = render(<SidebarNav {...baseProps({ navItem: 'sandbox-ui' })} />)
    const newChatButtons = container.querySelectorAll('.nav-link-new-chat')
    expect(newChatButtons.length).toBe(1)
  })

  it('does not render the new-chat button when the sidebar is collapsed', () => {
    render(<SidebarNav {...baseProps({ collapsed: true })} />)

    expect(screen.queryByTestId('nav-new-chat')).toBeNull()
  })
})
