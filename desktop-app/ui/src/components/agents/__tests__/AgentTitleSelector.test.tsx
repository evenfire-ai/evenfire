// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { installAntdDomEnvironment } from '../../../test/antdDomEnvironment'
import type { AgentWorkspaceRoute } from '../../../uiTypes'
import { AgentTitleSelector } from '../AgentTitleSelector'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPTIONS = [
  { id: 'alpha', label: 'Alpha' },
  { id: 'beta', label: 'Beta' },
  { id: 'gamma', label: 'Gamma' },
]

function renderSelector(overrides: Partial<React.ComponentProps<typeof AgentTitleSelector>> = {}) {
  installAntdDomEnvironment()
  const onSelectAgent = vi.fn()
  const onOpenRoute = vi.fn()
  const utils = render(
    <AgentTitleSelector
      ariaLabel="Switch chat agent"
      emptyLabel="No agents"
      options={OPTIONS}
      selectedId="alpha"
      selectedLabel="Alpha"
      onSelectAgent={onSelectAgent}
      onOpenRoute={onOpenRoute}
      {...overrides}
    />
  )
  return { ...utils, onSelectAgent, onOpenRoute }
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Switch chat agent' }))
}

// All agent-name targets and the per-row 3-dots targets render with
// role="menuitem" (the dropdown is a role="menu" container). Query within the
// menu so we only match the row items, not the trigger.
function menu() {
  const firstMenu = screen.getAllByRole('menu')[0]
  if (!firstMenu) throw new Error('Expected the agent menu to be rendered')
  return firstMenu
}

function menuAt(index: number) {
  const foundMenu = screen.getAllByRole('menu')[index]
  if (!foundMenu) throw new Error(`Expected Ant Design menu at index ${index}`)
  return foundMenu
}

// Returns the name menuitem (role=menuitem) whose label matches, or null.
function findNameItem(label: string) {
  return within(menu()).getByRole('button', { name: label })
}

