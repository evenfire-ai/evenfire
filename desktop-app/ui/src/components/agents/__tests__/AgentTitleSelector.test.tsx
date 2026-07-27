// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { AgentWorkspaceRoute } from '../../../uiTypes'
import { AgentTitleSelector } from '../AgentTitleSelector'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPTIONS = [
  { id: 'alpha', label: 'Alpha' },
  { id: 'beta', label: 'Beta' },
  { id: 'gamma', label: 'Gamma' },
]

function renderSelector(overrides: Partial<React.ComponentProps<typeof AgentTitleSelector>> = {}) {
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
  return screen.getByRole('menu')
}

// Returns the name menuitem (role=menuitem) whose label matches, or null.
function findNameItem(label: string) {
  return (
    within(menu())
      .getAllByRole('menuitem')
      .find(item => (item.textContent || '').trim() === label) || null
  )
}

// Returns the dots menuitem for a given agent label.
function findDotsItem(label: string) {
  return screen.getByRole('menuitem', { name: `Open ${label} sections` })
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

  it('selects an agent when its name is clicked and closes the menu', () => {
    const { onSelectAgent } = renderSelector()
    openMenu()
    const gamma = findNameItem('Gamma')
    expect(gamma).not.toBeNull()
    fireEvent.click(gamma as HTMLElement)

    expect(onSelectAgent).toHaveBeenCalledTimes(1)
    expect(onSelectAgent).toHaveBeenCalledWith('gamma')
    // Menu closed after selection.
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('does not re-select the already-selected agent when its name is clicked', () => {
    const { onSelectAgent } = renderSelector({ selectedId: 'alpha', selectedLabel: 'Alpha' })
    openMenu()
    const alpha = findNameItem('Alpha')
    expect(alpha).not.toBeNull()
    fireEvent.click(alpha as HTMLElement)

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
    expect(screen.queryByRole('menuitem', { name: 'Details' })).not.toBeNull()

    fireEvent.click(dots)
    expect(screen.queryByRole('menuitem', { name: 'Details' })).toBeNull()
  })

  it('shows the empty label when there are no options', () => {
    renderSelector({ options: [], selectedId: '', selectedLabel: '' })
    openMenu()
    expect(screen.getByText('No agents')).not.toBeNull()
  })
})
