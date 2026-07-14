import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import CostLayout from '../../app/cost/layout'
import { COST_TABS } from '../CostShell/constants'
import type { CostSegment } from '../CostShell/types'
import { DashboardLayout } from '../DashboardLayout'
import { Sidebar } from '../Sidebar'
import { TabBar } from '../TabBar'

const navigationState = vi.hoisted(() => ({ pathname: '/cost/usage', segments: [] as string[] }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => navigationState.pathname,
  useSelectedLayoutSegments: () => navigationState.segments,
}))

vi.mock('../AuthContext', () => ({
  useAuth: () => ({ authState: { isLoggedIn: true, isLoading: false }, logout: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  navigationState.pathname = '/cost/usage'
  navigationState.segments = []
})

describe('Cost & Usage tab bar', () => {
  it('exposes the three tabs in order pointing at their segment routes', () => {
    expect(COST_TABS.map(tab => [tab.value, tab.href, tab.label])).toEqual([
      ['usage', '/cost/usage', 'Usage'],
      ['llm-prices', '/cost/llm-prices', 'LLM Prices'],
      ['token-budgets', '/cost/token-budgets', 'Token Budgets'],
    ])
  })

  it('marks only the active tab as selected, by segment', () => {
    render(
      <TabBar<CostSegment>
        ariaLabel="Cost and usage sections"
        activeValue="llm-prices"
        options={COST_TABS}
      />
    )
    const active = screen.getByRole('tab', { name: 'LLM Prices' })
    expect(active).toHaveAttribute('data-active', 'true')
    expect(active).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('tab', { name: 'Usage' })).toHaveAttribute('data-active', 'false')
    expect(screen.getByRole('tab', { name: 'Token Budgets' })).toHaveAttribute(
      'data-active',
      'false'
    )
  })
})

describe('CostLayout segment gating', () => {
  function renderLayoutForSegments(segments: string[]) {
    navigationState.segments = segments
    return render(
      <CostLayout>
        <div>section content</div>
      </CostLayout>
    )
  }

  it.each([['usage'], ['llm-prices'], ['token-budgets']])(
    'wraps the %s list root in the shared tab shell',
    segment => {
      renderLayoutForSegments([segment])
      // Tab shell present with all three tabs, plus the section content.
      expect(screen.getByRole('tab', { name: 'Usage' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'LLM Prices' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Token Budgets' })).toBeInTheDocument()
      expect(screen.getByText('section content')).toBeInTheDocument()
    }
  )

  it.each([
    [['llm-prices', 'new']],
    [['token-budgets', 'new']],
    [['llm-prices', 'abc', 'edit']],
    [['token-budgets', 'abc', 'edit']],
    [[] as string[]],
  ])('renders create/edit/index routes untouched, without the tab shell (%j)', segments => {
    renderLayoutForSegments(segments)
    // Deeper routes own their own create shell — no tab bar injected here.
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.getByText('section content')).toBeInTheDocument()
  })
})

describe('Cost & Usage sidebar entry', () => {
  function renderLayoutAt(pathname: string) {
    navigationState.pathname = pathname
    return render(
      <DashboardLayout>
        <div>content</div>
      </DashboardLayout>
    )
  }

  it('renders a single consolidated entry pointing at /cost/usage', () => {
    render(<Sidebar currentTab="cost" />)
    const link = screen.getByRole('link', { name: /Cost & Usage/ })
    expect(link).toHaveAttribute('href', '/cost/usage')
    // The old split entries are gone.
    expect(screen.queryByRole('link', { name: /^Usage$/ })).toBeNull()
    expect(screen.queryByRole('link', { name: /LLM Prices/ })).toBeNull()
    expect(screen.queryByRole('link', { name: /Token Budgets/ })).toBeNull()
  })

  it.each(['/cost/usage', '/cost/llm-prices', '/cost/token-budgets/abc/edit'])(
    'stays active for any /cost/* route (%s)',
    pathname => {
      renderLayoutAt(pathname)
      const link = screen.getByRole('link', { name: /Cost & Usage/ })
      expect(link).toHaveAttribute('aria-current', 'page')
    }
  )

  it('is not active on unrelated routes', () => {
    renderLayoutAt('/hosts')
    const link = screen.getByRole('link', { name: /Cost & Usage/ })
    expect(link).not.toHaveAttribute('aria-current', 'page')
  })
})
