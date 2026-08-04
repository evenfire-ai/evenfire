import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import { ProfileShell } from '@components/ProfileShell'

const navigationState = vi.hoisted(() => ({
  pathname: '/members',
  replace: vi.fn(),
  logout: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => navigationState.pathname,
  useRouter: () => ({ replace: navigationState.replace }),
}))

vi.mock('@components/AuthContext', () => ({
  useAuth: () => ({ logout: navigationState.logout }),
}))

vi.mock('@components/MobileHeader', () => ({
  MobileHeader: () => <header data-testid="profile-mobile-header" />,
}))

vi.mock('@components/Sidebar', () => ({
  Sidebar: ({ currentRoute }: { currentRoute: string }) => (
    <aside className="cu-sidebar" data-current-route={currentRoute} />
  ),
}))

vi.mock('@constants/routes', () => ({
  PROFILE_ROUTES: { home: '/' },
}))

afterEach(() => {
  cleanup()
  navigationState.pathname = '/members'
  navigationState.replace.mockClear()
  navigationState.logout.mockClear()
})

describe('ProfileShell persistence', () => {
  it('preserves the same sidebar DOM node across protected profile navigation', () => {
    const view = render(
      <ProfileShell>
        <div data-testid="profile-page">Members</div>
      </ProfileShell>
    )
    const sidebar = view.container.querySelector('.cu-sidebar')
    expect(sidebar).toBeInstanceOf(HTMLElement)
    expect(sidebar).toHaveAttribute('data-current-route', 'members')

    navigationState.pathname = '/approval-channels'
    view.rerender(
      <ProfileShell>
        <div data-testid="profile-page">Approval channels</div>
      </ProfileShell>
    )
    expect(view.container.querySelector('.cu-sidebar')).toBe(sidebar)
    expect(sidebar).toHaveAttribute('data-current-route', 'approvalChannels')

    navigationState.pathname = '/settings/profile'
    view.rerender(
      <ProfileShell>
        <div data-testid="profile-page">Settings</div>
      </ProfileShell>
    )
    expect(view.container.querySelector('.cu-sidebar')).toBe(sidebar)
    expect(sidebar).toHaveAttribute('data-current-route', 'settings')
  })
})
