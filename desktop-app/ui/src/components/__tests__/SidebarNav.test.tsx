// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { QueuedChatDelete } from '../../contexts/AgentChatActionsContext/types'
import { installAntdDomEnvironment } from '../../test/antdDomEnvironment'
import { SidebarNav } from '../SidebarNav'
import type { FileExplorerTreeProps } from '../SidebarNav/FileExplorerTree/types'
import type { SidebarNavProps } from '../SidebarNav/types'

const sidebarMocks = vi.hoisted(() => ({
  activeChatId: null as string | null,
  latestChatSessions: [] as Array<{
    agentRef: string
    id: string
    title: string
    remote?: boolean
    unreadTerminal?: boolean
  }>,
  selectedAgent: null as string | null,
  captureChatDeleteFence: vi.fn(async (): Promise<QueuedChatDelete> => {
    throw new Error('no delete target')
  }),
  handleDeleteChatForAgent: vi.fn(async () => undefined),
  handleLogout: vi.fn(),
  handleRenameChatForAgent: vi.fn(async () => undefined),
  handleSelectChatAgent: vi.fn(),
}))

beforeEach(() => {
  installAntdDomEnvironment()
  sidebarMocks.activeChatId = null
  sidebarMocks.latestChatSessions = []
  sidebarMocks.selectedAgent = null
  sidebarMocks.captureChatDeleteFence.mockReset().mockRejectedValue(new Error('no delete target'))
  sidebarMocks.handleDeleteChatForAgent.mockClear()
  sidebarMocks.handleLogout.mockClear()
  sidebarMocks.handleRenameChatForAgent.mockClear()
  sidebarMocks.handleSelectChatAgent.mockClear()
})

afterEach(() => {
  cleanup()
})
// SidebarNav pulls from four contexts. Mock each module so we only render
// the logo block without standing up real providers, and so we never hit the
// "must be used within Provider" guards.
vi.mock('@contexts/AuthContext', () => ({
  useAuthContext: () => ({
    busy: false,
    me: { name: 'Test User', email: 'test@clerum.io' },
    handleLogout: sidebarMocks.handleLogout,
  }),
}))
vi.mock('@contexts/ChatListContext', () => ({
  useChatListContext: () => ({
    activeChatId: sidebarMocks.activeChatId,
    latestChatSessions: sidebarMocks.latestChatSessions,
    latestChatSessionsLoading: false,
    sessionStateByChatKey: {},
  }),
}))
vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => ({
    captureChatDeleteFence: sidebarMocks.captureChatDeleteFence,
    handleRenameChatForAgent: sidebarMocks.handleRenameChatForAgent,
    handleDeleteChatForAgent: sidebarMocks.handleDeleteChatForAgent,
  }),
}))
vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => ({
    selectedAgent: sidebarMocks.selectedAgent,
    handleSelectChatAgent: sidebarMocks.handleSelectChatAgent,
  }),
}))
// The real tree pulls TanStack Query and GFS contexts; the sidebar tests only
// care that revealing it flips the explorer open, not what it renders.
vi.mock('../SidebarNav/FileExplorerTree', () => ({
  FileExplorerTree: ({ onOpenFolder, onOpenPreview }: FileExplorerTreeProps) => (
    <div data-testid="file-explorer-tree">
      <button data-testid="file-tree-open-folder" onClick={() => onOpenFolder('gfs://main/folder')}>
        Open folder
      </button>
      <button
        data-testid="file-tree-open-preview"
        onClick={() =>
          onOpenPreview({
            bytes: 12,
            gfsUri: 'gfs://main/readme.md',
            kind: 'markdown',
            name: 'readme.md',
          })
        }
      >
        Open preview
      </button>
    </div>
  ),
}))

function baseProps(overrides: Partial<SidebarNavProps> = {}): SidebarNavProps {
  return {
    navItem: 'chat',
    collapsed: false,
    compactMode: false,
    compactMenuOpen: false,
    onCompactMenuOpenChange: vi.fn(),
    resize: {
      width: 328,
      maxWidth: 460,
      cancelActiveDrag: vi.fn(),
      onPointerDown: vi.fn(),
      onPointerMove: vi.fn(),
      onPointerUp: vi.fn(),
      onPointerCancel: vi.fn(),
      onLostPointerCapture: vi.fn(),
      onKeyDown: vi.fn(),
    },
    activeSandboxUiApp: null,
    availableSandboxUiApps: [],
    onCollapsedChange: vi.fn(),
    onNewChat: vi.fn(),
    onOpenSandboxUiApp: vi.fn(),
    onSelect: vi.fn(),
    onOpenFilesSection: vi.fn(),
    onOpenPreviewSection: vi.fn(),
    pushToast: vi.fn(),
    ...overrides,
  }
}

