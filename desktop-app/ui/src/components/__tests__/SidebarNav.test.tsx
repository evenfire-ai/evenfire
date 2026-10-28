// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { QueuedChatDelete } from '../../contexts/AgentChatActionsContext/types'
import { installAntdDomEnvironment } from '../../test/antdDomEnvironment'
import { SidebarNav } from '../SidebarNav'
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
  FileExplorerTree: () => <div data-testid="file-explorer-tree" />,
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
    onOpenFilesSection: vi.fn(),
    onOpenPreviewSection: vi.fn(),
    pushToast: vi.fn(),
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

  it('uses the Ant Design hard-drive icon inside the EvenDrive nav item', () => {
    const { container } = render(<SidebarNav {...baseProps()} />)
    const filesLink = container.querySelector('[data-testid="nav-files"]')
    expect(filesLink?.querySelector('[data-icon="hdd"]')).toBeTruthy()
    expect(filesLink?.querySelector('.anticon-hdd')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('points the sidebar toggle toward its action', () => {
    const onCollapsedChange = vi.fn()
    const { rerender } = render(
      <SidebarNav {...baseProps({ collapsed: false, onCollapsedChange })} />
    )

    const collapseButton = screen.getByRole('button', { name: 'Collapse sidebar' })
    expect(collapseButton.querySelector('[data-icon="left"]')).not.toBeNull()
    fireEvent.click(collapseButton)
    expect(onCollapsedChange).toHaveBeenCalledWith(true)

    rerender(<SidebarNav {...baseProps({ collapsed: true, onCollapsedChange })} />)

    const expandButton = screen.getByRole('button', { name: 'Expand sidebar' })
    expect(expandButton.querySelector('[data-icon="right"]')).not.toBeNull()
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