// Returns the dots menuitem for a given agent label.
function findDotsItem(label: string) {
  return screen.getByRole('button', { name: `Open ${label} sections` })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AgentTitleSelector', () => {
  it('renders the selected agent label in the trigger', () => {
    renderSelector({ selectedId: 'beta', selectedLabel: 'Beta' })
    const trigger = screen.getByRole('button', { name: 'Switch chat agent' })
    expect(trigger.textContent).toContain('Beta')
  })

  it('opens the menu on trigger click and lists every agent', () => {
    renderSelector()
    openMenu()
    for (const label of ['Alpha', 'Beta', 'Gamma']) {
      expect(findNameItem(label)).not.toBeNull()
    }
  })

  it('marks the selected agent row as current (aria-current)', () => {
    renderSelector({ selectedId: 'beta', selectedLabel: 'Beta' })
    openMenu()
    const beta = findNameItem('Beta')
    expect(beta).not.toBeNull()
    expect(beta?.getAttribute('aria-current')).toBe('true')
    // Non-selected rows are not marked current.
    expect(findNameItem('Alpha')?.getAttribute('aria-current')).toBeNull()
  })

  it('selects an agent when its name is clicked and closes the menu', async () => {
    const { onSelectAgent } = renderSelector()
    openMenu()
    const gamma = findNameItem('Gamma')
    expect(gamma).not.toBeNull()
    fireEvent.click(gamma)

    expect(onSelectAgent).toHaveBeenCalledTimes(1)
    expect(onSelectAgent).toHaveBeenCalledWith('gamma')
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Switch chat agent' }).getAttribute('aria-expanded')
      ).toBe('false')
    })
  })

  it('does not re-select the already-selected agent when its name is clicked', () => {
    const { onSelectAgent } = renderSelector({ selectedId: 'alpha', selectedLabel: 'Alpha' })
    openMenu()
    const alpha = findNameItem('Alpha')
    expect(alpha).not.toBeNull()
    fireEvent.click(alpha)

    expect(onSelectAgent).not.toHaveBeenCalled()
  })

  it('opens a sections sub-menu from the 3-dots and navigates to a route', () => {
    const { onOpenRoute } = renderSelector()
    openMenu()

    fireEvent.click(findDotsItem('Beta'))
    // Sub-menu route item; "Connectors" maps to 'mcp-servers'.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Connectors' }))

    expect(onOpenRoute).toHaveBeenCalledTimes(1)
    expect(onOpenRoute).toHaveBeenCalledWith('beta', 'mcp-servers' as AgentWorkspaceRoute)
  })

  it('temporarily hides Agent Files from the sections sub-menu', () => {
    renderSelector()
    openMenu()

    fireEvent.click(findDotsItem('Beta'))

    expect(screen.queryByRole('menuitem', { name: 'Agent Files' })).toBeNull()
  })

  it('toggles the sections sub-menu off when the dots are clicked again', () => {
    renderSelector()
    openMenu()
    const dots = findDotsItem('Beta')

    fireEvent.click(dots)
    expect(screen.queryByRole('menuitem', { name: 'Connectors' })).not.toBeNull()

    fireEvent.click(dots)
    expect(dots.getAttribute('aria-expanded')).toBe('false')
  })

  it('shows the empty label when there are no options', () => {
    renderSelector({ options: [], selectedId: '', selectedLabel: '' })
    openMenu()
    expect(screen.getByText('No agents')).not.toBeNull()
  })

  it('portals the menu out of the selector wrapper', () => {
    const { container } = renderSelector()
    openMenu()
    const menuEl = screen.getByRole('menu')
    expect(container.contains(menuEl)).toBe(false)
    expect(document.body.contains(menuEl)).toBe(true)
  })

  it('renders the sections menu in its own Ant Design popup', () => {
    renderSelector()
    openMenu()
    fireEvent.click(findDotsItem('Beta'))

    const menus = screen.getAllByRole('menu')
    expect(menus).toHaveLength(2)
    const mainMenu = menus[0]
    const routeMenu = menus[1]
    if (!mainMenu || !routeMenu) throw new Error('Expected separate agent and route menus')
    expect(mainMenu.contains(routeMenu)).toBe(false)
    expect(document.body.contains(routeMenu)).toBe(true)
  })

  it('opens route actions for a different agent without changing the selected agent', () => {
    const { onOpenRoute, onSelectAgent } = renderSelector()
    openMenu()
    fireEvent.click(findDotsItem('Gamma'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Connectors' }))

    expect(onOpenRoute).toHaveBeenCalledWith('gamma', 'mcp-servers')
    expect(onSelectAgent).not.toHaveBeenCalled()
  })

  it('keeps the menu open for internal clicks and closes after a route action', async () => {
    renderSelector()
    openMenu()
    fireEvent.mouseDown(menu())
    expect(screen.queryByRole('menu')).not.toBeNull()

    fireEvent.click(findDotsItem('Beta'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Connectors' }))
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Switch chat agent' }).getAttribute('aria-expanded')
      ).toBe('false')
    })
  })

  it('moves keyboard focus into the Ant Design menu when it opens', async () => {
    renderSelector()
    openMenu()
    await waitFor(() => expect(menu().contains(document.activeElement)).toBe(true))
  })

  it('moves focus into the sections menu and returns it to the trigger on ESC', async () => {
    renderSelector()
    openMenu()
    fireEvent.click(findDotsItem('Beta'))
    const routeMenu = menuAt(1)
    await waitFor(() => expect(routeMenu.contains(document.activeElement)).toBe(true))

    fireEvent.keyDown(routeMenu, { key: 'Escape' })
    await waitFor(() => {
      expect(findDotsItem('Beta').getAttribute('aria-expanded')).toBe('false')
      expect(document.activeElement).toBe(findDotsItem('Beta'))
    })
  })
})