function expectSettingsMenuClosed(trigger: HTMLElement) {
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  const menu = document.querySelector('.sidebar-settings-antd-menu')
  if (!menu) return
  const popup = menu.closest('.ant-dropdown') as HTMLElement | null
  expect(popup?.className).toContain('leave')
  expect(popup?.style.pointerEvents).toBe('none')
}

describe('SidebarNav logo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sidebarMocks.latestChatSessions = []
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

  it('renders EvenDrive as a top-level nav item labelled EvenDrive (not under Resources)', () => {
    render(<SidebarNav {...baseProps()} />)

    // EvenDrive is always visible as a primary nav destination — no menu opening needed.
    const filesItem = screen.getByTestId('nav-files')
    expect(filesItem.textContent).toContain('EvenDrive')
    expect(filesItem.textContent).not.toContain('Global File System')

    // Files is a top-level nav item, never nested inside the Settings popover.
    fireEvent.click(screen.getByTestId('nav-settings-menu'))
    const settingsMenu = screen.getByRole('menu')
    expect(settingsMenu.querySelector('[data-testid="nav-files"]')).toBeNull()
  })

  it('uses the restored hard-drive icon inside the EvenDrive nav item', () => {
    const { container } = render(<SidebarNav {...baseProps()} />)
    const filesLink = container.querySelector('[data-testid="nav-files"]')
    const icon = filesLink?.querySelector('.nav-icon svg')
    expect(icon?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(icon?.getAttribute('aria-hidden')).toBe('true')
    expect(icon?.querySelectorAll('line').length).toBe(3)
  })

  it('points the sidebar toggle toward its action', () => {
    const onCollapsedChange = vi.fn()
    const { rerender } = render(
      <SidebarNav {...baseProps({ collapsed: false, onCollapsedChange })} />
    )

    const collapseButton = screen.getByRole('button', { name: 'Collapse sidebar' })
    expect(
      collapseButton.querySelector('.sidebar-collapse-icon')?.classList.contains('expanded')
    ).toBe(false)
    fireEvent.click(collapseButton)
    expect(onCollapsedChange).toHaveBeenCalledWith(true)

    rerender(<SidebarNav {...baseProps({ collapsed: true, onCollapsedChange })} />)

    const expandButton = screen.getByRole('button', { name: 'Expand sidebar' })
    expect(
      expandButton.querySelector('.sidebar-collapse-icon')?.classList.contains('expanded')
    ).toBe(true)
    fireEvent.click(expandButton)
    expect(onCollapsedChange).toHaveBeenLastCalledWith(false)
  })

  it('routes a controlled palette request through desktop collapse behavior', () => {
    const onCollapsedChange = vi.fn()
    const { rerender } = render(
      <SidebarNav {...baseProps({ onCollapsedChange, toggleRequestId: 0 })} />
    )

    rerender(<SidebarNav {...baseProps({ onCollapsedChange, toggleRequestId: 1 })} />)

    expect(onCollapsedChange).toHaveBeenCalledWith(true)
  })

  it('routes a controlled palette request through the compact overlay behavior', () => {
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
      <SidebarNav {...baseProps({ compactMode: true, onCollapsedChange, toggleRequestId: 0 })} />
    )

    const onCompactMenuOpenChange = vi.fn()
    rerender(
      <SidebarNav
        {...baseProps({
          compactMode: true,
          onCollapsedChange,
          onCompactMenuOpenChange,
          toggleRequestId: 1,
        })}
      />
    )

    expect(onCompactMenuOpenChange).toHaveBeenCalledWith(true)
    expect(container.querySelector('.left-nav')?.classList.contains('compact-open')).toBe(false)
    expect(onCollapsedChange).not.toHaveBeenCalled()
  })

  it('closes the compact overlay on Escape and restores the prior body scroll style', () => {
    document.body.style.overflow = 'clip'
    const onCompactMenuOpenChange = vi.fn()
    const props = baseProps({
      compactMode: true,
      compactMenuOpen: true,
      onCompactMenuOpenChange,
    })
    const { rerender } = render(<SidebarNav {...props} />)

    expect(
      screen.getByRole('navigation').closest('aside')?.classList.contains('compact-open')
    ).toBe(true)
    expect(document.body.style.overflow).toBe('hidden')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCompactMenuOpenChange).toHaveBeenCalledWith(false, undefined)

    rerender(<SidebarNav {...props} compactMenuOpen={false} />)
    expect(document.body.style.overflow).toBe('clip')
    document.body.style.overflow = ''
  })

  it('closes the compact overlay after navigation', () => {
    const onSelect = vi.fn()
    const onCompactMenuOpenChange = vi.fn()
    render(
      <SidebarNav
        {...baseProps({
          compactMode: true,
          compactMenuOpen: true,
          onCompactMenuOpenChange,
          onSelect,
        })}
      />
    )

    fireEvent.click(screen.getByTestId('nav-files'))
    expect(onSelect).toHaveBeenCalledWith('files')
    expect(onCompactMenuOpenChange).toHaveBeenCalledWith(false, undefined)
  })

  it('clears local and mirrored compact Settings state on the explicit close control', () => {
    const onCompactMenuOpenChange = vi.fn()
    const onSettingsMenuOpenChange = vi.fn()
    const { container } = render(
      <SidebarNav
        {...baseProps({
          compactMode: true,
          compactMenuOpen: true,
          onCompactMenuOpenChange,
          onSettingsMenuOpenChange,
        })}
      />
    )

    const settings = screen.getByTestId('nav-settings-menu')
    fireEvent.click(settings)
    expect(settings.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(onSettingsMenuOpenChange).toHaveBeenLastCalledWith(true)

    fireEvent.click(container.querySelector('.sidebar-compact-close') as HTMLElement)

    expect(onCompactMenuOpenChange).toHaveBeenCalledWith(false, undefined)
    expect(onSettingsMenuOpenChange).toHaveBeenLastCalledWith(false)
    expect(settings.getAttribute('aria-expanded')).toBe('false')
    expectSettingsMenuClosed(settings)
  })

  it.each([
    ['Escape', 'escape'],
    ['the sidebar shortcut', 'shortcut'],
    ['ordinary route selection', 'route'],
    ['New Chat', 'new-chat'],
    ['session selection', 'session'],
    ['app selection', 'app'],
    ['folder opening', 'folder'],
    ['preview opening', 'preview'],
    ['logout', 'logout'],
  ] as const)('clears local and mirrored compact Settings state on %s', (_label, producer) => {
    const onCompactMenuOpenChange = vi.fn()
    const onSettingsMenuOpenChange = vi.fn()
    const onSelect = vi.fn()
    const onNewChat = vi.fn()
    const onOpenSandboxUiApp = vi.fn()
    const onOpenFilesSection = vi.fn()
    const onOpenPreviewSection = vi.fn()
    const app = {
      appRef: 'sandbox-recipes/alpha',
      label: 'Alpha',
      defaultPath: '/',
    }
    if (producer === 'session') {
      sidebarMocks.latestChatSessions = [{ agentRef: 'agent-x', id: 'chat-1', title: 'Saved chat' }]
    }
    const props = baseProps({
      navItem: producer === 'folder' || producer === 'preview' ? 'files' : 'chat',
      compactMode: true,
      compactMenuOpen: true,
      onCompactMenuOpenChange,
      onSettingsMenuOpenChange,
      onSelect,
      onNewChat,
      onOpenSandboxUiApp,
      onOpenFilesSection,
      onOpenPreviewSection,
      availableSandboxUiApps: producer === 'app' ? [app] : [],
      toggleRequestId: 0,
    })
    const { rerender } = render(<SidebarNav {...props} />)
    const settingsTrigger = screen.getByTestId('nav-settings-menu')
    fireEvent.click(settingsTrigger)
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(settingsTrigger.getAttribute('aria-expanded')).toBe('true')
    expect(onSettingsMenuOpenChange).toHaveBeenLastCalledWith(true)

    switch (producer) {
      case 'escape':
        fireEvent.keyDown(document, { key: 'Escape' })
        break
      case 'shortcut':
        rerender(<SidebarNav {...props} toggleRequestId={1} />)
        break
      case 'route':
        fireEvent.click(screen.getByTestId('nav-agents'))
        break
      case 'new-chat':
        fireEvent.click(screen.getByTestId('nav-new-chat'))
        break
      case 'session':
        fireEvent.click(screen.getByRole('button', { name: 'Open Saved chat' }))
        break
      case 'app':
        fireEvent.click(screen.getByRole('button', { name: 'Open Alpha' }))
        break
      case 'folder':
      case 'preview':
        fireEvent.click(screen.getByTestId('nav-files-explorer-toggle'))
        fireEvent.click(
          screen.getByTestId(
            producer === 'folder' ? 'file-tree-open-folder' : 'file-tree-open-preview'
          )
        )
        break
      case 'logout':
        fireEvent.click(screen.getByTestId('logout-btn'))
        break
    }

    expectSettingsMenuClosed(settingsTrigger)
    expect(settingsTrigger.getAttribute('aria-expanded')).toBe('false')
    expect(onSettingsMenuOpenChange).toHaveBeenLastCalledWith(false)
    expect(onCompactMenuOpenChange).toHaveBeenLastCalledWith(
      false,
      producer === 'new-chat' ? 'preserve-destination-focus' : undefined
    )
    if (producer === 'route') expect(onSelect).toHaveBeenCalledWith('agents')
    if (producer === 'new-chat') expect(onNewChat).toHaveBeenCalledOnce()
    if (producer === 'app') expect(onOpenSandboxUiApp).toHaveBeenCalledWith(app)
    if (producer === 'folder') expect(onOpenFilesSection).toHaveBeenCalledOnce()
    if (producer === 'preview') expect(onOpenPreviewSection).toHaveBeenCalledOnce()
  })

  it('clears a desktop Settings submenu when compact mode begins with navigation closed', () => {
    const onCompactMenuOpenChange = vi.fn()
    const onSettingsMenuOpenChange = vi.fn()
    const props = baseProps({ onCompactMenuOpenChange, onSettingsMenuOpenChange })
    const { rerender } = render(<SidebarNav {...props} />)
    const settingsTrigger = screen.getByTestId('nav-settings-menu')
    fireEvent.click(settingsTrigger)
    expect(screen.getByRole('menu')).toBeTruthy()

    rerender(<SidebarNav {...props} compactMode compactMenuOpen={false} />)

    expectSettingsMenuClosed(settingsTrigger)
    expect(screen.getByTestId('nav-settings-menu').getAttribute('aria-expanded')).toBe('false')
    expect(onSettingsMenuOpenChange).toHaveBeenLastCalledWith(false)
    expect(onCompactMenuOpenChange).not.toHaveBeenCalled()
  })

  it('shows expanded navigation in compact mode without changing the desktop collapse preference', () => {
    const onCollapsedChange = vi.fn()
    const { container } = render(
      <SidebarNav
        {...baseProps({ collapsed: true, compactMode: true, compactMenuOpen: true })}
        onCollapsedChange={onCollapsedChange}
      />
    )

    expect(container.querySelector('.left-nav')?.classList.contains('collapsed')).toBe(false)
    expect(screen.getByTestId('nav-new-chat')).toBeTruthy()
    expect(onCollapsedChange).not.toHaveBeenCalled()
  })

  it('closes the compact overlay when starting a new chat', () => {
    const onCompactMenuOpenChange = vi.fn()
    const onNewChat = vi.fn()
    render(
      <SidebarNav
        {...baseProps({
          compactMode: true,
          compactMenuOpen: true,
          onCompactMenuOpenChange,
          onNewChat,
        })}
      />
    )

    fireEvent.click(screen.getByTestId('nav-new-chat'))

    expect(onNewChat).toHaveBeenCalledOnce()
    expect(onCompactMenuOpenChange).toHaveBeenCalledWith(false, 'preserve-destination-focus')
  })

  it('closes the compact overlay after opening a file-tree folder', () => {
    const onCompactMenuOpenChange = vi.fn()
    const onOpenFilesSection = vi.fn()
    const props = baseProps({
      navItem: 'files',
      compactMode: true,
      compactMenuOpen: true,
      onCompactMenuOpenChange,
      onOpenFilesSection,
    })
    const { rerender } = render(<SidebarNav {...props} />)

    fireEvent.click(screen.getByTestId('nav-files'))
    rerender(<SidebarNav {...props} />)
    onCompactMenuOpenChange.mockClear()
    fireEvent.click(screen.getByTestId('file-tree-open-folder'))

    expect(onOpenFilesSection).toHaveBeenCalledWith('gfs://main/folder')
    expect(onCompactMenuOpenChange).toHaveBeenCalledWith(false, undefined)
  })

  it('closes the compact overlay after opening a file-tree preview', () => {
    const onCompactMenuOpenChange = vi.fn()
    const onOpenPreviewSection = vi.fn()
    const props = baseProps({
      navItem: 'files',
      compactMode: true,
      compactMenuOpen: true,
      onCompactMenuOpenChange,
      onOpenPreviewSection,
    })
    const { rerender } = render(<SidebarNav {...props} />)

    fireEvent.click(screen.getByTestId('nav-files'))
    rerender(<SidebarNav {...props} />)
    onCompactMenuOpenChange.mockClear()
    fireEvent.click(screen.getByTestId('file-tree-open-preview'))

    expect(onOpenPreviewSection).toHaveBeenCalledWith({
      bytes: 12,
      gfsUri: 'gfs://main/readme.md',
      kind: 'markdown',
      name: 'readme.md',
    })
    expect(onCompactMenuOpenChange).toHaveBeenCalledWith(false, undefined)
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

describe('SidebarNav flattened resources menu', () => {
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

  it('exposes only Agents, Connectors and Plugins as data items, directly under Settings', () => {
    render(<SidebarNav {...baseProps()} />)

    // The three data items live inside the Settings popover, so open it first.
    fireEvent.click(screen.getByTestId('nav-settings-menu'))

    expect(screen.getByTestId('nav-agents')).not.toBeNull()
    expect(screen.getByTestId('nav-mcp-servers')).not.toBeNull()
    expect(screen.getByTestId('nav-workflows')).not.toBeNull()
  })

  it('no longer renders the Contexts or Teams menu entries', () => {
    render(<SidebarNav {...baseProps()} />)
    fireEvent.click(screen.getByTestId('nav-settings-menu'))

    expect(screen.queryByTestId('nav-contexts')).toBeNull()
    expect(screen.queryByTestId('nav-teams')).toBeNull()
  })

  it('removes the intermediate "Resources" submenu level entirely', () => {
    const { container } = render(<SidebarNav {...baseProps()} />)
    fireEvent.click(screen.getByTestId('nav-settings-menu'))

    // The "Resources" trigger and its submenu container are gone; the three
    // items hang directly off the Settings popover.
    expect(screen.queryByTestId('nav-data-menu')).toBeNull()
    expect(container.querySelector('.sidebar-data-submenu')).toBeNull()
  })

  it('renders the three data items as direct children of the Settings popover menu', () => {
    render(<SidebarNav {...baseProps()} />)
    fireEvent.click(screen.getByTestId('nav-settings-menu'))

    const settingsMenu = screen.getByRole('menu')
    // Direct descendants (no wrapping submenu element between them and the popover).
    for (const testId of ['nav-agents', 'nav-mcp-servers', 'nav-workflows']) {
      const item = screen.getByTestId(testId)
      expect(item.closest('.sidebar-data-submenu')).toBeNull()
      expect(settingsMenu.contains(item)).toBe(true)
    }
  })

  it('marks the Settings popover active when on a data route', () => {
    render(<SidebarNav {...baseProps({ navItem: 'agents' })} />)
    const trigger = screen.getByTestId('nav-settings-menu')
    expect(trigger.classList.contains('active')).toBe(true)
  })
})

describe('SidebarNav Files label engages the file explorer', () => {
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

  it('opens the files section and reveals the tree on a label click', () => {
    const onSelect = vi.fn()
    render(<SidebarNav {...baseProps({ onSelect })} />)

    // The tree starts collapsed to defer its discovery fetch.
    expect(screen.getByTestId('nav-files-explorer-toggle').getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(screen.queryByTestId('file-explorer-tree')).toBeNull()

    fireEvent.click(screen.getByTestId('nav-files'))

    // Navigation still fires, and the same click now exposes the tree.
    expect(onSelect).toHaveBeenCalledWith('files')
    expect(screen.getByTestId('nav-files-explorer-toggle').getAttribute('aria-expanded')).toBe(
      'true'
    )
    expect(screen.getByTestId('file-explorer-tree')).not.toBeNull()
  })

  it('never collapses an already-open tree on a second label click', () => {
    const onSelect = vi.fn()
    render(<SidebarNav {...baseProps({ onSelect })} />)

    // Open the tree via the chevron first.
    fireEvent.click(screen.getByTestId('nav-files-explorer-toggle'))
    expect(screen.getByTestId('nav-files-explorer-toggle').getAttribute('aria-expanded')).toBe(
      'true'
    )

    // Clicking the label again re-navigates but leaves the tree open.
    fireEvent.click(screen.getByTestId('nav-files'))
    expect(onSelect).toHaveBeenCalledWith('files')
    expect(screen.getByTestId('nav-files-explorer-toggle').getAttribute('aria-expanded')).toBe(
      'true'
    )
    expect(screen.getByTestId('file-explorer-tree')).not.toBeNull()
  })

  it('navigates without arming the tree while the sidebar is collapsed', () => {
    const onSelect = vi.fn()
    render(<SidebarNav {...baseProps({ onSelect, collapsed: true })} />)

    fireEvent.click(screen.getByTestId('nav-files'))

    // Navigation still fires, but the reveal is skipped: the tree cannot render
    // collapsed, so the label must not defer its discovery fetch to a later expand.
    expect(onSelect).toHaveBeenCalledWith('files')
    expect(screen.getByTestId('nav-files-explorer-toggle').getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(screen.queryByTestId('file-explorer-tree')).toBeNull()
  })

  it('keeps the chevron as the only control that collapses the tree', () => {
    render(<SidebarNav {...baseProps()} />)
    const toggle = screen.getByTestId('nav-files-explorer-toggle')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('file-explorer-tree')).toBeNull()
  })
})

describe('SidebarNav Ant Design menus preserve their behavior owners', () => {
  it('restores focus to Settings after Escape closes its Ant Design menu', async () => {
    render(<SidebarNav {...baseProps()} />)
    const trigger = screen.getByTestId('nav-settings-menu')
    fireEvent.click(trigger)

    const menu = await screen.findByRole('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(menu.closest('.sidebar-settings-menu-wrapper')).not.toBeNull()
    fireEvent.keyDown(menu, { key: 'Escape' })

    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
    expect(document.activeElement).toBe(trigger)
  })

  it('routes Settings menu choices and Logout through the current owners', async () => {
    const onSelect = vi.fn()
    const onSettingsMenuOpenChange = vi.fn()
    render(<SidebarNav {...baseProps({ onSelect, onSettingsMenuOpenChange })} />)

    fireEvent.click(screen.getByTestId('nav-settings-menu'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Agents' }))
    expect(onSelect).toHaveBeenCalledWith('agents')
    expect(onSettingsMenuOpenChange.mock.calls).toEqual([[true], [false]])

    fireEvent.click(screen.getByTestId('nav-settings-menu'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Logout' }))
    expect(sidebarMocks.handleLogout).toHaveBeenCalledOnce()
  })

  it('opens a session through navigation state and renames via Enter', async () => {
    sidebarMocks.latestChatSessions = [
      { agentRef: 'agent-one', id: 'chat-one', title: 'Existing chat', remote: true },
    ]
    render(<SidebarNav {...baseProps()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open Existing chat' }))
    expect(sidebarMocks.handleSelectChatAgent).toHaveBeenCalledWith('agent-one', {
      selectLatest: false,
      chatId: 'chat-one',
      isRemote: true,
      title: 'Existing chat',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Session options for Existing chat' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    const renameInput = await screen.findByRole('textbox', { name: 'Rename session' })
    expect(document.activeElement).toBe(renameInput)
    fireEvent.change(renameInput, { target: { value: 'Renamed chat' } })
    fireEvent.keyDown(renameInput, { key: 'Enter' })

    await waitFor(() =>
      expect(sidebarMocks.handleRenameChatForAgent).toHaveBeenCalledWith(
        'agent-one',
        'chat-one',
        'Renamed chat'
      )
    )
  })

  it('keeps the delete confirmation behind the existing delete-fence owner', async () => {
    sidebarMocks.latestChatSessions = [
      { agentRef: 'agent-one', id: 'chat-one', title: 'Existing chat' },
    ]
    sidebarMocks.captureChatDeleteFence.mockResolvedValue({
      agentRef: 'agent-one',
      fence: {} as never,
      hostAuthorityEpoch: 1,
    })
    render(<SidebarNav {...baseProps()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Session options for Existing chat' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))

    expect(sidebarMocks.captureChatDeleteFence).toHaveBeenCalledWith('agent-one')
    expect(await screen.findByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() =>
      expect(sidebarMocks.handleDeleteChatForAgent).toHaveBeenCalledWith(
        'agent-one',
        'chat-one',
        expect.objectContaining({ agentRef: 'agent-one', hostAuthorityEpoch: 1 })
      )
    )
  })
})
