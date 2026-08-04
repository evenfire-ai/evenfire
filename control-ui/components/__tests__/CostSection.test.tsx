import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import CostLayout from '../../app/cost/layout'
import { DashboardLayout } from '../DashboardLayout'
import { Sidebar } from '../Sidebar'

const navigationState = vi.hoisted(() => ({
  pathname: '/cost-and-usage/usage',
  segments: [] as string[],
}))

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
  navigationState.pathname = '/cost-and-usage/usage'
  navigationState.segments = []
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
    'wraps the %s list root without rendering duplicate section tabs',
    segment => {
      renderLayoutForSegments([segment])
      expect(screen.queryByRole('tab')).toBeNull()
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

  it('renders one expandable group with canonical child routes', () => {
    render(<Sidebar currentTab="cost" />)
    const group = screen.getByRole('button', { name: /Cost & Usage/ })
    expect(group).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: /^Usage$/ })).toHaveAttribute(
      'href',
      '/cost-and-usage/usage'
    )
    expect(screen.getByRole('link', { name: /LLM Prices/ })).toHaveAttribute(
      'href',
      '/cost-and-usage/llm-prices'
    )
    expect(screen.getByRole('link', { name: /Token Budgets/ })).toHaveAttribute(
      'href',
      '/cost-and-usage/token-budgets'
    )
    expect(
      screen
        .getAllByRole('link')
        .filter(link => link.getAttribute('href')?.startsWith('/cost-and-usage/'))
        .map(link => link.textContent)
    ).toEqual(['Usage', 'Token Budgets', 'LLM Prices'])
  })

  it.each([
    '/cost-and-usage/usage',
    '/cost-and-usage/llm-prices',
    '/cost-and-usage/token-budgets/abc/edit',
  ])('stays active for any /cost/* route (%s)', pathname => {
    renderLayoutAt(pathname)
    const group = screen.getByRole('button', { name: /Cost & Usage/ })
    expect(group).toHaveAttribute('data-active', 'true')
    expect(group).toHaveAttribute('aria-expanded', 'true')
  })

  it.each([
    ['/cost-and-usage/usage', 'Usage'],
    ['/cost-and-usage/llm-prices/new', 'LLM Prices'],
    ['/cost-and-usage/token-budgets/abc/edit', 'Token Budgets'],
  ])('marks the matching child route as current for %s', (pathname, label) => {
    navigationState.pathname = pathname
    render(<Sidebar currentTab="cost" />)

    const child = screen.getByRole('link', { name: label })
    expect(child).toHaveAttribute('data-active', 'true')
    expect(child).toHaveAttribute('aria-current', 'page')
  })

  it('is not active on unrelated routes', () => {
    renderLayoutAt('/agents')
    const group = screen.getByRole('button', { name: /Cost & Usage/ })
    expect(group).toHaveAttribute('data-active', 'false')
    expect(group).toHaveAttribute('aria-expanded', 'false')
  })
})
