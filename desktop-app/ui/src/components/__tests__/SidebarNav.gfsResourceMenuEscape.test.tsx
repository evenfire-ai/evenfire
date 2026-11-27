// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { GfsResourceMenu } from '@components/GfsResourceMenu'
import { buildGfsResourceActions } from '@lib/gfsResourceActions'
import { SidebarNav } from '../SidebarNav'
import type { SidebarNavProps } from '../SidebarNav/types'

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
    handleSelectChatAgent: vi.fn(),
  }),
}))

// This row stands in for the tree, without its GFS data, and mounts the real
// anchored menu inside the real compact drawer. The real tree runs in
// App.sidebarGfsMenu.test.tsx.
vi.mock('../SidebarNav/FileExplorerTree', () => ({
  FileExplorerTree: function FileExplorerTreeStandIn() {
    const [menuKey, setMenuKey] = useState<number | null>(null)
    const actions = buildGfsResourceActions({
      kind: 'file',
      uri: 'gfs://main/0123456789abcdef0123456789abcdef',
      moveApplicable: true,
      previewable: true,
      handlers: { share: vi.fn(), 'copy-link': vi.fn(), rename: vi.fn() },
      canShare: true,
      canRename: true,
    })
    return (
      <div data-testid="file-explorer-tree">
        <button type="button" onContextMenu={() => setMenuKey(key => (key ?? 0) + 1)}>
          report.txt
        </button>
        {menuKey !== null ? (
          <GfsResourceMenu
            key={menuKey}
            actions={actions}
            anchor={{ x: 20, y: 20 }}
            resourceName="report.txt"
            permissionStatus="pending"
            onDismiss={() => setMenuKey(null)}
          />
        ) : null}
      </div>
    )
  },
}))

function CompactDrawer() {
  const [compactMenuOpen, setCompactMenuOpen] = useState(true)
  const props: SidebarNavProps = {
    navItem: 'files',
    collapsed: false,
    compactMode: true,
    compactMenuOpen,
    onCompactMenuOpenChange: open => setCompactMenuOpen(open),
    activeSandboxUiApp: null,
    availableSandboxUiApps: [],
    onCollapsedChange: vi.fn(),
    onNewChat: vi.fn(),
    onOpenSandboxUiApp: vi.fn(),
    onSelect: vi.fn(),
    onOpenFilesSection: vi.fn(),
    onOpenPreviewSection: vi.fn(),
    pushToast: vi.fn(),
  }
  return <SidebarNav {...props} />
}

function drawerOpen(): boolean {
  // Queried from the DOM: a closed compact drawer is aria-hidden.
  return Boolean(document.querySelector('aside')?.classList.contains('compact-open'))
}

function renderDrawerWithTree() {
  render(<CompactDrawer />)
  // The chevron reveals the tree without navigating, which would close the drawer.
  fireEvent.click(screen.getByTestId('nav-files-explorer-toggle'))
  expect(screen.getByTestId('file-explorer-tree')).toBeTruthy()
  expect(drawerOpen()).toBe(true)
}

function openMenu() {
  fireEvent.contextMenu(screen.getByRole('button', { name: 'report.txt' }))
  return screen.getByRole('menu', { name: 'Actions for report.txt' })
}

function pressEscapeOnFocus() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
}

describe('anchored GfsResourceMenu inside the compact sidebar drawer', () => {
  beforeEach(() => {
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

  it('closes only the menu on Escape and keeps the drawer open', () => {
    renderDrawerWithTree()
    const menu = openMenu()
    expect(menu.contains(document.activeElement)).toBe(true)

    pressEscapeOnFocus()

    expect(screen.queryByRole('menu', { name: 'Actions for report.txt' })).toBeNull()
    expect(drawerOpen()).toBe(true)
  })

  it('closes the Share flyout, then the menu, and keeps the drawer open', () => {
    renderDrawerWithTree()
    const menu = openMenu()
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Share' }), { key: 'ArrowRight' })
    const flyout = screen.getByRole('menu', { name: 'Share options for report.txt' })
    expect(flyout.contains(document.activeElement)).toBe(true)

    pressEscapeOnFocus()

    expect(screen.queryByRole('menu', { name: 'Share options for report.txt' })).toBeNull()
    expect(menu.contains(document.activeElement)).toBe(true)
    expect(drawerOpen()).toBe(true)

    pressEscapeOnFocus()

    expect(screen.queryByRole('menu', { name: 'Actions for report.txt' })).toBeNull()
    expect(drawerOpen()).toBe(true)
  })

  it('leaves Escape to the drawer once the menu is closed', () => {
    renderDrawerWithTree()
    openMenu()
    pressEscapeOnFocus()
    expect(drawerOpen()).toBe(true)

    pressEscapeOnFocus()

    expect(drawerOpen()).toBe(false)
  })

  it('leaves Escape to the drawer when focus has left the open menu', () => {
    renderDrawerWithTree()
    openMenu()
    const row = screen.getByRole('button', { name: 'report.txt' })
    row.focus()
    expect(document.activeElement).toBe(row)

    pressEscapeOnFocus()

    expect(drawerOpen()).toBe(false)
  })

  it('keeps Escape for the open menu when focus drops from a greyed-out item to body', () => {
    renderDrawerWithTree()
    openMenu()
    const rename = screen.getByRole('menuitem', { name: 'Rename' })
    expect(rename.getAttribute('aria-disabled')).toBe('true')
    // A click on the panel padding blurs the focused item in a browser; jsdom
    // does not move focus on click.
    fireEvent.click(rename)
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)

    pressEscapeOnFocus()

    expect(screen.queryByRole('menu', { name: 'Actions for report.txt' })).toBeNull()
    expect(drawerOpen()).toBe(true)
  })
})
