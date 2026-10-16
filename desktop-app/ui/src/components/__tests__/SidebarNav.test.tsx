// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
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
// Mutable so the held-host tests can drive the "Latest sessions" block; every
// other test reads the defaults restored in `beforeEach`.
const sidebarContext = vi.hoisted(() => ({
  latestChatSessions: [] as Array<{ id: string; agentRef: string; title: string }>,
  latestChatSessionsLoading: false,
  heldAgentRefs: [] as string[],
  handleSelectChatAgent: (() => undefined) as (...args: unknown[]) => void,
}))
vi.mock('@contexts/ChatListContext', () => ({
  useChatListContext: () => ({
    activeChatId: null,
    latestChatSessions: sidebarContext.latestChatSessions,
    latestChatSessionsLoading: sidebarContext.latestChatSessionsLoading,
    sessionStateByChatKey: {},
  }),
}))
vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => ({
    captureChatDeleteFence: vi.fn(async () => {
      throw new Error('no delete target')
    }),
    handleRenameChatForAgent: vi.fn(),
    handleDeleteChatForAgent: vi.fn(),
  }),
}))
vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => ({
    selectedAgent: null,
    heldAgentRefs: sidebarContext.heldAgentRefs,
    handleSelectChatAgent: sidebarContext.handleSelectChatAgent,
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

// Swaps in a narrow-window viewport for one test and puts the previous stub
// back afterwards, so the mobile layout never leaks into another test whatever
// the order. Restoring a `vi.spyOn` on the shared stub would reset it instead.
function stubNarrowViewport() {
  const previous = window.matchMedia
  window.matchMedia = vi.fn(
    (query: string) =>
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
  onTestFinished(() => {
    window.matchMedia = previous
  })
}

describe('SidebarNav logo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sidebarContext.latestChatSessions = []
    sidebarContext.latestChatSessionsLoading = false
    sidebarContext.heldAgentRefs = []
    sidebarContext.handleSelectChatAgent = vi.fn()
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
    const settingsMenu = document.querySelector('.sidebar-settings-menu')
    expect(settingsMenu?.querySelector('[data-testid="nav-files"]')).toBeNull()
  })

  it('mounts the hard-drive SVG inside the EvenDrive nav item so the icon is visible', () => {
    const { container } = render(<SidebarNav {...baseProps()} />)
    const filesLink = container.querySelector('[data-testid="nav-files"]')
    const icon = filesLink?.querySelector('.ui-nav-item__icon svg')
    expect(icon).toBeTruthy()
    expect(icon?.getAttribute('viewBox')).toBe('0 0 24 24')
    // Lucide hard-drive outline plus the separator line and two activity dots.
    // (Supersedes dev's paperclip alignment: this branch deliberately moved
    // the EvenDrive nav item to a hard-drive icon.)
    expect(icon?.querySelector('path')?.getAttribute('d')).toContain(
      'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89'
    )
    expect(icon?.querySelectorAll('line')).toHaveLength(3)
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
    stubNarrowViewport()
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

    const settingsMenu = document.querySelector('.sidebar-settings-menu')
    expect(settingsMenu).not.toBeNull()
    // Direct descendants (no wrapping submenu element between them and the popover).
    for (const testId of ['nav-agents', 'nav-mcp-servers', 'nav-workflows']) {
      const item = screen.getByTestId(testId)
      expect(item.closest('.sidebar-data-submenu')).toBeNull()
      expect(settingsMenu?.contains(item)).toBe(true)
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
    sidebarContext.latestChatSessions = []
    sidebarContext.latestChatSessionsLoading = false
    sidebarContext.heldAgentRefs = []
    sidebarContext.handleSelectChatAgent = vi.fn()
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

  it.each([
    {
      state: 'with sessions of another host',
      sessions: [{ id: 'chat-a1', agentRef: 'host-a', title: 'Session A1' }],
      loading: false,
    },
    { state: 'with an empty session list', sessions: [], loading: false },
    { state: 'while sessions load', sessions: [], loading: true },
  ])('T-F1-1: shows a Retry row for a held host $state', ({ sessions, loading }) => {
    sidebarContext.latestChatSessions = sessions
    sidebarContext.latestChatSessionsLoading = loading
    sidebarContext.heldAgentRefs = ['host-b']
    const { container } = render(<SidebarNav {...baseProps()} />)

    // Liveness witness: the "Latest sessions" block rendered in this state.
    const block = container.querySelector('.nav-latest-sessions')
    expect(block).not.toBeNull()
    if (sessions.length) {
      expect(
        [...container.querySelectorAll('[data-testid="latest-session-row"]')].map(row =>
          row.getAttribute('data-agent-ref')
        )
      ).toEqual(['host-a'])
    }

    expect(block?.textContent).toContain("Couldn't verify access to host-b")
    fireEvent.click(screen.getByRole('button', { name: 'Retry access to host-b' }))
    expect(sidebarContext.handleSelectChatAgent).toHaveBeenCalledTimes(1)
    expect(sidebarContext.handleSelectChatAgent).toHaveBeenCalledWith('host-b', {
      selectLatest: false,
    })
  })

  it('T-D13-1: names each held host Retry button after its host', () => {
    sidebarContext.heldAgentRefs = ['host-b', 'host-c']
    render(<SidebarNav {...baseProps()} />)

    expect(screen.getAllByRole('button', { name: /^Retry access to / })).toHaveLength(2)
    // The visible word stays "Retry": the F3 toast tells the user to use it.
    expect(screen.getByRole('button', { name: 'Retry access to host-c' }).textContent).toBe('Retry')
    fireEvent.click(screen.getByRole('button', { name: 'Retry access to host-c' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry access to host-b' }))
    expect(vi.mocked(sidebarContext.handleSelectChatAgent).mock.calls).toEqual([
      ['host-c', { selectLatest: false }],
      ['host-b', { selectLatest: false }],
    ])
  })

  it('T-D13-2: closes the mobile menu when Retry is clicked', () => {
    stubNarrowViewport()
    sidebarContext.heldAgentRefs = ['host-b']
    const { container, rerender } = render(<SidebarNav {...baseProps({ toggleRequestId: 0 })} />)
    rerender(<SidebarNav {...baseProps({ toggleRequestId: 1 })} />)

    // Liveness witness: the mobile menu is open before the click.
    const nav = container.querySelector('.left-nav')
    expect(nav?.classList.contains('mobile-open')).toBe(true)
    expect(document.body.classList.contains('mobile-sidebar-open')).toBe(true)

    const retry = container.querySelector<HTMLButtonElement>('.nav-latest-session--held button')
    expect(retry).not.toBeNull()
    fireEvent.click(retry!)

    expect(sidebarContext.handleSelectChatAgent).toHaveBeenCalledTimes(1)
    expect(sidebarContext.handleSelectChatAgent).toHaveBeenCalledWith('host-b', {
      selectLatest: false,
    })
    expect(nav?.classList.contains('mobile-open')).toBe(false)
    expect(document.body.classList.contains('mobile-sidebar-open')).toBe(false)
  })

  it('T-D15-1: moves focus to the menu button when Retry closes the narrow-window menu', () => {
    stubNarrowViewport()
    sidebarContext.heldAgentRefs = ['host-b']
    const { container, rerender } = render(<SidebarNav {...baseProps({ toggleRequestId: 0 })} />)
    rerender(<SidebarNav {...baseProps({ toggleRequestId: 1 })} />)
    expect(container.querySelector('.left-nav')?.classList.contains('mobile-open')).toBe(true)

    // Liveness witness: keyboard focus is on Retry before it is activated.
    const retry = screen.getByRole('button', { name: 'Retry access to host-b' })
    retry.focus()
    expect(document.activeElement).toBe(retry)
    fireEvent.click(retry)

    // Verification is still pending, so the row stays, hidden with the menu.
    expect(sidebarContext.handleSelectChatAgent).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.left-nav')?.classList.contains('mobile-open')).toBe(false)
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Open navigation menu' })
    )
  })

  it('T-D17-1: moves focus to the menu button when the backdrop closes the narrow-window menu', () => {
    stubNarrowViewport()
    const { container, rerender } = render(<SidebarNav {...baseProps({ toggleRequestId: 0 })} />)
    rerender(<SidebarNav {...baseProps({ toggleRequestId: 1 })} />)
    expect(container.querySelector('.left-nav')?.classList.contains('mobile-open')).toBe(true)

    // Liveness witness: keyboard focus is on the backdrop before it is activated.
    const backdrop = screen.getByRole('button', { name: 'Close navigation menu' })
    backdrop.focus()
    expect(document.activeElement).toBe(backdrop)
    fireEvent.click(backdrop)

    expect(container.querySelector('.left-nav')?.classList.contains('mobile-open')).toBe(false)
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Open navigation menu' })
    )
  })

  it('T-D15-2: closes an open session options menu when Retry is clicked', () => {
    sidebarContext.latestChatSessions = [{ id: 'chat-a1', agentRef: 'host-a', title: 'Session A1' }]
    sidebarContext.heldAgentRefs = ['host-b']
    const { container } = render(<SidebarNav {...baseProps()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Session options for Session A1' }))
    // Liveness witness: the options menu is open before Retry.
    expect(container.querySelector('.nav-latest-session__menu')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry access to host-b' }))
    expect(sidebarContext.handleSelectChatAgent).toHaveBeenCalledWith('host-b', {
      selectLatest: false,
    })
    expect(container.querySelector('.nav-latest-session__menu')).toBeNull()
  })

  it('T-D15-3: moves focus to the Chat item when the verified Host leaves the held rows', () => {
    sidebarContext.heldAgentRefs = ['host-b', 'host-c']
    const { rerender } = render(<SidebarNav {...baseProps()} />)
    const retry = screen.getByRole('button', { name: 'Retry access to host-b' })
    retry.focus()
    fireEvent.click(retry)

    // A failed verification keeps host-b held: its row and focus stay.
    sidebarContext.heldAgentRefs = ['host-b', 'host-c']
    rerender(<SidebarNav {...baseProps()} />)
    expect(document.activeElement).toBe(retry)
    // Another Host is released: host-b's row and focus stay.
    sidebarContext.heldAgentRefs = ['host-b']
    rerender(<SidebarNav {...baseProps()} />)
    expect(document.activeElement).toBe(retry)

    sidebarContext.heldAgentRefs = []
    rerender(<SidebarNav {...baseProps()} />)
    expect(screen.queryByRole('button', { name: /^Retry access to / })).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('nav-chat'))
  })

  it('T-D15-4: leaves focus where the user moved it before the Host verified', () => {
    sidebarContext.heldAgentRefs = ['host-b', 'host-c']
    const { rerender } = render(<SidebarNav {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry access to host-c' }))
    sidebarContext.heldAgentRefs = ['host-b']
    rerender(<SidebarNav {...baseProps()} />)
    // Liveness witness: the focus effect runs in this test and moves body focus.
    expect(document.activeElement).toBe(screen.getByTestId('nav-chat'))

    fireEvent.click(screen.getByRole('button', { name: 'Retry access to host-b' }))
    const files = screen.getByTestId('nav-files')
    files.focus()
    sidebarContext.heldAgentRefs = []
    rerender(<SidebarNav {...baseProps()} />)
    expect(screen.queryByRole('button', { name: /^Retry access to / })).toBeNull()
    expect(document.activeElement).toBe(files)
  })
})
