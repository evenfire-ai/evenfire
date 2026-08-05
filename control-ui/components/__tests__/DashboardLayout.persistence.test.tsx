import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { DashboardLayout } from '../DashboardLayout'

const navigationState = vi.hoisted(() => ({ pathname: '/agents' }))

vi.mock('next/navigation', () => ({
  usePathname: () => navigationState.pathname,
}))

vi.mock('../AuthContext', () => ({
  useAuth: () => ({ logout: vi.fn() }),
}))

vi.mock('../MobileHeader', () => ({
  MobileHeader: () => <header data-testid="mobile-header" />,
}))

vi.mock('../Sidebar', () => ({
  Sidebar: ({ currentTab }: { currentTab: string }) => (
    <aside data-testid="persistent-sidebar" data-current-tab={currentTab} />
  ),
}))

afterEach(() => {
  cleanup()
  navigationState.pathname = '/agents'
})

describe('DashboardLayout persistence', () => {
  it('keeps the application shell mounted across child route changes', () => {
    const view = render(
      <DashboardLayout>
        <DashboardLayout isDetailPage>
          <div>Agent detail</div>
        </DashboardLayout>
      </DashboardLayout>
    )
    const sidebar = screen.getByTestId('persistent-sidebar')
    const main = sidebar.parentElement?.querySelector('main')

    expect(sidebar).toHaveAttribute('data-current-tab', 'hosts')
    expect(main).toHaveClass('cu-detail-layout')

    navigationState.pathname = '/settings/ui'
    view.rerender(
      <DashboardLayout>
        <DashboardLayout>
          <div>Settings</div>
        </DashboardLayout>
      </DashboardLayout>
    )

    expect(screen.getByTestId('persistent-sidebar')).toBe(sidebar)
    expect(sidebar).toHaveAttribute('data-current-tab', 'settings')
    expect(main).not.toHaveClass('cu-detail-layout')
  })
})
