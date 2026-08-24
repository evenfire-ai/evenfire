import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import * as hook from '../../lib/hooks/usePublishScope'
import { Sidebar } from '../Sidebar'
import { activeSidebarChildHref } from '../Sidebar/activeChild'
import { SIDEBAR_TABS } from '../Sidebar/constants'

const navigationState = vi.hoisted(() => ({ pathname: '/agents' }))
const refreshPublishScope = vi.fn()

function publishScopeState(state: Omit<hook.PublishScopeState, 'refresh'>): hook.PublishScopeState {
  return { ...state, refresh: refreshPublishScope }
}

vi.mock('next/navigation', () => ({
  usePathname: () => navigationState.pathname,
}))

vi.mock('../../lib/hooks/usePublishScope', async orig => {
  const actual = await orig<typeof import('../../lib/hooks/usePublishScope')>()
  return { ...actual, usePublishScope: vi.fn() }
})

afterEach(() => {
  cleanup()
  navigationState.pathname = '/agents'
})
beforeEach(() => vi.clearAllMocks())

describe('Sidebar publisher gating', () => {
  it('does not render a Publisher entry (folded into the Marketplace org tab)', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({
        scope: { scope: 'acme', curator: false, orgName: 'Acme' },
        loading: false,
        error: false,
      })
    )
    render(<Sidebar currentTab="hosts" />)
    // Publisher was folded into the org-named Marketplace tab (design spec §4).
    expect(screen.queryByRole('link', { name: /publisher/i })).toBeNull()
    expect(screen.getByRole('link', { name: /marketplace/i })).toBeInTheDocument()
  })

  it('still renders the other navigation entries', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({ scope: null, loading: false, error: true })
    )
    render(<Sidebar currentTab="hosts" />)
    expect(screen.getByRole('link', { name: /agents/i })).toBeInTheDocument()
  })

  it('keeps Traces hidden and renders visible navigation in the defined order', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({ scope: null, loading: false, error: false })
    )
    render(<Sidebar currentTab="traces" />)

    expect(screen.queryByText('Traces')).not.toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Main sections' })
    const labels = Array.from(nav.children).map(item =>
      item.querySelector('.cu-sidebar__label')?.textContent?.trim()
    )
    expect(labels).toEqual([
      'Users & Teams',
      'Agents',
      'Contexts',
      'Marketplace',
      'Installed connectors',
      'Installed plugins',
      'Installed Guardrails',
      'Files',
      'External Channels',
      'LLM Models',
      'Secrets',
      'Cost & Usage',
    ])
  })

  it('keeps Settings in the footer on its canonical route', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({ scope: null, loading: false, error: false })
    )
    render(<Sidebar currentTab="settings" />)

    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings/ui')
  })

  it.each(['/llm-models', '/llm-models/model-id/edit', '/llm-models/discovery'])(
    'keeps the merged LLM Models entry selected for %s',
    pathname => {
      vi.mocked(hook.usePublishScope).mockReturnValue(
        publishScopeState({ scope: null, loading: false, error: false })
      )
      navigationState.pathname = pathname
      render(<Sidebar currentTab="llm-models" />)

      const entry = screen.getByRole('link', { name: 'LLM Models' })
      expect(entry).toHaveAttribute('href', '/llm-models')
      expect(entry).toHaveAttribute('data-active', 'true')
      expect(entry).toHaveAttribute('aria-current', 'page')
    }
  )

  it.each([
    ['/agent-outputs/recipe-artifacts', 'Agent Outputs', '/agent-outputs/recipe-artifacts'],
    ['/agent-outputs/desktop-app-artifacts', 'Agent Outputs', '/agent-outputs/recipe-artifacts'],
    ['/global-file-system', 'Global File System', '/global-file-system'],
  ])('selects the matching Files child for %s', (pathname, label, href) => {
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({ scope: null, loading: false, error: false })
    )
    navigationState.pathname = pathname
    render(<Sidebar currentTab="directories" />)

    const group = screen.getByRole('button', { name: 'Files' })
    expect(group).toHaveAttribute('aria-expanded', 'true')
    expect(group).toHaveAttribute('data-active', 'true')
    const child = screen.getByRole('link', { name: label })
    expect(child).toHaveAttribute('href', href)
    expect(child).toHaveAttribute('aria-current', 'page')
  })

  it('renders a thin icon for every visible child route', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({ scope: null, loading: false, error: false })
    )
    render(<Sidebar currentTab="directories" />)

    for (const label of ['Agent Outputs', 'Global File System']) {
      const child = screen.getByRole('link', { name: label })
      expect(child.querySelector('.cu-sidebar__subitem-icon svg')).toBeInTheDocument()
    }
  })

  it('renders an icon for the Files group', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({ scope: null, loading: false, error: false })
    )
    render(<Sidebar currentTab="directories" />)

    const directories = screen.getByRole('button', { name: 'Files' })
    const icon = directories.querySelector('.cu-sidebar__icon svg')
    expect(icon).toBeInTheDocument()
    expect(icon).toHaveAttribute('width', '18')
    expect(icon).toHaveAttribute('height', '18')
    expect(icon).toHaveAttribute('viewBox', '0 0 512 512')
    expect(icon?.querySelector('path')).toHaveAttribute(
      'd',
      'M464 128H272l-64-64H48C21.49 64 0 85.49 0 112v288c0 26.51 21.49 48 48 48h416c26.51 0 48-21.49 48-48V176c0-26.51-21.49-48-48-48z'
    )
  })

  it('hides Agent Files from the sidebar without changing its route', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({ scope: null, loading: false, error: false })
    )
    navigationState.pathname = '/agent-files/example'
    render(<Sidebar currentTab="directories" />)

    expect(screen.queryByRole('link', { name: 'Agent Files' })).not.toBeInTheDocument()
    expect(SIDEBAR_TABS.directories.href).toBe('/agent-files')
  })

  it('uses the shared Desktop paperclip glyph for Global File System', () => {
    vi.mocked(hook.usePublishScope).mockReturnValue(
      publishScopeState({ scope: null, loading: false, error: false })
    )
    navigationState.pathname = '/global-file-system'
    render(<Sidebar currentTab="directories" />)

    const globalFileSystem = screen.getByRole('link', { name: 'Global File System' })
    expect(globalFileSystem.querySelector('path')).toHaveAttribute(
      'd',
      'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48'
    )
  })

  it('defines an icon for every sidebar child route, including hidden groups', () => {
    for (const item of Object.values(SIDEBAR_TABS)) {
      expect(item.children?.every(child => Boolean(child.icon)) ?? true).toBe(true)
    }
  })

  it('sorts standard sidebar groups by the displayed child label', () => {
    for (const [tab, item] of Object.entries(SIDEBAR_TABS)) {
      if (tab === 'cost' || tab === 'directories') continue
      const labels = item.children?.map(child => child.label) ?? []
      expect(labels).toEqual([...labels].sort((first, second) => first.localeCompare(second)))
    }

    expect(SIDEBAR_TABS.cost.children?.map(child => child.label)).toEqual([
      'Usage',
      'Token Budgets',
      'LLM Prices',
    ])
    expect(SIDEBAR_TABS.directories.children?.map(child => child.label)).toEqual([
      'Global File System',
      'Agent Outputs',
    ])
  })

  it('selects hidden Trace children by their nested routes', () => {
    expect(
      activeSidebarChildHref('/traces/infrastructure/event-id', SIDEBAR_TABS.traces.children ?? [])
    ).toBe('/traces/infrastructure')
    expect(
      activeSidebarChildHref(
        '/traces/sessions/host-id/session-id',
        SIDEBAR_TABS.traces.children ?? []
      )
    ).toBe('/traces')
  })
})
